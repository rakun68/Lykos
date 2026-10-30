// The session browser: a full-screen view you go *to*, not a panel that appears
// under the prompt.
//
// The first cut rendered the T58 picker into a scrollback block. That was
// wrong twice over. It shared an id across opens, so a second open
// re-rendered the browser at its old position far up the transcript while
// still owning the keyboard — the session looked dead, and the only escape
// was a key nobody could see the prompt for. And a list is not a transcript
// entry: it does not belong in the scroll history of the conversation it is
// listing.
//
// So the browser owns the frame while it is open, and the state it owns is
// its own — cursor, filter, scroll — rather than the picker's. What it
// still shares with `cli/sessions.ts` is the one thing that must never
// disagree between the two surfaces: `filterSessions()`, the definition of
// what the filter box means.
//
// Layout, which is the request: **the list on the left, and what was said in
// the highlighted session on the right.** Every row carries when the session
// started and when its last message landed, and a session nobody named is
// named by the first thing that was typed into it (`session/preview.ts`).
//
// ---------------------------------------------------------------------
// 2026-09-07, the maintainer's second round of feedback on this surface.
// Four of the items land in this file and each changed a rule, not a pixel:
//
//  * **The session you are IN is in the list** (item 3). It used to be
//    invisible until it ended, because the list is built from `sessions`
//    rows and a live session has no row until ingest. The browser now takes
//    a synthesised row for the current session from its owner and marks it,
//    so "which of these am I?" is answerable without leaving and coming
//    back.
//  * **The groups are the lifecycle, they are ordered, and they fold**
//    (item 10). Empty → Running → Open → Closed, and Enter on a heading
//    collapses it. That makes the cursor move over two kinds of thing, so
//    the list is now an `Entry[]` — a heading or a session — rather than a
//    row index with headings drawn in as decoration.
//  * **Ctrl-X closes a session** (items 7 and 10), and says so on screen.
//    A running session cannot be closed from here at all: there is a
//    process that owns it, and closing the row out from under it would
//    make the ledger disagree with the machine. The refusal says what to
//    do instead rather than just refusing.
//  * **The hint sits at the bottom and the list reaches it** (item 8).
//
// Two rules it inherits and does not get to reinterpret:
//
//   * **It never spends anything.** Opening, filtering, scrolling, folding
//     and closing write no `calls` row and send nothing to a model.
//   * **It does no IO of its own.** Rows and previews arrive through
//     `BrowserSource`, so this file can be tested at two hundred sessions
//     without a disk.

import { filterSessions, type SessionListRow } from "../../session/listing.js";
import type { SessionPreview } from "../../session/preview.js";
import {
  deriveSessionLifecycle,
  LIFECYCLE_LABELS,
  LIFECYCLE_ORDER,
  type SessionLifecycle,
} from "../../session/lifecycle.js";
import type { KeyEvent } from "./input.js";
import { style, type ResolvedTheme, withBackground } from "../theme/resolve.js";
import { truncate } from "../format.js";
import { stringWidth } from "../width.js";
import { wrapPlain } from "./scrollback.js";
import { visibleWidth } from "./frame.js";
import { renderScreenBlock } from "./blocks.js";

export interface BrowserFailure {
  project: string;
  reason: string;
}

export interface BrowserLoad {
  rows: readonly SessionListRow[];
  /**
   * Ledgers that could not be opened — locked, corrupt, or from a newer
   * schema. Shown in the view rather than skipped: a project that silently
   * vanishes from the list is indistinguishable from one with no sessions.
   */
  failures: readonly BrowserFailure[];
  /** T115: fan-out instrumentation supplied by the source. */
  fanout?: { elapsedMs: number; projectsScanned: number; rowsReturned: number };
}

export interface BrowserSource {
  load(): BrowserLoad;
  /** What was said in one session. Called for the highlighted row only, and expected to cache — see `PreviewCache`. */
  preview(row: SessionListRow): SessionPreview;
  loadAll?(): BrowserLoad;
}

