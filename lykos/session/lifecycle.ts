// T128: lifecycle is a derived browser fact, never a second session state
// machine.  The ledger gives durable close/end facts; live.json gives the
// only positive evidence that a turn is currently running.
//
// 2026-09-07 (UI feedback item 10): the four states, their names and their
// order are the maintainer's, stated as a definition rather than a
// suggestion:
//
//   * **Empty**   — initialised and nothing said in it yet.
//   * **Running** — a turn is in flight right now.
//   * **Open**    — it has a conversation and no turn is running.
//   * **Closed**  — done; resuming it is what reopens it.
//
// The order they are listed in above is the order the browser groups them
// in, and it is deliberately not chronological: it is "what needs you
// first". An empty session is one keystroke from being useful, a running
// one is spending money, an open one is waiting, and a closed one is
// history.
//
// The rename from `needs-input`/`opening` is not cosmetic. "Opening" read
// as a transient state — something that would finish by itself — when what
// it actually means is a session sitting there with a conversation in it,
// which is exactly what "Open" says.

import type { SessionListRow } from "./listing.js";

export type SessionLifecycle = "empty" | "running" | "open" | "closed";

export interface LifecycleEvidence {
  hasUserMessage: boolean;
  heartbeatUtc?: string | null;
  now?: Date;
  heartbeatFreshMs?: number;
  /**
   * Positive, first-hand evidence from the process that owns the session:
   * the browser opened from inside a live session knows whether its own
   * turn is in flight, and a fresh heartbeat is a weaker signal than that.
   * Undefined for every row this process does not own.
   */
  isRunning?: boolean;
}

export function deriveSessionLifecycle(row: SessionListRow, evidence: LifecycleEvidence): SessionLifecycle {
  if (row.deletedUtc != null) return "closed";
  if (row.closedUtc != null || (row.endedUtc !== null && !row.resumable)) return "closed";
  // First-hand knowledge beats an inferred heartbeat in both directions: the
  // owning process saying "idle" is why the session you are sitting in reads
  // Open rather than Running the moment its turn finishes.
  if (evidence.isRunning !== undefined) {
    if (evidence.isRunning) return "running";
  } else {
    const now = (evidence.now ?? new Date()).getTime();
    const heartbeat = evidence.heartbeatUtc ? Date.parse(evidence.heartbeatUtc) : NaN;
    const freshMs = evidence.heartbeatFreshMs ?? 15_000;
    if (Number.isFinite(heartbeat) && now - heartbeat >= 0 && now - heartbeat <= freshMs) return "running";
  }
  // A session that has ended and is resumable is Closed unless something is
  // still running in it: `ended_utc` is the durable "this run finished"
  // fact, and a finished run with nothing live in it is not Open.
  if (row.endedUtc !== null) return "closed";
  if ((row.callCount ?? 0) === 0 && !evidence.hasUserMessage) return "empty";
  return "open";
}

export interface LifecycleGroup {
  state: SessionLifecycle;
  rows: SessionListRow[];
  collapsed: boolean;
}

/** Empty → Running → Open → Closed. See the header comment: this is a definition, not a default. */
export const LIFECYCLE_ORDER: readonly SessionLifecycle[] = ["empty", "running", "open", "closed"];

export const LIFECYCLE_LABELS: Record<SessionLifecycle, string> = {
  empty: "Empty",
  running: "Running",
  open: "Open",
  closed: "Closed",
};

export function groupSessionRows(
  rows: readonly SessionListRow[],
  evidence: (row: SessionListRow) => LifecycleEvidence,
  collapsed: ReadonlySet<SessionLifecycle> = new Set(),
): LifecycleGroup[] {
  const groups = new Map<SessionLifecycle, SessionListRow[]>();
  for (const row of rows) {
    const state = deriveSessionLifecycle(row, evidence(row));
    const group = groups.get(state);
    if (group) group.push(row);
    else groups.set(state, [row]);
  }
  return LIFECYCLE_ORDER.filter((state) => groups.has(state)).map((state) => ({
    state,
    rows: groups.get(state)!,
    collapsed: collapsed.has(state),
  }));
}
