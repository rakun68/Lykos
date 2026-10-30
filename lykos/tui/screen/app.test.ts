import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderTriadLine } from "../renderers/line.js";
import { resolveTheme } from "../theme/resolve.js";
import type { ViewModel } from "../types.js";
import { renderApp, type AppState } from "./app.js";

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

function state(overrides: Partial<AppState> = {}): AppState {
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
    vm: vm(),
    footerVisible: true,
    viewportLines: ["hello", "world"],
    composerLines: ["> "],
    ...overrides,
  };
}

const SIZES = [
  { width: 200, height: 60 },
  { width: 120, height: 40 },
  { width: 80, height: 24 },
  { width: 40, height: 10 },
];

describe("T42: renderApp tiles the whole frame with no gap and no overlap", () => {
  for (const { width, height } of SIZES) {
    it(`${width}x${height}`, () => {
      const frame = renderApp(state(), { width, height, theme: mono });
      assert.equal(frame.width, width);
      assert.equal(frame.height, height);
      assert.equal(frame.lines.length, height);
    });
  }

  it("the footer row is byte-identical to renderTriadLine() over the same ViewModel", () => {
    const model = vm();
    const frame = renderApp(state({ vm: model, composerLines: ["> "] }), { width: 100, height: 24, theme: mono });
    const expected = renderTriadLine(model, { width: 100, theme: mono });
    assert.ok(frame.lines.includes(expected), "footer row present verbatim in the frame");
  });

  it("toggling the footer changes only the viewport/footer split, not header or composer", () => {
    const on = renderApp(state({ footerVisible: true }), { width: 100, height: 24, theme: mono });
    const off = renderApp(state({ footerVisible: false }), { width: 100, height: 24, theme: mono });
    assert.equal(on.lines[0], off.lines[0], "header row unchanged");
    // The composer is the LAST row only when the footer is hidden — since
    // the 2026-09-02 reorder the ledger triad sits underneath it.
    assert.equal(on.lines.at(-2), off.lines.at(-1), "composer row unchanged, one row higher");
    assert.equal(on.height, off.height);
  });

  it("2026-09-02: the ledger triad is the last row, under the composer's bottom rule", () => {
    const model = vm();
    const frame = renderApp(state({ vm: model }), { width: 100, height: 24, theme: mono });
    assert.equal(frame.lines.at(-1), renderTriadLine(model, { width: 100, theme: mono }));
    assert.equal(frame.lines.at(-2), "> ", "composer's prompt row sits directly above it");
  });

  it("2026-09-02: the status line gets its own row above the composer and displaces no viewport content", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line-${i}`);
    const idle = renderApp(state({ viewportLines: long }), { width: 100, height: 24, theme: mono });
    const busy = renderApp(state({ viewportLines: long, statusLine: "working" }), { width: 100, height: 24, theme: mono });
    const statusRow = busy.lines.indexOf("working");
    assert.ok(statusRow > 0, "status row present");
    assert.equal(busy.lines[statusRow + 1], "> ", "composer follows it");
    // Every viewport row the busy frame still shows is one the idle frame
    // showed too — the status line took a row from the viewport's height
    // rather than painting over a line of transcript.
    assert.deepEqual(busy.lines.slice(1, statusRow), idle.lines.slice(1, statusRow));
  });

  it("T48: a running turn grows the footer by the activity row, stacked above the triad", () => {
    const idle = renderApp(state(), { width: 100, height: 24, theme: mono });
    const running = renderApp(
      state({ activity: { running: true, startedAtMs: 0, nowMs: 3000, activeTools: ["Edit"] } }),
      { width: 100, height: 24, theme: mono },
    );
    const idleFooterLine = idle.lines.find((l) => l.includes(fmtRunUsd));
    const runningFooterIndex = running.lines.findIndex((l) => l.includes(fmtRunUsd));
    assert.ok(idleFooterLine);
    assert.ok(runningFooterIndex >= 0);
    assert.ok(running.lines[runningFooterIndex - 1]!.includes("Edit"), "activity row sits directly above the triad row");
    assert.equal(running.lines.at(-1), idle.lines.at(-1), "composer stays pinned to the bottom either way");
  });

  it("T48: activity is suppressed along with the rest of the footer when hidden", () => {
    const frame = renderApp(
      state({ footerVisible: false, activity: { running: true, startedAtMs: 0, nowMs: 1000, activeTools: ["Edit"] } }),
      { width: 100, height: 24, theme: mono },
    );
    assert.ok(!frame.lines.some((l) => l.includes("Edit")));
  });
});

const fmtRunUsd = "$0.038";
