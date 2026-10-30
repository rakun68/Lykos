import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buildHeadView } from "./head-view.js";
import { piHostDir } from "../config/pi-host.js";
import { assembleBootHead, assembleIdentityHead, HeadContract, IDENTITY_HEADING } from "./head-contract.js";
import { assembleDietHead, assembleOutputDietHead, DIET_HEADING, OUTPUT_DIET_HEADING } from "../loop/prompt-diet.js";
import { BOOT_HEADING } from "./head-contract.js";
import { resolveSessionTools } from "../tools.js";
import { MEMORY_HEADING } from "./memory-head.js";
import { REPO_MAP_HEADING } from "../context/repo-map.js";
import { assembleSpecialistHead, SPECIALIST_HEADING } from "./specialist-head.js";
import { assemblePonytailHead, PONYTAIL_ATTRIBUTION, PONYTAIL_HEADING, PONYTAIL_REPLACE_MARKER } from "./ponytail-head.js";
import { SKILLS_HEADING } from "./skills.js";
import { PLAN_AGAINST_SKILL_HEADING } from "./plan-against-skill.js";
import { assembleMountedCatalogHead, MOUNTED_CATALOG_HEADING } from "./mounted-catalog-head.js";
import { OUTPUT_STYLE_HEADING, assembleOutputStyleHead } from "../config/output-styles.js";

const HEAD = "deadbeefcafebabe0000000000000000deadbeef";

function repoFile(...parts: string[]): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", ...parts);
}

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-head-view-"));
  writeFileSync(join(dir, "CLAUDE.md"), "# project rules\nbe brief.\n", "utf8");
  return dir;
}

/** A clean env: neither diet flag set, so both blocks are on, as in production. */
const ENV: NodeJS.ProcessEnv = {};

describe("buildHeadView — the environment is the host session's (ADR-0036, #47)", () => {
  it("reports the workspace, this platform, and the pi-host agent dir a session boots with", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      assert.equal(view.environment.cwd, dir);
      assert.equal(view.environment.platform, process.platform);
      assert.equal(view.environment.project, basename(dir));
      assert.equal(view.environment.agentDir, piHostDir(ENV));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads memory from the state root, as boot() does, when cwd is a worktree", () => {
    const worktree = tempProject();
    const stateRoot = tempProject();
    try {
      mkdirSync(join(stateRoot, ".lykos", "memory"), { recursive: true });
      writeFileSync(join(stateRoot, ".lykos", "memory", "gotchas.md"), "- [aaaaaaaa] kept at the state root\n", "utf8");
      const view = buildHeadView({ cwd: worktree, stateRoot, env: ENV, gitHead: HEAD, memory: { enabled: true, scope: ["project"] } });
      const memoryBlock = view.blocks.find((b) => b.heading === MEMORY_HEADING);
      assert.equal(memoryBlock?.enabled, true);
      assert.match(memoryBlock?.text ?? "", /kept at the state root/);
      assert.equal(view.environment.cwd, worktree, "the environment is still the worktree's");
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });
});

