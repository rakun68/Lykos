// The session picker's view model.
//
// `02-plan.md` §5's argument for inserting Phase 3.5 before Phase 4 was that
// a picker built against append-only stdout would have to be built twice.
// This is the once: a pure state machine over `session/listing.ts`'s rows,
// plus a renderer that returns lines. It owns no terminal, opens no file and
// never writes to the ledger — the T50 rule that the UI never writes and
// never derives a number applies here exactly as it does everywhere else.
//
// The one thing this task insists on, from §T58: **T56's verdict is shown
// before you press Enter, not after.** The estimated rebuild cost and any
// warning sit on the highlighted row, and a `resumable = 0` row is visibly
// marked with its reason and cannot be selected. The verdict is supplied by
// the caller as a lookup, because computing it reads a transcript off disk
// and a renderer that does file IO cannot be tested at a hundred rows.

import { filterSessions, type SessionListRow } from "../session/listing.js";
import type { ResumeVerdict } from "../session/resume-preflight.js";
import type { KeyEvent } from "./screen/input.js";
import { style, type ResolvedTheme } from "./theme/resolve.js";
import { fmtDuration, fmtUsd, pad, truncate } from "./format.js";
import { visibleWidth, clipToWidth } from "./screen/frame.js";

/** What the picker needs from T56. A caller with no preflight yet passes nothing and the row simply says so. */
export interface RowVerdict {
  overall: ResumeVerdict;
  /** One line: the worst check's message, or the cost when everything passed. */
  summary: string;
  estimateTokens?: number;
  estimateUsd?: number | null;
}

export interface PickerState {
  /** Nested by `nestSessions()`, newest root first. Never mutated. */
  rows: readonly SessionListRow[];
  filter: string;
  /** Index into the FILTERED list. Clamped by every transition. */
  cursor: number;
  /** First filtered index drawn. The renderer keeps the cursor inside the window. */
  scroll: number;
}

export type PickerAction =
  | { kind: "none" }
  | { kind: "select"; row: SessionListRow }
  /** Enter on a row that cannot be resumed. The picker stays open and says why. */
  | { kind: "refused"; row: SessionListRow; reason: string }
  | { kind: "cancel" };

export function initialPickerState(rows: readonly SessionListRow[]): PickerState {
  return { rows, filter: "", cursor: 0, scroll: 0 };
}

/**
 * `filterSessions` is the one definition of what the filter box means,
 * shared with the non-interactive listing, so filtering in the picker and
 * filtering on the command line can never disagree.
 */
export function visibleRows(state: PickerState): SessionListRow[] {
  return filterSessions(state.rows, state.filter);
}

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

function withCursor(state: PickerState, cursor: number, pageSize: number): PickerState {
  const total = visibleRows(state).length;
  const next = clamp(cursor, 0, Math.max(0, total - 1));
  const page = Math.max(1, pageSize);
  let scroll = state.scroll;
  if (next < scroll) scroll = next;
  if (next >= scroll + page) scroll = next - page + 1;
  scroll = clamp(scroll, 0, Math.max(0, total - 1));
  return { ...state, cursor: next, scroll };
}

/**
 * One keystroke. Returns the next state and what the caller should do.
 *
 * Deliberately small: arrows and Ctrl-P/N to move, printable characters to
 * filter, Enter to choose, Escape to cancel. No mouse, no multi-select, no
 * sort keys — every one of those is a feature nobody has asked for yet, and
 * `17` §5's rule about promoting a gap applies to the picker too.
 */
