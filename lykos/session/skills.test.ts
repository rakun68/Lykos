import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import {
  capSkills,
  discoverSkillNames,
  discoverSkills,
  ensureSkillsDir,
  filterSkillsByRoster,
  formatSkillsBlockText,
  listSkillFiles,
  lykosSkillsDir,
  newSkillInvocationState,
  observeSkillRead,
  resolveLoadedSkills,
  resolveSkillsPolicy,
  skillsCapNotice,
  skillsHeadCost,
  SKILLS_HEADING,
  type SkillLike,
} from "./skills.js";

const skill = (name: string, filePath = `/repo/.lykos/skills/${name}.md`): SkillLike => ({
  name,
  description: `does ${name}`,
  filePath,
});

/** Writes a real skill file under `.lykos/skills/` and returns its name. */
function writeSkill(dir: string, filename: string, frontmatter: string): string {
  const skillsDir = join(dir, ".lykos", "skills");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, filename), frontmatter, "utf8");
  return filename;
}

describe("lykosSkillsDir", () => {
  it("is .lykos/skills and never .pi/skills (rule 6)", () => {
    assert.equal(lykosSkillsDir("/repo"), join("/repo", ".lykos", "skills"));
  });
});

describe("resolveSkillsPolicy", () => {
  it("passes no path at all when the project has no skills directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      // Passing a non-existent directory would make Pi emit a diagnostic on
      // every boot for a state that is simply the default.
      assert.deepEqual(resolveSkillsPolicy(dir).paths, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes the directory once it exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      mkdirSync(join(dir, ".lykos", "skills"), { recursive: true });
      assert.deepEqual(resolveSkillsPolicy(dir).paths, [join(dir, ".lykos", "skills")]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes nothing when skills are switched off, even if the directory exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      mkdirSync(join(dir, ".lykos", "skills"), { recursive: true });
      assert.deepEqual(resolveSkillsPolicy(dir, { enabled: false }).paths, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("has no cap unless one is configured, and a configured cap is never zero (ADR-0029)", () => {
    assert.equal(resolveSkillsPolicy("/nowhere").max, undefined);
    assert.equal(resolveSkillsPolicy("/nowhere", { max: 5 }).max, 5);
    assert.equal(resolveSkillsPolicy("/nowhere", { max: 0 }).max, 1);
  });
});

describe("capSkills", () => {
  it("keeps every skill when there is no cap (ADR-0029)", () => {
    // P4 demo run 2, 2026-10-05: the old default of 12 dropped 18 of 30
    // skills, the project's own `finishing-work` among them, because global
    // skills are discovered first.
    const all = Array.from({ length: 30 }, (_, i) => skill(`s${i}`));
    const uncapped = capSkills(all, undefined);
    assert.equal(uncapped.kept.length, 30);
    assert.equal(uncapped.dropped.length, 0);
    assert.equal(skillsCapNotice(uncapped, undefined), undefined);
  });

  it("keeps discovery order so the surviving roster is predictable", () => {
    const all = [skill("a"), skill("b"), skill("c")];
    const capped = capSkills(all, 2);
    assert.deepEqual(capped.kept.map((s) => s.name), ["a", "b"]);
    assert.deepEqual(capped.dropped.map((s) => s.name), ["c"]);
  });

  it("drops nothing when the roster fits", () => {
    assert.equal(capSkills([skill("a")], 12).dropped.length, 0);
  });
});

describe("skillsCapNotice", () => {
  it("says nothing when nothing was dropped", () => {
    assert.equal(skillsCapNotice(capSkills([skill("a")], 12), 12), undefined);
  });

  it("names every dropped skill — a skill silently not loaded is worse than none", () => {
    const notice = skillsCapNotice(capSkills([skill("a"), skill("b")], 1), 1);
    assert.match(String(notice), /were NOT loaded: b/);
    assert.match(String(notice), /skills\.max/);
  });
});

describe("skillsHeadCost", () => {
  it("is zero for an empty roster", () => {
    assert.equal(skillsHeadCost([]), 0);
  });

  it("grows with the roster, because every name and description rides every request", () => {
    const one = skillsHeadCost([skill("a")]);
    const three = skillsHeadCost([skill("a"), skill("b"), skill("c")]);
    assert.ok(one > 0);
    assert.ok(three > one);
  });
});

describe("observeSkillRead", () => {
  const roster = [skill("code-search"), skill("verify-before-done")];

  it("counts a read of a skill file as an invocation", () => {
    const state = newSkillInvocationState();
    const name = observeSkillRead(state, "/repo/.lykos/skills/code-search.md", roster);
    assert.equal(name, "code-search");
    assert.deepEqual(state.invoked, ["code-search"]);
    assert.equal(state.reads, 1);
  });

  it("counts a re-read but does not list the skill twice", () => {
    const state = newSkillInvocationState();
    observeSkillRead(state, "/repo/.lykos/skills/code-search.md", roster);
    observeSkillRead(state, "/repo/.lykos/skills/code-search.md", roster);
    assert.equal(state.reads, 2);
    assert.deepEqual(state.invoked, ["code-search"]);
  });

  it("ignores a read of anything that is not a skill file", () => {
    const state = newSkillInvocationState();
    assert.equal(observeSkillRead(state, "/repo/lykos/session/session.ts", roster), undefined);
    // Notably including the skills DIRECTORY itself: listing it is not using
    // a skill, and counting it would inflate the rate §2.5 asks for.
    assert.equal(observeSkillRead(state, "/repo/.lykos/skills", roster), undefined);
    assert.equal(state.reads, 0);
  });

  it("matches the same file spelled differently", () => {
    const state = newSkillInvocationState();
    const abs = resolve("/repo/.lykos/skills/code-search.md");
    assert.equal(observeSkillRead(state, abs, roster), "code-search");
  });

  it("ignores an empty or missing path rather than throwing", () => {
    const state = newSkillInvocationState();
    assert.equal(observeSkillRead(state, undefined, roster), undefined);
    assert.equal(observeSkillRead(state, "", roster), undefined);
  });
});

describe("resolveSkillsPolicy roster (specialists ticket 02)", () => {
  it("passes the roster through unset when the config does not declare one", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      assert.equal(resolveSkillsPolicy(dir).roster, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes a declared roster through", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      assert.deepEqual(resolveSkillsPolicy(dir, { roster: ["reviewer"] }).roster, ["reviewer"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("filterSkillsByRoster (specialists ticket 02/05)", () => {
  const all = [skill("reviewer"), skill("code-search"), skill("explore")];

  it("with no roster, every skill stays a candidate", () => {
    assert.deepEqual(filterSkillsByRoster(all, undefined), all);
  });

  it("with a roster, only the named skills survive, in their original order", () => {
    assert.deepEqual(
      filterSkillsByRoster(all, ["explore", "reviewer"]).map((s) => s.name),
      ["reviewer", "explore"],
    );
  });

  it("an empty roster loads none", () => {
    assert.deepEqual(filterSkillsByRoster(all, []), []);
  });

  it("a roster naming a skill that is not present simply yields fewer results here — missing-skill reporting is ticket 05's job", () => {
    assert.deepEqual(filterSkillsByRoster(all, ["reviewer", "does-not-exist"]).map((s) => s.name), ["reviewer"]);
  });
});

describe("discoverSkills / discoverSkillNames (specialists ticket 05)", () => {
  it("returns no skills when there is no .lykos/skills directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      assert.deepEqual(discoverSkillNames(dir), []);
      assert.deepEqual(discoverSkills(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("derives a skill's name from its frontmatter name, NOT the .md basename — matching Pi's loader", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      writeSkill(dir, "a.md", "---\nname: alpha\ndescription: does alpha\n---\n# body\n");
      // The file is `a.md`, but the loader names it `alpha` — a roster must
      // reference `alpha`, and a reference to `a` would be a missing skill.
      assert.deepEqual(discoverSkillNames(dir), ["alpha"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to the parent directory name when a direct .md has no frontmatter name — again matching Pi", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      writeSkill(dir, "no-name.md", "---\ndescription: has a description but no name\n---\n# body\n");
      // Pi derives `parentDirName` (= "skills") for a direct child with no
      // frontmatter name, so every such file collides to "skills" and the
      // loader dedupes to one.
      assert.deepEqual(discoverSkillNames(dir), ["skills"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores non-markdown files in the skills directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      const skillsDir = join(dir, ".lykos", "skills");
      mkdirSync(skillsDir, { recursive: true });
      writeFileSync(join(skillsDir, "notes.txt"), "not a skill", "utf8");
      assert.deepEqual(discoverSkillNames(dir), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveLoadedSkills (specialists ticket 05)", () => {
  it("a roster loads exactly those skills and no others", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      writeSkill(dir, "reviewer.md", "---\nname: reviewer\ndescription: review only\n---\n# review\n");
      writeSkill(dir, "explore.md", "---\nname: explore\ndescription: read only\n---\n# explore\n");
      const loaded = resolveLoadedSkills(dir, { roster: ["reviewer"] });
      assert.deepEqual(loaded.map((s) => s.name), ["reviewer"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a specialist declaring no skills loads none", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      writeSkill(dir, "reviewer.md", "---\nname: reviewer\ndescription: review only\n---\n# review\n");
      assert.deepEqual(resolveLoadedSkills(dir, { roster: [] }), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no roster keeps every discovered skill (the pre-specialist default)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      writeSkill(dir, "reviewer.md", "---\nname: reviewer\ndescription: review only\n---\n# review\n");
      writeSkill(dir, "explore.md", "---\nname: explore\ndescription: read only\n---\n# explore\n");
      const loaded = resolveLoadedSkills(dir, undefined);
      assert.deepEqual(loaded.map((s) => s.name).sort(), ["explore", "reviewer"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the same skill referenced by two specialists loads once, without duplication", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      writeSkill(dir, "reviewer.md", "---\nname: reviewer\ndescription: review only\n---\n# review\n");
      // Two specialists each declaring the same skill resolve to the same single
      // entry — the roster is a set, and the loader dedupes by name.
      const first = resolveLoadedSkills(dir, { roster: ["reviewer"] });
      const second = resolveLoadedSkills(dir, { roster: ["reviewer"] });
      assert.deepEqual(first, second);
      assert.equal(first.length, 1);
      // A roster that names the same skill twice still loads it once.
      assert.deepEqual(resolveLoadedSkills(dir, { roster: ["reviewer", "reviewer"] }).map((s) => s.name), ["reviewer"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("formatSkillsBlockText (specialists ticket 05)", () => {
  it("is empty for an empty roster", () => {
    assert.equal(formatSkillsBlockText([]), "");
  });

  it("reproduces Pi's <available_skills> XML with name, description and location", () => {
    const text = formatSkillsBlockText([skill("reviewer", "/repo/.lykos/skills/reviewer.md")]);
    assert.ok(text.includes("<available_skills>"));
    assert.ok(text.includes("<name>reviewer</name>"));
    assert.ok(text.includes("<description>does reviewer</description>"));
    assert.ok(text.includes("<location>/repo/.lykos/skills/reviewer.md</location>"));
  });

  it("escapes XML metacharacters exactly as Pi's formatSkillsForPrompt does", () => {
    const text = formatSkillsBlockText([skill("a<b>&c", "/repo/x.md")]);
    assert.ok(text.includes("<name>a&lt;b&gt;&amp;c</name>"));
    assert.ok(!text.includes("<name>a<b>&c</name>"));
  });

  it("hides a disable-model-invocation skill, exactly as Pi's formatSkillsForPrompt does", () => {
    const visible = skill("reviewer");
    const hidden = { ...skill("internal"), disableModelInvocation: true };
    const text = formatSkillsBlockText([visible, hidden]);
    assert.ok(text.includes("<name>reviewer</name>"));
    assert.ok(!text.includes("<name>internal</name>"));
    // A roster of only disable-model-invocation skills produces an empty block.
    assert.equal(formatSkillsBlockText([hidden]), "");
  });

  it("exposes the block heading the prompt inspection renders", () => {
    assert.equal(SKILLS_HEADING, "## lykos-skills");
  });
});

describe("ensureSkillsDir / listSkillFiles", () => {
  it("creates the directory and lists what is in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-skills-"));
    try {
      assert.deepEqual(listSkillFiles(dir), []);
      const created = ensureSkillsDir(dir);
      writeFileSync(join(created, "code-search.md"), "# skill", "utf8");
      writeFileSync(join(created, "notes.txt"), "not a skill", "utf8");
      assert.deepEqual(listSkillFiles(dir), ["code-search.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
