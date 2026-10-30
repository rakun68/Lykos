// Per-call latency and TTFT, computed from Pi's own event stream.
//
// Event boundaries confirmed from pi-coding-agent's own docs/sdk.md (fetched
// 2026-08-31 against @earendil-works/pi-coding-agent@0.84.4, the pinned
// version): "message_start" fires once per model call, before "message_end".
// "message_update" fires on every streamed chunk in between. TTFT is defined
// here as the first message_update received after message_start -- the
// docs' own example names only two assistantMessageEvent sub-types
// (text_delta, thinking_delta) and documents no dedicated "first token"
// event, so this reads the outer envelope Pi's docs actually confirm rather
// than guessing at an unconfirmed sub-type name.
//
// A NULL is a correct answer here (T26.1: "undefined rather than a guess on
// any failure"). onMessageEnd()/onEnd() without a preceding start returns an
// empty timing rather than a negative or zero duration.

export interface CallTiming {
  latencyMs?: number;
  ttftMs?: number;
}

/** One model-call's message_start -> message_update* -> message_end span. */
export class LatencyTracker {
  private startedAt: number | undefined;
  private firstUpdateAt: number | undefined;

  onMessageStart(now: number = Date.now()): void {
    this.startedAt = now;
    this.firstUpdateAt = undefined;
  }

  onMessageUpdate(now: number = Date.now()): void {
    if (this.startedAt !== undefined && this.firstUpdateAt === undefined) {
      this.firstUpdateAt = now;
    }
  }

  /** Call once per message_end. Resets state so the next message starts clean. */
  onMessageEnd(now: number = Date.now()): CallTiming {
    const startedAt = this.startedAt;
    const firstUpdateAt = this.firstUpdateAt;
    this.startedAt = undefined;
    this.firstUpdateAt = undefined;
    if (startedAt === undefined) return {};
    const timing: CallTiming = { latencyMs: now - startedAt };
    if (firstUpdateAt !== undefined) timing.ttftMs = firstUpdateAt - startedAt;
    return timing;
  }
}

/**
 * The compaction summariser call (docs/11-prefix-control-surface.md T16.1:
 * compact() runs on Pi's own isolated head) does not emit message_start /
 * message_update / message_end into this session's public event stream, so
 * it needs its own start/end pair rather than LatencyTracker's. No TTFT: a
 * compaction call has no observed first-chunk boundary here.
 */
export class CompactionLatencyTracker {
  private startedAt: number | undefined;

  onStart(now: number = Date.now()): void {
    this.startedAt = now;
  }

  onEnd(now: number = Date.now()): CallTiming {
    const startedAt = this.startedAt;
    this.startedAt = undefined;
    return startedAt === undefined ? {} : { latencyMs: now - startedAt };
  }
}
