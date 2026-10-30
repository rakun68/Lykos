// The scrollback engine.
//
// The cost of choosing the alternate screen: the terminal's own scrollback
// does not exist there, so Lykos provides it. A `Scrollback` holds an
// ordered list of blocks, each of which knows how to render itself to N
// display lines at a given width (T44 supplies the real block renderers;
// this file has no idea what a block says). Wrapping is the expensive part
// at scale, so it is cached per (block, width) and only invalidated by a
// resize (T43.1) — scrolling one line must never re-wrap the whole
// history, which is asserted directly by counting render() calls rather
// than trusted (T43's acceptance).
//
// The viewport (T43.2) is an offset into wrapped lines plus a `followTail`
// flag: new output while following scrolls, new output while the user has
// scrolled back does not move anything and instead grows a "N new lines
// below" counter — "being yanked to the bottom mid-read is the most
// irritating bug this surface can have."
//
// Bounded memory (T43.4) caps retained *wrapped* lines, oldest blocks
// dropped with a marker naming `lykos show <session>` as the way to read
// the rest. The transcript on disk is never touched here — this is a
// display decision, not a data one.

import { sliceToWidth, stringWidth } from "../width.js";
import { stripAnsi } from "./frame.js";

/**
 * What clicking a specific span of a specific transcript row does —
 * 2026-09-02 round nine, item 3 ("make clicking hovering buttons with
 * mouse possible"). Two rounds earlier flagged this as blocked on exactly
 * this: "a scrollback block's on-screen row depends on scroll position...
 * mapping a click back to 'was this inside the still-open approval's key
 * row' needs `Scrollback` to expose a block-id-to-frame-row lookup that
 * does not exist yet" (round five, item 11's own note). `ScrollbackBlock.
 * regionsFor` below is that lookup — `pipeline.actionAt()` is what turns a
 * raw frame click into one of these.
 */
export type ClickAction =
  | { kind: "approvalKey"; key: string; decision: "allow" | "deny" | "allow-always" | "allow-folder" }
  | { kind: "toggleVerbose" }
  | { kind: "openLink"; url: string }
  | { kind: "showLegend" }
  /**
   * T114: the header's back affordance — open the session browser. Unlike
   * every other action here it is not produced by a block's `regionsFor()`,
   * because the header is not scrollback; `ScreenPipeline.actionAt()`
   * synthesises it from the header row the same way it synthesises
   * `showLegend` from the footer row.
   */
  | { kind: "openBrowser" }
  /**
   * Put a block's own SOURCE text on the system clipboard — 2026-09-02
   * round thirteen, item 3: "user cannot copy texts from the answer of the
   * agent... copying from agent answer is a really important feature."
   *
   * The text travels IN the action rather than as a block id the handler
   * would have to look up, for the same reason `openLink` carries its url:
   * `computeClickRegions()` already has the block in hand when it builds
   * the region, and nothing downstream should need a second way to resolve
   * a block back to its content.
   */
  | { kind: "copyText"; text: string; label: string };

export interface ClickRegion {
  /** Visible column the region starts at, inclusive. */
  colStart: number;
  /** Visible column the region ends at, exclusive. */
  colEnd: number;
  action: ClickAction;
}

export interface ScrollbackBlock {
  id: string;
  /** Pure: same (id, width) always renders the same lines. */
  render(width: number): string[];
  /**
   * Optional: given the exact lines `render(width)` just produced (same
   * length, same order), return the clickable regions on each one — `undefined`
   * for a line with none, and the WHOLE return value omitted or undefined
   * for a block that is never clickable at all (the common case, and
   * cheap: `Scrollback` never calls this unless a block provides it). Kept
   * as a POST-HOC scan over the finished lines rather than emitted
   * alongside them during rendering, so no renderer's own return type had
   * to change to make this possible — see `blocks.ts`'s
   * `computeClickRegions()` for why that trade was made.
   */
  regionsFor?(lines: readonly string[]): Array<ClickRegion[] | undefined> | undefined;
}

export interface ScrollbackOptions {
  /** Cap on retained wrapped lines. Default ~5000 per T43.4. */
  maxLines?: number;
}

