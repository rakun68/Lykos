// Test support for the LSP tests: ending a pool, proving its servers are gone, and
// removing the workspace folder on Windows.

import assert from "node:assert/strict";
import { rmSync } from "node:fs";

/** The errors Windows raises while something outside the test still has the folder open. */
const TRANSIENT = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

/** How long a folder may stay held before the removal is a real failure. */
const REMOVE_BUDGET_MS = 15_000;

/** Block the thread for `ms`; the cleanups that call this are synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove a test's temp workspace, waiting out a transient hold.
 *
 * Under load `rmSync` throws EPERM straight after `shutdownAll()` has returned
 * and every language-server process is provably gone (measured: no descendant
 * of the test process is alive when it throws). The hold is Windows' own and
 * clears within a moment. Node 24's `maxRetries` does not help: its remover
 * fails EPERM at once with no retry, so the retry is done here, bounded, and
 * the last error is rethrown once the budget is spent rather than swallowed.
 */
export function removeWorkspace(dir: string): void {
  const deadline = Date.now() + REMOVE_BUDGET_MS;
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT.has(code) || Date.now() >= deadline) throw err;
      sleepSync(50);
    }
  }
}

/** True only when the OS has no such process. Anything else, including EPERM, means it is still there. */
export function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** The part of a pool the helper needs, so a test can hand it one that leaks. */
export interface ShutdownablePool {
  pids(): number[];
  shutdownAll(): Promise<void>;
}

/**
 * End a pool, PROVE by asking the OS that every server it started is gone, then
 * remove the workspaces.
 *
 * The pids are read BEFORE `shutdownAll()`, because that call empties the pool's
 * own map and `pids()` afterwards is always empty: a check made through the pool
 * after shutdown can never fail. The check is made before the folders are
 * removed, so a leaked server fails as "survived shutdown" and not as an EPERM
 * after the removal budget. Every folder is removed even when the check or an
 * earlier removal throws; the first error is the one reported.
 */
export async function shutdownAndAssertGone(pool: ShutdownablePool, ...dirs: string[]): Promise<void> {
  const pids = pool.pids();
  const errors: unknown[] = [];
  try {
    await pool.shutdownAll();
    for (const pid of pids) assert.equal(processGone(pid), true, `language server ${pid} survived shutdown`);
  } catch (err) {
    errors.push(err);
  }
  for (const dir of dirs) {
    try {
      removeWorkspace(dir);
    } catch (err) {
      errors.push(err);
    }
  }
  if (errors.length > 0) throw errors[0];
}
