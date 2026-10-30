// Turns T46.2's `LineEditor` state into composer display lines plus the
// real cursor's frame-relative position — the piece that makes the
// composer feel like a normal text input rather than a static row of text.
// T41's `terminal.ts` hides the cursor on entry (`ENTER_SEQUENCES.
// hideCursor`); `ScreenPipeline.setCursor()` is the only place it comes
// back, and this file computes where.

import type { EditorState } from "../editor.js";
import { style, withInlineBackground, type ResolvedTheme } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import { findCommand, resolveSkillName } from "../commands.js";
import { charWidth, stringWidth } from "../width.js";
import { effortToken } from "../effort.js";

const PROMPT = "> ";
const CONTINUATION = "  ";

/**
 * Visible columns every composer row is inset by. Exported because the
 * mouse handler needs the inverse of this function — a frame column minus
 * this is a buffer column — and two independent copies of the number is
 * exactly how click-to-position ends up one character off. `PROMPT` and
 * `CONTINUATION` are the same width, which is what lets a single constant
 * cover every visual row regardless of whether it opens a logical line
 * (Shift+Enter) or is a soft-wrapped continuation of one.
 */
export const COMPOSER_PREFIX_WIDTH = PROMPT.length;

/**
 * The fraction of the terminal the composer may occupy before it starts
 * scrolling instead of growing — 2026-09-02 round six, item 5: "Make the
 * prompt box have a limit on how many lines it can show... Cap it of 40%
 * of the screen."
 */
export const COMPOSER_MAX_HEIGHT_FRACTION = 0.4;

/** Body rows the composer may show on a terminal `rows` tall — the cap itself, minus the two border rules, never below one row. */
export function composerMaxRows(rows: number): number {
  return Math.max(1, Math.floor(rows * COMPOSER_MAX_HEIGHT_FRACTION) - 2);
}

export interface ComposerRender {
  /** One rendered line per row of the editor buffer, framed by a top and bottom border rule — the composer region grows to fit (2 rows of chrome plus one per buffer row). */
  lines: string[];
  /** Cursor position relative to THIS block's own lines (row 0 is the top border) — the caller adds the composer region's absolute top offset from the layout. */
  cursorRow: number;
  cursorCol: number;
  /**
   * One entry per visual row of the WHOLE buffer — not just the rendered
   * window — naming which logical `EditorState.lines[]` row it came from
   * and the half-open column range `[startCol, endCol)` it covers within
   * that logical row. A logical row that fits on one visual row still gets
   * an entry, so a caller always indexes this array by visual row rather
   * than special-casing the unwrapped case.
   *
   * It stayed UNWINDOWED when the height cap landed (2026-09-02 round
   * seven) because visual Up/Down navigates it: an arrow pressed on the
   * top visible row has to reach the row above, which by definition is
   * outside the window. `windowStart` is what a caller adds to convert a
   * rendered row index into an index here.
   */
  rowMap: Array<{ logicalRow: number; startCol: number; endCol: number }>;
  /** Index into `rowMap` of the first RENDERED buffer row — 0 unless the height cap is scrolling the composer. */
  windowStart: number;
  /** Visual rows scrolled off the top / bottom of the capped window (item 5). Both 0 when the whole buffer fits. */
  hiddenAbove: number;
  hiddenBelow: number;
}

/**
 * Word-wraps one logical line to `width` columns, returning each visual
 * segment's TEXT alongside the character OFFSET into the logical line it
 * starts at — the offset is what makes cursor placement and selection
 * math possible after wrapping splits one buffer row into several.
 *
 * A break prefers the last space before the width limit, the same greedy
 * policy `scrollback.ts`'s `wrapPlain` uses for read-only text; the
 * difference here is that this function has to answer "where did segment N
 * start in the ORIGINAL string," which a caller doing cursor math cannot
 * reconstruct from wrapped text alone. The space at a word-boundary break
 * is consumed (not shown at the end of a visual row, matching every other
 * word-wrapping editor) but still counted in column offsets, so a cursor
 * sitting exactly on it resolves to the end of the row before the break.
 */
