// The frame buffer and the diff writer.
//
// A `Frame` is an array of already-styled lines with a known width and
// height: the layout (T42) and the scrollback engine (T43) decide what the
// lines say, and this file decides how few bytes it takes to put them on
// screen. Writing a frame emits only the rows that differ from the previous
// frame, cursor-positioned — never a full redraw for a three-character
// change. That is the whole reason T50.3's `< 8ms p95 at 200x60` budget is
// reachable at all: at 200x60 a full redraw is ~12KB of terminal traffic
// per frame, and at 30Hz that is a third of a megabyte a second for a
// spinner.
//
// Two properties this file is responsible for and nothing else is:
//
//  - **A line never wraps.** A row wider than the frame pushes every row
//    below it down by one and the whole screen is wrong from that point on,
//    which looks like a scrollback bug rather than an off-by-one. Every
//    line is clipped to `width` on the way in, ANSI-aware, so an escape
//    sequence is never cut in half and never counted as a visible column.
//  - **A dimension change is a full redraw.** After a resize (T41.5) the
//    previous frame describes a screen that no longer exists, so diffing
//    against it would leave stale cells wherever the new frame happens to
//    agree with the old one. Detected here rather than trusted to the
//    caller.
//
// No colour, no theme, no layout: this module has no idea what a header is.

import { charWidth, stringWidth } from "../width.js";

/** CSI sequences, named once. `frame.ts` owns cursor and erase; `terminal.ts` owns mode switching. */
const CUP = (row: number) => `\x1b[${row};1H`;
/** Erase from the cursor to the end of the line — clears whatever the previous frame left to the right of a shorter row. */
const EL = "\x1b[K";
/** Home + erase the whole display, the two-sequence preamble of a full redraw. */
const CLEAR = "\x1b[H\x1b[2J";

export interface Frame {
  width: number;
  height: number;
  /** Exactly `height` entries, each already clipped to `width`. Built by `makeFrame()`. */
  lines: string[];
}

export interface FrameWriteResult {
  /** Bytes handed to the sink. The number T41's acceptance asserts a diff beats a full redraw on. */
  bytes: number;
  /** How many rows were repositioned and rewritten. */
  linesDrawn: number;
  /** True when this write cleared the screen and drew every row (first frame, resize, or `reset()`). */
  full: boolean;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Every SGR/CSI escape removed, nothing else touched. Exported for `blocks.ts`'s click-region scan (2026-09-02 round nine, item 3), which needs the same plain text `visibleWidth()` measures from — a raw string index into THIS output is a visible column, which is exactly what a mouse click reports. */
export function stripAnsi(line: string): string {
  return line.replace(ANSI, "");
}

/**
 * Visible columns, ignoring SGR/CSI escapes.
 *
 * Counted with `tui/width.ts`'s `stringWidth` since 2026-09-02, not
 * `String.length`. The two disagree on every East Asian Wide code point —
 * `⚡` among them — and the disagreement was not cosmetic: a line one
 * column longer than this function reported did not get clipped, so the
 * terminal wrapped it onto the row below, and because `FrameWriter` only
 * repaints rows it computes as changed, the wrapped remainder stayed on
 * screen indefinitely. That is the "message is still there" bug in the
 * 2026-09-02 report, and `width.ts`'s own module doc has the long form.
 */
export function visibleWidth(line: string): number {
  return stringWidth(line.replace(ANSI, ""));
}

/**
 * Clip to `max` visible columns without ever cutting an escape sequence in
 * half, and re-emit a reset if any styling was open at the cut so the clip
 * cannot leak colour onto the rest of the screen. A two-column glyph that
 * would straddle the limit is dropped whole — half a wide glyph is not
 * something a terminal can draw.
 */
export function clipToWidth(line: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(line) <= max) return line;
  let out = "";
  let seen = 0;
  let styled = false;
  let i = 0;
  while (i < line.length && seen < max) {
    if (line[i] === "\x1b") {
      ANSI.lastIndex = i;
      const m = ANSI.exec(line);
      if (m && m.index === i) {
        out += m[0];
        if (m[0].endsWith("m") && m[0] !== "\x1b[0m" && m[0] !== "\x1b[m") styled = true;
        i += m[0].length;
        continue;
      }
    }
    // Iterate by code POINT, not code unit: a surrogate pair is one glyph
    // and splitting it produces a lone surrogate the terminal draws as a
    // replacement box.
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const w = charWidth(ch.codePointAt(0)!);
    if (seen + w > max) break;
    out += ch;
    seen += w;
    i += ch.length;
  }
  return styled ? `${out}\x1b[0m` : out;
}

/**
 * Paint a background across one visible COLUMN SPAN of an already-styled
 * line — round eleven, item 1's hover highlight ("make buttons highlight
 * when mouse hover around it, give it background color or something").
 *
 * Unlike `withBackground` (a whole row) and `withInlineBackground` (a
 * plain, unstyled span), the target here is a span inside a line that
 * already carries arbitrary SGR of its own: an approval's pills are
 * coloured, a fold hint is underlined and faint. Two things follow, and
 * both are why this could not just be a `slice`:
 *
 *  - Column positions are VISIBLE columns, which is what a mouse report
 *    gives and what `ClickRegion` records; escape sequences occupy none of
 *    them, so the walk counts glyph widths and copies escapes through
 *    untouched.
 *  - Every `[0m` inside the span would clear the background as well as
 *    the foreground, so each one is re-opened with the background prefix
 *    immediately after — the same patch `withBackground` applies for the
 *    same reason. The span closes with SGR 49 (default background only),
 *    leaving whatever foreground styling was open to carry on.
 *
 * A span that does not intersect the line returns it unchanged, so a
 * caller never has to bounds-check first.
 */
