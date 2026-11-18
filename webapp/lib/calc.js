// Estimated recipe stats, so the review screen shows numbers before anything
// is pushed. Standard homebrew formulas: gravity from extract potential and
// efficiency, Tinseth IBU, Morey colour. Brewfather may differ slightly.

const KG_TO_LB = 2.20462;
const L_TO_GAL = 0.264172;

const NO_MASH_EFFICIENCY = new Set(["Sugar", "Extract", "Dry Extract"]);

function round(n, dp) {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function gravityPoints(recipe) {
  const gal = recipe.batch_size_l * L_TO_GAL;
  let fermentable = 0;
  let unfermentable = 0;
  for (const f of recipe.fermentables) {
    const ppg = (f.potential_sg - 1) * 1000; // points per lb per gallon
    const eff = NO_MASH_EFFICIENCY.has(f.type) ? 1 : recipe.efficiency_pct / 100;
    const pts = (f.amount_kg * KG_TO_LB * ppg * eff) / gal;
    if (/lactose|maltodextrin/i.test(f.name)) unfermentable += pts;
    else fermentable += pts;
  }
  return { fermentable, unfermentable };
}

function tinsethUtilisation(gravity, minutes) {
  const bigness = 1.65 * 0.000125 ** (gravity - 1);
  const time = (1 - Math.exp(-0.04 * minutes)) / 4.15;
  return bigness * time;
}

// Whirlpool/hop-stand hops isomerise far less than boiling hops. Scale the
// Tinseth figure by a temperature factor (roughly what common tools assume).
function whirlpoolFactor(tempC) {
  if (tempC >= 95) return 0.5;
  if (tempC >= 85) return 0.3;
  if (tempC >= 75) return 0.15;
  return 0.05;
}

export function computeStats(recipe) {
  const { fermentable, unfermentable } = gravityPoints(recipe);
  const ogPoints = fermentable + unfermentable;
  const og = 1 + ogPoints / 1000;

  const yeastAttenuation = Math.max(0, ...recipe.yeasts.map((y) => y.attenuation_pct || 0)) || 75;
  // Hotter mashes leave more unfermentable sugar. Adjust attenuation by about
  // 1 point per degree away from 65°C (matches Brewfather more closely than
  // the yeast figure alone).
  const mainMashTemp = recipe.mash_steps?.length
    ? recipe.mash_steps.reduce((a, b) => (b.time_min > a.time_min ? b : a)).temp_c
    : 65;
  const attenuation = yeastAttenuation - Math.max(-3, Math.min(4, mainMashTemp - 65));
  const fgPoints = fermentable * (1 - attenuation / 100) + unfermentable;
  const fg = 1 + fgPoints / 1000;

  const abv = (og - fg) * 131.25;

  let ibu = 0;
  for (const h of recipe.hops) {
    const mgPerL = ((h.alpha_pct / 100) * h.amount_g * 1000) / recipe.batch_size_l;
    if (h.use === "Boil" || h.use === "First Wort") {
      const minutes = h.use === "First Wort" ? recipe.boil_time_min : h.time_min;
      ibu += mgPerL * tinsethUtilisation(og, minutes);
    } else if (h.use === "Whirlpool") {
      ibu += mgPerL * tinsethUtilisation(og, Math.min(h.time_min, 45)) * whirlpoolFactor(h.temp_c);
    }
  }

  const mcu = recipe.fermentables.reduce(
    (sum, f) => sum + (f.amount_kg * KG_TO_LB * f.color_lovibond) / (recipe.batch_size_l * L_TO_GAL),
    0,
  );
  const srm = 1.4922 * mcu ** 0.6859;

  return {
    og: round(og, 3),
    fg: round(fg, 3),
    abv: round(abv, 1),
    ibu: Math.round(ibu),
    srm: round(srm, 1),
    ebc: round(srm * 1.97, 1),
    attenuation_pct: round(attenuation, 1),
    total_grain_kg: round(recipe.fermentables.reduce((s, f) => s + f.amount_kg, 0), 2),
    total_hops_g: Math.round(recipe.hops.reduce((s, h) => s + h.amount_g, 0)),
  };
}

/**
 * Compare each ingredient with Brewfather inventory. Adds `stock` to every
 * ingredient: { status: "in_stock" | "partial" | "to_buy", have, unit }.
 */
export function annotateStock(recipe, inventory) {
  const byId = new Map();
  for (const list of Object.values(inventory || {})) {
    for (const item of list) byId.set(item._id, item);
  }

  const check = (item, need, unit) => {
    const inv = item.inventory_id ? byId.get(item.inventory_id) : null;
    if (!inv) return { ...item, stock: { status: "to_buy", have: 0, unit } };
    const have = Number(inv.inventory) || 0;
    const status = have >= need - 1e-9 ? "in_stock" : have > 0 ? "partial" : "to_buy";
    return { ...item, stock: { status, have: round(have, 3), unit } };
  };

  // The same hop is often used several times (and Claude may only tag some
  // additions with the inventory id), so group hops by name and check stock
  // against the total.
  const hopKey = (h) => h.name.trim().toLowerCase();
  const hopTotals = new Map();
  const hopInventoryId = new Map();
  for (const h of recipe.hops) {
    hopTotals.set(hopKey(h), (hopTotals.get(hopKey(h)) || 0) + h.amount_g);
    if (h.inventory_id && !hopInventoryId.has(hopKey(h))) hopInventoryId.set(hopKey(h), h.inventory_id);
  }
  const checkHop = (h) => {
    const id = h.inventory_id || hopInventoryId.get(hopKey(h)) || "";
    const { stock } = check({ ...h, inventory_id: id }, hopTotals.get(hopKey(h)), "g");
    return { ...h, stock };
  };

  // Swaps must point at a real inventory item that isn't already in the recipe.
  const usedIds = new Set(
    [...recipe.fermentables, ...recipe.hops, ...recipe.yeasts, ...recipe.miscs].map((i) => i.inventory_id).filter(Boolean),
  );
  const UNITS = { fermentables: "kg", hops: "g", yeasts: "pkg", miscs: "" };
  const unitOf = (id) => {
    for (const [collection, list] of Object.entries(inventory || {})) {
      const item = list.find((x) => x._id === id);
      if (item) return item.unit || UNITS[collection] || "";
    }
    return "";
  };
  const swaps = (recipe.swaps || [])
    .filter((s) => byId.has(s.inventory_id) && !usedIds.has(s.inventory_id))
    .slice(0, 4)
    .map((s) => ({ ...s, have: round(Number(byId.get(s.inventory_id).inventory) || 0, 3), unit: unitOf(s.inventory_id) }));

  return {
    ...recipe,
    swaps,
    fermentables: recipe.fermentables.map((f) => check(f, f.amount_kg, "kg")),
    hops: recipe.hops.map(checkHop),
    yeasts: recipe.yeasts.map((y) => check(y, y.amount, y.unit)),
    miscs: recipe.miscs.map((m) => check(m, m.amount, m.unit)),
  };
}
