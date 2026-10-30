// The fifth 2026-09-02 UI feedback round — eleven numbered items, asserted
// in the same order and named by their number, the same discipline as
// every round before this one.
//
// Items 1, 8 and 10 turned out to be three symptoms of ONE cause —
// `RawApprovalGate`'s single-slot design being overwritten by a second
// concurrent `request()` call — and are tested together here rather than
// split three ways, since the fix (a real queue) is one change and the
// regression that matters is the end-to-end one: a second approval no
// longer orphans the first, and typing works again once every pending
// approval is actually decided. Item 11's full click-target support is
// deliberately NOT attempted this round — see its own note below and
// WISHLIST.md for why.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApprovalRequest } from "../../gate/approval.js";
import { RawApprovalGate, approvalViewFor } from "./approval-modal.js";
import { renderScreenBlock } from "./blocks.js";
import { renderComposer, COMPOSER_PREFIX_WIDTH } from "./composer.js";
import { renderMarkdownLines } from "./markdown.js";
import { renderTriadLine } from "../renderers/line.js";
import { LineEditor } from "../editor.js";
import { Scrollback, type ScrollbackBlock } from "./scrollback.js";
import { routeStdin, type RouterTimer, type StdinLike } from "./stdin-router.js";
import { RawLineSource } from "./raw-line-source.js";
import { resolveTheme } from "../theme/resolve.js";
import { SHIPPED_PALETTES } from "../theme/palettes.js";
import type { ViewModel } from "../types.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

/** A clock that advances one slow keystroke per read, so nothing a test emits looks like a paste burst to `routeStdin()`. */
function typingClock(): () => number {
  let t = 1_000;
  return () => (t += 100);
}

function req(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { kind: "bash", summary: "run command", detail: "npm install", ...overrides };
}

class FakeStdin implements StdinLike {
  private listeners: Array<(chunk: Buffer | string) => void> = [];
  on(_event: "data", listener: (chunk: Buffer | string) => void): void {
    this.listeners.push(listener);
  }
  off(_event: "data", listener: (chunk: Buffer | string) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  emit(chunk: string): void {
    for (const l of [...this.listeners]) l(chunk);
  }
}

const immediateTimer: RouterTimer = {
  setTimer: (fn) => {
    fn();
    return null;
  },
  clearTimer: () => {},
};

describe("items 1, 8 and 10: a second concurrent approval no longer orphans the first, and typing works again once every approval is decided", () => {
  it("a second request() while one is open queues instead of overwriting it — the first is still answerable", async () => {
    const rendered: Array<{ id: string; queued?: number; decision?: string }> = [];
    const gate = new RawApprovalGate({ onRender: (id, view) => rendered.push({ id, ...(view.queued !== undefined ? { queued: view.queued } : {}), ...(view.decision !== undefined ? { decision: view.decision } : {}) }) });

    const pA = gate.request(req({ detail: "npm run build | head -40" }));
    const pB = gate.request(req({ detail: "npm test -- docs/17-phase35-terminal-ui-tasks.md" }));

    // Exactly ONE is shown, and it names how many more are waiting — this
    // is the literal ask of item 8 ("single approval message showing at a
    // time with a small text below telling how many approval message more
    // are there").
    assert.equal(rendered.length, 2, "the first request renders once, and the second's arrival re-renders it with a queued count");
    assert.equal(rendered[0]!.id, rendered[1]!.id, "still the SAME block — the second request never got its own competing render");
    assert.equal(rendered[1]!.queued, 1);

    // Answering the VISIBLE prompt resolves A — not silently reattaching to
    // B, which is exactly what the old single-slot design did (B's
    // pendingResolve would have overwritten A's).
    gate.feedBytes("y");
    assert.equal(await pA, "allow", "the first request, the one actually shown, is what 'y' answers");

    // The queue advanced: B is now current and still unanswered — pB has
    // not resolved yet.
    assert.equal(gate.isOpen, true, "B is now showing, not silently skipped");
    let bSettled = false;
    void pB.then(() => (bSettled = true));
    await Promise.resolve();
    assert.equal(bSettled, false, "B has not been answered yet — it is not auto-approved just because A was");

    gate.feedBytes("n");
    assert.equal(await pB, "deny");
    assert.equal(gate.isOpen, false, "nothing left pending once both are decided");
  });

  it("a request queued three deep is never dropped — every one of them eventually resolves, in order", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const results: string[] = [];
    const promises = [gate.request(req({ detail: "cmd-a" })), gate.request(req({ detail: "cmd-b" })), gate.request(req({ detail: "cmd-c" }))];
    for (const p of promises) void p.then((d) => results.push(d));

    gate.feedBytes("y"); // cmd-a
    await promises[0];
    gate.feedBytes("n"); // cmd-b
    await promises[1];
    gate.feedBytes("a"); // cmd-c
    await promises[2];

    assert.deepEqual(results, ["allow", "deny", "allow-always"]);
  });

  it("close() denies EVERY pending request, current and queued alike — nothing is left hanging on session teardown", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const pA = gate.request(req());
    const pB = gate.request(req());
    const pC = gate.request(req());
    gate.close();
    assert.deepEqual(await Promise.all([pA, pB, pC]), ["deny", "deny", "deny"]);
  });

