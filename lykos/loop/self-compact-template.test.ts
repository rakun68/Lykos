// T189: the self_compact note's fixed template and the check for what a note
// leaves out. The check reports; it never refuses (the extension saves a
// note missing sections, tested in `lykos-self-compact.test.ts`).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_COMMAND_PROMPT, DEFAULT_CUTOFF_PROMPT, DEFAULT_WARNING_PROMPT } from "./self-compact.js";
import {
  SELF_COMPACT_HANDOFF_PROMPT,
  SELF_COMPACT_SECTIONS,
  SELF_COMPACT_TEMPLATE,
  missingNoteSections,
} from "./self-compact-template.js";

describe("self-compact note template (T189)", () => {
  it("names the six sections of the handoff, in order, and the template carries each as a heading", () => {
    assert.deepEqual(
      [...SELF_COMPACT_SECTIONS],
      ["Goal", "Constraints & Preferences", "Progress", "Key Decisions", "Critical Context", "Next Steps"],
    );
    for (const s of SELF_COMPACT_SECTIONS) assert.match(SELF_COMPACT_TEMPLATE, new RegExp(`^## ${s}$`, "m"));
  });

  it("the handoff prompt is the instructions plus the skeleton, whole", () => {
    assert.match(SELF_COMPACT_HANDOFF_PROMPT, /Output ONLY the handoff document/);
    assert.match(SELF_COMPACT_HANDOFF_PROMPT, /address the successor directly in the imperative/);
    assert.match(SELF_COMPACT_HANDOFF_PROMPT, /NEVER list writing, generating, or delivering a handoff/);
    assert.ok(SELF_COMPACT_HANDOFF_PROMPT.endsWith(`${SELF_COMPACT_TEMPLATE}\n</output>`));
  });

  it("T189: every prompt the agent receives to write a note names every section", () => {
    for (const [name, text] of Object.entries({
      warning: DEFAULT_WARNING_PROMPT,
      cutoff: DEFAULT_CUTOFF_PROMPT,
      command: DEFAULT_COMMAND_PROMPT,
    })) {
      for (const s of SELF_COMPACT_SECTIONS) assert.ok(text.includes(s), `${name} prompt names ${s}`);
      assert.doesNotMatch(text, /what the task is, what is done/, `${name} prompt has no competing recipe`);
    }
  });

  it("a note built from the template misses nothing", () => {
    assert.deepEqual(missingNoteSections(SELF_COMPACT_TEMPLATE), []);
  });

  it("names the missing sections, matching headings by name, case and heading level aside", () => {
    const note = "## Goal\nfix it\n\n### progress\n- done\n\n# NEXT STEPS\n1. run tests\n";
    assert.deepEqual(missingNoteSections(note), ["Constraints & Preferences", "Key Decisions", "Critical Context"]);
  });

  it("a free-form note with no headings misses all of them; a section named only in prose does not count", () => {
    assert.deepEqual(missingNoteSections("The goal is X. Next steps: Y."), [...SELF_COMPACT_SECTIONS]);
  });
});
