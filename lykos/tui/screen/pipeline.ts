// The pull architecture from §1 wired end to end: AgentSessionEvent-shaped
// input -> Scrollback (T43) -> the frame scheduler (T41.4) -> renderApp
// (T42/T48) -> FrameWriter (T41.3) -> a sink. `ScreenPipeline` is what the
// wall-time comparison (fullscreen-wall-time.test.ts) measured, and what
// `session/interactive.ts`'s production wiring drives with real stdout
// instead of a synthetic sink, gated by `fallback.ts`'s
// `decideRenderMode()`.
//
// `updateBlock()` exists for the two mutate-in-place cases production
// wiring needs and a one-shot demo does not: streaming assistant text (the
// same block id grows with every delta) and a tool call's status moving
// from `running` to `ok`/`error` without leaving a stale duplicate line.
// `setCursor()` exists for the composer's real cursor — not needed to prove
// the render pipeline alone, needed to actually drive a terminal. It had a
// sibling, `setOverlay()`, for T49's full-screen approval modal; the modal
// became an ordinary scrollback block on 2026-09-02 (round three, item 11)
// and the overlay path was deleted rather than kept as an unused primitive.
//
// T114 brings back a narrower version of it, `setFullView()`, for a screen
// that genuinely replaces the session rather than appearing inside it: the
// session browser. The distinction the 2026-09-02 deletion drew is the one
// being honoured, not overturned — an approval belongs IN the transcript,
// because it is part of the conversation and you want to see it afterwards;
// a list of sessions is not part of any conversation and must not be left
// behind in one. The first cut of the browser proved the point by rendering
// as a block and coming back, on a second open, at its old position far up
// the scroll with the keyboard still pointed at it.

import { FrameScheduler, realClock, type SchedulerClock } from "./scheduler.js";
import { FrameWriter, highlightSpan, makeFrame, type Frame, type FrameSink } from "./frame.js";
import { Scrollback, type ClickAction } from "./scrollback.js";
import { renderApp, type AppState } from "./app.js";
import { computeLayout } from "./layout.js";
import { toScrollbackBlock, type ScreenBlock } from "./blocks.js";
import { headerBackSpan, type ScreenHeaderInfo } from "./header.js";
import { withBackground, type ResolvedTheme } from "../theme/resolve.js";
import { visibleWidth } from "./frame.js";
import type { ViewModel } from "../types.js";

export interface CursorPosition {
  /** 0-indexed row/col within the frame. */
  row: number;
  col: number;
}

export interface ScreenPipelineOptions {
  width: number;
  height: number;
  theme: ResolvedTheme;
  header: ScreenHeaderInfo;
  sink: FrameSink;
  maxHz?: number;
  clock?: SchedulerClock;
  maxScrollbackLines?: number;
  /** `ui.completion_position` — see `LayoutInput.completionAbove`. Default true (above the composer). */
  completionAbove?: boolean;
}

/**
 * Ties the pieces built across T41-T49 into one working loop. Owns no
 * terminal, no stdin, no ledger — `pushBlock()`/`setViewModel()` mutate
 * state and mark the frame dirty; the scheduler decides when to actually
 * call `renderApp()` and write the diff to `sink`. Exactly the "push
 * becomes pull" split §1 describes, and the reason resize, scrollback,
 * and a testable `Frame` all fall out of it for free.
 */
