// The frame's layout: five regions, top to bottom, computed rather than
// hardcoded.
//
// header (pinned, fixed height) / viewport (flexible, whatever is left) /
// status (0 or 1 rows: the mid-turn "Working…" line) / completion (0+
// rows: the tab-completion popup) / composer (grows with multi-line input)
// / footer (the always-on ledger, 0 or 1 rows). `completionAbove: false`
// swaps the middle two.
// This module owns arithmetic only — it has no idea what a header says or
// what the ledger's numbers are, matching frame.ts's own "no colour, no
// theme, no layout [content]" boundary one level up.
//
// The composer/footer order was inverted on 2026-09-02 (UI feedback, item
// 2: "bring 6.2k, 9%, ↓122 … beneath the 2 bar around the chat"). The
// ledger triad used to sit between the viewport and the composer, which
// put it INSIDE the composer's two border rules from the reader's point of
// view; it now sits under the composer's bottom rule, on the last row of
// the screen. Nothing about what the footer contains changed — this is a
// row-ordering change only, and `renderFooterLines` still draws the same
// `renderTriadLine()` over the same ViewModel.
//
// The `status` region is new in the same pass (item 1: spacing "with
// loading text"). It used to be composited over whatever viewport row
// happened to sit above the composer, which both destroyed a line of
// transcript and left the spinner touching the last line of output. As
// its own region it displaces nothing and the blank row every block now
// ends with (blocks.ts's `toScrollbackBlock`) sits above it.

export interface Region {
  /** 0-indexed row this region's first line occupies in the frame. */
  top: number;
  /** Number of rows, always >= 0. */
  height: number;
}

export interface Layout {
  header: Region;
  viewport: Region;
  status: Region;
  composer: Region;
  completion: Region;
  footer: Region;
}

export interface LayoutInput {
  width: number;
  height: number;
  /** Rows the header occupies — T42.2's header is 1-2 rows. */
  headerHeight: number;
  /** T42.4: off means the row is gone and the viewport grows — never a blank reserved row. */
  footerVisible: boolean;
  /** Rows the footer occupies when visible (07-ui-and-hud.md §2's triad is 1 row; a second alert row is 2). */
  footerHeight: number;
  /** Rows the composer occupies — grows with multi-line input (T46). */
  composerHeight: number;
  /** 1 while a turn is running and the animated status line is showing, 0 otherwise. Defaults to 0. */
  statusHeight?: number;
  /**
   * Rows the tab-completion popup occupies, 0 when it is hidden.
   *
   * A layout REGION since 2026-09-02 (UI feedback round two, item 4). It
   * used to be composited over the bottom of the viewport, which put a
   * seven-row popup on top of the last seven lines of the answer the user
   * was reading — and it was drawn over the frame rather than laid out in
   * it, so those lines were genuinely gone until it closed. As a region it
   * takes its rows from the viewport instead, which scrolls rather than
   * hides.
   */
  completionHeight?: number;
  /**
   * Which side of the composer the popup sits on (`ui.completion_position`).
   * True — the default — puts it directly above the input box, where a
   * shell and an editor both put it and where the eye already is; false
   * puts it below, between the composer and the ledger footer.
   *
   * Round two moved it below on the strength of "bring tab completer
   * underneath the chat bar so it wont block content"; round three asked
   * for it back above ("bring it back to above chat box"), which is why
   * this is a setting rather than a second unilateral move. Both positions
   * are regions, so neither hides anything either way — the thing that was
   * actually wrong in round two was the compositing, not the side.
   */
  completionAbove?: boolean;
}

/**
 * Tiles the six regions over exactly `height` rows with no gap and no
 * overlap (T42's acceptance). Every region but the viewport has a fixed or
 * content-derived height; the viewport takes whatever is left, floored at 0
 * rather than going negative when the fixed regions alone exceed the frame.
 */
export function computeLayout(input: LayoutInput): Layout {
  const height = Math.max(0, Math.floor(input.height));
  const header: Region = { top: 0, height: clampHeight(input.headerHeight, height) };
  const footerHeight = input.footerVisible ? clampHeight(input.footerHeight, height) : 0;
  const composerHeight = clampHeight(input.composerHeight, height);
  const statusHeight = clampHeight(input.statusHeight ?? 0, height);
  const completionHeight = clampHeight(input.completionHeight ?? 0, height);
  const fixed = header.height + footerHeight + composerHeight + statusHeight + completionHeight;
  const viewportHeight = Math.max(0, height - fixed);
  const viewport: Region = { top: header.height, height: viewportHeight };
  const status: Region = { top: viewport.top + viewport.height, height: statusHeight };
  const afterStatus = status.top + status.height;
  if (input.completionAbove ?? true) {
    const completion: Region = { top: afterStatus, height: completionHeight };
    const composer: Region = { top: completion.top + completion.height, height: composerHeight };
    const footer: Region = { top: composer.top + composer.height, height: footerHeight };
    return { header, viewport, status, composer, completion, footer };
  }
  const composer: Region = { top: afterStatus, height: composerHeight };
  const completion: Region = { top: composer.top + composer.height, height: completionHeight };
  const footer: Region = { top: completion.top + completion.height, height: footerHeight };
  return { header, viewport, status, composer, completion, footer };
}

function clampHeight(n: number, max: number): number {
  return Math.max(0, Math.min(max, Math.floor(n)));
}
