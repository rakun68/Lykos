// Live in-turn state: the footer moves.
//
// Today the HUD prints once, after the turn ends — even though
// `StandaloneSessionState` is updated live in memory the whole time
// (`s0.ts`'s `writeHud()`/`deriveHud()` already read it; T42's footer
// already draws whatever `ViewModel` it is handed). What is missing is a
// row for mid-turn activity: a spinner, elapsed seconds, the tool
// currently running, and the abort hint. This file is that row, and
// nothing else — the moving token/spend counters are T37/T42's existing
// live-overlay pipeline (`runFromSessionState()` -> `deriveHud()` ->
// `renderTriadLine()`) doing exactly what it already does, called again
// on the next scheduled frame; there is no second counter to build.
//
// T48.3: reads state from memory only. Nothing here opens the ledger —
// s0-writes.test.ts's scan covers this file like every other one under
// lykos/tui/.

import { style, type ResolvedTheme } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";

// The spinner cycle: frames, then the same frames reversed.
const SPINNER_UNICODE = ["·", "✢", "✳", "✶", "✻", "✽"] as const;
const SPINNER_ASCII = ["|", "/", "-", "\\"] as const;

/** One frame every 120ms. Wall-clock only, independent of token arrival (T48). */
const FRAME_INTERVAL_MS = 120;

function spinnerFrames(ascii: boolean): readonly string[] {
  if (ascii) return SPINNER_ASCII;
  return [...SPINNER_UNICODE, ...[...SPINNER_UNICODE].reverse()];
}

export function spinnerFrame(elapsedMs: number, ascii: boolean): string {
  const frames = spinnerFrames(ascii);
  const idx = Math.floor(Math.max(0, elapsedMs) / FRAME_INTERVAL_MS) % frames.length;
  return frames[idx]!;
}

export interface ActivityState {
  /** False between turns — the row renders as zero lines then (T48.1: "visible only while a turn runs"). */
  running: boolean;
  startedAtMs: number;
  nowMs: number;
  /** Tool(s) currently mid-execution, in start order — empty while the model is only thinking/speaking. */
  activeTools: readonly string[];
}

function fmtElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

/**
 * T48.1: spinner, elapsed, the running tool(s), the abort hint — one line,
 * empty between turns. Not self-clipping: like every other renderer in
 * this package, width clipping happens once, ANSI-safely, when `frame.ts`
 * assembles the final `Frame` — clipping a styled string here would risk
 * cutting an escape sequence in half.
 */
export function renderActivityLines(state: ActivityState, theme: ResolvedTheme): string[] {
  if (!state.running) return [];
  const ascii = theme.glyphs === "ascii";
  const elapsedMs = Math.max(0, state.nowMs - state.startedAtMs);
  const spinner = style(spinnerFrame(elapsedMs, ascii), "accent", theme);
  const elapsed = style(fmtElapsed(Math.floor(elapsedMs / 1000)), "dim", theme);
  const tool = state.activeTools.length > 0 ? `  ${style(state.activeTools.join(", "), "delegate", theme)}` : "";
  const hint = style("Ctrl-C abort", "faint", theme);
  const g = GLYPHS[theme.glyphs];
  return [`${spinner} ${elapsed}${tool}  ${g.vbar} ${hint}`];
}
