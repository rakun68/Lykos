import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "../theme/resolve.js";
import type { ViewModel } from "../types.js";
import { renderStatusline } from "./statusline.js";

const monoTheme = resolveTheme("mono", "none", "unicode");
const monoAsciiTheme = resolveTheme("mono", "none", "ascii");

const emptySession = {
  id: null,
  brief: null,
  agent: null,
  model: null,
  phase: null,
  startedUtc: null,
  endedUtc: null,
  heartbeatUtc: null,
  elapsedSec: null,
  thinkingLevel: null,
} as const;
const emptyHealth = { toolSchemaTokens: null, toolCount: null, prefixChanged: false } as const;

function vm(overrides: Partial<ViewModel> = {}): ViewModel {
  return {
    cost: { runUsd: 0.412, todayUsd: 0.41, capRunUsd: 0.5, capDayUsd: 2.0, onExceed: "stop" },
    tokens: {
      counters: { fresh: 31200, cacheRead: 28400, cacheWrite: 0, output: 400, reasoning: 0 },
      hitRatio: 0.91,
      calls: 2,
    },
    context: { parent: { usedTokens: 116000, totalTokens: 200000, pct: 0.58 }, delegate: null },
    outcome: null,
    alerts: [],
    session: { ...emptySession },
    health: { ...emptyHealth },
    children: [],
    ...overrides,
  };
}

describe("renderStatusline (S1)", () => {
  it("renders only the parent line when no delegate has run yet", () => {
    const line = renderStatusline(vm(), {
      width: 100,
      theme: monoTheme,
      meta: { parentModelName: "opus-5", delegateModelName: null, delegateCalls: 0 },
    });
    assert.equal(line.split("\n").length, 1);
    assert.match(line, /opus-5/);
    assert.match(line, /\$0\.412/);
  });

  it("adds the delegate line — the thesis line — once a delegate has run", () => {
    const line = renderStatusline(vm(), {
      width: 100,
      theme: monoTheme,
      meta: { parentModelName: "opus-5", delegateModelName: "ds-v4-flash", delegateCalls: 2 },
    });
    const lines = line.split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[1]!, /ds-v4-flash ×2/);
    assert.match(lines[1]!, /↑31\.2k/);
    assert.match(lines[1]!, /⚡28\.4k 91%/);
    assert.match(lines[1]!, /↓400/);
  });

  it("drops the context gauge below 60 columns", () => {
    const line = renderStatusline(vm(), {
      width: 50,
      theme: monoTheme,
      meta: { parentModelName: "opus-5", delegateModelName: null, delegateCalls: 0 },
    });
    assert.doesNotMatch(line, /ctx/);
  });

  it("emits no unicode glyphs under the ascii glyph set", () => {
    const line = renderStatusline(vm(), {
      width: 100,
      theme: monoAsciiTheme,
      meta: { parentModelName: "opus-5", delegateModelName: "ds-v4-flash", delegateCalls: 2 },
    });
    for (const unicodeGlyph of ["◆", "└", "↑", "↓", "⚡", "│", "█", "░"]) {
      assert.ok(!line.includes(unicodeGlyph), `expected no "${unicodeGlyph}" in ascii-mode output: ${line}`);
    }
  });

  it("never renders an avoided figure", () => {
    const line = renderStatusline(vm(), {
      width: 120,
      theme: monoTheme,
      meta: { parentModelName: "opus-5", delegateModelName: "ds-v4-flash", delegateCalls: 1 },
    });
    assert.doesNotMatch(line, /avoided/i);
    assert.doesNotMatch(line, /~\$/);
  });
});
