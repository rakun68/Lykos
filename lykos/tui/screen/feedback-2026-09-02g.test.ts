// The eighth 2026-09-02 UI feedback round — two numbered items, asserted
// in the maintainer's own order and named by their number, the same
// discipline as every round before this one.

import { newRetryObservation } from "../../loop/retry-observer.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StandaloneSessionState } from "../../session/session.js";
import { LineEditor } from "../editor.js";
import { renderScreenBlock, toScrollbackBlock, type TurnStatsView } from "./blocks.js";
import { createFullscreenAgentUi } from "./fullscreen-ui.js";
import { ScreenPipeline } from "./pipeline.js";
import { resolveTheme } from "../theme/resolve.js";
import { fmtDuration } from "../format.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

describe("item 1: pasted text with line endings does not garble the composer", () => {
  it("CRLF is normalised to a real line break — no stray \\r left in the buffer", () => {
    const ed = new LineEditor();
    ed.insertText("first line\r\nsecond line\r\nthird line");
    assert.deepEqual([...ed.state.lines], ["first line", "second line", "third line"]);
    for (const line of ed.state.lines) assert.doesNotMatch(line, /\r/);
  });

  it("a bare CR (old Mac line endings) is treated as a line break too, not inserted as a literal control byte", () => {
    const ed = new LineEditor();
    ed.insertText("alpha\rbeta\rgamma");
    assert.deepEqual([...ed.state.lines], ["alpha", "beta", "gamma"]);
  });

  it("Windows clipboard's own Get-Clipboard -Raw shape (CRLF-terminated, trailing CRLF) round-trips cleanly", () => {
    const ed = new LineEditor();
    ed.insertText("one\r\ntwo\r\nthree\r\n");
    assert.deepEqual([...ed.state.lines], ["one", "two", "three", ""]);
  });

  it("a lone \\n paste is completely unaffected — this is a normalisation, not a behaviour change for the common case", () => {
    const ed = new LineEditor();
    ed.insertText("a\nb\nc");
    assert.deepEqual([...ed.state.lines], ["a", "b", "c"]);
  });

  it("pasting mid-line splices correctly around the cursor with CRLF content, same as it already did for LF", () => {
    const ed = new LineEditor();
    ed.insertText("beforeafter");
    ed.moveTo(0, "before".length);
    ed.insertText("X\r\nY");
    assert.deepEqual([...ed.state.lines], ["beforeX", "Yafter"]);
  });

  it("the cursor lands after the LAST inserted character, on the last real line — not shifted by a phantom \\r row", () => {
    const ed = new LineEditor();
    ed.insertText("x\r\ny\r\nz");
    assert.equal(ed.state.cursorRow, 2);
    assert.equal(ed.state.cursorCol, 1);
  });

  it("a single-line paste with no line ending at all is untouched (the fast path)", () => {
    const ed = new LineEditor();
    ed.insertText("no newlines here");
    assert.deepEqual([...ed.state.lines], ["no newlines here"]);
  });
});

