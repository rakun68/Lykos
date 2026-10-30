// The 2026-09-02 UI feedback round, end to end. Eight numbered requests
// arrived in one message; this file asserts the behaviour each one asked
// for, in the same order, so a later change that quietly undoes one of
// them fails with the request itself in the test name rather than as an
// unexplained diff.
//
// Items whose whole surface is already covered where it belongs are
// asserted there instead and named here: item 5's window arithmetic lives
// in completion.test.ts, item 3's and item 7's key encodings in
// input.test.ts, and item 2's row order in layout.test.ts / app.test.ts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LineEditor } from "../editor.js";
import { osc52 } from "../clipboard.js";
import { resolveTheme } from "../theme/resolve.js";
import { renderScreenBlock, toScrollbackBlock, type ScreenBlock } from "./blocks.js";
import { COMPOSER_PREFIX_WIDTH, renderComposer } from "./composer.js";
import type { FrameSink } from "./frame.js";
import { ScreenPipeline } from "./pipeline.js";
import { RawLineSource } from "./raw-line-source.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

const header = {
  product: "LYKOS",
  version: "0.0.1",
  model: "deepseek-v4-flash",
  cwd: "~/w",
  branch: null,
  sessionId: "abc12345",
  executionShape: "standalone",
};

describe("item 1: a blank line between every block in the transcript", () => {
  it("every block kind ends with one plain, untinted blank row", () => {
    const blocks: ScreenBlock[] = [
      { id: "u", kind: "user", text: "hello" },
      { id: "t", kind: "thinking", text: "hmm" },
      { id: "s", kind: "speech", text: "hi there" },
      { id: "y", kind: "system", text: "note" },
    ];
    for (const block of blocks) {
      const lines = toScrollbackBlock(block, mono).render(40);
      assert.equal(lines.at(-1), "", `${block.kind} does not end with a separator row`);
      assert.equal(lines.length, renderScreenBlock(block, { width: 40, theme: mono }).length + 1);
    }
  });

  it("a thinking block followed by speech is separated by a genuinely blank row", () => {
    const thinking = toScrollbackBlock({ id: "t", kind: "thinking", text: "hmm" }, mono).render(40);
    const speech = toScrollbackBlock({ id: "s", kind: "speech", text: "hi" }, mono).render(40);
    assert.equal(thinking.at(-1), "");
    assert.notEqual(speech[0], "", "the speech block itself starts with content, not another blank");
  });
});

describe("item 4: no caret while the loading line is up", () => {
  function sinkCapturing(out: string[]): FrameSink {
    return { write: (t: string) => void out.push(t) };
  }

  it("the cursor is hidden while a status line is set and comes back when it clears", () => {
    const out: string[] = [];
    const pipeline = new ScreenPipeline({ width: 40, height: 12, theme: mono, header, sink: sinkCapturing(out), maxHz: 1000 });
    pipeline.setCursor({ row: 9, col: 4 });
    pipeline.flush();
    assert.ok(out.join("").includes("\x1b[?25h"), "caret shown with no status line");

    out.length = 0;
    pipeline.setStatus("working");
    pipeline.flush();
    const busy = out.join("");
    assert.ok(busy.includes("\x1b[?25l"), "caret hidden while the status line shows");
    assert.ok(!busy.includes("\x1b[?25h"), "and never re-shown in the same frame");

    out.length = 0;
    pipeline.setStatus(null);
    pipeline.flush();
    assert.ok(out.join("").includes("\x1b[?25h"), "caret returns the moment the status line clears");
  });
});

