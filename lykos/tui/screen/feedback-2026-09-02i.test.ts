// The ninth 2026-09-02 UI feedback round, items 1, 3 and 4 — asserted by
// number, the same discipline as every round before this one. Item 2's
// markdown half lives in `feedback-2026-09-02h.test.ts`; this file covers
// everything mouse-click-shaped: `Scrollback`'s new `regionsFor`,
// `blocks.ts`'s `computeClickRegions`, `ScreenPipeline.actionAt()`, and
// both `RawApprovalGate` and `RawLineSource`'s new mouse-click branches.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApprovalRequest } from "../../gate/approval.js";
import { RawApprovalGate } from "./approval-modal.js";
import { RawLineSource, type ComposerGeometry } from "./raw-line-source.js";
import { ScreenPipeline } from "./pipeline.js";
import { renderScreenBlock, type TurnStatsView } from "./blocks.js";
import { COMPOSER_PREFIX_WIDTH } from "./composer.js";
import type { ClickAction } from "./scrollback.js";
import { resolveTheme } from "../theme/resolve.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function req(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { kind: "bash", summary: "run command", detail: "npm install", ...overrides };
}

function header() {
  return { product: "LYKOS", version: "0", model: "m", cwd: "/w", branch: null, sessionId: "s", executionShape: "standalone" };
}

describe("item 1: the per-message stats line no longer overlaps the pencil glyph with a digit", () => {
  it("a space separates the cache-write glyph from its number, same fix round four gave the footer", () => {
    const stats: TurnStatsView = { elapsedSeconds: 1, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, context: null };
    const [line] = renderScreenBlock({ id: "s", kind: "stats", stats }, { width: 100, theme: color });
    const plain = stripAnsi(line!);
    // `g.write` carries a trailing variation selector (round four's own
    // East-Asian-Ambiguous fix) — match on "not immediately followed by a
    // digit" rather than the exact glyph bytes.
    assert.doesNotMatch(plain, /✎︎?0/, `pencil glyph touches the digit with no space, in "${plain}"`);
    assert.match(plain, /✎︎? 0/, `expected a space before the number, got "${plain}"`);
  });
});

describe("item 3: an approval's y/n/a/Esc pills are clickable", () => {
  it("ScreenPipeline.actionAt() resolves a click on the pill row to the right decision, for all four pills", () => {
    const pipeline = new ScreenPipeline({ width: 60, height: 20, theme: mono, header: header(), sink: { write: () => {} } });
    pipeline.pushBlock({ id: "a1", kind: "approval", approval: { kind: "bash", summary: "run", detail: "ls" } });
    pipeline.flush();
    let found: { y?: ClickAction; n?: ClickAction; a?: ClickAction; esc?: ClickAction } = {};
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 60; c++) {
        const action = pipeline.actionAt(r, c);
        if (action?.kind !== "approvalKey") continue;
        if (action.key === "y") found.y = action;
        if (action.key === "n") found.n = action;
        if (action.key === "a") found.a = action;
        if (action.key === "escape") found.esc = action;
      }
    }
    assert.deepEqual(found.y, { kind: "approvalKey", key: "y", decision: "allow" });
    assert.deepEqual(found.n, { kind: "approvalKey", key: "n", decision: "deny" });
    assert.deepEqual(found.a, { kind: "approvalKey", key: "a", decision: "allow-always" });
    assert.deepEqual(found.esc, { kind: "approvalKey", key: "escape", decision: "deny" });
  });

  it("a click resolved to an approvalKey action actually decides the pending request, through RawApprovalGate's own mouse handling", async () => {
    let rendered: { decision?: string } = {};
    const gate = new RawApprovalGate({
      onRender: (_id, view) => (rendered = { ...(view.decision !== undefined ? { decision: view.decision } : {}) }),
      resolveClick: () => ({ kind: "approvalKey", key: "y", decision: "allow" }),
    });
    const pending = gate.request(req());
    gate.feedBytes("\x1b[<0;5;5M"); // SGR left-button-down at some row/col — resolveClick ignores the coordinates in this test
    assert.equal(await pending, "allow");
    assert.equal(rendered.decision, "allow");
  });

  it("mouse-driven decisions go through the SAME debounce guard as keyboard ones — a rapid double click cannot double-fire", async () => {
    let now = 1000;
    const gate = new RawApprovalGate({ onRender: () => {}, now: () => now, resolveClick: () => ({ kind: "approvalKey", key: "y", decision: "allow" }) });
    const pA = gate.request(req());
    const pB = gate.request(req());
    gate.feedBytes("\x1b[<0;5;5M");
    assert.equal(await pA, "allow");
    now += 30; // well inside the guard window
    gate.feedBytes("\x1b[<0;5;5M"); // a second click, as if the user's hand hadn't lifted
    assert.equal(gate.isOpen, true, "the second approval must still be waiting");
    now += 1000;
    gate.feedBytes("\x1b[<0;5;5M");
    assert.equal(await pB, "allow");
  });

  it("a click that resolves to something OTHER than an approvalKey (a fold hint above the prompt) bubbles up via onAction instead of being applied to the pending request", () => {
    const seen: ClickAction[] = [];
    const gate = new RawApprovalGate({ onRender: () => {}, resolveClick: () => ({ kind: "toggleVerbose" }), onAction: (a) => seen.push(a) });
    void gate.request(req());
    gate.feedBytes("\x1b[<0;5;5M");
    assert.deepEqual(seen, [{ kind: "toggleVerbose" }]);
    assert.equal(gate.isOpen, true, "the pending approval is untouched by an unrelated click");
  });

  it("right/middle clicks are ignored, matching the composer's own left-button-only rule", async () => {
    let calls = 0;
    const gate = new RawApprovalGate({ onRender: () => {}, resolveClick: () => (calls++, { kind: "approvalKey", key: "y", decision: "allow" }) });
    void gate.request(req());
    gate.feedBytes("\x1b[<2;5;5M"); // button 2 (right)
    assert.equal(calls, 0);
  });
});