export interface BrowserState {
  rows: readonly SessionListRow[];
  failures: readonly BrowserFailure[];
  filter: string;
  /** Index into the flattened ENTRY list — headings included. Clamped by every transition. */
  cursor: number;
  /** First entry drawn in the left pane. */
  scroll: number;
  /** How far down the preview pane is scrolled, in rendered lines. */
  previewScroll: number;
  notice: string | null;
  scope: "project" | "all";
  fanout: BrowserLoad["fanout"];
  /** Lifecycle groups the user has folded away. Item 10: expand/shrink with Enter. */
  collapsed: readonly SessionLifecycle[];
  lastDelete?: { id: string; at: number };
}

export type BrowserAction =
  | { kind: "none" }
  | { kind: "select"; row: SessionListRow }
  | { kind: "close" }
  | { kind: "toggleScope" }
  | { kind: "new" }
  /** Item 10: mark the session Closed. Never sent for a running one. */
  | { kind: "closeSession"; row: SessionListRow }
  | { kind: "delete"; row: SessionListRow };

/** Rows per session entry: the name, then its times. A heading is one row. */
const ROWS_PER_ENTRY = 2;
/** Chrome the view always draws: title, filter, separator, hint. */
const CHROME_ROWS = 4;

/**
 * One thing the cursor can be on.
 *
 * Headings are entries rather than decoration because Enter has to be able
 * to land on one (item 10). Anything that treats the list as "sessions, with
 * labels painted in" ends up with a cursor index that means one thing to the
 * renderer and another to the key handler, which is the bug class this
 * whole file already learned once.
 */
export type BrowserEntry =
  | { kind: "heading"; state: SessionLifecycle; count: number; collapsed: boolean }
  | { kind: "session"; row: SessionListRow; state: SessionLifecycle };

export function openBrowser(source: BrowserSource): BrowserState {
  const load = source.load();
  const state: BrowserState = {
    rows: load.rows,
    failures: load.failures,
    filter: "",
    cursor: 0,
    scroll: 0,
    previewScroll: 0,
    notice: null,
    scope: "project",
    fanout: load.fanout,
    // Nothing is folded on the first open. Closed sessions are the group
    // that will grow without bound, but folding them by default would hide
    // the archive from someone who came here to read it.
    collapsed: [],
  };
  // Open on the first SESSION, not on the heading above it: the preview
  // pane is half this view and it would otherwise be blank until the first
  // keypress, and Enter — the key everyone reaches for — would fold a group
  // rather than resume anything.
  return { ...state, cursor: Math.max(0, state.rows.length === 0 ? 0 : firstSessionIndex(state)) };
}

/** Index of the first session entry, or 0 when the list is all headings (which cannot happen) or empty. */
function firstSessionIndex(state: BrowserState, now = new Date()): number {
  const entries = browserEntries(state, now);
  const at = entries.findIndex((entry) => entry.kind === "session");
  return at === -1 ? 0 : at;
}

export function visibleRows(state: BrowserState): SessionListRow[] {
  return filterSessions(state.rows.filter((row) => row.deletedUtc == null), state.filter);
}

function lifecycleOf(row: SessionListRow, now: Date): SessionLifecycle {
  return deriveSessionLifecycle(row, {
    hasUserMessage: (row.callCount ?? 0) > 0,
    heartbeatUtc: row.heartbeatUtc ?? null,
    ...(row.isRunning !== undefined ? { isRunning: row.isRunning } : {}),
    now,
  });
}

/**
 * The flattened list the cursor walks: a heading per non-empty lifecycle
 * group, in `LIFECYCLE_ORDER`, with its sessions under it unless folded.
 *
 * Built fresh on every keystroke rather than cached on the state. It is a
 * pure function of rows + filter + collapsed, and a cached copy is one more
 * thing that can disagree with the cursor pointing into it.
 */
