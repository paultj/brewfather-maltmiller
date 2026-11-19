import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { openDb } from "./lib/db.js";
import { requireLogin, requireAdmin, currentUser, setLoginCookie, clearLoginCookie, loginThrottle, recordLoginFailure, clearLoginFailures } from "./lib/auth.js";
import { maskSettings, DATA_DIR } from "./lib/settings.js";
import { passwordProblem, verifyPassword } from "./lib/secrets.js";
import {
  UserError,
  userCount,
  getUser,
  listUsers,
  publicUser,
  authenticate,
  setPassword,
  setDisabled,
  deleteUser,
  adminCount,
  findUserByEmail,
  getSettings,
  updateUserSettings,
  setupFirstAdmin,
  createInvite,
  inviteProblem,
  registerWithInvite,
  listInvites,
  revokeInvite,
  createPasswordReset,
  resetProblem,
  resetPassword,
  getConfig,
  updateConfig,
  publicConfig,
  INVITE_DAYS,
} from "./lib/users.js";
import { recordChat, recordPush, metrics, userUsage, cleanConversationId } from "./lib/usage.js";
import { mailConfigured, sendMail } from "./lib/mailer.js";
import { getInventory, createRecipe, updateRecipe, testConnection, listRecipes, getEquipment, equipmentEfficiency, waterFor, BrewfatherError } from "./lib/brewfather.js";
import { chatTurn } from "./lib/claude.js";
import { computeStats, annotateStock } from "./lib/calc.js";
import { validateRecipe } from "./lib/recipe-schema.js";
import { rangesFor, checkRanges } from "./lib/styles.js";
import { MOCK_INVENTORY, mockChatTurn } from "./lib/mock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
const MOCK = process.env.MOCK === "1";
const PORT = Number(process.env.PORT) || 3000;

openDb();

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

function sendError(res, err) {
  const status =
    err instanceof UserError ? err.status
    : err instanceof BrewfatherError ? (err.status >= 500 ? 502 : err.status || 502)
    : err instanceof Anthropic.AuthenticationError ? 400
    : err instanceof Anthropic.RateLimitError ? 429
    : err instanceof Anthropic.APIError ? 502
    : err.status || 500;
  let message = err.message || "Something went wrong";
  if (err instanceof Anthropic.AuthenticationError) message = "Your Anthropic API key was rejected. Check it in Settings.";
  if (err instanceof Anthropic.RateLimitError) message = "Anthropic rate limit reached. Wait a moment and try again.";
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message, details: err.details });
}

const handle = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    sendError(res, err);
  }
};

/** Base address for links in invites and reset emails. */
function baseUrl(req) {
  return getConfig().appUrl || `${req.protocol}://${req.get("host")}`;
}

// ---- Pages and files anyone can load ----
const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC, file));
app.get("/login", (req, res) => (currentUser(req) ? res.redirect("/") : page("login.html")(req, res)));
app.get("/register", page("register.html"));
app.get("/reset", page("reset.html"));
for (const f of ["styles.css", "login.js", "register.js", "reset.js", "common.js"]) app.get(`/${f}`, page(f));

// ---- Sign-in, setup, sign-up, password reset ----
app.get("/api/auth/status", (req, res) => {
  res.json({ setupNeeded: userCount() === 0, setupPossible: Boolean(process.env.ADMIN_PASSWORD), mail: mailConfigured() });
});

app.post(
  "/api/setup",
  handle((req, res) => {
    const { setupPassword, email, password } = req.body || {};
    const ip = req.ip || "unknown";
    const wait = loginThrottle(ip);
    if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    try {
      const { user, migrated } = setupFirstAdmin({ setupPassword, email, password });
      setLoginCookie(req, res, user);
      res.json({ ok: true, migrated });
    } catch (err) {
      if (err.status === 401) recordLoginFailure(ip);
      throw err;
    }
  }),
);

app.post(
  "/api/login",
  handle((req, res) => {
    const { email, password } = req.body || {};
    const ip = req.ip || "unknown";
    const wait = loginThrottle(ip, email);
    if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });
    const user = authenticate(email, password);
    if (!user) {
      recordLoginFailure(ip, email);
      return res.status(401).json({ error: "Wrong email or password." });
    }
    clearLoginFailures(ip, email);
    setLoginCookie(req, res, user);
    res.json({ ok: true });
  }),
);

app.post("/api/logout", (req, res) => {
  clearLoginCookie(res);
  res.json({ ok: true });
});

