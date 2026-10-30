import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LineEditor } from "./editor.js";

describe("T46.2: LineEditor — single-line editing", () => {
  it("insertChar appends and advances the cursor", () => {
    const e = new LineEditor();
    e.insertChar("h");
    e.insertChar("i");
    assert.equal(e.text, "hi");
    assert.equal(e.state.cursorCol, 2);
  });

  it("backspace removes the character before the cursor", () => {
    const e = new LineEditor();
    e.insertText("hello");
    e.backspace();
    assert.equal(e.text, "hell");
  });

  it("deleteForward removes the character at the cursor", () => {
    const e = new LineEditor();
    e.insertText("hello");
    e.home();
    e.deleteForward();
    assert.equal(e.text, "ello");
  });

  it("home/end move to the line boundaries", () => {
    const e = new LineEditor();
    e.insertText("hello");
    e.home();
    assert.equal(e.state.cursorCol, 0);
    e.end();
    assert.equal(e.state.cursorCol, 5);
  });

  it("moveLeft/moveRight move by one character and stop at the boundary", () => {
    const e = new LineEditor();
    e.insertText("hi");
    e.moveLeft();
    e.moveLeft();
    e.moveLeft(); // already at 0 — no-op
    assert.equal(e.state.cursorCol, 0);
    e.moveRight();
    e.moveRight();
    e.moveRight(); // already at end — no-op
    assert.equal(e.state.cursorCol, 2);
  });

  it("moveWordLeft/moveWordRight skip whole words", () => {
    const e = new LineEditor();
    e.insertText("hello world foo");
    e.moveWordLeft();
    assert.equal(e.state.cursorCol, 12); // start of "foo"
    e.moveWordLeft();
    assert.equal(e.state.cursorCol, 6); // start of "world"
    e.moveWordRight();
    assert.equal(e.state.cursorCol, 11); // end of "world"
  });

  it("Ctrl-K kills to end of line", () => {
    const e = new LineEditor();
    e.insertText("hello world");
    e.moveWordLeft();
    e.killToEnd();
    assert.equal(e.text, "hello ");
  });

  it("Ctrl-U kills to start of line", () => {
    const e = new LineEditor();
    e.insertText("hello world");
    e.moveWordLeft();
    e.killLine();
    assert.equal(e.text, "world");
  });

  it("Ctrl-W deletes the word before the cursor", () => {
    const e = new LineEditor();
    e.insertText("hello world");
    e.deleteWordBackward();
    assert.equal(e.text, "hello ");
  });
});

describe("T46.2: LineEditor — multi-line", () => {
  it("newline() splits the buffer at the cursor", () => {
    const e = new LineEditor();
    e.insertText("hello world");
    e.moveWordLeft();
    e.newline();
    assert.equal(e.text, "hello \nworld");
    assert.equal(e.lineCount, 2);
  });

  it("backspace at column 0 joins with the previous line", () => {
    const e = new LineEditor();
    e.insertText("hello");
    e.newline();
    e.insertText("world");
    e.home();
    e.backspace();
    assert.equal(e.text, "helloworld");
    assert.equal(e.lineCount, 1);
  });

  it("moveUp/moveDown return false at the top/bottom row so the caller can fall through to history", () => {
    const e = new LineEditor();
    assert.equal(e.moveUp(), false);
    assert.equal(e.moveDown(), false);
    e.insertText("a");
    e.newline();
    e.insertText("b");
    assert.equal(e.moveUp(), true);
    assert.equal(e.moveUp(), false); // already at row 0
  });

  it("insertText with embedded newlines creates real line breaks — a paste is one operation", () => {
    const e = new LineEditor();
    e.insertText("a\nb\nc");
    assert.equal(e.lineCount, 3);
    assert.equal(e.text, "a\nb\nc");
  });

  it("reset() seeds a fresh buffer with the cursor at the end", () => {
    const e = new LineEditor();
    e.insertText("stale");
    e.reset("fresh");
    assert.equal(e.text, "fresh");
    assert.equal(e.state.cursorCol, 5);
    e.reset();
    assert.equal(e.text, "");
  });
});
