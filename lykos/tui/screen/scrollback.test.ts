import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Scrollback, wrapPlain, type ScrollbackBlock } from "./scrollback.js";

function lineBlock(id: string, text: string): ScrollbackBlock {
  return { id, render: () => [text] };
}

function pushMany(sb: Scrollback, n: number, width: number, prefix = "line"): void {
  for (let i = 0; i < n; i++) sb.push(lineBlock(`${prefix}-${i}`, `${prefix} ${i}`), width);
}

describe("T43.1/T43.2: the scrollback engine", () => {
  it("following the tail shows the most recent `height` lines", () => {
    const sb = new Scrollback();
    pushMany(sb, 100, 80);
    const vp = sb.viewport(80, 10);
    assert.equal(vp.lines.length, 10);
    assert.equal(vp.lines[9], "line 99");
    assert.equal(vp.lines[0], "line 90");
    assert.equal(vp.following, true);
  });

  it("scrolling up stops following and does not move when new lines arrive", () => {
    const sb = new Scrollback();
    pushMany(sb, 100, 80);
    sb.scrollUp(20, 80, 10);
    const before = sb.viewport(80, 10);
    assert.equal(before.following, false);
    pushMany(sb, 500, 80, "later");
    const after = sb.viewport(80, 10);
    assert.deepEqual(after.lines, before.lines, "500 new lines arriving must not move a scrolled-back viewport");
    assert.equal(after.newLinesBelow, 500);
  });

  it("End re-arms followTail and jumps back to the live tail", () => {
    const sb = new Scrollback();
    pushMany(sb, 100, 80);
    sb.scrollUp(50, 80, 10);
    sb.end();
    const vp = sb.viewport(80, 10);
    assert.equal(vp.following, true);
    assert.equal(vp.lines[9], "line 99");
  });

  it("Home jumps to the top of the document", () => {
    const sb = new Scrollback();
    pushMany(sb, 100, 80);
    sb.home(80, 10);
    const vp = sb.viewport(80, 10);
    assert.equal(vp.lines[0], "line 0");
  });

  it("PgUp/PgDn move by roughly a page", () => {
    const sb = new Scrollback();
    pushMany(sb, 100, 80);
    sb.pageUp(80, 10);
    const afterUp = sb.viewport(80, 10);
    assert.equal(afterUp.lines[9], "line 90"); // one page (9 lines) back from the tail
    sb.pageDown(80, 10);
    const afterDown = sb.viewport(80, 10);
    assert.equal(afterDown.following, true);
  });

  it("the wrap cache is used: scrolling does not re-render blocks already wrapped at this width", () => {
    const sb = new Scrollback();
    pushMany(sb, 200, 80);
    const callsAfterPush = sb.renderCalls;
    sb.scrollUp(5, 80, 10);
    sb.viewport(80, 10);
    sb.scrollUp(5, 80, 10);
    sb.viewport(80, 10);
    assert.equal(sb.renderCalls, callsAfterPush, "no additional render() calls from scrolling at the same width");
  });

  it("T43.4: bounded memory drops the oldest blocks and names a marker, never truncating silently", () => {
    const sb = new Scrollback({ maxLines: 50 });
    pushMany(sb, 200, 80);
    const vp = sb.viewport(80, 10);
    assert.ok(vp.droppedMarker, "a marker is present once content has been dropped");
    assert.match(vp.droppedMarker!, /lykos show/);
    assert.equal(vp.lines[9], "line 199", "the tail is still intact after dropping the oldest blocks");
  });

  it("10,000 streamed lines: the viewport is still correct at the tail", () => {
    const sb = new Scrollback({ maxLines: 20000 });
    pushMany(sb, 10000, 80);
    const vp = sb.viewport(80, 24);
    assert.equal(vp.lines.at(-1), "line 9999");
    assert.equal(vp.lines.length, 24);
  });

  it("resize invalidates the wrap cache and re-renders at the new width", () => {
    const sb = new Scrollback();
    const block: ScrollbackBlock = { id: "x", render: (w) => [`w=${w}`] };
    sb.push(block, 80);
    const before = sb.renderCalls;
    sb.viewport(80, 5); // same width — no extra render
    assert.equal(sb.renderCalls, before);
    const vp = sb.viewport(120, 5); // resize
    // Short content pads at the BOTTOM since 2026-09-02 round five, item 2
    // ("I want when start, the first messages start on top of the page
    // instead at the bottom") — the one real line is now at index 0, not
    // the tail.
    assert.equal(vp.lines.at(0), "w=120");
    assert.equal(sb.renderCalls, before + 1);
  });

  it("wrapPlain: greedy word wrap never exceeds the width and preserves blank paragraph lines", () => {
    const wrapped = wrapPlain("a b c d e f g h i j", 5);
    for (const line of wrapped) assert.ok(line.length <= 5, `"${line}" exceeds width 5`);
    assert.deepEqual(wrapPlain("hello\n\nworld", 20), ["hello", "", "world"]);
  });
});

