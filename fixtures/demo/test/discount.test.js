import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyDiscount } from "../src/pricing.js";

describe("applyDiscount", () => {
  it("takes 10% off", () => {
    assert.equal(applyDiscount(1000, 10), 900);
  });

  it("leaves the price alone at 0%", () => {
    assert.equal(applyDiscount(1000, 0), 1000);
  });

  it("halves the price at 50%, rounding half up", () => {
    assert.equal(applyDiscount(999, 50), 500);
  });
});
