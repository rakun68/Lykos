import { assembleSpecialistHead } from "./specialist-head.js";

// The default system-prompt block every Lykos session boots with, and the seam
// a specialist uses to replace it entirely instead of appending after it.
//
// **Provenance, per AGENTS.md rule 4 ("never fabricate") and the spec's own
// "the exact wording is the mechanism": fetched at implementation time from
// the real project, not reconstructed from memory.**
//
//   Project:  ponytail — https://github.com/DietrichGebert/ponytail
//   File:     .agents/rules/ponytail.md
//   Commit:   356918eba965ee1eac64bd3a7f0dd02108350de5 (2026-09-07T16:27:00Z, `main`)
//   Fetched:  raw.githubusercontent.com at that pinned commit; byte length
//             (2495) verified against the GitHub API blob for the same path
//             and commit before being copied in below.
//   License:  MIT, Copyright (c) 2026 DietrichGebert — verified by reading
//             the repository's own LICENSE file at the same commit.
//
// `PONYTAIL_RULESET_LINES` is the file's content verbatim, one array entry
// per line, joined with "\n" below rather than kept as a template literal —
// the source text contains a backtick (`` `ponytail:` ``) that would need
// escaping, and an escaped backtick is exactly the kind of edit that could
// quietly drift from the source over time. Do not paraphrase, reformat, or
// "clean up" any line below; `ponytail-head.test.ts` hashes this content so
// a later edit that changes the wording fails loudly instead of silently.
const PONYTAIL_RULESET_LINES: readonly string[] = [
  "# Ponytail, lazy senior dev mode",
  "",
  "You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.",
  "",
  "Before writing any code, stop at the first rung that holds:",
  "",
  "1. Does this need to be built at all? (YAGNI)",
  "2. Does it already exist in this codebase? Reuse the helper, util, or pattern that's already here, don't re-write it.",
  "3. Does the standard library already do this? Use it.",
  "4. Does a native platform feature cover it? Use it.",
  "5. Does an already-installed dependency solve it? Use it.",
  "6. Can this be one line? Make it one line.",
  "7. Only then: write the minimum code that works.",
  "",
  "The ladder runs after you understand the problem, not instead of it: read the task and the code it touches, trace the real flow end to end, then climb.",
  "",
  "Bug fix = root cause, not symptom: a report names a symptom. Grep every caller of the function you touch and fix the shared function once — one guard there is a smaller diff than one per caller, and patching only the path the ticket names leaves a sibling caller still broken.",
  "",
  "Rules:",
  "",
  "- No abstractions that weren't explicitly requested.",
  "- No new dependency if it can be avoided.",
  "- No boilerplate nobody asked for.",
  "- Deletion over addition. Boring over clever. Fewest files possible.",
  "- Shortest working diff wins, but only once you understand the problem. The smallest change in the wrong place isn't lazy, it's a second bug.",
  '- Question complex requests: "Do you actually need X, or does Y cover it?"',
  "- Pick the edge-case-correct option when two stdlib approaches are the same size, lazy means less code, not the flimsier algorithm.",
  "- Mark deliberate simplifications that cut a real corner with a known ceiling (global lock, O(n²) scan, naive heuristic) with a `ponytail:` comment naming the ceiling and upgrade path.",
  "",
  "Not lazy about: understanding the problem (read it fully and trace the real flow before picking a rung, a small diff you don't understand is just laziness dressed up as efficiency), input validation at trust boundaries, error handling that prevents data loss, security, accessibility, the calibration real hardware needs (the platform is never the spec ideal, a clock drifts, a sensor reads off), anything explicitly requested. Lazy code without its check is unfinished: non-trivial logic leaves ONE runnable check behind, the smallest thing that fails if the logic breaks (an assert-based demo/self-check or one small test file; no frameworks, no fixtures). Trivial one-liners need no test.",
];

/** The ruleset text, verbatim, no heading or attribution wrapper. */
export const PONYTAIL_RULESET_TEXT = PONYTAIL_RULESET_LINES.join("\n");

