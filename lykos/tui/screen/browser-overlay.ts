// T114 — the session browser as a stdin consumer.
//
// `browser.ts` is the pure half: state in, lines out, no terminal. This is
// the half that owns bytes while the browser is open, and it is deliberately
// the same shape as `RawApprovalGate`: its own `KeyDecoder`, `feedBytes` /
// `flushPending`, and an `isOpen` the router reads to decide where the next
// chunk goes. Two consumers cannot both read stdin — that is the whole
// premise of `stdin-router.ts` — so the browser becomes a routable overlay
// rather than reaching for the stream itself.
//
// It renders through a callback rather than touching the pipeline, for the
// same reason the gate does: this class is constructed before the pipeline
// exists, and a forward reference is cheaper than a construction order that
// has to stay true.

import { KeyDecoder, type FeedOptions, type KeyEvent } from "./input.js";
import { browserEntries, browserKey, openBrowser, type BrowserSource, type BrowserState } from "./browser.js";
import type { SessionListRow } from "../../session/listing.js";

export interface BrowserOverlayOptions {
  /** Where rows come from. Called on every open, so a browser opened twice sees sessions that landed in between. */
  source: BrowserSource;
  /** Draw the current state as the whole screen. Called on open and after every keystroke that changed anything. */
  onRender(state: BrowserState, height: number): void;
  /** The browser closed with nothing chosen. The session is exactly as it was. */
  onClose(): void;
  /** A session was chosen. What "continue this" means is the caller's decision, not this class's. */
  onSelect(row: SessionListRow): void;
  /** T130: explicit new-session action, including when the list is empty. */
  onNew?(): void;
  /**
   * T129, reshaped 2026-09-07 (UI feedback items 7 and 10): Ctrl-X marks a
   * session Closed. The browser refuses to send this for a running session
   * at all, so an implementation never has to decide whether it is allowed
   * to close one out from under the process that owns it.
   */
  onCloseSession?(row: SessionListRow): void;
  /** T129: remove the conversation, keep the accounting. Ctrl-K, two presses. */
  onDelete?(row: SessionListRow): void;
}

export class BrowserOverlay {
  private readonly decoder = new KeyDecoder();
  private readonly opts: BrowserOverlayOptions;
  private state: BrowserState | null = null;
  /** Viewport height at the last render, so paging matches what is actually on screen. */
  private height = 24;

  constructor(opts: BrowserOverlayOptions) {
    this.opts = opts;
  }

  get isOpen(): boolean {
    return this.state !== null;
  }

  /** For a caller that wants to show the current rows without waiting for a render. */
  get current(): BrowserState | null {
    return this.state;
  }

  /**
   * Open, or close again if it is already open — the back affordance is one
   * target and pressing it twice should put you back where you were, not
   * reload the list on top of itself.
   */
  toggle(height: number): void {
    if (this.state) {
      this.close();
      return;
    }
    this.open(height);
  }

  open(height: number): void {
    this.height = Math.max(6, height);
    this.state = openBrowser(this.opts.source);
    this.opts.onRender(this.state, this.height);
  }

  close(): void {
    if (!this.state) return;
    this.state = null;
    // The decoder is dropped on close so a half-decoded escape sequence
    // from the browser can never be delivered to the composer as a stray
    // key once the browser is gone.
    this.decoder.flush();
    this.opts.onClose();
  }

  /**
   * Kept in step with the real terminal so paging moves by what the user can
   * see. A resize while the browser is open re-renders at the new size
   * rather than waiting for the next keystroke.
   */
  setHeight(height: number): void {
    this.height = Math.max(6, height);
    if (this.state) this.opts.onRender(this.state, this.height);
  }

  feedBytes(chunk: string, opts?: FeedOptions): void {
    for (const ev of this.decoder.feed(chunk, opts)) this.handleKey(ev);
  }

  flushPending(): void {
    for (const ev of this.decoder.flush()) this.handleKey(ev);
  }

  /**
   * Re-read the rows the current scope points at, keeping everything the
   * person chose — filter, cursor, fold state — and clamping the cursor to
   * whatever is still there. Used after a write that changes which group a
   * session belongs to.
   */
  private reload(from: BrowserState, notice: string | null): void {
    const load = from.scope === "all" ? this.opts.source.loadAll?.() ?? this.opts.source.load() : this.opts.source.load();
    const next: BrowserState = {
      ...from,
      rows: load.rows,
      failures: load.failures,
      previewScroll: 0,
      notice,
      ...(load.fanout !== undefined ? { fanout: load.fanout } : {}),
    };
    const total = browserEntries(next).length;
    this.state = { ...next, cursor: Math.min(next.cursor, Math.max(0, total - 1)) };
    this.opts.onRender(this.state, this.height);
  }

  private handleKey(ev: KeyEvent): void {
    const open = this.state;
    if (!open) return;
    const { state, action } = browserKey(open, ev, this.height);
    this.state = state;
    switch (action.kind) {
      case "close":
        this.close();
        return;
      case "select":
        // Closed BEFORE the callback: whatever `onSelect` does — and T116
        // makes it end this session and continue another — must not run
        // with a browser still holding stdin.
        this.state = null;
        this.opts.onClose();
        this.opts.onSelect(action.row);
        return;
      case "new":
        this.close();
        this.opts.onNew?.();
        return;
      case "closeSession":
        this.opts.onCloseSession?.(action.row);
        // Stay open, and RELOAD: the row just moved from one lifecycle
        // group to another, and a list that still shows it under Open
        // would be lying about the write that just happened. The cursor
        // and the fold state are kept because the point of doing this from
        // here is to keep going down the list.
        this.reload(state, `closed ${action.row.id.slice(0, 8)} — Enter reopens it`);
        return;
      case "delete":
        this.opts.onDelete?.(action.row);
        this.reload(state, `deleted the conversation of ${action.row.id.slice(0, 8)}; its cost is kept`);
        return;
      case "toggleScope": {
        const scope = state.scope === "all" ? "project" : "all";
        const load = scope === "all" ? this.opts.source.loadAll?.() : this.opts.source.load();
        if (!load) {
          this.state = { ...state, notice: "all-project scope is unavailable" };
          this.opts.onRender(this.state, this.height);
          return;
        }
        this.state = {
          ...state,
          rows: load.rows,
          failures: load.failures,
          cursor: 0,
          scroll: 0,
          previewScroll: 0,
          notice: null,
          scope,
          ...(load.fanout !== undefined ? { fanout: load.fanout } : { fanout: undefined }),
        };
        this.opts.onRender(this.state, this.height);
        return;
      }
      default:
        this.opts.onRender(state, this.height);
    }
  }
}
