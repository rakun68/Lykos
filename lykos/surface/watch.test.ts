import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../config/load.js";
import { Ledger } from "../ledger/ledger.js";
import { removeLiveSnapshot, writeLiveSnapshot, type LiveSnapshot } from "../ledger/live.js";
import { PI_DEFAULT_TOOLS } from "../ledger/tool-schema.js";
import { derive } from "./derive.js";
import { collect } from "./collect.js";
import { renderWatchFrame } from "./renderers/watch.js";
import { findDefaultSessionId, resolveSessionSnapshot } from "./session-snapshot.js";
import { resolveTheme } from "./theme/resolve.js";

function makeLive(sessionId: string, ended: boolean): LiveSnapshot {
  return {
    schemaVersion: 1,
    sessionId,
    taskId: null,
    brief: "watch me",
    startedUtc: "2026-09-01T00:00:00Z",
    heartbeatUtc: "2026-09-01T00:01:00Z",
    endedUtc: ended ? "2026-09-01T00:02:00Z" : null,
    outcome: ended ? "success" : null,
    outcomeSource: ended ? "verification_command" : null,
    totals: {
      costUsd: 0.02,
      input: 1000,
      output: 100,
      cacheRead: 500,
      cacheWrite: 50,
      reasoning: 0,
      calls: 1,
    },
    lastCall: {
      tsUtc: "2026-09-01T00:01:00Z",
      agent: "worker",
      phase: "implement",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      contextBefore: 1000,
      contextAfter: 2000,
      toolSchemaTokens: 3500,
      toolCount: 7,
      prefixChanged: false,
    },
  };
}

describe("T38 watch: live.json + ledger fallback", () => {
  it("prefers live.json for a running session and shows schema tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-watch-"));
    const ledgerPath = join(dir, "ledger.db");
    try {
      const ledger = Ledger.open(ledgerPath);
      const id = ledger.startSession({ brief: "watch me", harnessCommit: "test" });
      ledger.recordCall({
        sessionId: id,
        agent: "worker",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        tokens: { input: 1000, output: 100, cacheRead: 500, cacheWrite: 50 },
        ts: new Date("2026-09-01T00:01:00Z"),
        toolNames: [...PI_DEFAULT_TOOLS],
      });
      // Force a known live cache shape (refreshLiveCache also writes one).
      writeLiveSnapshot(ledgerPath, makeLive(id, false));
      ledger.close();

      const resolved = resolveSessionSnapshot(ledgerPath, id);
      assert.ok(resolved);
      assert.equal(resolved!.source, "live");
      assert.equal(resolved!.snapshot.lastCall?.toolSchemaTokens, 3500);

      const config = loadConfig({ cwd: dir }).resolved;
      const snap = collect({
        ledgerPath,
        sessionId: id,
        config,
        runOverride: {
          sessionId: resolved!.snapshot.sessionId,
          brief: resolved!.snapshot.brief,
          startedUtc: resolved!.snapshot.startedUtc,
          heartbeatUtc: resolved!.snapshot.heartbeatUtc,
          endedUtc: resolved!.snapshot.endedUtc,
          outcome: resolved!.snapshot.outcome,
          outcomeSource: resolved!.snapshot.outcomeSource,
          totals: resolved!.snapshot.totals,
          lastCall: resolved!.snapshot.lastCall,
        },
        now: new Date("2026-09-01T00:01:30Z"),
      });
      const vm = derive(snap);
      assert.equal(vm.health.toolSchemaTokens, 3500);
      const theme = resolveTheme("mono", "none", "unicode");
      const frame = renderWatchFrame(vm, {
        width: 80,
        height: 40,
        theme,
        panels: ["now", "cost", "tokens", "health", "session"],
        source: "live",
      });
      assert.match(frame, /lykos watch/);
      assert.match(frame, /\$0\.02/);
      assert.match(frame, /3\.5k tokens/);
      assert.match(frame, /HEALTH/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the ledger for a finished session with no live.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-watch-done-"));
    const ledgerPath = join(dir, "ledger.db");
    try {
      const ledger = Ledger.open(ledgerPath);
      const id = ledger.startSession({ brief: "done task", harnessCommit: "test" });
      ledger.recordCall({
        sessionId: id,
        agent: "worker",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        tokens: { input: 2000, output: 200, cacheRead: 800, cacheWrite: 40 },
        ts: new Date("2026-09-01T00:01:00Z"),
        toolNames: [...PI_DEFAULT_TOOLS],
      });
      ledger.endSession({ id, outcome: "success", outcomeSource: "verification_command" });
      removeLiveSnapshot(ledgerPath, id);
      ledger.close();

      const resolved = resolveSessionSnapshot(ledgerPath, id);
      assert.ok(resolved);
      assert.equal(resolved!.source, "ledger");
      assert.equal(resolved!.snapshot.outcome, "success");
      assert.ok(
        resolved!.snapshot.lastCall?.toolSchemaTokens !== null &&
          resolved!.snapshot.lastCall!.toolSchemaTokens! > 0,
      );

      const config = loadConfig({ cwd: dir }).resolved;
      const vm = derive(
        collect({
          ledgerPath,
          sessionId: id,
          config,
          runOverride: {
            sessionId: resolved!.snapshot.sessionId,
            brief: resolved!.snapshot.brief,
            startedUtc: resolved!.snapshot.startedUtc,
            heartbeatUtc: resolved!.snapshot.heartbeatUtc,
            endedUtc: resolved!.snapshot.endedUtc,
            outcome: resolved!.snapshot.outcome,
            outcomeSource: resolved!.snapshot.outcomeSource,
            totals: resolved!.snapshot.totals,
            lastCall: resolved!.snapshot.lastCall,
          },
        }),
      );
      const theme = resolveTheme("mono", "none", "unicode");
      const frame = renderWatchFrame(vm, {
        width: 80,
        height: 40,
        theme,
        panels: ["session", "health"],
        source: "ledger",
      });
      assert.match(frame, /success/);
      assert.match(frame, /schema/);
      assert.equal(findDefaultSessionId(ledgerPath), id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
