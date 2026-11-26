import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fmtUsd, renderAvoidedSegment, sparkline, truncate } from "./format.js";

describe("sparkline", () => {
  it("renders unicode bars scaled to the series", () => {
    assert.equal(sparkline([0, 1], false), "▁█");
  });

  it("renders ascii bars under LYKOS_ASCII", () => {
    const s = sparkline([0, 0.5, 1], true);
    assert.equal(s.length, 3);
    assert.ok(!/[▁▂▃▄▅▆▇█]/.test(s));
  });

  it("empty in, empty out", () => {
    assert.equal(sparkline([], false), "");
  });

  it("a flat series uses the lowest bar, not a NaN", () => {
    assert.equal(sparkline([4, 4, 4], false), "▁▁▁");
  });
});

describe("truncate", () => {
  it("uses a unicode ellipsis by default", () => {
    assert.equal(truncate("abcdef", 4), "abc…");
  });

  it("uses ... under the ascii glyph set", () => {
    assert.equal(truncate("abcdef", 5, true), "ab...");
  });
});

describe("renderAvoidedSegment — never bare, never without spend", () => {
  it("returns null when the basis is missing", () => {
    assert.equal(renderAvoidedSegment(0.03, 0.01, null), null);
    assert.equal(renderAvoidedSegment(0.03, 0.01, ""), null);
  });

  it("returns null when spend is missing, even with a basis", () => {
    assert.equal(renderAvoidedSegment(null, 0.01, "cache_read"), null);
  });

  it("renders spend, ~avoided, and the basis together", () => {
    const s = renderAvoidedSegment(0.038, 0.01, "cache_read");
    assert.ok(s);
    assert.match(s, /\$0\.038/);
    assert.match(s, /~\$0\.010/);
    assert.match(s, /cache_read/);
  });

  it("fmtUsd still renders unpriced as $?", () => {
    assert.equal(fmtUsd(null), "$?");
  });
});
