// T150: the pure rule that turns `context_strategy` into the one active strategy.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_CONTEXT_STRATEGY, resolveContextStrategy } from "./context-strategy.js";

const BOTH = ["lykos-continuation", "lykos-self-compact"];

describe("resolveContextStrategy (T150)", () => {
  it("defaults to self-compact, active when its extension is declared (T152: no longer a fallback to pi)", () => {
    assert.equal(DEFAULT_CONTEXT_STRATEGY, "self-compact");
    assert.deepEqual(resolveContextStrategy(undefined, BOTH), { declared: "self-compact", active: "self-compact" });
    assert.deepEqual(resolveContextStrategy("self-compact", BOTH), { declared: "self-compact", active: "self-compact" });
  });

  it("self-compact without lykos-self-compact declared falls back to pi and says so", () => {
    const missing = resolveContextStrategy("self-compact", ["lykos-continuation"]);
    assert.equal(missing.active, "pi");
    assert.match(missing.note ?? "", /needs the lykos-self-compact extension/);
  });

  it("continue is active when its extension is declared, silently", () => {
    assert.deepEqual(resolveContextStrategy("continue", BOTH), { declared: "continue", active: "continue" });
  });

  it("continue without lykos-continuation declared falls back to pi and says so", () => {
    const r = resolveContextStrategy("continue", []);
    assert.equal(r.active, "pi");
    assert.match(r.note ?? "", /needs the lykos-continuation extension/);
  });

  it("pi is always available and needs no extension", () => {
    assert.deepEqual(resolveContextStrategy("pi", []), { declared: "pi", active: "pi" });
  });

  it("an unknown value falls back to pi and names the allowed values", () => {
    const r = resolveContextStrategy("summarize", BOTH);
    assert.equal(r.active, "pi");
    assert.match(r.note ?? "", /"summarize" is not one of self-compact, continue, pi/);
  });
});