export interface ViewportResult {
  /** Exactly `height` lines (padded with "" at the bottom when the document is shorter than the viewport). */
  lines: string[];
  /** One entry per `lines[]` row — the same array `regionsFor()` produced for whichever block that row belongs to, or `undefined` for a row with nothing clickable (including every padded blank row). */
  regions: Array<ClickRegion[] | undefined>;
  /** True when the viewport is pinned to the tail. */
  following: boolean;
  /** Lines that arrived after the user scrolled back and have not been seen. */
  newLinesBelow: number;
  /** Set once content has been dropped for T43.4's cap; null otherwise. */
  droppedMarker: string | null;
  /** Viewport-relative search matches, for the renderer to tint. */
  matches: number[];
}

interface SearchMatch {
  /** Index into the flattened wrapped-line list. */
  lineIndex: number;
}

/**
 * Greedy word wrap over plain text — for simple blocks that have no
 * styling of their own. Not ANSI-aware; a styled block owns its own
 * wrapping.
 *
 * Measured in terminal COLUMNS (`tui/width.ts`) since 2026-09-02, not
 * UTF-16 code units. Wrapping a `⚡`-prefixed system line by code units
 * produced rows one column wider than the frame believed, which the
 * terminal then wrapped itself — the display bug behind item 2 of that
 * day's feedback. A word longer than the whole line is hard-broken on a
 * column boundary, never mid-glyph.
 */
