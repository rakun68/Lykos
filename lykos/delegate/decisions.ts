// Decisions on delegated sessions (T233, spec decision 17): the coordinator's `accept`, `reject`, `merged` and
// `discard`, each with a cause, a reason and an actor, and the review cycle's findings forwarded, dropped or retired.
// Both are append-only ledger tables; a session's history is every row, oldest first.
//
// What may be decided on:
//   - a session that ended (`done`, `stopped`, `error`): any decision;
//   - a crashed session (live row, owner `dead`): only `discard`, and only once everything it started is confirmed
//     stopped (T256, so its tree lock never frees a tree something still writes in). The discard ends the row in the
//     same transaction that records the decision, by a conditional update of the owner the caller saw (R6);
//   - a live session, or one whose owner is `alive` or `unknown`: nothing. Fail-closed.

import type { Ledger } from "../ledger/use.js";
import { confirmQuiescence, type QuiescenceDeps } from "../process/quiescence.js";
import { isLive, ownerLiveness, ownerRow, type LivenessOf } from "./ownership.js";

export const DECISIONS = ["accept", "reject", "merged", "discard"] as const;
export type DecisionKind = (typeof DECISIONS)[number];

/**
 * Boxie's fixed cause list: the `label` causes of its run ledger, from the maintainer's Boxie parity table
 * (`../Lykos_Dev/docs/boxie-parity.md`, "Ledger causes"). Nothing here is Lykos's own invention.
 */
export const CAUSES = [
  "worker_careless",
  "worker_scope_creep",
  "ctx_missing",
  "env",
  "other",
  "review_false_positive",
  "scope_too_narrow",
  "model_limit",
  "worker_ignored_rule",
  "spec_vague",
  "worker_misreport",
] as const;
export type Cause = (typeof CAUSES)[number];

export const FINDING_ACTIONS = ["forwarded", "dropped", "retired"] as const;
export type FindingAction = (typeof FINDING_ACTIONS)[number];

export function isCause(value: string): value is Cause {
  return (CAUSES as readonly string[]).includes(value);
}

export interface DecisionRow {
  id: number;
  ts: string;
  session_id: string;
  decision: DecisionKind;
  cause: Cause | null;
  reason: string;
  actor: string;
}

export interface FindingDecisionRow {
  id: number;
  ts: string;
  session_id: string;
  cycle_id: string | null;
  finding_id: string;
  action: FindingAction;
  reason: string;
}

export interface DecideInput {
  sessionId: string;
  decision: DecisionKind;
  reason: string;
  cause?: Cause | undefined;
  actor: string;
  /** Tests pass stand-ins. */
  livenessOf?: LivenessOf;
  quiescence?: QuiescenceDeps;
}

export type Decided =
  | { ok: true; decision: DecisionRow; discardedCrashed: boolean }
  | { ok: false; message: string; next: "fix_environment" | "wait" | "recover" };

export function decisionsOf(ledger: Ledger, sessionId: string): DecisionRow[] {
  return ledger.db.prepare("SELECT id, ts, session_id, decision, cause, reason, actor FROM decisions WHERE session_id = ? ORDER BY id ASC").all(sessionId) as DecisionRow[];
}

export function findingDecisionsOf(ledger: Ledger, sessionId: string): FindingDecisionRow[] {
  return ledger.db
    .prepare("SELECT id, ts, session_id, cycle_id, finding_id, action, reason FROM finding_decisions WHERE session_id = ? ORDER BY id ASC")
    .all(sessionId) as FindingDecisionRow[];
}

/** The cycle's decision on one finding: forwarded to the fixer, dropped, or retired. */
export function recordFindingDecision(
  ledger: Ledger,
  input: { sessionId: string; cycleId?: string | undefined; findingId: string; action: FindingAction; reason: string },
): FindingDecisionRow {
  const ts = new Date().toISOString();
  const info = ledger.db
    .prepare("INSERT INTO finding_decisions (ts, session_id, cycle_id, finding_id, action, reason) VALUES (?, ?, ?, ?, ?, ?)")
    .run(ts, input.sessionId, input.cycleId ?? null, input.findingId, input.action, input.reason);
  return { id: Number(info.lastInsertRowid), ts, session_id: input.sessionId, cycle_id: input.cycleId ?? null, finding_id: input.findingId, action: input.action, reason: input.reason };
}

