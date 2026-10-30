// Assembles the frame: `renderApp(AppState) -> Frame`, the pull side of §1's
// architecture diagram. Pure and computes nothing: the header, the footer's
// ViewModel, and the viewport's lines are all handed in already decided. A
// resize is just calling this again with a new width/height (§1's claim);
// scrollback is just `viewportLines` being a different slice (T43 owns choosing
// the slice — this file only tiles it into the frame).

import { renderActivityLines, type ActivityState } from "./activity.js";
import { makeFrame, type Frame } from "./frame.js";
import { renderFooterLines } from "./footer.js";
import { renderHeaderLine } from "./header.js";
import { computeLayout } from "./layout.js";
import type { ResolvedTheme } from "../theme/resolve.js";
import type { ViewModel } from "../types.js";
import type { ScreenHeaderInfo } from "./header.js";

export interface AppState {
  header: ScreenHeaderInfo;
  vm: ViewModel | null;
  footerVisible: boolean;
  /** T48: mid-turn activity (spinner/elapsed/running tool), stacked above the ledger triad — "the footer moves." Absent or `running: false` between turns. */
  activity?: ActivityState;
  /**
   * Exactly the lines to show in the viewport, already chosen by the
   * caller (T43's scrollback engine picks these; T42 alone may just pass
   * the tail of a flat transcript). Shorter than the viewport height is
   * padded; longer is an caller bug `makeFrame()` will silently clip
   * rather than crash on, matching T41.3's own contract.
   */
  viewportLines: string[];
  /** Rendered composer rows — one for a single-line prompt, more while multi-line input grows (T46). */
  composerLines: string[];
  /** The mid-turn "Working…" line, already styled by its owner. Null between turns — the region is then 0 rows, not a blank reserved one. */
  statusLine?: string | null;
  /** The tab-completion popup's already-rendered rows. Empty when hidden. */
  completionLines?: string[];
  /** Which side of the composer the popup's region sits on — `ui.completion_position`, default above. */
  completionAbove?: boolean;
}

export interface RenderAppOptions {
  width: number;
  height: number;
  theme: ResolvedTheme;
  /** Header is 1 row by default (T42.2); 2 when a caller wants the wrapped form. */
  headerHeight?: number;
  footerHeight?: number;
}

/**
 * `AppState -> Frame`. Never writes a byte — the frame scheduler and
 * `FrameWriter` (T41) are what turn this into terminal output.
 */
export function renderApp(state: AppState, opts: RenderAppOptions): Frame {
  const { width, height, theme } = opts;
  const headerHeight = opts.headerHeight ?? 1;
  const activityLines = state.activity && state.footerVisible ? renderActivityLines(state.activity, theme) : [];
  const triadLines = renderFooterLines(state.vm, theme, width, state.footerVisible);
  // T48: activity stacks above the triad — both live in the same "footer"
  // region T42 already reserves, so a turn running is the footer growing
  // by one row rather than a second region to lay out.
  const footerLines = [...activityLines, ...triadLines];
  const footerHeight = opts.footerHeight ?? (footerLines.length > 0 ? footerLines.length : 1);
  const composerHeight = Math.max(1, state.composerLines.length);

  const statusHeight = state.statusLine ? 1 : 0;
  const completionLines = state.completionLines ?? [];

  const layout = computeLayout({
    width,
    height,
    headerHeight,
    footerVisible: state.footerVisible,
    footerHeight,
    composerHeight,
    statusHeight,
    completionHeight: completionLines.length,
    completionAbove: state.completionAbove ?? true,
  });

  const lines: string[] = new Array(height).fill("");

  const headerLine = renderHeaderLine(state.header, theme, width);
  for (let i = 0; i < layout.header.height; i++) lines[layout.header.top + i] = i === 0 ? headerLine : "";

  for (let i = 0; i < layout.viewport.height; i++) lines[layout.viewport.top + i] = state.viewportLines[i] ?? "";

  for (let i = 0; i < layout.status.height; i++) lines[layout.status.top + i] = state.statusLine ?? "";

  for (let i = 0; i < layout.composer.height; i++) lines[layout.composer.top + i] = state.composerLines[i] ?? "";

  for (let i = 0; i < layout.completion.height; i++) lines[layout.completion.top + i] = completionLines[i] ?? "";

  for (let i = 0; i < layout.footer.height; i++) lines[layout.footer.top + i] = footerLines[i] ?? "";

  return makeFrame(width, height, lines);
}

export { computeLayout } from "./layout.js";
export type { Layout, Region } from "./layout.js";
export type { ScreenHeaderInfo } from "./header.js";