describe("buildHeadView — blocks are what the session gets, in assembly order", () => {
  it("lists lykos-head, lykos-identity, lykos-diet, lykos-output-diet in assembly order", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      assert.deepEqual(
        view.blocks.map((b) => b.heading),
        [BOOT_HEADING, IDENTITY_HEADING, DIET_HEADING, OUTPUT_DIET_HEADING, MOUNTED_CATALOG_HEADING, MEMORY_HEADING, PONYTAIL_HEADING, SKILLS_HEADING, PLAN_AGAINST_SKILL_HEADING, SPECIALIST_HEADING, OUTPUT_STYLE_HEADING, REPO_MAP_HEADING],
      );
      const memoryBlock = view.blocks.find((b) => b.heading === MEMORY_HEADING);
      assert.equal(memoryBlock?.enabled, false, "a workspace with no memory entries injects none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints the blocks verbatim rather than a paraphrase", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const [boot, identity, diet, output] = view.blocks;
      assert.equal(
        boot?.text,
        assembleBootHead({
          cwd: dir,
          platform: process.platform,
          project: basename(dir),
          gitHeadAtBoot: HEAD,
          toolNames: resolveSessionTools(),
        }),
      );
      assert.equal(identity?.text, assembleIdentityHead());
      assert.equal(diet?.text, assembleDietHead());
      assert.equal(output?.text, assembleOutputDietHead());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("marks a flagged-off block disabled and excludes it from the head token total", () => {
    const dir = tempProject();
    try {
      const on = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const off = buildHeadView({ cwd: dir, env: { LYKOS_OUTPUT_DIET: "0" }, gitHead: HEAD });
      const offBlock = off.blocks.find((b) => b.heading === OUTPUT_DIET_HEADING);
      assert.equal(offBlock?.enabled, false);
      assert.equal(offBlock?.flag, "LYKOS_OUTPUT_DIET=0");
      assert.equal(off.totals.headTokens, on.totals.headTokens - (offBlock?.tokens ?? 0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("drops context files entirely when the prompt diet is off, matching agentsFilesOverride", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: { LYKOS_PROMPT_DIET: "0" }, gitHead: HEAD });
      assert.equal(view.contextFilesEnabled, false);
      assert.deepEqual(view.contextFiles, []);
      assert.equal(view.totals.contextTokens, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildHeadView — context files", () => {
  it("lists an in-workspace file at its own path and counts it", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const claude = view.contextFiles.find((f) => f.name === "CLAUDE.md");
      assert.ok(claude, "CLAUDE.md should be ingested");
      assert.equal(claude.path, join(dir, "CLAUDE.md"));
      assert.ok(view.totals.contextTokens > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lists and counts an ancestor file, which a host session reads like any other", () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-head-view-outer-"));
    try {
      writeFileSync(join(root, "AGENTS.md"), "# ancestor rules\n", "utf8");
      const inner = join(root, "project");
      mkdirSync(inner);
      writeFileSync(join(inner, "CLAUDE.md"), "# inner\n", "utf8");
      const view = buildHeadView({ cwd: inner, env: ENV, gitHead: HEAD });
      assert.ok(view.contextFiles.some((f) => f.name === "AGENTS.md"));
      assert.equal(
        view.totals.contextTokens,
        view.contextFiles.reduce((n, f) => n + f.tokens, 0),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("buildHeadView — fingerprint and tool surface (T28.2, T28.4)", () => {
  it("the boot fingerprint is byte-identical to HeadContract.boot()'s", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const { fingerprint } = new HeadContract().boot({
        cwd: dir,
        platform: process.platform,
        project: basename(dir),
        gitHeadAtBoot: HEAD,
        toolNames: resolveSessionTools(),
      });
      assert.equal(view.fingerprints.bootHead, fingerprint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the scope difference rather than claiming the ledger value should match", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      assert.match(view.fingerprints.note, /prefix_fingerprint/);
      assert.match(view.fingerprints.note, /not (readable|reproducible)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds no tool: the measured surface is exactly the hop-0 allowlist", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      assert.deepEqual(view.toolset.names, resolveSessionTools());
      assert.equal(view.toolset.complete, true);
      assert.equal(view.totals.total, view.totals.headTokens + view.totals.contextTokens + (view.toolset.tokens ?? 0));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is deterministic — two views of the same frozen inputs are identical", () => {
    const dir = tempProject();
    try {
      const a = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const b = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      assert.deepEqual(a, b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildHeadView — specialists ticket 01: the specialist instructions block", () => {
  it("is listed but disabled when no specialist instructions are in the resolved config — ponytail is still on", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const block = view.blocks.find((b) => b.heading === SPECIALIST_HEADING);
      assert.equal(block?.enabled, false);
      assert.equal(block?.text, "");
      assert.equal(block?.tokens, 0);
      const ponytail = view.blocks.find((b) => b.heading === PONYTAIL_HEADING);
      assert.equal(ponytail?.enabled, true);
      assert.ok(ponytail!.tokens > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prints the specialist block verbatim, after ponytail, with a real token count", () => {
    const dir = tempProject();
    try {
      const instructions = "Prefer the smallest correct change.";
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD, specialistInstructions: instructions });
      // T148: the repo map block is listed after it, because the extension appends last.
      const block = view.blocks.find((b) => b.heading === SPECIALIST_HEADING);
      assert.equal(block?.enabled, true);
      assert.equal(block?.text, assembleSpecialistHead(instructions));
      assert.ok(block!.tokens > 0);
      const ponytail = view.blocks.find((b) => b.heading === PONYTAIL_HEADING);
      assert.equal(ponytail?.text, assemblePonytailHead());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildHeadView — specialists ticket 03: the ponytail block", () => {
  it("carries its source attribution and MIT licence, and a real token count, by default", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const block = view.blocks.find((b) => b.heading === PONYTAIL_HEADING);
      assert.equal(block?.enabled, true);
      assert.ok(block!.text.includes(PONYTAIL_ATTRIBUTION));
      assert.ok(block!.text.includes("MIT"));
      assert.ok(block!.tokens > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a specialist can replace the ponytail block entirely — its own text stands in, and the specialist block goes empty", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({
        cwd: dir,
        env: ENV,
        gitHead: HEAD,
        specialistInstructions: `${PONYTAIL_REPLACE_MARKER}\nDeliberate fully; weigh alternatives before committing.`,
      });
      const ponytail = view.blocks.find((b) => b.heading === PONYTAIL_HEADING);
      const specialist = view.blocks.find((b) => b.heading === SPECIALIST_HEADING);
      assert.equal(ponytail?.text, "## lykos-ponytail\nDeliberate fully; weigh alternatives before committing.");
      assert.equal(ponytail?.text.includes("Does this need to be built at all?"), false);
      assert.equal(specialist?.enabled, false);
      assert.equal(specialist?.text, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildHeadView — specialists ticket 05: the loaded-skills block", () => {
  function writeSkill(dir: string, filename: string, frontmatter: string): void {
    mkdirSync(join(dir, ".lykos", "skills"), { recursive: true });
    writeFileSync(join(dir, ".lykos", "skills", filename), frontmatter, "utf8");
  }

  it("shows the active specialist's loaded skills, naming each", () => {
    const dir = tempProject();
    try {
      writeSkill(dir, "reviewer.md", "---\nname: reviewer\ndescription: review only\n---\n# review\n");
      writeSkill(dir, "explore.md", "---\nname: explore\ndescription: read only\n---\n# explore\n");
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD, skills: { roster: ["reviewer"] } });
      const block = view.blocks.find((b) => b.heading === SKILLS_HEADING);
      assert.equal(block?.enabled, true);
      assert.match(block?.note ?? "", /1 skill\(s\) loaded/);
      assert.match(block?.note ?? "", /reviewer/);
      assert.ok(block!.text.includes("<name>reviewer</name>"));
      assert.ok(!block!.text.includes("<name>explore</name>"), "a specialist must load exactly its roster, nothing else");
      assert.ok(block!.tokens > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports no skills loaded when the specialist declares none, even when skills exist on disk", () => {
    const dir = tempProject();
    try {
      writeSkill(dir, "reviewer.md", "---\nname: reviewer\ndescription: review only\n---\n# review\n");
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD, skills: { roster: [] } });
      const block = view.blocks.find((b) => b.heading === SKILLS_HEADING);
      assert.equal(block?.enabled, false);
      assert.equal(block?.text, "");
      assert.match(block?.note ?? "", /no skills loaded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildHeadView — specialists ticket 06: the plan-against-skill block", () => {
  function writeSkill(dir: string, filename: string, body: string): void {
    mkdirSync(join(dir, ".lykos", "skills"), { recursive: true });
    writeFileSync(join(dir, ".lykos", "skills", filename), body, "utf8");
  }

  const reviewBody =
    "---\nname: reviewer\ndescription: review only\n---\n# Review\n\n" +
    "1. **Read the diff.** Understand every file it touches.\n" +
    "2. **Report findings.** Never fix them silently.\n";

  it("shows plan guidance and the loaded skill's extracted steps", () => {
    const dir = tempProject();
    try {
      writeSkill(dir, "reviewer.md", reviewBody);
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD, skills: { roster: ["reviewer"] } });
      const block = view.blocks.find((b) => b.heading === PLAN_AGAINST_SKILL_HEADING);
      assert.equal(block?.enabled, true);
      assert.match(block?.note ?? "", /reviewer/);
      assert.ok(block!.text.includes("reviewer"), "the presentation names the skill");
      assert.ok(block!.text.includes("Read the diff."), "steps are extracted from the skill body");
      assert.ok(block!.text.includes("Report findings."));
      assert.match(block!.text, /deviat/, "a deviation is called a deviation");
      assert.match(block!.text, /correct/, "the human can correct the approach");
      assert.ok(block!.tokens > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is empty and disabled when no skills are loaded — no extra output, no extra prompt", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const block = view.blocks.find((b) => b.heading === PLAN_AGAINST_SKILL_HEADING);
      assert.equal(block?.enabled, false);
      assert.equal(block?.text, "");
      assert.equal(block?.tokens, 0);
      assert.match(block?.note ?? "", /no skills loaded/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildHeadView — P10.2 mounted catalog block", () => {
  it("lists the catalog after the diet blocks, with a measured token count", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const headings = view.blocks.map((b) => b.heading);
      assert.equal(headings.indexOf(MOUNTED_CATALOG_HEADING), headings.indexOf(OUTPUT_DIET_HEADING) + 1);
      const block = view.blocks.find((b) => b.heading === MOUNTED_CATALOG_HEADING);
      assert.equal(block?.text, assembleMountedCatalogHead());
      assert.equal(block?.enabled, true);
      assert.ok((block?.tokens ?? 0) > 0);
      assert.ok(block!.text.includes("- agent:"));
      assert.equal(block!.text.includes("- find:"), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildHeadView — T217 output style block", () => {
  it("defaults to disabled when output style is default or empty", () => {
    const dir = tempProject();
    try {
      const view = buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD });
      const block = view.blocks.find((b) => b.heading === OUTPUT_STYLE_HEADING);
      assert.ok(block);
      assert.equal(block.enabled, false);
      assert.equal(block.text, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enables the block immediately after specialist heading when style text is provided", () => {
    const dir = tempProject();
    try {
      const styleText = "Be brief. One line per thought.";
      const view = buildHeadView({
        cwd: dir,
        env: ENV,
        gitHead: HEAD,
        outputStyleName: "minimal",
        outputStyleText: styleText,
      });
      const headings = view.blocks.map((b) => b.heading);
      assert.equal(headings.indexOf(OUTPUT_STYLE_HEADING), headings.indexOf(SPECIALIST_HEADING) + 1);

      const block = view.blocks.find((b) => b.heading === OUTPUT_STYLE_HEADING);
      assert.ok(block);
      assert.equal(block.enabled, true);
      assert.equal(block.text, assembleOutputStyleHead(styleText));
      assert.ok((block.tokens ?? 0) > 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads project output style from state root when cwd is a worktree", () => {
    const worktree = tempProject();
    const stateRoot = tempProject();
    try {
      mkdirSync(join(stateRoot, ".lykos", "output-styles"), { recursive: true });
      writeFileSync(join(stateRoot, ".lykos", "output-styles", "custom.md"), "Project output style text.\n", "utf8");
      const view = buildHeadView({
        cwd: worktree,
        stateRoot,
        env: ENV,
        gitHead: HEAD,
        outputStyleName: "custom",
      });
      const block = view.blocks.find((b) => b.heading === OUTPUT_STYLE_HEADING);
      assert.ok(block);
      assert.equal(block.enabled, true);
      assert.match(block.text, /Project output style text\./);
    } finally {
      rmSync(worktree, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  });

  it("throws OutputStyleNotFoundError when output style name is unknown", () => {
    const dir = tempProject();
    try {
      assert.throws(
        () => buildHeadView({ cwd: dir, env: ENV, gitHead: HEAD, outputStyleName: "nonexistent" }),
        /no output style named "nonexistent"/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
