// T102 — a skills mechanism (`docs/24-strength-and-tooling-audit.md` §2.5,
// `docs/27-phase12-tasks.md`).
//
// **THE PREMISE IS WRONG, AND THE CORRECTION IS THE FINDING — again.** §2.5
// says "Lykos has no way to load procedural knowledge on demand" and calls
// the mechanism the highest-leverage cheap item in the register. The
// mechanism already exists, one layer down, and it is better than what this
// task would have built:
//
//   - `loadSkillsFromDir()` discovers skills from a directory, either as
//     `SKILL.md` in a skill root or as direct `.md` children;
//   - `formatSkillsForPrompt()` puts **name, description and location** in
//     the system prompt and tells the model to *read the file* when the task
//     matches — progressive disclosure, exactly as §2.5 specifies;
//   - the body is loaded with the **`read` tool**, so the whole capability
//     costs **zero tool schema**, which is the property §2.5 wanted most;
//   - `disable-model-invocation` in a skill's frontmatter hides it from the
//     prompt entirely, leaving it reachable only through `/skill:name`;
//   - `DefaultResourceLoader` takes `additionalSkillPaths` and a
//     `skillsOverride` hook.
//
// Lykos has been booting with all of that available and `booted.skillNames`
// has been reporting whatever Pi's own default discovery found. So the task
// is NOT to build a skills surface. It is four smaller things Pi cannot do
// for us:
//
//  1. **A Lykos-owned location.** `.lykos/skills/`, passed as
//     `additionalSkillPaths`. Rule 6: translate at the boundary, never teach
//     Pi a new path and never patch it.
//
//  2. **A deliberate cap.** §2.5's load-bearing caveat is that skill
//     *selection* degrades with count — forty skills is a retrieval problem
//     solved by description matching. `skillsOverride` enforces a cap, and
//     what it drops is REPORTED rather than silently disappeared, because a
//     skill the author believes is loaded and is not is worse than no skill.
//
//  3. **An invocation counter.** §2.5 asks for the invocation rate to be
//     measured, on the same reasoning T76 used for memory entries: a skill
//     never invoked is store pressure. Because a skill body is loaded with
//     `read`, an invocation IS a `read` whose path is inside a skills
//     directory — so this is observable from the tool trace without
//     instrumenting anything the model does.
//
//  4. **The head cost, stated.** Skills sit in the system prompt, which is
//     frozen for the session (T17), and every name and description rides
//     every request. `skillsHeadCost()` prices the roster the same way the
//     tool-schema tax is priced, so the bill is itemised at the moment the
//     roster grows rather than reconstructed later.
//
// WHAT LYKOS'S OWN SKILLS SHOULD BE, and this is prose in the skill files
// rather than code here: short and mechanical. A checklist, a command
// sequence, a refusal rule. Not essays — instruction-following depth is
// precisely the capability the cheap tier has least of, so a long
// conditional skill is a liability on exactly the model this project
// assumes.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import type { SkillsConfig } from "../config/types.js";

export type { SkillsConfig };

export const LYKOS_SKILLS_DIRNAME = "skills";

/** The heading of the prompt-inspection block that lists the loaded skills (ticket 05). */
export const SKILLS_HEADING = "## lykos-skills";

/** `.lykos/skills` — the Lykos-owned location, never `.pi/skills`. */
export function lykosSkillsDir(cwd: string): string {
  return join(cwd, ".lykos", LYKOS_SKILLS_DIRNAME);
}

/**
 * Specialists ticket 05: the skills actually on disk under `.lykos/skills`,
 * discovered with **Pi's own loader** (`loadSkillsFromDir`) rather than a
 * second, hand-rolled name derivation. That matters because a skill's `name`
 * is `frontmatter.name`, falling back to its parent directory's name — NOT
 * the `.md` basename — and the missing-skill check must compare against the
 * names the session actually loads, not a guess. Deduplicated by name,
 * first-wins, exactly as Pi's `loadSkills` does, so this roster is byte-faithful
 * to what `boot()` offers the model.
 */
export function discoverSkills(cwd: string): SkillLike[] {
  const dir = lykosSkillsDir(cwd);
  if (!existsSync(dir)) return [];
  const seen = new Set<string>();
  const out: SkillLike[] = [];
  for (const s of loadSkillsFromDir({ dir, source: "project" }).skills) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push({ name: s.name, description: s.description, filePath: s.filePath, disableModelInvocation: s.disableModelInvocation });
  }
  return out;
}

