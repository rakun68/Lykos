// The one addition to the write path docs/07-ui-and-hud.md §1.1 calls for:
// small, atomically-written cache files that let a fast reader (the
// status-line adapter, the stderr HUD) show current numbers without opening
// SQLite. Justified by measurement, not by the doc alone — see DECISIONS.md
// 2026-08-29 "live.json cache, measured": a cold `node` process that opens
// the real ledger in WAL mode and runs one query measured p50 78ms / p95 95ms
// on the dev machine, against p50 47ms / p95 56ms for a bare JSON read at the
// same process-start cost. Against the §8 budget of p95 < 50ms including node
// start, SQLite alone already exceeds it; the cache is what makes the budget
// reachable at all, not a premature optimisation.
//
// The ledger stays authoritative. Both files may be deleted at any time —
// a reader that finds them missing or unparsable falls back to null, never
// throws, and a caller falls back to the ledger itself.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface LiveTotals {
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  calls: number;
}

export interface LiveLastCall {
  tsUtc: string;
  agent: string;
  phase: string | null;
  provider: string;
  model: string;
  contextBefore: number | null;
  contextAfter: number | null;
  /** T4.1: catalog measurement for this call; null if unmeasured. */
  toolSchemaTokens: number | null;
  toolCount: number | null;
  /** T4.2: true when this call's tool-schema hash differs from the previous. */
  prefixChanged: boolean;
}

export interface LiveSnapshot {
  schemaVersion: 1;
  sessionId: string;
  taskId: string | null;
  brief: string | null;
  startedUtc: string;
  heartbeatUtc: string;
  endedUtc: string | null;
  outcome: string | null;
  outcomeSource: string | null;
  totals: LiveTotals;
  lastCall: LiveLastCall | null;
}

export interface TodayRollup {
  schemaVersion: 1;
  date: string; // YYYY-MM-DD, UTC
  spentUsd: number;
  sessions: number;
  successes: number;
  updatedUtc: string;
}

/** Directory sibling to ledger.db that holds one subdirectory per session. */
export function sessionsDir(ledgerPath: string): string {
  return join(dirname(ledgerPath), "sessions");
}

export function liveSnapshotPath(ledgerPath: string, sessionId: string): string {
  return join(sessionsDir(ledgerPath), sessionId, "live.json");
}

export function todayRollupPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), "today.json");
}

/** Write-temp-then-rename so a reader never observes a half-written file. */
function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, path);
  } catch (err) {
    // D15: a failed rename (on Windows, a reader holding the target open)
    // must not leave the temporary file behind; the caller still sees the error.
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function writeLiveSnapshot(ledgerPath: string, snapshot: LiveSnapshot): void {
  writeAtomic(liveSnapshotPath(ledgerPath, snapshot.sessionId), JSON.stringify(snapshot));
}

/** Never throws: a missing or corrupt cache file is a cache miss, not an error. */
export function readLiveSnapshot(ledgerPath: string, sessionId: string): LiveSnapshot | null {
  const path = liveSnapshotPath(ledgerPath, sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as LiveSnapshot;
  } catch {
    return null;
  }
}

/** Removes the per-session cache file. Safe to call on an already-removed one. */
export function removeLiveSnapshot(ledgerPath: string, sessionId: string): void {
  const path = liveSnapshotPath(ledgerPath, sessionId);
  try {
    unlinkSync(path);
  } catch {
    // already gone — the file is a cache, this is not an error
  }
}

export function writeTodayRollup(ledgerPath: string, rollup: TodayRollup): void {
  writeAtomic(todayRollupPath(ledgerPath), JSON.stringify(rollup));
}

export function readTodayRollup(ledgerPath: string): TodayRollup | null {
  const path = todayRollupPath(ledgerPath);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TodayRollup;
  } catch {
    return null;
  }
}

/** Throttles writes to at most 4 Hz per session (docs/07-ui-and-hud.md §1.1). */
export class LiveWriteThrottle {
  private lastWriteMs = new Map<string, number>();
  private readonly minIntervalMs: number;

  constructor(hz = 4) {
    this.minIntervalMs = 1000 / hz;
  }

  /** `force` bypasses throttling — always used for the final write on endSession. */
  shouldWrite(sessionId: string, force: boolean): boolean {
    if (force) {
      this.lastWriteMs.set(sessionId, Date.now());
      return true;
    }
    const last = this.lastWriteMs.get(sessionId) ?? 0;
    const now = Date.now();
    if (now - last < this.minIntervalMs) return false;
    this.lastWriteMs.set(sessionId, now);
    return true;
  }
}
