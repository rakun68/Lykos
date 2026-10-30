import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "./ledger.js";
import { liveSnapshotPath, readLiveSnapshot, readTodayRollup, writeLiveSnapshot, type LiveSnapshot } from "./live.js";

function tempLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-live-"));
  return join(dir, "ledger.db");
}

describe("live cache", () => {
  it("writes live.json after startSession and keeps it current after recordCall", async () => {
    const path = tempLedgerPath();
    const ledger = Ledger.open(path);
    const sessionId = ledger.startSession({ brief: "test task", harnessCommit: "abc" });

    const afterStart = readLiveSnapshot(path, sessionId);
    assert.ok(afterStart);
    assert.equal(afterStart.sessionId, sessionId);
    assert.equal(afterStart.totals.calls, 0);
    assert.equal(afterStart.endedUtc, null);

    // Past the 4 Hz throttle window (live.ts) so this recordCall's write is
    // not suppressed as a burst follow-up to startSession's forced write.
    await new Promise((resolve) => setTimeout(resolve, 260));

    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
    });

    const afterCall = readLiveSnapshot(path, sessionId);
    assert.ok(afterCall);
    assert.equal(afterCall.totals.calls, 1);
    assert.equal(afterCall.totals.input, 100);
    assert.ok(afterCall.lastCall);
    assert.equal(afterCall.lastCall.model, "deepseek-v4-flash");
    assert.equal(afterCall.lastCall.toolSchemaTokens, null);
    assert.equal(afterCall.lastCall.toolCount, null);
    assert.equal(afterCall.lastCall.prefixChanged, false);

    ledger.close();
  });

  it("marks live.json ended and updates today.json after endSession", () => {
    const path = tempLedgerPath();
    const ledger = Ledger.open(path);
    const sessionId = ledger.startSession({ brief: "test task", harnessCommit: "abc" });
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
    });
    ledger.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });

    const live = readLiveSnapshot(path, sessionId);
    assert.ok(live);
    assert.ok(live.endedUtc);
    assert.equal(live.outcome, "success");

    const rollup = readTodayRollup(path);
    assert.ok(rollup);
    assert.equal(rollup.sessions, 1);
    assert.equal(rollup.successes, 1);
    assert.ok(rollup.spentUsd > 0);

    ledger.close();
  });

  it("does not write a live cache for an in-memory ledger", () => {
    const ledger = Ledger.open(":memory:");
    const sessionId = ledger.startSession({ brief: "no cache", harnessCommit: "abc" });
    // No directory exists for ":memory:", so this only proves refreshLiveCache
    // did not throw trying to write beside a non-existent path.
    assert.equal(readLiveSnapshot(":memory:", sessionId), null);
    ledger.close();
  });
});

describe("atomic write (D15)", () => {
  it("removes its temporary file when the rename fails, and still throws", () => {
    const path = tempLedgerPath();
    const target = liveSnapshotPath(path, "s1");
    // A non-empty directory where the file should go: the rename over it
    // fails on every platform, standing in for Windows' held-open target.
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "keep"), "x");
    assert.throws(() => writeLiveSnapshot(path, { sessionId: "s1" } as LiveSnapshot));
    assert.deepEqual(readdirSync(join(target, "..")), ["live.json"]);
  });
});
