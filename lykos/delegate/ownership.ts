// Who owns a delegated session, in the project ledger (T243, ADR-0060 amended 2026-10-31: fail-closed).
//
// A delegated session is owned by the process holding its stdin: an MCP server or `lykos run`. Its `owners` row
// is written when it starts, with the owner's pid and the time of the record, so any process can see it: `lykos
// status` sees a session an MCP server started, and the reverse. A write-in-place session also holds a
// `tree_locks` row for its canonical tree, so a second writer on one tree is refused, naming the first.
//
// Admission is one `BEGIN IMMEDIATE` transaction: it finds a retried request by its `request_id`, counts the
// project's sessions whose owner is not `dead` against the cap, takes the tree lock, and writes the owner row.
// Owner liveness is read before the transaction (it asks the OS), never inside it. `unknown` counts as alive:
// uncertainty never frees a slot or a lock. A session whose owner is `dead` keeps its lock and is listed with
// `next recover` (T246); nothing takes it over by itself.

import { realpathSync } from "node:fs";
import type { Ledger } from "../ledger/use.js";
import { liveness, type Liveness } from "../process/identity.js";

export type OwnerKind = "run" | "mcp";
export type OwnedState = "running" | "waiting" | "done" | "stopped" | "error";

export interface OwnerRow {
  session_id: string;
  request_id: string | null;
  owner: OwnerKind;
  owner_pid: number;
  owner_recorded_at_ms: number;
  specialist: string | null;
  write_in_place: number;
  state: OwnedState;
  started_at: string;
  ended_at: string | null;
  stop_requested: number;
  question: string | null;
  result_json: string | null;
  /** T246: how many times `lykos recover` took the session over from a dead owner. */
  crashes: number;
}

/** This process, recorded while it lives. */
export function selfIdentity(): { pid: number; recordedAt: number } {
  return { pid: process.pid, recordedAt: Date.now() };
}

