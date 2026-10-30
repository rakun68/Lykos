import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { guardToolCall, isGatedTool, recordBudgetTrip, sessionExceedsRunCap, taskExceedsRunCap } from "./budget.js";
import { Ledger } from "./ledger.js";
import { writeTodayRollup } from "./live.js";
import type { BudgetConfig } from "../config/types.js";

function tempLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-budget-"));
  return join(dir, "ledger.db");
}

const BUDGET: Required<BudgetConfig> = {
  per_run_usd: 0.5,
  per_day_usd: 2.0,
  on_exceed: "stop",
  max_concurrent_delegates: 3,
};

describe("isGatedTool", () => {
  it("gates only the calls that start new spend", () => {
    assert.equal(isGatedTool("run"), true);
    assert.equal(isGatedTool("spawn"), true);
    assert.equal(isGatedTool("spawn_batch"), true);
    assert.equal(isGatedTool("follow_up"), true);
    assert.equal(isGatedTool("steer"), false);
    assert.equal(isGatedTool("abort"), false);
    assert.equal(isGatedTool("status"), false);
  });
});

describe("guardToolCall", () => {
  it("never trips on a non-gated tool, regardless of budget state", () => {
    const path = tempLedgerPath();
    writeTodayRollup(path, {
      schemaVersion: 1,
      date: "2026-08-29",
      spentUsd: 999,
      sessions: 5,
      successes: 5,
      updatedUtc: new Date().toISOString(),
    });
    const verdict = guardToolCall({
      toolName: "steer",
      args: { sessionId: "s1", message: "stop" },
      ledgerPath: path,
      budget: BUDGET,
      defaultModel: "deepseek-v4-flash",
      trippedSessions: new Set(),
    });
    assert.equal(verdict.tripped, false);
  });

  it("trips the day cap once today's recorded spend reaches it", () => {
    const path = tempLedgerPath();
    writeTodayRollup(path, {
      schemaVersion: 1,
      date: "2026-08-29",
      spentUsd: 2.0,
      sessions: 3,
      successes: 2,
      updatedUtc: new Date().toISOString(),
    });
    const verdict = guardToolCall({
      toolName: "run",
      args: { prompt: "do a small thing" },
      ledgerPath: path,
      budget: BUDGET,
      defaultModel: "deepseek-v4-flash",
      trippedSessions: new Set(),
    });
    assert.equal(verdict.tripped, true);
    if (verdict.tripped) assert.equal(verdict.capKind, "day");
  });

  it("does not trip the day cap while under it, with no other signal", () => {
    const path = tempLedgerPath();
    writeTodayRollup(path, {
      schemaVersion: 1,
      date: "2026-08-29",
      spentUsd: 0.1,
      sessions: 1,
      successes: 1,
      updatedUtc: new Date().toISOString(),
    });
    const verdict = guardToolCall({
      toolName: "run",
      args: { prompt: "short" },
      ledgerPath: path,
      budget: BUDGET,
      defaultModel: "deepseek-v4-flash",
      trippedSessions: new Set(),
    });
    assert.equal(verdict.tripped, false);
  });

  it("treats a missing today.json as zero spent today, not as tripped", () => {
    const path = tempLedgerPath(); // never written — fresh workspace, no prior session
    const verdict = guardToolCall({
      toolName: "run",
      args: { prompt: "first run of the day" },
      ledgerPath: path,
      budget: BUDGET,
      defaultModel: "deepseek-v4-flash",
      trippedSessions: new Set(),
    });
    assert.equal(verdict.tripped, false);
  });

  it("trips the concurrency cap when spawn_batch requests more than max_concurrent_delegates", () => {
    const path = tempLedgerPath();
    const tasks = Array.from({ length: 5 }, (_, i) => ({ prompt: `task ${i}` }));
    const verdict = guardToolCall({
      toolName: "spawn_batch",
      args: { tasks },
      ledgerPath: path,
      budget: BUDGET, // max_concurrent_delegates: 3
      defaultModel: "deepseek-v4-flash",
      trippedSessions: new Set(),
    });
    assert.equal(verdict.tripped, true);
    if (verdict.tripped) assert.equal(verdict.capKind, "concurrency");
  });

  it("lets spawn_batch through at or under the concurrency cap", () => {
    const path = tempLedgerPath();
    const tasks = Array.from({ length: 3 }, (_, i) => ({ prompt: `task ${i}` }));
    const verdict = guardToolCall({
      toolName: "spawn_batch",
      args: { tasks },
      ledgerPath: path,
      budget: BUDGET,
      defaultModel: "deepseek-v4-flash",
      trippedSessions: new Set(),
    });
    assert.equal(verdict.tripped, false);
  });

  it("blocks follow_up on a session already known to have exceeded the per-run cap", () => {
    const path = tempLedgerPath();
    const verdict = guardToolCall({
      toolName: "follow_up",
      args: { sessionId: "blown-session", prompt: "one more thing" },
      ledgerPath: path,
      budget: BUDGET,
      defaultModel: "deepseek-v4-flash",
      trippedSessions: new Set(["blown-session"]),
    });
    assert.equal(verdict.tripped, true);
    if (verdict.tripped) assert.equal(verdict.capKind, "run");
  });

  it("trips the per-run cap on preflight estimate for a pathologically large prompt", () => {
    const path = tempLedgerPath();
    // ~4 chars/token estimator: 12,000,000 chars ≈ 3M tokens. Even at
    // deepseek-v4-flash's cheapest window (off-peak, $0.22/mtok) that prices
    // at ~$0.66 — over the $0.50 cap regardless of which peak/off-peak
    // window the test happens to run in, so this can't flake on time of day.
    const hugePrompt = "x".repeat(12_000_000);
    const verdict = guardToolCall({
      toolName: "run",
      args: { prompt: hugePrompt },
      ledgerPath: path,
      budget: BUDGET,
      defaultModel: "deepseek-v4-flash",
      trippedSessions: new Set(),
    });
    assert.equal(verdict.tripped, true);
    if (verdict.tripped) assert.equal(verdict.capKind, "run");
  });

  it("does not trip the per-run preflight estimate for an ordinary prompt", () => {
    const path = tempLedgerPath();
    const verdict = guardToolCall({
      toolName: "run",
      args: { prompt: "reply with pong" },
      ledgerPath: path,
      budget: BUDGET,
      defaultModel: "deepseek-v4-flash",
      trippedSessions: new Set(),
    });
    assert.equal(verdict.tripped, false);
  });

  it("does not throw and does not trip on an unpriced model — cannot estimate is not tripped", () => {
    const path = tempLedgerPath();
    const verdict = guardToolCall({
      toolName: "run",
      args: { prompt: "hello", model: "nobody/not-a-real-model" },
      ledgerPath: path,
      budget: BUDGET,
      defaultModel: "deepseek-v4-flash",
      trippedSessions: new Set(),
    });
    assert.equal(verdict.tripped, false);
  });

  it("T39.4: per-run preflight includes taskSpentUsd so a cheap prompt after expensive children still trips", () => {
    const path = tempLedgerPath();
    const verdict = guardToolCall({
      toolName: "spawn",
      args: { prompt: "short", model: "deepseek/deepseek-v4-flash" },
      ledgerPath: path,
      budget: { ...BUDGET, per_run_usd: 0.01 },
      defaultModel: "deepseek/deepseek-v4-flash",
      trippedSessions: new Set(),
      taskSpentUsd: 0.01,
    });
    assert.equal(verdict.tripped, true);
    if (verdict.tripped) {
      assert.equal(verdict.capKind, "run");
      assert.match(verdict.reason, /task tree/);
    }
  });
});

