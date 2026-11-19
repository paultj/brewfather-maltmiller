// Login sessions: an HMAC-signed, HttpOnly cookie holding the user id, an
// expiry and the user's session version. Changing the password (or disabling
// the account) bumps the version, which signs out every other session.
import crypto from "node:crypto";
import { sessionSecret } from "./secrets.js";
import { getUser, touchUser } from "./users.js";

const COOKIE = "brew_session";
const SESSION_DAYS = 30;

function sign(payload) {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** The signed-in user, or null. */
export function currentUser(req) {
  const value = readCookie(req, COOKIE);
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [uid, expires, ver, sig] = parts;
  if (!safeEqual(sig, sign(`${uid}.${expires}.${ver}`))) return null;
  if (Number(expires) < Date.now()) return null;
  const user = getUser(Number(uid));
  if (!user || user.disabled || String(user.session_version) !== ver) return null;
  return user;
}

export function setLoginCookie(req, res, user) {
  const payload = `${user.id}.${Date.now() + SESSION_DAYS * 86400_000}.${user.session_version}`;
  const secure = req.secure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${payload}.${sign(payload)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`,
  );
}

export function clearLoginCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Slow down password guessing, per IP and per email: one attempt a second,
// then a 5-minute lockout after 5 failures.
const failures = new Map();
const keysFor = (ip, email) => [`ip:${ip}`, email ? `email:${String(email).trim().toLowerCase()}` : null].filter(Boolean);

export function loginThrottle(ip, email) {
  const t = Date.now();
  let wait = 0;
  for (const k of keysFor(ip, email)) {
    const entry = failures.get(k);
    if (entry && entry.until > t) wait = Math.max(wait, Math.ceil((entry.until - t) / 1000));
  }
  return wait;
}

export function recordLoginFailure(ip, email) {
  for (const k of keysFor(ip, email)) {
    const entry = failures.get(k) || { count: 0, until: 0 };
    entry.count += 1;
    entry.until = Date.now() + (entry.count >= 5 ? 5 * 60_000 : 1000);
    failures.set(k, entry);
  }
  if (failures.size > 10_000) failures.clear(); // keep memory bounded
}

export function clearLoginFailures(ip, email) {
  for (const k of keysFor(ip, email)) failures.delete(k);
}

/** Express middleware: sets req.user; API routes get 401, pages redirect to /login. */
export function requireLogin(req, res, next) {
  const user = currentUser(req);
  if (user) {
    req.user = user;
    const last = user.last_seen_at ? Date.parse(user.last_seen_at) : 0;
    if (Date.now() - last > 10 * 60_000) touchUser(user.id);
    return next();
  }
  if (req.originalUrl.startsWith("/api/")) return res.status(401).json({ error: "Not signed in" });
  return res.redirect("/login");
}

export function requireAdmin(req, res, next) {
  if (req.user?.is_admin) return next();
  if (req.originalUrl.startsWith("/api/")) return res.status(403).json({ error: "Admins only" });
  return res.redirect("/");
}