/** The skill names on disk, as the loader derives them (frontmatter `name`, else parent dir name). */
export function discoverSkillNames(cwd: string): string[] {
  return discoverSkills(cwd).map((s) => s.name);
}

export interface SkillsPolicy {
  enabled: boolean;
  /**
   * ADR-0029: absent means no cap, which is the default. Pi caps
   * nothing, and T102's ceiling of 12 dropped a project's own skill behind
   * the global ones. A project that wants a ceiling sets `skills.max`.
   */
  max?: number;
  /** Directories handed to Pi as `additionalSkillPaths`. Only ones that exist. */
  paths: string[];
  /**
   * Specialists ticket 02/05: when set, only skills named here are candidates
   * — filtered BEFORE the cap above, so a roster of three never gets capped
   * by a `max` written for the unrestricted default. `undefined` means every
   * discovered skill is a candidate, same as before this field existed.
   */
  roster?: string[];
}

export function resolveSkillsPolicy(cwd: string, config?: SkillsConfig): SkillsPolicy {
  const enabled = config?.enabled ?? true;
  const dir = lykosSkillsDir(cwd);
  return {
    enabled,
    ...(config?.max !== undefined ? { max: Math.max(1, config.max) } : {}),
    // A path that does not exist is not passed: Pi would report a diagnostic
    // for it on every boot, and "you have no skills directory" is not a
    // problem, it is the default state of a project.
    paths: enabled && existsSync(dir) ? [dir] : [],
    ...(config?.roster !== undefined ? { roster: config.roster } : {}),
  };
}

/**
 * Specialists ticket 05: the roster this session actually offers the model,
 * computed from the SAME pieces `boot()`'s `skillsOverride` runs — discover
 * with the loader, filter by the specialist's roster (before the cap), then cap.
 * `undefined` roster keeps every discovered skill; an empty roster loads
 * none. Used by the prompt-inspection block and the switch report so neither
 * re-derives the pipeline.
 */
export function resolveLoadedSkills(cwd: string, config?: SkillsConfig): SkillLike[] {
  const policy = resolveSkillsPolicy(cwd, config);
  if (!policy.enabled) return [];
  const discovered = discoverSkills(cwd);
  const rostered = filterSkillsByRoster(discovered, policy.roster);
  return capSkills(rostered, policy.max).kept;
}

/**
 * Specialists ticket 02: applies `SkillsPolicy.roster`. `undefined` roster is a
 * no-op (every skill stays a candidate); an empty roster loads none, matching
 * "a specialist declaring no skills loads none" (ticket 05 checkbox).
 */
export function filterSkillsByRoster<T extends SkillLike>(skills: readonly T[], roster: readonly string[] | undefined): T[] {
  if (roster === undefined) return [...skills];
  const wanted = new Set(roster);
  return skills.filter((s) => wanted.has(s.name));
}

/** The minimum of Pi's `Skill` this module needs; narrow so tests need no loader. */
export interface SkillLike {
  name: string;
  description: string;
  filePath: string;
  /** Pi hides a skill from the prompt when its frontmatter sets this — carried so `formatSkillsBlockText` can match `formatSkillsForPrompt` exactly. */
  disableModelInvocation?: boolean;
}

export interface SkillsCapResult<T extends SkillLike> {
  kept: T[];
  dropped: T[];
}

/**
 * Applies the cap. Order is preserved, so what survives is deterministic and
 * a project can predict which skills are in force by their discovery order
 * rather than by a scoring function nobody can reproduce.
 */
export function capSkills<T extends SkillLike>(skills: readonly T[], max: number | undefined): SkillsCapResult<T> {
  if (max === undefined) return { kept: [...skills], dropped: [] };
  return { kept: skills.slice(0, max), dropped: skills.slice(max) };
}

/**
 * What the session says on stderr when the cap actually bit. Undefined when
 * nothing was dropped — silence is the correct output for the normal case,
 * and the same rule T97.3 follows for a missing extension: a thing that did
 * not load is REPORTED, never skipped quietly.
 */
export function skillsCapNotice<T extends SkillLike>(result: SkillsCapResult<T>, max: number | undefined): string | undefined {
  if (result.dropped.length === 0) return undefined;
  return (
    `lykos: ${result.dropped.length} skill(s) over the cap of ${max} were NOT loaded: ` +
    `${result.dropped.map((s) => s.name).join(", ")}. Skill selection degrades with roster size ` +
    `(docs/24 §2.5); raise or remove skills.max in config.yaml to carry them all.`
  );
}