describe("taskExceedsRunCap", () => {
  it("sums parent and children, not the parent node alone", () => {
    const ledger = Ledger.open(":memory:");
    const parent = ledger.startSession({ brief: "p", harnessCommit: "x" });
    const child = ledger.startSession({
      brief: "c",
      harnessCommit: "x",
      parentSessionId: parent,
    });
    ledger.recordCall({
      sessionId: parent,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
    });
    ledger.recordCall({
      sessionId: child,
      agent: "scout",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 },
      hop: 1,
      ts: new Date("2026-08-29T12:00:00Z"),
    });
    const parentOnly = ledger.callTotals(parent).costUsd!;
    const tree = ledger.taskCallTotals(parent).costUsd!;
    assert.ok(tree > parentOnly);
    const mid = parentOnly + (tree - parentOnly) / 2;
    assert.equal(taskExceedsRunCap(ledger, parent, mid), true);
    assert.equal(sessionExceedsRunCap(ledger, parent, mid), false);
    ledger.close();
  });
});

describe("sessionExceedsRunCap", () => {
  it("reads real recorded cost, not an estimate", () => {
    const ledger = Ledger.open(":memory:");
    const sessionId = ledger.startSession({ brief: "expensive session", harnessCommit: "abc" });
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 50_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
    });
    assert.equal(sessionExceedsRunCap(ledger, sessionId, 0.5), true);
    assert.equal(sessionExceedsRunCap(ledger, sessionId, 1_000_000), false);
    ledger.close();
  });
});

describe("recordBudgetTrip", () => {
  it("writes an abandoned session with zero calls and a reason in the notes", () => {
    const ledger = Ledger.open(":memory:");
    const verdict = guardToolCall({
      toolName: "run",
      args: { prompt: "x" },
      ledgerPath: ":memory:",
      budget: { ...BUDGET, per_day_usd: 0 },
      defaultModel: "deepseek-v4-flash",
      trippedSessions: new Set(),
    });
    assert.equal(verdict.tripped, true);
    if (!verdict.tripped) throw new Error("expected a trip");

    const sessionId = recordBudgetTrip(ledger, { toolName: "run", verdict });
    const row = ledger.db.prepare(`SELECT outcome, notes FROM sessions WHERE id = ?`).get(sessionId) as {
      outcome: string;
      notes: string;
    };
    assert.equal(row.outcome, "abandoned");
    assert.match(row.notes, /spend kill switch tripped \(day cap\)/);
    assert.equal(ledger.hasCalls(sessionId), false);
    ledger.close();
  });
});
