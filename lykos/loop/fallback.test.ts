import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_MAX_SWITCHES,
  decideFallback,
  newFallbackState,
  recordSwitch,
  resolveFallbackPolicy,
  serializeFallbacks,
} from "./fallback.js";

const CURRENT = "deepseek/deepseek-v4-flash";
const ALT = "anthropic/claude-haiku-4-5-20251001";

describe("resolveFallbackPolicy", () => {
  it("is off when nothing is configured -- the shipped default", () => {
    assert.deepEqual(resolveFallbackPolicy(undefined), { chain: [], maxSwitches: DEFAULT_MAX_SWITCHES });
    assert.deepEqual(resolveFallbackPolicy({}), { chain: [], maxSwitches: DEFAULT_MAX_SWITCHES });
  });

  it("drops a malformed spec rather than resolving it to first-available", () => {
    const p = resolveFallbackPolicy({ chain: ["not-a-spec", ALT, 42, ALT] });
    assert.deepEqual(p.chain, [ALT], "no duplicates, no bare model names, no non-strings");
  });

  it("takes an explicit switch limit", () => {
    assert.equal(resolveFallbackPolicy({ chain: [ALT], max_switches: 3 }).maxSwitches, 3);
  });
});

describe("decideFallback", () => {
  const policy = resolveFallbackPolicy({ chain: [ALT] });

  it("does nothing at all when no fallback is configured", () => {
    const d = decideFallback({
      policy: resolveFallbackPolicy(undefined),
      state: newFallbackState(CURRENT),
      current: CURRENT,
      exhaustedRetry: true,
      error: "502",
    });
    assert.equal(d.action, "none");
  });

  it("NEVER switches on an ordinary failure -- only on an exhausted provider retry", () => {
    const d = decideFallback({
      policy,
      state: newFallbackState(CURRENT),
      current: CURRENT,
      exhaustedRetry: false,
      error: "tests failed",
    });
    assert.equal(d.action, "none");
    if (d.action === "none") assert.equal(d.why, "not a provider failure");
  });

  it("switches when the provider ran out of retries, and explains the cost", () => {
    const d = decideFallback({
      policy,
      state: newFallbackState(CURRENT),
      current: CURRENT,
      exhaustedRetry: true,
      error: "429 rate limit",
    });
    assert.equal(d.action, "switch");
    if (d.action !== "switch") return;
    assert.equal(d.to, ALT);
    assert.ok(d.note.includes("429 rate limit"), "the human is told why");
    assert.ok(d.note.includes("full cache write"), "the cost is stated, never hidden");
    assert.ok(d.note.includes("must not be summed"), "the price-basis trap is named");
  });

  it("never revisits a model it already tried", () => {
    const state = newFallbackState(CURRENT);
    recordSwitch(state, CURRENT, ALT, "429");
    const d = decideFallback({
      policy: resolveFallbackPolicy({ chain: [ALT], max_switches: 5 }),
      state,
      current: ALT,
      exhaustedRetry: true,
      error: "502",
    });
    assert.equal(d.action, "none");
    if (d.action === "none") assert.equal(d.why, "every configured fallback already tried");
  });

  it("stops at the switch limit so a bad day cannot walk the chain forever", () => {
    const state = newFallbackState(CURRENT);
    recordSwitch(state, CURRENT, ALT, "429");
    const d = decideFallback({
      policy: resolveFallbackPolicy({ chain: [ALT, "openai/gpt-x"], max_switches: 1 }),
      state,
      current: ALT,
      exhaustedRetry: true,
      error: "502",
    });
    assert.equal(d.action, "none");
    if (d.action === "none") assert.ok(d.why.includes("switch limit"));
  });
});

describe("serializeFallbacks", () => {
  it("is undefined when nothing switched, so the column stays NULL", () => {
    assert.equal(serializeFallbacks(newFallbackState(CURRENT)), undefined);
  });

  it("records the whole path taken", () => {
    const state = newFallbackState(CURRENT);
    recordSwitch(state, CURRENT, ALT, "429");
    assert.equal(serializeFallbacks(state), `${CURRENT}>${ALT}`);
  });
});
