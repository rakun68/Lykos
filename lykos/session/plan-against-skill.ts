// The plan-against-skill block.
//
// **What it is.** When a session has one or more skills loaded, before the
// agent acts it presents its intended approach mapped to that skill's STEPS,
// so the human corrects the *approach* (the plan) rather than the *output*
// (the finished work). The human encodes a procedure once as a skill, and the
// agent demonstrates it is replicating that procedure instead of improvising
// while the human hopes.
//
// **What it is NOT.** Not a new approval prompt, and not a gate. The
// interaction modes (`gate/modes.ts`) already decide what needs consent; this
// is a VISIBILITY layer — it changes what the model SAYS, not what it is
// permitted to do. The guidance tells the model to present the plan first,
// name the skill, map intended actions to its steps, and mark deviations as
// deviations. The human's correction rides the loop's existing `steer()` —
// no new terminal surface, no new tool schema, no new approval.
//
// **Steps come from the skill BODY, not a schema.** A skill is a plain
// markdown file (Pi's zero-schema skill mechanism) whose body is loaded on
// demand via the `read` tool. Pi has no `steps:` frontmatter field, so this
// module extracts the procedure the author already wrote — a numbered list,
// a checkbox list, or (when neither exists) the `##`-level headings. Nothing
// here invents a schema Pi does not have (AGENTS.md rule 2/3).
//
// **Frozen like every other block.** Computed once at boot from the loaded
// roster (ticket 05's `resolveLoadedSkills`), passed into
// `buildAppendSystemPromptOverride` as a plain string, never mutated
// afterwards — the same cache-stable head contract every block obeys. A
// session with no skills produces an empty block that is NOT appended, so a
// no-skill session's head is byte-identical to today.

import { readFileSync } from "node:fs";
import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import type { SkillLike } from "./skills.js";
import type { SpecialistContext } from "./specialist-apply.js";
import type { SkillsConfig } from "../config/types.js";

/** The heading of the prompt-inspection block (and the block itself). */
export const PLAN_AGAINST_SKILL_HEADING = "## lykos-plan-against-skill";

/**
 * The guidance the model is handed. It deliberately names the four things
 * the ticket's checkboxes ask for: name the skill, map to its steps, mark
 * deviations as deviations, adopt a human correction. It is an instruction
 * about what to say, not a permission change — the gate still owns consent.
 */
const PLAN_GUIDANCE = [
  PLAN_AGAINST_SKILL_HEADING,
  "",
  "When a task matches a loaded skill, present your plan before you act — not after. Name the",
  "skill you are following, list its steps, and for each step say what you intend to do. If you",
  "intend to deviate from a step, say so explicitly as a deviation and give the reason; never",
  "silently absorb the difference. If the human corrects your approach, adopt the corrected",
  "version and proceed on it.",
].join("\n");

/**
 * The procedure a skill body states, in the order the author wrote it.
 *
 * A step is a top-level numbered list item (`1.`, `2.`), a checkbox item
 * (`- [ ]` / `- [x]`), or a `##`-level heading (the title `#` is skipped) —
 * collected in document order. Fenced code blocks are skipped so a numbered
 * example inside a snippet never becomes a step. Inline markdown (bold,
 * code, links) is stripped so a step reads as plain prose.
 */
export function extractSteps(body: string): string[] {
  const steps: string[] = [];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const numbered = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (numbered) {
      steps.push(cleanStep(numbered[1]!));
      continue;
    }
    const checkbox = /^\s*[-*+]\s+\[[ xX]\]\s+(.+)$/.exec(line);
    if (checkbox) {
      steps.push(cleanStep(checkbox[1]!));
      continue;
    }
    const heading = /^#{2,6}\s+(.+)$/.exec(line);
    if (heading) {
      steps.push(cleanStep(heading[1]!));
    }
  }
  return steps;
}

function cleanStep(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]*)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The steps of one skill, read from its file on disk. A missing or unreadable file yields no steps rather than a boot failure. */
function readSkillSteps(skill: SkillLike): string[] {
  try {
    return extractSteps(stripFrontmatter(readFileSync(skill.filePath, "utf8")));
  } catch {
    return [];
  }
}

/**
 * The full `## lykos-plan-against-skill` block: the guidance above, then
 * each loaded skill's name and its extracted steps, so the model maps its
 * plan against canonical steps (not a recollection) and the human can read
 * the same procedure in `lykos prompt`.
 *
 * Empty when nothing is loaded — including when the only loaded skills are
 * `disable-model-invocation` ones, which `formatSkillsBlockText` and Pi's
 * own `formatSkillsForPrompt` both hide from the model. That emptiness is
 * the "no skill, no extra output, no extra prompt" invariant.
 */
export function formatPlanAgainstSkillBlock(skills: readonly SkillLike[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";

  const lines: string[] = [PLAN_GUIDANCE];
  for (const skill of visible) {
    const steps = readSkillSteps(skill);
    lines.push("", `${skill.name}`);
    if (steps.length === 0) {
      lines.push(`  (no steps could be read from ${skill.filePath})`);
    } else {
      for (const step of steps) {
        lines.push(`  - ${step}`);
      }
    }
  }
  return lines.join("\n");
}

export interface LeanHeadPredicateOpts {
  neutralHead?: boolean | undefined;
  delegated?: boolean | undefined;
  specialistContext?: SpecialistContext | undefined;
  skills?: SkillsConfig | undefined;
}

/**
 * T227 / ADR-0055: A delegated head is lean iff neutralHead is not true AND
 * (delegated === true OR specialistContext === "subagent").
 *
 * A switch head, a session-start head without delegated, and every neutral
 * (person-driven) head are unchanged.
 */
export function isLeanHead(opts: {
  neutralHead?: boolean | undefined;
  delegated?: boolean | undefined;
  specialistContext?: SpecialistContext | undefined;
}): boolean {
  if (opts.neutralHead === true) return false;
  return opts.delegated === true || opts.specialistContext === "subagent";
}

/**
 * Whether the `## lykos-plan-against-skill` block is dropped for this session.
 *
 * Dropped in a lean head unless the session's resolved skills config has a
 * roster (`skills.roster !== undefined`), which a specialist sets by naming
 * skills in its existing `skills:` field.
 */
export function shouldDropPlanAgainstSkill(opts: LeanHeadPredicateOpts): boolean {
  return isLeanHead(opts) && opts.skills?.roster === undefined;
}

