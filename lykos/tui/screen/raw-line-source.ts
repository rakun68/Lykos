// The raw-mode LineSource, and the seam that keeps `runInteractiveLoop()`
// unchanged.
//
// `session/interactive.ts`'s `LineSource` interface (`next()` / `close()`) is
// deliberately small and structural — `createReadlineLineSource()` is one
// implementation of it; `RawLineSource` here is a second one, built on
// T46.1's key decoder and T46.2's line editor instead of Node's
// `readline`. Nothing about `runInteractiveLoop()`'s `pendingRead`
// discipline changes: this class still resolves exactly one pending
// `next()` at a time, and `close()` still wakes a pending read with null.
//
// A submitted multi-line buffer is queued as ONE `next()` result with its
// real newlines intact. It used to be translated into the backslash-
// continuation protocol instead — one entry per physical row, every row
// but the last suffixed with a backslash — on the theory that this let a
// multi-line edit reuse the single-line-at-a-time parser with no change to
// it. It did, and it also deleted every line break on the way, because the
// loop reassembles a continued line as `pending + line` with no separator:
// that protocol means "this line keeps going", which is the opposite of
// what a newline in a pasted block means. See `submit()` for the full
// account (2026-09-02 round twelve, item 3).
//
// This file is where the 2026-09-02 editor round (UI feedback item 8) is
// bound to actual keys. Two of those bindings are deliberate departures
// from readline's defaults, and both are named here rather than left to be
// discovered:
//
//  - **Ctrl-A is Select All, not beginning-of-line.** The request was
//    explicit ("add ctrl A to select all the text in the current prompt").
//    Home still reaches the start of the line, so nothing is lost; a
//    readline reflex is. (Ctrl-Left used to as well; as of 2026-09-07 it
//    opens the session browser — UI feedback item 5.)
//  - **Ctrl-C copies when there is a selection, and only aborts when there
//    is not.** An abort that a stray selection could swallow would be
//    unacceptable, so copying also CLEARS the selection: pressing Ctrl-C
//    twice always aborts, and pressing it once with nothing selected
//    aborts immediately, exactly as before. Terminals that map
//    Ctrl-Shift-C to their own copy still do that and never reach here.

import { appendHistory, loadHistory, searchHistoryByPrefix } from "../history.js";
import { LineEditor, type EditorState } from "../editor.js";
import { KeyDecoder, type FeedOptions, type KeyEvent } from "./input.js";
import { complete, completionWindow, DEFAULT_COMPLETION_MAX_VISIBLE, type Candidate } from "./completion.js";
import type { ClickAction } from "./scrollback.js";
import { inputLogPath, visibleBytes, writeInputLog } from "./input-log.js";

export interface LineSource {
  next(): Promise<string | null>;
  close(): void;
}

/**
 * Where in the frame the composer's editable text starts, so a mouse
 * report's absolute row/column can be turned back into a buffer position.
 * Returned by a callback rather than passed once because the composer
 * moves whenever it grows a line or the terminal resizes.
 */
export interface ComposerGeometry {
  /** Frame row of buffer row 0 — the composer region's top, plus one for its border rule. */
  firstBufferRow: number;
  /** Visible columns each row is inset by (`composer.ts`'s `COMPOSER_PREFIX_WIDTH`). */
  prefixWidth: number;
  /** Rows of buffer the composer is currently showing — a click below the last one is not a click in the composer. */
  rowCount: number;
  /**
   * `composer.ts`'s `ComposerRender.rowMap` — one entry per VISUAL row,
   * naming the logical editor row and column offset it starts at. Needed
   * since soft word-wrap (2026-09-02 round five) means a click's row is a
   * visual row, not necessarily a logical one: `handleMouse` uses this to
   * translate back before calling `editor.moveTo()`, which only
   * understands logical coordinates. Omitted rows (a caller mid-migration,
   * or a test that doesn't care) fall back to treating the click's row as
   * the logical row directly, unwrapped.
   */
  rowMap?: Array<{ logicalRow: number; startCol: number; endCol: number }>;
  /**
   * Index into `rowMap` of the first RENDERED row — `ComposerRender.
   * windowStart`. Non-zero only while the composer's height cap
   * (2026-09-02 round six, item 5) is scrolling it, and needed because
   * `rowMap` covers the whole buffer while a mouse report names a row
   * inside the visible window.
   */
  rowOffset?: number;
}