app.get("/api/invite/:token", (req, res) => {
  const problem = inviteProblem(req.params.token);
  res.status(problem ? 410 : 200).json(problem ? { error: problem } : { ok: true });
});

app.post(
  "/api/register",
  handle((req, res) => {
    const { token, email, password } = req.body || {};
    const ip = req.ip || "unknown";
    const wait = loginThrottle(ip);
    if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    const user = registerWithInvite({ token, email, password });
    setLoginCookie(req, res, user);
    res.json({ ok: true });
  }),
);

app.post(
  "/api/password/forgot",
  handle(async (req, res) => {
    const config = getConfig();
    if (!mailConfigured(config) || !config.appUrl) {
      return res.json({ mail: false, message: "Email isn't set up on this site yet. Ask the person who invited you for a password reset link." });
    }
    const ip = req.ip || "unknown";
    const wait = loginThrottle(ip);
    if (wait) return res.status(429).json({ error: `Too many attempts. Try again in ${wait}s.` });
    recordLoginFailure(ip); // counts towards the throttle so this can't be used to flood inboxes
    const user = findUserByEmail(req.body?.email);
    if (user && !user.disabled) {
      const token = createPasswordReset(user.id, 2);
      await sendMail({
        to: user.email,
        subject: "Reset your Brew Recipe Maker password",
        text: `Someone (hopefully you) asked to reset the password for ${user.email}.\n\nTo choose a new password, open this link within 2 hours:\n${config.appUrl}/reset?token=${token}\n\nIf you didn't ask for this, you can ignore this email.`,
      }).catch((err) => console.error("Reset email failed:", err.message));
    }
    // Same answer whether or not the account exists.
    res.json({ mail: true, message: "If there's an account with that email, a reset link is on its way. Check your spam folder too." });
  }),
);

app.get("/api/password/reset/:token", (req, res) => {
  const problem = resetProblem(req.params.token);
  res.status(problem ? 410 : 200).json(problem ? { error: problem } : { ok: true });
});

app.post(
  "/api/password/reset",
  handle((req, res) => {
    const { token, password } = req.body || {};
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    const user = resetPassword(token, password);
    setLoginCookie(req, res, user);
    res.json({ ok: true });
  }),
);

// ---- Everything below needs a login ----
app.use(requireLogin);
app.get("/admin.html", requireAdmin, page("admin.html"));
app.get("/admin.js", requireAdmin, page("admin.js"));
app.use(express.static(PUBLIC, { index: "index.html" }));

app.get("/api/me", (req, res) => res.json({ user: publicUser(req.user), mock: MOCK }));

// ---- Account ----
app.get(
  "/api/account/usage",
  handle((req, res) => res.json({ ...userUsage(req.user.id), gbpPerUsd: getConfig().gbpPerUsd })),
);

app.post(
  "/api/account/password",
  handle((req, res) => {
    const { current, password } = req.body || {};
    if (!verifyPassword(current, req.user.password_hash)) return res.status(400).json({ error: "Your current password is wrong." });
    const problem = passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    setLoginCookie(req, res, setPassword(req.user.id, password));
    res.json({ ok: true });
  }),
);

app.post(
  "/api/account/delete",
  handle((req, res) => {
    if (!verifyPassword(req.body?.password, req.user.password_hash)) return res.status(400).json({ error: "Your password is wrong." });
    if (req.user.is_admin && adminCount() <= 1) return res.status(400).json({ error: "You're the only admin, so this account can't be deleted." });
    deleteUser(req.user.id);
    clearLoginCookie(res);
    res.json({ ok: true });
  }),
);

// ---- Settings (per user) ----
app.get("/api/settings", (req, res) => res.json({ ...maskSettings(getSettings(req.user.id)), mock: MOCK }));

app.post(
  "/api/settings",
  handle((req, res) => res.json({ ...maskSettings(updateUserSettings(req.user.id, req.body || {})), mock: MOCK })),
);

app.post(
  "/api/settings/test-brewfather",
  handle(async (req, res) => {
    const settings = getSettings(req.user.id);
    await testConnection(settings);
    const inv = await getInventory(settings, { refresh: true });
    const equip = await getEquipment(settings, { refresh: true }).catch(() => null);
    res.json({
      ok: true,
      counts: Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, v.length])),
      equipment: equip?.equipment
        ? {
            name: equip.equipment.name || "(unnamed)",
            fromRecipe: equip.fromRecipe.name,
            efficiency: equipmentEfficiency(equip.equipment),
            batchSize: equip.equipment.batchSize,
            boilTime: equip.equipment.boilTime,
          }
        : null,
      water: equip?.water ? { source: equip.water.source?.name || "", target: equip.water.target?.name || "", fromRecipe: equip.fromRecipe.name } : null,
    });
  }),
);