/**
 * Specialists ticket 05: the exact text Pi's `formatSkillsForPrompt` puts in the
 * system prompt for this roster (an `<available_skills>` XML block), for the
 * prompt-inspection block. Byte-faithful to `skills.js` — same preamble, same
 * XML, same escaping, and the same `disable-model-invocation` filter — so what
 * `lykos prompt` prints is what the model was actually handed, not a
 * paraphrase. Empty when there is nothing to offer.
 */
export function formatSkillsBlockText(skills: readonly SkillLike[]): string {
  const visible = skills.filter((s) => !s.disableModelInvocation);
  if (visible.length === 0) return "";
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of visible) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The head cost of a roster, in the same basis the tool-schema tax uses
 * (Pi 0.84.3's own `estimateTokens`: ceil(chars / 4)). This is what rides
 * every request for the whole session, so it is the number that matters when
 * deciding whether one more skill is worth it.
 *
 * It reproduces `formatSkillsForPrompt`'s shape rather than importing it,
 * because the exported function takes Pi's full `Skill` and this must be
 * callable from a config check with three strings.
 */
export function skillsHeadCost(skills: readonly SkillLike[]): number {
  if (skills.length === 0) return 0;
  const preamble =
    "\n\nThe following skills provide specialized instructions for specific tasks.\n" +
    "Use the read tool to load a skill's file when the task matches its description.\n" +
    "When a skill file references a relative path, resolve it against the skill directory " +
    "(parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.\n\n" +
    "<available_skills>\n</available_skills>";
  const body = skills
    .map((s) => `  <skill>\n    <name>${s.name}</name>\n    <description>${s.description}</description>\n    <location>${s.filePath}</location>\n  </skill>`)
    .join("\n");
  return Math.ceil((preamble.length + body.length) / 4);
}

// ---------------------------------------------------------------------------
// Invocation: a skill is "used" when its file is read.
// ---------------------------------------------------------------------------

export interface SkillInvocationState {
  /** Distinct skills whose body was read this session, in first-read order. */
  invoked: string[];
  /** Total reads of skill files, including re-reads. */
  reads: number;
  /** Skills offered in the head. The denominator §2.5 asks for. */
  available: number;
}

export function newSkillInvocationState(): SkillInvocationState {
  return { invoked: [], reads: 0, available: 0 };
}

/**
 * Classifies a `read` as a skill invocation, by matching the path against
 * the known skill files rather than against a directory pattern. Matching on
 * "is it under a skills dir" would count a session that greps the directory
 * listing, and would miss a skill loaded through a symlink or an absolute
 * path spelled differently.
 */
export function observeSkillRead(
  state: SkillInvocationState,
  path: string | undefined,
  skills: readonly SkillLike[],
): string | undefined {
  if (path === undefined || path.length === 0) return undefined;
  const target = normalise(path);
  for (const skill of skills) {
    if (normalise(skill.filePath) === target) {
      state.reads += 1;
      if (!state.invoked.includes(skill.name)) state.invoked.push(skill.name);
      return skill.name;
    }
  }
  return undefined;
}

/**
 * P4 T143: a successful call to the `skill` tool is a use of that skill, the
 * same as a read of its file — counted in the same two fields, so the skills
 * kill criterion sees the tool the prompt now points at. Matched against the
 * roster by name the way the tool matches it (exact first, then ignoring
 * case), and recorded under the roster's spelling.
 */
export function observeSkillCall(
  state: SkillInvocationState,
  name: string | undefined,
  skills: readonly SkillLike[],
): string | undefined {
  const asked = name?.trim() ?? "";
  if (asked.length === 0) return undefined;
  const hit =
    skills.find((s) => s.name === asked) ?? skills.find((s) => s.name.toLowerCase() === asked.toLowerCase());
  if (hit === undefined) return undefined;
  state.reads += 1;
  if (!state.invoked.includes(hit.name)) state.invoked.push(hit.name);
  return hit.name;
}

function normalise(path: string): string {
  const abs = resolve(path);
  // Windows paths are case-insensitive and may arrive with either separator.
  return process.platform === "win32" ? abs.toLowerCase().split(sep).join("/") : abs.split(sep).join("/");
}

/**
 * Creates `.lykos/skills/` when it is missing. Called by `lykos init` rather
 * than at boot: a session that silently creates directories in a project is
 * a session doing something the user did not ask for.
 */
export function ensureSkillsDir(cwd: string): string {
  const dir = lykosSkillsDir(cwd);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Names of the `.md` files directly in the skills dir. For `lykos doctor`. */
export function listSkillFiles(cwd: string): string[] {
  const dir = lykosSkillsDir(cwd);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isFile() && e.name.endsWith(".md")) || e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
