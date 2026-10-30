// The sixth 2026-09-02 UI feedback round — five numbered items, asserted in
// the maintainer's own order and named by their number, the same discipline
// as every round before this one.
//
// Item 1 ("i cannot scroll or type and i have to Ctrl C to get out") and
// item 3 (the key-repeat guard) are two halves of one report and are
// tested together where the fix is shared: round five's queue is what made
// "one approval at a time" true, and this round is what makes the one on
// screen reachable — a held `y` can no longer burn through the queue
// unseen, the wheel still scrolls while a prompt is open, a new prompt
// yanks a scrolled-back viewport to the tail, and Ctrl-C cancels the whole
// turn instead of denying one request per press.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApprovalRequest } from "../../gate/approval.js";
import { RawApprovalGate, APPROVAL_KEY_REPEAT_GUARD_MS } from "./approval-modal.js";
import { ScreenPipeline } from "./pipeline.js";
import { renderScreenBlock } from "./blocks.js";
import { renderMarkdownLines } from "./markdown.js";
import { renderComposer, composerMaxRows, COMPOSER_MAX_HEIGHT_FRACTION } from "./composer.js";
import { renderTriadLine } from "../renderers/line.js";
import { derive } from "../derive.js";
import { LineEditor } from "../editor.js";
import { resolveTheme } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import type { Snapshot } from "../types.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");
const glyphs = GLYPHS.unicode;

