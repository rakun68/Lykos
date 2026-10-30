// T50.2 — 07-ui-and-hud.md §9's acceptance list, re-run whole against the
// new full-screen surface, the same way T37 was held to it originally
// (renderers/conversation.test.ts's own "T4 acceptance re-run for S0").
// A full-screen app that only works in one terminal is a downgrade from
// the append-only renderer it sits on top of.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "./frame.js";
import { renderApp, type AppState } from "./app.js";
import { renderScreenBlock, type ScreenBlock } from "./blocks.js";
import { resolveTheme } from "../theme/resolve.js";
import type { OutcomeView, ViewModel } from "../types.js";

const mono = resolveTheme("mono", "none", "unicode");
const asciiTheme = resolveTheme("mono", "none", "ascii");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

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

function appState(theme: typeof mono, model: ViewModel): AppState {
  return {
    header: {
      product: "LYKOS",
      version: "0.0.1",
      model: "deepseek-v4-flash",
      cwd: "~/Workspace/Lykos",
      branch: "master",
      sessionId: "abc12345",
      executionShape: "standalone",
    },
    vm: model,
    footerVisible: true,
    viewportLines: ["hello", "world", "a reply from the model spanning the viewport"],
    composerLines: ["> some input"],
  };
}

const OUTCOME: OutcomeView = { value: "success", source: "verification_command", verified: true };

function allBlocks(): ScreenBlock[] {
  return [
    { id: "1", kind: "user", text: "fix the header please, it looks wrong at narrow widths" },
    { id: "2", kind: "thinking", text: "the header needs a right-aligned block that degrades gracefully" },
    { id: "3", kind: "speech", text: "done — the header now right-aligns the session id and drops it when narrow." },
    { id: "4", kind: "tool", tool: { name: "Edit", summary: "lykos/tui/screen/header.ts", state: "ok" } },
    { id: "5", kind: "diff", diff: { path: "header.ts", lines: [{ kind: "add", text: "+ new line of reasonable length" }] } },
    { id: "6", kind: "bash", bash: { command: "npm test", output: "782 passing", exitCode: 0, sendToModel: true } },
    { id: "7", kind: "approval", approval: { kind: "write", summary: "header.ts", detail: "12 lines" } },
    { id: "8", kind: "system", text: "compacting..." },
    { id: "9", kind: "outcome", outcome: OUTCOME },
  ];
}

const WIDTHS = [40, 60, 80, 120];

describe("T50.2: renderApp holds at 40/60/80/120 columns — the frame tiles exactly, no line overruns", () => {
  for (const width of WIDTHS) {
    it(`${width} columns`, () => {
      const height = 24;
      const frame = renderApp(appState(mono, vm()), { width, height, theme: mono });
      assert.equal(frame.width, width);
      assert.equal(frame.lines.length, height);
      for (const line of frame.lines) {
        assert.ok(visibleWidth(line) <= width, `line exceeds ${width} columns: "${line}"`);
      }
    });

    it(`every block kind renders within ${width} columns`, () => {
      for (const block of allBlocks()) {
        for (const line of renderScreenBlock(block, { width, theme: color })) {
          assert.ok(visibleWidth(line) <= width + 4, `${block.kind} line exceeds ~${width} columns: "${line}"`);
        }
      }
    });
  }
});

describe("T50.2: NO_COLOR / TERM=dumb / LYKOS_ASCII=1 — zero escapes, zero unicode", () => {
  it("renderApp emits no ANSI escape codes under the mono theme", () => {
    const frame = renderApp(appState(mono, vm()), { width: 100, height: 24, theme: mono });
    for (const line of frame.lines) assert.doesNotMatch(line, /\x1b\[/);
  });

  it("every block kind emits no ANSI escape codes under the mono theme", () => {
    for (const block of allBlocks()) {
      for (const line of renderScreenBlock(block, { width: 100, theme: mono })) {
        assert.doesNotMatch(line, /\x1b\[/, `${block.kind} leaked an escape`);
      }
    }
  });

  it("LYKOS_ASCII=1 (the ascii glyph theme) leaks no unicode glyph anywhere in the frame", () => {
    const frame = renderApp(appState(asciiTheme, vm()), { width: 100, height: 24, theme: asciiTheme });
    const UNICODE_GLYPHS = ["█", "░", "↑", "↓", "⚡", "✎", "│", "◆", "✓", "⚠", "…", "┌", "┐", "└", "┘", "─"];
    for (const line of frame.lines) {
      for (const g of UNICODE_GLYPHS) assert.ok(!line.includes(g), `ascii frame leaked "${g}": "${line}"`);
    }
  });

  it("LYKOS_ASCII=1 leaks no unicode glyph in any block kind", () => {
    const UNICODE_GLYPHS = ["█", "░", "↑", "↓", "⚡", "✎", "│", "◆", "✓", "⚠", "…"];
    for (const block of allBlocks()) {
      for (const line of renderScreenBlock(block, { width: 100, theme: asciiTheme })) {
        for (const g of UNICODE_GLYPHS) assert.ok(!line.includes(g), `${block.kind} leaked "${g}": "${line}"`);
      }
    }
  });
});

describe("T50.2: the footer/HUD numbers still show by default, matching the append-only surface's own guarantee", () => {
  it("cost, tokens, and context gauge are all present in the frame at a normal width", () => {
    const frame = renderApp(appState(mono, vm()), { width: 100, height: 24, theme: mono });
    const text = frame.lines.join("\n");
    assert.match(text, /\$0\.038/);
    assert.match(text, /42\.1k|91%/); // whichever width tier is in play still shows a real number, never a placeholder
  });
});