export interface RawLineSourceOptions {
  /** Seed history, newest last — normally `loadHistory(workspace)`. */
  history?: string[];
  /** Persist a submitted, non-blank line to `.lykos/history.json`. Omit in tests that don't want disk writes. */
  workspace?: string;
  /** Ctrl-C: raw mode disables the terminal's own SIGINT generation, so this is the hook a caller wires to `InteractiveHandle.interrupt()`. */
  onInterrupt?: () => void;
  /** Called after every key is applied — the composer's redraw trigger (T42's frame scheduler). Never required for correctness, only for drawing. */
  onChange?: (state: EditorState) => void;
  /** PgUp/PgDn and a real mouse wheel notch (T43.3) — scrolls the transcript, never the composer or history. */
  onScroll?: (action: "pageUp" | "pageDown" | "wheelUp" | "wheelDown") => void;
  /** T47: the project root `@`-completion lists files under. Omitted disables Tab completion entirely — Tab is then a no-op, matching pre-T47 behaviour. */
  completionRoot?: string;
  /** Fires whenever the completion popup's candidate list changes — an empty array hides it. `selected` indexes into `candidates` and is -1 when hidden. */
  onCompletionChange?: (candidates: Candidate[], selected: number) => void;
  /** Ctrl-C / Ctrl-X: hand the copied text to the system clipboard. Omitted leaves the editor's in-process register as the only clipboard. */
  onCopy?: (text: string) => void;
  /** Ctrl-V: the system clipboard's current contents, or null when unreachable — the editor's own register is the fallback. */
  readClipboard?: () => string | null;
  /** Mouse click / drag support. Omitted leaves clicks inert, which is what every non-fullscreen caller wants. */
  composerGeometry?: () => ComposerGeometry | null;
  /** Where the tab-completion popup currently sits in the frame — 2026-09-02 round nine, item 3's click-to-accept. Omitted leaves the popup unclickable (Tab/arrows still work), which is what every non-fullscreen caller and every test that doesn't care about this gets. */
  completionGeometry?: () => { firstRow: number } | null;
  /** Resolves a click OUTSIDE the composer and the completion popup — normally `ScreenPipeline.actionAt()`. Omitted leaves such a click inert, same as before this round. */
  resolveClick?: (row: number, col: number) => ClickAction | null;
  /** The pointer moved with no button held (round eleven, item 1) — wired to `ScreenPipeline.setHover()`, which decides whether anything needs repainting. Omitted leaves hover inert, which is what every non-fullscreen caller and every test that does not care about it gets. */
  onHover?: (row: number, col: number) => void;
  /** What `resolveClick()` found. This class does not interpret any `ClickAction` itself — see `session/interactive.ts`'s dispatcher — it only decides WHETHER a click was for the composer/popup or for everything else. */
  onAction?: (action: ClickAction) => void;
  /** T126: Alt+Left is the browser back gesture and stays free in the editor. Ctrl+Left is NOT routed here — it is word-left (reverted 2026-09-08, T131). */
  onAltArrow?: (direction: "left" | "right") => boolean;
  /** T123/T215: Shift+Tab cycles primary specialists. */
  onShiftTab?: () => boolean;
  /** T125: transcript search, separate from Ctrl-R's editor history search. */
  onTranscriptSearchQuery?: (query: string) => void;
  onTranscriptSearchSubmit?: (query: string) => void;
  onTranscriptSearchCancel?: () => void;
  onTranscriptSearchMove?: (direction: "next" | "previous") => void;
  /** T122: Esc Esc opens the human-only checkpoint picker. */
  onDoubleEscape?: () => boolean;
  doubleEscapeWindowMs?: number;
  /**
   * T114: a chance to claim a Ctrl key before the editor sees it. Return
   * `true` to consume it; anything else falls through to the editor's own
   * bindings, unchanged.
   *
   * A hook rather than a per-feature option because the alternative is one
   * option per key, and this pass alone adds three (`Ctrl+B` opens the
   * session browser here; T120 and T125 claim `Ctrl+L`/`Ctrl+P` and
   * `Ctrl+F`). It is checked FIRST, so an owner can override a default
   * binding — which is also why it is a hook and not a lookup table: G1's
   * real keybinding layer is still the right answer and this must not grow
   * into a worse version of it.
   */
  onCtrlKey?: (key: string, shift: boolean) => boolean;
}

/**
 * T47.3's trigger rule, restated as a text RANGE rather than `complete()`'s
 * text: mirrors `complete()` in `completion.ts` exactly (same two branches,
 * same order) because that function answers "what are the candidates" and
 * this one answers "what text do they replace" — the same trigger decides
 * both, and duplicating the two-line check here is cheaper than threading a
 * range out through `complete()`'s return type for every other caller.
 */
function completionAnchorFor(lineText: string, cursorCol: number): { startCol: number; endCol: number } {
  const before = lineText.slice(0, cursorCol);
  if (before.startsWith("/")) {
    const space = before.indexOf(" ");
    // The command name itself, or — since 2026-09-02 round three, item 7 —
    // its first argument, which starts after that space. An `@token` inside
    // the arguments anchors on the `@`, same as anywhere else.
    if (space === -1) return { startCol: 0, endCol: cursorCol };
    const atArg = before.lastIndexOf("@");
    if (atArg > space) return { startCol: atArg + 1, endCol: cursorCol };
    return { startCol: space + 1, endCol: cursorCol };
  }
  const at = before.lastIndexOf("@");
  if (at !== -1) return { startCol: at + 1, endCol: cursorCol };
  return { startCol: cursorCol, endCol: cursorCol };
}

/** One event as a compact tag for the input capture: its type, plus whatever about it would matter when reading a paste back. */
function describeEvent(ev: KeyEvent): string {
  if (ev.type === "char") return `char ${visibleBytes(ev.value)}`;
  if (ev.type === "paste") return `paste ${visibleBytes(ev.text)}`;
  if (ev.type === "enter") return `enter${ev.shift ? " shift" : ""}${ev.ctrl ? " ctrl" : ""}${ev.alt ? " alt" : ""}`;
  if (ev.type === "unknown") return `unknown ${visibleBytes(ev.bytes)}`;
  return ev.type;
}

/** Two clicks closer together than this, on the same cell, are a double-click. 400ms is the common desktop default. */
const DOUBLE_CLICK_MS = 400;