function req(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { kind: "bash", summary: "run command", detail: "npm install", ...overrides };
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** A clock the test moves by hand — the key-repeat guard is the only thing in the gate that reads one. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

describe("item 3: holding the approval key approves exactly one request, not the whole queue", () => {
  it("a repeat of the same key inside the guard window is ignored — the second approval survives a held `y`", async () => {
    const clock = fakeClock();
    const gate = new RawApprovalGate({ onRender: () => {}, now: clock.now });
    const pA = gate.request(req({ detail: "cmd-a" }));
    const pB = gate.request(req({ detail: "cmd-b" }));

    gate.feedBytes("y");
    assert.equal(await pA, "allow");

    // Auto-repeat: a stream of identical bytes ~30ms apart. Every one of
    // them must bounce off the guard, and each one restarts the window, so
    // holding the key down forever never reaches the second request.
    for (let i = 0; i < 40; i++) {
      clock.advance(30);
      gate.feedBytes("y");
    }
    assert.equal(gate.isOpen, true, "the second approval is still waiting for a real decision");
    let settled = false;
    void pB.then(() => (settled = true));
    await Promise.resolve();
    assert.equal(settled, false, "a held key must not approve a request the user never saw");

    // Fingers lifted (no repeats for longer than the window), then a real press.
    clock.advance(APPROVAL_KEY_REPEAT_GUARD_MS + 1);
    gate.feedBytes("y");
    assert.equal(await pB, "allow");
  });

  it("a DIFFERENT key acts immediately — no keyboard auto-repeats into another character, so `y` then `n` is a person changing their mind", async () => {
    const clock = fakeClock();
    const gate = new RawApprovalGate({ onRender: () => {}, now: clock.now });
    const pA = gate.request(req());
    const pB = gate.request(req());
    gate.feedBytes("y");
    assert.equal(await pA, "allow");
    clock.advance(20);
    gate.feedBytes("n");
    assert.equal(await pB, "deny");
  });

  it("the guard applies to Escape too — a held Escape denies one request, not every queued one", async () => {
    const clock = fakeClock();
    const gate = new RawApprovalGate({ onRender: () => {}, now: clock.now });
    const pA = gate.request(req());
    const pB = gate.request(req());
    gate.feedBytes("\x1b");
    gate.flushPending();
    assert.equal(await pA, "deny");
    for (let i = 0; i < 10; i++) {
      clock.advance(30);
      gate.feedBytes("\x1b");
      gate.flushPending();
    }
    assert.equal(gate.isOpen, true);
    let settled = false;
    void pB.then(() => (settled = true));
    await Promise.resolve();
    assert.equal(settled, false);
    clock.advance(APPROVAL_KEY_REPEAT_GUARD_MS + 1);
    gate.feedBytes("\x1b");
    gate.flushPending();
    assert.equal(await pB, "deny");
  });

  it("the window is a real duration, not a count — a decision long after the last repeat still lands", async () => {
    assert.ok(APPROVAL_KEY_REPEAT_GUARD_MS >= 250, "the window has to comfortably exceed a terminal's auto-repeat interval");
    const clock = fakeClock();
    const gate = new RawApprovalGate({ onRender: () => {}, now: clock.now });
    const p = gate.request(req());
    clock.advance(APPROVAL_KEY_REPEAT_GUARD_MS * 2);
    gate.feedBytes("y");
    assert.equal(await p, "allow");
  });
});

describe("item 1: an open approval prompt is reachable — scrollable, visible, and escapable", () => {
  it("the mouse wheel still scrolls the transcript while a prompt is open (it was decoded and dropped)", () => {
    const actions: string[] = [];
    const gate = new RawApprovalGate({ onRender: () => {}, onScroll: (a) => actions.push(a) });
    void gate.request(req());
    gate.feedBytes("\x1b[<64;10;10M"); // SGR wheel up
    gate.feedBytes("\x1b[<65;10;10M"); // SGR wheel down
    assert.deepEqual(actions, ["wheelUp", "wheelDown"]);
  });

  it("Ctrl+wheel is left to the terminal's own zoom, exactly as the composer leaves it", () => {
    const actions: string[] = [];
    const gate = new RawApprovalGate({ onRender: () => {}, onScroll: (a) => actions.push(a) });
    void gate.request(req());
    gate.feedBytes("\x1b[<80;10;10M"); // wheel up with the SGR ctrl bit set
    assert.deepEqual(actions, []);
  });

  it("Up/Down scroll the transcript too — typing is captured, reading is not", () => {
    const actions: string[] = [];
    const gate = new RawApprovalGate({ onRender: () => {}, onScroll: (a) => actions.push(a) });
    void gate.request(req());
    gate.feedBytes("\x1b[A");
    gate.feedBytes("\x1b[B");
    assert.deepEqual(actions, ["wheelUp", "wheelDown"]);
  });

  it("Ctrl-C denies EVERY pending approval and interrupts the turn — one press is the way out, not one press per request", async () => {
    let interrupted = 0;
    const gate = new RawApprovalGate({ onRender: () => {}, onInterrupt: () => (interrupted += 1) });
    const pending = [gate.request(req()), gate.request(req()), gate.request(req())];
    gate.feedBytes("\x03");
    assert.deepEqual(await Promise.all(pending), ["deny", "deny", "deny"]);
    assert.equal(gate.isOpen, false, "stdin goes back to the composer after one Ctrl-C");
    assert.equal(interrupted, 1);
  });

  it("end to end: a new prompt is visible even to a reader who had scrolled back, and the decision does NOT move the view again", async () => {
    let out = "";
    const pipeline = new ScreenPipeline({
      width: 60,
      height: 20,
      theme: mono,
      header: { product: "LYKOS", version: "0", model: "m", cwd: "/w", branch: null, sessionId: "s", executionShape: "standalone" },
      sink: { write: (t: string) => void (out += t) },
    });
    // Production's own wiring, copied from `session/interactive.ts`.
    const gate = new RawApprovalGate({
      onRender: (id, view) => {
        const block = { id, kind: "approval" as const, approval: view };
        if (!pipeline.updateBlock(id, block)) {
          pipeline.pushBlock(block);
          if (!view.decision) pipeline.scrollToEnd();
        }
        pipeline.flush();
      },
    });

    for (let i = 0; i < 200; i++) pipeline.pushBlock({ id: `sys-${i}`, kind: "system", text: `line ${i}` });
    pipeline.scrollUp(120);
    pipeline.flush();

    out = "";
    const pending = gate.request(req({ detail: "APPROVE-ME" }));
    assert.ok(stripAnsi(out).includes("APPROVE-ME"), "an approval that arrives while the reader is scrolled back must still be on screen");

    out = "";
    gate.feedBytes("y");
    assert.equal(await pending, "allow");
    assert.ok(stripAnsi(out).includes("allowed once"), "the decision replaces the question in place");
  });
});

describe("item 2: bold survives a wrap boundary, and a table is drawn as a table", () => {
  // The span itself is longer than the wrap width, so it CANNOT survive on
  // one row — which is the case round five's renderer got wrong.
  const prose =
    "lead in text **a single bold span that is much longer than the wrap width and therefore has to break across several rows** trailing text";

  it("a bold span split by the wrap shows no literal asterisks anywhere", () => {
    const lines = renderMarkdownLines(prose, 40, color, "speech");
    for (const line of lines) {
      assert.doesNotMatch(line.plain, /\*\*/, `markers leaked into "${line.plain}"`);
      assert.doesNotMatch(stripAnsi(line.styled), /\*\*/, `markers leaked into the painted line`);
    }
  });

  it("BOTH halves of the split span are painted bold, not just the one that stayed whole", () => {
    const lines = renderMarkdownLines(prose, 40, color, "speech");
    const boldRows = lines.filter((l) => l.styled.includes("\x1b[1m"));
    assert.ok(boldRows.length >= 2, `the span crosses a wrap, so at least two rows must carry SGR 1 — got ${boldRows.length}`);
  });

  it("a code span split by the wrap keeps its own styling too", () => {
    const lines = renderMarkdownLines(`${"a".repeat(30)} \`some inline code that wraps\` tail`, 24, color, "speech");
    for (const line of lines) assert.doesNotMatch(line.plain, /`/, `backticks leaked into "${line.plain}"`);
  });

  it("no wrapped row exceeds the width, span-splitting or not", () => {
    for (const w of [12, 24, 40, 79]) {
      for (const line of renderMarkdownLines(prose, w, color, "speech")) {
        assert.ok(line.plain.length <= w, `"${line.plain}" (${line.plain.length}) exceeds ${w}`);
      }
    }
  });

  it("under the mono theme the raw markers still pass through untouched — the NO_COLOR rule is unchanged", () => {
    const [line] = renderMarkdownLines("this is **bold** text", 80, mono, "speech");
    assert.equal(line!.styled, "this is **bold** text");
  });

  it("a table is a ruled box: corners, junctions, and one vertical bar per column boundary", () => {
    const table = ["| Name | Role |", "| --- | --- |", "| Alice | eng |", "| Bob | ops |"].join("\n");
    const lines = renderMarkdownLines(table, 60, color, "speech").map((l) => l.plain);
    assert.ok(lines[0]!.startsWith(glyphs.boxTL) && lines[0]!.endsWith(glyphs.boxTR), `top rule: "${lines[0]}"`);
    assert.ok(lines[0]!.includes(glyphs.teeDown), "the top rule carries a column junction");
    assert.ok(lines[2]!.startsWith(glyphs.teeRight) && lines[2]!.includes(glyphs.cross), `header rule: "${lines[2]}"`);
    assert.ok(lines.at(-1)!.startsWith(glyphs.boxBL) && lines.at(-1)!.endsWith(glyphs.boxBR), `bottom rule: "${lines.at(-1)}"`);
    const aliceRow = lines.find((l) => l.includes("Alice"))!;
    assert.equal(aliceRow.split(glyphs.vbar).length - 1, 3, "two columns means three vertical bars");
  });

  it("every row of the box is exactly the same width — a ragged frame is the thing that reads as broken", () => {
    const table = ["| A | Bee | C |", "| --- | ---: | :--- |", "| 1 | 22 | 333 |", "| x | y | z |"].join("\n");
    const lines = renderMarkdownLines(table, 60, color, "speech").map((l) => l.plain);
    const widths = new Set(lines.map((l) => l.length));
    assert.equal(widths.size, 1, `ragged frame: ${[...widths].join(", ")}`);
  });

  it("the box chrome is inside the width budget, never added on top of it", () => {
    const wide = [
      "| aaaaaaaaaaaaaaa | bbbbbbbbbbbbbbb | ccccccccccccccc |",
      "| --- | --- | --- |",
      "| 111111111111111 | 222222222222222 | 333333333333333 |",
    ].join("\n");
    for (const w of [30, 44, 60]) {
      for (const line of renderMarkdownLines(wide, w, color, "speech")) {
        assert.ok(line.plain.length <= w, `"${line.plain}" (${line.plain.length}) exceeds ${w}`);
      }
    }
  });

  it("bold inside a table cell is styled, and the frame still lines up around it", () => {
    const table = ["| Name | Role |", "| --- | --- |", "| **Alice** | eng |"].join("\n");
    const lines = renderMarkdownLines(table, 60, color, "speech");
    const row = lines.find((l) => l.plain.includes("Alice"))!;
    assert.doesNotMatch(row.plain, /\*\*/);
    assert.match(row.styled, /\x1b\[1m/);
    assert.equal(row.plain.length, lines[0]!.plain.length);
  });

  it("a speech block carrying a table renders it inside the block's own inset without overrunning the frame", () => {
    const text = ["intro", "", "| K | V |", "| --- | --- |", "| a | b |"].join("\n");
    for (const line of renderScreenBlock({ id: "s", kind: "speech", text }, { width: 40, theme: color })) {
      assert.ok(stripAnsi(line).length <= 40, `"${stripAnsi(line)}" overruns the frame`);
    }
  });
});

describe("item 4: a booted session with no message sent shows the window it knows, not a question mark", () => {
  function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
    return {
      now: new Date("2026-09-02T00:00:00Z"),
      run: null,
      today: null,
      budget: { perRunUsd: 0.5, perDayUsd: 2, onExceed: "stop" },
      parentContext: null,
      rateLimits: null,
      delegateContextTokens: undefined,
      ...overrides,
    };
  }

  it("with a known context window and no call yet, the gauge shows nothing-over-max", () => {
    const vm = derive(snapshot({ delegateContextTokens: 1_000_000 }));
    const line = stripAnsi(renderTriadLine(vm, { width: 120, theme: mono }));
    assert.match(line, /—\/1\.00M/, `expected an em dash over the max, got "${line}"`);
    assert.doesNotMatch(line, /ctx \?/);
    assert.doesNotMatch(line, /0\.0k/, "zero used must never be printed as a measurement");
  });

  it("with no context window known at all, `ctx ?` is still the honest answer", () => {
    const vm = derive(snapshot());
    assert.match(stripAnsi(renderTriadLine(vm, { width: 120, theme: mono })), /ctx \?/);
  });

  it("the boot gauge raises no context alert — nothing has been measured, so there is nothing to warn about", () => {
    const vm = derive(snapshot({ delegateContextTokens: 1_000_000 }));
    assert.deepEqual(
      vm.alerts.filter((a) => a.id.startsWith("R-D")),
      [],
    );
  });
});

describe("item 5: the composer is capped and says how much is out of sight", () => {
  function editorWith(text: string): LineEditor {
    const ed = new LineEditor();
    ed.insertText(text);
    return ed;
  }

  it("the cap is 40% of the terminal, less the two border rules, and never below one row", () => {
    assert.equal(COMPOSER_MAX_HEIGHT_FRACTION, 0.4);
    assert.equal(composerMaxRows(30), 10);
    assert.equal(composerMaxRows(50), 18);
    assert.equal(composerMaxRows(6), 1);
    assert.equal(composerMaxRows(1), 1);
  });

  it("a buffer taller than the cap renders exactly cap+2 rows instead of growing over the screen", () => {
    const r = renderComposer(editorWith("d".repeat(3000)).state, color, 70, null, 10);
    assert.equal(r.lines.length, 12, "ten body rows plus two rules");
  });

  it("the rules name how many visual rows are hidden above and below", () => {
    const ed = editorWith("d".repeat(3000));
    const atEnd = renderComposer(ed.state, color, 70, null, 10);
    assert.ok(atEnd.hiddenAbove > 0 && atEnd.hiddenBelow === 0, "typing at the end pins the window to the tail");
    assert.match(stripAnsi(atEnd.lines[0]!), new RegExp(`${glyphs.up} ${atEnd.hiddenAbove} more`));
    assert.equal(stripAnsi(atEnd.lines.at(-1)!).includes("more"), false, "nothing below, so no bottom label");

    ed.moveTo(0, 0);
    const atTop = renderComposer(ed.state, color, 70, null, 10);
    assert.ok(atTop.hiddenAbove === 0 && atTop.hiddenBelow > 0);
    assert.match(stripAnsi(atTop.lines.at(-1)!), new RegExp(`${glyphs.down} ${atTop.hiddenBelow} more`));
  });

  it("the cursor is inside the window wherever it sits — a cap that can hide the caret is worse than no cap", () => {
    const ed = editorWith("d".repeat(3000));
    for (const col of [0, 1, 200, 900, 1500, 2400, 3000]) {
      ed.moveTo(0, col);
      const r = renderComposer(ed.state, color, 70, null, 10);
      assert.ok(
        r.cursorRow >= 1 && r.cursorRow <= r.lines.length - 2,
        `cursor row ${r.cursorRow} outside the ${r.lines.length}-row composer at col ${col}`,
      );
      assert.ok(r.windowStart + (r.lines.length - 2) <= r.rowMap.length, "the window names a real slice of the full row map");
    }
  });

  it("the window keeps naming the RIGHT logical position — rowMap stays whole and windowStart is the offset into it", () => {
    const ed = editorWith("d".repeat(3000));
    ed.moveTo(0, 3000);
    const r = renderComposer(ed.state, color, 70, null, 10);
    // Unwindowed since round seven, item 1: visual Up/Down navigates rows
    // ABOVE the window, which a sliced map could not name.
    assert.ok(r.rowMap.length > r.lines.length - 2, "the map covers the whole buffer, not just what is painted");
    const first = r.rowMap[r.windowStart]!;
    assert.equal(first.logicalRow, 0);
    assert.ok(first.startCol > 0, "the first visible row is a continuation, and says so");
    assert.equal(r.windowStart, r.hiddenAbove);
  });

  it("a buffer that fits is completely unaffected — no labels, no window, cursor where it was", () => {
    const r = renderComposer(editorWith("hello").state, color, 70, null, 10);
    assert.equal(r.lines.length, 3);
    assert.equal(r.hiddenAbove, 0);
    assert.equal(r.hiddenBelow, 0);
    assert.equal(stripAnsi(r.lines[0]!).includes("more"), false);
    assert.equal(r.cursorRow, 1);
  });

  it("omitting the cap keeps the old unbounded behaviour, which is what every non-production caller relies on", () => {
    const r = renderComposer(editorWith("d".repeat(3000)).state, color, 70, null);
    assert.ok(r.lines.length > 40);
    assert.equal(r.hiddenAbove, 0);
    assert.equal(r.hiddenBelow, 0);
  });
});
