import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatCents } from "../src/pricing.js";

describe("formatCents", () => {
  it("prints dollars and cents", () => {
    assert.equal(formatCents(150), "$1.50");
  });

  it("pads single-digit cents", () => {
    assert.equal(formatCents(1005), "$10.05");
  });
});
