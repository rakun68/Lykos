// The coalescing frame scheduler.
//
// State mutations mark the frame dirty; they never render. A token delta
// from a streaming model arrives far faster than a human reads and far
// faster than a terminal can usefully paint — DeepSeek decodes at ~124
// output tokens/s (docs/14-performance.md), and a `thinking_delta` burst
// can be several deltas per token. Rendering per delta would spend the
// wall-clock time §0 of the phase doc claims the UI does not cost.
//
// So: at most `maxHz` renders per second (default 30), and never two
// renders for one burst. A dirty mark inside the current window schedules
// exactly one render at the end of it and is otherwise free.
//
// Timers and the clock are injected because the alternative is a test suite
// that sleeps: `scheduler.test.ts` drives a fake clock and a manual timer
// queue, so the coalescing property is asserted exactly rather than
// approximately.

export interface SchedulerClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const realClock: SchedulerClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface FrameSchedulerOpts {
  /** Called when a render is actually due. Must not throw — a throw here would leave the scheduler armed. */
  render: () => void;
  /** Ceiling on renders per second. T41.4 fixes the maximum at 30; a lower value is legitimate (T50.4's cut lever). */
  maxHz?: number;
  clock?: SchedulerClock;
}

export class FrameScheduler {
  private readonly render: () => void;
  private readonly minIntervalMs: number;
  private readonly clock: SchedulerClock;
  private timer: unknown;
  private dirty = false;
  private lastRenderAt = -Infinity;
  private stopped = false;

  /** Renders actually performed. */
  renders = 0;
  /** Dirty marks that were absorbed into an already-scheduled render — the number that proves coalescing. */
  coalesced = 0;

  constructor(opts: FrameSchedulerOpts) {
    const hz = Math.max(1, Math.min(30, opts.maxHz ?? 30));
    this.render = opts.render;
    this.minIntervalMs = 1000 / hz;
    this.clock = opts.clock ?? realClock;
  }

  get isArmed(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Mark the frame dirty. Renders immediately if the rate limit allows it,
   * otherwise arms one render for the end of the current window. Cheap
   * enough to call per streamed delta, which is the point.
   */
  markDirty(): void {
    if (this.stopped) return;
    this.dirty = true;
    if (this.timer !== undefined) {
      this.coalesced += 1;
      return;
    }
    const since = this.clock.now() - this.lastRenderAt;
    if (since >= this.minIntervalMs) {
      this.fire();
      return;
    }
    this.timer = this.clock.setTimer(() => {
      this.timer = undefined;
      this.fire();
    }, Math.ceil(this.minIntervalMs - since));
  }

  /**
   * Render now if dirty, ignoring the rate limit, and cancel any armed
   * render. For the moments where a frame must be on screen before the
   * process blocks: an approval prompt (T49), and the last frame before
   * leaving the alternate buffer.
   */
  flush(): void {
    if (this.timer !== undefined) {
      this.clock.clearTimer(this.timer);
      this.timer = undefined;
    }
    if (this.dirty && !this.stopped) this.fire();
  }

  /** Disarm permanently. Called on the way out, before the terminal is restored. */
  stop(): void {
    this.stopped = true;
    this.dirty = false;
    if (this.timer !== undefined) {
      this.clock.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private fire(): void {
    this.dirty = false;
    this.lastRenderAt = this.clock.now();
    this.renders += 1;
    this.render();
  }
}
