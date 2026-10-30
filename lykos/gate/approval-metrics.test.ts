import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApprovalMetrics } from "./approval-metrics.js";

describe("T111.2 approvals counted by tier", () => {
  it("separates a prompt, a human refusal, a mode refusal, and a silent allow", () => {
    const m = new ApprovalMetrics();
    m.record("auto", "hard-write", "ask");
    m.recordHumanDenial("auto", "hard-write");
    m.record("manual", "soft-write", "deny");
    m.record("auto", "read", "allow");

    assert.deepEqual(m.totals, { requested: 1, denied: 1, autoDenied: 1, allowed: 1 });
  });

  it("keeps a mode refusal out of the friction number — a mode denial is not friction", () => {
    const m = new ApprovalMetrics();
    for (let i = 0; i < 5; i += 1) m.record("manual", "soft-write", "deny");
    assert.equal(m.totals.requested, 0, "nobody was asked, so there was no friction");
    assert.equal(m.totals.autoDenied, 5);
    assert.equal(m.totals.denied, 0);
  });

  it("breaks down by tier, omitting tiers nothing reached", () => {
    const m = new ApprovalMetrics();
    m.record("manual", "read", "ask");
    m.record("manual", "destructive", "ask");
    m.recordHumanDenial("manual", "destructive");
    const byTier = JSON.parse(m.serializeByTier()) as Record<string, Record<string, number>>;
    assert.deepEqual(Object.keys(byTier), ["read", "destructive"], "in RISK_TIERS order, and only what was reached");
    assert.equal(byTier.read?.requested, 1);
    assert.equal(byTier.read?.denied, 0);
    assert.equal(byTier.destructive?.requested, 1);
    assert.equal(byTier.destructive?.denied, 1);
  });
});

describe("T111.2 approvals counted by interaction mode", () => {
  it("tells Manual's asks apart from Auto's, which is the whole point of the second breakdown", () => {
    const m = new ApprovalMetrics();
    // The same action, in the two modes that treat it oppositely.
    m.record("manual", "read", "ask");
    m.record("auto", "read", "allow");
    const byMode = JSON.parse(m.serializeByMode()) as Record<string, Record<string, number>>;
    assert.equal(byMode.manual?.requested, 1);
    assert.equal(byMode.manual?.allowed, 0);
    assert.equal(byMode.auto?.requested, 0);
    assert.equal(byMode.auto?.allowed, 1);
  });

  it("agrees with the tier breakdown on the totals, because both count the same decisions", () => {
    const m = new ApprovalMetrics();
    m.record("manual", "read", "ask");
    m.record("auto", "hard-write", "ask");
    m.record("accept-edits", "destructive", "deny");
    m.recordHumanDenial("manual", "read");

    const sum = (json: string, field: string): number =>
      Object.values(JSON.parse(json) as Record<string, Record<string, number>>).reduce(
        (acc, tally) => acc + (tally[field] ?? 0),
        0,
      );
    for (const field of ["requested", "denied", "autoDenied", "allowed"]) {
      assert.equal(sum(m.serializeByTier(), field), sum(m.serializeByMode(), field), field);
    }
    assert.equal(sum(m.serializeByTier(), "requested"), m.totals.requested);
  });
});

describe("T111.2 a session with zero approvals", () => {
  it("reports zeros and empty breakdowns, which is not the same as never having had a gate", () => {
    const m = new ApprovalMetrics();
    assert.deepEqual(m.totals, { requested: 0, denied: 0, autoDenied: 0, allowed: 0 });
    assert.equal(m.serializeByTier(), "{}");
    assert.equal(m.serializeByMode(), "{}");
  });
});
