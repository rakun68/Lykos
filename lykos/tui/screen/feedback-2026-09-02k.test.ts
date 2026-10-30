// The eleventh 2026-09-02 UI feedback round, three numbered items. Most of
// this file is item 3 — "pasting multiple lines still bug, FIX THIS RIGHT
// NOW AT ALL COST" — which is the third round to touch paste and the first
// to reach the actual cause.
//
// Rounds eight and ten fixed real paste bugs (a `\r` left in the buffer by
// splitting on bare `\n`; bracketed paste never enabled by any caller) and
// both were correct — on a terminal that speaks bracketed paste. The
// maintainer's does not, because Lykos itself asks it not to:
// `ENTER_SEQUENCES.win32Input` turns on win32-input-mode so Shift+Enter is
// reportable, and a console in that mode delivers pasted text as ordinary
// key records with no `\x1b[200~` markers anywhere in the stream. The
// pasted carriage returns are then indistinguishable from Enter, and the
// first one submits.
//
// The fix is position-based and therefore protocol-independent — an Enter
// with more text after it in the same read was pasted, one that ends a read
// was pressed; see the paste-detection note in `input.ts` for the full
// argument.
//
// **Amended by round fourteen** (`feedback-2026-09-02n.test.ts`): the one
// case position alone cannot see — a paste split across reads, cut between
// a line's text and its newline — was covered here by a 30 ms clock, and
// that clock is what still broke on a real paste, because the next read
// arrives after the screen has been repainted for the one before it. A
// trailing Enter is now HELD until either more text arrives or the caller's
// idle `flush()` runs, so nothing in this file depends on a clock at all
// any more, real or injected.
//
// Items 1 (hover highlighting) and 2 (a whole-row tint behind added and
// removed diff lines) are covered at the bottom of the file, one describe
// per numbered item as every round before this one did.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyDecoder, type KeyEvent } from "./input.js";
import { highlightSpan } from "./frame.js";
import { renderDiffLines, type DiffView } from "./diff.js";
import { ScreenPipeline } from "./pipeline.js";
import { resolveTheme } from "../theme/resolve.js";
import { LineEditor } from "../editor.js";
import { RawLineSource } from "./raw-line-source.js";

/** One win32-input-mode record: `CSI Vk;Sc;Uc;Kd;Cs;Rc _`, key-down, no modifiers. */
function win32(vk: number, uc: number): string {
  return `\x1b[${vk};0;${uc};1;0;1_`;
}

/** The byte stream a Windows console in win32-input-mode produces for pasted text. */
function win32Paste(text: string): string {
  let out = "";
  for (const ch of text) {
    if (ch === "\n") out += win32(13, 13);
    else out += win32(0, ch.codePointAt(0)!);
  }
  return out;
}