export class ScreenPipeline {
  private readonly scrollback: Scrollback;
  private readonly writer: FrameWriter;
  private readonly scheduler: FrameScheduler;
  private readonly sink: FrameSink;
  private width: number;
  private height: number;
  private readonly theme: ResolvedTheme;
  private readonly header: ScreenHeaderInfo;
  private vm: ViewModel | null = null;
  /** Every block ever pushed, in order — the source `setExpanded()` re-renders from. The scrollback holds rendered lines, not the blocks that made them. */
  private readonly blocks: ScreenBlock[] = [];
  private footerVisible = true;
  private composerLines: string[] = ["> "];
  /** The composer's real cursor position — null hides it (T41 hides the cursor on entry; this is the one place it comes back). */
  private cursor: CursorPosition | null = null;
  /** T47.3: rendered popup lines (`renderCompletionPopup()`'s output), composited directly onto the app frame — never null-when-empty, `setCompletionPopup(null)` is the hide signal. */
  private completionPopup: string[] | null = null;
  /**
   * The animated "Working..." status line (2026-09-02 UI feedback — Pi's
   * own `Loader` component, inspected in `node_modules`, renders exactly
   * this: a braille spinner plus a muted message, re-rendered on an 80ms
   * timer independent of whether any real content has arrived yet). Its
   * caller (`fullscreen-ui.ts`) owns the timer; this class only paints
   * whatever string it's given.
   *
   * It gets its OWN layout region as of 2026-09-02 (UI feedback item 1),
   * rather than being composited over whichever viewport row happened to
   * sit above the composer. Compositing destroyed a line of transcript for
   * as long as the turn ran, and left the spinner touching the last line
   * of output with no gap; a region displaces nothing, and the blank row
   * every block now ends with sits above it. The completion popup is still
   * composited, and still wins if the two ever collide.
   */
  private statusLine: string | null = null;
  private readonly completionAbove: boolean;
  /**
   * Whether folded blocks (a long diff, a long bash output) render
   * expanded — `/verbose`'s toggle, which until 2026-09-02 round three was
   * tracked and inert. Held here rather than on each block because the
   * toggle is global and has to reach blocks already in the scrollback:
   * `setExpanded()` re-renders every one of them.
   */
  private expanded = false;
  /** T114: when set, these lines ARE the frame — see `setFullView()`. */
  private fullView: string[] | null = null;
  /**
   * Where the mouse is, and what it is over — round eleven, item 1's hover
   * highlight. `region` is the viewport-relative row and column span of
   * the clickable thing under the pointer, or null for "over nothing";
   * `setHover` only marks the frame dirty when THAT changes, so pointer
   * motion across ordinary transcript rows costs a lookup and no repaint.
   */
  private hover: { row: number; colStart: number; colEnd: number } | null = null;

  constructor(opts: ScreenPipelineOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.theme = opts.theme;
    this.header = opts.header;
    this.sink = opts.sink;
    this.completionAbove = opts.completionAbove ?? true;
    this.scrollback = new Scrollback({ maxLines: opts.maxScrollbackLines ?? 5000 });
    this.writer = new FrameWriter(opts.sink);
    this.scheduler = new FrameScheduler({
      render: () => this.paint(),
      ...(opts.maxHz !== undefined ? { maxHz: opts.maxHz } : {}),
      ...(opts.clock ? { clock: opts.clock } : { clock: realClock }),
    });
  }

  get renders(): number {
    return this.scheduler.renders;
  }

  get diffWrites(): number {
    return this.writer.diffWrites;
  }

  pushBlock(block: ScreenBlock): void {
    this.blocks.push(block);
    this.scrollback.push(toScrollbackBlock(block, this.theme, this.expanded), this.width);
    this.scheduler.markDirty();
  }

  /** The id of the most recently pushed block, or `undefined` before anything has been pushed — round ten, item 3: a caller can compare against this to avoid re-pushing an identical block when nothing has happened since the last one landed. */
  lastBlockId(): string | undefined {
    return this.blocks[this.blocks.length - 1]?.id;
  }

  /** Mutate an existing block in place by id — streaming text and a tool's status, per this file's module doc. Returns false, doing nothing, when the id is not found. */
  updateBlock(id: string, block: ScreenBlock): boolean {
    const ok = this.scrollback.updateBlock(id, toScrollbackBlock(block, this.theme, this.expanded), this.width);
    if (ok) {
      const at = this.blocks.findIndex((b) => b.id === id);
      if (at !== -1) this.blocks[at] = block;
      this.scheduler.markDirty();
    }
    return ok;
  }