export function browserEntries(state: BrowserState, now = new Date()): BrowserEntry[] {
  const rows = visibleRows(state);
  const byState = new Map<SessionLifecycle, SessionListRow[]>();
  for (const row of rows) {
    const st = lifecycleOf(row, now);
    const bucket = byState.get(st);
    if (bucket) bucket.push(row);
    else byState.set(st, [row]);
  }
  const collapsed = new Set(state.collapsed);
  const out: BrowserEntry[] = [];
  for (const st of LIFECYCLE_ORDER) {
    const bucket = byState.get(st);
    if (!bucket || bucket.length === 0) continue;
    const folded = collapsed.has(st);
    out.push({ kind: "heading", state: st, count: bucket.length, collapsed: folded });
    if (folded) continue;
    for (const row of bucket) out.push({ kind: "session", row, state: st });
  }
  return out;
}

/** The session under the cursor, or null when a heading is. */
export function selectedRow(state: BrowserState, now = new Date()): SessionListRow | null {
  const entry = browserEntries(state, now)[state.cursor];
  return entry?.kind === "session" ? entry.row : null;
}

/**
 * How many entries fit in the left pane at this height.
 *
 * Sessions take two rows and headings take one, so this is a lower bound
 * rather than an exact count — used for paging, where being conservative
 * means Page Down never jumps past something unseen.
 */