// Recipes for the "copy equipment from" picker in Settings.
app.get(
  "/api/brewfather/recipes",
  handle(async (req, res) => {
    if (MOCK) return res.json({ recipes: [] });
    const list = await listRecipes(getSettings(req.user.id));
    res.json({ recipes: (list || []).map((r) => ({ id: r._id, name: r.name, equipment: r.equipment?.name || "" })) });
  }),
);

// Equipment copied from Brewfather (null if unavailable). Never throws.
async function equipmentFor(settings) {
  if (MOCK || !settings.brewfatherUserId || !settings.brewfatherApiKey) return null;
  try {
    return await getEquipment(settings);
  } catch (err) {
    console.warn("Couldn't load Brewfather equipment:", err.message);
    return null;
  }
}

// Settings with the efficiency from the Brewfather equipment profile, when available.
async function effectiveSettings(settings) {
  const equip = await equipmentFor(settings);
  const eff = equipmentEfficiency(equip?.equipment);
  if (!eff) return { settings, equip };
  return {
    settings: { ...settings, efficiencyPct: eff, efficiencySource: `from Brewfather equipment "${equip.equipment.name || equip.fromRecipe.name}"` },
    equip,
  };
}

// ---- Inventory ----
async function inventoryFor(settings, opts) {
  if (MOCK) return MOCK_INVENTORY;
  if (!settings.brewfatherUserId || !settings.brewfatherApiKey) return null;
  return getInventory(settings, opts);
}

app.get(
  "/api/inventory",
  handle(async (req, res) => {
    const inv = await inventoryFor(getSettings(req.user.id), { refresh: req.query.refresh === "1" });
    res.json({ inventory: inv });
  }),
);

function prepareRecipe(recipe, inventory) {
  const stats = computeStats(recipe);
  const ranges = rangesFor(recipe);
  return { ...annotateStock(recipe, inventory), stats, ranges, rangeCheck: checkRanges(stats, ranges) };
}

// ---- Chat ----
app.post("/api/chat", async (req, res) => {
  const { history = [], text, conversationId } = req.body || {};
  const convId = cleanConversationId(conversationId);
  try {
    if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Message is empty." });
    if (!Array.isArray(history)) return res.status(400).json({ error: "Bad history." });

    const settings = getSettings(req.user.id);
    if (!MOCK && !settings.anthropicApiKey) return res.status(400).json({ error: "Add your Anthropic API key in Settings first." });
    let inventory = null;
    let inventoryWarning = "";
    try {
      inventory = await inventoryFor(settings);
    } catch (err) {
      inventoryWarning = `Couldn't load Brewfather inventory: ${err.message}`;
    }

    const turn = MOCK
      ? mockChatTurn({ history, text: text.trim() })
      : await chatTurn({ settings: (await effectiveSettings(settings)).settings, inventory, history, text: text.trim() });
    if (turn.usage?.requests) recordChat(req.user.id, convId, turn.usage);

    res.json({
      history: turn.history,
      reply: turn.reply,
      recipe: turn.recipe ? prepareRecipe(turn.recipe, inventory) : null,
      inventoryWarning,
    });
  } catch (err) {
    if (err.usage?.requests) recordChat(req.user.id, convId, err.usage);
    sendError(res, err);
  }
});

// Recalculate after the brewer edits the batch size etc. on the review screen.
app.post(
  "/api/recipe/calc",
  handle(async (req, res) => {
    const recipe = req.body?.recipe;
    const errors = validateRecipe(recipe);
    if (errors.length) return res.status(400).json({ error: errors.join("; ") });
    const inventory = await inventoryFor(getSettings(req.user.id)).catch(() => null);
    res.json({ recipe: prepareRecipe(recipe, inventory) });
  }),
);

