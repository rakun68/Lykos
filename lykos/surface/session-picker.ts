// The numbered session list `lykos sessions` prints and `lykos resume` reads a number from when no terminal can
// show lykos-tui (P5 #55 removed the full-screen picker). It owns no terminal, opens no file and never writes to the
// ledger.

import type { SessionListRow } from "../session/listing.js";
import { fmtUsd, pad, truncate } from "./format.js";

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
  const arm =
    row.edge === "resumed" ? (ascii ? "\\-> " : "└→ ") : row.edge === "forked" ? (ascii ? "\\-< " : "└↳ ") : ascii ? "\\-- " : "└─ ";
  return `${stem}${arm}`;
}

/** T266: where a fork came from, for the listing; empty for a row that is not one. */
function forkedLabel(row: SessionListRow): string {
  if (row.forkedFrom === null || row.forkedFrom === undefined) return "";
  const turn = row.forkedFromTurn !== null && row.forkedFromTurn !== undefined ? ` at turn ${row.forkedFromTurn}` : "";
  return ` · forked from ${row.forkedFrom.slice(0, 8)}${turn}`;
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
    const mark = (row.resumable ? "" : "  [not resumable]") + (row.archivedUtc ? "  [archived from lykos-tui]" : "");
    return `${pad(`${i + 1})`, 4)} ${row.id.slice(0, 8)}  ${indent(row, ascii)}${truncate(label, 48, ascii)}  ${when(row.startedUtc, now)}  ${flags}${forkedLabel(row)}${mark}`;
  });
  if (rows.length > shown.length) {
    lines.push(`     … ${rows.length - shown.length} more — narrow it with a filter, or use \`lykos show <id>\``);
  }
  return lines;
}
