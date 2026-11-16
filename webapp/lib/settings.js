// Settings live in a JSON file on the server (never in the browser).
// API keys are returned to the UI only in masked form.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const SECRET_FILE = path.join(DATA_DIR, "session-secret");

export const DEFAULT_MODEL = "claude-sonnet-5-5";

const DEFAULTS = {
  anthropicApiKey: "",
  brewfatherUserId: "",
  brewfatherApiKey: "",
  model: DEFAULT_MODEL,
  batchSizeL: 23,
  efficiencyPct: 72,
  boilTimeMin: 60,
  brewerNotes: "",
};

const SECRET_KEYS = ["anthropicApiKey", "brewfatherApiKey"];

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

export function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(settings) {
  ensureDataDir();
  const tmp = `${SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SETTINGS_FILE);
}

function mask(value) {
  if (!value) return "";
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

/** Settings safe to send to the browser. */
export function publicSettings() {
  const s = loadSettings();
  const out = { ...s };
  for (const k of SECRET_KEYS) {
    out[k] = "";
    out[`${k}Masked`] = mask(s[k]);
  }
  return out;
}

function num(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Merge an update from the admin form. Blank secret fields keep the stored value. */
export function updateSettings(input) {
  const current = loadSettings();
  const next = { ...current };

  for (const k of SECRET_KEYS) {
    if (input[`clear_${k}`] === true) next[k] = "";
    else if (typeof input[k] === "string" && input[k].trim()) next[k] = input[k].trim();
  }
  if (typeof input.brewfatherUserId === "string") next.brewfatherUserId = input.brewfatherUserId.trim();
  if (typeof input.model === "string" && input.model.trim()) next.model = input.model.trim();
  if (typeof input.brewerNotes === "string") next.brewerNotes = input.brewerNotes.slice(0, 4000);
  next.batchSizeL = num(input.batchSizeL, current.batchSizeL, 1, 2000);
  next.efficiencyPct = num(input.efficiencyPct, current.efficiencyPct, 30, 100);
  next.boilTimeMin = num(input.boilTimeMin, current.boilTimeMin, 0, 240);

  writeSettings(next);
  return publicSettings();
}

/** Secret used to sign the login cookie. From env, else generated once and stored. */
export function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try {
    return fs.readFileSync(SECRET_FILE, "utf8").trim();
  } catch {
    ensureDataDir();
    const secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  }
}