describe("item 6: one dot opens each answer, and column 0 is a marker or blank", () => {
  it("a speech block starts with the bullet glyph and indents its continuation lines", () => {
    const lines = renderScreenBlock({ id: "s", kind: "speech", text: "one two three four five six seven" }, { width: 16, theme: mono });
    assert.ok(lines.length > 1, "text long enough to wrap");
    assert.ok(lines[0]!.startsWith("● "), `expected a bullet, got ${JSON.stringify(lines[0])}`);
    for (const line of lines.slice(1)) assert.ok(line.startsWith("  "), `continuation line not indented: ${JSON.stringify(line)}`);
  });

  it("no block kind renders a bare word at column 0 under the mono theme", () => {
    const blocks: ScreenBlock[] = [
      { id: "u", kind: "user", text: "hello" },
      { id: "t", kind: "thinking", text: "hmm" },
      { id: "s", kind: "speech", text: "hi" },
      { id: "y", kind: "system", text: "note" },
      { id: "r", kind: "read", path: "a/b.ts" },
      {
        id: "x",
        kind: "resources",
        resources: { contextEnabled: true, contextFiles: ["CLAUDE.md"], contextTokens: 100, skills: ["s"], extensions: [] },
      },
    ];
    const markers = new Set(["●", "│", ">", "⚡", "◆", "+", "-", " "]);
    for (const block of blocks) {
      for (const line of renderScreenBlock(block, { width: 40, theme: mono })) {
        if (line.length === 0) continue;
        assert.ok(markers.has(line[0]!), `${block.kind} starts a line with ${JSON.stringify(line[0])}: ${JSON.stringify(line)}`);
      }
    }
  });
});