describe("item 3: a folded diff/bash message's expand hint is clickable", () => {
  it("clicking anywhere on the fold-hint line resolves to toggleVerbose", () => {
    const pipeline = new ScreenPipeline({ width: 40, height: 60, theme: mono, header: header(), sink: { write: () => {} } });
    const lines = Array.from({ length: 50 }, (_, i) => ({ kind: "ctx" as const, text: `line ${i}` }));
    pipeline.pushBlock({ id: "d1", kind: "diff", diff: { path: "a.ts", lines } });
    pipeline.flush();
    let hits = 0;
    for (let r = 0; r < 60; r++) {
      for (let c = 0; c < 40; c++) {
        const action = pipeline.actionAt(r, c);
        if (action?.kind === "toggleVerbose") hits += 1;
      }
    }
    assert.ok(hits > 0, "expected at least one clickable column on the fold-hint row");
  });

  it("a decided approval's body is unaffected — clicking near its own (now-collapsed) reply shows nothing clickable from the pill scan", () => {
    const pipeline = new ScreenPipeline({ width: 60, height: 20, theme: mono, header: header(), sink: { write: () => {} } });
    pipeline.pushBlock({ id: "a1", kind: "approval", approval: { kind: "bash", summary: "run", detail: "ls", decision: "allow" } });
    pipeline.flush();
    for (let r = 0; r < 20; r++) {
      for (let c = 0; c < 60; c++) {
        const action = pipeline.actionAt(r, c);
        assert.notEqual(action?.kind, "approvalKey", "a decided block must never offer a pill click");
      }
    }
  });
});

describe("item 3: a rendered link's [n] marker is clickable and opens the right url", () => {
  it("ScreenPipeline.actionAt() resolves the marker to an openLink action carrying the correct url", () => {
    const pipeline = new ScreenPipeline({ width: 60, height: 10, theme: color, header: header(), sink: { write: () => {} } });
    pipeline.pushBlock({ id: "s1", kind: "speech", text: "see [the docs](https://example.com/docs) now" });
    pipeline.flush();
    let found: ClickAction | null = null;
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 60; c++) {
        const action = pipeline.actionAt(r, c);
        if (action?.kind === "openLink") found = action;
      }
    }
    assert.deepEqual(found, { kind: "openLink", url: "https://example.com/docs" });
  });

  it("under the mono theme there is no [n] marker at all (links are not rendered specially there), so nothing is clickable", () => {
    const pipeline = new ScreenPipeline({ width: 60, height: 10, theme: mono, header: header(), sink: { write: () => {} } });
    pipeline.pushBlock({ id: "s1", kind: "speech", text: "see [the docs](https://example.com/docs) now" });
    pipeline.flush();
    for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 60; c++) {
        assert.notEqual(pipeline.actionAt(r, c)?.kind, "openLink");
      }
    }
  });
});