describe("item 2: a per-turn stats line follows every completed message", () => {
  function freshState(overrides: Partial<StandaloneSessionState["usage"]> = {}): StandaloneSessionState {
    return {
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheWrite1h: 0,
        reasoning: 0,
        nestedInput: 0,
        nestedOutput: 0,
        nestedCacheRead: 0,
        nestedCacheWrite: 0,
        calls: [],
        ...overrides,
      },
      toolCalls: [],
      turns: 0,
      lastText: "",
      humanInterventions: 0,
  retry: newRetryObservation(),
    } as StandaloneSessionState;
  }

  function header() {
    return { product: "LYKOS", version: "0", model: "m", cwd: "/w", branch: null, sessionId: "s", executionShape: "standalone" };
  }

  it("renders duration, cost, all four token counts and the context gauge — never combining cache read and write", () => {
    const stats: TurnStatsView = {
      elapsedSeconds: 12.4,
      costUsd: 0.0031,
      tokens: { input: 1200, output: 340, cacheRead: 5000, cacheWrite: 800 },
      context: { usedTokens: 28800, totalTokens: 64000, pct: 0.45 },
    };
    const [line] = renderScreenBlock({ id: "s", kind: "stats", stats }, { width: 100, theme: mono });
    assert.match(line!, /12\.4s/);
    assert.match(line!, /\$0\.003/);
    assert.match(line!, /1\.2k/, "input tokens shown");
    assert.match(line!, /340/, "output tokens shown");
    assert.match(line!, /5\.0k/, "cache read shown as its own number");
    assert.match(line!, /800/, "cache write shown as its own number");
    assert.match(line!, /28\.8k/);
    assert.match(line!, /64\.0k/);
  });

  it("a blank row separates the agent's reply from the stats line below it — the same trailing-blank convention every block kind rides", () => {
    const stats: TurnStatsView = { elapsedSeconds: 1, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, context: null };
    const replyLines = toScrollbackBlock({ id: "reply", kind: "speech", text: "the answer" }, mono).render(60);
    const statsLines = toScrollbackBlock({ id: "stats", kind: "stats", stats }, mono).render(60);
    // What the scrollback actually concatenates, per `Scrollback.allLines()`.
    const combined = [...replyLines, ...statsLines];
    const replyIdx = combined.findIndex((l) => l.includes("the answer"));
    const statsIdx = combined.findIndex((l) => l.includes("1.0s"));
    assert.ok(replyIdx >= 0 && statsIdx > replyIdx + 1, "at least one row must sit between them");
    // The blank row immediately above the stats line is the separator this
    // item is about. Round thirteen, item 3 added one more row to a
    // finished answer — its click-to-copy hint — which belongs to the
    // answer block and sits above that blank, so "everything between is
    // blank" became "the separator is still there, and the only other
    // thing between them is the answer's own hint".
    assert.equal(combined[statsIdx - 1], "", "the stats line has lost its blank separator");
    for (let i = replyIdx + 1; i < statsIdx - 1; i++) {
      assert.ok(combined[i] === "" || combined[i]!.includes("click to copy"), `row ${i} ("${combined[i]}") is neither blank nor the answer's copy hint`);
    }
  });

  it("no context window known yet falls back to the plain `ctx ?`, same as the footer", () => {
    const stats: TurnStatsView = { elapsedSeconds: 1, costUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, context: null };
    const [line] = renderScreenBlock({ id: "s", kind: "stats", stats }, { width: 100, theme: mono });
    assert.match(line!, /ctx \?/);
  });

  it("fmtDuration: sub-minute keeps a decimal, a minute or more switches to m/s", () => {
    assert.equal(fmtDuration(0.4), "0.4s");
    assert.equal(fmtDuration(12.4), "12.4s");
    assert.equal(fmtDuration(59.9), "59.9s");
    assert.equal(fmtDuration(60), "1m 0s");
    assert.equal(fmtDuration(90), "1m 30s");
  });

  it("end to end: a stats block is pushed at endTurn(), with deltas measured from writeUser to endTurn — not the session's running total", () => {
    let out = "";
    const pipeline = new ScreenPipeline({
      width: 120,
      height: 20,
      theme: color,
      header: header(),
      sink: { write: (t: string) => void (out += t) },
    });
    const state = freshState({
      input: 500,
      output: 100,
      cacheRead: 2000,
      cacheWrite: 100,
      calls: [{ hop: "direct", source: "assistant_message", provider: "p", model: "m", costUsd: 0.005, ts: Date.now() }],
    });
    const ui = createFullscreenAgentUi({
      pipeline,
      header: header(),
      ledgerPath: ":memory:",
      config: { budget: {}, providers: {} } as never,
      startedUtc: new Date().toISOString(),
      theme: color,
      live: () => ({ contextUsage: { tokens: 12000, contextWindow: 64000, percent: 18.75 /* Pi's 0-100 scale (D28) */ } }),
    });
    ui.attach({ subscribe: () => () => {} }, () => state);

    ui.writeUser("do a thing");
    // Simulate usage arriving during the turn.
    state.usage.input += 800;
    state.usage.output += 250;
    state.usage.cacheRead += 6000;
    state.usage.cacheWrite += 400;
    state.usage.calls.push({ hop: "direct", source: "assistant_message", provider: "p", model: "m", costUsd: 0.0025, ts: Date.now() });

    out = "";
    ui.endTurn!();
    pipeline.flush();
    const printed = stripAnsi(out);
    // Only the DELTA since writeUser, not the pre-existing 500/100/2000/100/0.005 baseline.
    assert.match(printed, /800/);
    assert.match(printed, /250/);
    assert.match(printed, /6\.0k/);
    assert.match(printed, /400/);
    assert.match(printed, /\$0\.002/, "the turn's own $0.0025, not the session total of $0.0075");
    assert.match(printed, /18\.75%|19%|18%/, "the context percent Pi reported at endTurn");
  });

  it("a turn that produces nothing visible still gets a (zeroed) stats line via the endTurn safety net", () => {
    let out = "";
    const pipeline = new ScreenPipeline({
      width: 120,
      height: 20,
      theme: mono,
      header: header(),
      sink: { write: (t: string) => void (out += t) },
    });
    const state = freshState();
    const ui = createFullscreenAgentUi({
      pipeline,
      header: header(),
      ledgerPath: ":memory:",
      config: { budget: {}, providers: {} } as never,
      startedUtc: new Date().toISOString(),
      theme: mono,
    });
    ui.attach({ subscribe: () => () => {} }, () => state);
    ui.writeUser("abort me immediately");
    out = "";
    ui.endTurn!();
    pipeline.flush();
    assert.match(stripAnsi(out), /0\.0s|0s/);
  });

  it("a steer mid-turn does not reset the stopwatch or the usage baseline — the stats cover the whole turn, steers included", () => {
    let out = "";
    const pipeline = new ScreenPipeline({
      width: 120,
      height: 20,
      theme: mono,
      header: header(),
      sink: { write: (t: string) => void (out += t) },
    });
    const state = freshState({ input: 100 });
    const ui = createFullscreenAgentUi({
      pipeline,
      header: header(),
      ledgerPath: ":memory:",
      config: { budget: {}, providers: {} } as never,
      startedUtc: new Date().toISOString(),
      theme: mono,
    });
    ui.attach({ subscribe: () => () => {} }, () => state);

    ui.writeUser("first prompt");
    state.usage.input += 50;
    ui.writeUser("a steer while it's running"); // must NOT re-baseline
    state.usage.input += 70;

    out = "";
    ui.endTurn!();
    pipeline.flush();
    // 50 + 70 = 120 total input added since the FIRST writeUser.
    assert.match(stripAnsi(out), /120/);
  });

  it("without attach() ever being called, endTurn() is a no-op for stats — no crash, no stray block", () => {
    let out = "";
    const pipeline = new ScreenPipeline({
      width: 120,
      height: 20,
      theme: mono,
      header: header(),
      sink: { write: (t: string) => void (out += t) },
    });
    const ui = createFullscreenAgentUi({
      pipeline,
      header: header(),
      ledgerPath: ":memory:",
      config: { budget: {}, providers: {} } as never,
      startedUtc: new Date().toISOString(),
      theme: mono,
    });
    ui.writeUser("no attach happened");
    out = "";
    ui.endTurn!();
    pipeline.flush();
    assert.equal(out.includes("$"), false);
  });
});