describe("item 7: Ctrl+Backspace deletes a whole word", () => {
  it("0x08 removes the word behind the cursor, not one character", async () => {
    const src = new RawLineSource();
    const p = src.next();
    src.feedBytes("hello world\x08\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await p, "hello ");
  });

  it("at column 0 of a continued line it joins with the previous line rather than doing nothing", () => {
    const e = new LineEditor();
    e.insertText("one");
    e.newline();
    e.deleteWordBackward();
    assert.deepEqual(e.state.lines, ["one"]);
  });
});

describe("item 8: selection, undo/redo, clipboard, mouse", () => {
  it("Ctrl-A selects the whole buffer, including across lines", () => {
    const e = new LineEditor();
    e.insertText("one\ntwo");
    e.selectAll();
    assert.equal(e.selectedText(), "one\ntwo");
  });

  it("typing over a selection replaces it", () => {
    const e = new LineEditor();
    e.insertText("hello world");
    e.selectAll();
    e.insertChar("x");
    assert.deepEqual(e.state.lines, ["x"]);
  });

  it("Shift+arrow extends the selection; a plain arrow drops it", () => {
    const e = new LineEditor();
    e.insertText("abcdef");
    e.home();
    e.moveRight(true);
    e.moveRight(true);
    assert.equal(e.selectedText(), "ab");
    e.moveRight();
    assert.equal(e.selection, null);
  });

  it("Ctrl+Shift+arrow extends by word", () => {
    const e = new LineEditor();
    e.insertText("alpha beta");
    e.home();
    e.moveWordRight(true);
    assert.equal(e.selectedText(), "alpha");
  });

  it("a double-click takes the word under the cursor", () => {
    const e = new LineEditor();
    e.insertText("alpha beta gamma");
    e.moveTo(0, 8);
    e.selectWordAtCursor();
    assert.equal(e.selectedText(), "beta");
  });

  it("undo takes back a word at a time and redo puts it back", () => {
    const e = new LineEditor();
    for (const ch of "one two") e.insertChar(ch);
    assert.equal(e.text, "one two");
    e.undo();
    assert.equal(e.text, "one ", "the run since the last space is one undo step");
    e.redo();
    assert.equal(e.text, "one two");
  });

  it("undo returns false with nothing left rather than clearing the buffer", () => {
    const e = new LineEditor();
    e.insertChar("a");
    assert.equal(e.undo(), true);
    assert.equal(e.text, "");
    assert.equal(e.undo(), false);
  });

  it("cut removes the selection and copy leaves it in place; both fill the register", () => {
    const e = new LineEditor();
    e.insertText("hello world");
    e.home();
    e.moveWordRight(true);
    assert.equal(e.copy(), "hello");
    assert.equal(e.text, "hello world", "copy does not mutate");
    assert.equal(e.cut(), "hello");
    assert.equal(e.text, " world");
    assert.equal(e.clipboardRegister, "hello");
  });

  it("Ctrl-X then Ctrl-V round-trips through the register when no system clipboard answers", async () => {
    const src = new RawLineSource({ readClipboard: () => null });
    const p = src.next();
    src.feedBytes("word");
    src.feedBytes("\x01"); // Ctrl-A: select all
    src.feedBytes("\x18"); // Ctrl-X: cut
    src.feedBytes("kept ");
    src.feedBytes("\x16"); // Ctrl-V: paste
    src.feedBytes("\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await p, "kept word");
  });

  it("Ctrl-V prefers the system clipboard when it answers", async () => {
    const src = new RawLineSource({ readClipboard: () => "from-system" });
    const p = src.next();
    src.feedBytes("\x16\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await p, "from-system");
  });

  it("Ctrl-C copies a selection and clears it; the next Ctrl-C aborts", () => {
    const copied: string[] = [];
    let interrupts = 0;
    const src = new RawLineSource({ onCopy: (t) => void copied.push(t), onInterrupt: () => void (interrupts += 1) });
    src.feedBytes("hello");
    src.feedBytes("\x01"); // Ctrl-A
    src.feedBytes("\x03"); // Ctrl-C — copies
    assert.deepEqual(copied, ["hello"]);
    assert.equal(interrupts, 0);
    src.feedBytes("\x03"); // Ctrl-C again — nothing selected now, so it aborts
    assert.equal(interrupts, 1);
  });

  it("Ctrl-C with nothing selected aborts immediately, unchanged from before", () => {
    let interrupts = 0;
    const src = new RawLineSource({ onInterrupt: () => void (interrupts += 1) });
    src.feedBytes("hello\x03");
    assert.equal(interrupts, 1);
  });

  it("a click in the composer places the cursor and a drag extends the selection", () => {
    const src = new RawLineSource({
      composerGeometry: () => ({ firstBufferRow: 20, prefixWidth: COMPOSER_PREFIX_WIDTH, rowCount: 1 }),
    });
    src.feedBytes("hello world");
    // press at frame row 20, column 2 + 6 -> buffer (0, 6)
    src.feedBytes("\x1b[<0;9;21M");
    assert.equal(src.editorState.cursorCol, 6);
    // drag to column 2 + 11 -> buffer (0, 11)
    src.feedBytes("\x1b[<32;14;21M");
    assert.equal(src.editorState.selection?.start.col, 6);
    assert.equal(src.editorState.selection?.end.col, 11);
    src.feedBytes("\x1b[<0;14;21m");
  });

  it("a click outside the composer's rows is ignored, not mapped to row 0", () => {
    const src = new RawLineSource({
      composerGeometry: () => ({ firstBufferRow: 20, prefixWidth: COMPOSER_PREFIX_WIDTH, rowCount: 1 }),
    });
    src.feedBytes("hello");
    src.feedBytes("\x1b[<0;3;5M");
    assert.equal(src.editorState.cursorCol, 5, "cursor stayed where typing left it");
  });

  it("the composer paints the selection as a background span, leaving cursor columns untouched", () => {
    const e = new LineEditor();
    e.insertText("hello");
    e.home();
    e.moveRight(true);
    e.moveRight(true);
    const plain = renderComposer(e.state, mono, 20);
    const styled = renderComposer(e.state, color, 20);
    assert.equal(plain.lines[1], "> hello", "no escapes at all under the mono theme");
    assert.ok(styled.lines[1]!.includes("\x1b[48;"), "a background span under a colour theme");
    assert.equal(styled.cursorCol, plain.cursorCol, "highlighting adds only zero-width escapes");
  });

  it("OSC 52 carries the copied text base64-encoded, terminated so a terminal can find its end", () => {
    const seq = osc52("hi");
    assert.equal(seq, `\x1b]52;c;${Buffer.from("hi", "utf8").toString("base64")}\x07`);
  });
});

/** Kept last: the whole frame still assembles with everything above turned on at once. */
describe("the assembled frame after the round", () => {
  it("a status line and a multi-row composer leave the footer on the bottom row", () => {
    const pipeline = new ScreenPipeline({
      width: 60,
      height: 16,
      theme: mono,
      header,
      sink: { write: () => {} },
      maxHz: 1000,
    });
    pipeline.pushBlock({ id: "s", kind: "speech", text: "an answer" });
    pipeline.setComposerLines(["────", "> one", "  two", "────"]);
    pipeline.setStatus("working");
    pipeline.flush();
    // 16 rows: header 1, viewport 9, status 1, composer 4, footer 1.
    assert.equal(pipeline.composerTopRow(), 11);
  });
});