  it("end to end: with only ONE approval pending, routing gives stdin back to the composer the moment it is decided, and /verbose reaches it", async () => {
    const stdin = new FakeStdin();
    const gate = new RawApprovalGate({ onRender: () => {} });
    const submitted: string[] = [];
    const lineSource = new RawLineSource();
    const drain = async () => {
      for (;;) {
        const line = await Promise.race([lineSource.next(), Promise.resolve("__none__")]);
        if (line === "__none__" || line === null) break;
        submitted.push(line);
      }
    };
    routeStdin({ stdin, primary: lineSource, overlay: gate, timer: immediateTimer, now: typingClock() });

    const pending = gate.request(req());
    stdin.emit("y"); // answers the approval — must NOT reach the composer as a "y" keystroke
    await pending;

    stdin.emit("/verbose\r");
    await drain();
    assert.deepEqual(submitted, ["/verbose"], "once the only pending approval is decided, ordinary typing reaches the line source again");
  });

  it("end to end: with TWO approvals pending, typing is still captured by the gate until BOTH are decided — this is the intended single-at-a-time behaviour, not a residual bug", async () => {
    const stdin = new FakeStdin();
    const gate = new RawApprovalGate({ onRender: () => {} });
    const lineSource = new RawLineSource();
    routeStdin({ stdin, primary: lineSource, overlay: gate, timer: immediateTimer, now: typingClock() });

    const pA = gate.request(req());
    const pB = gate.request(req());
    stdin.emit("y");
    await pA;
    // B is now the current, undecided prompt — the gate is still open, so a
    // stray "v" (as if someone started typing "/verbose" too early) is
    // correctly swallowed by T49.2's "ignore everything else" rule rather
    // than leaking into the composer as a character.
    stdin.emit("v");
    assert.equal(lineSource.editorState.lines.join(""), "", "a keystroke aimed at a still-pending approval must not land in the composer");
    stdin.emit("n");
    await pB;
    assert.equal(gate.isOpen, false);
  });
});

describe("item 2: a short transcript starts at the top of the screen, not the bottom", () => {
  it("Scrollback.viewport pads blank rows at the BOTTOM when there is less content than the viewport", () => {
    const sb = new Scrollback();
    const block: ScrollbackBlock = { id: "boot", render: () => ["[Context]", "  CLAUDE.md · 4.9k tokens"] };
    sb.push(block, 80);
    const vp = sb.viewport(80, 10);
    assert.equal(vp.lines[0], "[Context]", "the first real line is at the very top");
    assert.equal(vp.lines[1], "  CLAUDE.md · 4.9k tokens");
    for (let i = 2; i < 10; i++) assert.equal(vp.lines[i], "", `row ${i} should be blank padding, not content pushed to the bottom`);
  });
});

