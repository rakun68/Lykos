import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeLayout } from "./layout.js";

const SIZES = [
  { width: 200, height: 60 },
  { width: 120, height: 40 },
  { width: 80, height: 24 },
  { width: 40, height: 10 },
];

describe("T42.1: computeLayout tiles the frame with no gap and no overlap", () => {
  for (const { width, height } of SIZES) {
    it(`${width}x${height}, footer visible`, () => {
      const layout = computeLayout({
        width,
        height,
        headerHeight: 1,
        footerVisible: true,
        footerHeight: 1,
        composerHeight: 1,
      });
      // Sorted by actual position rather than listed in a fixed name order:
      // `completionAbove` (default true since 2026-09-02 round three) puts
      // the completion region before the composer in the frame, which this
      // generic "no gap, no overlap" check should hold under either way the
      // two are arranged. A zero-height region ties on `top` with whatever
      // sits at that same point, so height breaks the tie — a zero-height
      // entry sorts first, which is the only order consistent with it
      // contributing nothing to the walk below.
      const regions = [layout.header, layout.viewport, layout.status, layout.composer, layout.completion, layout.footer].sort(
        (a, b) => a.top - b.top || a.height - b.height,
      );
      let expectedTop = 0;
      for (const r of regions) {
        assert.equal(r.top, expectedTop, `region starts where the previous one ended at ${width}x${height}`);
        expectedTop += r.height;
      }
      assert.equal(expectedTop, height, `regions sum to the full height at ${width}x${height}`);
    });

    it(`${width}x${height}, footer hidden — viewport grows, no reserved blank row`, () => {
      const shown = computeLayout({ width, height, headerHeight: 1, footerVisible: true, footerHeight: 1, composerHeight: 1 });
      const hidden = computeLayout({ width, height, headerHeight: 1, footerVisible: false, footerHeight: 1, composerHeight: 1 });
      assert.equal(hidden.footer.height, 0);
      assert.equal(hidden.viewport.height, shown.viewport.height + shown.footer.height);
    });
  }

  it("a very short frame never produces a negative-height region", () => {
    const layout = computeLayout({ width: 40, height: 2, headerHeight: 1, footerVisible: true, footerHeight: 1, composerHeight: 1 });
    for (const r of [layout.header, layout.viewport, layout.status, layout.composer, layout.completion, layout.footer]) {
      assert.ok(r.height >= 0);
    }
  });

  it("the ledger footer is the last row of the frame, below the composer (2026-09-02 reorder)", () => {
    const layout = computeLayout({ width: 80, height: 24, headerHeight: 1, footerVisible: true, footerHeight: 1, composerHeight: 3 });
    assert.equal(layout.footer.top, 23);
    assert.ok(layout.composer.top < layout.footer.top, "composer sits above the footer");
  });

  it("the status region takes its row from the viewport and pushes nothing else", () => {
    const off = computeLayout({ width: 80, height: 24, headerHeight: 1, footerVisible: true, footerHeight: 1, composerHeight: 3 });
    const on = computeLayout({ width: 80, height: 24, headerHeight: 1, footerVisible: true, footerHeight: 1, composerHeight: 3, statusHeight: 1 });
    assert.equal(on.viewport.height, off.viewport.height - 1);
    assert.equal(on.composer.top, off.composer.top);
    assert.equal(on.footer.top, off.footer.top);
    assert.equal(on.status.top, on.viewport.top + on.viewport.height);
  });

  it("multi-row composer grows and the viewport shrinks by exactly that many rows", () => {
    const one = computeLayout({ width: 80, height: 24, headerHeight: 1, footerVisible: true, footerHeight: 1, composerHeight: 1 });
    const three = computeLayout({ width: 80, height: 24, headerHeight: 1, footerVisible: true, footerHeight: 1, composerHeight: 3 });
    assert.equal(three.composer.height, 3);
    assert.equal(three.viewport.height, one.viewport.height - 2);
  });
});