export function wrapPlain(text: string, width: number): string[] {
  const w = Math.max(1, Math.floor(width));
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      const candidate = line.length === 0 ? word : `${line} ${word}`;
      if (stringWidth(candidate) <= w) {
        line = candidate;
        continue;
      }
      if (line.length > 0) out.push(line);
      let rest = word;
      while (stringWidth(rest) > w) {
        const head = sliceToWidth(rest, w);
        if (head.text.length === 0) break; // a single glyph wider than the line — emit it whole below rather than loop forever
        out.push(head.text);
        rest = rest.slice(head.text.length);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

/** One block's cached render, at one width: the lines AND (if the block declares `regionsFor`) the parallel click-region array. */
interface WrappedEntry {
  lines: string[];
  regions: Array<ClickRegion[] | undefined> | undefined;
}

export class Scrollback {
  private blocks: ScrollbackBlock[] = [];
  private wrapCache = new Map<string, WrappedEntry>();
  private lastWidth: number | undefined;
  private readonly maxLines: number;
  private droppedBlocks = 0;
  private droppedLines = 0;
  private offset = 0;
  private newLinesBelowCount = 0;
  private followTailFlag = true;
  /** Tracked incrementally so pushing block N does not re-walk blocks 0..N-1 — that is the O(n²) trap a naive "sum every block's wrapped length" would fall into at 10k+ streamed lines. */
  private totalWrapped = 0;

  /** Instrumentation for T43's acceptance: proves the wrap cache is used. */
  renderCalls = 0;

  private searchQuery: string | null = null;
  private searchMatches: SearchMatch[] = [];
  private searchIndex = -1;

  constructor(opts: ScrollbackOptions = {}) {
    this.maxLines = Math.max(1, opts.maxLines ?? 5000);
  }

  get followTail(): boolean {
    return this.followTailFlag;
  }

  get length(): number {
    return this.blocks.length;
  }

  private cacheKey(id: string, width: number): string {
    return `${width}:${id}`;
  }

  private wrapped(block: ScrollbackBlock, width: number): WrappedEntry {
    const key = this.cacheKey(block.id, width);
    const cached = this.wrapCache.get(key);
    if (cached) return cached;
    this.renderCalls += 1;
    const lines = block.render(width);
    // A post-hoc scan over the FINISHED lines (blocks.ts's
    // `computeClickRegions()`), never a second render — see
    // `ScrollbackBlock.regionsFor`'s own doc for why.
    const regions = block.regionsFor?.(lines);
    const entry: WrappedEntry = { lines, regions };
    this.wrapCache.set(key, entry);
    return entry;
  }

  /** All wrapped lines, in order, at `width`, alongside the parallel region array. Cheap when nothing changed — every block's render is cache-hit. */
  private allLinesWithRegions(width: number): { lines: string[]; regions: Array<ClickRegion[] | undefined> } {
    const lines: string[] = [];
    const regions: Array<ClickRegion[] | undefined> = [];
    for (const b of this.blocks) {
      const entry = this.wrapped(b, width);
      lines.push(...entry.lines);
      if (entry.regions) regions.push(...entry.regions);
      else for (let i = 0; i < entry.lines.length; i++) regions.push(undefined);
    }
    return { lines, regions };
  }

  private allLines(width: number): string[] {
    return this.allLinesWithRegions(width).lines;
  }

  /** Append one block. If following the tail, the viewport stays pinned; otherwise both the offset and the "new lines below" counter grow by exactly what was added, so a scrolled-back read position stays on the same lines. */
  push(block: ScrollbackBlock, width: number): void {
    this.resize(width);
    this.blocks.push(block);
    const added = this.wrapped(block, width).lines.length;
    this.totalWrapped += added;
    if (!this.followTailFlag) {
      this.offset += added;
      this.newLinesBelowCount += added;
    }
    this.enforceCap(width);
  }

  /**
   * Replace an existing block in place, by id, wherever it is in the
   * document — not just the most recent one. Built for the production
   * wiring's two mutate-in-place cases: streaming assistant text (the
   * same block id grows with every delta, which is what keeps a streamed
   * reply one flowing paragraph instead of one line per token) and a
   * tool call's status (the same `toolCallId` moves from `running` to
   * `ok`/`error` without leaving a stale duplicate line behind). Returns
   * false, doing nothing, when the id is not found — a caller mistake to
   * surface, not to paper over with a silent `push()`.
   */
  updateBlock(id: string, block: ScrollbackBlock, width: number): boolean {
    this.resize(width);
    const idx = this.blocks.findIndex((b) => b.id === id);
    if (idx === -1) return false;
    const oldLen = this.wrapped(this.blocks[idx]!, width).lines.length;
    this.wrapCache.delete(this.cacheKey(id, width));
    this.blocks[idx] = block;
    const newLen = this.wrapped(block, width).lines.length;
    const delta = newLen - oldLen;
    this.totalWrapped += delta;
    if (!this.followTailFlag) {
      this.offset = Math.max(0, this.offset + delta);
      this.newLinesBelowCount = Math.max(0, this.newLinesBelowCount + delta);
    }
    this.enforceCap(width);
    return true;
  }

  private enforceCap(width: number): void {
    while (this.totalWrapped > this.maxLines && this.blocks.length > 1) {
      const dropped = this.blocks.shift()!;
      const droppedLen = this.wrapped(dropped, width).lines.length;
      this.wrapCache.delete(this.cacheKey(dropped.id, width));
      this.droppedBlocks += 1;
      this.droppedLines += droppedLen;
      this.totalWrapped -= droppedLen;
      this.offset = Math.max(0, this.offset - droppedLen);
    }
  }

  /** T43.1: a resize invalidates the wrap cache — old-width entries are unreachable and simply discarded — and forces the total to be recomputed at the new width. */
  resize(width: number): void {
    if (this.lastWidth === width) return;
    this.lastWidth = width;
    this.wrapCache.clear();
    this.totalWrapped = this.allLinesUncached(width).length;
    this.searchMatches = [];
    this.searchIndex = -1;
  }

  /** Only used right after a resize, when the cache was just cleared — every call here is a genuine miss, not a hidden re-render of already-wrapped content. */
  private allLinesUncached(width: number): string[] {
    return this.allLines(width);
  }

  private totalLines(_width: number): number {
    return this.totalWrapped;
  }

  private clampOffset(width: number, height: number): void {
    const total = this.totalLines(width);
    const maxOffset = Math.max(0, total - height);
    this.offset = Math.max(0, Math.min(this.offset, maxOffset));
  }

  scrollUp(n: number, width: number, height: number): void {
    this.resize(width);
    this.followTailFlag = false;
    this.offset += n;
    this.clampOffset(width, height);
  }

  scrollDown(n: number, width: number, height: number): void {
    this.resize(width);
    this.offset = Math.max(0, this.offset - n);
    this.clampOffset(width, height);
    if (this.offset === 0) this.reArmFollowTail();
  }

  pageUp(width: number, height: number): void {
    this.scrollUp(Math.max(1, height - 1), width, height);
  }

  pageDown(width: number, height: number): void {
    this.scrollDown(Math.max(1, height - 1), width, height);
  }

  home(width: number, height: number): void {
    this.resize(width);
    this.followTailFlag = false;
    const total = this.totalLines(width);
    this.offset = Math.max(0, total - height);
  }

  /** T43.3: End re-arms followTail. */
  end(): void {
    this.reArmFollowTail();
  }

  private reArmFollowTail(): void {
    this.followTailFlag = true;
    this.offset = 0;
    this.newLinesBelowCount = 0;
  }

  droppedMarker(): string | null {
    if (this.droppedBlocks === 0) return null;
    return `— ${this.droppedLines} earlier line${this.droppedLines === 1 ? "" : "s"} hidden (${this.droppedBlocks} block${
      this.droppedBlocks === 1 ? "" : "s"
    }) — the full transcript is on disk, see \`lykos show <session>\` —`;
  }

  /** T43.2: exactly `height` lines, following the tail or honouring the user's scroll position. */
  viewport(width: number, height: number): ViewportResult {
    this.resize(width);
    const all = this.allLinesWithRegions(width);
    const total = all.lines.length;
    let start: number;
    if (this.followTailFlag) {
      start = Math.max(0, total - height);
      this.offset = 0;
    } else {
      this.clampOffset(width, height);
      start = Math.max(0, total - height - this.offset);
    }
    const slice = all.lines.slice(start, start + height);
    const regionSlice = all.regions.slice(start, start + height);
    // A document shorter than the viewport pads at the BOTTOM, so content
    // starts at the TOP of the screen (2026-09-02 round five, item 2: "I
    // want when start, the first messages start on top of the page instead
    // at the bottom"). This reversed the original T43 choice, which padded
    // above on the theory that content should sit where a real terminal's
    // own scrollback looks before it fills — the boot banner (Context /
    // Skills / Extensions) reading from the very top of an otherwise-empty
    // screen is what was actually wanted instead.
    while (slice.length < height) {
      slice.push("");
      regionSlice.push(undefined);
    }
    return {
      lines: slice,
      regions: regionSlice,
      following: this.followTailFlag,
      newLinesBelow: this.followTailFlag ? 0 : this.newLinesBelowCount,
      droppedMarker: this.droppedMarker(),
      matches: this.searchMatches
        .filter((match) => match.lineIndex >= start && match.lineIndex < start + height)
        .map((match) => match.lineIndex - start),
    };
  }

  // --- T43.5 search (named a cuttable in the task list; implemented minimally) ---

  /** Incremental search over block text at the current width. Case-insensitive substring match. */
  search(query: string, width: number): number {
    this.searchQuery = query.length > 0 ? query : null;
    this.searchMatches = [];
    this.searchIndex = -1;
    if (!this.searchQuery) return 0;
    const needle = this.searchQuery.toLowerCase();
    const all = this.allLines(width);
    all.forEach((line, i) => {
      if (stripAnsi(line).toLowerCase().includes(needle)) this.searchMatches.push({ lineIndex: i });
    });
    if (this.searchMatches.length > 0) this.searchIndex = 0;
    return this.searchMatches.length;
  }

  clearSearch(): void {
    this.searchQuery = null;
    this.searchMatches = [];
    this.searchIndex = -1;
  }

  /** Line indices (into the flattened wrapped list) that currently match — for the viewport to highlight. */
  matchedLineIndices(): number[] {
    return this.searchMatches.map((m) => m.lineIndex);
  }

  nextMatch(width: number, height: number): number | null {
    if (this.searchMatches.length === 0) return null;
    this.searchIndex = (this.searchIndex + 1) % this.searchMatches.length;
    return this.jumpToCurrentMatch(width, height);
  }

  prevMatch(width: number, height: number): number | null {
    if (this.searchMatches.length === 0) return null;
    this.searchIndex = (this.searchIndex - 1 + this.searchMatches.length) % this.searchMatches.length;
    return this.jumpToCurrentMatch(width, height);
  }

  private jumpToCurrentMatch(width: number, height: number): number {
    const match = this.searchMatches[this.searchIndex]!;
    this.followTailFlag = false;
    const total = this.totalLines(width);
    this.offset = Math.max(0, total - height - match.lineIndex);
    this.clampOffset(width, height);
    return match.lineIndex;
  }
}