function wrapLineWithOffsets(text: string, width: number): Array<{ startCol: number; text: string }> {
  const w = Math.max(1, Math.floor(width));
  const chars = [...text];
  if (chars.length === 0) return [{ startCol: 0, text: "" }];
  if (stringWidth(text) <= w) return [{ startCol: 0, text }];

  const segments: Array<{ startCol: number; text: string }> = [];
  let segStart = 0;
  let col = 0;
  let lastSpace = -1;
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i]!;
    const cw = charWidth(ch.codePointAt(0)!);
    if (col + cw > w && i > segStart) {
      if (lastSpace >= segStart) {
        segments.push({ startCol: segStart, text: chars.slice(segStart, lastSpace).join("") });
        segStart = lastSpace + 1;
      } else {
        // No space to break on — a single word wider than the line. Hard
        // break right here rather than overrun the width.
        segments.push({ startCol: segStart, text: chars.slice(segStart, i).join("") });
        segStart = i;
      }
      i = segStart;
      col = 0;
      lastSpace = -1;
      continue;
    }
    if (ch === " ") lastSpace = i;
    col += cw;
    i += 1;
  }
  segments.push({ startCol: segStart, text: chars.slice(segStart).join("") });
  return segments;
}

/**
 * Which visual segment `col` (a column in the LOGICAL line) falls on, and
 * where within that segment — the last segment whose `startCol` does not
 * exceed `col`, since segments are produced in increasing `startCol` order
 * and a column that lands exactly on a consumed word-break space belongs
 * to the row before the break (where the cursor visually sits).
 */
function locateInSegments(segments: readonly { startCol: number; text: string }[], col: number): { index: number; localCol: number } {
  let index = 0;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i]!.startCol <= col) index = i;
    else break;
  }
  const seg = segments[index]!;
  return { index, localCol: Math.min(col - seg.startCol, seg.text.length) };
}

/** The intersection of a logical-row selection span with one visual segment, in the segment's OWN local column space. */
function segmentSelection(seg: { startCol: number; text: string }, span: [number, number] | null): [number, number] | null {
  if (!span) return null;
  const segEnd = seg.startCol + seg.text.length;
  const s = Math.max(span[0], seg.startCol);
  const e = Math.min(span[1], segEnd);
  if (e <= s) return null;
  return [s - seg.startCol, e - seg.startCol];
}

/**
 * The selected span of one LOGICAL buffer row, as `[startCol, endCol)`, or
 * null when the selection does not touch this row. A multi-row selection
 * covers each intermediate row whole.
 */
function selectedSpan(state: EditorState, row: number, lineLength: number): [number, number] | null {
  const sel = state.selection;
  if (!sel) return null;
  if (row < sel.start.row || row > sel.end.row) return null;
  const start = row === sel.start.row ? sel.start.col : 0;
  const end = row === sel.end.row ? sel.end.col : lineLength;
  return end > start ? [start, end] : null;
}

/**
 * Visible-column math only — the prompt/continuation prefix is styled, but
 * cursor positioning uses the PLAIN prefix length (`PROMPT.length`), never
 * the styled string's `.length`, because a CUP escape sequence counts
 * visible columns and an ANSI escape has zero visible width. The top/
 * bottom border rules are the same box-drawing glyphs and `border` token
 * T49's approval modal already uses — a second box style would be a second
 * thing to keep visually consistent for no reason.
 *
 * **Soft word-wrap** (2026-09-02 UI feedback, round five, item 5): a
 * logical line longer than the available width used to run straight into
 * `FrameWriter`'s own clip, which meant a long prompt visibly stopped
 * mid-word at the edge of the terminal with everything past it simply
 * gone from view rather than reachable — "when typing the prompt and
 * reach the end of the line, it just show nothing after it." Each
 * logical `state.lines[]` row is now wrapped into one or more VISUAL rows
 * via `wrapLineWithOffsets()`, and the returned `rowMap` is what lets a
 * caller translate a visual row (what a mouse click or the frame layout
 * actually sees) back to a logical `(row, col)` the editor understands —
 * the wrapping is display-only, so `EditorState.lines` and the submitted
 * text are never touched by it, per the explicit "not like breaking the
 * line for real" request.
 *
 * **Capped height** (2026-09-02 round six, item 5): with `maxBodyRows`
 * set, the composer shows a WINDOW onto its visual rows rather than all of
 * them, and the two border rules carry `▲ N more` / `▼ N more` for what is
 * out of sight. Production passes `composerMaxRows(terminalRows)` — 40% of
 * the screen — because a pasted wall of text otherwise grew the region
 * until the transcript was gone ("right now if you type too much, the box
 * will just cover up the entire screen"). The window is chosen so the
 * cursor is always inside it, `rowMap` is sliced alongside `lines` so a
 * mouse click still maps to the right logical position, and a caller that
 * omits `maxBodyRows` gets exactly the previous unbounded behaviour.
 *
 * **Up/Down move by VISUAL row** since 2026-09-02 round seven, item 1
 * ("Arrow up down is now only used for scrolling up down in the current
 * prompt... just like a normal editor"), closing the limitation round five
 * named when it added wrapping. `LineEditor` still knows nothing about
 * display width — it did not need to. `rowMap` already describes every
 * visual row, so `raw-line-source.ts` navigates THAT and converts back to
 * the logical `(row, col)` the editor understands, which is the same
 * translation mouse clicks were already doing. That is also why `rowMap`
 * covers the whole buffer rather than just the rendered window: an arrow
 * pressed on the top visible row has to reach the row above it.
 *
 * The selection highlight (2026-09-02 UI feedback, item 8) is a background
 * tint over a span, which adds only zero-width escapes and therefore does
 * not disturb any of that column math. Under the mono theme
 * `withInlineBackground` returns its input untouched, so a NO_COLOR
 * session emits no escapes here and simply does not show the selection —
 * named rather than papered over: the alternatives (bracketing the span
 * with literal characters, say) would shift every column after it and put
 * the real cursor in the wrong place, which is a worse failure than an
 * invisible selection on a terminal that has no colour to show it with.
 */