export function pickerKey(
  state: PickerState,
  key: KeyEvent,
  pageSize: number,
): { state: PickerState; action: PickerAction } {
  const rows = visibleRows(state);
  const none = (s: PickerState): { state: PickerState; action: PickerAction } => ({ state: s, action: { kind: "none" } });

  switch (key.type) {
    case "escape":
      return { state, action: { kind: "cancel" } };
    case "ctrl":
      if (key.key === "c" || key.key === "d") return { state, action: { kind: "cancel" } };
      if (key.key === "n") return none(withCursor(state, state.cursor + 1, pageSize));
      if (key.key === "p") return none(withCursor(state, state.cursor - 1, pageSize));
      if (key.key === "u") return none(withCursor({ ...state, filter: "" }, 0, pageSize));
      return none(state);
    case "arrow":
      if (key.dir === "down") return none(withCursor(state, state.cursor + 1, pageSize));
      if (key.dir === "up") return none(withCursor(state, state.cursor - 1, pageSize));
      return none(state);
    case "pageDown":
      return none(withCursor(state, state.cursor + pageSize, pageSize));
    case "pageUp":
      return none(withCursor(state, state.cursor - pageSize, pageSize));
    case "home":
      return none(withCursor(state, 0, pageSize));
    case "end":
      return none(withCursor(state, rows.length - 1, pageSize));
    case "backspace":
      return none(withCursor({ ...state, filter: state.filter.slice(0, -1) }, 0, pageSize));
    case "enter": {
      const row = rows[state.cursor];
      if (!row) return none(state);
      if (!row.resumable) {
        return {
          state,
          action: {
            kind: "refused",
            row,
            // Verbatim, never softened into a generic error — `08` §1.1's
            // requirement, and T60 restates it because it is exactly the
            // kind of message that gets rewritten into "cannot resume".
            reason: row.notResumableReason ?? "this session was recorded as not resumable",
          },
        };
      }
      return { state, action: { kind: "select", row } };
    }
    case "char":
      return none(withCursor({ ...state, filter: state.filter + key.value }, 0, pageSize));
    default:
      return none(state);
  }
}

function outcomeLabel(row: SessionListRow): string {
  if (row.outcome === null) return row.endedUtc ? "—" : "running";
  // An agent's own claim is displayed as such and never as a success —
  // the ledger records it, the UI must not launder it.
  if (row.outcomeSource === "agent_claim") return `${row.outcome}?`;
  return row.outcome;
}

function when(iso: string, now: Date): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "?";
  const secs = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`;
  if (secs < 86_400) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86_400)}d ago`;
}

/** The tree edge drawn to the left of a nested row. */
function indent(row: SessionListRow, ascii: boolean): string {
  if (row.depth === 0) return "";
  const stem = "  ".repeat(row.depth - 1);
  const arm = row.edge === "resumed" ? (ascii ? "\\-> " : "└→ ") : ascii ? "\\-- " : "└─ ";
  return `${stem}${arm}`;
}

export interface RenderPickerOpts {
  width: number;
  height: number;
  theme?: ResolvedTheme | null;
  ascii?: boolean;
  now?: Date;
  /** T56's verdict for the highlighted row. Computed lazily by the caller — never here. */
  verdictFor?: (row: SessionListRow) => RowVerdict | undefined;
  /** A message from the last refused Enter, shown until the next keystroke. */
  notice?: string | null;
  title?: string;
}

/** How many session rows fit, given the chrome the renderer always draws. */
export function pickerPageSize(height: number): number {
  // title + filter + separator + detail(2) + footer = 6 lines of chrome.
  return Math.max(1, height - 6);
}

/**
 * Returns the lines to paint. Never longer than `height`, never wider than
 * `width` — `FrameWriter` clips too, but a renderer that relies on being
 * clipped is a renderer nobody can test.
 */