/** The canonical path a tree lock is keyed by. */
export function canonicalTree(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export type LivenessOf = (row: Pick<OwnerRow, "owner_pid" | "owner_recorded_at_ms">) => Liveness;

/** The owner's liveness. This process is alive without asking the OS. */
export const ownerLiveness: LivenessOf = (row) =>
  row.owner_pid === process.pid ? "alive" : liveness({ pid: row.owner_pid, recordedAt: row.owner_recorded_at_ms });

const COLUMNS =
  "session_id, request_id, owner, owner_pid, owner_recorded_at_ms, specialist, write_in_place, state, started_at, ended_at, stop_requested, question, result_json, crashes";

export function ownerRow(ledger: Ledger, sessionId: string): OwnerRow | undefined {
  return ledger.db.prepare(`SELECT ${COLUMNS} FROM owners WHERE session_id = ?`).get(sessionId) as OwnerRow | undefined;
}

export function ownerRows(ledger: Ledger, sessionIds?: readonly string[]): OwnerRow[] {
  if (sessionIds === undefined) return ledger.db.prepare(`SELECT ${COLUMNS} FROM owners ORDER BY started_at ASC`).all() as OwnerRow[];
  return sessionIds.map((id) => ownerRow(ledger, id)).filter((r): r is OwnerRow => r !== undefined);
}

export function isLive(state: OwnedState): boolean {
  return state === "running" || state === "waiting";
}

export interface AdmitInput {
  sessionId: string;
  requestId?: string | undefined;
  owner: OwnerKind;
  specialist: string;
  /** The tree a write-in-place session writes in. Absent: no lock. */
  writeInPlaceTree?: string | undefined;
  /** `delegation.max_sessions`. */
  projectCap: number;
  /** A continuation of an earlier session: its row is reused. */
  continuation?: boolean;
  /** T246: this process took the live row over with `takeOver` (`lykos recover`); it runs it. */
  adopt?: boolean;
  /** Tests pass a stand-in. */
  livenessOf?: LivenessOf;
}

export type Admission =
  | { ok: true }
  | { ok: false; kind: "duplicate"; sessionId: string; row: OwnerRow }
  | { ok: false; kind: "cap"; reason: string; holders: string[] }
  | { ok: false; kind: "tree"; reason: string; holder: string }
  | { ok: false; kind: "owned"; reason: string; row: OwnerRow; liveness: Liveness };

/** Admits a session: one transaction checks the request id, the cap and the tree lock, and writes the owner row. */
export function admit(ledger: Ledger, input: AdmitInput): Admission {
  const livenessOf = input.livenessOf ?? ownerLiveness;
  // Outside the transaction: ask the OS which live rows' owners are gone.
  const live = (ledger.db.prepare(`SELECT ${COLUMNS} FROM owners WHERE state IN ('running', 'waiting')`).all() as OwnerRow[]);
  const dead = new Set(live.filter((r) => livenessOf(r) === "dead").map((r) => r.session_id));
  const previous = ownerRow(ledger, input.sessionId);
  const previousLiveness = previous !== undefined && isLive(previous.state) ? livenessOf(previous) : undefined;
  const tree = input.writeInPlaceTree !== undefined ? canonicalTree(input.writeInPlaceTree) : undefined;
  const me = selfIdentity();

  const run = ledger.db.transaction((): Admission => {
    if (input.requestId !== undefined) {
      const existing = ledger.db.prepare(`SELECT ${COLUMNS} FROM owners WHERE request_id = ?`).get(input.requestId) as OwnerRow | undefined;
      if (existing !== undefined) return { ok: false, kind: "duplicate", sessionId: existing.session_id, row: existing };
    }
    const current = ownerRow(ledger, input.sessionId);
    const adopted = input.adopt === true && current !== undefined && isLive(current.state) && current.owner_pid === me.pid;
    if (current !== undefined && isLive(current.state) && !adopted) {
      const state = previousLiveness ?? "unknown";
      return {
        ok: false,
        kind: "owned",
        row: current,
        liveness: state,
        reason:
          state === "dead"
            ? `session ${input.sessionId} crashed (its owner, pid ${current.owner_pid}, is gone); continue it with \`lykos recover ${input.sessionId}\``
            : `session ${input.sessionId} is running, owned by pid ${current.owner_pid} (${state})`,
      };
    }
    const holders = (ledger.db.prepare(`SELECT session_id FROM owners WHERE state IN ('running', 'waiting')`).all() as Array<{ session_id: string }>)
      .map((r) => r.session_id)
      .filter((id) => !dead.has(id) && !(adopted && id === input.sessionId));
    if (holders.length >= input.projectCap) {
      return {
        ok: false,
        kind: "cap",
        holders,
        reason: `delegation.max_sessions (${input.projectCap}) reached; running sessions: ${holders.join(", ")}`,
      };
    }
    if (tree !== undefined) {
      const lock = ledger.db.prepare("SELECT session_id FROM tree_locks WHERE path = ?").get(tree) as { session_id: string } | undefined;
      if (lock !== undefined && lock.session_id !== input.sessionId) {
        return {
          ok: false,
          kind: "tree",
          holder: lock.session_id,
          reason: `another write-in-place session (${lock.session_id}) holds this tree (${tree})`,
        };
      }
      ledger.db
        .prepare("INSERT OR REPLACE INTO tree_locks (path, session_id, acquired_at) VALUES (?, ?, ?)")
        .run(tree, input.sessionId, new Date().toISOString());
    }
    const values = {
      session_id: input.sessionId,
      request_id: input.requestId ?? null,
      owner: input.owner,
      owner_pid: me.pid,
      owner_recorded_at_ms: me.recordedAt,
      specialist: input.specialist,
      write_in_place: tree !== undefined ? 1 : 0,
      started_at: new Date(me.recordedAt).toISOString(),
    };
    if (current !== undefined) {
      // A continuation: the same session, a new owner and a fresh run. Its first request id stays.
      ledger.db
        .prepare(
          `UPDATE owners SET owner = @owner, owner_pid = @owner_pid, owner_recorded_at_ms = @owner_recorded_at_ms,
             specialist = @specialist, write_in_place = @write_in_place, state = 'running', started_at = @started_at,
             ended_at = NULL, stop_requested = 0, question = NULL, result_json = NULL,
             request_id = COALESCE(request_id, @request_id)
           WHERE session_id = @session_id`,
        )
        .run(values);
    } else {
      ledger.db
        .prepare(
          `INSERT INTO owners (session_id, request_id, owner, owner_pid, owner_recorded_at_ms, specialist, write_in_place, state, started_at)
           VALUES (@session_id, @request_id, @owner, @owner_pid, @owner_recorded_at_ms, @specialist, @write_in_place, 'running', @started_at)`,
        )
        .run(values);
    }
    return { ok: true };
  });
  return run.immediate();
}

/** T246: the most crashes a session is recovered from; the next one stops it. */
export const MAX_CRASHES = 5;

export type TakeOver =
  | { ok: true; crashes: number }
  | { ok: false; kind: "lost"; reason: string }
  | { ok: false; kind: "stopped"; reason: string };

/**
 * T246: `lykos recover` takes a crashed session over. One transaction: a conditional update of the owner row, from
 * the dead owner the caller read to this process, with the tree lock kept for the session. A second recover that
 * read the same row loses: the row no longer names that owner. The sixth crash stops the session instead.
 */
export function takeOver(ledger: Ledger, expected: Pick<OwnerRow, "session_id" | "owner_pid" | "owner_recorded_at_ms">): TakeOver {
  const me = selfIdentity();
  const run = ledger.db.transaction((): TakeOver => {
    const current = ownerRow(ledger, expected.session_id);
    if (current === undefined || !isLive(current.state) || current.owner_pid !== expected.owner_pid || current.owner_recorded_at_ms !== expected.owner_recorded_at_ms) {
      return {
        ok: false,
        kind: "lost",
        reason:
          current === undefined
            ? `session ${expected.session_id} is gone from the ledger`
            : isLive(current.state)
              ? `another recover took session ${expected.session_id} over first (owner pid ${current.owner_pid})`
              : `session ${expected.session_id} is ${current.state} now`,
      };
    }
    if (current.crashes >= MAX_CRASHES) {
      const reason = `session ${expected.session_id} crashed ${current.crashes + 1} times; it is stopped (at most ${MAX_CRASHES} are recovered)`;
      ledger.db
        .prepare("UPDATE owners SET state = 'error', ended_at = ?, question = NULL, result_json = ? WHERE session_id = ?")
        .run(new Date().toISOString(), JSON.stringify({ outcome: "error", message: reason, sessionId: expected.session_id, next: "fix_environment" }), expected.session_id);
      ledger.db.prepare("DELETE FROM tree_locks WHERE session_id = ?").run(expected.session_id);
      return { ok: false, kind: "stopped", reason };
    }
    const changed = ledger.db
      .prepare(
        `UPDATE owners SET owner = 'run', owner_pid = ?, owner_recorded_at_ms = ?, stop_requested = 0, crashes = crashes + 1
         WHERE session_id = ? AND owner_pid = ? AND owner_recorded_at_ms = ? AND state IN ('running', 'waiting')`,
      )
      .run(me.pid, me.recordedAt, expected.session_id, expected.owner_pid, expected.owner_recorded_at_ms).changes;
    // The tree lock is keyed by the session, so it moves with the row: it stays this session's, now this process's.
    return changed === 1 ? { ok: true, crashes: current.crashes + 1 } : { ok: false, kind: "lost", reason: `another recover took session ${expected.session_id} over first` };
  });
  return run.immediate();
}

/** Ends a session: its state and result, and its tree lock let go, in one transaction. */
export function finish(ledger: Ledger, sessionId: string, state: Exclude<OwnedState, "running" | "waiting">, result: unknown): void {
  ledger.db.transaction(() => {
    ledger.db
      .prepare("UPDATE owners SET state = ?, ended_at = ?, question = NULL, result_json = ? WHERE session_id = ?")
      .run(state, new Date().toISOString(), JSON.stringify(result), sessionId);
    ledger.db.prepare("DELETE FROM tree_locks WHERE session_id = ?").run(sessionId);
  }).immediate();
}

// The inbox (T244): any process reaches any session through rows its owner polls. A steer is a row in `inbox`; a
// question the session asks is a row in `questions`, and the owner row shows it at once (F1). A steer answers every
// open question; a question the timeout answered is closed too, so `wait --questions` never returns on one already
// answered (G8).

/** The session asked a question: recorded, and shown on its owner row, before anything else happens. */
export function askQuestion(ledger: Ledger, sessionId: string, question: string): void {
  ledger.db.transaction(() => {
    ledger.db.prepare("INSERT INTO questions (session_id, question, asked_at) VALUES (?, ?, ?)").run(sessionId, question, new Date().toISOString());
    ledger.db.prepare(`UPDATE owners SET state = 'waiting', question = ? WHERE session_id = ? AND state IN ('running', 'waiting')`).run(question, sessionId);
  }).immediate();
}

/** Closes the session's open questions: `steer` when a message answered them, `timeout` when it decided alone. */
export function closeQuestions(ledger: Ledger, sessionId: string, by: "steer" | "timeout"): number {
  return ledger.db.transaction(() => {
    const res = ledger.db
      .prepare("UPDATE questions SET answered_at = ?, answered_by = ? WHERE session_id = ? AND answered_at IS NULL")
      .run(new Date().toISOString(), by, sessionId);
    ledger.db.prepare(`UPDATE owners SET state = 'running', question = NULL WHERE session_id = ? AND state = 'waiting'`).run(sessionId);
    return res.changes;
  }).immediate();
}

export interface OpenQuestion {
  session_id: string;
  question: string;
  asked_at: string;
}

/** The questions nobody has answered yet, oldest first. */
export function openQuestions(ledger: Ledger, sessionIds: readonly string[]): OpenQuestion[] {
  if (sessionIds.length === 0) return [];
  const marks = sessionIds.map(() => "?").join(", ");
  return ledger.db
    .prepare(`SELECT session_id, question, asked_at FROM questions WHERE answered_at IS NULL AND session_id IN (${marks}) ORDER BY id ASC`)
    .all(...sessionIds) as OpenQuestion[];
}

/** Posts a steering message for the session's owner. False when the session is not live. */
export function postSteer(ledger: Ledger, sessionId: string, message: string): boolean {
  return ledger.db.transaction(() => {
    const row = ownerRow(ledger, sessionId);
    if (row === undefined || !isLive(row.state)) return false;
    ledger.db.prepare("INSERT INTO inbox (session_id, message, created_at) VALUES (?, ?, ?)").run(sessionId, message, new Date().toISOString());
    return true;
  }).immediate();
}

/** The owner takes the session's undelivered messages, oldest first, and marks them delivered. */
export function takeInbox(ledger: Ledger, sessionId: string): string[] {
  return ledger.db.transaction(() => {
    const rows = ledger.db
      .prepare("SELECT id, message FROM inbox WHERE session_id = ? AND delivered_at IS NULL ORDER BY id ASC")
      .all(sessionId) as Array<{ id: number; message: string }>;
    const mark = ledger.db.prepare("UPDATE inbox SET delivered_at = ? WHERE id = ?");
    const now = new Date().toISOString();
    for (const r of rows) mark.run(now, r.id);
    return rows.map((r) => r.message);
  }).immediate();
}

/** Asks the owner to stop the session. The owner polls the flag. False when no live row has that id. */
export function requestStop(ledger: Ledger, sessionId: string): boolean {
  const res = ledger.db.prepare(`UPDATE owners SET stop_requested = 1 WHERE session_id = ? AND state IN ('running', 'waiting')`).run(sessionId);
  return res.changes > 0;
}

export function stopRequested(ledger: Ledger, sessionId: string): boolean {
  const row = ledger.db.prepare("SELECT stop_requested FROM owners WHERE session_id = ?").get(sessionId) as { stop_requested: number } | undefined;
  return row?.stop_requested === 1;
}

export interface SessionView {
  session_id: string;
  state: OwnedState | "crashed";
  owner: OwnerKind;
  owner_pid: number;
  /** The owner's liveness, for a session still live in the ledger. */
  owner_liveness?: Liveness;
  specialist: string | null;
  request_id: string | null;
  write_in_place: boolean;
  started_at: string;
  ended_at: string | null;
  question: string | null;
  result?: unknown;
  next?: string;
}

/**
 * What any process sees of a session. A live row whose owner is `dead` is `crashed`, with `next recover`; one whose
 * owner is `unknown` stays as recorded: uncertainty never ends a session. `reread` reads the row again after a `dead`
 * verdict: an owner that ended the session and exited while its liveness was being read is not a crash.
 */
export function viewOf(row: OwnerRow, livenessOf: LivenessOf = ownerLiveness, reread?: () => OwnerRow | undefined): SessionView {
  const ownerState = isLive(row.state) ? livenessOf(row) : undefined;
  if (ownerState === "dead" && reread !== undefined) {
    const fresh = reread();
    if (fresh !== undefined && !isLive(fresh.state)) return viewOf(fresh, livenessOf);
  }
  const crashed = ownerState === "dead";
  const result = row.result_json !== null ? (JSON.parse(row.result_json) as unknown) : undefined;
  const resultNext = typeof result === "object" && result !== null ? (result as { next?: unknown }).next : undefined;
  const next = crashed
    ? "recover"
    : row.state === "waiting"
      ? "answer_question"
      : isLive(row.state)
        ? "wait"
        : typeof resultNext === "string"
          ? resultNext
          : undefined;
  return {
    session_id: row.session_id,
    state: crashed ? "crashed" : row.state,
    owner: row.owner,
    owner_pid: row.owner_pid,
    ...(ownerState !== undefined ? { owner_liveness: ownerState } : {}),
    specialist: row.specialist,
    request_id: row.request_id,
    write_in_place: row.write_in_place === 1,
    started_at: row.started_at,
    ended_at: row.ended_at,
    question: row.question,
    ...(result !== undefined ? { result } : {}),
    ...(next !== undefined ? { next } : {}),
  };
}

/** True when a session needs nothing more from its owner: ended, or crashed. */
export function settled(view: SessionView): boolean {
  return view.state !== "running" && view.state !== "waiting";
}
