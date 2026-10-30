// Fixed-width formatting (docs/07-ui-and-hud.md §4): numbers must not jitter
// as values change — "a status line that reflows every turn is a status line
// people turn off." Every formatter here returns a string, never a number,
// so a renderer cannot accidentally interpolate an unformatted value.

import { sliceToWidth, stringWidth } from "./width.js";

/** 42100 -> "42.1k", 1_240_000 -> "1.24M", 950 -> "950". */
export function fmtTokens(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
}

/**
 * $0.0384 -> "$0.0384" below a cent, "$0.038" -> ... at/above a cent per
 * docs/07-ui-and-hud.md §4's own example ("$0.0384 -> $0.038 above a cent").
 * Unpriced (null/undefined) renders "$?", never "$0.00" (H-4).
 */
export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "$?";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs < 0.01) return `${sign}$${abs.toFixed(4)}`;
  return `${sign}$${abs.toFixed(3)}`;
}

/** An avoided figure always carries `~` and is never bare (03-telemetry.md §5). */
export function fmtAvoidedUsd(n: number): string {
  return `~${fmtUsd(n)}`;
}

/**
 * 12.4 -> "12.4s", 90 -> "1m 30s". A per-message wall-clock duration
 * (2026-09-02 round eight, item 2) — one decimal below a minute, whole
 * seconds above it, since a stopwatch tenth of a second stops meaning
 * anything once tool calls are involved.
 */
export function fmtDuration(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) return `${s.toFixed(1)}s`;
  const mins = Math.floor(s / 60);
  const secs = Math.round(s % 60);
  return `${mins}m ${secs}s`;
}

/** 0.913 -> "91%". */
export function fmtPct(fraction: number | null): string {
  if (fraction === null || Number.isNaN(fraction)) return "?%";
  return `${Math.round(fraction * 100)}%`;
}

/** width-cell gauge: gauge(0.58, 10) -> "██████░░░░" (unicode) or "#####----" (ascii). */
export function gauge(pct: number | null, width: number, ascii: boolean): string {
  const full = ascii ? "#" : "█";
  const empty = ascii ? "-" : "░";
  if (pct === null) return empty.repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
  return full.repeat(filled) + empty.repeat(width - filled);
}

/** Pad to `width` terminal COLUMNS — `stringWidth`, not `.length`, for the same reason `truncate` uses it. */
export function pad(s: string, width: number): string {
  const w = stringWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

/**
 * Whole-string truncate. The ellipsis is `...` under the ascii glyph set so
 * LYKOS_ASCII=1 never emits a unicode codepoint in a fixed-width field.
 */
export function truncate(s: string, width: number, ascii = false): string {
  // Measured in terminal COLUMNS since 2026-09-02, not UTF-16 code units —
  // see `tui/width.ts`. A string containing a wide glyph used to come back
  // one column over budget from here, and the caller that padded a field
  // to `width` around it then produced a row the frame had to clip.
  if (stringWidth(s) <= width) return s;
  if (width <= 1) return sliceToWidth(s, Math.max(0, width)).text;
  const ellipsis = ascii ? "..." : "…";
  const room = ascii ? 3 : 1;
  if (width <= room) return sliceToWidth(s, width).text;
  return `${sliceToWidth(s, width - room).text}${ellipsis}`;
}

const SPARK_UNICODE = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;
const SPARK_ASCII = ["_", ".", "-", "=", "#"] as const;

/** docs/07-ui-and-hud.md §1.2 primitive: a sparkline over a series. Empty in, empty out. */
export function sparkline(values: readonly number[], ascii: boolean): string {
  if (values.length === 0) return "";
  const bars = ascii ? SPARK_ASCII : SPARK_UNICODE;
  let min = values[0]!;
  let max = values[0]!;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min;
  return values
    .map((v) => {
      if (span === 0) return bars[0]!;
      const idx = Math.round(((v - min) / span) * (bars.length - 1));
      return bars[Math.max(0, Math.min(bars.length - 1, idx))]!;
    })
    .join("");
}

/**
 * Avoided is a model, never a measurement (03-telemetry.md §5.3). Drop the
 * segment entirely rather than print a bare `~$n` when spend or the basis
 * is missing — a truncated dollar figure reads as a number and is not one.
 */
export function renderAvoidedSegment(
  spentUsd: number | null | undefined,
  avoidedUsd: number | null | undefined,
  basis: string | null | undefined,
): string | null {
  if (avoidedUsd === null || avoidedUsd === undefined || Number.isNaN(avoidedUsd)) return null;
  if (spentUsd === null || spentUsd === undefined || Number.isNaN(spentUsd)) return null;
  if (!basis) return null;
  return `${fmtUsd(spentUsd)} ${fmtAvoidedUsd(avoidedUsd)} (${basis})`;
}
