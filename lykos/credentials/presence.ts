// Credential store presence and pool summaries (ADR-0025).
//
// Read-only inspection of the credential database: reports pool counts
// per provider without ever touching the `data` column or secrets.
// A missing store file returns an empty map and never creates the file.

import { activeCooldowns, openCredentialDb } from "./db.js";
import { listCredentials } from "./pool.js";

export interface PoolCounts {
  total: number;
  enabled: number;
  cooling: number;
  disabled: number;
}

/**
 * Return summary counts for every provider in the store: total, enabled,
 * cooling, and disabled. Opens the database with `create: false`. If the file
 * does not exist, returns an empty Map without creating the file.
 */
export function poolSummary(
  dbPath: string,
  now: number = Date.now(),
): Map<string, PoolCounts> {
  const map = new Map<string, PoolCounts>();
  const db = openCredentialDb(dbPath, { create: false });
  if (db === undefined) return map;
  try {
    const rows = listCredentials(db);
    if (rows.length === 0) return map;
    const cooldowns = activeCooldowns(db, now);
    const coolingIds = new Set(cooldowns.map((c) => c.credentialId));

    for (const row of rows) {
      let entry = map.get(row.provider);
      if (!entry) {
        entry = { total: 0, enabled: 0, cooling: 0, disabled: 0 };
        map.set(row.provider, entry);
      }
      entry.total += 1;
      if (row.disabledCause !== null) {
        entry.disabled += 1;
      } else {
        entry.enabled += 1;
        if (coolingIds.has(row.id)) {
          entry.cooling += 1;
        }
      }
    }
    return map;
  } finally {
    db.close();
  }
}

/**
 * Convert a pool summary map into a map of provider -> enabled pool size.
 */
export function summaryPoolSizes(summary: Map<string, PoolCounts>): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const [provider, counts] of summary) {
    sizes.set(provider, counts.enabled);
  }
  return sizes;
}
