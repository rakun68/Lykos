// Read-only session snapshot for S3: live.json first, ledger fallback when
// the cache is gone (finished sessions). Never opens Ledger.open() — that
// runs migrations and INSERT OR IGNORE into price_versions — so a reader
// cannot write (§8 / T38 acceptance).

import { existsSync, readdirSync, statSync } from "node:fs";
import { openReadonlyDb } from "../ledger/read-only.js";
import { join } from "node:path";
import {
  liveSnapshotPath,
  readLiveSnapshot,
  sessionsDir,
  type LiveSnapshot,
} from "../ledger/live.js";

export type SnapshotSource = "live" | "ledger";

export interface ResolvedSessionSnapshot {
  snapshot: LiveSnapshot;
  source: SnapshotSource;
}

function rowToSnapshot(
  sessionId: string,
  session: {
    task_id: string | null;
    brief: string | null;
    started_utc: string;
    ended_utc: string | null;
    outcome: string | null;
    outcome_source: string | null;
  },
  totals: {
    costUsd: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    n: number;
  },
  lastCallRow:
    | {
        ts_utc: string;
        agent: string;
        phase: string | null;
        provider: string;
        model: string;
        context_before: number | null;
        context_after: number | null;
        tool_schema_tokens: number | null;
        tool_count: number | null;
        prefix_changed: number | null;
      }
    | undefined,
): LiveSnapshot {
  return {
    schemaVersion: 1,
    sessionId,
    taskId: session.task_id,
    brief: session.brief,
    startedUtc: session.started_utc,
    heartbeatUtc: session.ended_utc ?? lastCallRow?.ts_utc ?? session.started_utc,
    endedUtc: session.ended_utc,
    outcome: session.outcome,
    outcomeSource: session.outcome_source,
    totals: {
      costUsd: totals.costUsd,
      input: totals.input,
      output: totals.output,
      cacheRead: totals.cacheRead,
      cacheWrite: totals.cacheWrite,
      reasoning: totals.reasoning,
      calls: totals.n,
    },
    lastCall: lastCallRow
      ? {
          tsUtc: lastCallRow.ts_utc,
          agent: lastCallRow.agent,
          phase: lastCallRow.phase,
          provider: lastCallRow.provider,
          model: lastCallRow.model,
          contextBefore: lastCallRow.context_before,
          contextAfter: lastCallRow.context_after,
          toolSchemaTokens: lastCallRow.tool_schema_tokens,
          toolCount: lastCallRow.tool_count,
          prefixChanged: lastCallRow.prefix_changed === 1,
        }
      : null,
  };
}

export function readSessionFromLedger(ledgerPath: string, sessionId: string): LiveSnapshot | null {
  const db = openReadonlyDb(ledgerPath);
  if (!db) return null;
  try {
    const session = db
      .prepare(
        `SELECT task_id, brief, started_utc, ended_utc, outcome, outcome_source
         FROM sessions WHERE id = ?`,
      )
      .get(sessionId) as
      | {
          task_id: string | null;
          brief: string | null;
          started_utc: string;
          ended_utc: string | null;
          outcome: string | null;
          outcome_source: string | null;
        }
      | undefined;
    if (!session) return null;

    const totals = db
      .prepare(
        `SELECT
           COALESCE(SUM(cost_usd), 0) AS costUsd,
           COALESCE(SUM(input_tokens), 0) AS input,
           COALESCE(SUM(output_tokens), 0) AS output,
           COALESCE(SUM(cache_read_tokens), 0) AS cacheRead,
           COALESCE(SUM(cache_write_tokens), 0) AS cacheWrite,
           COALESCE(SUM(reasoning_tokens), 0) AS reasoning,
           COUNT(*) AS n
         FROM calls WHERE session_id = ?`,
      )
      .get(sessionId) as {
      costUsd: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
      n: number;
    };

    const lastCallRow = db
      .prepare(
        `SELECT ts_utc, agent, phase, provider, model, context_before, context_after,
                tool_schema_tokens, tool_count, prefix_changed
         FROM calls WHERE session_id = ? ORDER BY ts_utc DESC LIMIT 1`,
      )
      .get(sessionId) as
      | {
          ts_utc: string;
          agent: string;
          phase: string | null;
          provider: string;
          model: string;
          context_before: number | null;
          context_after: number | null;
          tool_schema_tokens: number | null;
          tool_count: number | null;
          prefix_changed: number | null;
        }
      | undefined;

    return rowToSnapshot(sessionId, session, totals, lastCallRow);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** T39: children of `parentSessionId` for the watch delegates panel. */
export function readChildSessions(
  ledgerPath: string,
  parentSessionId: string,
): import("./types.js").ChildSessionView[] {
  const db = openReadonlyDb(ledgerPath);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT s.id, s.brief, s.agent_role, s.resumable, s.not_resumable_reason, s.execution_shape,
                COALESCE((SELECT SUM(cost_usd) FROM calls c WHERE c.session_id = s.id), 0) AS costUsd
         FROM sessions s
         WHERE s.parent_session_id = ?
         ORDER BY s.started_utc ASC`,
      )
      .all(parentSessionId) as Array<{
      id: string;
      brief: string | null;
      agent_role: string | null;
      resumable: number | null;
      not_resumable_reason: string | null;
      execution_shape: string | null;
      costUsd: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      brief: r.brief,
      agent: r.agent_role,
      costUsd: r.costUsd,
      resumable: r.resumable !== 0,
      notResumableReason: r.not_resumable_reason,
      executionShape: r.execution_shape,
    }));
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * live.json first; ledger when the cache is missing (finished / purged).
 * Prefer live when both exist — it is the mid-run truth.
 */
export function resolveSessionSnapshot(ledgerPath: string, sessionId: string): ResolvedSessionSnapshot | null {
  const live = readLiveSnapshot(ledgerPath, sessionId);
  if (live) return { snapshot: live, source: "live" };
  const fromLedger = readSessionFromLedger(ledgerPath, sessionId);
  if (fromLedger) return { snapshot: fromLedger, source: "ledger" };
  return null;
}

/** Most recent live session (ended_utc IS NULL), else most recent any. */
export function findDefaultSessionId(ledgerPath: string): string | null {
  const fromLive = findNewestLiveJson(ledgerPath);
  if (fromLive) return fromLive;

  const db = openReadonlyDb(ledgerPath);
  if (!db) return null;
  try {
    const live = db
      .prepare(
        `SELECT id FROM sessions WHERE ended_utc IS NULL
         ORDER BY started_utc DESC LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (live) return live.id;
    const any = db
      .prepare(`SELECT id FROM sessions ORDER BY started_utc DESC LIMIT 1`)
      .get() as { id: string } | undefined;
    return any?.id ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function findNewestLiveJson(ledgerPath: string): string | null {
  const dir = sessionsDir(ledgerPath);
  if (!existsSync(dir)) return null;
  let bestId: string | null = null;
  let bestMtime = 0;
  for (const entry of readdirSync(dir)) {
    const path = liveSnapshotPath(ledgerPath, entry);
    if (!existsSync(path)) continue;
    try {
      const snap = readLiveSnapshot(ledgerPath, entry);
      if (!snap || snap.endedUtc) continue;
      const mtime = statSync(path).mtimeMs;
      if (mtime >= bestMtime) {
        bestMtime = mtime;
        bestId = entry;
      }
    } catch {
      // skip unreadable
    }
  }
  return bestId;
}
