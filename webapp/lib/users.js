// Accounts, invites, password resets, per-user settings and app config.
import fs from "node:fs";
import { getDb, now } from "./db.js";
import { DEFAULTS, SECRET_KEYS, mergeSettings, readLegacySettings } from "./settings.js";
import { encrypt, decrypt, hashPassword, verifyPassword, burnPasswordCheck, randomToken, hashToken } from "./secrets.js";

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 254) throw new UserError("Enter a valid email address.");
  return e;
}

const DAY = 86400_000;
const addMs = (ms) => new Date(Date.now() + ms).toISOString();

// ---------- Users ----------

export function userCount() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM users").get().n;
}

export function getUser(id) {
  return getDb().prepare("SELECT * FROM users WHERE id = ?").get(id) || null;
}

export function listUsers() {
  return getDb().prepare("SELECT * FROM users ORDER BY created_at").all();
}

export function findUserByEmail(email) {
  return getDb().prepare("SELECT * FROM users WHERE email = ?").get(String(email || "").trim().toLowerCase()) || null;
}

/** Public view of a user for the browser. */
export function publicUser(u) {
  return u && { id: u.id, email: u.email, isAdmin: Boolean(u.is_admin) };
}

export function createUser({ email, password, isAdmin = false, settings = {} }) {
  const e = normalizeEmail(email);
  if (findUserByEmail(e)) throw new UserError("There is already an account with that email. Try signing in, or reset your password.", 409);
  const info = getDb()
    .prepare("INSERT INTO users (email, password_hash, is_admin, settings, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(e, hashPassword(password), isAdmin ? 1 : 0, encodeSettings({ ...DEFAULTS, ...settings }), now());
  return getUser(Number(info.lastInsertRowid));
}

/** The user for this email and password, or null. */
export function authenticate(email, password) {
  const u = findUserByEmail(email);
  if (!u) {
    burnPasswordCheck(password);
    return null;
  }
  if (!verifyPassword(password, u.password_hash)) return null;
  if (u.disabled) throw new UserError("This account has been disabled.", 403);
  return u;
}

/** Sets a new password and signs the user out everywhere else. */
export function setPassword(userId, password) {
  getDb()
    .prepare("UPDATE users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?")
    .run(hashPassword(password), userId);
  return getUser(userId);
}

export function touchUser(userId) {
  getDb().prepare("UPDATE users SET last_seen_at = ? WHERE id = ?").run(now(), userId);
}

export function setDisabled(userId, disabled) {
  getDb().prepare("UPDATE users SET disabled = ?, session_version = session_version + 1 WHERE id = ?").run(disabled ? 1 : 0, userId);
}

export function deleteUser(userId) {
  getDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export function adminCount() {
  return getDb().prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND disabled = 0").get().n;
}

// ---------- Per-user settings ----------

function encodeSettings(s) {
  const out = { ...s };
  for (const k of SECRET_KEYS) out[k] = encrypt(s[k] || "");
  return JSON.stringify(out);
}

function decodeSettings(json) {
  let raw = {};
  try {
    raw = JSON.parse(json || "{}");
  } catch {
    // corrupt row: fall back to defaults
  }
  const out = { ...DEFAULTS, ...raw };
  for (const k of SECRET_KEYS) {
    try {
      out[k] = decrypt(raw[k] || "");
    } catch {
      // Encryption key changed or lost: the key has to be entered again.
      out[k] = "";
    }
  }
  return out;
}

export function getSettings(userId) {
  const row = getDb().prepare("SELECT settings FROM users WHERE id = ?").get(userId);
  return decodeSettings(row?.settings);
}

export function updateUserSettings(userId, input) {
  const next = mergeSettings(getSettings(userId), input || {});
  getDb().prepare("UPDATE users SET settings = ? WHERE id = ?").run(encodeSettings(next), userId);
  return next;
}

// ---------- First admin ----------

/**
 * First run: there are no users yet. Whoever knows ADMIN_PASSWORD creates the
 * admin account. Settings from the single-user version are moved into it.
 */
export function setupFirstAdmin({ setupPassword, email, password }) {
  if (userCount() > 0) throw new UserError("Setup is already done. Sign in instead.", 409);
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) throw new UserError("ADMIN_PASSWORD is not set on the server. Set it as an environment variable and restart.", 503);
  if (String(setupPassword) !== expected) throw new UserError("The setup password is wrong.", 401);
  const legacy = readLegacySettings();
  const user = createUser({ email, password, isAdmin: true, settings: legacy?.settings || {} });
  if (legacy) {
    // The keys now live (encrypted) in the database; don't leave a plain copy.
    try {
      fs.renameSync(legacy.file, `${legacy.file}.migrated`);
      const moved = JSON.parse(fs.readFileSync(`${legacy.file}.migrated`, "utf8"));
      for (const k of SECRET_KEYS) if (moved[k]) moved[k] = "(moved to the database)";
      fs.writeFileSync(`${legacy.file}.migrated`, JSON.stringify(moved, null, 2), { mode: 0o600 });
    } catch (err) {
      console.warn("Couldn't tidy up the old settings.json:", err.message);
    }
  }
  return { user, migrated: Boolean(legacy) };
}

// ---------- Invites ----------

export const INVITE_DAYS = 14;

/** Returns the invite and its token. Only the hash is stored, so the link is shown once. */
export function createInvite({ createdBy, note = "", days = INVITE_DAYS }) {
  const token = randomToken();
  const info = getDb()
    .prepare("INSERT INTO invites (token_hash, note, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)")
    .run(hashToken(token), String(note).slice(0, 200), createdBy, now(), addMs(Math.max(1, Math.min(90, Number(days) || INVITE_DAYS)) * DAY));
  return { id: Number(info.lastInsertRowid), token };
}

function inviteByToken(token) {
  return getDb().prepare("SELECT * FROM invites WHERE token_hash = ?").get(hashToken(token)) || null;
}

/** null if the invite can be used, else why not. */
export function inviteProblem(token) {
  const inv = token ? inviteByToken(token) : null;
  if (!inv || inv.revoked) return "This invite link isn't valid. Ask for a new one.";
  if (inv.used_at) return "This invite link has already been used. Ask for a new one, or sign in.";
  if (inv.expires_at < now()) return "This invite link has expired. Ask for a new one.";
  return null;
}

export function registerWithInvite({ token, email, password }) {
  const problem = inviteProblem(token);
  if (problem) throw new UserError(problem, 410);
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    // Claim the invite first so two sign-ups can't share it.
    const claimed = db
      .prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND revoked = 0")
      .run(now(), hashToken(token));
    if (claimed.changes !== 1) throw new UserError("This invite link has already been used.", 410);
    const user = createUser({ email, password });
    db.prepare("UPDATE invites SET used_by = ? WHERE token_hash = ?").run(user.id, hashToken(token));
    db.exec("COMMIT");
    return user;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function listInvites() {
  return getDb()
    .prepare(
      `SELECT i.id, i.note, i.created_at, i.expires_at, i.used_at, i.revoked, u.email AS used_by_email
       FROM invites i LEFT JOIN users u ON u.id = i.used_by
       ORDER BY i.created_at DESC LIMIT 100`,
    )
    .all()
    .map((i) => ({
      id: i.id,
      note: i.note,
      createdAt: i.created_at,
      expiresAt: i.expires_at,
      usedAt: i.used_at,
      usedBy: i.used_by_email,
      status: i.revoked ? "revoked" : i.used_at ? "used" : i.expires_at < now() ? "expired" : "open",
    }));
}

export function revokeInvite(id) {
  getDb().prepare("UPDATE invites SET revoked = 1 WHERE id = ? AND used_at IS NULL").run(id);
}

// ---------- Password resets ----------

/** A reset token for this user (valid for `hours`). */
export function createPasswordReset(userId, hours = 2) {
  const token = randomToken();
  getDb()
    .prepare("INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), userId, now(), addMs(hours * 3600_000));
  return token;
}

export function resetProblem(token) {
  const r = token ? getDb().prepare("SELECT * FROM password_resets WHERE token_hash = ?").get(hashToken(token)) : null;
  if (!r || r.used_at) return "This reset link isn't valid any more. Ask for a new one.";
  if (r.expires_at < now()) return "This reset link has expired. Ask for a new one.";
  return null;
}

export function resetPassword(token, password) {
  const problem = resetProblem(token);
  if (problem) throw new UserError(problem, 410);
  const r = getDb().prepare("SELECT * FROM password_resets WHERE token_hash = ?").get(hashToken(token));
  getDb().prepare("UPDATE password_resets SET used_at = ? WHERE id = ?").run(now(), r.id);
  return setPassword(r.user_id, password);
}

// ---------- App-wide config (admin) ----------

export const CONFIG_DEFAULTS = {
  appUrl: "", // e.g. https://brew.example.com; links use the request's host if empty
  gbpPerUsd: 0.76, // for showing costs in pounds; edit in the admin page
  smtpHost: "",
  smtpPort: 587,
  smtpSecure: false, // true for port 465
  smtpUser: "",
  smtpPass: "",
  mailFrom: "", // e.g. "Brew Recipe Maker <brew@example.com>"
};

export function getConfig() {
  const rows = getDb().prepare("SELECT key, value FROM app_config").all();
  const out = { ...CONFIG_DEFAULTS };
  for (const { key, value } of rows) {
    if (!(key in CONFIG_DEFAULTS)) continue;
    try {
      out[key] = JSON.parse(value);
    } catch {
      // ignore a bad row
    }
  }
  try {
    out.smtpPass = decrypt(out.smtpPass);
  } catch {
    out.smtpPass = "";
  }
  return out;
}

export function updateConfig(input) {
  const cur = getConfig();
  const next = { ...cur };
  const str = (k, max = 300) => {
    if (typeof input[k] === "string") next[k] = input[k].trim().slice(0, max);
  };
  str("appUrl");
  next.appUrl = next.appUrl.replace(/\/+$/, "");
  if (next.appUrl && !/^https?:\/\//.test(next.appUrl)) throw new UserError("The app address must start with https://");
  str("smtpHost");
  str("smtpUser");
  str("mailFrom");
  if (typeof input.smtpPass === "string" && input.smtpPass) next.smtpPass = input.smtpPass;
  if (input.clear_smtpPass === true) next.smtpPass = "";
  if ("smtpPort" in input) next.smtpPort = Math.round(Number(input.smtpPort)) || 587;
  if ("smtpSecure" in input) next.smtpSecure = Boolean(input.smtpSecure);
  if ("gbpPerUsd" in input) {
    const r = Number(input.gbpPerUsd);
    if (Number.isFinite(r) && r > 0 && r < 5) next.gbpPerUsd = r;
  }
  const put = getDb().prepare("INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const k of Object.keys(CONFIG_DEFAULTS)) put.run(k, JSON.stringify(k === "smtpPass" ? encrypt(next.smtpPass) : next[k]));
  return getConfig();
}

export function publicConfig(c = getConfig()) {
  return { ...c, smtpPass: "", smtpPassSet: Boolean(c.smtpPass) };
}
