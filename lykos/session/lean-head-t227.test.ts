// Sealed acceptance test (ADR-0055).
//
// A delegated session starts with a lean frozen head. Measured before the build:
// no skill BODY is in any head — Pi's
// `<available_skills>` listing carries name, description and location only —
// and the one place skill-body text enters the head is the
// `## lykos-plan-against-skill` block, which copies every loaded skill's steps
// and tells the model to present its plan to a human who may correct it. A
// delegated session has no such human. The lean head drops that block; every
// other part stays (the ponytail ladder has no levels to trim, and ADR-0002's
// trial measured the injected ladder lowering cost).
//
// Rulings this test holds the build to:
//   - "Delegated" is `delegated: true` (lykos run, an MCP call) or
//     `specialistContext: "subagent"` (a child of `agent`), and never a head
//     with `neutralHead: true`. A `switch` head is not delegated.
//   - A specialist asks for the dropped block back by naming skills in its
//     existing `skills:` field (resolved `skills.roster`); its delegated head then
//     carries the block for exactly those skills. No new specialist field.
//   - A session a person drives is byte-identical to before (fixture below).
//
// Seams: `buildAppendSystemPromptOverride` (what a real session's Lykos blocks
// are built by) with two new options, `delegated` and `skills`; `lykos prompt
// --json --context subagent` (`runPrompt`); and the real session, through the
// scripted-model harness, reading the system prompt the model was sent.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { buildAppendSystemPromptOverride } from "./boot.js";
import type { BootArtifacts } from "./head-contract.js";
import type { HeadView } from "./head-view.js";
import { assembleMountedCatalogHead } from "./mounted-catalog-head.js";
import { formatPlanAgainstSkillBlock, PLAN_AGAINST_SKILL_HEADING } from "./plan-against-skill.js";
import { PONYTAIL_HEADING } from "./ponytail-head.js";
import { resolveLoadedSkills, SKILLS_HEADING } from "./skills.js";
import { SPECIALIST_HEADING } from "./specialist-head.js";
import { runPrompt } from "../cli/prompt.js";
import { reply, runScriptedSession, say, scriptedPiHost } from "../cli/scripted-session.js";
import { resetIoMode } from "../tui/io-mode.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(HERE, "lean-head-t227.fixture.json");

// Isolate the user's home (global config, pi-host) for every seam in this file.
scriptedPiHost();

const ALPHA_STEP = "Alpha step one";
const BETA_STEP = "Beta step one";

const SKILL_FILES: Record<string, string> = {
  ".lykos/skills/alpha.md": [
    "---",
    "name: alpha",
    "description: Alpha procedure for the T227 fixture.",
    "---",
    "",
    "# Alpha",
    "",
    `1. ${ALPHA_STEP}.`,
    "2. Alpha step two.",
    "",
  ].join("\n"),
  ".lykos/skills/beta.md": [
    "---",
    "name: beta",
    "description: Beta procedure for the T227 fixture.",
    "---",
    "",
    "# Beta",
    "",
    `1. ${BETA_STEP}.`,
    "",
  ].join("\n"),
};

/** A project specialist that names one skill — the opt-in. */
const SKILLED_SPECIALIST: Record<string, string> = {
  ".lykos/specialists/skilled.yaml": [
    "description: T227 fixture specialist that names its skill.",
    "role: subagent",
    "read_only: false",
    "skills:",
    "  - alpha",
    "instructions: Follow the alpha procedure.",
    "",
  ].join("\n"),
};

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t227-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body, "utf8");
  }
  return dir;
}

