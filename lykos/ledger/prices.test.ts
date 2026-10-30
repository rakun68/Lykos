// Cache avoided cost is exact, both terms observed. These tests pin the formula
// against real prices.yaml numbers so a pricing change or a formula regression
// fails loudly here rather than only showing up as a shifted dollar figure
// three layers up.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cacheAvoidedUsd, isPeak, isPriced, priceCall, providerHasVerifiedPricing } from "./prices.js";

const OFF_PEAK = new Date("2026-08-29T12:00:00Z"); // Saturday
const PEAK = new Date("2026-08-25T02:00:00Z"); // Tuesday 02:00 UTC

describe("cacheAvoidedUsd", () => {
  it("is exactly zero with no cache activity at all", () => {
    const { rates } = priceCall({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10 },
      ts: OFF_PEAK,
    });
    assert.equal(cacheAvoidedUsd(0, 0, rates), 0);
  });

  it("DeepSeek off-peak: a cache read avoids input-price minus read-price, no write premium", () => {
    const { rates } = priceCall({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 900 },
      ts: OFF_PEAK,
    });
    // off-peak: input 0.22, cache_read 0.007 per mtok (prices.yaml)
    const expected = (900 / 1e6) * (0.22 - 0.007);
    assert.ok(Math.abs(cacheAvoidedUsd(900, 0, rates) - expected) < 1e-12);
  });

  it("DeepSeek: cache-write premium term is always zero (no write premium), regardless of the billed cache_write_per_mtok value", () => {
    const { rates } = priceCall({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheWrite: 5000 },
      ts: PEAK,
    });
    // cache_write_per_mtok is 0.0 in prices.yaml -- that prevents double-
    // billing tokens already counted through freshInput, it is NOT evidence
    // of a write premium. writeIsPremium (a separate, explicit flag) is what
    // must gate the avoided-cost penalty term, or a DeepSeek cache write
    // would wrongly show up as a positive "avoided" cost.
    assert.equal(rates.writeIsPremium, false);
    assert.equal(cacheAvoidedUsd(0, 5000, rates), 0);
  });

  it("DeepSeek peak vs off-peak: the same tokens avoid twice as much at peak", () => {
    const offPeak = priceCall({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 1000 },
      ts: OFF_PEAK,
    });
    const peak = priceCall({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 1000 },
      ts: PEAK,
    });
    const offPeakAvoided = cacheAvoidedUsd(1000, 0, offPeak.rates);
    const peakAvoided = cacheAvoidedUsd(1000, 0, peak.rates);
    assert.ok(Math.abs(peakAvoided - 2 * offPeakAvoided) < 1e-12);
  });

  it("Anthropic: a cache write with no matching read is a NEGATIVE avoided figure — the write premium diagnostic", () => {
    const { rates } = priceCall({
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: { input: 100, output: 10, cacheWrite: 1000 },
      ts: OFF_PEAK,
      cacheTtlSeconds: 300,
    });
    // 5m TTL: input 2.00, cache_write_5m 2.50 per mtok (prices.yaml) -- a
    // prefix written once and never read back is a pure loss, and this must
    // come out negative so it shows up in v_cost_inversions (AGENTS.md rule 4).
    const avoided = cacheAvoidedUsd(0, 1000, rates);
    assert.ok(avoided < 0);
    const expected = -(1000 / 1e6) * (2.5 - 2.0);
    assert.ok(Math.abs(avoided - expected) < 1e-12);
  });

  it("Anthropic: the 1h TTL write premium is larger than the 5m premium", () => {
    const write5m = priceCall({
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: { input: 100, output: 10, cacheWrite: 1000 },
      ts: OFF_PEAK,
      cacheTtlSeconds: 300,
    });
    const write1h = priceCall({
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: { input: 100, output: 10, cacheWrite: 1000 },
      ts: OFF_PEAK,
      cacheTtlSeconds: 3600,
    });
    const avoided5m = cacheAvoidedUsd(0, 1000, write5m.rates);
    const avoided1h = cacheAvoidedUsd(0, 1000, write1h.rates);
    assert.ok(avoided1h < avoided5m, "the 1h TTL premium should be a larger loss than the 5m premium");
  });

  it("Anthropic: reads and a write together net the read savings against the write premium", () => {
    const { rates } = priceCall({
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: { input: 100, output: 10, cacheRead: 10_000, cacheWrite: 1000 },
      ts: OFF_PEAK,
      cacheTtlSeconds: 300,
    });
    const expected = (10_000 / 1e6) * (2.0 - 0.2) - (1000 / 1e6) * (2.5 - 2.0);
    assert.ok(Math.abs(cacheAvoidedUsd(10_000, 1000, rates) - expected) < 1e-12);
  });
});

describe("isPriced / providerHasVerifiedPricing (T36.2)", () => {
  it("DeepSeek flash is priced (rates AND cache semantics verified)", () => {
    assert.equal(isPriced("deepseek", "deepseek-v4-flash"), true);
    assert.equal(providerHasVerifiedPricing("deepseek"), true);
  });

  it("Anthropic sonnet is priced", () => {
    assert.equal(isPriced("anthropic", "claude-sonnet-5"), true);
    assert.equal(providerHasVerifiedPricing("anthropic"), true);
  });

  it("OpenRouter is not priced — empty models map, no cache semantics", () => {
    assert.equal(isPriced("openrouter", "anything"), false);
    assert.equal(providerHasVerifiedPricing("openrouter"), false);
  });

  it("an unknown provider is not priced", () => {
    assert.equal(isPriced("mystery", "mystery-model"), false);
    assert.equal(providerHasVerifiedPricing("mystery"), false);
  });
});

describe("isPeak — a window that crosses midnight belongs to the day it starts on (D18)", () => {
  // The real table declares no wrapping window on purpose (prices.yaml is
  // primary-source data, not a place to park a fixture), so these windows are
  // supplied by the test. 2026-08-23 is a Sunday, 24 a Monday, 25 a Tuesday.
  const MONDAY_WRAP = [{ days: ["mon"], ranges: ["22:00-02:00"] }];
  const SUNDAY_WRAP = [{ days: ["sun"], ranges: ["22:00-02:00"] }];

  it("Monday 23:00 is inside a Monday 22:00-02:00 window", () => {
    assert.equal(isPeak(new Date("2026-08-24T23:00:00Z"), MONDAY_WRAP), true);
  });

  it("Tuesday 01:00 is inside it — the window belongs to Monday, the day it started", () => {
    assert.equal(isPeak(new Date("2026-08-25T01:00:00Z"), MONDAY_WRAP), true);
  });

  it("Tuesday 02:00 is outside it — the end minute is exclusive", () => {
    assert.equal(isPeak(new Date("2026-08-25T02:00:00Z"), MONDAY_WRAP), false);
  });

  it("Tuesday 23:00 is outside it — Tuesday is not listed, so it does not own the wrap", () => {
    assert.equal(isPeak(new Date("2026-08-25T23:00:00Z"), MONDAY_WRAP), false);
  });

  it("a Sunday window owns Sunday 23:00 and Monday 01:00", () => {
    assert.equal(isPeak(new Date("2026-08-23T23:00:00Z"), SUNDAY_WRAP), true);
    assert.equal(isPeak(new Date("2026-08-24T01:00:00Z"), SUNDAY_WRAP), true);
  });

  it("start == end throws — '00:00-00:00' is malformed, not zero and not 24 hours", () => {
    const malformed = [{ days: ["mon"], ranges: ["00:00-00:00"] }];
    assert.throws(() => isPeak(new Date("2026-08-24T12:00:00Z"), malformed), /start equals end/);
  });
});