export class RawLineSource implements LineSource {
  private readonly decoder = new KeyDecoder();
  private readonly editor = new LineEditor();
  private readonly queue: string[] = [];
  private pendingResolve: ((v: string | null) => void) | null = null;
  private closed = false;
  private history: string[];
  private readonly workspace: string | undefined;
  private readonly onInterrupt: (() => void) | undefined;
  private readonly onChange: ((state: EditorState) => void) | undefined;
  private readonly onScroll: ((action: "pageUp" | "pageDown" | "wheelUp" | "wheelDown") => void) | undefined;
  private readonly completionRoot: string | undefined;
  private readonly onCompletionChange: ((candidates: Candidate[], selected: number) => void) | undefined;
  private readonly onCopy: ((text: string) => void) | undefined;
  private readonly readClipboard: (() => string | null) | undefined;

 private readonly composerGeometry: (() => ComposerGeometry | null) | undefined;
  private readonly completionGeometry: (() => { firstRow: number } | null) | undefined;
  private readonly resolveClick: ((row: number, col: number) => ClickAction | null) | undefined;
  private readonly onAction: ((action: ClickAction) => void) | undefined;
  private readonly onCtrlKey: ((key: string, shift: boolean) => boolean) | undefined;
  private readonly onHover: ((row: number, col: number) => void) | undefined;
  private readonly onShiftTab: (() => boolean) | undefined;
  private readonly onTranscriptSearchQuery: ((query: string) => void) | undefined;
  private readonly onTranscriptSearchSubmit: ((query: string) => void) | undefined;
  private readonly onTranscriptSearchCancel: (() => void) | undefined;
  private readonly onTranscriptSearchMove: ((direction: "next" | "previous") => void) | undefined;
  private readonly onDoubleEscape: (() => boolean) | undefined;
  private readonly doubleEscapeWindowMs: number;
  private lastEscapeAt = 0;
  private readonly onAltArrow: ((direction: "left" | "right") => boolean) | undefined;

  private completionCandidates: Candidate[] = [];
  private completionIndex = -1;
  /** The dismissed token's anchor start column (`completionAnchorFor()`'s `startCol`), or null when nothing is dismissed. Compared against the CURRENT anchor on every refresh: unchanged means the user is still extending the same `/co`/`@pa` token Escape closed, so the popup stays closed; changed (typed past it, backspaced out of it, started a different token) clears the dismissal. A plain boolean would either reopen on every keystroke of the same token or stay stuck closed for the rest of the session — neither is what Escape means. */
  private completionDismissedAt: number | null = null;

  private historyIndex: number | null = null;
  private draftBeforeHistory = "";
  private searchPrefix: string | null = null;
  private searchResults: string[] = [];
  private searchPos = 0;
  private transcriptSearchMode = false;
  private transcriptSearchQuery = "";

  /** Mouse drag state: true between a press inside the composer and its release. */
  private dragging = false;
  private lastClickAt = 0;
  private lastClickCell: { row: number; col: number } | null = null;

  constructor(opts: RawLineSourceOptions = {}) {
    this.history = opts.history ? [...opts.history] : [];
    this.workspace = opts.workspace;
    this.onInterrupt = opts.onInterrupt;
    // P14.6 ticket 06: while a secret is being typed, whatever paints the
    // composer is handed a masked copy of the state, never the text.
    const onChange = opts.onChange;
    this.onChange = onChange === undefined ? undefined : (state) => onChange(this.secretEntry ? maskEditorState(state) : state);
    this.onScroll = opts.onScroll;
    this.completionRoot = opts.completionRoot;
    this.onCompletionChange = opts.onCompletionChange;
    this.onCopy = opts.onCopy;
    this.readClipboard = opts.readClipboard;
    this.composerGeometry = opts.composerGeometry;
    this.completionGeometry = opts.completionGeometry;
    this.resolveClick = opts.resolveClick;
    this.onAction = opts.onAction;
    this.onCtrlKey = opts.onCtrlKey;
    this.onHover = opts.onHover;
    this.onShiftTab = opts.onShiftTab;
    this.onTranscriptSearchQuery = opts.onTranscriptSearchQuery;
    this.onTranscriptSearchSubmit = opts.onTranscriptSearchSubmit;
    this.onTranscriptSearchCancel = opts.onTranscriptSearchCancel;
    this.onTranscriptSearchMove = opts.onTranscriptSearchMove;
    this.onDoubleEscape = opts.onDoubleEscape;
    this.doubleEscapeWindowMs = opts.doubleEscapeWindowMs ?? 500;
    this.onAltArrow = opts.onAltArrow;
  }

  get editorState(): EditorState {
    return this.secretEntry ? maskEditorState(this.editor.state) : this.editor.state;
  }

  /** P14.6 ticket 06: true while `nextSecret()` is waiting for its line. */
  private secretEntry = false;

  /**
   * The next submitted line as a secret (`/login`'s key or token prompt):
   * painted masked while typed, and never added to input history, in memory
   * or on disk.
   */
  nextSecret(): Promise<string | null> {
    this.secretEntry = true;
    this.onChange?.(this.editor.state);
    return this.next().finally(() => {
      this.secretEntry = false;
      this.onChange?.(this.editor.state);
    });
  }