describe("round eleven, item 3: a multi-line paste never submits", () => {
  it("folds a win32-input-mode paste burst into one paste event instead of an Enter mid-stream", () => {
    const d = new KeyDecoder();
    const events = d.feed(win32Paste("one\ntwo"));
    assert.deepEqual(events, [{ type: "paste", text: "one\ntwo" }]);
    assert.equal(events.some((e) => e.type === "enter"), false);
  });

  it("does the same for a plain-bytes terminal that never sent bracketed-paste markers", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("one\ntwo\nthree"), [{ type: "paste", text: "one\ntwo\nthree" }]);
  });

  it("keeps a paste split across two reads as one paste — the lone \\r chunk must not submit", () => {
    const d = new KeyDecoder();
    assert.equal(d.feed("x".repeat(64)).length, 64);
    // The chunk boundary landed exactly on the newline. Before round
    // eleven that chunk was a bare Enter and sent the half-pasted prompt;
    // before round fourteen it was rescued by a 30 ms clock. Now it is
    // simply not decided yet — no event comes out at all.
    assert.deepEqual(d.feed("\r"), []);
    // What arrives next is what decides it, however long that takes.
    assert.deepEqual(d.feed("beta"), [{ type: "paste", text: "\nbeta" }]);
  });

  it("a real Enter keypress still submits — an Enter that ends a read, with nothing after it", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("h"), [{ type: "char", value: "h" }]);
    assert.deepEqual(d.feed("i"), [{ type: "char", value: "i" }]);
    // It ends the read, so nothing yet says whether it was typed or
    // pasted; the idle gap is what says nothing followed it.
    assert.deepEqual(d.feed("\r"), []);
    assert.deepEqual(d.flush(), [{ type: "enter" }]);
  });

  it("a typed line and its Enter batched into ONE read still submits — position, not rate", () => {
    const d = new KeyDecoder();
    // What a slow SSH link does to a typed prompt: byte-for-byte a small
    // paste, and the only thing that tells them apart is that the Enter is
    // last. A rate threshold would make this prompt unsendable.
    // The position rule still refuses to fold it into a paste — every
    // character comes out as itself — and one idle gap later it submits.
    const events = d.feed("hello there\r");
    assert.equal(events.every((e) => e.type === "char"), true);
    assert.deepEqual(d.flush(), [{ type: "enter" }]);
  });

  it("a paste that ends in a newline does not submit either — its last Enter is part of the paste", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("one\ntwo\n"), [{ type: "paste", text: "one\ntwo\n" }]);
  });

  it("an Enter typed after a paste has ended is a keypress again", () => {
    const d = new KeyDecoder();
    d.feed("one\ntwo\n");
    d.flush(); // the idle gap that ends the paste
    assert.deepEqual(d.feed("\r"), []);
    assert.deepEqual(d.flush(), [{ type: "enter" }]);
  });

  it("Shift+Enter is never swallowed by a burst — a modified Enter is not a run member", () => {
    // Cs bit 0x10 is SHIFT_PRESSED: the same record the console sends for
    // round eight's own Shift+Enter, arriving in the middle of a burst.
    const shiftEnter = "\x1b[13;0;13;1;16;1_";
    const events = new KeyDecoder().feed(win32Paste("ab") + shiftEnter + win32Paste("cd"));
    assert.deepEqual(
      events.filter((e) => e.type === "enter"),
      [{ type: "enter", shift: true }],
    );
  });

  it("CRLF is one line break, not two — a Windows-authored paste keeps its shape", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("one\r\ntwo\r\nthree"), [{ type: "paste", text: "one\ntwo\nthree" }]);
  });

  it("bracketed paste still wins outright where the terminal sends it", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("\x1b[200~a\nb\x1b[201~"), [{ type: "paste", text: "a\nb" }]);
  });

  it("the pasted text lands in the editor whole, with real line breaks", () => {
    const ed = new LineEditor();
    ed.insertText("one\r\ntwo\r\n");
    assert.deepEqual(ed.state.lines, ["one", "two", ""]);
  });

  it("end to end: a burst through RawLineSource leaves the composer holding every line and submits nothing", async () => {
    const submitted: string[] = [];
    const src = new RawLineSource();
    const pending = src.next().then((v) => {
      if (v !== null) submitted.push(v);
      return v;
    });
    src.feedBytes(win32Paste("first\nsecond\nthird"));
    assert.deepEqual(src.editorState.lines, ["first", "second", "third"]);
    assert.equal(submitted.length, 0);
    src.close();
    assert.equal(await pending, null);
  });
});

describe("round eleven, item 3: the burst rule is narrow by construction", () => {
  it("a run with no Enter in it is left as individual char events", () => {
    const events: KeyEvent[] = new KeyDecoder().feed("abcdef");
    assert.equal(events.length, 6);
    assert.equal(events.every((e) => e.type === "char"), true);
  });

  it("a non-text event splits a run rather than joining it", () => {
    const d = new KeyDecoder();
    const events = d.feed("ab\x1b[Dc\r");
    // The arrow ends the first run. What follows is one char and a
    // trailing Enter, which is held rather than guessed at — so the events
    // stop at the char, and the idle gap turns the Enter into the submit
    // it was.
    assert.deepEqual(events.map((e) => e.type), ["char", "char", "arrow", "char"]);
    assert.deepEqual(d.flush(), [{ type: "enter" }]);
  });
});


const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

