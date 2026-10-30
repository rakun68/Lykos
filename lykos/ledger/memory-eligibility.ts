// T76 — memory eligibility, and what "dead weight" is actually allowed to mean
// (`docs/23-phase10-tasks.md` §2; `problems/09-memory-rot.md` mitigation 5).
//
// A "never-injected dead weight" count turns eviction from a matter of taste
// into arithmetic, with no model call.
//
// **But it cannot be read as an eviction verdict here, and the reason is in
// Lykos's own selection policy.** `assembleMemoryHead` walks the entries in
// file order and stops at the first one that does not fit. File order is
// priority order (T65 rule 4). So an entry sitting below the cap boundary
// is never injected however good it is, and "injected zero times" conflates
// two completely different findings:
//
//   * **useless** — reached, injected, and it never helped; and
//   * **unreachable** — the budget was full before its turn came.
//
// Evicting on the raw number would delete the second kind, and would
// permanently entrench whatever order the file happened to have on day one:
// the entries that start below the line can never earn their way above it.
// GPT-5.6 Sol's review named this (§11.8) and it is the reason this module
// reports the split rather than a single figure.
//
// So: **dead weight is a pressure signal that forces curation, and the
// maintainer does the evicting.** The one automatic consequence permitted is
// the one `problems/09` mitigation 5 asks for — when the store is full,
// something must give, and this says which candidates to look at first.

import type { Ledger } from "./ledger.js";

export interface EntryEligibility {
  entryId: string;
  scope: string;
  file: string;
  /** Sessions in which this entry existed and was a candidate. */
  eligibleSessions: number;
  /** Sessions in which it was frozen into the head. */
  injectedSessions: number;
  /** Sessions in which it lost to the token cap. */
  skippedSessions: number;
  /** T79: sessions in which it was held back because a declared path was gone. */
  staleSessions: number;
  /** Best (lowest) position it ever held. Low and never injected is the damning case. */
  bestPosition: number;
  tokens: number;
}

export interface EligibilityReport {
  entries: EntryEligibility[];
  sessionsWithEligibility: number;
  /**
   * Entries eligible at least once and injected never. NOT an eviction list:
   * see `unreachable` below, which is the part of this number that is an
   * artefact of the first-fit cap rather than a judgement about the entry.
   */
  neverInjected: EntryEligibility[];
  /** Never-injected entries that were ALWAYS skipped for the cap — the unreachable half. */
  unreachable: EntryEligibility[];
  /** T79: never-injected because a declared path was missing every time. Fix or invalidate, do not evict. */
  stale: EntryEligibility[];
  /** Never-injected entries that were reached at least once. The genuinely dead half. */
  reachedButUnused: EntryEligibility[];
}

export function eligibilityReport(ledger: Ledger): EligibilityReport {
  const rows = ledger.db
    .prepare(
      `SELECT entry_id, scope, file,
              COUNT(*)                                        AS eligible,
              SUM(state = 'injected')                         AS injected,
              SUM(state = 'skipped_cap')                      AS skipped,
              SUM(state = 'stale')                            AS stale,
              MIN(position)                                   AS best_position,
              MAX(tokens)                                     AS tokens
       FROM memory_eligibility
       GROUP BY entry_id, scope, file
       ORDER BY injected ASC, best_position ASC, entry_id ASC`,
    )
    .all() as Array<{
    entry_id: string;
    scope: string;
    file: string;
    eligible: number;
    injected: number;
    skipped: number;
    stale: number;
    best_position: number;
    tokens: number;
  }>;

  const entries: EntryEligibility[] = rows.map((r) => ({
    entryId: r.entry_id,
    scope: r.scope,
    file: r.file,
    eligibleSessions: r.eligible,
    injectedSessions: r.injected,
    skippedSessions: r.skipped,
    staleSessions: r.stale,
    bestPosition: r.best_position,
    tokens: r.tokens,
  }));

  const sessions = ledger.db
    .prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM memory_eligibility`)
    .get() as { n: number };

  const neverInjected = entries.filter((e) => e.injectedSessions === 0);
  return {
    entries,
    sessionsWithEligibility: sessions.n,
    neverInjected,
    unreachable: neverInjected.filter((e) => e.skippedSessions === e.eligibleSessions),
    stale: neverInjected.filter((e) => e.staleSessions > 0),
    // Reached, not stale, and still never injected: the only genuinely dead
    // half of the three, and the only one eviction should ever look at.
    reachedButUnused: neverInjected.filter(
      (e) => e.skippedSessions < e.eligibleSessions && e.staleSessions === 0,
    ),
  };
}

export function formatEligibilityReport(r: EligibilityReport): string {
  const L: string[] = [];
  L.push("memory eligibility (T76 — what happened to each entry, injected or not)");
  L.push(`  sessions measured         ${r.sessionsWithEligibility}`);
  L.push(`  entries seen              ${r.entries.length}`);
  if (r.entries.length === 0) {
    L.push("  nothing to report — no session has had an eligible memory entry yet.");
    return L.join("\n");
  }
  L.push(`  never injected            ${r.neverInjected.length}`);
  L.push(`    of those, unreachable   ${r.unreachable.length}  (always lost to the cap — re-order, do not evict)`);
  L.push(`    of those, stale         ${r.stale.length}  (a declared path is gone — fix or invalidate, do not evict)`);
  L.push(`    of those, reached       ${r.reachedButUnused.length}  (the genuinely dead half)`);
  L.push("");
  L.push("  entry     scope/file                 elig  inj  skip stale  pos  tok");
  for (const e of r.entries.slice(0, 20)) {
    const label = `${e.scope}/${e.file}`.padEnd(25);
    L.push(
      `  ${e.entryId}  ${label} ${String(e.eligibleSessions).padStart(5)}` +
        `${String(e.injectedSessions).padStart(5)}${String(e.skippedSessions).padStart(6)}` +
        `${String(e.staleSessions).padStart(6)}${String(e.bestPosition).padStart(5)}${String(e.tokens).padStart(5)}`,
    );
  }
  L.push("");
  L.push("  Never-injected is a PRESSURE SIGNAL, not an eviction verdict: under a");
  L.push("  first-fit cap it partly measures file position, and evicting on it would");
  L.push("  entrench day-one ordering. The maintainer evicts; this says where to look.");
  return L.join("\n");
}
