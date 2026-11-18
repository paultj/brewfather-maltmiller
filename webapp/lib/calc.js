// Estimated recipe stats, so the review screen shows numbers before anything
// is pushed. Standard homebrew formulas: gravity from extract potential and
// efficiency, Tinseth IBU (calibrated to Brewfather), Morey colour.

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

// Calibrated against Brewfather (Tinseth) on a real recipe: 23 L, OG 1.070,
// 15 g Magnum 14% @60 = 20.8 IBU, 40 g Citra 12.5% + 25 g Mosaic 11.2%
// hop stand 20 min @80°C = 6.2 + 3.5 IBU. Brewfather's boil figures fit
// Tinseth evaluated at about 73% of the OG points (i.e. a boil gravity),
// and its hop-stand figures fit a temperature factor of 0.9 x the
// Malowicki isomerisation rate relative to 100°C.
const IBU_GRAVITY_FRACTION = 0.73;
function ibuGravity(og) {
  return 1 + (og - 1) * IBU_GRAVITY_FRACTION;
}

export function hopStandFactor(tempC) {
  if (!(tempC > 0)) return 0;
  const k = 2.39e11 * Math.exp(-9773 / (tempC + 273.15));
  return Math.min(1, 0.9 * k);
}

/** Total IBU for a list of hop additions (Tinseth, calibrated as above). */
export function computeIbu(hops, og, batchSizeL, boilTimeMin) {
  const g = ibuGravity(og);
  let ibu = 0;
  for (const h of hops) {
    const mgPerL = ((h.alpha_pct / 100) * h.amount_g * 1000) / batchSizeL;
    if (h.use === "Boil" || h.use === "First Wort") {
      const minutes = h.use === "First Wort" ? boilTimeMin : h.time_min;
      ibu += mgPerL * tinsethUtilisation(g, minutes);
    } else if (h.use === "Whirlpool") {
      ibu += mgPerL * tinsethUtilisation(g, h.time_min) * hopStandFactor(h.temp_c);
    }
  }
  return ibu;
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

  const ibu = computeIbu(recipe.hops, og, recipe.batch_size_l, recipe.boil_time_min);

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
