import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FrameWriter, clipToWidth, makeFrame, visibleWidth, type Frame } from "./frame.js";

function sink() {
  const out: string[] = [];
  return { out, write: (t: string) => void out.push(t) };
}

/** A frame of `height` rows reading "row 0", "row 1", ... — enough to tell rows apart in the emitted bytes. */
function rows(width: number, height: number, mutate?: (i: number) => string | undefined): Frame {
  const lines: string[] = [];
  for (let i = 0; i < height; i++) lines.push(mutate?.(i) ?? `row ${i}`);
  return makeFrame(width, height, lines);
}

describe("visibleWidth / clipToWidth: a line never wraps", () => {
  it("ignores SGR escapes when measuring", () => {
    assert.equal(visibleWidth("\x1b[31mred\x1b[0m"), 3);
    assert.equal(visibleWidth("plain"), 5);
  });

  it("clips to the visible column count, not the byte count", () => {
    assert.equal(clipToWidth("abcdef", 3), "abc");
    assert.equal(visibleWidth(clipToWidth("\x1b[31mabcdef\x1b[0m", 3)), 3);
  });

  it("never cuts an escape sequence in half", () => {
    const clipped = clipToWidth("\x1b[38;5;213mabcdef", 3);
    assert.equal(clipped, "\x1b[38;5;213mabc\x1b[0m");
  });

  it("closes open styling at the cut so a clip cannot leak colour across the screen", () => {
    assert.ok(clipToWidth("\x1b[31mabcdef", 2).endsWith("\x1b[0m"));
    // Nothing was styled, so nothing needs resetting.
    assert.equal(clipToWidth("abcdef", 2), "ab");
  });

  it("leaves a short line alone and handles a zero width", () => {
    assert.equal(clipToWidth("ab", 10), "ab");
    assert.equal(clipToWidth("ab", 0), "");
  });
});

describe("makeFrame: a frame is the whole screen", () => {
  it("pads short input to exactly height rows", () => {
    const f = makeFrame(10, 4, ["a", "b"]);
    assert.equal(f.lines.length, 4);
    assert.deepEqual(f.lines, ["a", "b", "", ""]);
  });

  it("drops rows past height and clips every row to width", () => {
    const f = makeFrame(3, 2, ["abcdef", "ghijkl", "mnopqr"]);
    assert.deepEqual(f.lines, ["abc", "ghi"]);
  });

  it("no row ever exceeds the frame width, at any width", () => {
    for (const width of [40, 60, 80, 120, 200]) {
      const f = makeFrame(width, 10, Array.from({ length: 10 }, () => "x".repeat(500)));
      for (const line of f.lines) assert.equal(visibleWidth(line), width);
    }
  });
});

