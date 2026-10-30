import assert from "node:assert/strict";
import test from "node:test";
import { deriveSessionLifecycle, groupSessionRows } from "./lifecycle.js";
import type { SessionListRow } from "./listing.js";

function row(overrides: Partial<SessionListRow> = {}): SessionListRow {
  return {
    id: "s",
    taskId: null,
    taskBrief: null,
    brief: null,
    startedUtc: "2026-09-07T00:00:00.000Z",
    endedUtc: null,
    model: null,
    executionShape: "standalone",
    outcome: null,
    outcomeSource: null,
    archiveState: null,
    captureMode: "live",
    resumable: true,
    notResumableReason: null,
    parentSessionId: null,
    resumedFrom: null,
    closedUtc: null,
    deletedUtc: null,
    callCount: 1,
    costUsd: 0,
    durationSeconds: null,
    depth: 0,
    edge: null,
    ...overrides,
  };
}

test("T128 derives the four lifecycle states from durable and live evidence", () => {
  const now = new Date("2026-09-07T00:10:00.000Z");
  assert.equal(deriveSessionLifecycle(row({ callCount: 0 }), { hasUserMessage: false, now }), "empty");
  assert.equal(
    deriveSessionLifecycle(row(), { hasUserMessage: true, heartbeatUtc: "2026-09-07T00:09:59.000Z", now }),
    "running",
  );
  assert.equal(deriveSessionLifecycle(row(), { hasUserMessage: true, now }), "open");
  assert.equal(deriveSessionLifecycle(row({ closedUtc: "2026-09-07T00:01:00.000Z" }), { hasUserMessage: true, now }), "closed");
});

test("T128 orders groups and preserves per-view collapse state", () => {
  const groups = groupSessionRows(
    [row({ id: "closed", closedUtc: "x" }), row({ id: "new", callCount: 0 })],
    () => ({ hasUserMessage: false, now: new Date("2026-09-07T00:10:00.000Z") }),
    new Set(["empty"]),
  );
  assert.deepEqual(groups.map((group) => group.state), ["empty", "closed"]);
  assert.equal(groups[0]?.collapsed, true);
});

// 2026-09-07 (UI feedback item 10): the maintainer restated the four states
// as definitions, and two of them changed meaning rather than just name.
test("a run that ended is Closed, whether or not anyone closed it", () => {
  const now = new Date("2026-09-07T00:10:00.000Z");
  // "Closed (Done, resume to reopen)". `ended_utc` is the durable record
  // that the run finished, so a finished run with nothing live in it is
  // Closed — it used to read as Open, which invited the reader to think
  // something was still waiting on them.
  assert.equal(
    deriveSessionLifecycle(row({ endedUtc: "2026-09-07T00:05:00.000Z" }), { hasUserMessage: true, now }),
    "closed",
  );
});

test("the owning process's own answer beats an inferred heartbeat, in both directions", () => {
  const now = new Date("2026-09-07T00:10:00.000Z");
  // A session you are sitting in reads Open the instant its turn finishes,
  // rather than staying Running for the heartbeat's freshness window.
  assert.equal(
    deriveSessionLifecycle(row({ isRunning: false }), {
      hasUserMessage: true,
      heartbeatUtc: "2026-09-07T00:09:59.000Z",
      isRunning: false,
      now,
    }),
    "open",
  );
  assert.equal(
    deriveSessionLifecycle(row(), { hasUserMessage: true, isRunning: true, now }),
    "running",
  );
});

test("the group order is Empty, Running, Open, Closed", () => {
  const now = new Date("2026-09-07T00:10:00.000Z");
  const rows = [
    row({ id: "closed", endedUtc: "2026-09-07T00:05:00.000Z" }),
    row({ id: "open", callCount: 3 }),
    row({ id: "empty", callCount: 0 }),
    row({ id: "running", callCount: 3 }),
  ];
  const groups = groupSessionRows(rows, (r) => ({
    hasUserMessage: (r.callCount ?? 0) > 0,
    ...(r.id === "running" ? { isRunning: true } : {}),
    now,
  }));
  assert.deepEqual(groups.map((group) => group.state), ["empty", "running", "open", "closed"]);
});
