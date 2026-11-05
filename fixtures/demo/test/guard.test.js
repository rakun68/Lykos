import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCents } from "../src/pricing.js";

describe("formatCents refuses what SPEC.md forbids", () => {
  it("refuses a negative amount", () => {
    assert.throws(() => formatCents(-1), RangeError);
  });

  it("refuses a fraction of a cent", () => {
    assert.throws(() => formatCents(1.5), TypeError);
  });
});