// ---- Push to Brewfather ----
app.post(
  "/api/recipe/push",
  handle(async (req, res) => {
    const recipe = req.body?.recipe;
    const errors = validateRecipe(recipe);
    if (errors.length) return res.status(400).json({ error: errors.join("; ") });
    const updateId = typeof req.body?.updateId === "string" && req.body.updateId ? req.body.updateId : null;
    const convId = cleanConversationId(req.body?.conversationId);
    if (MOCK) {
      const id = updateId || `mock-recipe-${Date.now()}`;
      recordPush(req.user.id, convId, { recipeName: recipe.name, brewfatherId: id, created: !updateId });
      return res.json({ id, url: "https://web.brewfather.app/tabs/recipes", mock: true, updated: Boolean(updateId) });
    }
    const settings = getSettings(req.user.id);
    const inventory = await inventoryFor(settings).catch(() => null);
    const { equip } = await effectiveSettings(settings);
    const result = updateId
      ? await updateRecipe(settings, updateId, recipe, inventory, equip)
      : await createRecipe(settings, recipe, inventory, equip);
    recordPush(req.user.id, convId, { recipeName: recipe.name, brewfatherId: result.id || updateId || "", created: !updateId });
    res.json({
      ...result,
      equipment: equip?.equipment ? equip.equipment.name || equip.fromRecipe.name : null,
      water: equip?.water
        ? { source: equip.water.source?.name || "", targetCopied: Boolean(waterFor(recipe, equip)?.target) }
        : null,
    });
  }),
);

// ---- Admin ----
const admin = express.Router();
admin.use(requireAdmin);

admin.get(
  "/overview",
  handle((req, res) => {
    const m = metrics();
    const usageByUser = new Map(m.users.map((u) => [u.userId, u]));
    const users = listUsers().map((u) => {
        const s = getSettings(u.id);
        const usage = usageByUser.get(u.id) || {};
        return {
          id: u.id,
          email: u.email,
          isAdmin: Boolean(u.is_admin),
          disabled: Boolean(u.disabled),
          createdAt: u.created_at,
          lastSeenAt: u.last_seen_at,
          hasAnthropicKey: Boolean(s.anthropicApiKey),
          hasBrewfather: Boolean(s.brewfatherUserId && s.brewfatherApiKey),
          model: s.model,
          costMonthUsd: usage.costMonth || 0,
          costTotalUsd: usage.costTotal || 0,
          startedMonth: usage.conversationsMonth || 0,
          pushedMonth: usage.createdMonth || 0,
          pushedTotal: usage.createdTotal || 0,
        };
      });
    res.json({ me: req.user.id, users, invites: listInvites(), metrics: m, config: publicConfig(), mail: mailConfigured(), inviteDays: INVITE_DAYS });
  }),
);

admin.post(
  "/invites",
  handle((req, res) => {
    const { id, token } = createInvite({ createdBy: req.user.id, note: req.body?.note || "", days: req.body?.days });
    res.json({ id, link: `${baseUrl(req)}/register?invite=${token}` });
  }),
);

admin.post(
  "/invites/:id/revoke",
  handle((req, res) => {
    revokeInvite(Number(req.params.id));
    res.json({ ok: true });
  }),
);

function targetUser(req) {
  const u = getUser(Number(req.params.id));
  if (!u) throw new UserError("No such user.", 404);
  return u;
}

admin.post(
  "/users/:id/reset-link",
  handle((req, res) => {
    const u = targetUser(req);
    const token = createPasswordReset(u.id, 48);
    res.json({ link: `${baseUrl(req)}/reset?token=${token}`, hours: 48 });
  }),
);

admin.post(
  "/users/:id/disable",
  handle((req, res) => {
    const u = targetUser(req);
    if (u.id === req.user.id) throw new UserError("You can't disable your own account.");
    setDisabled(u.id, Boolean(req.body?.disabled));
    res.json({ ok: true });
  }),
);

admin.post(
  "/users/:id/delete",
  handle((req, res) => {
    const u = targetUser(req);
    if (u.id === req.user.id) throw new UserError("Delete your own account from Settings instead.");
    deleteUser(u.id);
    res.json({ ok: true });
  }),
);

admin.post(
  "/config",
  handle((req, res) => res.json({ config: publicConfig(updateConfig(req.body || {})), mail: mailConfigured() })),
);

admin.post(
  "/test-email",
  handle(async (req, res) => {
    await sendMail({ to: req.user.email, subject: "Brew Recipe Maker test email", text: "Email from Brew Recipe Maker is working." });
    res.json({ ok: true, to: req.user.email });
  }),
);

app.use("/api/admin", admin);

app.listen(PORT, () => {
  console.log(`Brew Recipe Maker on http://localhost:${PORT}${MOCK ? " (demo mode: no API calls)" : ""}`);
  console.log(`Data folder: ${DATA_DIR}`);
  if (userCount() === 0) {
    console.log(
      process.env.ADMIN_PASSWORD
        ? "No accounts yet: open the site and use ADMIN_PASSWORD to create the admin account."
        : "No accounts yet and ADMIN_PASSWORD is not set; set it and restart to create the admin account.",
    );
  }
});
