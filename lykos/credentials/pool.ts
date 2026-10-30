// Credential pool operations.
//
// A provider's pool is its enabled rows. Removal is always a soft disable with
// a cause; nothing here deletes a row. Listings used for output never carry
// the `data` column.

import type { CredentialStore } from "../session/model-runtime.js";
import type { CredentialDb } from "./db.js";
import { apiKeyIdentityKey, oauthDisplayEmail, oauthIdentityKey } from "./identity.js";
export { poolSummary, summaryPoolSizes, type PoolCounts } from "./presence.js";

/** Pi's `Credential` (`ApiKeyCredential | OAuthCredential`), derived because `@earendil-works/pi-ai` is not resolvable here. */
export type Credential = NonNullable<Awaited<ReturnType<CredentialStore["read"]>>>;
export type OAuthCredential = Extract<Credential, { type: "oauth" }>;
export type ApiKeyCredential = Extract<Credential, { type: "api_key" }>;

export type CredentialType = "api_key" | "oauth";

/** A pool row without its secret. */
export interface CredentialRow {
  id: number;
  provider: string;
  type: CredentialType;
  label: string;
  identityKey: string | null;
  disabledCause: string | null;
  createdAt: number;
  updatedAt: number;
}

/** A pool row with its stored JSON `data`. Never printed. */
export interface CredentialRowWithData extends CredentialRow {
  data: string;
}

const ROW_COLUMNS = `id, provider, type, label, identity_key AS identityKey, disabled_cause AS disabledCause,
  created_at AS createdAt, updated_at AS updatedAt`;
const ROW_COLUMNS_WITH_DATA = `${ROW_COLUMNS}, data`;

/** Every row (enabled and disabled), without `data`, ordered by id. The only listing used for output. */
export function listCredentials(db: CredentialDb, provider?: string): CredentialRow[] {
  if (provider !== undefined) {
    return db
      .prepare(`SELECT ${ROW_COLUMNS} FROM credentials WHERE provider = ? ORDER BY id`)
      .all(provider) as CredentialRow[];
  }
  return db.prepare(`SELECT ${ROW_COLUMNS} FROM credentials ORDER BY id`).all() as CredentialRow[];
}

/** Enabled rows of one provider, without `data`, ordered by id. */
export function listEnabled(db: CredentialDb, provider: string): CredentialRow[] {
  return listCredentials(db, provider).filter((row) => row.disabledCause === null);
}

/** One row by id, with `data`. */
export function readCredentialById(db: CredentialDb, id: number): CredentialRowWithData | undefined {
  return db.prepare(`SELECT ${ROW_COLUMNS_WITH_DATA} FROM credentials WHERE id = ?`).get(id) as
    | CredentialRowWithData
    | undefined;
}

/** What an `api_key` row stores: the key source, never its resolved value unless the source is a literal. */
export interface StoredApiKey {
  key: string;
  env?: Record<string, string>;
}

/** Serialise a credential's secret part for the `data` column. */
export function serializeCredentialData(credential: Credential): string {
  if (credential.type === "api_key") {
    if (typeof credential.key !== "string" || credential.key.length === 0) {
      throw new Error("an api_key credential needs a non-empty key source");
    }
    const data: StoredApiKey = { key: credential.key };
    if (credential.env !== undefined) data.env = { ...credential.env } as Record<string, string>;
    return JSON.stringify(data);
  }
  const { type: _type, ...rest } = credential;
  return JSON.stringify(rest);
}

function identityOf(provider: string, credential: Credential): string | null {
  if (credential.type === "api_key") return apiKeyIdentityKey(credential.key ?? "");
  return oauthIdentityKey(provider, credential);
}

/** A label no other enabled row of the provider already uses, so `lykos logout <provider> <label>` is unambiguous. */
function uniqueLabel(db: CredentialDb, provider: string, id: number, preferred: string): string {
  const clash = db
    .prepare(`SELECT 1 FROM credentials WHERE provider = ? AND label = ? AND id <> ? AND disabled_cause IS NULL`)
    .get(provider, preferred, id);
  return clash === undefined ? preferred : `${preferred}#${id}`;
}

