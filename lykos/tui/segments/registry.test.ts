import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureBuiltinSegments, resetBuiltinSegmentsFlag } from "./builtin.js";
import {
  clearSegmentRegistry,
  listSegmentNames,
  parseFormat,
  renderFormat,
  validateFormat,
} from "./registry.js";
import { resolveTheme } from "../theme/resolve.js";
import type { ViewModel } from "../types.js";

const theme = resolveTheme("mono", "none", "unicode");

function vm(): ViewModel {
  return {
    cost: { runUsd: 0.038, todayUsd: null, capRunUsd: 0.5, capDayUsd: 2, onExceed: "stop" },
    tokens: {
      counters: { fresh: 1000, cacheRead: 9000, cacheWrite: 100, output: 200, reasoning: 0 },
      hitRatio: 0.9,
      calls: 2,
    },
    context: { parent: { usedTokens: 100, totalTokens: 200, pct: 0.5 }, delegate: null },
    outcome: null,
    alerts: [],
    session: {
      id: "s1",
      brief: "x",
      agent: "worker",
      model: "deepseek-v4-flash",
      phase: "implement",
      startedUtc: "2026-08-31T12:00:00Z",
      endedUtc: null,
      heartbeatUtc: "2026-08-31T12:01:00Z",
      elapsedSec: 60,
      thinkingLevel: null,
    },
    health: { toolSchemaTokens: 4200, toolCount: 8, prefixChanged: false },
    children: [],
  };
}

describe("segment registry", () => {
  it("parses literals and {names}, with brace escapes", () => {
    assert.deepEqual(parseFormat("a {cost} b"), [
      { kind: "literal", text: "a " },
      { kind: "segment", name: "cost" },
      { kind: "literal", text: " b" },
    ]);
    assert.deepEqual(parseFormat("{{cost}}"), [{ kind: "literal", text: "{cost}" }]);
  });

  it("rejects unknown segment names loudly", () => {
    ensureBuiltinSegments();
    assert.throws(() => validateFormat("{cost} {nope}"), /unknown segment "\{nope\}"/);
  });

  it("renders the default hud format", () => {
    ensureBuiltinSegments();
    const format = "{status} {tokens} | {context} | {cost}";
    validateFormat(format);
    const out = renderFormat(format, vm(), { theme, width: 100 });
    assert.match(out, /implement/);
    assert.match(out, /\$0\.038/);
    assert.match(out, /ctx/);
  });

  it("lists builtins after ensure", () => {
    clearSegmentRegistry();
    resetBuiltinSegmentsFlag();
    ensureBuiltinSegments();
    assert.ok(listSegmentNames().includes("cost"));
    assert.ok(listSegmentNames().includes("tokens"));
  });
});
