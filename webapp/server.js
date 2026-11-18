import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  requireLogin,
  checkPassword,
  passwordConfigured,
  setLoginCookie,
  clearLoginCookie,
  isLoggedIn,
  loginThrottle,
  recordLoginFailure,
  clearLoginFailures,
} from "./lib/auth.js";
import { loadSettings, publicSettings, updateSettings, DATA_DIR } from "./lib/settings.js";
import { getInventory, createRecipe, testConnection, BrewfatherError } from "./lib/brewfather.js";
import { chatTurn } from "./lib/claude.js";
import { computeStats, annotateStock } from "./lib/calc.js";
import { validateRecipe } from "./lib/recipe-schema.js";
import { rangesFor, checkRanges } from "./lib/styles.js";
import { MOCK_INVENTORY, mockChatTurn } from "./lib/mock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const MOCK = process.env.MOCK === "1";
const PORT = Number(process.env.PORT) || 3000;

const app = express();
app.set("trust proxy", 1); // behind Passenger / a reverse proxy on cPanel
app.disable("x-powered-by");
app.use(express.json({ limit: "4mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

// ---- Login ----
app.get("/login", (req, res) => {
  if (isLoggedIn(req)) return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "login.html"));
});

app.post("/api/login", (req, res) => {
  if (!passwordConfigured()) {
    return res.status(503).json({ error: "ADMIN_PASSWORD is not set on the server. Set it as an environment variable and restart." });
  }
  const ip = req.ip || "unknown";
  const wait = loginThrottle(ip);
  if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });
  if (!checkPassword(req.body?.password)) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: "Wrong password." });
  }
  clearLoginFailures(ip);
  setLoginCookie(req, res);
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  clearLoginCookie(res);
  res.json({ ok: true });
});

app.get("/styles.css", (req, res) => res.sendFile(path.join(PUBLIC, "styles.css")));
app.get("/login.js", (req, res) => res.sendFile(path.join(PUBLIC, "login.js")));

// Everything below needs a login.
app.use(requireLogin);
app.use(express.static(PUBLIC, { index: "index.html" }));

function sendError(res, err) {
  const status =
    err instanceof BrewfatherError ? (err.status >= 500 ? 502 : err.status || 502)
    : err instanceof Anthropic.AuthenticationError ? 400
    : err instanceof Anthropic.RateLimitError ? 429
    : err instanceof Anthropic.APIError ? 502
    : err.status || 500;
  let message = err.message || "Something went wrong";
  if (err instanceof Anthropic.AuthenticationError) message = "The Anthropic API key was rejected. Check it in Settings.";
  if (err instanceof Anthropic.RateLimitError) message = "Anthropic rate limit reached. Wait a moment and try again.";
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message, details: err.details });
}

// ---- Settings ----
app.get("/api/settings", (req, res) => res.json({ ...publicSettings(), mock: MOCK, dataDir: DATA_DIR }));

app.post("/api/settings", (req, res) => {
  try {
    res.json(updateSettings(req.body || {}));
  } catch (err) {
    sendError(res, err);
  }
});

app.post("/api/settings/test-brewfather", async (req, res) => {
  try {
    const settings = loadSettings();
    await testConnection(settings);
    const inv = await getInventory(settings, { refresh: true });
    res.json({ ok: true, counts: Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, v.length])) });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- Inventory ----
async function inventoryFor(settings, opts) {
  if (MOCK) return MOCK_INVENTORY;
  if (!settings.brewfatherUserId || !settings.brewfatherApiKey) return null;
  return getInventory(settings, opts);
}

app.get("/api/inventory", async (req, res) => {
  try {
    const inv = await inventoryFor(loadSettings(), { refresh: req.query.refresh === "1" });
    res.json({ inventory: inv });
  } catch (err) {
    sendError(res, err);
  }
});

function prepareRecipe(recipe, inventory) {
  const stats = computeStats(recipe);
  const ranges = rangesFor(recipe);
  return { ...annotateStock(recipe, inventory), stats, ranges, rangeCheck: checkRanges(stats, ranges) };
}

// ---- Chat ----
app.post("/api/chat", async (req, res) => {
  try {
    const { history = [], text } = req.body || {};
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Message is empty." });
    if (!Array.isArray(history)) return res.status(400).json({ error: "Bad history." });

    const settings = loadSettings();
    let inventory = null;
    let inventoryWarning = "";
    try {
      inventory = await inventoryFor(settings);
    } catch (err) {
      inventoryWarning = `Couldn't load Brewfather inventory: ${err.message}`;
    }

    const turn = MOCK
      ? mockChatTurn({ history, text: text.trim() })
      : await chatTurn({ settings, inventory, history, text: text.trim() });

    res.json({
      history: turn.history,
      reply: turn.reply,
      recipe: turn.recipe ? prepareRecipe(turn.recipe, inventory) : null,
      inventoryWarning,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Recalculate after the brewer edits the batch size etc. on the review screen.
app.post("/api/recipe/calc", async (req, res) => {
  try {
    const recipe = req.body?.recipe;
    const errors = validateRecipe(recipe);
    if (errors.length) return res.status(400).json({ error: errors.join("; ") });
    const inventory = await inventoryFor(loadSettings()).catch(() => null);
    res.json({ recipe: prepareRecipe(recipe, inventory) });
  } catch (err) {
    sendError(res, err);
  }
});

// ---- Push to Brewfather ----
app.post("/api/recipe/push", async (req, res) => {
  try {
    const recipe = req.body?.recipe;
    const errors = validateRecipe(recipe);
    if (errors.length) return res.status(400).json({ error: errors.join("; ") });
    if (MOCK) return res.json({ id: "mock-recipe", url: "https://web.brewfather.app/tabs/recipes", mock: true });
    const settings = loadSettings();
    const inventory = await inventoryFor(settings).catch(() => null);
    res.json(await createRecipe(settings, recipe, inventory));
  } catch (err) {
    sendError(res, err);
  }
});

app.listen(PORT, () => {
  console.log(`Brew Recipe Maker on http://localhost:${PORT}${MOCK ? " (demo mode: no API calls)" : ""}`);
  if (!passwordConfigured()) console.warn("ADMIN_PASSWORD is not set; nobody can log in until it is.");
});