  /**
   * `/verbose` for real (2026-09-02 round three, item 12: "i wanna see
   * content of it and can expand or close the command"). Re-renders every
   * block already in the scrollback at the new fold setting, because the
   * blocks the user wants expanded are the ones that already scrolled past
   * — a flag that only affected future blocks would be useless for exactly
   * the case it exists for.
   */
  setExpanded(expanded: boolean): void {
    if (expanded === this.expanded) return;
    this.expanded = expanded;
    for (const block of this.blocks) {
      this.scrollback.updateBlock(block.id, toScrollbackBlock(block, this.theme, this.expanded), this.width);
    }
    this.scheduler.markDirty();
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  /** The composer's real cursor. `null` hides it — the state T41 leaves the terminal in until this says otherwise. */
  setCursor(pos: CursorPosition | null): void {
    this.cursor = pos;
    this.scheduler.markDirty();
  }

  /**
   * The pointer moved (round eleven, item 1). Pass frame coordinates, or
   * null when the pointer leaves the frame entirely; the highlight is
   * applied to whichever clickable region contains the cell, and nothing
   * is repainted unless the hovered region actually changed. Hover is
   * resolved against the SAME regions `actionAt()` clicks against, so
   * anything that lights up is by construction something that does
   * something when clicked — the whole point of the affordance.
   */
  setHover(frameRow: number | null, frameCol = 0): void {
    const next = frameRow === null ? null : this.hoverRegionAt(frameRow, frameCol);
    const same =
      (next === null && this.hover === null) ||
      (next !== null &&
        this.hover !== null &&
        next.row === this.hover.row &&
        next.colStart === this.hover.colStart &&
        next.colEnd === this.hover.colEnd);
    if (same) return;
    this.hover = next;
    this.header.backHovered = next?.row === -1;
    this.scheduler.markDirty();
  }

  /** The viewport-relative span of the clickable region under a frame cell, or null. The footer's whole-row legend region is deliberately excluded: a band across the entire footer every time the pointer crosses it reads as a glitch, not as a button. */
  private hoverRegionAt(frameRow: number, frameCol: number): { row: number; colStart: number; colEnd: number } | null {
    const layout = this.currentLayout();
    if (frameRow === layout.header.top) {
      const span = headerBackSpan(this.header, this.theme);
      if (span && frameCol >= span.colStart && frameCol < span.colEnd) return { row: -1, colStart: span.colStart, colEnd: span.colEnd };
      return null;
    }
    if (frameRow < layout.viewport.top || frameRow >= layout.viewport.top + layout.viewport.height) return null;
    const viewportRow = frameRow - layout.viewport.top;
    const vp = this.scrollback.viewport(this.width, layout.viewport.height);
    const regions = vp.regions[viewportRow];
    if (!regions) return null;
    for (const r of regions) {
      if (frameCol >= r.colStart && frameCol < r.colEnd) return { row: viewportRow, colStart: r.colStart, colEnd: r.colEnd };
    }
    return null;
  }

  setViewModel(vm: ViewModel | null): void {
    this.vm = vm;
    this.scheduler.markDirty();
  }

  /** T120: update the displayed session model without rebuilding the screen. */
  setHeader(patch: Partial<ScreenHeaderInfo>): void {
    Object.assign(this.header, patch);
    this.scheduler.markDirty();
  }

  setFooterVisible(visible: boolean): void {
    this.footerVisible = visible;
    this.scheduler.markDirty();
  }

  setComposerLines(lines: string[]): void {
    this.composerLines = lines;
    this.scheduler.markDirty();
  }

  /**
   * T47.3: show (or, with `null`/an empty array, hide) the tab-completion
   * popup. A layout region under the composer since 2026-09-02 rather than
   * something composited over the viewport — see `LayoutInput.completionHeight`.
   */
  setCompletionPopup(lines: string[] | null): void {
    this.completionPopup = lines && lines.length > 0 ? lines : null;
    this.scheduler.markDirty();
  }

  /** The animated turn-in-progress status line — `null` hides it. See this class's field doc. */
  setStatus(line: string | null): void {
    this.statusLine = line;
    this.scheduler.markDirty();
  }

  /** T41.5: forces a full redraw at the new size — never trusted to a caller-side reset. */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.writer.reset();
    this.scheduler.markDirty();
  }

  /** Render now, ignoring the rate limit — the last frame before a caller blocks (an approval modal, teardown). */
  flush(): void {
    this.scheduler.flush();
  }

  /** T43.2/T43.3 exposed for real input: mouse wheel and PgUp/PgDn scroll the transcript, not the composer. */
  scrollUp(n: number): void {
    this.scrollback.scrollUp(n, this.width, this.currentLayout().viewport.height);
    this.scheduler.markDirty();
  }

  scrollDown(n: number): void {
    this.scrollback.scrollDown(n, this.width, this.currentLayout().viewport.height);
    this.scheduler.markDirty();
  }