  get isSearching(): boolean {
    return this.searchPrefix !== null || this.transcriptSearchMode;
  }

  beginTranscriptSearch(): void {
    this.transcriptSearchMode = true;
    this.transcriptSearchQuery = "";
    this.onTranscriptSearchQuery?.("");
  }

  /** For tests and for a caller that wants to know without listening for onCompletionChange. */
  get completionActive(): boolean {
    return this.completionCandidates.length > 0;
  }

  /** For tests: true once `next()` has registered a waiting reader with nothing queued — the raw-mode equivalent of `ScriptedLineSource.onWaiting()` in interactive.test.ts. */
  get hasPendingRead(): boolean {
    return this.pendingResolve !== null;
  }

  /** Feed raw bytes from stdin. */
  feedBytes(chunk: string, opts?: FeedOptions): void {
    if (this.closed) return;
    const events = this.decoder.feed(chunk, opts);
    for (const ev of events) this.handleKey(ev);
    if (inputLogPath()) {
      writeInputLog({
        kind: "feed",
        bytes: visibleBytes(chunk),
        contiguous: opts?.contiguous === true,
        events: events.map(describeEvent),
        lines: [...this.editor.state.lines],
      });
    }
  }

  /** Called by the caller after an idle gap — resolves a lone pending ESC (T46.1's `flush()` contract). */
  flushPending(): void {
    if (this.closed) return;
    const events = this.decoder.flush();
    for (const ev of events) this.handleKey(ev);
    if (inputLogPath() && events.length > 0) {
      writeInputLog({ kind: "flush", events: events.map(describeEvent), lines: [...this.editor.state.lines] });
    }
  }

