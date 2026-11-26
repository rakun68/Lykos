import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "../theme/resolve.js";
import type { ViewModel } from "../types.js";
import { renderStderrLine } from "./stderr.js";
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

const baseVm: ViewModel = {
  cost: { runUsd: 0.0384, todayUsd: null, capRunUsd: 0.5, capDayUsd: 2.0, onExceed: "stop" },
  tokens: {
    counters: { fresh: 42100, cacheRead: 38400, cacheWrite: 2100, output: 3800, reasoning: 0 },
    hitRatio: 0.91,
    calls: 6,
  },
  context: { parent: null, delegate: null },
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
};

describe("renderStderrLine (S2) — one line, triad only", () => {
  it("shows fresh/output tokens, cache hit ratio, and cost", () => {
    const line = renderStderrLine(baseVm, { theme: monoTheme });
    assert.equal(line.split("\n").length, 1);
    assert.match(line, /↑42\.1k/);
    assert.match(line, /↓3\.8k/);
    assert.match(line, /⚡38\.4k cached \(91%\)/);
    assert.match(line, /\$0\.038/);
  });

  it("appends elapsed time when provided", () => {
    const line = renderStderrLine(baseVm, { theme: monoTheme, elapsedMs: 161000 });
    assert.match(line, /2m 41s/);
  });

  it("appends the highest-severity alert", () => {
    const line = renderStderrLine(
      { ...baseVm, alerts: [{ id: "H-5", severity: "danger", message: "cap", remedy: "stop" }] },
      { theme: monoTheme },
    );
    assert.match(line, new RegExp(`${WARN}H-5`));
  });

  it("emits no unicode glyphs under the ascii glyph set (LYKOS_ASCII=1)", () => {
    const line = renderStderrLine(
      { ...baseVm, alerts: [{ id: "H-5", severity: "danger", message: "cap", remedy: "stop" }] },
      { theme: monoAsciiTheme },
    );
    for (const unicodeGlyph of ["◆", "↑", "↓", "⚡", "✎", "✓", "⚠", "\uFE0E"]) {
      assert.ok(!line.includes(unicodeGlyph), `expected no "${unicodeGlyph}" in ascii-mode output: ${line}`);
    }
    assert.match(line, /\*/); // diamond -> "*"
    assert.match(line, /!H-5/); // warnGlyph -> "!"
  });
});