function preferredLabel(credential: Credential, id: number): string {
  if (credential.type === "api_key") return `key#${id}`;
  return oauthDisplayEmail(credential) ?? `oauth#${id}`;
}

/**
 * Add a credential to the provider's pool. An enabled row of the same type and
 * identity is updated in place; anything else inserts. An OAuth upsert never
 * touches an `api_key` row.
 */
export function upsertCredential(
  db: CredentialDb,
  provider: string,
  credential: Credential,
): { row: CredentialRow; inserted: boolean } {
  const data = serializeCredentialData(credential);
  const identityKey = identityOf(provider, credential);
  const now = Date.now();

  const run = db.transaction((): { id: number; inserted: boolean } => {
    const existing =
      identityKey === null
        ? undefined
        : (db
            .prepare(
              `SELECT id, label FROM credentials
               WHERE provider = ? AND type = ? AND identity_key = ? AND disabled_cause IS NULL
               ORDER BY id LIMIT 1`,
            )
            .get(provider, credential.type, identityKey) as { id: number; label: string } | undefined);

    if (existing !== undefined) {
      db.prepare("UPDATE credentials SET data = ?, updated_at = ? WHERE id = ?").run(data, now, existing.id);
      // An OAuth row keyed by account id may learn its email on a later login.
      if (credential.type === "oauth" && existing.label.startsWith("oauth#")) {
        const email = oauthDisplayEmail(credential);
        if (email !== undefined) {
          db.prepare("UPDATE credentials SET label = ? WHERE id = ?").run(
            uniqueLabel(db, provider, existing.id, email),
            existing.id,
          );
        }
      }
      return { id: existing.id, inserted: false };
    }

    const info = db
      .prepare(
        `INSERT INTO credentials (provider, type, data, label, identity_key, disabled_cause, created_at, updated_at)
         VALUES (?, ?, ?, '', ?, NULL, ?, ?)`,
      )
      .run(provider, credential.type, data, identityKey, now, now);
    const id = Number(info.lastInsertRowid);
    db.prepare("UPDATE credentials SET label = ? WHERE id = ?").run(
      uniqueLabel(db, provider, id, preferredLabel(credential, id)),
      id,
    );
    return { id, inserted: true };
  });

  // IMMEDIATE takes the write lock before the SELECT, so two processes logging
  // in to the same identity cannot both miss the row and both insert.
  const { id, inserted } = run.immediate();
  const row = listCredentials(db, provider).find((r) => r.id === id)!;
  return { row, inserted };
}

/** Soft-disable one row. Returns whether an enabled row was disabled. */
export function disableCredential(db: CredentialDb, id: number, cause: string): boolean {
  const info = db
    .prepare("UPDATE credentials SET disabled_cause = ?, updated_at = ? WHERE id = ? AND disabled_cause IS NULL")
    .run(cause, Date.now(), id);
  return info.changes === 1;
}

/** Soft-disable every enabled row of a provider. Returns how many were disabled. */
export function disableProvider(db: CredentialDb, provider: string, cause: string): number {
  const info = db
    .prepare("UPDATE credentials SET disabled_cause = ?, updated_at = ? WHERE provider = ? AND disabled_cause IS NULL")
    .run(cause, Date.now(), provider);
  return info.changes;
}

/** Enabled rows of one provider, with `data`, ordered by id. Selection (`select.ts`) reads these; never printed. */
export function listEnabledWithData(db: CredentialDb, provider: string): CredentialRowWithData[] {
  return db
    .prepare(`SELECT ${ROW_COLUMNS_WITH_DATA} FROM credentials WHERE provider = ? AND disabled_cause IS NULL ORDER BY id`)
    .all(provider) as CredentialRowWithData[];
}