  pageUp(): void {
    this.scrollback.pageUp(this.width, this.currentLayout().viewport.height);
    this.scheduler.markDirty();
  }

  pageDown(): void {
    this.scrollback.pageDown(this.width, this.currentLayout().viewport.height);
    this.scheduler.markDirty();
  }

  /** T125: search rendered transcript text without entering model context. */
  searchTranscript(query: string): number {
    const count = this.scrollback.search(query, this.width);
    this.scheduler.markDirty();
    return count;
  }

  nextTranscriptMatch(): void {
    this.scrollback.nextMatch(this.width, this.currentLayout().viewport.height);
    this.scheduler.markDirty();
  }

  previousTranscriptMatch(): void {
    this.scrollback.prevMatch(this.width, this.currentLayout().viewport.height);
    this.scheduler.markDirty();
  }

  /**
   * Re-arm tail-following and jump to the live tail — `Scrollback.end()`,
   * exposed because one caller genuinely needs to yank the view back:
   * an approval prompt that has just opened (2026-09-02 round six, item 1).
   * A user who had scrolled up to read is otherwise shown nothing at all
   * when a request arrives, while the gate takes stdin away from them —
   * which is the "i cannot scroll or type and i have to Ctrl C to get out"
   * report exactly. Everywhere else T43.2's rule stands unchanged: new
   * output never moves a scrolled-back reader.
   */
  scrollToEnd(): void {
    this.scrollback.end();
    this.scheduler.markDirty();
  }

  stop(): void {
    this.scheduler.stop();
  }

  private currentLayout() {
    return computeLayout({
      width: this.width,
      height: this.height,
      headerHeight: 1,
      footerVisible: this.footerVisible,
      footerHeight: 1,
      composerHeight: Math.max(1, this.composerLines.length),
      statusHeight: this.statusLine ? 1 : 0,
      completionHeight: this.completionPopup?.length ?? 0,
      completionAbove: this.completionAbove,
    });
  }

  /** The composer region's current top row — for placing the real cursor (`composer.ts`'s job) at the right frame row from outside this class. */
  /** T114: how many rows the transcript region currently has — what the browser pages by. */
  /**
   * Paint `lines` instead of the session, or `null` to give the session its
   * screen back. The caller owns every row: no header, no composer and no
   * footer are drawn under a full view, because a view that replaces the
   * screen and then leaves a prompt visible invites typing into a composer
   * that is not receiving keys.
   */
  setFullView(lines: readonly string[] | null): void {
    this.fullView = lines === null ? null : [...lines];
    this.scheduler.markDirty();
  }

  get hasFullView(): boolean {
    return this.fullView !== null;
  }

  /**
   * The number of rows a full view has to fill.
   *
   * 2026-09-07 (UI feedback item 8): the browser was rendered against a
   * height the caller tracked separately from this one, and the two could
   * disagree — a full view laid out for fewer rows than the frame has
   * leaves the bottom of the screen showing whatever was under it, which is
   * what "there is just an empty blank below the hint" was. Callers now ask
   * the pipeline how tall the frame is instead of remembering.
   */
  get frameHeight(): number {
    return this.height;
  }

  viewportHeight(): number {
    return this.currentLayout().viewport.height;
  }

  composerTopRow(): number {
    return this.currentLayout().composer.top;
  }

  /** The completion popup's current top row — 2026-09-02 round nine, item 3's tab-completer clicking, which needs the popup's OWN fixed frame position the same way the composer's cursor placement already does. Meaningless while no popup is showing, but cheap to compute regardless — the caller only consults it while `completionActive` is true. */
  completionTopRow(): number {
    return this.currentLayout().completion.top;
  }

