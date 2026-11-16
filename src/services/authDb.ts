import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DB_PATH = process.env.AUTH_DB_PATH || './data/auth.sqlite';
if (DB_PATH !== ':memory:') fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

/**
 * Auth storage: users and refresh tokens in one SQLite file (`AUTH_DB_PATH`, default `data/auth.sqlite`).
 * Opened once at startup; better-sqlite3 is synchronous, so queries are never awaited.
 * Timestamps are integer Unix milliseconds.
 */
export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  google_sub    TEXT NOT NULL UNIQUE,   -- Google's stable sub claim
  umich_sub     TEXT UNIQUE,            -- reserved for the U-M OIDC path
  email         TEXT NOT NULL,
  name          TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,     -- sha256 of the raw token; the raw token is never stored
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,                  -- NULL while valid
  created_at  INTEGER NOT NULL,
  device      TEXT                      -- user agent of the client the token was issued to
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens(expires_at);
`);

// SQLite has no TTL index. Revoked rows are kept for a week so that replaying a recently rotated
// refresh token is still recognised as reuse.
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const purge = db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)');
const purgeExpired = () => purge.run(Date.now(), Date.now() - WEEK_MS);
purgeExpired();
setInterval(purgeExpired, 60 * 60 * 1000).unref();
