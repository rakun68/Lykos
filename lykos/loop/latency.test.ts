import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CompactionLatencyTracker, LatencyTracker } from "./latency.js";

describe("LatencyTracker", () => {
  it("computes latency and TTFT from message_start / message_update / message_end", () => {
    const t = new LatencyTracker();
    t.onMessageStart(1000);
    t.onMessageUpdate(1150); // first chunk
    t.onMessageUpdate(1300); // later chunk -- must not move ttft
    const timing = t.onMessageEnd(1500);
    assert.equal(timing.latencyMs, 500);
    assert.equal(timing.ttftMs, 150);
  });

  it("returns latency with no ttft when message_end fires with no update in between", () => {
    const t = new LatencyTracker();
    t.onMessageStart(1000);
    const timing = t.onMessageEnd(1200);
    assert.equal(timing.latencyMs, 200);
    assert.equal(timing.ttftMs, undefined);
  });

  it("returns an empty timing (never a guess) when message_end fires with no start observed", () => {
    const t = new LatencyTracker();
    const timing = t.onMessageEnd(1000);
    assert.deepEqual(timing, {});
  });

  it("resets after each message so a second call's timing is independent of the first", () => {
    const t = new LatencyTracker();
    t.onMessageStart(0);
    t.onMessageUpdate(50);
    t.onMessageEnd(100);

    t.onMessageStart(1000);
    const timing = t.onMessageEnd(1080);
    assert.equal(timing.latencyMs, 80);
    assert.equal(timing.ttftMs, undefined); // no update this time
  });

  it("ignores a message_update that arrives before any message_start", () => {
    const t = new LatencyTracker();
    t.onMessageUpdate(500); // stray, before start
    t.onMessageStart(1000);
    t.onMessageUpdate(1100);
    const timing = t.onMessageEnd(1300);
    assert.equal(timing.latencyMs, 300);
    assert.equal(timing.ttftMs, 100);
  });
});

describe("CompactionLatencyTracker", () => {
  it("computes latency only, from start/end, with no TTFT concept", () => {
    const t = new CompactionLatencyTracker();
    t.onStart(1000);
    const timing = t.onEnd(4200);
    assert.equal(timing.latencyMs, 3200);
    assert.equal(timing.ttftMs, undefined);
  });

  it("returns an empty timing when end fires with no start observed", () => {
    const t = new CompactionLatencyTracker();
    const timing = t.onEnd(1000);
    assert.deepEqual(timing, {});
  });
});