/**
 * T131 — the span of the slash command on a composer line, and which theme
 * token should colour it.
 *
 * **Why an unknown command gets its own colour.** Until now the composer
 * rendered typed text with no styling at all, so `/hlep` looked exactly like
 * `/help` right up to the moment Enter turned it into a prompt sent to the
 * model. Colouring only the recognised commands would have left the typo
 * looking like prose — which it technically is, and which is precisely the
 * surprise. So an unrecognised `/word` is marked `warn`: not an error, but
 * visibly not a command.
 *
 * The recognised classes reuse the cost tokens the completion popup already
 * uses, so `/compact` (a model call) reads differently from `/help` (free)
 * in the box as well as in the list. Nothing new was added to the palette.
 *
 * Pure and exported for its own test: the span arithmetic is the part worth
 * asserting directly rather than through rendered escape sequences.
 */
export interface CommandSpanResult {
  start: number;
  end: number;
  token: "local" | "costed" | "danger" | "warn";
}

export function commandSpan(line: string): CommandSpanResult | null {
  if (!line.startsWith("/")) return null;
  const space = line.indexOf(" ");
  const end = space === -1 ? line.length : space;
  // A bare "/" is the completion popup opening, not a command yet.
  if (end <= 1) return null;
  const word = line.slice(1, end);
  const spec = findCommand(`/${word}`);
  if (spec !== undefined) {
    return { start: 0, end, token: spec.costClass === "refused" ? "danger" : spec.costClass };
  }
  // `/skill:handoff` resolves through the same collision rule dispatch uses.
  if (resolveSkillName(word) !== undefined) return { start: 0, end, token: "costed" };
  return { start: 0, end, token: "warn" };
}

