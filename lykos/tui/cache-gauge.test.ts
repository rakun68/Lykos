import assert from "node:assert/strict";
import test from "node:test";
import { deriveCacheGauge } from "./cache-gauge.js";

test("T121 keeps cache readings per model and preserves unknown TTLs", () => {
  const now = new Date("2026-09-07T00:10:00.000Z");
  const entries = deriveCacheGauge(
    [
      { model: "anthropic/claude", cacheRead: 900, cacheWrite: 100, atUtc: "2026-09-07T00:09:00.000Z", ttlSeconds: 300 },
      { model: "deepseek/deepseek", cacheRead: 500, cacheWrite: 500, atUtc: "2026-09-06T23:00:00.000Z" },
    ],
    now,
    "anthropic/claude",
  );

  assert.equal(entries[0]?.model, "anthropic/claude");
  assert.equal(entries[0]?.pct, 0.9);
  assert.equal(entries[0]?.status, "fresh");
  assert.equal(entries[1]?.status, "unknown");
  assert.equal(entries[1]?.ageSeconds, 4200);
});

test("T121 marks a contractual cache entry stale after its TTL", () => {
  const [entry] = deriveCacheGauge(
    [{ model: "anthropic/claude", cacheRead: 1, cacheWrite: 1, atUtc: "2026-09-07T00:00:00.000Z", ttlSeconds: 300 }],
    new Date("2026-09-07T00:06:00.000Z"),
  );
  assert.equal(entry?.status, "stale");
});
