import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Ledger } from "./ledger.js";
import { formatAnnotationReport, listRediscoveries } from "./rediscovery-annotations.js";

function ledgerWith(sessions: string[] = []): Ledger {
  const l = Ledger.open(":memory:");
  for (const id of sessions) l.startSession({ id, harnessCommit: "abc" });
  return l;
}

describe("T80 — rediscovery annotations", () => {
  it("refuses an author that is not a human, with a message that says why", () => {
    const l = ledgerWith();
    // The outcome_source rule, applied to memory: an agent that could write
    // this could manufacture the evidence for memory's own value.
    assert.throws(
      () => l.recordRediscovery({ lesson: "x", author: "agent_claim" }),
      /refuses author='agent_claim'/,
    );
    assert.throws(() => l.recordRediscovery({ lesson: "x", author: "agent" }), /self-report may never create it/);
    l.close();
  });

  it("refuses an empty lesson rather than filing a blank row", () => {
    const l = ledgerWith();
    assert.throws(() => l.recordRediscovery({ lesson: "   ", author: "human" }), /the lesson is empty/);
    l.close();
  });

  it("records the lesson, its provenance and whether it would have helped", () => {
    const l = ledgerWith(["s1", "s2"]);
    l.recordRediscovery({
      lesson: "DeepSeek peak pricing swings 2x",
      author: "human",
      sessionId: "s2",
      sourceSessionId: "s1",
      wouldHaveHelped: true,
      callsSpent: 6,
      tsUtc: "2026-09-04T00:00:00.000Z",
    });
    const r = listRediscoveries(l);
    assert.equal(r.total, 1);
    assert.equal(r.helpful, 1);
    assert.equal(r.answered, 1);
    assert.equal(r.callsSpent, 6);
    const a = r.annotations[0]!;
    assert.equal(a.lesson, "DeepSeek peak pricing swings 2x");
    assert.equal(a.sourceSessionId, "s1");
    assert.equal(a.sessionId, "s2");
    l.close();
  });

  it("leaves would_have_helped NULL when it was not answered, rather than guessing no", () => {
    const l = ledgerWith();
    l.recordRediscovery({ lesson: "something", author: "human" });
    const r = listRediscoveries(l);
    assert.equal(r.annotations[0]?.wouldHaveHelped, null);
    assert.equal(r.answered, 0);
    assert.equal(r.helpful, 0);
    l.close();
  });

  it("redacts a secret pasted into a lesson", () => {
    const l = ledgerWith();
    l.recordRediscovery({ lesson: "the key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA", author: "human" });
    const stored = listRediscoveries(l).annotations[0]!.lesson;
    assert.ok(!stored.includes("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA"));
    l.close();
  });

  it("says on its face that an empty set is a lower bound, not a rate of zero", () => {
    const l = ledgerWith();
    const text = formatAnnotationReport(listRediscoveries(l));
    assert.match(text, /LOWER BOUND/);
    assert.match(text, /never a rate/);
    l.close();
  });

  it("keeps the lower-bound caveat on a non-empty report too", () => {
    const l = ledgerWith();
    l.recordRediscovery({ lesson: "a lesson", author: "human", wouldHaveHelped: false });
    const text = formatAnnotationReport(listRediscoveries(l));
    assert.match(text, /lower bound/i);
    assert.match(text, /an agent may not write these/i);
    l.close();
  });
});
