import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  budgetNotice,
  contextNoticeEnabledFromEnv,
  newContextBudgetState,
} from "./context-budget.js";

const WINDOW = 100_000;
const base = { contextWindow: WINDOW, compactionThreshold: 0.8 };

describe("budgetNotice", () => {
  it("says nothing well below the first band", () => {
    const s = newContextBudgetState();
    assert.equal(budgetNotice(s, { ...base, contextTokens: 10_000 }), undefined);
  });

  it("announces the first band once and then stays quiet", () => {
    const s = newContextBudgetState();
    const first = budgetNotice(s, { ...base, contextTokens: 71_000 });
    assert.ok(first?.includes("[lykos-context]"));
    assert.ok(first?.includes("71%"));
    assert.equal(budgetNotice(s, { ...base, contextTokens: 72_000 }), undefined);
    assert.equal(s.notices, 1);
  });

  it("names the consequence, not just the number", () => {
    const s = newContextBudgetState();
    const note = budgetNotice(s, { ...base, contextTokens: 71_000 });
    assert.ok(note?.includes("Compaction triggers at"));
    assert.ok(note?.includes("write it down now"));
  });

  it("announces the highest band crossed, not the lowest", () => {
    const s = newContextBudgetState();
    const note = budgetNotice(s, { ...base, contextTokens: 96_000 });
    assert.ok(note?.includes("96%"));
    // 70% and 85% are spent too, so nothing dribbles out afterwards.
    assert.equal(budgetNotice(s, { ...base, contextTokens: 97_000 }), undefined);
    assert.equal(s.notices, 1);
  });

  it("still climbs through the bands one at a time when growth is gradual", () => {
    const s = newContextBudgetState();
    assert.ok(budgetNotice(s, { ...base, contextTokens: 70_500 }));
    assert.ok(budgetNotice(s, { ...base, contextTokens: 86_000 }));
    assert.ok(budgetNotice(s, { ...base, contextTokens: 95_500 }));
    assert.equal(s.notices, 3);
  });

  it("says nothing at all when the window is unknown", () => {
    const s = newContextBudgetState();
    assert.equal(budgetNotice(s, { contextTokens: 90_000, contextWindow: undefined, compactionThreshold: 0.8 }), undefined);
    assert.equal(budgetNotice(s, { contextTokens: 90_000, contextWindow: 0, compactionThreshold: 0.8 }), undefined);
  });

  it("changes its wording once compaction is imminent rather than future", () => {
    const s = newContextBudgetState();
    const note = budgetNotice(s, { ...base, contextTokens: 96_000 });
    assert.ok(note?.includes("will run on the next call"));
  });

  it("never reports a negative remainder when the window is already exceeded", () => {
    const s = newContextBudgetState();
    const note = budgetNotice(s, { ...base, contextTokens: 120_000 });
    assert.ok(note?.includes("0 left"), "remaining is clamped at zero, never negative");
    assert.ok(!/-[\d,]+ from here/.test(note!), "no negative distance-to-compaction");
  });
});

describe("contextNoticeEnabledFromEnv", () => {
  it("is on unless explicitly disabled", () => {
    assert.equal(contextNoticeEnabledFromEnv({} as NodeJS.ProcessEnv), true);
    assert.equal(contextNoticeEnabledFromEnv({ LYKOS_CONTEXT_NOTICE: "0" } as NodeJS.ProcessEnv), false);
  });
});