describe("item 3: Left/Right with a selection collapses to the selection's edge, not a one-column move from the cursor", () => {
  it("Left lands right before the first character of the selection", () => {
    const e = new LineEditor();
    e.insertText("hello world");
    // Select "world" by dragging left-to-right: anchor at col 6, cursor at col 11.
    e.moveTo(0, 6);
    e.moveTo(0, 11, true);
    assert.equal(e.selectedText(), "world");
    e.moveLeft();
    assert.equal(e.cursor.col, 6, "cursor sits right before the 'w' of the selection's start");
    assert.equal(e.hasSelection, false, "the selection is cleared, not just visually — a plain Left is not itself an extend");
  });

  it("Left after a RIGHT-to-LEFT drag lands at the selection's start too — the collapse target never depends on drag direction", () => {
    const e = new LineEditor();
    e.insertText("hello world");
    // Drag right-to-left: anchor at col 11, cursor at col 6 — the raw
    // cursor is already AT the selection's start here. A real editor's
    // Left still collapses to `selection.start`, full stop, regardless of
    // where the raw cursor/anchor were before the collapse — there is no
    // "well the cursor was already there, so move one further" special
    // case. This is what proves the fix reads `selection.start` off the
    // normalised selection, not "wherever this.col already is."
    e.moveTo(0, 11);
    e.moveTo(0, 6, true);
    e.moveLeft();
    assert.equal(e.cursor.col, 6);
    assert.equal(e.hasSelection, false);
  });

  it("Right lands right after the last character of the selection", () => {
    const e = new LineEditor();
    e.insertText("hello world");
    e.moveTo(0, 0);
    e.moveTo(0, 5, true); // selects "hello"
    e.moveRight();
    assert.equal(e.cursor.col, 5);
    assert.equal(e.hasSelection, false);
  });

  it("Shift+Left/Right (extend: true) still extends normally — the collapse only applies to a plain arrow", () => {
    const e = new LineEditor();
    e.insertText("hello world");
    e.moveTo(0, 0);
    e.moveTo(0, 5, true);
    e.moveRight(true);
    assert.equal(e.selectedText(), "hello ", "extending Right grows the selection by one column, exactly as before");
  });
});

