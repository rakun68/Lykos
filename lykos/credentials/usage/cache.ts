// Usage report cache.
//
// Reports live in the credential db's `usage` table, one per credential. A
// report younger than five minutes is reused instead of fetched again. A failed fetch is never stored.

import type { CredentialDb } from "../db.js";
import type { UsageReport } from "./types.js";

export const USAGE_REPORT_TTL_MS = 5 * 60_000;

export interface CachedReport {
  report: UsageReport;
  fetchedAt: number;
}

function parseReport(json: string): UsageReport | undefined {
  try {
    const parsed = JSON.parse(json) as UsageReport;
    return typeof parsed === "object" && parsed !== null && Array.isArray(parsed.windows) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The stored report for a credential, whatever its age (display and ranking). */
export function readCachedReport(db: CredentialDb, credentialId: number): CachedReport | undefined {
  const row = db.prepare("SELECT report, fetched_at FROM usage WHERE credential_id = ?").get(credentialId) as
    | { report: string; fetched_at: number }
    | undefined;
  if (row === undefined) return undefined;
  const report = parseReport(row.report);
  return report === undefined ? undefined : { report, fetchedAt: row.fetched_at };
}

/** The stored report when it is younger than the TTL at `now`, else undefined. */
export function readFreshReport(db: CredentialDb, credentialId: number, now: number): UsageReport | undefined {
  const cached = readCachedReport(db, credentialId);
  if (cached === undefined || now - cached.fetchedAt >= USAGE_REPORT_TTL_MS) return undefined;
  return cached.report;
}

/** Store a successful report. An older report never overwrites a newer one. */
export function storeReport(db: CredentialDb, credentialId: number, report: UsageReport): void {
  db.prepare(
    `INSERT INTO usage (credential_id, report, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(credential_id) DO UPDATE SET report = excluded.report, fetched_at = excluded.fetched_at
     WHERE excluded.fetched_at >= usage.fetched_at`,
  ).run(credentialId, JSON.stringify(report), report.fetchedAt);
}
