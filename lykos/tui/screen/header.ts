// The pinned header line.
//
// `LYKOS 0.0.1 · deepseek-v4-flash · ~/Workspace/Lykos (master)`, left; the
// short session id and `execution_shape`, right-aligned. Product name is
// `accent`; everything else is `dim`/`faint` (§5's medium-contrast rule) —
// this file decides layout and delegates every colour decision to
// `theme/resolve.ts`'s `style()`, same as every other renderer in the
// package.

import { truncate } from "../format.js";
import { stringWidth } from "../width.js";
import { style, withInlineBackground, type ResolvedTheme } from "../theme/resolve.js";

export interface ScreenHeaderInfo {
  /**
   * T114: draw the back affordance at the very left of the header — the
   * click target that opens the session browser. Off by default, because
   * `lykos show` and every non-interactive renderer share this header and
   * a click target that cannot be clicked is a lie about what the surface
   * does.
   */
  back?: boolean;
  backHovered?: boolean;
  product: string;
  version: string;
  model: string;
  /** Already shortened to a display-friendly form (e.g. `~/Workspace/Lykos`). */
  cwd: string;
  /** Current branch, or null when not in a git repo / detached with no name. */
  branch: string | null;
  sessionId: string;
  executionShape: string;
  /** T123: session-only approval mode, always visible in the header. */
  permissionMode?: string;
  /** Ticket 04: the active specialist, when one is selected — "the active specialist is displayed continuously in the interface." Absent means no specialist, and every existing caller's rendered line is unchanged. */
  specialist?: string;
}

const SEP = " · ";

/**
 * The back affordance's own text, in one place, because two things have to
 * agree about it byte for byte: `renderHeaderLine()` draws it, and
 * `headerBackSpan()` tells `ScreenPipeline.actionAt()` which columns to
 * treat as a click on it. A hit-test computed from a second copy of this
 * string is a hit-test that drifts.
 */
export function backLabel(theme: ResolvedTheme): string {
  return theme.glyphs === "ascii" ? "<<<" : "‹‹‹";
}

/**
 * What the affordance says while the pointer is on it.
 *
 * 2026-09-07 (UI feedback item 6). The hovered state used to be
 * `withBackground(label, "hoverBg", …, width)` — with the whole HEADER's
 * width as the target — so the tint padded out to the end of the row and
 * pushed every other segment off it. The button appeared to turn into a
 * white bar that ate the rest of the header, which is exactly what was
 * reported.
 *
 * The fix keeps the accident's one good property and makes it deliberate:
 * hovering DOES take the row, because the button expands into a sentence
 * that says where it goes. The colour stays the accent it always was, the
 * background is a tint rather than a fill, and the header returns intact
 * the moment the pointer leaves.
 */
export function backHoverLabel(theme: ResolvedTheme): string {
  return theme.glyphs === "ascii" ? "<<< return to sessions" : "‹‹‹ return to sessions";
}

/**
 * The visible columns the back affordance occupies, or null when the header
 * is not drawing one. Always anchored at column 0 — "top left" is the
 * request, and it is also the only position that survives truncation.
 */
export function headerBackSpan(info: ScreenHeaderInfo, theme: ResolvedTheme): { colStart: number; colEnd: number } | null {
  if (!info.back) return null;
  // The HOVERED width, in both states, deliberately. The button grows when
  // the pointer is on it (item 6), and a span sized to the collapsed label
  // would stop containing the pointer as soon as it moved right inside the
  // expanded one — the hover would drop, the button would shrink under the
  // cursor, and it would flicker between the two at 3 columns.
  return { colStart: 0, colEnd: stringWidth(backHoverLabel(theme)) };
}

function shortSessionId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

/**
 * A single header row. When the right-aligned block does not fit next to
 * the left block, it is dropped whole rather than truncated into
 * unreadable fragments — the same whole-segment-drop rule the triad line
 * uses at narrow widths (renderers/line.ts).
 */
export function renderHeaderLine(info: ScreenHeaderInfo, theme: ResolvedTheme, width: number): string {
  const ascii = theme.glyphs === "ascii";
  // Hovered, the button is the whole left side: it expands into its
  // sentence and the segments that would have followed it are simply not
  // drawn (item 6). Unhovered, it is three chevrons and the header reads
  // exactly as it did before.
  if (info.back && info.backHovered) {
    const label = backHoverLabel(theme);
    const tinted = withInlineBackground(style(label, "accent", theme), "hoverBg", theme);
    const rightPlainHover = `${info.specialist ? `specialist:${info.specialist}  ` : ""}${info.permissionMode ? `${info.permissionMode}  ` : ""}${shortSessionId(info.sessionId)}  ${info.executionShape}`;
    const gapHover = width - stringWidth(label) - stringWidth(rightPlainHover);
    return gapHover < 1
      ? tinted
      : `${tinted}${" ".repeat(gapHover)}${style(rightPlainHover, "faint", theme)}`;
  }
  const back = info.back ? style(backLabel(theme), "accent", theme) + SEP : "";
  const left =
    back +
    style(info.product, "accent", theme) +
    SEP +
    style(info.version, "dim", theme) +
    SEP +
    style(info.model, "text", theme) +
    SEP +
    style(info.branch ? `${info.cwd} (${info.branch})` : info.cwd, "faint", theme);
  const rightPlain = `${info.specialist ? `specialist:${info.specialist}  ` : ""}${info.permissionMode ? `${info.permissionMode}  ` : ""}${shortSessionId(info.sessionId)}  ${info.executionShape}`;
  const right = style(rightPlain, "faint", theme);

  const leftPlain = stripAnsi(left);
  const leftTrunc = truncate(leftPlain, Math.max(1, width), ascii);
  if (leftTrunc.length !== leftPlain.length) {
    // Left block alone overruns the width — re-style the truncated plain
    // text rather than trying to cut the styled string in half.
    return style(leftTrunc, "text", theme);
  }
  // Terminal columns, not code units (`tui/width.ts`) — a cwd or model name
  // with a wide glyph in it would otherwise be given one column too few
  // and push the right-aligned block off the end of the row.
  const gap = width - stringWidth(leftPlain) - stringWidth(rightPlain);
  if (gap < 1) return left;
  return `${left}${" ".repeat(gap)}${right}`;
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}
