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
export function recordSessionBase(ledger: Ledger, sessionId: string, base: string, modelPath?: string): void {
  ledger.db
    .prepare("INSERT OR IGNORE INTO session_bases (session_id, base_commit, recorded_at, model_path) VALUES (?, ?, ?, ?)")
    .run(sessionId, base, new Date().toISOString(), modelPath ?? null);
}

/**
 * The full model path a session ran on (`provider/model`): the one it was started with, else the session row's, or undefined when none was recorded. A session's `model` column
 * holds the bare id, which names the wrong provider when a continuation resolves it again; a continuation that must keep
 * the model names this one (T236: the review cycle's fixer and recheck, and `lykos recover`).
 */
export function sessionModelPath(ledger: Ledger, sessionId: string): string | undefined {
  const asked = ledger.db.prepare("SELECT model_path FROM session_bases WHERE session_id = ?").get(sessionId) as { model_path: string | null } | undefined;
  if (asked?.model_path != null) return asked.model_path;
  const row = ledger.db.prepare("SELECT model_path FROM sessions WHERE id = ?").get(sessionId) as { model_path: string | null } | undefined;
  return row?.model_path ?? undefined;
}

/** The base a session started from, or undefined for one that predates the record. */
export function sessionBaseOf(ledger: Ledger, sessionId: string): string | undefined {
  const row = ledger.db.prepare("SELECT base_commit FROM session_bases WHERE session_id = ?").get(sessionId) as { base_commit: string } | undefined;
  return row?.base_commit;
}
