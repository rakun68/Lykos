import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderTriadLine } from "../renderers/line.js";
import { resolveTheme } from "../theme/resolve.js";
import type { ViewModel } from "../types.js";
import { renderFooterLines } from "./footer.js";

const mono = resolveTheme("mono", "none", "unicode");

function vm(): ViewModel {
  return {
    cost: { runUsd: 0.038, todayUsd: 0.41, capRunUsd: 0.5, capDayUsd: 2.0, onExceed: "stop" },
    tokens: {
      counters: { fresh: 42100, cacheRead: 38400, cacheWrite: 2100, output: 3800, reasoning: 0 },
      hitRatio: 0.91,
      calls: 4,
    },
    context: { parent: null, delegate: { usedTokens: 12000, totalTokens: 64000, pct: 0.19 } },
    outcome: null,
    alerts: [],
    session: {
      id: "s1",
      brief: null,
      agent: null,
      model: null,
      phase: null,
      startedUtc: null,
      endedUtc: null,
      heartbeatUtc: null,
      elapsedSec: null,
      thinkingLevel: null,
    },
    health: { toolSchemaTokens: null, toolCount: null, prefixChanged: false },
    children: [],
  };
}

describe("T42.3: the footer is renderTriadLine over the shared ViewModel", () => {
  it("emits exactly one line, byte-identical to renderTriadLine()", () => {
    const model = vm();
    const lines = renderFooterLines(model, mono, 100, true);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], renderTriadLine(model, { width: 100, theme: mono }));
  });

  it("no session yet — zero rows, not a blank one", () => {
    assert.deepEqual(renderFooterLines(null, mono, 100, true), []);
  });

  it("T42.4: hidden — zero rows even with a live session", () => {
    assert.deepEqual(renderFooterLines(vm(), mono, 100, false), []);
  });
});