/** Records a decision on a session, or says why it may not be decided on yet. */
export async function decide(ledger: Ledger, input: DecideInput): Promise<Decided> {
  const row = ownerRow(ledger, input.sessionId);
  if (row === undefined) return { ok: false, message: `unknown session id: ${input.sessionId}`, next: "fix_environment" };
  const livenessOf = input.livenessOf ?? ownerLiveness;
  const live = isLive(row.state);
  const ownerState = live ? livenessOf(row) : undefined;
  if (live && ownerState !== "dead") {
    return {
      ok: false,
      message: `lykos ${input.decision}: session ${input.sessionId} is still ${row.state} (owner pid ${row.owner_pid} is ${ownerState}); wait for it or stop it first`,
      next: "wait",
    };
  }
  if (live && input.decision !== "discard") {
    return {
      ok: false,
      message: `lykos ${input.decision}: session ${input.sessionId} crashed; it has no result to ${input.decision}. Continue it with \`lykos recover ${input.sessionId}\`, or \`lykos discard ${input.sessionId} --why <reason>\``,
      next: "recover",
    };
  }
  if (live) {
    const quiet = await confirmQuiescence(ledger, input.sessionId, input.quiescence ?? {});
    if (!quiet.quiet) {
      const named = quiet.notStopped.map((n) => `${n.kind}${n.pid !== undefined ? ` pid ${n.pid}` : ""}${n.container !== undefined ? ` ${n.container}` : ""} (${n.liveness})`);
      return { ok: false, message: `lykos discard: what the session started is not confirmed stopped: ${named.join(", ")}; stop it first; discard never kills anything`, next: "fix_environment" };
    }
  }
  const run = ledger.db.transaction((): Decided => {
    const current = ownerRow(ledger, input.sessionId);
    if (current === undefined) return { ok: false, message: `unknown session id: ${input.sessionId}`, next: "fix_environment" };
    if (live) {
      // The owner the caller saw dead is still the row's: a recover that raced this discard has taken it over.
      if (!isLive(current.state) || current.owner_pid !== row.owner_pid || current.owner_recorded_at_ms !== row.owner_recorded_at_ms) {
        return { ok: false, message: `lykos discard: session ${input.sessionId} changed while it was being discarded (a recover took it over, or it ended); read it again`, next: "wait" };
      }
      const message = `discarded: its owner (pid ${row.owner_pid}) died mid-run; ${input.reason}`;
      ledger.db
        .prepare("UPDATE owners SET state = 'stopped', ended_at = ?, question = NULL, result_json = ? WHERE session_id = ?")
        .run(new Date().toISOString(), JSON.stringify({ outcome: "error", message, sessionId: input.sessionId, next: "fix_environment" }), input.sessionId);
      ledger.db.prepare("DELETE FROM tree_locks WHERE session_id = ?").run(input.sessionId);
    } else if (isLive(current.state)) {
      return { ok: false, message: `lykos ${input.decision}: session ${input.sessionId} is running again; read it again`, next: "wait" };
    }
    const ts = new Date().toISOString();
    const info = ledger.db
      .prepare("INSERT INTO decisions (ts, session_id, decision, cause, reason, actor) VALUES (?, ?, ?, ?, ?, ?)")
      .run(ts, input.sessionId, input.decision, input.cause ?? null, input.reason, input.actor);
    return {
      ok: true,
      discardedCrashed: live,
      decision: { id: Number(info.lastInsertRowid), ts, session_id: input.sessionId, decision: input.decision, cause: input.cause ?? null, reason: input.reason, actor: input.actor },
    };
  });
  return run.immediate();
}