/** The plan-against-skill block for the fixture skills, built by today's own function. */
function planBlock(roster?: string[]): string {
  const dir = project(SKILL_FILES);
  try {
    return formatPlanAgainstSkillBlock(resolveLoadedSkills(dir, roster !== undefined ? { roster } : undefined));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ARTIFACTS: BootArtifacts = {
  cwd: "/fixture/project",
  platform: "linux",
  project: "project",
  gitHeadAtBoot: "0".repeat(40),
  toolNames: ["read", "bash", "edit", "write"],
};

const IMPLEMENTER_INSTRUCTIONS = "Make the sealed tests pass.";

type OverrideOpts = Parameters<typeof buildAppendSystemPromptOverride>[1];

/**
 * The Lykos parts of a head, exactly as a session builds them. `extra` may carry
 * options the build adds (`delegated`, `skills`); it goes through a cast so this
 * file typechecks before they exist.
 */
function headParts(extra: Record<string, unknown>): string[] {
  const opts = {
    promptDietEnabled: true,
    outputDietEnabled: true,
    memoryHead: "",
    ...extra,
  };
  return buildAppendSystemPromptOverride(ARTIFACTS, opts as unknown as OverrideOpts)(["<pi base>"]);
}

const isPlan = (part: string): boolean => part.startsWith(PLAN_AGAINST_SKILL_HEADING);

async function promptView(cwd: string, specialist: string, context: "subagent" | "session-start" | "switch"): Promise<HeadView> {
  resetIoMode();
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
    out += s;
    return true;
  };
  try {
    const code = await runPrompt(cwd, { json: true, specialist, context });
    assert.equal(code, 0);
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
    resetIoMode();
  }
  return JSON.parse(out) as HeadView;
}

function injectedText(view: HeadView): string {
  return view.blocks
    .filter((b) => b.enabled && b.text.length > 0)
    .map((b) => b.text)
    .join("\n\n");
}

async function sessionSystemPrompt(specialist: string, extra: Record<string, unknown>): Promise<string> {
  let systemPrompt = "";
  const run = await runScriptedSession({
    files: { ...SKILL_FILES, ...SKILLED_SPECIALIST, "README.md": "fixture\n" },
    extra: { trustSource: "stored", specialist, ...extra },
    script: [
      (context) => {
        systemPrompt = context.systemPrompt ?? "";
        return reply(say("done"));
      },
    ],
  });
  assert.equal(run.result.status, "ok", JSON.stringify(run.result));
  return systemPrompt;
}

describe("T227 (a): a delegated session's head drops the plan-against-skill block", () => {
  it("the boot seam: a subagent implementer's head is the full head minus that block, nothing else", () => {
    const plan = planBlock();
    assert.ok(plan.includes(ALPHA_STEP), "fixture: the block carries the skill's steps");
    const common = {
      specialistName: "implementer",
      specialist: { instructions: IMPLEMENTER_INSTRUCTIONS },
      planAgainstSkillHead: plan,
    };
    // A `switch` head is a person's session changing specialist: not delegated, so the full head.
    const full = headParts({ ...common, specialistContext: "switch" });
    assert.ok(full.some(isPlan), "fixture: the non-delegated head carries the block");

    const lean = headParts({ ...common, specialistContext: "subagent" });
    assert.ok(!lean.some(isPlan), "a subagent head has no plan-against-skill block");
    assert.ok(!lean.join("\n\n").includes(ALPHA_STEP), "no skill step text is left in the head");
    assert.ok(lean.some((p) => p.startsWith(PONYTAIL_HEADING)), "the ponytail ladder stays");
    assert.ok(lean.includes(`${SPECIALIST_HEADING}\n${IMPLEMENTER_INSTRUCTIONS}`), "the specialist's instructions stay");
    assert.deepEqual(lean, full.filter((p) => !isPlan(p)), "only the plan-against-skill block is dropped");
    assert.ok(
      full.join("\n\n").length - lean.join("\n\n").length >= plan.length,
      "the lean head is smaller by at least the dropped block",
    );
  });

  it("the boot seam: a top-level delegated session (lykos run, an MCP call) is lean too", () => {
    const plan = planBlock();
    const lean = headParts({
      delegated: true,
      specialistContext: "session-start",
      specialistName: "implementer",
      specialist: { instructions: IMPLEMENTER_INSTRUCTIONS },
      planAgainstSkillHead: plan,
    });
    assert.ok(!lean.some(isPlan), "a delegated head has no plan-against-skill block");
    assert.ok(lean.some((p) => p.startsWith(PONYTAIL_HEADING)));
  });

  it("lykos prompt --context subagent shows the lean head: skills listed by name, no steps", async () => {
    const dir = project(SKILL_FILES);
    try {
      const view = await promptView(dir, "implementer", "subagent");
      const text = injectedText(view);
      const skills = view.blocks.find((b) => b.heading === SKILLS_HEADING);
      assert.ok(skills?.enabled === true, "the skills listing stays");
      assert.ok(skills.text.includes("<name>alpha</name>") && skills.text.includes("<name>beta</name>"));
      const plan = view.blocks.find((b) => b.heading === PLAN_AGAINST_SKILL_HEADING);
      assert.ok(plan === undefined || !plan.enabled || plan.text.length === 0, "no plan-against-skill block is injected");
      assert.ok(!text.includes(ALPHA_STEP) && !text.includes(BETA_STEP), "no skill step text is injected");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the real delegated session sends the model the lean head", async () => {
    const prompt = await sessionSystemPrompt("implementer", { delegated: true });
    assert.ok(prompt.includes("<name>alpha</name>"), "the skill is still listed by name");
    assert.ok(prompt.includes(PONYTAIL_HEADING));
    assert.ok(!prompt.includes(PLAN_AGAINST_SKILL_HEADING), "no plan-against-skill block in the delegated head");
    assert.ok(!prompt.includes(ALPHA_STEP), "no skill step text in the delegated head");
  });
});

describe("T227 (b): a specialist that names a skill in `skills:` gets the block back", () => {
  it("the boot seam: a named roster keeps the block; no roster drops it", () => {
    const plan = planBlock(["alpha"]);
    const common = { specialistContext: "subagent", specialistName: "skilled", planAgainstSkillHead: plan };
    const withRoster = headParts({ ...common, skills: { roster: ["alpha"] } });
    assert.ok(withRoster.includes(plan), "the specialist that named alpha keeps alpha's block");
    const withoutRoster = headParts({ ...common });
    assert.ok(!withoutRoster.some(isPlan), "without a roster the delegated head drops it");
  });

  it("lykos prompt --context subagent: the skilled specialist gets alpha's steps, the implementer does not", async () => {
    const dir = project({ ...SKILL_FILES, ...SKILLED_SPECIALIST });
    try {
      const skilled = injectedText(await promptView(dir, "skilled", "subagent"));
      assert.ok(skilled.includes(PLAN_AGAINST_SKILL_HEADING) && skilled.includes(ALPHA_STEP), "the opt-in keeps the block");
      assert.ok(!skilled.includes(BETA_STEP), "only for the skills it named");
      const implementer = injectedText(await promptView(dir, "implementer", "subagent"));
      assert.ok(!implementer.includes(ALPHA_STEP), "a specialist that named no skill does not get it");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the real delegated session: the skilled specialist's head carries alpha's block", async () => {
    const skilled = await sessionSystemPrompt("skilled", { delegated: true });
    assert.ok(skilled.includes(PLAN_AGAINST_SKILL_HEADING) && skilled.includes(ALPHA_STEP));
    const implementer = await sessionSystemPrompt("implementer", { delegated: true });
    assert.ok(!implementer.includes(ALPHA_STEP), "contrast: the implementer named no skill");
  });
});

describe("T227 (c): a session a person drives is byte-identical to before", () => {
  it("the person-driven head, from fixed inputs, equals the head captured before T227", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { personDriven: string[]; capturedAt: string };
    // The mounted catalog is the tool registry's, which other tickets change; it is pinned by its own tests.
    const catalog = assembleMountedCatalogHead();
    const parts = headParts({
      neutralHead: true,
      specialistContext: "session-start",
      specialistName: "build",
      planAgainstSkillHead: planBlock(),
    }).map((p) => (catalog.length > 0 && p === catalog ? "<mounted-catalog>" : p));
    assert.deepEqual(parts, fixture.personDriven);
  });

  it("lykos prompt for the session a person drives still shows the plan-against-skill block", async () => {
    const dir = project(SKILL_FILES);
    try {
      const view = await promptView(dir, "build", "session-start");
      const plan = view.blocks.find((b) => b.heading === PLAN_AGAINST_SKILL_HEADING);
      assert.ok(plan?.enabled === true);
      assert.equal(plan.text, formatPlanAgainstSkillBlock(resolveLoadedSkills(dir)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
