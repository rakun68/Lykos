// The spec check (T259, ADR-0061, spec decision 24): the first step of a writable delegated session. It records its
// reading of the task with `spec_checked {undecided: [...]}` before it changes anything: missing acceptance criteria,
// unclear scope, no test command, a sealed test that contradicts the task. Each undecided point is asked of the
// coordinator then and there, and the answer is a ruling. There is no separate spec-check session (R5, R7 do not
// apply): the result comes from the tool, never from text the model wrote.
//
// Until the check is recorded the harness refuses every edit, write and shell write, with the reason. A ruling binds
// the session and, in a cycle, every later reviewer, who is handed it (`renderRulings`). A continuation of a session
// that already recorded its check is not gated again.

import { isFileChangingCall, resolveActualToolArgs, resolveActualToolName } from "../tools/tool-call.js";
import { classifyCommandRisk } from "../gate/command-safety.js";
import { withLedgerSync, type Ledger } from "../ledger/use.js";

export const SPEC_CHECKED_TOOL_NAME = "spec_checked";

/** One thing the session could not decide alone, and what the coordinator ruled. */
export interface SpecPoint {
  point: string;
  /** The coordinator's answer. Absent: nobody answered in time and the session decided alone. */
  ruling?: string;
}

export interface SpecCheckRecord {
  recorded_at: string;
  points: SpecPoint[];
}

/** The most points one check records, and the longest one: a check is a short list, not a transcript. */
export const MAX_SPEC_POINTS = 8;
export const MAX_SPEC_POINT_CHARS = 1000;

/** What a session holds of its own check: whether it is recorded, and a way to record it. */
export interface SpecCheckGate {
  /** True once the check is recorded, in this call or an earlier one of the same session. */
  recorded(): boolean;
  /** Records the check; a session's second call returns the first. */
  record(points: SpecPoint[]): SpecCheckRecord;
}

/**
 * The gate of a session whose check lives in the project ledger under `sessionId`: the id the caller knows the session
 * by, which a continuation keeps, so a session that recorded its check is not gated again when it continues.
 */
export function ledgerSpecCheck(ledgerPath: string, sessionId: string): SpecCheckGate {
  let recorded = false;
  return {
    recorded: () => {
      if (!recorded) recorded = withLedgerSync(ledgerPath, (ledger) => specCheckOf(ledger, sessionId) !== undefined);
      return recorded;
    },
    record: (points) => {
      const record = withLedgerSync(ledgerPath, (ledger) => recordSpecCheck(ledger, sessionId, points));
      recorded = true;
      return record;
    },
  };
}

/** Writes the check. A session has one; a second call keeps the first and says so by returning it. */
export function recordSpecCheck(ledger: Ledger, sessionId: string, points: readonly SpecPoint[]): SpecCheckRecord {
  const existing = specCheckOf(ledger, sessionId);
  if (existing !== undefined) return existing;
  const recordedAt = new Date().toISOString();
  ledger.db
    .prepare("INSERT INTO spec_checks (session_id, recorded_at, points_json) VALUES (?, ?, ?)")
    .run(sessionId, recordedAt, JSON.stringify(points));
  return { recorded_at: recordedAt, points: [...points] };
}

/** A session's recorded check, or undefined when it has not made one. */
export function specCheckOf(ledger: Ledger, sessionId: string): SpecCheckRecord | undefined {
  const row = ledger.db.prepare("SELECT recorded_at, points_json FROM spec_checks WHERE session_id = ?").get(sessionId) as
    | { recorded_at: string; points_json: string }
    | undefined;
  return row === undefined ? undefined : { recorded_at: row.recorded_at, points: JSON.parse(row.points_json) as SpecPoint[] };
}

/** The coordinator's rulings from these sessions' checks, in the order the sessions are named. */
export function rulingsOf(ledger: Ledger, sessionIds: readonly string[]): Array<{ session: string; point: string; ruling: string }> {
  const out: Array<{ session: string; point: string; ruling: string }> = [];
  for (const session of sessionIds) {
    for (const p of specCheckOf(ledger, session)?.points ?? []) {
      if (p.ruling !== undefined) out.push({ session, point: p.point, ruling: p.ruling });
    }
  }
  return out;
}

/** The rulings as a later reviewer reads them. Empty text when there are none. */
export function renderRulings(rulings: ReadonlyArray<{ point: string; ruling: string }>): string {
  if (rulings.length === 0) return "";
  return [
    "# Rulings",
    "The coordinator ruled on these points of the task before the work began. They bind you: judge the work against them, and never report a point as a defect because it follows a ruling.",
    ...rulings.map((r, i) => `${i + 1}. Point: ${r.point}\n   Ruling: ${r.ruling}`),
  ].join("\n");
}

/** Calls that change a repository without being a file edit: refused with the rest until the check is recorded. */
const OTHER_WRITERS: ReadonlySet<string> = new Set(["commit", "eval", "rewind"]);
const SHELLS: ReadonlySet<string> = new Set(["bash", "powershell"]);

/**
 * The reason a call is refused before the check is recorded, or undefined when it may run. An edit or a write, any
 * call the registry says changes files, a commit, and a shell command that is not provably a read are refused: a
 * command the parser cannot call a read may write, and the cost of one refused `npm test` is one tool call.
 */
export function specCheckRefusal(wireToolName: string | undefined, input: unknown): string | undefined {
  const name = resolveActualToolName(wireToolName, input) ?? wireToolName ?? "?";
  const args = resolveActualToolArgs(wireToolName, input);
  const refusal = (what: string): string =>
    `lykos: ${what} is refused: you have not recorded your spec check. Read the task, then call ${SPEC_CHECKED_TOOL_NAME} with {"undecided": []} when nothing is unclear, ` +
    `or list each point you cannot decide alone (a missing acceptance criterion, unclear scope, no test command, a sealed test that contradicts the task); the coordinator rules on each. Reading and searching are not refused.`;
  if (SHELLS.has(name)) {
    const rec = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
    const command = typeof rec.command === "string" ? rec.command : typeof rec.cmd === "string" ? rec.cmd : "";
    return classifyCommandRisk(command) === "read-only" ? undefined : refusal(`the ${name} command (it may write)`);
  }
  if (OTHER_WRITERS.has(name) || isFileChangingCall(wireToolName, input)) return refusal(`the ${name} call (it changes the repository)`);
  return undefined;
}