export function renderPicker(state: PickerState, opts: RenderPickerOpts): string[] {
  const theme = opts.theme ?? null;
  const paint = (text: string, token: Parameters<typeof style>[1]): string =>
    theme ? style(text, token, theme) : text;
  const ascii = opts.ascii ?? false;
  const now = opts.now ?? new Date();
  const width = Math.max(20, opts.width);
  const rows = visibleRows(state);
  const page = pickerPageSize(opts.height);
  const scroll = clamp(state.scroll, 0, Math.max(0, rows.length - 1));
  const lines: string[] = [];

  const title = opts.title ?? "sessions";
  lines.push(
    paint(clipToWidth(`  ${title}  ${rows.length}/${state.rows.length}`, width), "accent"),
  );
  lines.push(paint(clipToWidth(`  filter: ${state.filter}${theme ? "" : ""}_`, width), "dim"));
  lines.push(paint((ascii ? "-" : "─").repeat(width), "border"));

  if (rows.length === 0) {
    lines.push(paint("  nothing recorded yet — run something first.", "dim"));
  }

  for (let i = scroll; i < Math.min(rows.length, scroll + page); i += 1) {
    const row = rows[i]!;
    const selected = i === state.cursor;
    const marker = selected ? (ascii ? ">" : "❯") : " ";
    const label = row.taskBrief ?? row.brief ?? "(no brief)";
    const left = `${marker} ${row.id.slice(0, 8)} ${indent(row, ascii)}${label}`;
    const right = [
      row.model ?? "—",
      row.durationSeconds === null ? "—" : fmtDuration(row.durationSeconds),
      fmtUsd(row.costUsd),
      outcomeLabel(row),
      row.archiveState ?? "—",
    ].join("  ");
    const gap = Math.max(1, width - visibleWidth(right) - 2);
    const line = `${pad(truncate(left, gap - 1, ascii), gap)}${right} `;
    const token = !row.resumable ? "faint" : selected ? "accent" : "text";
    lines.push(paint(clipToWidth(line, width), token));
  }

  // The detail panel: two lines about the highlighted row, which is where
  // the preflight verdict and the reason a row cannot be selected live.
  const current = rows[state.cursor];
  lines.push(paint((ascii ? "-" : "─").repeat(width), "border"));
  if (!current) {
    lines.push("");
    lines.push("");
  } else if (!current.resumable) {
    lines.push(
      paint(clipToWidth(`  not resumable — ${current.notResumableReason ?? "no reason recorded"}`, width), "danger"),
    );
    lines.push(paint(clipToWidth(`  ${when(current.startedUtc, now)} · ${current.id}`, width), "dim"));
  } else {
    const verdict = opts.verdictFor?.(current);
    const token =
      verdict === undefined
        ? "dim"
        : verdict.overall === "refuse"
          ? "danger"
          : verdict.overall === "proceed"
            ? "ok"
            : "warn";
    const text =
      verdict === undefined
        ? "  checking…"
        : `  ${verdict.overall}: ${verdict.summary}`;
    lines.push(paint(clipToWidth(text, width), token));
    lines.push(
      paint(
        clipToWidth(
          `  ${when(current.startedUtc, now)} · ${current.id}` +
            (current.captureMode ? ` · capture ${current.captureMode}` : "") +
            (current.taskId ? ` · task ${current.taskId.slice(0, 8)}` : ""),
          width,
        ),
        "dim",
      ),
    );
  }

  lines.push(
    paint(
      clipToWidth(
        opts.notice
          ? `  ${opts.notice}`
          : "  ↑↓ move · type to filter · Enter resume · Esc cancel",
        width,
      ),
      opts.notice ? "warn" : "faint",
    ),
  );

  return lines.slice(0, opts.height);
}

/**
 * The append-only fallback (T50's discipline: every non-TTY caller still has
 * to work). A numbered list and a prompt — the same rows, no key handling.
 */
export function renderPickerFallback(
  rows: readonly SessionListRow[],
  opts: { now?: Date; ascii?: boolean; limit?: number } = {},
): string[] {
  const now = opts.now ?? new Date();
  const ascii = opts.ascii ?? true;
  const limit = opts.limit ?? 20;
  const shown = rows.slice(0, limit);
  const lines = shown.map((row, i) => {
    const label = row.taskBrief ?? row.brief ?? "(no brief)";
    const flags = [
      row.captureMode ?? "capture?",
      row.archiveState ?? "state?",
      outcomeLabel(row),
      fmtUsd(row.costUsd),
    ].join(" · ");
    const mark = row.resumable ? "" : "  [not resumable]";
    return `${pad(`${i + 1})`, 4)} ${row.id.slice(0, 8)}  ${indent(row, ascii)}${truncate(label, 48, ascii)}  ${when(row.startedUtc, now)}  ${flags}${mark}`;
  });
  if (rows.length > shown.length) {
    lines.push(`     … ${rows.length - shown.length} more — narrow it with a filter, or use \`lykos show <id>\``);
  }
  return lines;
}
