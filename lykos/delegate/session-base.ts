// The commit a delegated session started from (T235, R16). It is written when the session is admitted and never
// changed, so a review diffs the session's branch against it, however far the host's HEAD has moved since.

import { hostGit } from "../git/host-git.js";
import type { Ledger } from "../ledger/use.js";

/** The commit `ref` names in `repo`, or undefined when it names none. */
export function commitOf(repo: string, ref: string): string | undefined {
  const r = hostGit(["rev-parse", "--verify", `${ref}^{commit}`], repo);
  return r.ok ? r.stdout : undefined;
}

/** Stores the base of a session's first run. A continuation keeps the first one. */
export function recordSessionBase(ledger: Ledger, sessionId: string, base: string): void {
  ledger.db.prepare("INSERT OR IGNORE INTO session_bases (session_id, base_commit, recorded_at) VALUES (?, ?, ?)").run(sessionId, base, new Date().toISOString());
}

/** The base a session started from, or undefined for one that predates the record. */
export function sessionBaseOf(ledger: Ledger, sessionId: string): string | undefined {
  const row = ledger.db.prepare("SELECT base_commit FROM session_bases WHERE session_id = ?").get(sessionId) as { base_commit: string } | undefined;
  return row?.base_commit;
}
