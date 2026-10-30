// The Lykos credential database (ADR-0025).
//
// One user-level SQLite file, mode 0600, never inside a workspace. Secrets are
// stored in plaintext, as Pi does. A read never creates the file,
// so a session with no logins, and every test, leaves the home directory alone.

import Database from "better-sqlite3";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type CredentialDb = Database.Database;

/** 2 (ticket 05): `sticky.pinned`, a per-session pin that overrides selection. */
const SCHEMA_VERSION = 2;
const STICKY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** `LYKOS_CREDENTIALS_DB` when set, else `~/.lykos/credentials.db`. Never derived from a workspace. */
export function defaultCredentialDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.LYKOS_CREDENTIALS_DB;
  if (override !== undefined && override.length > 0) return override;
  return join(homedir(), ".lykos", "credentials.db");
}

const DDL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('api_key','oauth')),
  data TEXT NOT NULL,
  label TEXT NOT NULL,
  identity_key TEXT,
  disabled_cause TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credentials_provider_identity ON credentials(provider, identity_key);

CREATE TABLE IF NOT EXISTS cooldowns (
  credential_id INTEGER NOT NULL,
  scope TEXT NOT NULL DEFAULT '',
  until_ms INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY(credential_id, scope)
);

CREATE TABLE IF NOT EXISTS refresh_leases (
  credential_id INTEGER PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sticky (
  session_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  credential_id INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id, provider)
);

CREATE TABLE IF NOT EXISTS usage (
  credential_id INTEGER PRIMARY KEY,
  report TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`;

/** Bring an older file forward: `CREATE TABLE IF NOT EXISTS` never adds a column to an existing table. */
function migrate(db: CredentialDb, from: number): void {
  db.transaction(() => {
    if (from < 2) {
      const columns = db.prepare("PRAGMA table_info(sticky)").all() as Array<{ name: string }>;
      if (!columns.some((c) => c.name === "pinned")) {
        db.exec("ALTER TABLE sticky ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0");
      }
    }
    db.prepare("UPDATE schema_version SET version = ?").run(SCHEMA_VERSION);
  }).immediate();
}

/**
 * Open the credential database. With `create: false` a missing file returns
 * `undefined` and nothing is written to disk. With `create: true` the file is
 * made with mode 0600 first (Windows ignores the mode), then the schema is
 * ensured and sticky rows older than 30 days are pruned. A pinned sticky row is
 * kept until it is unpinned.
 */
export function openCredentialDb(path: string, opts: { create: boolean }): CredentialDb | undefined {
  if (!existsSync(path)) {
    if (!opts.create) return undefined;
    mkdirSync(dirname(path), { recursive: true });
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
  }

  const db = new Database(path);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.exec(DDL);
    const version = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
    if (version === undefined) {
      db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(SCHEMA_VERSION);
    } else if (version.version < SCHEMA_VERSION) {
      migrate(db, version.version);
    }
    if (opts.create) {
      db.prepare("DELETE FROM sticky WHERE updated_at < ? AND pinned = 0").run(Date.now() - STICKY_MAX_AGE_MS);
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

export interface Cooldown {
  credentialId: number;
  scope: string;
  untilMs: number;
  reason: string | null;
}

/** Record a cooldown; an existing one keeps whichever `until_ms` is later. Ticket 05 reads these. */
export function upsertCooldown(
  db: CredentialDb,
  credentialId: number,
  untilMs: number,
  opts: { scope?: string; reason?: string } = {},
): void {
  db.prepare(
    `INSERT INTO cooldowns (credential_id, scope, until_ms, reason) VALUES (?, ?, ?, ?)
     ON CONFLICT(credential_id, scope) DO UPDATE SET
       until_ms = max(cooldowns.until_ms, excluded.until_ms),
       reason = CASE WHEN excluded.until_ms >= cooldowns.until_ms THEN excluded.reason ELSE cooldowns.reason END`,
  ).run(credentialId, opts.scope ?? "", untilMs, opts.reason ?? null);
}

/** Cooldowns still in force at `nowMs`, ordered by credential id then scope. */
export function activeCooldowns(db: CredentialDb, nowMs: number = Date.now()): Cooldown[] {
  return db
    .prepare(
      `SELECT credential_id AS credentialId, scope, until_ms AS untilMs, reason
       FROM cooldowns WHERE until_ms > ? ORDER BY credential_id, scope`,
    )
    .all(nowMs) as Cooldown[];
}
