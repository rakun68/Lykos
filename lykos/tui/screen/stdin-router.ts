// Routes real stdin bytes to whichever raw-mode consumer is currently
// "active": T49's approval modal while one is open, T46's line editor
// otherwise. Both are built on the same key decoder (T46.1) and each owns
// its own `KeyDecoder` instance, but only one may actually read stdin at a
// time — the same reason `TerminalApprovalGate` shares ONE `readline`
// interface with the main prompt instead of opening a second one: two
// independent consumers on the same stream fight each other for bytes.
//
// The idle-flush timer exists because `KeyDecoder.feed()` buffers a byte
// sequence that could still become a known escape sequence (T46.1's own
// module doc: a lone ESC waits for `flush()` rather than being guessed).
// Real terminal writes arrive in bursts with gaps between keystrokes, so a
// short idle gap after the last chunk is what resolves an ambiguous
// trailing ESC into a bare Escape key instead of leaving it stuck.

import { StringDecoder } from "node:string_decoder";
import type { FeedOptions } from "./input.js";

export interface StdinRoutable {
  feedBytes(chunk: string, opts?: FeedOptions): void;
  flushPending(): void;
}

export interface RoutableOverlay extends StdinRoutable {
  readonly isOpen: boolean;
}

export interface StdinLike {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
  off(event: "data", listener: (chunk: Buffer | string) => void): void;
}

export interface RouterTimer {
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

export const realRouterTimer: RouterTimer = {
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Long enough that a real keystroke's bytes (even a slow ssh hop) arrive as one burst; short enough that a bare Escape resolves before it reads as a hang. */
export const DEFAULT_IDLE_FLUSH_MS = 50;

/**
 * A read that lands this soon after the previous one FINISHED being
 * processed did not come from a hand: two keystrokes five milliseconds
 * apart is 2400 characters a minute. A paste being delivered does it on
 * every read, because its bytes are already sitting in the OS buffer
 * waiting for us to come back and read them.
 *
 * Measuring from the end of the previous `feedBytes()` rather than from
 * its arrival is the whole point: a big paste spends most of its wall
 * clock in this process repainting the screen, and timing from arrival
 * counts our own rendering as though the terminal had paused. That is
 * exactly the mistake round eleven's 30 ms window made.
 */
export const CONTIGUOUS_READ_MS = 5;

/**
 * How long to wait before declaring the stream idle when the last read
 * arrived mid-burst. A paste is delivered in back-to-back reads, but a
 * terminal can still stall in the middle of one — and a stall that gets
 * mistaken for "the user stopped typing" is what resolves a held Enter as
 * a submit and sends half a paste. Nothing is waiting on this gap except a
 * lone ESC and a held key, and neither is in play while a paste is
 * arriving, so the wait is nearly free; ordinary typing never reaches it,
 * because a typed read is never contiguous with the one before it — a
 * person who pastes and then presses Enter is answered on the ordinary
 * 50 ms timer, because their keystroke is its own, non-contiguous read.
 *
 * A second and a half rather than a few hundred milliseconds because the
 * cost is asymmetric: the upper bound is a stall this misses and half a
 * paste sent, and the price of the wait is paid only by a lone ESC pressed
 * in the middle of a paste arriving, which nobody does.
 */
export const BURST_IDLE_FLUSH_MS = 1500;

export interface RouteStdinOptions {
  stdin: StdinLike;
  primary: StdinRoutable;
  /**
   * The overlay that takes bytes while it is open. T114 made this a list:
   * the approval gate is no longer the only thing that can own the keyboard,
   * and **order is priority** — the first open overlay wins, so an approval
   * prompt raised while the session browser is up still gets the keystroke
   * that answers it.
   */
  overlay: RoutableOverlay | readonly RoutableOverlay[];
  idleFlushMs?: number;
  /** Overrides `BURST_IDLE_FLUSH_MS` — the patience used after a read that arrived mid-burst. */
  burstIdleFlushMs?: number;
  timer?: RouterTimer;
  /** Injectable clock for the burst test above. Defaults to `Date.now`. */
  now?: () => number;
}

/** Returns an unsubscribe function that also cancels any pending idle-flush timer. */
export function routeStdin(opts: RouteStdinOptions): () => void {
  const idleMs = opts.idleFlushMs ?? DEFAULT_IDLE_FLUSH_MS;
  const burstIdleMs = opts.burstIdleFlushMs ?? BURST_IDLE_FLUSH_MS;
  const timer = opts.timer ?? realRouterTimer;
  const now = opts.now ?? Date.now;
  let lastFeedEndedAt = 0;
  let idleHandle: unknown;

  const clearIdle = (): void => {
    if (idleHandle !== undefined) {
      timer.clearTimer(idleHandle);
      idleHandle = undefined;
    }
  };

  const overlays: readonly RoutableOverlay[] = Array.isArray(opts.overlay)
    ? (opts.overlay as readonly RoutableOverlay[])
    : [opts.overlay as RoutableOverlay];
  const activeTarget = (): StdinRoutable => overlays.find((o) => o.isOpen) ?? opts.primary;

  // A stateful decoder, not `chunk.toString("utf8")` per chunk. stdin
  // delivers whatever bytes were available, and a multi-byte character
  // straddling that boundary decoded on its own is two replacement
  // glyphs — the "random characters appear in the text" report, arriving
  // by a route that has nothing to do with any key protocol and that only
  // ever shows up on a paste, because a paste is the only input big enough
  // to be split. `StringDecoder` holds the partial sequence back until its
  // remaining bytes arrive.
  const utf8 = new StringDecoder("utf8");

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : utf8.write(chunk);
    clearIdle();
    // One stdin data event routes atomically to whichever target is
    // active at the moment it arrives. The idle-flush callback below reads
    // `isOpen` fresh, at its own later moment — that is what lets a
    // pending-ESC flush land on an approval gate that opened only after
    // this chunk's own feedBytes() call returned (a submitted line that
    // turns out to need approval, mid-chunk).
    //
    // A chunk that was nothing but the first bytes of a split character
    // decodes to "", and feeding that is a no-op — but the idle timer is
    // still re-armed below, so a held Enter is not resolved by the gap the
    // rest of that character is sitting in.
    const contiguous = lastFeedEndedAt !== 0 && now() - lastFeedEndedAt <= CONTIGUOUS_READ_MS;
    if (text.length > 0) activeTarget().feedBytes(text, { contiguous });
    lastFeedEndedAt = now();
    idleHandle = timer.setTimer(
      () => {
        idleHandle = undefined;
        activeTarget().flushPending();
      },
      // A read that arrived mid-burst gets a long patience: see
      // `BURST_IDLE_FLUSH_MS`. Typing always gets the short one.
      contiguous ? burstIdleMs : idleMs,
    );
  };

  opts.stdin.on("data", onData);
  return () => {
    opts.stdin.off("data", onData);
    clearIdle();
  };
}
