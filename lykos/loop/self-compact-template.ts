// P17 T189 — the fixed template for the `self_compact` note: Goal /
// Constraints / Progress / Key Decisions / Critical Context / Next Steps.
//
// This file is where the section names and the full handoff prompt live.
// `self-compact.ts` builds its warning, cutoff and command prompts from
// `SELF_COMPACT_SECTION_LIST`, and the extension builds the tool's note
// description from it. `ledger/tool-catalog.ts` imports nothing, so it carries
// a literal copy; `lykos-self-compact.test.ts` asserts the copy is the live
// text. T190's side call loads `SELF_COMPACT_HANDOFF_PROMPT` as it is.
//
// A note that leaves sections out is still saved and returned. This file only
// reports which ones it left out, so the handoff record can say.

/** The note's sections, in order. Each is a `##` heading in the template. */
export const SELF_COMPACT_SECTIONS = [
  "Goal",
  "Constraints & Preferences",
  "Progress",
  "Key Decisions",
  "Critical Context",
  "Next Steps",
] as const;

export type SelfCompactSection = (typeof SELF_COMPACT_SECTIONS)[number];

/** The sections as one phrase for guidance: "Goal; Constraints & Preferences; …". */
export const SELF_COMPACT_SECTION_LIST = SELF_COMPACT_SECTIONS.join("; ");

/** The structure a note is written in. Bracketed text is what the writer fills. */
export const SELF_COMPACT_TEMPLATE = `## Goal
[What the person is trying to accomplish]

## Constraints & Preferences
- [Constraints, preferences or requirements given]

## Progress
### Done
- [x] [Completed work, with specifics]

### In Progress
- [ ] [Current work, if any]

### Pending
- [ ] [Work mentioned but not started]

## Key Decisions
- **[Decision]**: [Why]

## Critical Context
- [File paths, symbol names, commands run, test results, error messages, repository state: exact, not abstract]

## Next Steps
1. [What to do first]`;

/** The instruction blocks, which frame the skeleton for a model asked to write the note. */
export const SELF_COMPACT_INSTRUCTIONS = `<critical>
Write a handoff document for another instance of yourself.
The handoff MUST be sufficient for seamless continuation without access to this conversation.
Output ONLY the handoff document. No preamble, no commentary, no wrapper text.
</critical>

<instruction>
Capture exact technical state, not abstractions.
- File paths, symbol names, commands run
- Test results, observed failures
- Decisions made
- Partial work affecting the next step
Register: address the successor directly in the imperative ("Fix X", "Run Y"), never first person ("I need to...", "my attempt...").
The handoff mechanism is invisible to the document: NEVER list writing, generating, or delivering a handoff/summary/context document as progress or a next step. Progress and Next Steps cover the user's task only.
</instruction>`;

/** The whole prompt for a call that writes the note: instructions, then the structure to use exactly. */
export const SELF_COMPACT_HANDOFF_PROMPT = `${SELF_COMPACT_INSTRUCTIONS}

<output>
Use exactly this structure:

${SELF_COMPACT_TEMPLATE}
</output>`;

/**
 * The sections of the template that no heading in `note` names. A heading
 * counts when its text is exactly a section's name; case and heading level
 * (`#` to `######`) are ignored, and prose that merely mentions a section does not count.
 */
export function missingNoteSections(note: string): SelfCompactSection[] {
  const named = new Set<string>();
  for (const line of note.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m !== null) named.add(m[1]!.toLowerCase());
  }
  return SELF_COMPACT_SECTIONS.filter((s) => !named.has(s.toLowerCase()));
}
