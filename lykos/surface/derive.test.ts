import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { derive } from "./derive.js";
import type { RunLastCall, RunSnapshot, Snapshot } from "./types.js";

function baseSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    now: new Date("2026-08-29T12:00:00Z"),
    run: null,
    today: null,
    budget: { perRunUsd: 0.5, perDayUsd: 2.0, onExceed: "stop" },
    parentContext: null,
    rateLimits: null,
    delegateContextTokens: undefined,
    ...overrides,
  };
}

function lastCall(overrides: Partial<RunLastCall> = {}): RunLastCall {
  return {
    tsUtc: "2026-08-29T12:00:00Z",
    agent: "worker",
    phase: null,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    contextBefore: 1000,
    contextAfter: 12000,
    toolSchemaTokens: null,
    toolCount: null,
    prefixChanged: false,
    ...overrides,
  };
}

function runWith(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    sessionId: "s1",
    brief: "test",
    startedUtc: "2026-08-29T11:58:00Z",
    heartbeatUtc: "2026-08-29T12:00:00Z",
    endedUtc: null,
    outcome: null,
    outcomeSource: null,
    totals: { costUsd: 0.01, input: 1000, output: 200, cacheRead: 9000, cacheWrite: 500, reasoning: 0, calls: 2 },
    lastCall: null,
    ...overrides,
  };
}

describe("derive: tokens", () => {
  it("computes the cache hit ratio as cacheRead / (fresh + cacheRead)", () => {
    const vm = derive(baseSnapshot({ run: runWith() }));
    assert.equal(vm.tokens.hitRatio, 9000 / (1000 + 9000));
  });

  it("returns null hit ratio with no calls yet", () => {
    const vm = derive(baseSnapshot({ run: null }));
    assert.equal(vm.tokens.hitRatio, null);
  });
});

describe("derive: cost + budget alerts", () => {
  it("no alert below 80% of either cap", () => {
    const vm = derive(baseSnapshot({ run: runWith({ totals: { ...runWith().totals, costUsd: 0.1 } }) }));
    assert.equal(vm.alerts.find((a) => a.id === "H-5"), undefined);
  });

  it("warns at >=80% of the run cap", () => {
    const vm = derive(baseSnapshot({ run: runWith({ totals: { ...runWith().totals, costUsd: 0.45 } }) }));
    const alert = vm.alerts.find((a) => a.id === "H-5");
    assert.ok(alert);
    assert.equal(alert.severity, "warn");
  });

  it("goes danger at 100% of the day cap even if the run itself is cheap", () => {
    const vm = derive(
      baseSnapshot({
        run: runWith({ totals: { ...runWith().totals, costUsd: 0.01 } }),
        today: { date: "2026-08-29", spentUsd: 2.0, sessions: 5, successes: 4 },
      }),
    );
    const alert = vm.alerts.find((a) => a.id === "H-5");
    assert.ok(alert);
    assert.equal(alert.severity, "danger");
  });
});

describe("derive: outcome", () => {
  it("marks agent_claim as not verified and raises H-8", () => {
    const vm = derive(
      baseSnapshot({ run: runWith({ outcome: "success", outcomeSource: "agent_claim" }) }),
    );
    assert.equal(vm.outcome?.verified, false);
    assert.ok(vm.alerts.some((a) => a.id === "H-8"));
  });

  it("marks verification_command as verified with no H-8", () => {
    const vm = derive(
      baseSnapshot({ run: runWith({ outcome: "success", outcomeSource: "verification_command" }) }),
    );
    assert.equal(vm.outcome?.verified, true);
    assert.equal(vm.alerts.some((a) => a.id === "H-8"), false);
  });
});

describe("derive: context gauges", () => {
  it("omits the delegate percentage when the model's context window is unknown", () => {
    const vm = derive(
      baseSnapshot({
        run: runWith({
            lastCall: lastCall({
              contextBefore: 1000,
              contextAfter: 12000,
            }),
        }),
        delegateContextTokens: undefined,
      }),
    );
    assert.equal(vm.context.delegate?.usedTokens, 12000);
    assert.equal(vm.context.delegate?.totalTokens, null);
    assert.equal(vm.context.delegate?.pct, null);
  });

  it("raises H-6 when context is >= 85%", () => {
    const vm = derive(
      baseSnapshot({ parentContext: { usedTokens: 170000, totalTokens: 200000, usedPercentage: 0.85 } }),
    );
    assert.ok(vm.alerts.some((a) => a.id === "H-6"));
  });
});