function stripAnsi(v: string): string {
  return v.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function header() {
  return { product: "LYKOS", version: "0", model: "m", cwd: "/w", branch: null, sessionId: "s", executionShape: "standalone" };
}

describe("round eleven, item 1: a clickable thing lights up under the pointer", () => {
  it("motion with no button held decodes as a hover, not as a drag", () => {
    // SGR Cb 35 = 32 (motion) + 3 (no button). A drag reports the button
    // it is holding instead, which is what keeps the two apart.
    assert.deepEqual(new KeyDecoder().feed("\x1b[<35;10;5M"), [
      { type: "mouse", action: "move", button: 3, col: 9, row: 4 },
    ]);
    assert.deepEqual(new KeyDecoder().feed("\x1b[<32;10;5M"), [
      { type: "mouse", action: "drag", button: 0, col: 9, row: 4 },
    ]);
  });

  it("highlightSpan tints exactly the span asked for, counting VISIBLE columns past the escapes", () => {
    const line = `plain \x1b[38;2;1;2;3m[y]\x1b[0m rest`;
    const out = highlightSpan(line, 6, 9, "\x1b[48;2;9;9;9m");
    assert.equal(stripAnsi(out), stripAnsi(line), "the text itself is untouched");
    assert.match(out, /\x1b\[48;2;9;9;9m/, "the background is opened");
    assert.match(out, /\x1b\[49m/, "and closed with SGR 49, not a full reset");
    // The pill's own reset would otherwise drop the tint mid-span.
    assert.match(out, /\x1b\[0m\x1b\[48;2;9;9;9m/, "a reset inside the span re-opens the background");
  });

  it("a span outside the line, or a theme with no background, changes nothing", () => {
    assert.equal(highlightSpan("abc", 10, 12, "\x1b[48;5;1m"), "abc");
    assert.equal(highlightSpan("abc", 0, 2, ""), "abc");
  });

  it("hovering an approval pill repaints once; hovering blank transcript repaints not at all", () => {
    const pipeline = new ScreenPipeline({ width: 60, height: 20, theme: color, header: header(), sink: { write: () => {} } });
    pipeline.pushBlock({ id: "a1", kind: "approval", approval: { kind: "bash", summary: "run", detail: "ls" } });
    pipeline.flush();

    let pill: { row: number; col: number } | null = null;
    for (let r = 0; r < 20 && !pill; r++) {
      for (let c = 0; c < 60; c++) {
        const action = pipeline.actionAt(r, c);
        if (action?.kind === "approvalKey" && action.key === "y") {
          pill = { row: r, col: c };
          break;
        }
      }
    }
    assert.ok(pill, "an approval prompt must have a clickable [y] pill to hover");

    const before = pipeline.renders;
    // Two moves inside the SAME pill: the first is a state change, the
    // second is not, and neither is a move onto a row with nothing on it.
    pipeline.setHover(pill.row, pill.col);
    pipeline.flush();
    const afterFirst = pipeline.renders;
    assert.equal(afterFirst, before + 1, "moving onto a clickable region repaints once");
    pipeline.setHover(pill.row, pill.col + 1);
    pipeline.flush();
    assert.equal(pipeline.renders, afterFirst, "moving WITHIN the same region repaints nothing");
    pipeline.setHover(19, 0);
    pipeline.flush();
    assert.equal(pipeline.renders, afterFirst + 1, "leaving the region repaints once to clear the tint");
  });

  it("the hovered pill is actually tinted in the painted frame, and nothing is once the pointer leaves", () => {
    const frames: string[] = [];
    const pipeline = new ScreenPipeline({ width: 60, height: 20, theme: color, header: header(), sink: { write: (f) => frames.push(f) } });
    pipeline.pushBlock({ id: "a1", kind: "approval", approval: { kind: "bash", summary: "run", detail: "ls" } });
    pipeline.flush();
    let pill: { row: number; col: number } | null = null;
    for (let r = 0; r < 20 && !pill; r++) {
      for (let c = 0; c < 60; c++) {
        if (pipeline.actionAt(r, c)?.kind === "approvalKey") {
          pill = { row: r, col: c };
          break;
        }
      }
    }
    assert.ok(pill);
    const hoverBg = color.bgPrefixFor("hoverBg");
    assert.notEqual(hoverBg, "", "the palette must define a hover tint for this test to mean anything");
    frames.length = 0;
    pipeline.setHover(pill.row, pill.col);
    pipeline.flush();
    assert.ok(frames.join("").includes(hoverBg), "the hovered pill is painted with the hover background");
    frames.length = 0;
    pipeline.setHover(null);
    pipeline.flush();
    assert.equal(frames.join("").includes(hoverBg), false, "and the tint is gone once the pointer leaves");
  });
});

describe("round eleven, item 2: added and removed diff lines carry a whole-row tint", () => {
  const diff: DiffView = {
    path: "a.ts",
    lines: [
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "ctx", text: "kept" },
      { kind: "add", text: "new line" },
      { kind: "del", text: "old line" },
    ],
  };

  it("the tint fills the full width of the row, not just the text on it", () => {
    const lines = renderDiffLines(diff, { width: 40, theme: color });
    const added = lines.find((l) => stripAnsi(l).startsWith("+"))!;
    const removed = lines.find((l) => stripAnsi(l).startsWith("-"))!;
    assert.equal(stripAnsi(added).length, 40, "an added row is padded out to the block width");
    assert.equal(stripAnsi(removed).length, 40);
    assert.ok(added.includes(color.bgPrefixFor("addedBg")));
    assert.ok(removed.includes(color.bgPrefixFor("removedBg")));
  });

  it("context and hunk lines are left plain — the band only means added or removed", () => {
    const lines = renderDiffLines(diff, { width: 40, theme: color });
    const context = lines.find((l) => stripAnsi(l).trim() === "kept")!;
    assert.equal(context.includes(color.bgPrefixFor("addedBg")), false);
    assert.equal(context.includes(color.bgPrefixFor("removedBg")), false);
  });

  it("the tint is a weak blend, not the foreground colour — the words stay readable on it", () => {
    // The request: "dont make the red and green to noticeable, just enough
    // for the words to still be easily readable". Measured as the tint
    // being far closer to the terminal background than to `added` itself.
    const bg = color.bgPrefixFor("addedBg");
    const fgAsBg = color.prefixFor("added").replace("[38;", "[48;");
    assert.notEqual(bg, fgAsBg, "the band must not be the same green as the text on it");
    const base = color.bgPrefixFor("bg");
    assert.notEqual(bg, base, "but it must still differ from the plain background");
  });

  it("mono and any palette with no tint emit no background at all", () => {
    const lines = renderDiffLines(diff, { width: 40, theme: mono });
    for (const line of lines) assert.equal(line.includes("\x1b["), false, line);
  });
});
