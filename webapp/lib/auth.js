// Single-user login. The password comes from the ADMIN_PASSWORD environment
// variable; a successful login sets an HMAC-signed, HttpOnly cookie.
import crypto from "node:crypto";
import { sessionSecret } from "./settings.js";

const COOKIE = "brew_session";
const SESSION_DAYS = 14;

function sign(payload) {
  return crypto.createHmac("sha256", sessionSecret()).update(payload).digest("hex");
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function passwordConfigured() {
  return Boolean(process.env.ADMIN_PASSWORD);
}

export function checkPassword(candidate) {
  if (!passwordConfigured()) return false;
  // Compare hashes so the comparison is constant-time regardless of length.
  const h = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
  return safeEqual(h(candidate), h(process.env.ADMIN_PASSWORD));
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function isLoggedIn(req) {
  const value = readCookie(req, COOKIE);
  if (!value) return false;
  const [expires, sig] = value.split(".");
  if (!expires || !sig || !safeEqual(sig, sign(expires))) return false;
  return Number(expires) > Date.now();
}

export function setLoginCookie(req, res) {
  const expires = String(Date.now() + SESSION_DAYS * 86400_000);
  const secure = req.secure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`,
  );
}

export function clearLoginCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

// Slow down password guessing: one attempt per second per IP, with a short
// lockout after repeated failures.
const failures = new Map();
export function loginThrottle(ip) {
  const now = Date.now();
  const entry = failures.get(ip) || { count: 0, until: 0 };
  if (entry.until > now) return Math.ceil((entry.until - now) / 1000);
  return 0;
}
export function recordLoginFailure(ip) {
  const entry = failures.get(ip) || { count: 0, until: 0 };
  entry.count += 1;
  entry.until = Date.now() + (entry.count >= 5 ? 5 * 60_000 : 1000);
  failures.set(ip, entry);
}
export function clearLoginFailures(ip) {
  failures.delete(ip);
}

/** Express middleware: API routes get 401, pages redirect to /login. */
export function requireLogin(req, res, next) {
  if (isLoggedIn(req)) return next();
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Not logged in" });
  return res.redirect("/login");
}