describe("derive: silent delegate", () => {
  it("raises H-10 when the heartbeat is stale and the run has not ended", () => {
    const vm = derive(
      baseSnapshot({
        now: new Date("2026-08-29T12:05:00Z"),
        run: runWith({ heartbeatUtc: "2026-08-29T12:00:00Z", endedUtc: null }),
      }),
    );
    assert.ok(vm.alerts.some((a) => a.id === "H-10"));
  });

  it("does not raise H-10 once the run has ended", () => {
    const vm = derive(
      baseSnapshot({
        now: new Date("2026-08-29T12:05:00Z"),
        run: runWith({ heartbeatUtc: "2026-08-29T12:00:00Z", endedUtc: "2026-08-29T12:00:05Z" }),
      }),
    );
    assert.equal(vm.alerts.some((a) => a.id === "H-10"), false);
  });
});

describe("derive: cache hit ratio floor (H-1, T18.2)", () => {
  it("raises H-1 on a multi-turn session below the Phase 2 floor", () => {
    const vm = derive(
      baseSnapshot({
        run: runWith({
          totals: { costUsd: 0.01, input: 1000, output: 200, cacheRead: 0, cacheWrite: 500, reasoning: 0, calls: 3 },
        }),
      }),
    );
    const alert = vm.alerts.find((a) => a.id === "H-1");
    assert.ok(alert);
    assert.equal(alert.severity, "warn");
    assert.match(alert.message, /cache hit ratio 0% is below the Phase 2 floor \(80%\)/);
    assert.match(alert.remedy, /v_head_drift/);
  });

  it("does not raise H-1 at or above the floor, on a single-call miss, or with no run", () => {
    const atFloor = derive(
      baseSnapshot({
        run: runWith({
          totals: { costUsd: 0.01, input: 200, output: 10, cacheRead: 800, cacheWrite: 0, reasoning: 0, calls: 4 },
        }),
      }),
    );
    assert.equal(atFloor.tokens.hitRatio, 0.8);
    assert.equal(atFloor.alerts.some((a) => a.id === "H-1"), false);

    const single = derive(
      baseSnapshot({
        run: runWith({
          totals: { costUsd: 0.01, input: 1000, output: 10, cacheRead: 0, cacheWrite: 500, reasoning: 0, calls: 1 },
        }),
      }),
    );
    assert.equal(single.alerts.some((a) => a.id === "H-1"), false);

    const none = derive(baseSnapshot({ run: null }));
    assert.equal(none.alerts.some((a) => a.id === "H-1"), false);
  });

  it("does not raise H-1 on the warmed multi-turn fixture already used by the HUD tests", () => {
    const vm = derive(baseSnapshot({ run: runWith() }));
    assert.ok((vm.tokens.hitRatio as number) > 0.8);
    assert.equal(vm.alerts.some((a) => a.id === "H-1"), false);
  });
});

describe("derive: prefix stability (H-2)", () => {
  it("raises H-2 when the last call's tool-schema hash changed", () => {
    const vm = derive(
      baseSnapshot({ run: runWith({ lastCall: lastCall({ prefixChanged: true }) }) }),
    );
    const alert = vm.alerts.find((a) => a.id === "H-2");
    assert.ok(alert);
    assert.equal(alert.severity, "warn");
    assert.match(alert.message, /prefix hash changed/);
  });

  it("does not raise H-2 when the hash is stable or unmeasured", () => {
    const stable = derive(baseSnapshot({ run: runWith({ lastCall: lastCall({ prefixChanged: false }) }) }));
    assert.equal(stable.alerts.some((a) => a.id === "H-2"), false);
    const none = derive(baseSnapshot({ run: runWith({ lastCall: null }) }));
    assert.equal(none.alerts.some((a) => a.id === "H-2"), false);
  });
});
