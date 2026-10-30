import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Ledger } from "./ledger.js";
import { formatSessionSummary, loadSessionSummary } from "./summary.js";

describe("loadSessionSummary / formatSessionSummary", () => {
  it("returns null for an unknown session", () => {
    const db = Ledger.open(":memory:");
    assert.equal(loadSessionSummary(db, "does-not-exist"), null);
    db.close();
  });

  it("renders tokens, cost by hop, and a real T6.1 cache-avoided figure", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ brief: "implement: add retry", harnessCommit: "abc123" });
    db.recordCall({
      sessionId,
      hop: 0,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 20, cacheRead: 900, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
    });
    db.recordCall({
      sessionId,
      hop: 1,
      agent: "subagent",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:05Z"),
    });
    db.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command", turns: 3, toolCalls: 2 });

    const summary = loadSessionSummary(db, sessionId);
    assert.ok(summary);
    const text = formatSessionSummary(summary!);

    assert.match(text, /implement: add retry/);
    assert.match(text, /outcome\s+success \(verification_command\)/);
    assert.match(text, /cached\s+900\s+\(85\.7%\)/);
    assert.match(text, /fresh\s+150/);
    assert.match(text, /output\s+25/);
    assert.match(text, /hop 0 \(direct\)/);
    assert.match(text, /hop 1 \(subagent\)/);
    // hop 0: cacheRead=900 at off-peak DeepSeek rates (input 0.22, cacheRead
    // 0.007 per mtok) -> 900/1e6 * (0.22 - 0.007) = $0.0001917; hop 1 has no
    // cache activity, so its own avoided figure is exactly zero.
    assert.match(text, /avoided\s+~\$0\.0002/);
    assert.match(text, /schema tax\s+not measured/);
    db.close();
  });

  it("T20.1: prints per-session schema share from v_schema_tax when toolNames were recorded", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ brief: "measured schema", harnessCommit: "abc123" });
    db.recordCall({
      sessionId,
      hop: 0,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 400, output: 10, cacheRead: 600, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
      toolNames: ["read", "bash", "edit", "write"],
    });
    db.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });
    const summary = loadSessionSummary(db, sessionId);
    assert.ok(summary);
    assert.ok(summary.schemaTax.measuredCalls > 0);
    assert.ok(summary.schemaTax.share !== null);
    const text = formatSessionSummary(summary);
    assert.match(text, /schema tax\s+\d[\d,]* tokens\/call\s+\d+\.\d+% of prompt/);
    db.close();
  });

  it("still reports 'not yet computed' for a pre-T6.1 row with no avoided figure at all", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ brief: "legacy row", harnessCommit: "abc123" });
    db.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
    });
    // Simulate a row written before T6.1 existed, when avoided_usd was
    // always NULL -- endSession()'s SUM(avoided_usd) must still read this
    // session as "not computed," not silently coerce it to $0.
    db.db.prepare(`UPDATE calls SET avoided_usd = NULL WHERE session_id = ?`).run(sessionId);
    db.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });

    const summary = loadSessionSummary(db, sessionId);
    const text = formatSessionSummary(summary!);
    assert.match(text, /avoided\s+not yet computed — counterfactual accounting is T6/);
    db.close();
  });

  it("shows a real avoided figure once a call actually has one, never a fabricated $0.00", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ brief: "cached prefix run", harnessCommit: "abc123" });
    db.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
      avoidedUsd: 0.0123,
      avoidedBasis: "cache_read_vs_input_price",
    });
    db.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });

    const summary = loadSessionSummary(db, sessionId);
    const text = formatSessionSummary(summary!);
    assert.match(text, /avoided\s+~\$0\.0123/);
    assert.doesNotMatch(text, /not yet computed/);
    db.close();
  });

  it("marks an in-progress session and omits wall time until it ends", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ brief: "still running", harnessCommit: "abc123" });
    const summary = loadSessionSummary(db, sessionId);
    const text = formatSessionSummary(summary!);
    assert.match(text, /outcome\s+in progress/);
    assert.doesNotMatch(text, /wall time/);
    db.close();
  });
});
