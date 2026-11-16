// Brewfather API v2: read inventory, create recipes.
// Docs: https://docs.brewfather.app/api  (500 calls/hour per key)
import { computeStats } from "./calc.js";

const BASE = "https://api.brewfather.app/v2";
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

export function toBrewfatherRecipe(recipe, inventory) {
  const stats = computeStats(recipe);

  const fermentables = recipe.fermentables.map((f) => ({
    ...fromInventory(inventory, "fermentables", f.inventory_id),
    name: f.name,
    type: f.type,
    amount: f.amount_kg,
    color: f.color_lovibond,
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

  const notes = [recipe.description, recipe.water_notes && `Water: ${recipe.water_notes}`, recipe.notes]
    .filter(Boolean)
    .join("\n\n");

  return {
    name: recipe.name,
    type: "All Grain",
    batchSize: recipe.batch_size_l,
    boilTime: recipe.boil_time_min,
    efficiency: recipe.efficiency_pct,
    style: {
      name: recipe.style.name,
      categoryNumber: recipe.style.bjcp_code.replace(/[A-Z]$/i, ""),
      styleLetter: (recipe.style.bjcp_code.match(/[A-Z]$/i) || [""])[0],
      styleGuide: "BJCP 2021",
      type: "Beer",
    },
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

export async function createRecipe(settings, recipe, inventory) {
  const body = toBrewfatherRecipe(recipe, inventory);
  const result = await bf(settings, "POST", "/recipes", body);
  const id = result?.id || result?._id;
  return {
    id,
    url: id ? `https://web.brewfather.app/tabs/recipes/recipe/${id}` : "https://web.brewfather.app/tabs/recipes",
  };
}