describe("updateBlock: mutate-in-place, for streaming text and tool status", () => {
  it("replaces a block by id in place, wherever it is, not just the most recent one", () => {
    const sb = new Scrollback();
    sb.push(lineBlock("a", "first"), 80);
    sb.push(lineBlock("b", "second"), 80);
    sb.push(lineBlock("c", "third"), 80);
    const ok = sb.updateBlock("a", lineBlock("a", "first (updated)"), 80);
    assert.equal(ok, true);
    const vp = sb.viewport(80, 3);
    assert.deepEqual(vp.lines, ["first (updated)", "second", "third"]);
  });

  it("a growing block (streaming text) is what a caller uses to keep one paragraph flowing, not one line per delta", () => {
    const sb = new Scrollback();
    sb.push(lineBlock("assistant-1", "Hel"), 80);
    sb.updateBlock("assistant-1", lineBlock("assistant-1", "Hello"), 80);
    sb.updateBlock("assistant-1", lineBlock("assistant-1", "Hello world"), 80);
    const vp = sb.viewport(80, 1);
    assert.deepEqual(vp.lines, ["Hello world"]);
  });

  it("returns false and changes nothing for an id that does not exist", () => {
    const sb = new Scrollback();
    sb.push(lineBlock("a", "first"), 80);
    const ok = sb.updateBlock("missing", lineBlock("missing", "x"), 80);
    assert.equal(ok, false);
    assert.deepEqual(sb.viewport(80, 1).lines, ["first"]);
  });

  it("a scrolled-back reader's position is preserved the same way push() preserves it, accounting for the length delta", () => {
    const sb = new Scrollback();
    for (let i = 0; i < 50; i++) sb.push(lineBlock(`l${i}`, `line ${i}`), 80);
    sb.scrollUp(20, 80, 10);
    const before = sb.viewport(80, 10);
    sb.updateBlock("l25", lineBlock("l25", "line 25 (longer than before)"), 80);
    const after = sb.viewport(80, 10);
    assert.equal(after.lines.filter((l) => l.startsWith("line 25")).length <= 1, true);
    // The rest of the scrolled-back view is otherwise stable — only the
    // updated line's own text changed.
    assert.deepEqual(
      after.lines.filter((l) => !l.startsWith("line 25")),
      before.lines.filter((l) => !l.startsWith("line 25")),
    );
  });

  it("the wrap cache entry for the old block content is gone — updateBlock() does not leak stale cache", () => {
    const sb = new Scrollback();
    sb.push(lineBlock("a", "one line"), 80);
    const before = sb.renderCalls;
    sb.updateBlock("a", lineBlock("a", "a different line"), 80);
    // The update itself is a genuine re-render (a cache miss for the new content).
    assert.equal(sb.renderCalls, before + 1);
    sb.viewport(80, 1);
    // Reading it back afterward is a cache hit, not another render.
    assert.equal(sb.renderCalls, before + 1);
  });
});

describe("T43.5: incremental search (cuttable, implemented minimally)", () => {
  it("finds matches and cycles through them", () => {
    const sb = new Scrollback();
    sb.push(lineBlock("a", "apple"), 80);
    sb.push(lineBlock("b", "banana"), 80);
    sb.push(lineBlock("c", "grape"), 80);
    sb.push(lineBlock("d", "pineapple"), 80);
    const count = sb.search("apple", 80);
    assert.equal(count, 2);
    assert.equal(sb.matchedLineIndices().length, 2);
    const first = sb.nextMatch(80, 10);
    const second = sb.nextMatch(80, 10);
    const wrapped = sb.nextMatch(80, 10);
    assert.notEqual(first, second);
    assert.equal(wrapped, first, "cycling past the last match wraps to the first");
  });

  it("an empty query clears the search", () => {
    const sb = new Scrollback();
    sb.push(lineBlock("a", "apple"), 80);
    sb.search("apple", 80);
    assert.equal(sb.search("", 80), 0);
    assert.deepEqual(sb.matchedLineIndices(), []);
  });
});