describe("item 5: the composer word-wraps a long line for display without inserting a real newline", () => {
  it("a line longer than the available width renders as more than one visual row", () => {
    const e = new LineEditor();
    e.insertText("the quick brown fox jumps over the lazy dog");
    const r = renderComposer(e.state, mono, 20); // body width 18
    // Buffer lines are everything between the two border rules.
    const bufferLines = r.lines.slice(1, -1);
    assert.ok(bufferLines.length > 1, "a 44-character line at 18 usable columns must wrap onto more than one row");
    for (const line of bufferLines) assert.ok(line.length <= 20, `wrapped row exceeds the requested width: "${line}"`);
    // Still ONE logical line — Enter would submit it as a single unbroken string.
    assert.equal(e.text, "the quick brown fox jumps over the lazy dog");
  });

  it("every visual row after the first uses the continuation prefix, including a wrapped continuation of logical row 0", () => {
    const e = new LineEditor();
    e.insertText("the quick brown fox jumps over the lazy dog");
    const r = renderComposer(e.state, mono, 20);
    const bufferLines = r.lines.slice(1, -1);
    assert.ok(bufferLines[0]!.startsWith("> "), "only the very first visual row gets the prompt");
    for (const line of bufferLines.slice(1)) assert.ok(line.startsWith("  "), `expected a continuation prefix: "${line}"`);
  });

  it("rowMap has one entry per visual row and names the logical row/column each one starts at", () => {
    const e = new LineEditor();
    e.insertText("the quick brown fox jumps over the lazy dog");
    const r = renderComposer(e.state, mono, 20);
    assert.equal(r.rowMap.length, r.lines.length - 2, "one map entry per buffer row, excluding the two border rules");
    assert.equal(r.rowMap[0]!.logicalRow, 0);
    assert.equal(r.rowMap[0]!.startCol, 0);
    assert.ok(r.rowMap[1]!.startCol > 0, "the second visual row starts partway through the logical line, not at 0 again");
  });

  it("the cursor tracks onto the correct wrapped visual row as it moves through a long line", () => {
    const e = new LineEditor();
    e.insertText("the quick brown fox jumps over the lazy dog");
    e.home();
    const atStart = renderComposer(e.state, mono, 20);
    assert.equal(atStart.cursorRow, 1, "the cursor starts on the first visual row");
    e.moveTo(0, 40); // well past where the first wrap happens
    const atEnd = renderComposer(e.state, mono, 20);
    assert.ok(atEnd.cursorRow > atStart.cursorRow, "moving the logical cursor past the wrap point moves it onto a LATER visual row");
  });

  it("a Shift+Enter buffer (multiple logical lines) still wraps each logical line independently", () => {
    const e = new LineEditor();
    e.insertText("short");
    e.newline();
    e.insertText("this second logical line is long enough to need wrapping too");
    const r = renderComposer(e.state, mono, 20);
    const bufferLines = r.lines.slice(1, -1);
    assert.equal(bufferLines[0], "> short");
    assert.ok(bufferLines.length > 2, "the second logical line alone should still produce more than one visual row");
  });

  it("a selection spanning a wrap point highlights correctly on each visual row it touches (no crash, no dropped span)", () => {
    const e = new LineEditor();
    e.insertText("the quick brown fox jumps over the lazy dog");
    e.moveTo(0, 5);
    e.moveTo(0, 25, true);
    const plain = renderComposer(e.state, mono, 20);
    const colored = renderComposer(e.state, color, 20);
    assert.equal(plain.lines.length, colored.lines.length);
    assert.ok(colored.lines.some((l) => /\x1b\[48;2;/.test(l)), "at least one wrapped row carries the selection background");
  });

  it("a mouse click on a WRAPPED visual row lands in the right place in the LOGICAL line, via rowMap", () => {
    const src = new RawLineSource({
      composerGeometry: () => {
        const r = renderComposer(src.editorState, mono, 20);
        return { firstBufferRow: 20, prefixWidth: COMPOSER_PREFIX_WIDTH, rowCount: r.rowMap.length, rowMap: r.rowMap };
      },
    });
    src.feedBytes("the quick brown fox jumps over the lazy dog");
    const before = renderComposer(src.editorState, mono, 20);
    assert.ok(before.lines.length > 3, "sanity: this buffer really does wrap onto more than one visual row");
    // Click on the SECOND visual row (frame row 21), a few columns in.
    src.feedBytes("\x1b[<0;5;22M");
    const map = before.rowMap[1]!;
    assert.equal(src.editorState.cursorRow, map.logicalRow, "still logical row 0 — word-wrap never created a second logical line");
    assert.equal(src.editorState.cursorCol, map.startCol + (5 - COMPOSER_PREFIX_WIDTH - 1), "the click's column is offset by the wrapped segment's own start, not read as an absolute column into the whole line");
  });

  it("without a rowMap (a caller that hasn't adopted it), a click still falls back to treating the visual row as the logical row directly", () => {
    const src = new RawLineSource({
      composerGeometry: () => ({ firstBufferRow: 20, prefixWidth: COMPOSER_PREFIX_WIDTH, rowCount: 1 }),
    });
    src.feedBytes("short");
    src.feedBytes("\x1b[<0;9;21M"); // frame col 8, buffer col 6 — past the end of "short"
    assert.equal(src.editorState.cursorRow, 0);
    assert.equal(src.editorState.cursorCol, 5, "clamped to the line's own length by editor.moveTo(), same as always");
  });
});

describe("item 6: the thinking block's background sits closer to the terminal's own than the user block's does, in every shipped palette", () => {
  function hexDistance(a: string, b: string): number {
    const parse = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const [ar, ag, ab] = parse(a);
    const [br, bg, bb] = parse(b);
    return Math.sqrt((ar! - br!) ** 2 + (ag! - bg!) ** 2 + (ab! - bb!) ** 2);
  }

  const HEX = /^#[0-9a-f]{6}$/i;

  it("thinkingBg is closer to bg (the terminal's own background) than userBg is", () => {
    for (const palette of Object.values(SHIPPED_PALETTES)) {
      // mono carries no value at all; ansi16 carries a named colour
      // ("black", "brightblack") rather than a traceable hex blend — the
      // ordering this test asserts only applies to a palette actually
      // built by `mix()`.
      if (!HEX.test(palette.tokens.thinkingBg) || !HEX.test(palette.tokens.userBg) || !HEX.test(palette.tokens.bg)) continue;
      const toBg = hexDistance(palette.tokens.thinkingBg, palette.tokens.bg);
      const userToBg = hexDistance(palette.tokens.userBg, palette.tokens.bg);
      assert.ok(toBg < userToBg, `${palette.name}: thinkingBg (${palette.tokens.thinkingBg}) should sit closer to bg (${palette.tokens.bg}) than userBg (${palette.tokens.userBg}) does`);
    }
  });

  // d537f44 dropped the full-width thinkingBg slab on purpose: a `│ Thinking`
  // header and an indented body, coloured and unfilled. The palette ordering
  // above still holds for the token; the block no longer paints it.
  it("the Thinking block renders coloured and without a background slab under a colour theme", () => {
    const lines = renderScreenBlock({ id: "t", kind: "thinking", text: "reasoning" }, { width: 40, theme: color });
    assert.ok(lines.some((l) => /\x1b\[38;2;/.test(l)));
    assert.ok(!lines.some((l) => /\x1b\[48;2;/.test(l)));
  });
});

function vm(overrides: Partial<ViewModel> = {}): ViewModel {
  return {
    cost: { runUsd: 0, todayUsd: null, capRunUsd: 0.5, capDayUsd: 2, onExceed: "stop" },
    tokens: { counters: { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }, hitRatio: 0, calls: 0 },
    context: { parent: null, delegate: null },
    outcome: null,
    alerts: [],
    session: { id: "s", brief: null, agent: null, model: null, phase: null, startedUtc: null, endedUtc: null, heartbeatUtc: null, elapsedSec: null, thinkingLevel: null },
    health: { toolSchemaTokens: null, toolCount: null, prefixChanged: false },
    children: [],
    ...overrides,
  };
}

describe("item 7: a freshly booted context gauge shows a placeholder, not a misleading 0", () => {
  it("usedTokens: 0 renders an em dash and the known total, never '0.0k' or '0%'", () => {
    const line = renderTriadLine(vm({ context: { parent: null, delegate: { usedTokens: 0, totalTokens: 64000, pct: 0 } } }), { width: 100, theme: mono });
    assert.match(line, /ctx .+—\/64\.0k/);
    assert.doesNotMatch(line, /0\.0k\/64\.0k/);
    assert.doesNotMatch(line, /ctx.*\b0%/);
  });

  it("the narrow pct-only tier shows the same placeholder rather than '0%'", () => {
    const line = renderTriadLine(vm({ context: { parent: null, delegate: { usedTokens: 0, totalTokens: 64000, pct: 0 } } }), { width: 70, theme: mono });
    assert.match(line, /ctx —/);
    assert.doesNotMatch(line, /ctx 0%/);
  });

  it("a real (non-zero) usage figure is completely unaffected — this is a boot-only placeholder", () => {
    const line = renderTriadLine(vm({ context: { parent: null, delegate: { usedTokens: 12000, totalTokens: 64000, pct: 0.1875 } } }), { width: 100, theme: mono });
    assert.match(line, /12\.0k\/64\.0k/);
    assert.match(line, /19%/);
  });

  it("a genuinely unknown window (no total at all) still falls back to the plain '?'", () => {
    const line = renderTriadLine(vm({ context: { parent: null, delegate: null } }), { width: 100, theme: mono });
    assert.match(line, /ctx \?/);
  });
});

describe("item 9: GFM tables render as real columns, and bold survives inside them", () => {
  it("a table is rendered as aligned columns with a header rule, not word-wrapped into garbage", () => {
    const text = ["| Name | Value |", "| --- | --- |", "| Alice | 42 |", "| Bob | 7 |"].join("\n");
    const lines = renderMarkdownLines(text, 40, mono, "speech");
    const plain = lines.map((l) => l.plain);
    assert.ok(plain[0]!.includes("Name") && plain[0]!.includes("Value"), "header row");
    assert.ok(/^[-─]+$/.test(plain[1]!.replace(/\s/g, "")) === false || plain[1]!.length > 0, "a rule line follows the header");
    assert.ok(plain.some((l) => l.includes("Alice") && l.includes("42")));
    assert.ok(plain.some((l) => l.includes("Bob") && l.includes("7")));
  });

  it("bold text inside a table cell is styled, not left as literal asterisks", () => {
    const text = ["| Name | Status |", "| --- | --- |", "| Alice | **done** |"].join("\n");
    const lines = renderMarkdownLines(text, 60, color, "speech");
    const styledRow = lines.find((l) => l.plain.includes("Alice"))!;
    assert.doesNotMatch(styledRow.plain, /\*\*/, "the plain text must not still show ** markers");
    assert.match(styledRow.styled, /\x1b\[1m/, "the cell is actually bold, not just marker-stripped");
  });

  it("column alignment is honoured (right-aligned numeric column)", () => {
    const text = ["| Name | Value |", "| --- | ---: |", "| Alice | 1 |", "| Bob | 200 |"].join("\n");
    const lines = renderMarkdownLines(text, 40, mono, "speech");
    const aliceRow = lines.find((l) => l.plain.includes("Alice"))!.plain;
    const bobRow = lines.find((l) => l.plain.includes("Bob"))!.plain;
    // Both "1" and "200" should end at the same column (right-aligned).
    const aliceEnd = aliceRow.trimEnd().length;
    const bobEnd = bobRow.trimEnd().length;
    assert.equal(aliceEnd, bobEnd);
  });

  it("a table wider than the available width shrinks its columns rather than overrunning it", () => {
    const text = ["| A very long column header indeed | Another quite long header | Third one too |", "| --- | --- | --- |", "| short | short | short |"].join("\n");
    const lines = renderMarkdownLines(text, 40, mono, "speech");
    for (const line of lines) assert.ok(line.plain.length <= 41, `row exceeds the budget: "${line.plain}" (${line.plain.length})`);
  });

  it("ordinary paragraphs and lists around a table are unaffected", () => {
    const text = ["intro text", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "- a list item after the table"].join("\n");
    const lines = renderMarkdownLines(text, 40, mono, "speech");
    assert.ok(lines.some((l) => l.plain === "intro text"));
    assert.ok(lines.some((l) => l.plain.includes("- a list item after the table")));
  });

  it("a '|' inside ordinary prose with no separator row underneath is NOT mistaken for a table", () => {
    const text = "the pipe | here is not a table";
    const lines = renderMarkdownLines(text, 60, mono, "speech");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.plain, text);
  });
});

describe("item 11: approval key hints are spaced further apart to reduce misclicks; full mouse click support is a named follow-up, not silently dropped", () => {
  it("the gutter between key hints widened from 3 to 5 columns", () => {
    const lines = renderScreenBlock({ id: "a", kind: "approval", approval: approvalViewFor(req()) }, { width: 80, theme: mono });
    const keysLine = lines.find((l) => l.includes("[y]"))!;
    assert.match(keysLine, /\[y\] allow once {5}\[n\] deny/);
  });
});
