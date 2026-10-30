import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FrameScheduler, type SchedulerClock } from "./scheduler.js";

/**
 * A fake clock with a manual timer queue. The coalescing property is a
 * statement about exact render counts, so a test that slept would be
 * asserting something weaker than the claim.
 */
function fakeClock() {
  let t = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const clock: SchedulerClock = {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimer: (h) => void timers.delete(h as number),
  };
  return {
    clock,
    get pending() {
      return timers.size;
    },
    /** Advance the clock, firing every timer whose deadline has passed, in order. */
    advance(ms: number) {
      const target = t + ms;
      while (true) {
        const due = [...timers.entries()].filter(([, v]) => v.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = target;
    },
  };
}

function scheduler(maxHz?: number) {
  const c = fakeClock();
  const renders: number[] = [];
  const s = new FrameScheduler({
    render: () => renders.push(c.clock.now()),
    ...(maxHz !== undefined ? { maxHz } : {}),
    clock: c.clock,
  });
  return { s, c, renders };
}

describe("T41.4: the coalescing scheduler", () => {
  it("the first dirty mark renders immediately — nothing waits on a timer to appear", () => {
    const { s, renders } = scheduler();
    s.markDirty();
    assert.equal(renders.length, 1);
    assert.equal(s.renders, 1);
  });

  it("ACCEPTANCE: a burst of deltas renders once, not once per delta", () => {
    const { s, c, renders } = scheduler(30);
    s.markDirty(); // renders now
    for (let i = 0; i < 500; i++) s.markDirty(); // one burst, inside one window
    assert.equal(renders.length, 1, "the burst must not have rendered yet");
    assert.equal(s.coalesced, 499);
    c.advance(34);
    assert.equal(renders.length, 2, "the whole burst produced exactly one further render");
    assert.equal(s.renders, 2);
  });

  it("never exceeds maxHz over a sustained stream", () => {
    const { s, c } = scheduler(30);
    // One dirty mark per millisecond for a simulated second — roughly what a
    // streaming model at ~124 tok/s with several deltas per token looks like.
    for (let i = 0; i < 1000; i++) {
      s.markDirty();
      c.advance(1);
    }
    assert.ok(s.renders <= 31, `rendered ${s.renders} times in one second, budget is 30Hz`);
    assert.ok(s.renders >= 29, `rendered only ${s.renders} times — the rate limiter is starving the screen`);
  });

  it("caps maxHz at 30 even when a caller asks for more", () => {
    const { s, c } = scheduler(240);
    for (let i = 0; i < 1000; i++) {
      s.markDirty();
      c.advance(1);
    }
    assert.ok(s.renders <= 31, `${s.renders} renders — T41.4 fixes the ceiling at 30Hz`);
  });

  it("a lower maxHz is honoured (T50.4's cut lever)", () => {
    const { s, c } = scheduler(10);
    for (let i = 0; i < 1000; i++) {
      s.markDirty();
      c.advance(1);
    }
    assert.ok(s.renders <= 11, `${s.renders} renders at 10Hz`);
  });

  it("a quiet period does not accumulate a debt of renders", () => {
    const { s, c, renders } = scheduler(30);
    s.markDirty();
    c.advance(5_000);
    assert.equal(renders.length, 1, "an idle scheduler renders nothing");
    s.markDirty();
    assert.equal(renders.length, 2, "and the next mark after the quiet period renders immediately");
  });

  it("flush() renders a pending frame now and disarms the timer", () => {
    const { s, c, renders } = scheduler(30);
    s.markDirty();
    s.markDirty();
    assert.equal(renders.length, 1);
    assert.equal(s.isArmed, true);
    s.flush();
    assert.equal(renders.length, 2);
    assert.equal(s.isArmed, false);
    c.advance(100);
    assert.equal(renders.length, 2, "the armed render must not fire a second time after a flush");
  });

  it("flush() with nothing dirty is a no-op", () => {
    const { s, renders } = scheduler();
    s.markDirty();
    s.flush();
    s.flush();
    assert.equal(renders.length, 1);
  });

  it("stop() disarms permanently and clears the timer queue", () => {
    const { s, c, renders } = scheduler(30);
    s.markDirty();
    s.markDirty();
    s.stop();
    assert.equal(c.pending, 0, "a stopped scheduler must not keep the event loop alive");
    c.advance(1_000);
    s.markDirty();
    s.flush();
    assert.equal(renders.length, 1, "nothing renders after stop()");
  });
});