  /**
   * What clicking `(frameRow, frameCol)` does, or `null` for nowhere
   * clickable — 2026-09-02 round nine, items 3 and 4. Two regions: the
   * footer's own row (any click on it shows the glossary, item 4 — "not
   * all people may understand each of them"), and the scrollback viewport
   * (`Scrollback.viewport()`'s own `regions`, resolved from a frame row
   * back to a viewport-relative one the same way `paintCursor()` already
   * offsets by `layout.composer.top` for the composer).
   *
   * Deliberately NOT true mouse hover: that would mean enabling `?1003h`
   * any-motion tracking, which reports the pointer's position continuously
   * for every movement across the WHOLE terminal, not just the footer —
   * a real, unverified-live change to how much stdin traffic every
   * keystroke's neighbourhood now carries, for a feature the maintainer's
   * own request already hedged ("if TUI even allows it"). A click is the
   * same discrete, already-proven event every other affordance in this
   * round uses.
   */
  actionAt(frameRow: number, frameCol: number): ClickAction | null {
    const layout = this.currentLayout();
    if (this.footerVisible && layout.footer.height > 0 && frameRow === layout.footer.top) {
      return { kind: "showLegend" };
    }
    // T114: the header's back affordance. Synthesised here rather than
    // declared by a block, because the header is not scrollback — the same
    // shape the footer legend above already takes.
    if (layout.header.height > 0 && frameRow === layout.header.top) {
      const span = headerBackSpan(this.header, this.theme);
      if (span && frameCol >= span.colStart && frameCol < span.colEnd) return { kind: "openBrowser" };
      return null;
    }
    if (frameRow < layout.viewport.top || frameRow >= layout.viewport.top + layout.viewport.height) return null;
    const viewportRow = frameRow - layout.viewport.top;
    const vp = this.scrollback.viewport(this.width, layout.viewport.height);
    const regions = vp.regions[viewportRow];
    if (!regions) return null;
    for (const r of regions) if (frameCol >= r.colStart && frameCol < r.colEnd) return r.action;
    return null;
  }

  private paint(): void {
    const frame = this.buildAppFrame();
    this.writer.write(frame);
    this.paintCursor();
  }

  private buildAppFrame(): Frame {
    if (this.fullView !== null) {
      const lines = new Array(this.height).fill("");
      for (let i = 0; i < Math.min(this.height, this.fullView.length); i++) lines[i] = this.fullView[i]!;
      return makeFrame(this.width, this.height, lines);
    }
    const layout = this.currentLayout();
    const viewport = this.scrollback.viewport(this.width, layout.viewport.height);
    const matched = new Set(viewport.matches);
    const searched = viewport.lines.map((line, index) =>
      matched.has(index) ? withBackground(line, "completionBg", this.theme, visibleWidth(line), this.width) : line,
    );
    const viewportLines = this.withHoverHighlight(searched);
    const state: AppState = {
      header: this.header,
      vm: this.vm,
      footerVisible: this.footerVisible,
      viewportLines,
      composerLines: this.composerLines,
      statusLine: this.statusLine,
      completionAbove: this.completionAbove,
      ...(this.completionPopup ? { completionLines: this.completionPopup } : {}),
    };
    return renderApp(state, { width: this.width, height: this.height, theme: this.theme });
  }

  /**
   * One row of the viewport re-emitted with the hovered region tinted —
   * round eleven, item 1. Applied at paint time rather than baked into the
   * scrollback, because hover is a property of the pointer, not of the
   * transcript: nothing about the stored block changes, and the highlight
   * disappears the moment the pointer moves without any block being
   * re-rendered.
   */
  private withHoverHighlight(lines: string[]): string[] {
    const hover = this.hover;
    if (!hover) return lines;
    const line = lines[hover.row];
    if (line === undefined) return lines;
    const out = [...lines];
    out[hover.row] = highlightSpan(line, hover.colStart, hover.colEnd, this.theme.bgPrefixFor("hoverBg"));
    return out;
  }

  /**
   * Escape sequences here are cursor positioning, not frame content — they
   * go straight to the sink, outside FrameWriter's line-diff bookkeeping,
   * which is why this is a separate step after write().
   *
   * The cursor is hidden outright while the status line is up (2026-09-02
   * UI feedback, item 4: "when loading text is loading, the caret blinking
   * continuously, i dont want it to even appear when loading text is on").
   * A blinking caret in the composer while the model is working reads as
   * "type here" at the exact moment typing is not what the user is doing,
   * and it competes with the spinner for the eye. The composer's cursor
   * POSITION is untouched — `setCursor()` keeps being called, and the caret
   * comes back exactly where it was the moment the status line clears.
   */
  private paintCursor(): void {
    if (this.cursor && !this.statusLine) {
      this.sink.write(`\x1b[${this.cursor.row + 1};${this.cursor.col + 1}H\x1b[?25h`);
    } else {
      this.sink.write("\x1b[?25l");
    }
  }
}