describe("item 4: clicking the footer shows the glossary", () => {
  it("any column of the footer row resolves to showLegend", () => {
    const pipeline = new ScreenPipeline({ width: 60, height: 20, theme: mono, header: header(), sink: { write: () => {} } });
    pipeline.setViewModel(null);
    pipeline.flush();
    const row = 19; // header(1) + viewport + footer(1) at height 20 — the last row
    let hits = 0;
    for (let c = 0; c < 60; c++) if (pipeline.actionAt(row, c)?.kind === "showLegend") hits += 1;
    assert.equal(hits, 60, "the whole footer row is clickable, not just part of it");
  });

  it("a viewport click never resolves to showLegend — the footer's own region is exclusive", () => {
    const pipeline = new ScreenPipeline({ width: 60, height: 20, theme: mono, header: header(), sink: { write: () => {} } });
    pipeline.pushBlock({ id: "s1", kind: "system", text: "hello" });
    pipeline.flush();
    assert.notEqual(pipeline.actionAt(2, 3)?.kind, "showLegend");
  });
});

describe("item 3: the tab-completion popup is clickable", () => {
  function source(): { src: RawLineSource; accepted: string[] } {
    const accepted: string[] = [];
    const src = new RawLineSource({
      completionRoot: "/project",
      completionGeometry: () => ({ firstRow: 5 }),
    });
    void accepted;
    return { src, accepted };
  }

  it("a click on a candidate row selects AND accepts it in one action", () => {
    const { src } = source();
    src.feedBytes("/co");
    assert.equal(src.completionActive, true, "precondition: the popup is open");
    // Candidate rows start at firstRow (5); click the SECOND row (row 6).
    src.feedBytes("\x1b[<0;10;7M"); // SGR down, col 10 (1-indexed -> 9), row 7 (1-indexed -> 6)
    assert.equal(src.completionActive, false, "accepting closes the popup");
    assert.ok(src.editorState.lines.join("").startsWith("/"), "some command text was inserted");
  });

  it("a click below the rendered candidates (on the legend/counter row) does nothing — no crash, no phantom accept", () => {
    const { src } = source();
    src.feedBytes("/co");
    const before = src.editorState.lines.join("\n");
    src.feedBytes("\x1b[<0;10;50M"); // far below the popup
    assert.equal(src.editorState.lines.join("\n"), before);
  });

  it("with no completion open, a click passes through to resolveClick instead — the popup branch does not swallow ordinary clicks", () => {
    let calls = 0;
    const src = new RawLineSource({
      completionGeometry: () => ({ firstRow: 5 }),
      resolveClick: () => (calls++, null),
    });
    src.feedBytes("\x1b[<0;10;7M");
    assert.equal(calls, 1);
  });
});

describe("item 3: a click outside the composer and popup resolves generically via resolveClick/onAction", () => {
  function composerGeom(): ComposerGeometry {
    return { firstBufferRow: 10, prefixWidth: COMPOSER_PREFIX_WIDTH, rowCount: 1 };
  }

  it("a click above the composer bubbles the resolved action through onAction", () => {
    const seen: ClickAction[] = [];
    const src = new RawLineSource({
      composerGeometry: composerGeom,
      resolveClick: (row, col) => (row === 2 && col === 3 ? { kind: "toggleVerbose" } : null),
      onAction: (a) => seen.push(a),
    });
    src.feedBytes("\x1b[<0;4;3M"); // 1-indexed col 4 -> 3, row 3 -> 2
    assert.deepEqual(seen, [{ kind: "toggleVerbose" }]);
  });

  it("a click that resolves to nothing calls onAction zero times", () => {
    const seen: ClickAction[] = [];
    const src = new RawLineSource({ composerGeometry: composerGeom, resolveClick: () => null, onAction: (a) => seen.push(a) });
    src.feedBytes("\x1b[<0;4;3M");
    assert.deepEqual(seen, []);
  });

  it("a click INSIDE the composer never reaches resolveClick — the composer still owns its own clicks exactly as before this round", () => {
    let calls = 0;
    const src = new RawLineSource({
      composerGeometry: composerGeom,
      resolveClick: () => (calls++, { kind: "toggleVerbose" }),
    });
    // firstBufferRow=10, so row 10 col within prefix width is inside the composer.
    src.feedBytes("\x1b[<0;3;11M"); // 1-indexed row 11 -> 10 (inside), col 3 -> 2
    assert.equal(calls, 0);
  });

  it("an in-progress drag that wanders outside the composer still extends the selection and does not also fire resolveClick", () => {
    let calls = 0;
    const src = new RawLineSource({
      composerGeometry: composerGeom,
      resolveClick: () => (calls++, null),
    });
    src.feedBytes("hello world");
    // Press inside the composer first.
    src.feedBytes("\x1b[<0;3;11M");
    // Drag far outside it.
    src.feedBytes("\x1b[<32;50;50M");
    assert.equal(calls, 0, "a drag never consults resolveClick, in or out of bounds");
  });
});
