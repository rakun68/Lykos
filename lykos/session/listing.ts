// The data behind the session picker.
//
// Pure and read-only. It answers one question — "what has this project run,
// and how do those runs relate to each other" — and answers it in the shape
// `08-sessions-and-archive.md` §1 describes: project -> task -> session,
// with two kinds of edge between sessions that have existed in the schema
// since T8 and have never been VISIBLE anywhere in the product:
//
//   * `parent_session_id` — a subagent, nested under its spawner (T39).
//   * `resumed_from`      — a continuation, chained under its original (T57).
//
// The picker is the first place the four-level identity model is actually
// legible, so the nesting lives here rather than in a renderer: it is a
// property of the data, it is what T60 asserts against, and a tree built
// inside a draw call cannot be tested without a terminal.
//
// Nothing here opens a transcript. Every column comes from the ledger, so
// listing a thousand sessions costs one query — the preflight (T56), which
// does read files, is computed lazily for the highlighted row only.

import type { Ledger } from "../ledger/ledger.js";

export interface SessionListRow {
  id: string;
  taskId: string | null;
  /** The task's own brief, which is a NAME once T61's `lykos task name` has been used on it. */
  taskBrief: string | null;
  brief: string | null;
  startedUtc: string;
  endedUtc: string | null;
  model: string | null;
  executionShape: string | null;
  outcome: string | null;
  outcomeSource: string | null;
  archiveState: string | null;
  captureMode: string | null;
  resumable: boolean;
  notResumableReason: string | null;
  parentSessionId: string | null;
  resumedFrom: string | null;
  closedUtc?: string | null;
  deletedUtc?: string | null;
  /** T128: fresh live.json heartbeat, when the browser source can read it. */
  heartbeatUtc?: string | null;
  /**
   * 2026-09-07 (UI feedback item 3): this row IS the session the browser was
   * opened from. Set by the browser source, never by SQL — the live session
   * has no `sessions` row until it ends, so the row it describes is
   * synthesised rather than selected.
   */
  isCurrent?: boolean;
  /**
   * First-hand "a turn is in flight" from the process that owns the session.
   * Only ever set for `isCurrent` rows; every other row is judged by its
   * heartbeat.
   */
  isRunning?: boolean;
  callCount?: number;
  projectName?: string | null;
  projectPath?: string;
  ledgerPath?: string;
  costUsd: number | null;
  durationSeconds: number | null;
  /** 0 for a root session; 1 for a child or a continuation of a root; and so on. Assigned by `nestSessions()`. */
  depth: number;
  /** Why this row sits under the one above it. `null` at depth 0. */
  edge: "subagent" | "resumed" | null;
}

const SELECT = `
  SELECT s.id, s.task_id, t.brief AS task_brief, s.brief, s.started_utc, s.ended_utc,
         s.model, s.execution_shape, s.outcome, s.outcome_source, s.archive_state,
         s.capture_mode, s.resumable, s.not_resumable_reason,
         s.parent_session_id, s.resumed_from, s.total_cost_usd,
         s.closed_utc, s.deleted_utc,
         (SELECT COUNT(*) FROM calls c WHERE c.session_id = s.id) AS call_count
    FROM sessions s
    LEFT JOIN tasks t ON t.id = s.task_id`;

interface Raw {
  id: string;
  task_id: string | null;
  task_brief: string | null;
  brief: string | null;
  started_utc: string;
  ended_utc: string | null;
  model: string | null;
  execution_shape: string | null;
  outcome: string | null;
  outcome_source: string | null;
  archive_state: string | null;
  capture_mode: string | null;
  resumable: number | null;
  not_resumable_reason: string | null;
  parent_session_id: string | null;
  resumed_from: string | null;
  total_cost_usd: number | null;
  closed_utc: string | null;
  deleted_utc: string | null;
  call_count: number;
}

