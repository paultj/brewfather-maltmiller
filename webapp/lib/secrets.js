// Passwords, encryption of stored API keys, and random tokens.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, ensureDataDir } from "./settings.js";

/** A secret from an env var, else generated once and kept in DATA_DIR. */
function storedSecret(envName, fileName) {
  if (process.env[envName]) return process.env[envName];
  const file = path.join(DATA_DIR, fileName);
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    ensureDataDir();
    const secret = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  }
}

/** Signs the login cookie. */
export const sessionSecret = () => storedSecret("SESSION_SECRET", "session-secret");

let encKey = null;
function encryptionKey() {
  if (!encKey) encKey = crypto.createHash("sha256").update(storedSecret("ENCRYPTION_KEY", "encryption-key")).digest();
  return encKey;
}

/** AES-256-GCM. Returns "v1:<iv>:<tag>:<data>" (base64), or "" for an empty value. */
export function encrypt(plain) {
  if (!plain) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decrypt(value) {
  if (!value) return "";
  const [v, iv, tag, data] = String(value).split(":");
  if (v !== "v1") throw new Error("Unknown encrypted value format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

// scrypt with N=2^15 takes ~50-100 ms: slow enough to resist guessing,
// fast enough for a login.
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64");
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, "base64"), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return crypto.timingSafeEqual(actual, expected);
}

// Run when an email has no account, so a login takes the same time either way.
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString("hex"));
export const burnPasswordCheck = (password) => verifyPassword(password, DUMMY_HASH);

/** URL-safe random token. */
export const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString("base64url");

/** Tokens are stored hashed, so a copy of the database can't be used to sign in. */
export const hashToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

export const MIN_PASSWORD = 10;
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD) return `Use a password of at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return "That password is too long.";
  return "";
}
