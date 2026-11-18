// Brewfather API v2: read inventory, create recipes.
// Docs: https://docs.brewfather.app/api  (500 calls/hour per key)
import { computeStats } from "./calc.js";
import { rangesFor, bjcpCategory } from "./styles.js";

const BASE = process.env.BREWFATHER_API_BASE || "https://api.brewfather.app/v2";
const COLLECTIONS = ["fermentables", "hops", "yeasts", "miscs"];
const INVENTORY_TTL_MS = 5 * 60_000;

export class BrewfatherError extends Error {
  constructor(message, status, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function authHeader(settings) {
  if (!settings.brewfatherUserId || !settings.brewfatherApiKey) {
    throw new BrewfatherError("Brewfather user ID and API key are not set. Add them in Settings.", 400);
  }
  return "Basic " + Buffer.from(`${settings.brewfatherUserId}:${settings.brewfatherApiKey}`).toString("base64");
}

async function bf(settings, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: authHeader(settings),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? " Check the user ID and API key, and that the key has the needed scopes (inventory.read, recipes.write)."
        : res.status === 429
          ? " Brewfather rate limit reached (500 calls/hour); try again shortly."
          : "";
    throw new BrewfatherError(`Brewfather ${method} ${path} failed: ${res.status}.${hint}`, res.status, data);
  }
  return data;
}

async function listAll(settings, collection) {
  const items = [];
  let startAfter = "";
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ inventory_exists: "true", complete: "true", limit: "50" });
    if (startAfter) qs.set("start_after", startAfter);
    const batch = await bf(settings, "GET", `/inventory/${collection}?${qs}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < 50) break;
    startAfter = batch[batch.length - 1]._id;
  }
  return items;
}

let inventoryCache = { key: "", at: 0, data: null };

/** All inventory items with stock > 0, grouped by collection. Cached for 5 minutes. */
export async function getInventory(settings, { refresh = false } = {}) {
  const key = `${settings.brewfatherUserId}:${settings.brewfatherApiKey.slice(-6)}`;
  if (!refresh && inventoryCache.data && inventoryCache.key === key && Date.now() - inventoryCache.at < INVENTORY_TTL_MS) {
    return inventoryCache.data;
  }
  const results = await Promise.all(COLLECTIONS.map((c) => listAll(settings, c)));
  const data = {};
  COLLECTIONS.forEach((c, i) => {
    data[c] = results[i].filter((item) => Number(item.inventory) > 0);
  });
  inventoryCache = { key, at: Date.now(), data };
  return data;
}

/** Recipes for the equipment picker: newest first where Brewfather supports it. */
export async function listRecipes(settings) {
  try {
    return await bf(settings, "GET", "/recipes?limit=50&order_by=_timestamp&order_by_direction=desc");
  } catch (err) {
    if (err.status !== 400) throw err;
    return bf(settings, "GET", "/recipes?limit=50");
  }
}

let equipmentCache = { key: "", at: 0, data: null };

/**
 * The equipment profile to use for new recipes, copied from an existing
 * Brewfather recipe (the API has no equipment endpoint). Uses the recipe
 * chosen in Settings, or the most recent recipe. Cached for 5 minutes.
 * Also returns that recipe's water setup and style code.
 * Returns { equipment, water, styleCode, fromRecipe } or null if there are no recipes.
 */
export async function getEquipment(settings, { refresh = false } = {}) {
  const key = `${settings.brewfatherUserId}:${settings.brewfatherApiKey.slice(-6)}:${settings.equipmentRecipeId || "latest"}`;
  if (!refresh && equipmentCache.key === key && Date.now() - equipmentCache.at < INVENTORY_TTL_MS) {
    return equipmentCache.data;
  }
  let id = settings.equipmentRecipeId;
  if (!id) {
    const list = await listRecipes(settings);
    id = Array.isArray(list) && list[0]?._id;
  }
  let data = null;
  if (id) {
    const full = await bf(settings, "GET", `/recipes/${encodeURIComponent(id)}`);
    if (full?.equipment || full?.water) {
      data = {
        equipment: full.equipment || null,
        water: full.water || null,
        styleCode: full.style ? `${full.style.categoryNumber || ""}${full.style.styleLetter || ""}`.toUpperCase() : "",
        fromRecipe: { id: full._id || id, name: full.name },
      };
    }
  }
  equipmentCache = { key, at: Date.now(), data };
  return data;
}

/** Brewhouse efficiency from a Brewfather equipment profile, if it has one. */
export function equipmentEfficiency(equipment) {
  const e = Number(equipment?.efficiency ?? equipment?.brewhouseEfficiency);
  return Number.isFinite(e) && e > 0 ? e : null;
}

/** Cheap check that credentials work (one call). */
export async function testConnection(settings) {
  await bf(settings, "GET", "/recipes?limit=1");
  return true;
}

// ---- Mapping our recipe format to Brewfather's recipe object ----

// Copy an inventory item so the recipe ingredient keeps Brewfather's own data
// (supplier, analysis, etc.), minus stock levels and server bookkeeping.
function fromInventory(inventory, collection, id) {
  if (!id) return {};
  const item = (inventory?.[collection] || []).find((x) => x._id === id);
  if (!item) return {};
  const copy = {};
  for (const [k, v] of Object.entries(item)) {
    if (k === "inventory" || (k.startsWith("_") && k !== "_id")) continue;
    copy[k] = v;
  }
  return copy;
}

const HOP_USE = {
  Boil: "Boil",
  "First Wort": "First Wort",
  Mash: "Mash",
  Whirlpool: "Aroma",
  "Dry Hop": "Dry Hop",
};

function lovibondToSrm(l) {
  return Math.max(0, Math.round((1.3546 * l - 0.76) * 10) / 10);
}

// Copy the brewer's equipment profile and apply this recipe's batch size,
// boil time and efficiency, so Brewfather doesn't fall back to defaults.
function equipmentFor(recipe, equipment) {
  if (!equipment) return null;
  const copy = { ...equipment };
  const sizeChanged = Number(copy.batchSize) !== recipe.batch_size_l || Number(copy.boilTime) !== recipe.boil_time_min;
  copy.batchSize = recipe.batch_size_l;
  copy.boilTime = recipe.boil_time_min;
  copy.efficiency = recipe.efficiency_pct;
  if ("brewhouseEfficiency" in copy) copy.brewhouseEfficiency = recipe.efficiency_pct;
  // Let Brewfather work out the pre-boil volume for the new batch size.
  if (sizeChanged) copy.calcBoilVolume = true;
  return copy;
}

// Water treatment is left to Brewfather's water calculator. Copy the
// brewer's water setup (source water report, settings and, when the template
// recipe is the same style, the target profile) but not the salt and acid
// amounts or anything volume-dependent: those are recalculated in Brewfather.
const WATER_SKIP = new Set([
  "mash", "sparge", "total", "diluted",
  "mashAdjustments", "spargeAdjustments", "totalAdjustments",
  "sourceTargetDiff", "mashTargetDiff", "spargeTargetDiff", "totalTargetDiff",
  "mashWaterAmount", "spargeWaterAmount", "dilutionAmount",
  "mashPh", "mashPhDistilled", "acidPhAdjustment", "spargeAcidPhAdjustment",
]);

export function waterFor(recipe, template) {
  if (!template?.water) return null;
  const copy = {};
  for (const [k, v] of Object.entries(template.water)) if (!WATER_SKIP.has(k)) copy[k] = v;
  const sameStyle = template.styleCode && template.styleCode === String(recipe.style?.bjcp_code || "").toUpperCase();
  if (!sameStyle) copy.target = null;
  return copy;
}

// Brewfather style object with the ranges filled in, so Brewfather shows the
// style's ranges against the recipe.
function brewfatherStyle(recipe) {
  const code = String(recipe.style.bjcp_code || "").toUpperCase();
  const r = rangesFor(recipe) || {};
  const pair = (key, min, max) => (r[key] ? { [min]: r[key][0], [max]: r[key][1] } : {});
  return {
    name: recipe.style.name,
    category: bjcpCategory(code) || recipe.style.name,
    categoryNumber: code.replace(/[A-Z]$/, ""),
    styleLetter: (code.match(/[A-Z]$/) || [""])[0],
    styleGuide: code ? "BJCP 2021" : "",
    type: "Beer",
    ...pair("og", "ogMin", "ogMax"),
    ...pair("fg", "fgMin", "fgMax"),
    ...pair("abv", "abvMin", "abvMax"),
    ...pair("ibu", "ibuMin", "ibuMax"),
    ...pair("srm", "colorMin", "colorMax"),
  };
}

export function toBrewfatherRecipe(recipe, inventory, equipment = null, template = null) {
  const stats = computeStats(recipe);
  const equip = equipmentFor(recipe, equipment);
  const water = waterFor(recipe, template);

  const fermentables = recipe.fermentables.map((f) => ({
    ...fromInventory(inventory, "fermentables", f.inventory_id),
    name: f.name,
    type: f.type,
    amount: f.amount_kg,
    // Brewfather stores grain colour in SRM, with Lovibond as a separate field.
    color: lovibondToSrm(f.color_lovibond),
    lovibond: f.color_lovibond,
    potential: f.potential_sg,
    potentialPercentage: Math.round(((f.potential_sg - 1) / 0.04621) * 1000) / 10,
    ...(f.supplier ? { supplier: f.supplier } : {}),
  }));

  const hops = recipe.hops.map((h) => {
    const base = {
      ...fromInventory(inventory, "hops", h.inventory_id),
      name: h.name,
      amount: h.amount_g,
      alpha: h.alpha_pct,
      use: HOP_USE[h.use] || h.use,
      type: h.form,
    };
    if (h.use === "Dry Hop") return { ...base, time: h.dry_hop_duration_days, timeUnit: "day", day: h.dry_hop_day };
    if (h.use === "Whirlpool") return { ...base, time: h.time_min, temp: h.temp_c };
    return { ...base, time: h.use === "First Wort" ? recipe.boil_time_min : h.time_min };
  });

  const yeasts = recipe.yeasts.map((y) => ({
    ...fromInventory(inventory, "yeasts", y.inventory_id),
    name: y.name,
    laboratory: y.laboratory,
    productId: y.product_id,
    type: y.type,
    form: y.form,
    attenuation: y.attenuation_pct,
    amount: y.amount,
    unit: y.unit,
    minTemp: y.min_temp_c,
    maxTemp: y.max_temp_c,
  }));

  const miscs = recipe.miscs.map((m) => ({
    ...fromInventory(inventory, "miscs", m.inventory_id),
    name: m.name,
    amount: m.amount,
    unit: m.unit,
    use: m.use,
    time: m.time_min,
    type: m.type,
  }));

  const notes = [recipe.description, recipe.water_notes && `Water (set up in Brewfather's water calculator): ${recipe.water_notes}`, recipe.notes]
    .filter(Boolean)
    .join("\n\n");

  return {
    name: recipe.name,
    type: "All Grain",
    batchSize: recipe.batch_size_l,
    boilTime: recipe.boil_time_min,
    efficiency: recipe.efficiency_pct,
    ...(equip ? { equipment: equip } : {}),
    ...(water ? { water } : {}),
    ...(equip && equip.mashEfficiency != null ? { mashEfficiency: equip.mashEfficiency } : {}),
    style: brewfatherStyle(recipe),
    og: stats.og,
    fg: stats.fg,
    ibu: stats.ibu,
    abv: stats.abv,
    fermentables,
    hops,
    yeasts,
    miscs,
    mash: {
      name: "Recipe mash",
      steps: recipe.mash_steps.map((s) => ({
        type: "Temperature",
        name: s.name,
        stepTemp: s.temp_c,
        stepTime: s.time_min,
      })),
    },
    fermentation: {
      name: "Recipe fermentation",
      steps: recipe.fermentation_steps.map((s) => ({
        type: s.name.toLowerCase().includes("cold") ? "Cold Crash" : "Primary",
        name: s.name,
        stepTemp: s.temp_c,
        stepTime: s.days,
      })),
    },
    notes,
  };
}

function recipeUrl(id) {
  return id ? `https://web.brewfather.app/tabs/recipes/recipe/${id}` : "https://web.brewfather.app/tabs/recipes";
}

export async function createRecipe(settings, recipe, inventory, template) {
  const body = toBrewfatherRecipe(recipe, inventory, template?.equipment, template);
  const result = await bf(settings, "POST", "/recipes", body);
  const id = result?.id || result?._id;
  return { id, url: recipeUrl(id) };
}

/** Overwrite an existing Brewfather recipe (PATCH replaces each top-level field sent). */
export async function updateRecipe(settings, id, recipe, inventory, template) {
  const body = toBrewfatherRecipe(recipe, inventory, template?.equipment, template);
  await bf(settings, "PATCH", `/recipes/${encodeURIComponent(id)}`, body);
  return { id, url: recipeUrl(id), updated: true };
}
