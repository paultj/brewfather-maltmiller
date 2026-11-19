// SQLite database, using Node's built-in node:sqlite (Node 22.13+), so there
// is no native package to compile on shared hosting.
import path from "node:path";
import { DATA_DIR, ensureDataDir } from "./settings.js";

// node:sqlite prints an "experimental feature" warning on Node 22/23. It
// works fine; hide that one warning so it doesn't clutter the server log.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...args) {
  const text = typeof warning === "string" ? warning : warning?.message;
  if (/SQLite is an experimental feature/.test(text || "")) return;
  return emitWarning.call(process, warning, ...args);
};
const { DatabaseSync } = await import("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  session_version INTEGER NOT NULL DEFAULT 1,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  used_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS password_resets (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

-- One row per chat turn (kind 'chat') or Brewfather push (kind 'push').
-- conversation_id ties a push to the chat turns that produced the recipe.
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  conversation_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  key_owner TEXT NOT NULL DEFAULT 'user',
  recipe_name TEXT NOT NULL DEFAULT '',
  brewfather_id TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_user_at ON usage(user_id, at);
CREATE INDEX IF NOT EXISTS usage_conversation ON usage(conversation_id);

CREATE TABLE IF NOT EXISTS app_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

let db = null;

/** Open (and create) the database. Pass ":memory:" in tests. */
export function openDb(file) {
  if (db) return db;
  if (!file) {
    ensureDataDir();
    file = path.join(DATA_DIR, "brew.db");
  }
  db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  db.exec(SCHEMA);
  return db;
}

export function getDb() {
  return db || openDb();
}

/** For tests: forget the open database. */
export function closeDb() {
  db?.close();
  db = null;
}

export const now = () => new Date().toISOString();
