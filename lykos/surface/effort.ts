// Reasoning effort as a *displayable* thing — 2026-09-02 UI feedback round
// three, item 7: "make effort message more informative… Each effort have a
// different color. And the two bar wrapping around chat box should change
// color based on effort too, off low high max is darker to brighter, the
// color should be light blue like the theme of lykos."
//
// The ladder itself is Pi's, not Lykos's (`THINKING_LEVEL_OPTIONS`, read
// out of the bundled agent): the provider clamps to what the specific model
// supports, and inventing a second vocabulary between the user and Pi would
// be one more thing to keep in sync. This module adds only the two things a
// terminal needs on top of it — which token colours a level, and how the
// composer's border rules read the current one.
//
// Why four palette tokens for seven levels: the ramp is a *brightness*
// signal, not an identity one. Its job is "more effort is brighter", read
// peripherally off the input box, and seven steps of one hue are not
// distinguishable at a glance in a terminal's colour space — four are. The
// bucketing below is the whole of that compromise, stated in one place
// rather than reproduced at each call site.

import type { SemanticToken } from "./theme/types.js";

export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

const BUCKET: Record<string, SemanticToken> = {
  off: "effortOff",
  minimal: "effortLow",
  low: "effortLow",
  medium: "effortMid",
  high: "effortMid",
  xhigh: "effortMax",
  max: "effortMax",
};

/**
 * The colour token for one effort level. An unknown level (a provider with
 * a ladder Lykos has never seen) gets the middle of the ramp rather than
 * throwing or defaulting to `off` — showing a real level in the "nothing"
 * colour would be a quiet lie about a setting the user just changed.
 */
export function effortToken(level: string | null | undefined): SemanticToken {
  if (!level) return "effortOff";
  return BUCKET[level.toLowerCase()] ?? "effortMid";
}

/** True when `level` names a rung of Pi's own ladder. */
export function isEffortLevel(level: string): level is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(level.toLowerCase());
}