  next(): Promise<string | null> {
    if (this.queue.length > 0) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pendingResolve) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(null);
    }
  }

  private handleKey(ev: KeyEvent): void {
    if (ev.type === "ctrl" && ev.key === "c" && !ev.shift) {
      // See this file's module doc: a live selection turns the first
      // Ctrl-C into a copy and clears the selection, so the second one
      // aborts. With nothing selected it aborts immediately, unchanged.
      if (this.editor.hasSelection) {
        this.copySelection();
        this.onChange?.(this.editor.state);
        return;
      }
      this.onInterrupt?.();
      return;
    }
    // Scroll actions never reach the editor or history — they read the
    // transcript, they do not edit or recall the composer's text.
    if (ev.type === "pageUp") {
      this.onScroll?.("pageUp");
      return;
    }
    if (ev.type === "pageDown") {
      this.onScroll?.("pageDown");
      return;
    }
    if (ev.type === "wheel") {
      // Ctrl+wheel scrolls like any other notch. It used to be skipped, on
      // the theory that the terminal would zoom its own font on the same
      // gesture — it will not: with tracking on, the wheel is forwarded
      // here and the terminal never sees it, so skipping the notch just
      // made Ctrl+wheel do nothing at all. Zoom lives on Ctrl +/- instead
      // (2026-09-02 round three, item 1).
      this.onScroll?.(ev.dir === "up" ? "wheelUp" : "wheelDown");
      return;
    }
    if (ev.type === "mouse") {
      this.handleMouse(ev);
      return;
    }
    if (ev.type === "tab" && ev.shift && this.onShiftTab?.() === true) {
      return;
    }
    if (this.transcriptSearchMode) {
      this.handleTranscriptSearchKey(ev);
      return;
    }
    if (this.isSearching) {
      this.handleSearchKey(ev);
      this.onChange?.(this.editor.state);
      return;
    }
    // While the popup is showing, Up/Down move the highlighted candidate
    // instead of the cursor/history, Tab accepts it, and Escape dismisses
    // it — none of these three reach the editor at all. Any other key
    // (typing, backspace, left/right, …) falls through to the normal
    // switch below and the list is re-filtered against the new text after.
    if (this.completionActive) {
      // Ctrl+Up/Down is history recall and passes straight through — the
      // popup only ever owns the PLAIN arrows (2026-09-02 round seven,
      // item 3: "tab completer should only detect arrow up down, not Ctrl
      // Arrow up down"). Recalling an earlier prompt while a completion
      // list happens to be open is a legitimate thing to want, and having
      // the list silently swallow the gesture reads as the key being dead.
      if (ev.type === "arrow" && ev.dir === "up" && !ev.ctrl) {
        this.moveCompletionSelection(-1);
        return;
      }
      if (ev.type === "arrow" && ev.dir === "down" && !ev.ctrl) {
        this.moveCompletionSelection(1);
        return;
      }
      if (ev.type === "tab") {
        this.acceptCompletion();
        this.onChange?.(this.editor.state);
        return;
      }
      if (ev.type === "escape") {
        const state = this.editor.state;
        const lineText = state.lines[state.cursorRow] ?? "";
        this.completionDismissedAt = completionAnchorFor(lineText, state.cursorCol).startCol;
        this.clearCompletion();
        this.onChange?.(this.editor.state);
        return;
      }
    }
    switch (ev.type) {
      case "paste":
        this.editor.insertText(ev.text);
        break;
      case "char":
        this.editor.insertChar(ev.value);
        break;
      case "enter":
        // Any modifier means newline. Shift+Enter is the gesture people
        // ask for, Ctrl+Enter is the one they reach for when it does not
        // work, and Alt+Enter is what a terminal that reports neither can
        // always deliver — treating all three the same costs nothing and
        // means the answer to "which one is it" is "whichever you pressed".
        if (ev.alt || ev.shift || ev.ctrl) this.editor.newline();
        else this.submit();
        break;
      case "backspace":
        if (ev.ctrl) this.editor.deleteWordBackward();
        else this.editor.backspace();
        break;
      case "delete":
        if (ev.ctrl) this.editor.deleteWordForward();
        else this.editor.deleteForward();
        break;
      case "arrow":
        // **Alt+Left opens the session browser; Ctrl+Left does not.**
        //
        // The history is worth keeping because it reversed twice. T126 chose
        // Alt+Left precisely because Ctrl+Left was already word-left and the
        // whole `Alt+` family was free. On 2026-09-07 the maintainer asked
        // for Ctrl+Left as well and it was routed here. On 2026-09-08 they
        // hit the collision T126 had predicted and asked for it back, which
        // settles it in favour of the original analysis: **word-left is worth
        // more than a second way to open the browser**, and Alt+Left is
        // still the browser gesture it always was.
        if (ev.alt && ev.dir === "left" && this.onAltArrow?.("left") === true) break;
        if (ev.alt) {
          if (ev.dir === "right" && this.onAltArrow?.("right") === true) break;
          break;
        }
        this.handleArrow(ev.dir, ev.ctrl ?? false, ev.shift ?? false);
        break;
      case "home":
        if (ev.ctrl) this.editor.moveTo(0, 0, ev.shift ?? false);
        else this.editor.home(ev.shift ?? false);
        break;
      case "end":
        if (ev.ctrl) this.editor.moveTo(this.editor.lineCount - 1, Number.MAX_SAFE_INTEGER, ev.shift ?? false);
        else this.editor.end(ev.shift ?? false);
        break;
      case "escape":
        {
          const now = Date.now();
          if (now - this.lastEscapeAt <= this.doubleEscapeWindowMs && this.onDoubleEscape?.() === true) {
            this.lastEscapeAt = 0;
            return;
          }
          this.lastEscapeAt = now;
        }
        // Nothing to dismiss but a selection — dropping it is what Escape
        // means in every editor.
        this.editor.clearSelection();
        break;
      case "ctrl":
        this.handleCtrl(ev.key, ev.shift ?? false);
        break;
      default:
        break;
    }
    this.refreshCompletion();
    this.onChange?.(this.editor.state);
  }

  /**
   * **Up/Down edit; Ctrl+Up/Down recall.** 2026-09-02 round seven, item 1:
   * "Arrow up down is now only used for scrolling up down in the current
   * prompt... if at line one, up goes to first, if at last line, down goes
   * to last just like a normal editor."
   *
   * Until this round Up/Down moved a logical row and fell through to
   * history recall at the buffer's edge, which meant a multi-line prompt
   * could not be navigated past its own first line without recalling
   * something instead — and made the two gestures indistinguishable from
   * the outside. History now has its own binding and the arrows are purely
   * an editing motion, which is also the first time they respect soft
   * word-wrap: they move by VISUAL row, closing the limitation round five
   * named when it added wrapping.
   */
  private handleArrow(dir: "up" | "down" | "left" | "right", ctrl: boolean, shift: boolean): void {
    if (dir === "left") {
      ctrl ? this.editor.moveWordLeft(shift) : this.editor.moveLeft(shift);
    } else if (dir === "right") {
      ctrl ? this.editor.moveWordRight(shift) : this.editor.moveRight(shift);
    } else if (dir === "up") {
      if (ctrl) this.recallOlder();
      else this.moveVisualUp(shift);
    } else if (dir === "down") {
      if (ctrl) this.recallNewer();
      else this.moveVisualDown(shift);
    }
  }

  /**
   * The cursor's index into the composer's full visual `rowMap`, or null
   * when there is no geometry to read (a caller that supplies none, or a
   * frame that has not been painted yet) — in which case the arrows fall
   * back to `LineEditor`'s own logical-row movement, which is exactly what
   * they did before wrapping existed.
   */
  private visualRowIndex(): { map: NonNullable<ComposerGeometry["rowMap"]>; index: number } | null {
    const map = this.composerGeometry?.()?.rowMap;
    if (!map || map.length === 0) return null;
    const { cursorRow, cursorCol } = this.editor.state;
    let index = -1;
    for (let i = 0; i < map.length; i++) {
      const entry = map[i]!;
      if (entry.logicalRow !== cursorRow) continue;
      if (entry.startCol <= cursorCol) index = i;
      else break;
    }
    return index === -1 ? null : { map, index };
  }

  /** Places the cursor on `map[index]`, keeping the column it visually sat at, clamped to that row's own extent. */
  private moveToVisualRow(map: NonNullable<ComposerGeometry["rowMap"]>, from: number, to: number, extend: boolean): void {
    const offset = this.editor.state.cursorCol - map[from]!.startCol;
    const target = map[to]!;
    this.editor.moveTo(target.logicalRow, Math.min(target.startCol + offset, target.endCol), extend);
  }

  private moveVisualUp(extend: boolean): void {
    const at = this.visualRowIndex();
    if (!at) {
      // No geometry: logical movement, and Home-at-the-top rather than
      // history recall, which is the whole point of this round's change.
      if (!this.editor.moveUp(extend)) this.editor.moveTo(0, 0, extend);
      return;
    }
    if (at.index === 0) {
      this.editor.moveTo(0, 0, extend);
      return;
    }
    this.moveToVisualRow(at.map, at.index, at.index - 1, extend);
  }

  private moveVisualDown(extend: boolean): void {
    const at = this.visualRowIndex();
    if (!at) {
      if (!this.editor.moveDown(extend)) this.editor.moveTo(this.editor.lineCount - 1, Number.MAX_SAFE_INTEGER, extend);
      return;
    }
    if (at.index === at.map.length - 1) {
      this.editor.moveTo(this.editor.lineCount - 1, Number.MAX_SAFE_INTEGER, extend);
      return;
    }
    this.moveToVisualRow(at.map, at.index, at.index + 1, extend);
  }

  private handleCtrl(key: string, shift: boolean): void {
    if (this.onCtrlKey?.(key, shift) === true) return;
    switch (key) {
      case "k":
        this.editor.killToEnd();
        break;
      case "u":
        this.editor.killLine();
        break;
      case "w":
        this.editor.deleteWordBackward();
        break;
      case "a":
        // Select All, not beginning-of-line — see this file's module doc.
        this.editor.selectAll();
        break;
      case "e":
        this.editor.end();
        break;
      case "r":
        this.startSearch();
        break;
      case "z":
        if (shift) this.editor.redo();
        else this.editor.undo();
        break;
      case "y":
        this.editor.redo();
        break;
      case "x":
        this.cutSelection();
        break;
      case "v":
        this.paste();
        break;
      default:
        break;
    }
  }

  private handleTranscriptSearchKey(ev: KeyEvent): void {
    if (ev.type === "escape") {
      this.transcriptSearchMode = false;
      this.onTranscriptSearchCancel?.();
      return;
    }
    if (ev.type === "enter") {
      this.transcriptSearchMode = false;
      this.onTranscriptSearchSubmit?.(this.transcriptSearchQuery);
      return;
    }
    if (ev.type === "backspace") {
      this.transcriptSearchQuery = this.transcriptSearchQuery.slice(0, -1);
      this.onTranscriptSearchQuery?.(this.transcriptSearchQuery);
      return;
    }
    if (ev.type === "arrow" && (ev.dir === "up" || ev.dir === "left")) {
      this.onTranscriptSearchMove?.("previous");
      return;
    }
    if (ev.type === "arrow" && (ev.dir === "down" || ev.dir === "right")) {
      this.onTranscriptSearchMove?.("next");
      return;
    }
    if (ev.type === "char") {
      this.transcriptSearchQuery += ev.value;
      this.onTranscriptSearchQuery?.(this.transcriptSearchQuery);
    } else if (ev.type === "paste") {
      this.transcriptSearchQuery += ev.text.replace(/[\r\n]/g, " ");
      this.onTranscriptSearchQuery?.(this.transcriptSearchQuery);
    }
  }

  // --- 2026-09-02: clipboard ---

  private copySelection(): void {
    const text = this.editor.copy();
    if (text.length === 0) return;
    this.onCopy?.(text);
    // Clearing is what makes the second Ctrl-C an abort rather than a
    // second copy of the same text.
    this.editor.clearSelection();
  }

  private cutSelection(): void {
    const text = this.editor.cut();
    if (text.length > 0) this.onCopy?.(text);
  }

  /**
   * The system clipboard when it can be read, the editor's own cut/copy
   * register otherwise — so Ctrl-X then Ctrl-V works in a session where no
   * platform clipboard tool exists at all. A terminal's own paste gesture
   * (Ctrl-Shift-V, middle click, right click) still arrives as bracketed
   * paste and never reaches this path.
   */
  private paste(): void {
    const system = this.readClipboard?.() ?? null;
    const text = system !== null && system.length > 0 ? system : this.editor.clipboardRegister;
    if (text.length > 0) this.editor.insertText(text);
  }

  // --- 2026-09-02: mouse click, drag-select, double-click ---

  /**
   * A visual (row, col) — what a mouse report actually names — translated
   * to the logical (row, col) `LineEditor` understands, via `geom.rowMap`.
   * `visualRow` is clamped into the map's own bounds first (a drag past
   * the composer's top/bottom edge, or a geometry with no rows yet), and
   * `visualCol` is added to the segment's own `startCol` rather than used
   * directly — that offset is the whole reason `rowMap` exists.
   */
  private logicalPosition(geom: ComposerGeometry, visualRow: number, visualCol: number): { row: number; col: number } {
    const map = geom.rowMap;
    if (!map || map.length === 0) return { row: visualRow, col: visualCol };
    // `rowMap` covers the whole buffer; a mouse report names a row inside
    // the rendered window, so the window's own start is added before
    // indexing (2026-09-02 round seven).
    const clamped = Math.max(0, Math.min(visualRow + (geom.rowOffset ?? 0), map.length - 1));
    const entry = map[clamped]!;
    return { row: entry.logicalRow, col: entry.startCol + visualCol };
  }

  /**
   * Three fixed regions, checked in order, plus a fourth that is
   * anything but fixed:
   *
   *  1. The tab-completion popup — its own frame region
   *     (`completionGeometry`), checked first because it can sit directly
   *     above or below the composer depending on `ui.completion_position`
   *     and the two must never fight over a click on their shared edge.
   *     2026-09-02 round nine, item 3: "Tab completer: user can click the
   *     completer they want." A single click both selects AND accepts —
   *     the same as Tab already does for the highlighted one, so clicking
   *     a DIFFERENT row is "I want that one," not "let me look at that
   *     one first."
   *  2. The composer, unchanged from before this round.
   *  3. Everything else in the frame — the scrollback viewport and the
   *     footer — resolved generically via `resolveClick`, which the
   *     caller wires to `ScreenPipeline.actionAt()`. This is where an
   *     approval's `[y]`/`[n]`/`[a]`/`[Esc]` pills, a fold hint, a link,
   *     and the footer's legend all land; this class does not know or
   *     care which.
   *
   * A drag already in progress (started inside the composer) keeps
   * extending even once the pointer leaves it — unchanged from before —
   * which is why the composer's own bounds check happens after, not
   * instead of, the drag branch.
   */
  private handleMouse(ev: Extract<KeyEvent, { type: "mouse" }>): void {
    // Hover — motion with no button held, reported since round eleven
    // turned on `?1003h`. It never touches the editor, the selection, or
    // the drag state: it is a pure notification, and the pipeline decides
    // whether it means anything. Handled before the button filter below
    // because a hover report carries the SGR "no button" code (3), not 0.
    if (ev.action === "move") {
      this.onHover?.(ev.row, ev.col);
      return;
    }

    // Only the left button edits/clicks; a right/middle click is left to
    // the terminal, which is where paste-on-click lives on most platforms.
    if (ev.button !== 0) return;

    if (ev.action === "up") {
      this.dragging = false;
      return;
    }

    if (ev.action === "down" && this.completionActive && this.completionGeometry) {
      const cGeom = this.completionGeometry();
      if (cGeom) {
        const { start, end } = completionWindow(this.completionCandidates.length, this.completionIndex, DEFAULT_COMPLETION_MAX_VISIBLE);
        const rowIdx = ev.row - cGeom.firstRow;
        if (rowIdx >= 0 && rowIdx < end - start) {
          this.completionIndex = start + rowIdx;
          this.acceptCompletion();
          this.onChange?.(this.editor.state);
          return;
        }
      }
    }

    const geom = this.composerGeometry?.() ?? null;
    if (geom) {
      const visualRow = ev.row - geom.firstBufferRow;
      const visualCol = ev.col - geom.prefixWidth;
      // Soft word-wrap (2026-09-02 round five) means the row a click lands
      // on is a VISUAL row, which no longer maps 1:1 onto the editor's own
      // logical rows — `rowMap` is what translates back. A drag that has
      // wandered past the top/bottom of the composer clamps to the
      // nearest real row rather than being dropped, same as
      // `editor.moveTo()` already clamps an out-of-range column.
      const logical = this.logicalPosition(geom, visualRow, visualCol);

      if (ev.action === "drag") {
        // A drag that started in the composer keeps extending even when
        // the pointer wanders out of it, clamped by `moveTo` — releasing
        // outside the box should not silently abandon the selection.
        if (!this.dragging) return;
        this.editor.moveTo(logical.row, logical.col, true);
        this.onChange?.(this.editor.state);
        return;
      }

      if (visualRow >= 0 && visualRow < geom.rowCount) {
        const now = Date.now();
        const isDouble =
          this.lastClickCell !== null &&
          this.lastClickCell.row === ev.row &&
          this.lastClickCell.col === ev.col &&
          now - this.lastClickAt < DOUBLE_CLICK_MS;
        this.lastClickAt = now;
        this.lastClickCell = { row: ev.row, col: ev.col };

        this.editor.moveTo(logical.row, logical.col, ev.shift ?? false);
        if (isDouble) {
          this.editor.selectWordAtCursor();
          this.dragging = false;
        } else {
          this.dragging = true;
        }
        this.onChange?.(this.editor.state);
        return;
      }
    }

    // Outside the composer (and not a completion-popup click, and not an
    // in-progress drag that just wandered out of the box) — the rest of
    // the frame's own clickable regions, resolved generically.
    this.dragging = false;
    if (ev.action === "down" && this.resolveClick) {
      const action = this.resolveClick(ev.row, ev.col);
      if (action) this.onAction?.(action);
    }
  }

  // --- T46.3 history ---

  private recallOlder(): void {
    if (this.history.length === 0) return;
    if (this.historyIndex === null) {
      this.draftBeforeHistory = this.editor.text;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      return;
    }
    this.editor.reset(this.history[this.historyIndex]!);
  }

  private recallNewer(): void {
    if (this.historyIndex === null) return;
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.editor.reset(this.history[this.historyIndex]!);
    } else {
      this.historyIndex = null;
      this.editor.reset(this.draftBeforeHistory);
    }
  }

  // --- T47: tab completion — auto-shown while typing, never committed until accepted ---

  /**
   * Recomputes the candidate list from the CURRENT text/cursor and always
   * resets the selection to the top match — called after every text- or
   * cursor-mutating key so the popup live-filters as the user types, the
   * way a `/` menu is expected to behave rather than requiring a Tab press
   * just to see what exists. Never touches the editor's own text: showing
   * the list and committing a choice from it are two different actions.
   */
  private refreshCompletion(): void {
    if (!this.completionRoot) {
      this.clearCompletion();
      return;
    }
    const state = this.editor.state;
    const lineText = state.lines[state.cursorRow] ?? "";
    const anchorStart = completionAnchorFor(lineText, state.cursorCol).startCol;
    if (this.completionDismissedAt !== null) {
      if (this.completionDismissedAt === anchorStart) {
        this.clearCompletion();
        return;
      }
      this.completionDismissedAt = null;
    }
    const candidates = complete(this.completionRoot, lineText, state.cursorCol);
    if (candidates.length === 0) {
      this.clearCompletion();
      return;
    }
    this.completionCandidates = candidates;
    this.completionIndex = 0;
    this.onCompletionChange?.(this.completionCandidates, this.completionIndex);
  }

  private moveCompletionSelection(delta: number): void {
    const len = this.completionCandidates.length;
    if (len === 0) return;
    this.completionIndex = ((this.completionIndex + delta) % len + len) % len;
    this.onCompletionChange?.(this.completionCandidates, this.completionIndex);
  }

  /** Tab: replace the token at the cursor with the highlighted candidate and close the popup. Never submits — a second Enter is still required, same as accepting a shell completion. */
  private acceptCompletion(): void {
    const candidate = this.completionCandidates[this.completionIndex];
    if (!candidate) return;
    const state = this.editor.state;
    const lineText = state.lines[state.cursorRow] ?? "";
    const anchor = completionAnchorFor(lineText, state.cursorCol);
    this.editor.replaceRange(anchor.startCol, anchor.endCol, candidate.label);
    this.clearCompletion();
  }

  private clearCompletion(): void {
    const wasActive = this.completionCandidates.length > 0;
    this.completionCandidates = [];
    this.completionIndex = -1;
    if (wasActive) this.onCompletionChange?.([], -1);
  }

  // --- T46.3 Ctrl-R: prefix-filtered search, cheap ---

  private startSearch(): void {
    this.searchPrefix = this.editor.text;
    this.searchResults = searchHistoryByPrefix(this.history, this.searchPrefix);
    this.searchPos = 0;
    if (this.searchResults.length > 0) this.editor.reset(this.searchResults[0]!);
  }

  private handleSearchKey(ev: KeyEvent): void {
    if (ev.type === "ctrl" && ev.key === "r") {
      if (this.searchResults.length > 0) {
        this.searchPos = (this.searchPos + 1) % this.searchResults.length;
        this.editor.reset(this.searchResults[this.searchPos]!);
      }
      return;
    }
    if (ev.type === "escape") {
      this.endSearch();
      return;
    }
    if (ev.type === "enter" && !ev.alt && !ev.shift && !ev.ctrl) {
      this.endSearch();
      this.submit();
      return;
    }
    // Any other key exits search mode and is NOT re-applied — a simplification
    // documented here rather than silently dropped: T46.3 asks for Ctrl-R "if
    // cheap," and re-dispatching the key into normal editing after leaving
    // search is the part that would need a second pass through handleKey().
    this.endSearch();
  }

  private endSearch(): void {
    this.searchPrefix = null;
    this.searchResults = [];
    this.searchPos = 0;
  }

  private submit(): void {
    const text = this.editor.text;
    this.editor.reset();
    this.historyIndex = null;
    this.draftBeforeHistory = "";
    this.dragging = false;
    if (text.trim().length > 0 && !this.secretEntry) {
      this.history.push(text);
      if (this.workspace) appendHistory(this.workspace, text);
    }
    // ONE queue entry, newlines and all — not one entry per physical row
    // with a trailing backslash on each, which is how T46.4 originally
    // bridged a multi-line composer to a single-line-at-a-time loop.
    //
    // That bridge silently DELETED every line break in a pasted or
    // Shift+Entered prompt (2026-09-02 round twelve, item 3). The
    // receiving end, `runInteractiveLoop`, reassembles a continued line as
    // `pending + line` — no separator, because the backslash-continuation
    // protocol it was built for means "this line keeps going", which is
    // exactly not what a real newline in a pasted block means. Three
    // pasted lines reached the model as one run-on line, and no amount of
    // fixing the key decoder could have shown up as anything but "pasting
    // multiple lines still bugs".
    //
    // A multi-line entry is safe for the loop: it trims and inspects the
    // whole string, and a `/command` or `!bash` line is a single row by
    // construction. The append-only surface's readline source cannot
    // produce an embedded newline at all, so the backslash protocol it
    // still relies on for typed continuations is untouched.
    this.queue.push(text);
    this.drain();
  }

  /**
   * T114: deliver a line the user did not type — the session browser's
   * chosen row, arriving as `/resume <id>`.
   *
   * Deliberately NOT `submit()`: the editor is not touched (there may be a
   * half-written prompt in it, and losing that to a browser you opened by
   * accident would be its own bug), and nothing is appended to history,
   * because history is a record of what a person typed.
   */
  inject(text: string): void {
    this.queue.push(text);
    this.drain();
  }

  private drain(): void {
    while (this.pendingResolve && this.queue.length > 0) {
      const resolve = this.pendingResolve;
      this.pendingResolve = null;
      resolve(this.queue.shift()!);
    }
  }
}

export { loadHistory };

/** Every character of the composer's text as a bullet; cursor and selection keep their columns. */
function maskEditorState(state: EditorState): EditorState {
  return { ...state, lines: state.lines.map((line) => "•".repeat([...line].length)) };
}
