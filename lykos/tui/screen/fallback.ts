// The fallback ladder, explicit and tested.
//
// A decision table, not a chain of `if`s: full-screen requires every one
// of four conditions, and missing any single one falls back to T37's
// append-only renderer, which keeps working exactly as it does today.
// `TERM=dumb`, a pipe, a redirect, CI, and `lykos mcp` all take the
// fallback — this function is where that list becomes one testable rule
// per row rather than four scattered checks a future change could get out
// of sync with each other.

export type RenderMode = "fullscreen" | "append-only";

export interface FallbackDecisionInput {
  /** T32: stdout belongs to the transport outside `standalone`. */
  ioMode: import("../io-mode.js").IoMode;
  isTTY: boolean;
  /** T41.2's probe result (or an explicit `LYKOS_VT` override) — never guessed from `TERM`. */
  vtSupported: boolean;
  /** `--no-fullscreen` at launch. */
  noFullscreen: boolean;
  /** Checked directly rather than folded into `vtSupported`: a caller that hasn't run the (async) probe yet can still catch the one case that needs no round-trip to know. */
  term?: string | undefined;
}

export interface FallbackDecision {
  mode: RenderMode;
  reason: string;
}

/**
 * The table, evaluated top to bottom — order matters only in that
 * `--no-fullscreen` is checked first, since it is a deliberate choice and
 * should win even if every other condition would otherwise allow the
 * full-screen surface.
 */
export function decideRenderMode(input: FallbackDecisionInput): FallbackDecision {
  if (input.noFullscreen) {
    return { mode: "append-only", reason: "--no-fullscreen was passed" };
  }
  if (input.ioMode !== "standalone") {
    return { mode: "append-only", reason: `io mode is "${input.ioMode}", not standalone (T32: stdout belongs to the transport)` };
  }
  if (!input.isTTY) {
    return { mode: "append-only", reason: "stdout is not a TTY (piped, redirected, or CI)" };
  }
  if (input.term === "dumb") {
    return { mode: "append-only", reason: "TERM=dumb" };
  }
  if (!input.vtSupported) {
    return { mode: "append-only", reason: "VT support not detected (T41.2's probe answered no, or was not run)" };
  }
  return { mode: "fullscreen", reason: "TTY, standalone, VT supported, --no-fullscreen not set" };
}