export function renderComposer(state: EditorState, theme: ResolvedTheme, width: number, effort: string | null = null, maxBodyRows?: number): ComposerRender {
  const g = GLYPHS[theme.glyphs];
  const hbarRun = g.hbar.repeat(Math.max(0, width));
  // The two rules carry the current reasoning effort as a brightness on the
  // palette's light-blue role — 2026-09-02 round three, item 7: "the two bar
  // wrapping around chat box should change color based on effort too, off
  // low high max is darker to brighter." It is the cheapest possible place
  // to put a setting that changes what every subsequent turn costs: already
  // on screen, already framing the thing being typed, and costing no row.
  // With no live session to read (every ledger-backed surface), the rules
  // stay `border` rather than implying an effort nobody set.
  const ruleToken = effort ? effortToken(effort) : "border";
  const topBorder = style(hbarRun, ruleToken, theme);
  const bottomBorder = style(hbarRun, ruleToken, theme);

  const bodyWidth = Math.max(1, width - COMPOSER_PREFIX_WIDTH);
  const bufferLines: string[] = [];
  const rowMap: Array<{ logicalRow: number; startCol: number; endCol: number }> = [];
  let cursorVisualRow = 0;
  // The cursor's COLUMN, not its index into the segment's string: a CUP
  // escape counts columns, so a segment containing a wide glyph (a pasted
  // CJK path, an emoji) before the cursor would otherwise leave the caret
  // behind by one cell per glyph.
  let cursorVisibleCol = 0;

  state.lines.forEach((line, logicalRow) => {
    const segments = wrapLineWithOffsets(line, bodyWidth);
    const rowSpan = selectedSpan(state, logicalRow, line.length);
    segments.forEach((seg, segIndex) => {
      const visualRow = bufferLines.length;
      rowMap.push({ logicalRow, startCol: seg.startCol, endCol: seg.startCol + seg.text.length });
      // Only the very first visual row of the whole buffer gets the "> "
      // prompt; every soft-wrapped continuation AND every Shift+Enter row
      // gets the same "  " inset — they read as one flowing paragraph.
      const prefix = logicalRow === 0 && segIndex === 0 ? PROMPT : CONTINUATION;
      const span = segmentSelection(seg, rowSpan);
      // T131: colour the command word. Selection wins when the two overlap —
      // a highlighted selection is a direct answer to what the user is doing
      // right now, and stacking two backgrounds on one run reads as neither.
      const cmd = logicalRow === 0 && segIndex === 0 ? commandSpan(seg.text) : null;
      const body = span
        ? `${seg.text.slice(0, span[0])}${withInlineBackground(seg.text.slice(span[0], span[1]), "selectionBg", theme)}${seg.text.slice(span[1])}`
        : cmd
          ? `${style(seg.text.slice(cmd.start, cmd.end), cmd.token, theme)}${seg.text.slice(cmd.end)}`
          : seg.text;
      bufferLines.push(`${style(prefix, "accent", theme)}${body}`);
      if (logicalRow === state.cursorRow) {
        const located = locateInSegments(segments, state.cursorCol);
        if (located.index === segIndex) {
          cursorVisualRow = visualRow;
          cursorVisibleCol = stringWidth(seg.text.slice(0, located.localCol));
        }
      }
    });
  });

  // The cap (2026-09-02 round six, item 5). Without it a pasted or
  // dictated wall of text grows the composer region until it owns the
  // whole terminal and the transcript is gone: "right now if you type too
  // much, the box will just cover up the entire screen." The window is
  // chosen so the CURSOR is always inside it — a capped composer that can
  // hide the caret would be a worse bug than the one it fixes — and the
  // two rules say how much is out of sight in each direction, the way Pi's
  // own input box does.
  const total = bufferLines.length;
  const cap = maxBodyRows !== undefined ? Math.max(1, Math.floor(maxBodyRows)) : total;
  let start = 0;
  if (total > cap) {
    // Centred on the cursor, then clamped — which means typing at the end
    // (the overwhelmingly common case) pins the window to the tail and it
    // stops moving, while an edit in the middle keeps context either side.
    start = Math.max(0, Math.min(cursorVisualRow - Math.floor((cap - 1) / 2), total - cap));
  }
  const end = Math.min(total, start + cap);
  const hiddenAbove = start;
  const hiddenBelow = total - end;

  return {
    lines: [overflowRule(topBorder, hbarRun, hiddenAbove, "up", ruleToken, theme), ...bufferLines.slice(start, end), overflowRule(bottomBorder, hbarRun, hiddenBelow, "down", ruleToken, theme)],
    // +1: row 0 of `lines` is the top border, so every buffer row shifts down one.
    cursorRow: cursorVisualRow - start + 1,
    cursorCol: COMPOSER_PREFIX_WIDTH + cursorVisibleCol,
    rowMap,
    windowStart: start,
    hiddenAbove,
    hiddenBelow,
  };
}

/**
 * A border rule carrying `▲ 24 more` / `▼ 59 more` when the composer is
 * capped — the label is written INTO the rule (two glyphs of lead-in, then
 * the count, then the rule resumes) rather than costing a row of its own,
 * which is both what Pi does and the only option that does not make the
 * cap pay for itself twice. Returns the plain rule unchanged when nothing
 * is hidden.
 */
function overflowRule(plainRule: string, hbarRun: string, hidden: number, dir: "up" | "down", ruleToken: Parameters<typeof style>[1], theme: ResolvedTheme): string {
  if (hidden <= 0) return plainRule;
  const g = GLYPHS[theme.glyphs];
  const label = ` ${dir === "up" ? g.up : g.down} ${hidden} more `;
  const labelWidth = stringWidth(label);
  const runWidth = stringWidth(hbarRun);
  if (labelWidth + 4 > runWidth) return plainRule;
  const lead = 2;
  const tail = runWidth - lead - labelWidth;
  const hbar = g.hbar;
  return `${style(hbar.repeat(lead), ruleToken, theme)}${style(label, "accent", theme)}${style(hbar.repeat(Math.max(0, tail)), ruleToken, theme)}`;
}