export function highlightSpan(line: string, colStart: number, colEnd: number, bgPrefix: string): string {
  if (bgPrefix === "" || colEnd <= colStart) return line;
  let out = "";
  let col = 0;
  let open = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      ANSI.lastIndex = i;
      const m = ANSI.exec(line);
      if (m && m.index === i) {
        out += m[0];
        // A reset inside the highlighted span drops the background with
        // everything else; re-open it so the tint survives to colEnd.
        if (open && (m[0] === "\x1b[0m" || m[0] === "\x1b[m")) out += bgPrefix;
        i += m[0].length;
        continue;
      }
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    if (!open && col >= colStart && col < colEnd) {
      out += bgPrefix;
      open = true;
    }
    if (open && col >= colEnd) {
      out += "\x1b[49m";
      open = false;
    }
    out += ch;
    col += charWidth(ch.codePointAt(0)!);
    i += ch.length;
  }
  return open ? `${out}\x1b[49m` : out;
}

/**
 * Build a frame of exactly `height` rows, each clipped to `width`. Short
 * input is padded with empty rows rather than left ragged: a frame is the
 * whole screen by definition, and a caller that supplies four regions
 * summing to 59 rows on a 60-row terminal has a layout bug (T42's
 * acceptance) that a silent ragged frame would hide.
 */
export function makeFrame(width: number, height: number, lines: readonly string[]): Frame {
  const w = Math.max(0, Math.floor(width));
  const h = Math.max(0, Math.floor(height));
  const out: string[] = [];
  for (let i = 0; i < h; i++) out.push(clipToWidth(lines[i] ?? "", w));
  return { width: w, height: h, lines: out };
}

export interface FrameSink {
  write(text: string): void;
}

/**
 * Holds the last frame written and emits the difference to the next one.
 * One writer per screen; `reset()` after anything that invalidates the
 * terminal's contents behind our back (leaving and re-entering the
 * alternate buffer, a resize, an approval modal drawn by something else).
 */
export class FrameWriter {
  private previous: Frame | undefined;
  private sink: FrameSink;
  /** Diagnostics for T50.3's bench, and for proving the diff path is the one being taken. */
  fullRedraws = 0;
  diffWrites = 0;

  constructor(sink: FrameSink) {
    this.sink = sink;
  }

  /** Forget the previous frame; the next write is a full redraw. */
  reset(): void {
    this.previous = undefined;
  }

  /** What a full redraw of this frame would cost, so a caller (or a test) can compare. */
  static fullRedrawBytes(frame: Frame): number {
    return Buffer.byteLength(fullRedrawPayload(frame), "utf8");
  }

  write(frame: Frame): FrameWriteResult {
    const prev = this.previous;
    const full = prev === undefined || prev.width !== frame.width || prev.height !== frame.height;
    const payload = full ? fullRedrawPayload(frame) : diffPayload(prev, frame);
    const linesDrawn = full ? frame.height : countChangedRows(prev, frame);
    if (payload.length > 0) this.sink.write(payload);
    if (full) this.fullRedraws += 1;
    else if (linesDrawn > 0) this.diffWrites += 1;
    this.previous = frame;
    return { bytes: Buffer.byteLength(payload, "utf8"), linesDrawn, full };
  }
}

/**
 * `CUP` + the line + `EL`, EXCEPT when the line already fills the row.
 *
 * 2026-09-02 UI feedback item 2 ("high and standalone on top right and
 * bottom right lost a character at the end"): after a character is written
 * into the last column, a terminal leaves the cursor ON that column with a
 * deferred-wrap flag rather than advancing past it. `EL` (erase from the
 * cursor to the end of the line) then erases from that column — which
 * deletes the character just written. Every full-width row lost its last
 * character, which is exactly the two right-aligned segments in the
 * report: the header's `standalone` and the footer's effort badge.
 *
 * Skipping `EL` on a row that fills the width is correct rather than a
 * workaround: there is nothing to the right of a full-width line to erase.
 * Erase-first (`CUP` + `EL` + line) would also fix it, at the cost of
 * blanking every changed row a frame before repainting it.
 */
function paintRow(row: number, line: string, width: number): string {
  return CUP(row) + line + (visibleWidth(line) < width ? EL : "");
}

function fullRedrawPayload(frame: Frame): string {
  let out = CLEAR;
  for (let i = 0; i < frame.lines.length; i++) {
    out += paintRow(i + 1, frame.lines[i] ?? "", frame.width);
  }
  return out;
}

function countChangedRows(prev: Frame | undefined, next: Frame): number {
  if (!prev) return next.height;
  let n = 0;
  for (let i = 0; i < next.height; i++) if (prev.lines[i] !== next.lines[i]) n += 1;
  return n;
}

function diffPayload(prev: Frame, next: Frame): string {
  let out = "";
  for (let i = 0; i < next.height; i++) {
    const line = next.lines[i] ?? "";
    if (prev.lines[i] === line) continue;
    out += paintRow(i + 1, line, next.width);
  }
  return out;
}
