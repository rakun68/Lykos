import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  extractSteps,
  formatPlanAgainstSkillBlock,
  PLAN_AGAINST_SKILL_HEADING,
} from "./plan-against-skill.js";
import type { SkillLike } from "./skills.js";

function repoFile(...parts: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", ...parts);
}

const skill = (name: string, filePath = `/repo/.lykos/skills/${name}.md`): SkillLike => ({
  name,
  description: `does ${name}`,
  filePath,
});

describe("extractSteps", () => {
  it("collects a numbered list in document order, stripping inline bold", () => {
    const steps = extractSteps("1. **Run the check.** It ran already.\n2. **Mark it done.** Then commit.\n");
    assert.deepEqual(steps, ["Run the check. It ran already.", "Mark it done. Then commit."]);
  });

  it("collects checkbox items — the checklist form the spec names", () => {
    const steps = extractSteps("- [ ] open the diff\n- [x] run the suite\n");
    assert.deepEqual(steps, ["open the diff", "run the suite"]);
  });

  it("falls back to ##-level headings when there is no numbered or checkbox list", () => {
    const steps = extractSteps("# LSP navigation\n\n## Check availability\n\n## Query a project\n");
    assert.deepEqual(steps, ["Check availability", "Query a project"]);
  });

  it("skips the title (#) and never treats it as a step", () => {
    assert.deepEqual(extractSteps("# Finishing work\n"), []);
  });

  it("skips numbered lines inside fenced code blocks", () => {
    const steps = extractSteps("## Run it\n\n```bash\n1. this is code\n2. not a step\n```\n");
    assert.deepEqual(steps, ["Run it"]);
  });

  it("strips inline code and links so a step reads as prose", () => {
    const steps = extractSteps("1. Change them with the `edit` tool [one at a time](docs).\n");
    assert.deepEqual(steps, ["Change them with the edit tool one at a time."]);
  });

  it("returns nothing for an empty body", () => {
    assert.deepEqual(extractSteps(""), []);
  });
});

describe("formatPlanAgainstSkillBlock", () => {
  it("is empty when no skills are loaded — the no-extra-output invariant", () => {
    assert.equal(formatPlanAgainstSkillBlock([]), "");
  });

  it("is empty when the only loaded skills are hidden from the model", () => {
    const hidden = { ...skill("internal"), disableModelInvocation: true };
    assert.equal(formatPlanAgainstSkillBlock([hidden]), "");
  });

  it("names each skill and its extracted steps, and states the plan/correction contract", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-plan-"));
    try {
      const skillsDir = join(dir, ".lykos", "skills");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, "reviewer.md"),
        "---\nname: reviewer\ndescription: review only\n---\n# Review\n\n1. **Read the diff.**\n2. **Report findings.**\n",
        "utf8",
      );
      const text = formatPlanAgainstSkillBlock([
        { name: "reviewer", description: "review only", filePath: join(skillsDir, "reviewer.md") },
      ]);
      assert.ok(text.startsWith(PLAN_AGAINST_SKILL_HEADING));
      assert.ok(text.includes("reviewer"), "the presentation names the skill");
      assert.ok(text.includes("Read the diff."), "the skill's steps are in the block");
      assert.ok(text.includes("Report findings."));
      assert.match(text, /deviat/, "a deviation must be called a deviation");
      assert.match(text, /correct/, "a human correction must be adopted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the shipped skill and extracts a non-empty step list from it", () => {
    // T141 deleted the other two shipped skills (lsp-navigation,
    // structural-search); the heading fallback they exercised is pinned below.
    const skills: SkillLike[] = [
      { name: "finishing-work", description: "finishing-work", filePath: repoFile(".lykos", "skills", "finishing-work.md") },
    ];
    const text = formatPlanAgainstSkillBlock(skills);
    assert.ok(text.includes("finishing-work"), "the block must name finishing-work");
    assert.match(text, /Run the project's own check\./, "finishing-work's numbered steps are extracted");
  });

  it("falls back to ## headings when a skill has no numbered or checkbox steps", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-plan-"));
    try {
      const skillsDir = join(dir, ".lykos", "skills");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(
        join(skillsDir, "headed.md"),
        "---\nname: headed\ndescription: headings only\n---\n# Title\n\n## Check availability\n\nprose\n\n## Query it\n\nprose\n",
        "utf8",
      );
      const text = formatPlanAgainstSkillBlock([
        { name: "headed", description: "headings only", filePath: join(skillsDir, "headed.md") },
      ]);
      assert.match(text, /Check availability/);
      assert.match(text, /Query it/);
      assert.doesNotMatch(text, /Title/, "the # title is skipped");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic — two formats of the same skills are byte-identical", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-plan-"));
    try {
      const skillsDir = join(dir, ".lykos", "skills");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, "a.md"), "---\nname: a\ndescription: a skill\n---\n1. one\n2. two\n", "utf8");
      const s = { name: "a", description: "a skill", filePath: join(skillsDir, "a.md") };
      assert.equal(formatPlanAgainstSkillBlock([s]), formatPlanAgainstSkillBlock([s]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
