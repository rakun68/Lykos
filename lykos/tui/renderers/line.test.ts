import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "../theme/resolve.js";
import type { ViewModel } from "../types.js";
import { renderTriadLine } from "./line.js";
import { GLYPHS } from "../theme/types.js";

// The unicode glyph set carries a trailing VS15 on the three glyphs that
// have an emoji presentation (theme/types.ts's TEXT_PRESENTATION) — assert
// against the glyph set rather than a literal, so a presentation change is
// a one-line edit there and not a test rewrite here.
const WARN = GLYPHS.unicode.warnGlyph;
const CHECK = GLYPHS.unicode.check;
const WRITE = GLYPHS.unicode.write;

const monoTheme = resolveTheme("mono", "none", "unicode");
const monoAsciiTheme = resolveTheme("mono", "none", "ascii");

function vm(overrides: Partial<ViewModel> = {}): ViewModel {
  return {
    cost: { runUsd: 0.038, todayUsd: 0.41, capRunUsd: 0.5, capDayUsd: 2.0, onExceed: "stop" },
    tokens: {
      counters: { fresh: 42100, cacheRead: 38400, cacheWrite: 2100, output: 3800, reasoning: 0 },
      hitRatio: 0.91,
      calls: 4,
    },
    context: { parent: { usedTokens: 116000, totalTokens: 200000, pct: 0.58 }, delegate: null },
    outcome: null,
    alerts: [],
    session: {
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
    },
    health: { toolSchemaTokens: null, toolCount: null, prefixChanged: false },
    children: [],
    ...overrides,
  };
}

describe("renderTriadLine — degradation ladder never wraps or drops mid-number", () => {
  it("< 40: cost and highest alert only", () => {
    const line = renderTriadLine(vm({ alerts: [{ id: "H-6", severity: "warn", message: "x", remedy: "y" }] }), {
      width: 35,
      theme: monoTheme,
    });
    assert.equal(line, `$0.038 ${WARN} H-6`);
  });

  it("40-59: hard-compact single line with ctx and hit ratio", () => {
    const line = renderTriadLine(vm(), { width: 50, theme: monoTheme });
    assert.equal(line, "58%ctx ⚡91% $0.038");
  });

  it("60-79: triad only, one line", () => {
    const line = renderTriadLine(vm(), { width: 70, theme: monoTheme });
    assert.equal(line, "⚡91% ↑42.1k ↓3.8k │ ctx 58% │ $0.038");
  });

  it("80+: full triad with cache write shown separately from fresh input", () => {
    const line = renderTriadLine(vm(), { width: 100, theme: monoTheme });
    assert.match(line, /↑42\.1k/);
    assert.match(line, new RegExp(`${WRITE} 2\\.1k`));
    assert.match(line, /↓3\.8k/);
    assert.match(line, /⚡91%/);
  });

  it("never renders a bare cost segment when nothing else fits and cost is absent", () => {
    const line = renderTriadLine(vm({ alerts: [] }), { width: 30, theme: monoTheme });
    assert.equal(line, "$0.038");
  });

  it("emits no unicode glyphs at 80+ under the ascii glyph set", () => {
    const line = renderTriadLine(vm(), { width: 100, theme: monoAsciiTheme });
    for (const unicodeGlyph of ["█", "░", "↑", "↓", "⚡", "✎", "│", "\uFE0E"]) {
      assert.ok(!line.includes(unicodeGlyph), `expected no "${unicodeGlyph}" in ascii-mode output: ${line}`);
    }
    assert.match(line, /~ 2\.1k/); // cache-write glyph -> "~"
  });
});