export function listPageSize(height: number): number {
  return Math.max(1, Math.floor((height - CHROME_ROWS) / ROWS_PER_ENTRY));
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function withCursor(state: BrowserState, cursor: number, page: number): BrowserState {
  const total = browserEntries(state).length;
  const next = clamp(cursor, 0, Math.max(0, total - 1));
  let scroll = state.scroll;
  if (next < scroll) scroll = next;
  if (next >= scroll + page) scroll = next - page + 1;
  scroll = clamp(scroll, 0, Math.max(0, total - 1));
  // Moving to another session always starts its preview at the top: keeping
  // the old offset would open a short conversation scrolled past its end.
  return { ...state, cursor: next, scroll, previewScroll: 0, notice: null };
}

function toggleGroup(state: BrowserState, group: SessionLifecycle): BrowserState {
  const collapsed = state.collapsed.includes(group)
    ? state.collapsed.filter((g) => g !== group)
    : [...state.collapsed, group];
  // The cursor stays on the heading it was on: folding a group must not
  // teleport the selection somewhere else, and the heading is guaranteed to
  // still exist because folding never removes one.
  return { ...state, collapsed, notice: null, previewScroll: 0 };
}

/**
 * One keystroke.
 *
 * Arrows and Ctrl-N/P move the list; PageUp/PageDown scroll the *preview*,
 * because that is the pane with more in it than fits and the one a reader
 * reaches for. Printable characters filter, Enter chooses or folds, Escape
 * leaves. Ctrl-X closes a session; Ctrl-K deletes its conversation.
 */
export function browserKey(
  state: BrowserState,
  key: KeyEvent,
  height: number,
  now = Date.now(),
): { state: BrowserState; action: BrowserAction } {
  const page = listPageSize(height);
  const entries = browserEntries(state, new Date(now));
  const here = entries[state.cursor];
  const none = (s: BrowserState): { state: BrowserState; action: BrowserAction } => ({ state: s, action: { kind: "none" } });

  switch (key.type) {
    case "escape":
      return { state, action: { kind: "close" } };
    case "ctrl":
      if (key.key === "c" || key.key === "d") return { state, action: { kind: "close" } };
      if (key.key === "n" && key.shift) return { state, action: { kind: "new" } };
      if (key.key === "n") return none(withCursor(state, state.cursor + 1, page));
      if (key.key === "p") return none(withCursor(state, state.cursor - 1, page));
      if (key.key === "u") return none(withCursor({ ...state, filter: "" }, 0, page));
      if (key.key === "o") return { state, action: { kind: "toggleScope" } };
      if (key.key === "x") {
        // Item 10. A heading is not a session and closing "all of Open"
        // silently is not a gesture anyone asked for.
        if (here?.kind !== "session") return none({ ...state, notice: "Ctrl-X closes the highlighted session" });
        if (here.state === "running") {
          // The maintainer's own rule: a running session is stopped by the
          // process running it, not by a row edit from another window.
          return none({
            ...state,
            notice: here.row.isCurrent === true
              ? "this session is mid-turn — press Esc or Ctrl-C in it to stop the turn, then Ctrl-X to close"
              : "that session is running — resume it (Enter), stop its turn with Esc, then Ctrl-X to close",
          });
        }
        if (here.state === "closed") return none({ ...state, notice: "already closed — Enter reopens it" });
        return { state: { ...state, notice: null }, action: { kind: "closeSession", row: here.row } };
      }
      if (key.key === "k") {
        // Deletion moved off Ctrl-X when Ctrl-X became "close" (item 10).
        // The two-press confirmation is kept exactly as T129 built it: this
        // removes a conversation, and the accounting it leaves behind is
        // not a reason to make it a single keystroke.
        if (here?.kind !== "session") return none(state);
        const row = here.row;
        if (row.isCurrent === true) return none({ ...state, notice: "you are in this session — it cannot be deleted from inside itself" });
        const second = state.lastDelete?.id === row.id && now - state.lastDelete.at <= 3000;
        if (second) {
          const { lastDelete: _lastDelete, ...withoutPending } = state;
          return { state: withoutPending, action: { kind: "delete", row } };
        }
        return none({
          ...state,
          lastDelete: { id: row.id, at: now },
          notice: "press Ctrl-K again within 3s to delete this conversation (its cost is kept)",
        });
      }
      return none(state);
    case "arrow":
      if (key.dir === "down") return none(withCursor(state, state.cursor + 1, page));
      if (key.dir === "up") return none(withCursor(state, state.cursor - 1, page));
      // Left/right fold and unfold the group the cursor is in — the gesture
      // every tree in every file manager uses — and scroll the preview when
      // the cursor is on a session inside an already-open group.
      if (key.dir === "left") {
        if (here?.kind === "heading" && !here.collapsed) return none(toggleGroup(state, here.state));
        return none({ ...state, previewScroll: Math.max(0, state.previewScroll - 1), notice: null });
      }
      if (here?.kind === "heading" && here.collapsed) return none(toggleGroup(state, here.state));
      return none({ ...state, previewScroll: state.previewScroll + 1, notice: null });
    case "pageDown":
      return none({ ...state, previewScroll: state.previewScroll + Math.max(1, height - CHROME_ROWS - 2), notice: null });
    case "pageUp":
      return none({
        ...state,
        previewScroll: Math.max(0, state.previewScroll - Math.max(1, height - CHROME_ROWS - 2)),
        notice: null,
      });
    case "home":
      return none(withCursor(state, 0, page));
    case "end":
      return none(withCursor(state, entries.length - 1, page));
    case "backspace":
      return none(withCursor({ ...state, filter: state.filter.slice(0, -1) }, 0, page));
    case "enter": {
      if (!here) return none(state);
      if (here.kind === "heading") return none(toggleGroup(state, here.state));
      const row = here.row;
      if (row.isCurrent === true) {
        return none({ ...state, notice: "this is the session you are in — Esc goes back to it" });
      }
      if (!row.resumable) {
        // Verbatim, never softened into a generic error — `08` §1.1's
        // requirement, restated by T60 because this is exactly the message
        // that gets rewritten into "cannot resume".
        return none({ ...state, notice: row.notResumableReason ?? "this session was recorded as not resumable" });
      }
      return { state, action: { kind: "select", row } };
    }
    case "char":
      return none(withCursor({ ...state, filter: state.filter + key.value }, 0, page));
    default:
      return none(state);
  }
}

export interface RenderBrowserOpts {
  width: number;
  height: number;
  theme: ResolvedTheme;
  now?: Date;
  preview: (row: SessionListRow) => SessionPreview;
}

/**
 * The whole frame while the browser is open. Exactly `height` lines, never
 * more and never fewer — the caller paints these instead of the session,
 * not on top of it, so a short answer would leave the previous frame's rows
 * showing through underneath (item 8).
 */
export function renderBrowser(state: BrowserState, opts: RenderBrowserOpts): string[] {
  const { theme } = opts;
  const width = Math.max(40, opts.width);
  const height = Math.max(8, opts.height);
  const now = opts.now ?? new Date();
  const ascii = theme.glyphs === "ascii";
  const entries = browserEntries(state, now);
  const here = entries[state.cursor];
  const selected = here?.kind === "session" ? here.row : null;

  // The list gets a fixed, readable share and the preview gets the rest —
  // 40% is enough for a name and a time pair at every width this runs at.
  const listWidth = clamp(Math.floor(width * 0.4), 28, 52);
  const previewWidth = width - listWidth - 3;

  const out: string[] = [];
  const total = state.rows.filter((row) => row.deletedUtc == null).length;
  const shown = visibleRows(state).length;
  const count = shown === total ? `${total}` : `${shown}/${total}`;
  out.push(
    style(ascii ? "sessions" : "‹ sessions", "accent", theme) +
      style(`  ${count} in ${state.scope === "all" ? "all projects" : "this project"}`, "faint", theme),
  );
  out.push(style(`  filter: ${state.filter}${ascii ? "_" : "▏"}`, state.filter ? "text" : "faint", theme));
  out.push(style((ascii ? "-" : "─").repeat(width), "faint", theme));

  const bodyHeight = height - CHROME_ROWS;
  const listLines = renderList(state, entries, listWidth, bodyHeight, opts, now);
  const previewLines = renderPreview(selected, previewWidth, bodyHeight, state.previewScroll, opts);
  const divider = style(ascii ? "|" : "│", "faint", theme);
  for (let i = 0; i < bodyHeight; i++) {
    const left = padVisible(listLines[i] ?? "", listWidth);
    const right = previewLines[i] ?? "";
    out.push(`${left} ${divider} ${right}`);
  }

  out.push(renderHint(state, theme, width));
  // Exactly `height`: pad as well as slice. `out` is built to length by
  // construction today, but a renderer whose contract is "fills the frame"
  // should not depend on arithmetic elsewhere in the file staying true.
  while (out.length < height) out.push("");
  return out.slice(0, height);
}

function renderList(
  state: BrowserState,
  entries: readonly BrowserEntry[],
  width: number,
  height: number,
  opts: RenderBrowserOpts,
  now: Date,
): string[] {
  const { theme } = opts;
  const ascii = theme.glyphs === "ascii";
  if (entries.length === 0) {
    return [style(state.rows.length === 0 ? "  nothing recorded yet" : "  nothing matches that filter", "faint", theme)];
  }
  const lines: string[] = [];
  for (let i = state.scroll; i < entries.length && lines.length < height; i++) {
    const entry = entries[i]!;
    const on = i === state.cursor;
    if (entry.kind === "heading") {
      // The fold marker points the way it will move, which is the one
      // convention every tree control shares.
      const chevron = entry.collapsed ? (ascii ? "+" : "▸") : (ascii ? "-" : "▾");
      const text = `${chevron} ${LIFECYCLE_LABELS[entry.state]}  ${entry.count}`;
      const line = style(truncate(text, Math.max(4, width), ascii), entry.state === "running" ? "ok" : "accent", theme);
      lines.push(on ? withBackground(line, "completionBg", theme, visibleWidth(line), width) : line);
      continue;
    }
    const row = entry.row;
    const preview = opts.preview(row);
    const name = preview.name ?? row.brief ?? row.taskBrief ?? row.id.slice(0, 8);
    // Item 3: the session you are in is marked, and marked in the column
    // the eye is already scanning rather than as a suffix that truncation
    // could eat.
    const marker = on ? (ascii ? "  > " : "  ▸ ") : row.isCurrent === true ? (ascii ? "  * " : "  ● ") : "    ";
    const nameLine =
      style(marker, row.isCurrent === true && !on ? "ok" : "accent", theme) +
      style(truncate(name, Math.max(4, width - 4), ascii), on ? "accent" : "text", theme);
    const started = shortWhen(row.startedUtc, now);
    const last = preview.lastMessageUtc ?? row.endedUtc;
    const when = `${started} ${ascii ? "->" : "→"} ${last ? shortWhen(last, now) : "now"}`;
    const tag = row.isCurrent === true ? "  this session" : "";
    const outcome = row.outcome === null ? "" : row.outcomeSource === "agent_claim" ? `  ${row.outcome}?` : `  ${row.outcome}`;
    const timesLine = style(truncate(`      ${when}${tag}${outcome}`, Math.max(4, width), ascii), "faint", theme);
    lines.push(on ? withBackground(nameLine, "completionBg", theme, visibleWidth(nameLine), width) : nameLine);
    if (lines.length < height) {
      lines.push(on ? withBackground(timesLine, "completionBg", theme, visibleWidth(timesLine), width) : timesLine);
    }
  }
  return lines;
}

function renderPreview(
  row: SessionListRow | null,
  width: number,
  height: number,
  scroll: number,
  opts: RenderBrowserOpts,
): string[] {
  const { theme } = opts;
  if (!row) return [];
  const preview = opts.preview(row);
  const lines: string[] = [];

  if (preview.unavailable !== null) {
    lines.push(style(preview.unavailable, "faint", theme));
    return lines;
  }
  if ((preview.screenBlocks?.length ?? 0) === 0 && preview.turns.length === 0) {
    lines.push(style("nothing was said in this session", "faint", theme));
    return lines;
  }

  if ((preview.screenBlocks?.length ?? 0) > 0) {
    for (const block of preview.screenBlocks ?? []) {
      lines.push(...renderScreenBlock(block, { width: Math.max(8, width), theme }));
      lines.push("");
    }
    if ((preview.unsupportedKinds?.length ?? 0) > 0) {
      lines.push(style(`… omitted transcript events: ${preview.unsupportedKinds?.join(", ")}`, "faint", theme));
    }
  } else {
    for (const turn of preview.turns) {
      const label = turn.role === "you" ? "you" : turn.role === "lykos" ? "lykos" : "";
      if (label) lines.push(style(`${label}`, turn.role === "you" ? "accent" : "cache", theme));
      for (const wrapped of wrapPlain(turn.text, Math.max(8, width))) {
        lines.push(style(wrapped, turn.role === "note" ? "faint" : "text", theme));
      }
      lines.push("");
    }
  }

  // Clamp the scroll to what actually exists, so holding PageDown parks at
  // the end instead of scrolling into empty space.
  const maxScroll = Math.max(0, lines.length - height);
  return lines.slice(Math.min(scroll, maxScroll), Math.min(scroll, maxScroll) + height);
}

function renderHint(state: BrowserState, theme: ResolvedTheme, width: number): string {
  if (state.notice !== null) return style(truncate(`  ${state.notice}`, width, theme.glyphs === "ascii"), "warn", theme);
  if (state.failures.length > 0) {
    const text = `  ${state.failures.length} ledger(s) could not be read: ${state.failures
      .map((f) => `${f.project} (${f.reason})`)
      .join("; ")}`;
    return style(truncate(text, width, theme.glyphs === "ascii"), "warn", theme);
  }
  // Item 7: Ctrl-X was never mentioned anywhere, so it did not exist as far
  // as anyone using this could tell. Item 8's other half: the sentence now
  // reads as English — "pgup/pgdn TO preview".
  return style(
    truncate(
      "  ↑↓ move · enter to resume or fold · Ctrl-X to close · Ctrl-K to delete · pgup/pgdn to scroll · Ctrl-O scope · Ctrl-N new · esc back · type to filter",
      width,
      theme.glyphs === "ascii",
    ),
    "faint",
    theme,
  );
}

/** Pads to a visible width, ignoring the ANSI the styles already added. */
function padVisible(text: string, width: number): string {
  const w = stringWidth(text.replace(/\[[0-9;]*m/g, ""));
  return w >= width ? text : text + " ".repeat(width - w);
}

/** `14:32` for today, `Sep 4 14:32` otherwise — the pair a person actually compares sessions by. */
export function shortWhen(iso: string, now: Date): string {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "?";
  const hh = `${t.getHours()}`.padStart(2, "0");
  const mm = `${t.getMinutes()}`.padStart(2, "0");
  const sameDay =
    t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}`;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][t.getMonth()]!;
  return `${month} ${t.getDate()} ${hh}:${mm}`;
}