function durationSeconds(started: string, ended: string | null): number | null {
  if (!ended) return null;
  const a = Date.parse(started);
  const b = Date.parse(ended);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

function toRow(r: Raw): SessionListRow {
  return {
    id: r.id,
    taskId: r.task_id,
    taskBrief: r.task_brief,
    brief: r.brief,
    startedUtc: r.started_utc,
    endedUtc: r.ended_utc,
    model: r.model,
    executionShape: r.execution_shape,
    outcome: r.outcome,
    outcomeSource: r.outcome_source,
    archiveState: r.archive_state,
    captureMode: r.capture_mode,
    // The column defaults to 1, so only an explicit 0 means "not resumable".
    resumable: r.resumable !== 0,
    notResumableReason: r.not_resumable_reason,
    parentSessionId: r.parent_session_id,
    resumedFrom: r.resumed_from,
    closedUtc: r.closed_utc,
    deletedUtc: r.deleted_utc,
    callCount: r.call_count,
    costUsd: r.total_cost_usd,
    durationSeconds: durationSeconds(r.started_utc, r.ended_utc),
    depth: 0,
    edge: null,
  };
}

export interface LoadSessionsOpts {
  /** Restrict to one project. Omitted means every session in this ledger. */
  projectId?: string | null;
  limit?: number;
}

/** One query, newest first. */
export function loadSessions(ledger: Ledger, opts: LoadSessionsOpts = {}): SessionListRow[] {
  const where = opts.projectId ? ` WHERE s.project_id = ?` : "";
  const limit = opts.limit !== undefined ? ` LIMIT ${Math.max(1, Math.floor(opts.limit))}` : "";
  const sql = `${SELECT}${where} ORDER BY s.started_utc DESC${limit}`;
  const rows = (opts.projectId
    ? ledger.db.prepare(sql).all(opts.projectId)
    : ledger.db.prepare(sql).all()) as Raw[];
  return rows.map(toRow);
}

/**
 * Turns the flat list into the tree the picker draws, and flattens it again
 * with `depth` and `edge` filled in.
 *
 * A row whose parent or original is NOT in the list — a subagent whose
 * spawner was filtered out, a resume of a session in another project — stays
 * at depth 0 rather than disappearing. Losing a session because its
 * relative is missing would be a deletion, and this project does not delete.
 */
export function nestSessions(rows: readonly SessionListRow[]): SessionListRow[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const children = new Map<string, SessionListRow[]>();
  const roots: SessionListRow[] = [];

  for (const row of rows) {
    // A subagent is nested under its spawner; a continuation under the
    // session it continues. Both edges can be set (a resumed subagent), and
    // the parent wins, because that is the stronger structural claim: a
    // child belongs INSIDE its spawner's run.
    const parentId =
      (row.parentSessionId && byId.has(row.parentSessionId) ? row.parentSessionId : null) ??
      (row.resumedFrom && byId.has(row.resumedFrom) ? row.resumedFrom : null);
    if (parentId === null || parentId === row.id) {
      roots.push(row);
      continue;
    }
    const list = children.get(parentId);
    if (list) list.push(row);
    else children.set(parentId, [row]);
  }

  const out: SessionListRow[] = [];
  const seen = new Set<string>();
  const walk = (row: SessionListRow, depth: number, edge: SessionListRow["edge"]): void => {
    // A cycle cannot happen through valid data (a session can only point at
    // one that already existed), but the guard costs nothing and a picker
    // that hangs is worse than one that shows a row twice.
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ ...row, depth, edge });
    // Children oldest-first: a continuation chain reads forwards, which is
    // the order the work actually happened in.
    const kids = (children.get(row.id) ?? []).slice().sort((a, b) => a.startedUtc.localeCompare(b.startedUtc));
    for (const kid of kids) {
      walk(kid, depth + 1, kid.parentSessionId === row.id ? "subagent" : "resumed");
    }
  };
  for (const root of roots) walk(root, 0, null);
  // Anything the walk missed (only reachable through a cycle) is appended
  // rather than dropped.
  for (const row of rows) if (!seen.has(row.id)) out.push({ ...row, depth: 0, edge: null });
  return out;
}

/** Everything the filter box searches. Deliberately every field a person can see on the row. */
function haystack(row: SessionListRow): string {
  return [
    row.id,
    row.brief ?? "",
    row.taskBrief ?? "",
    row.model ?? "",
    row.outcome ?? "",
    row.executionShape ?? "",
    row.archiveState ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

/**
 * Filter-as-you-type. Plain case-insensitive substring — the same restraint
 * T59 is held to, and for the same reason: nothing clever until plain fails.
 *
 * A match keeps its ANCESTORS, so a nested row never appears orphaned under
 * a heading that is no longer there. Ancestors kept only for context are
 * still selectable — a person who can see a session should be able to act
 * on it.
 */
export function filterSessions(rows: readonly SessionListRow[], query: string): SessionListRow[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return rows.slice();
  const keep = new Set<string>();
  // `rows` is in tree order, so an ancestor always precedes its descendants
  // and this single forward pass is enough to pull the chain in.
  const stack: SessionListRow[] = [];
  for (const row of rows) {
    stack.length = row.depth;
    stack[row.depth] = row;
    if (haystack(row).includes(q)) for (const a of stack) if (a) keep.add(a.id);
  }
  return rows.filter((r) => keep.has(r.id));
}
