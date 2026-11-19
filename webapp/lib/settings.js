// Per-user settings (API keys, Brewfather account, brewing defaults).
// They are stored in the users table (see users.js) with the API keys
// encrypted. Keys are returned to the browser only in masked form.
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5"];

export const DEFAULTS = {
  anthropicApiKey: "",
  brewfatherUserId: "",
  brewfatherApiKey: "",
  equipmentRecipeId: "",
  model: DEFAULT_MODEL,
  batchSizeL: 23,
  efficiencyPct: 72,
  boilTimeMin: 60,
  brewerNotes: "",
};

export const SECRET_KEYS = ["anthropicApiKey", "brewfatherApiKey"];

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function mask(value) {
  if (!value) return "";
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

/** Settings safe to send to the browser. */
export function maskSettings(s) {
  const out = { ...DEFAULTS, ...s };
  for (const k of SECRET_KEYS) {
    out[`${k}Masked`] = mask(out[k]);
    out[k] = "";
  }
  return out;
}

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Merge an update from the settings form. Blank secret fields keep the stored value. */
export function mergeSettings(current, input) {
  const cur = { ...DEFAULTS, ...current };
  const next = { ...cur };
  for (const k of SECRET_KEYS) {
    if (input[`clear_${k}`] === true) next[k] = "";
    else if (typeof input[k] === "string" && input[k].trim()) next[k] = input[k].trim();
  }
  if (typeof input.brewfatherUserId === "string") next.brewfatherUserId = input.brewfatherUserId.trim();
  if (typeof input.equipmentRecipeId === "string") next.equipmentRecipeId = input.equipmentRecipeId.trim();
  if (typeof input.model === "string" && MODELS.includes(input.model.trim())) next.model = input.model.trim();
  if (typeof input.brewerNotes === "string") next.brewerNotes = input.brewerNotes.slice(0, 4000);
  if ("batchSizeL" in input) next.batchSizeL = num(input.batchSizeL, cur.batchSizeL, 1, 2000);
  if ("efficiencyPct" in input) next.efficiencyPct = num(input.efficiencyPct, cur.efficiencyPct, 30, 100);
  if ("boilTimeMin" in input) next.boilTimeMin = num(input.boilTimeMin, cur.boilTimeMin, 0, 240);
  return next;
}

/** Settings from the single-user version (data/settings.json), if present. */
export function readLegacySettings() {
  const file = path.join(DATA_DIR, "settings.json");
  try {
    return { file, settings: { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, "utf8")) } };
  } catch {
    return null;
  }
}