describe("T41.3: the diff writer emits only what changed", () => {
  it("the first frame is a full redraw, clear screen included", () => {
    const s = sink();
    const w = new FrameWriter(s);
    const result = w.write(rows(20, 5));
    assert.equal(result.full, true);
    assert.equal(result.linesDrawn, 5);
    assert.ok(s.out.join("").startsWith("\x1b[H\x1b[2J"));
    assert.equal(w.fullRedraws, 1);
  });

  it("an identical frame emits nothing at all", () => {
    const s = sink();
    const w = new FrameWriter(s);
    w.write(rows(20, 5));
    s.out.length = 0;
    const result = w.write(rows(20, 5));
    assert.equal(s.out.join(""), "");
    assert.equal(result.bytes, 0);
    assert.equal(result.linesDrawn, 0);
  });

  it("a one-line change repositions and rewrites exactly that row", () => {
    const s = sink();
    const w = new FrameWriter(s);
    w.write(rows(20, 5));
    s.out.length = 0;
    const result = w.write(rows(20, 5, (i) => (i === 2 ? "CHANGED" : undefined)));
    assert.equal(result.full, false);
    assert.equal(result.linesDrawn, 1);
    // Row index 2 is terminal row 3 (CUP is 1-based).
    assert.equal(s.out.join(""), "\x1b[3;1HCHANGED\x1b[K");
    assert.equal(w.diffWrites, 1);
    assert.equal(w.fullRedraws, 1);
  });

  it("ACCEPTANCE: a one-line change costs fewer bytes than a full redraw", () => {
    const s = sink();
    const w = new FrameWriter(s);
    const before = rows(200, 60);
    const after = rows(200, 60, (i) => (i === 30 ? "one changed row" : undefined));
    w.write(before);
    const diff = w.write(after);
    const full = FrameWriter.fullRedrawBytes(after);
    assert.equal(diff.full, false);
    assert.ok(
      diff.bytes < full,
      `diff ${diff.bytes}B should be cheaper than a full redraw ${full}B`,
    );
    // Not merely cheaper — cheaper by the order of magnitude the 30Hz
    // budget in T50.3 depends on. At 200x60 a full redraw is ~1KB+ and one
    // row is a couple of dozen bytes.
    assert.ok(diff.bytes * 20 < full, `diff ${diff.bytes}B vs full ${full}B is not the saving the budget assumes`);
  });

  it("each changed row erases to end of line, so a shortened row leaves no stale cells", () => {
    const s = sink();
    const w = new FrameWriter(s);
    w.write(makeFrame(20, 2, ["a long line here", "second"]));
    s.out.length = 0;
    w.write(makeFrame(20, 2, ["short", "second"]));
    assert.equal(s.out.join(""), "\x1b[1;1Hshort\x1b[K");
  });

  it("reset() forces the next write to be a full redraw", () => {
    const s = sink();
    const w = new FrameWriter(s);
    w.write(rows(20, 5));
    w.reset();
    s.out.length = 0;
    const result = w.write(rows(20, 5));
    assert.equal(result.full, true);
    assert.ok(s.out.join("").startsWith("\x1b[H\x1b[2J"));
  });
});

describe("T41.5 acceptance: resizing mid-stream produces a correct frame at every step", () => {
  it("200x60 -> 40x10 -> 200x60 is a full redraw at each step, with no stale cells and no wrap", () => {
    const s = sink();
    const w = new FrameWriter(s);
    const sizes: Array<[number, number]> = [
      [200, 60],
      [40, 10],
      [200, 60],
    ];
    for (const [columns, rowCount] of sizes) {
      s.out.length = 0;
      // Content wider and taller than the smallest size, so a missed clip
      // or a missed truncation would show up as a wrapped row.
      const frame = makeFrame(
        columns,
        rowCount,
        Array.from({ length: 80 }, (_, i) => `\x1b[36mstreaming line ${i} ${"=".repeat(300)}\x1b[0m`),
      );
      const result = w.write(frame);
      const payload = s.out.join("");
      assert.equal(result.full, true, `${columns}x${rowCount} must be a full redraw`);
      assert.ok(payload.startsWith("\x1b[H\x1b[2J"), "a resize clears before it draws");
      assert.equal(frame.lines.length, rowCount);
      for (const line of frame.lines) assert.equal(visibleWidth(line), columns);
      // Exactly `rowCount` cursor positions: no row is drawn twice and none
      // is left out, at either size.
      assert.equal(payload.match(/\x1b\[\d+;1H/g)?.length, rowCount);
      const lastRow = Number(/\x1b\[(\d+);1H(?![\s\S]*\x1b\[\d+;1H)/.exec(payload)?.[1]);
      assert.equal(lastRow, rowCount, "the last row drawn is the last row of the screen");
    }
  });

  it("a shrink then a same-size frame goes back to diffing, not redrawing forever", () => {
    const s = sink();
    const w = new FrameWriter(s);
    w.write(rows(200, 60));
    w.write(rows(40, 10));
    const result = w.write(rows(40, 10, (i) => (i === 1 ? "changed after the resize" : undefined)));
    assert.equal(result.full, false);
    assert.equal(result.linesDrawn, 1);
    assert.equal(w.fullRedraws, 2);
    assert.equal(w.diffWrites, 1);
  });
});