export const PONYTAIL_SOURCE_URL = "https://github.com/DietrichGebert/ponytail";
export const PONYTAIL_SOURCE_PATH = ".agents/rules/ponytail.md";
export const PONYTAIL_SOURCE_COMMIT = "356918eba965ee1eac64bd3a7f0dd02108350de5";

/** Ticket 03 checkbox: "the shipped ruleset carries its source attribution and MIT licence." */
export const PONYTAIL_ATTRIBUTION =
  `Source: ponytail (${PONYTAIL_SOURCE_URL}), ${PONYTAIL_SOURCE_PATH} @ ${PONYTAIL_SOURCE_COMMIT}. ` +
  "License: MIT, Copyright (c) 2026 DietrichGebert.";

export const PONYTAIL_HEADING = "## lykos-ponytail";

/**
 * The default block: heading, attribution, then the verbatim ladder.
 * Unconditional — unlike every other block in this file's sibling modules
 * (`prompt-diet.ts`'s diet blocks, `memory-head.ts`, `repo-map.ts`), there is
 * no `LYKOS_*=0` env opt-out, because the spec frames this as the default
 * every session gets, with a specialist's `instructions` as the only override
 * (see `resolvePonytailAndSpecialistHeads` below).
 */
export function assemblePonytailHead(): string {
  return [PONYTAIL_HEADING, PONYTAIL_ATTRIBUTION, "", PONYTAIL_RULESET_TEXT].join("\n");
}

// --- Replace vs append ---
//
// Spec: "A specialist can replace that ruleset entirely." ADR-0015 / ticket 02
// close the specialist vocabulary at fifteen fields (`SPECIALIST_FIELD_NAMES` in
// `config/specialists.ts`) — a sixteenth field (e.g. `ponytail_mode`) is exactly
// the kind of widening the spec says to record as an issue rather than build.
// So "replace" is expressed inside the existing `instructions` field: when a
// specialist's `instructions` value's FIRST LINE is exactly this marker, the
// rest of the value becomes the ponytail block's own content instead of a
// separate `## lykos-specialist` block appended after the default ladder.
//
// Default (no marker): APPEND — the ladder above, unmodified, then the
// specialist's instructions as their own block (existing ticket 01 behaviour).
export const PONYTAIL_REPLACE_MARKER = "<!-- lykos:replace-ponytail -->";

export function isPonytailReplacement(instructions: string): boolean {
  return instructions.startsWith(PONYTAIL_REPLACE_MARKER);
}

export interface PonytailAndSpecialistHeads {
  /** Always non-empty: the default ladder, or the specialist's replacement text under the same heading. */
  ponytail: string;
  /** The separate `## lykos-specialist` block. Empty when the specialist's text was consumed as a replacement — nothing is left to append. */
  specialist: string;
  replaced: boolean;
}

/**
 * The single seam `boot.ts` and `head-view.ts` both call, so the two
 * assembly paths (the real session, and the prompt-inspection printer)
 * cannot independently drift on the replace/append decision.
 */
export function resolvePonytailAndSpecialistHeads(instructions?: string): PonytailAndSpecialistHeads {
  if (instructions && isPonytailReplacement(instructions)) {
    const body = instructions.slice(PONYTAIL_REPLACE_MARKER.length).replace(/^\r?\n/, "");
    return { ponytail: [PONYTAIL_HEADING, body].join("\n"), specialist: "", replaced: true };
  }
  return {
    ponytail: assemblePonytailHead(),
    specialist: instructions ? assembleSpecialistHead(instructions) : "",
    replaced: false,
  };
}

/**
 * Resolution for prompt_mode: override (ADR-0021). The ponytail block is omitted
 * and the specialist instructions take its place under the ## lykos-specialist heading.
 * When instructions begin with PONYTAIL_REPLACE_MARKER, compatibility behaviour
 * is preserved (the marker text replaces the ponytail block's content).
 */
export function resolveSpecialistOverrideHeads(instructions?: string): PonytailAndSpecialistHeads {
  if (instructions && isPonytailReplacement(instructions)) {
    return resolvePonytailAndSpecialistHeads(instructions);
  }
  return {
    ponytail: "",
    specialist: instructions ? assembleSpecialistHead(instructions) : "",
    replaced: true,
  };
}

