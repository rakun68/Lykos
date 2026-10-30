import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LineEditor } from "../editor.js";
import { resolveTheme } from "../theme/resolve.js";
import { renderComposer } from "./composer.js";

const mono = resolveTheme("mono", "none", "unicode");

describe("renderComposer: LineEditor state to display lines + cursor position", () => {
  it("a single-line buffer gets the prompt prefix, framed by a top and bottom border rule", () => {
    const e = new LineEditor();
    e.insertText("hi");
    const r = renderComposer(e.state, mono, 10);
    assert.deepEqual(r.lines, ["──────────", "> hi", "──────────"]);
    assert.equal(r.cursorRow, 1, "row 0 is the top border, so the buffer's own row 0 lands at frame row 1");
    assert.equal(r.cursorCol, 4); // "> " (2) + cursor at col 2 of "hi"
  });

  it("cursor moved to the start of the line lands right after the prompt", () => {
    const e = new LineEditor();
    e.insertText("hi");
    e.home();
    const r = renderComposer(e.state, mono, 10);
    assert.equal(r.cursorCol, 2); // "> ".length
  });

  it("a multi-line buffer prefixes continuation lines differently from the first", () => {
    const e = new LineEditor();
    e.insertText("first");
    e.newline();
    e.insertText("second");
    const r = renderComposer(e.state, mono, 10);
    assert.equal(r.lines[1], "> first");
    assert.equal(r.lines[2], "  second");
    assert.equal(r.cursorRow, 2, "buffer row 1 (0-indexed) lands at frame row 2, one past the top border");
    assert.equal(r.cursorCol, 2 + "second".length); // continuation prefix is also 2 columns wide
  });

  it("styling never changes the cursor column — it's plain-prefix-width math, not styled-string length", () => {
    const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");
    const e = new LineEditor();
    e.insertText("abc");
    const plain = renderComposer(e.state, mono, 10);
    const colored = renderComposer(e.state, color, 10);
    assert.equal(plain.cursorCol, colored.cursorCol);
    // The coloured version actually carries escape codes on the text row; the plain one doesn't.
    assert.doesNotMatch(plain.lines[1]!, /\x1b\[/);
    assert.match(colored.lines[1]!, /\x1b\[/);
  });

  it("an empty buffer still renders the bare prompt with the cursor right after it", () => {
    const e = new LineEditor();
    const r = renderComposer(e.state, mono, 10);
    assert.deepEqual(r.lines, ["──────────", "> ", "──────────"]);
    assert.equal(r.cursorCol, 2);
  });

  it("the border rules span the full requested width", () => {
    const e = new LineEditor();
    const r = renderComposer(e.state, mono, 24);
    assert.equal(r.lines[0]!.length, 24);
    assert.equal(r.lines.at(-1)!.length, 24);
  });

  it("LYKOS_ASCII=1 renders the border in ASCII, no stray unicode", () => {
    const ascii = resolveTheme("mono", "none", "ascii");
    const e = new LineEditor();
    const r = renderComposer(e.state, ascii, 10);
    assert.equal(r.lines[0], "-".repeat(10));
    assert.equal(r.lines.at(-1), "-".repeat(10));
  });
});
