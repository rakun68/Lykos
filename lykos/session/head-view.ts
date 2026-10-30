// T28.1/T28.2 — head inspection (`docs/10-phase2-tasks.md`,
// `docs/05-cli-and-config.md` §4). "Show what the agent was actually told."
//
// This module computes NOTHING new. Every value here comes from the same
// functions a session itself calls — `assembleBootHead()` (T17),
// `assembleDietHead()` (T21), `assembleOutputDietHead()` (T23),
// `ingestContextFiles()` (T21.3), `measureToolset()` (T4.1) — so what the
// command prints is what a session gets, not a second description of it.
// The moment this file starts deriving its own answer it becomes
// documentation of the head rather than a view of it.
//
// **One view, the host's.** A delegated run is an ordinary Lykos session on
// the host with only its commands contained (ADR-0036), so `boot.ts` builds
// its head from the host cwd and `process.platform` exactly as it does for a
// standalone one. The view used to default to a `delegate` target modelling
// the retired container (`/work`, linux, memory and skills off). That target
// was removed with the container (#47) because it had become a confidently
// wrong answer for every session.
//
// **What cannot be shown, stated rather than guessed.** Pi's own base
// system prompt is assembled inside the agent process from Pi's resources;
// the host has no copy of it. So `calls.prefix_fingerprint` — sha256 of the
// FULL assembled prompt plus the active tool names — is not reproducible
// here, and this module does not pretend otherwise (`fingerprints.note`).
// What it does give is the boot-block fingerprint, which is exactly the
// value `HeadContract.boot()` returns and exactly the block T18's drift
// detector names when it fires.

import { hostGit } from "../git/host-git.js";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  assembleBootHead,
  assembleIdentityHead,
  bootFieldValues,
  BOOT_HEADING,
  fingerprintHead,
  HEAD_FIELD_ORDER,
  IDENTITY_HEADING,
  type HeadField,
} from "./head-contract.js";
import {
  assembleDietHead,
  assembleOutputDietHead,
  contextFileMeta,
  toolResultMaxBytesFromEnv,
  DIET_HEADING,
  dietEnabledFromEnv,
  ingestContextFiles,
  OUTPUT_DIET_HEADING,
  outputDietEnabledFromEnv,
  type ContextFileKind,
} from "../loop/prompt-diet.js";
import { resolveSessionTools } from "../tools.js";
import { piHostDir } from "../config/pi-host.js";
import {
  buildMemoryHead,
  MEMORY_HEADING,
  resolveMemoryPolicy,
} from "./memory-head.js";
import type { MemoryScope } from "../memory.js";
import { buildRepoMap, REPO_MAP_HEADING, resolveRepoMapPolicy } from "../context/repo-map.js";
import { SPECIALIST_HEADING } from "./specialist-head.js";
import { assemblePonytailHead, PONYTAIL_HEADING, resolvePonytailAndSpecialistHeads } from "./ponytail-head.js";
import { specialistStreamMessage } from "./specialist-stream.js";
import { formatSkillsBlockText, resolveLoadedSkills, SKILLS_HEADING } from "./skills.js";
import { formatPlanAgainstSkillBlock, PLAN_AGAINST_SKILL_HEADING, shouldDropPlanAgainstSkill } from "./plan-against-skill.js";
import { assembleMountedCatalogHead, MOUNTED_CATALOG_HEADING } from "./mounted-catalog-head.js";
import { assembleOutputStyleHead, OUTPUT_STYLE_HEADING, resolveOutputStyle } from "../config/output-styles.js";
import type { SkillsConfig } from "../config/types.js";
import {
  estimateTokensChars4,
  measureToolset,
  SCHEMA_TOKENS_BASIS,
  type ToolSchemaMeasurement,
} from "../ledger/tool-schema.js";

export interface HeadBlock {
  /** The literal heading line, e.g. `## lykos-head`. */
  heading: string;
  /** Task that owns the block, for the reader who wants the rationale. */
  task: string;
  note: string;
  /** False when the block's flag is off — it is still listed, and counted as 0 tokens. */
  enabled: boolean;
  /** The flag that turns it off, for the reader who wants to change it. */
  flag: string | null;
  text: string;
  bytes: number;
  tokens: number;
  sha256: string;
}

export interface HeadContextFile {
  path: string;
  name: string;
  kind: ContextFileKind;
  bytes: number;
  tokens: number;
}

export interface HeadEnvironment {
  cwd: string;
  platform: string;
  project: string;
  gitHead: string;
  agentDir: string;
}

export interface HeadView {
  environment: HeadEnvironment;
  /** In assembly order, after Pi's own base prompt (which is not visible here). */
  blocks: HeadBlock[];
  bootFields: Record<HeadField, string>;
  contextFiles: HeadContextFile[];
  contextFilesEnabled: boolean;
  toolset: ToolSchemaMeasurement;
  toolResultMaxBytes: number;
  tokensBasis: typeof SCHEMA_TOKENS_BASIS;
  fingerprints: {
    /** Identical to `HeadContract.boot()`'s return — sha256(bootHead + NUL + tools). */
    bootHead: string;
    note: string;
  };
  totals: {
    headTokens: number;
    contextTokens: number;
    schemaTokens: number | null;
    /** null when the toolset could not be measured — never a partial sum passed off as a total. */
    total: number | null;
  };
  /** T215: the stream message the session would send when neutralHead is true. */
  specialistStreamMessage?: string;
}

export interface BuildHeadViewOpts {
  /** The session's workspace. */
  cwd: string;
  /** T184: `BootConfig.stateRoot` — where `.lykos/` memory lives when `cwd` is a worktree. Absent, it is `cwd`. */
  stateRoot?: string;
  /** Caller override, exactly as `runTask()` passes it through `resolveSessionTools()`. */
  tools?: readonly string[];
  subagents?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Injectable so a test does not depend on the repo's own HEAD. */
  gitHead?: string;
  /** T65: `config.memory`. Omitted → the shipped default (enabled, 500 tokens). */
  memory?: { enabled?: boolean; scope?: ReadonlyArray<MemoryScope>; max_inject_tokens?: number };
  /**
   * T158 (ADR-0028): whether `lykos-repo-map` is declared in `extensions:` —
   * its only switch. Omitted → off, which is the shipped default.
   */
  repoMapDeclared?: boolean;
  /** T69: `config.retrieval.repo_map`. */
  repoMap?: { max_tokens?: number; max_files_per_dir?: number };
  /** Specialists ticket 01: `ResolvedConfig.instructions`, already merged across every layer. */
  specialistInstructions?: string;
  /**
   * Specialists ticket 05: `ResolvedConfig.skills` (including the specialist's
   * `roster`). Omitted → the loaded roster is computed from disk with no
   * roster filter, same as `boot()` when no specialist declares one.
   */
  skills?: SkillsConfig;
  /** T217: output style name. Default: "default". */
  outputStyleName?: string;
  /** T217: output style text. Empty for default. */
  outputStyleText?: string;
  /** T215: neutral head for human-driven sessions. */
  neutralHead?: boolean;
  /** T215: specialist name for stream message in head view. */
  specialistName?: string;
  /** T215: mode label for stream message in head view. */
  modeLabel?: string;
  /** T215: explicit specialist stream message. */
  specialistStreamMessage?: string;
  /** T227 / ADR-0055: whether the session is delegated. */
  delegated?: boolean | undefined;
}

/** Same shape as the worker's `gitHeadOnce()`: one call, 2s cap, `no-git` on any failure. */
export function gitHeadOnce(cwd: string): string {
  // T170: through the host git helper, so the repository's hooks and fsmonitor never run.
  const run = hostGit(["rev-parse", "HEAD"], cwd, { timeoutMs: 2000 });
  return run.ok && run.stdout.length > 0 ? run.stdout : "no-git";
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function block(
  heading: string,
  task: string,
  note: string,
  enabled: boolean,
  flag: string | null,
  text: string,
): HeadBlock {
  return {
    heading,
    task,
    note,
    enabled,
    flag,
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    tokens: estimateTokensChars4(text),
    sha256: sha256(text),
  };
}

export function buildHeadView(opts: BuildHeadViewOpts): HeadView {
  const env = opts.env ?? process.env;
  const hostCwd = resolve(opts.cwd);
  const toolNames = resolveSessionTools({
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.subagents !== undefined ? { subagents: opts.subagents } : {}),
  });

  const environment: HeadEnvironment = {
    cwd: hostCwd,
    platform: process.platform,
    project: basename(hostCwd),
    gitHead: opts.gitHead ?? gitHeadOnce(hostCwd),
    // T33: this must print the SAME value a session would actually run with,
    // not a placeholder. ADR-0027: that is the generated pi-host
    // `session/boot.ts` passes Pi, from the one resolver.
    agentDir: piHostDir(env),
  };

  const bootArtifacts = {
    cwd: environment.cwd,
    platform: environment.platform,
    project: environment.project,
    gitHeadAtBoot: environment.gitHead,
    toolNames,
  };
  const bootHead = assembleBootHead(bootArtifacts);

  const dietEnabled = dietEnabledFromEnv(env);
  const outputDietEnabled = outputDietEnabledFromEnv(env);
  // T65 / T69: the repo map is read from the workspace, and memory from the
  // state root's `.lykos/`, the same way `boot.ts` reads them.
  const repoMapPolicy = resolveRepoMapPolicy({ enabled: opts.repoMapDeclared === true, ...(opts.repoMap ?? {}) });
  const repoMap = buildRepoMap(hostCwd, repoMapPolicy);
  const memoryPolicy = resolveMemoryPolicy(opts.memory, env);
  const memoryHead = buildMemoryHead(resolve(opts.stateRoot ?? opts.cwd), memoryPolicy);
  const heads = opts.neutralHead
    ? { ponytail: assemblePonytailHead(), specialist: "", replaced: false }
    : resolvePonytailAndSpecialistHeads(opts.specialistInstructions);
  // Specialists ticket 05: the roster the session offers the model, computed
  // from the same pieces `boot()` runs (loader discovery + roster filter +
  // cap). Skills are a Pi-native prompt component (`<available_skills>`), not
  // a Lykos append block — surfaced here so `lykos prompt` can finally say
  // which skills the active specialist loaded, rather than omitting them.
  const loadedSkills = resolveLoadedSkills(hostCwd, opts.skills);
  const skillsText = formatSkillsBlockText(loadedSkills);
  // Specialists ticket 06: the plan-against-skill block, built from the same
  // loaded roster.
  const planText = formatPlanAgainstSkillBlock(loadedSkills);
  const mountedCatalogHead = assembleMountedCatalogHead();
  const projectRoot = resolve(opts.stateRoot ?? hostCwd);
  const outputStyleName = opts.outputStyleName ?? "default";
  const outputStyleText =
    opts.outputStyleText !== undefined
      ? opts.outputStyleText
      : resolveOutputStyle(outputStyleName, projectRoot).text;
  const outputStyleEnabled = outputStyleText.trim().length > 0;

  const blocks: HeadBlock[] = [
    block(BOOT_HEADING, "T17", `frozen environment: ${HEAD_FIELD_ORDER.join(", ")}`, true, null, bootHead),
    block(IDENTITY_HEADING, "identity fix 2026-09-01", "answer as Lykos, not Pi", true, null, assembleIdentityHead()),
    block(
      DIET_HEADING,
      "T21",
      "format rules, stated once",
      dietEnabled,
      "LYKOS_PROMPT_DIET=0",
      assembleDietHead(),
    ),
    block(
      OUTPUT_DIET_HEADING,
      "T23",
      "one-line YAGNI rule",
      outputDietEnabled,
      "LYKOS_OUTPUT_DIET=0",
      assembleOutputDietHead(),
    ),
    block(
      MOUNTED_CATALOG_HEADING,
      "P10.2",
      mountedCatalogHead.length > 0
        ? "mounted tools by prompt presence (named / full); hidden tools are omitted"
        : "no named or full mounted tools — nothing appended",
      mountedCatalogHead.length > 0,
      null,
      mountedCatalogHead,
    ),
    block(
      MEMORY_HEADING,
      "T65",
      memoryHead.enabled
        ? `${memoryHead.injected.length} of ${memoryHead.available} entries, cap ${memoryPolicy.maxInjectTokens} tokens` +
          (memoryHead.skipped > 0 ? ` (${memoryHead.skipped} did not fit)` : "")
        : "memory injection off",
      memoryHead.enabled && memoryHead.text.length > 0,
      "LYKOS_MEMORY_INJECT=0",
      memoryHead.text,
    ),
    // Specialists ticket 03: the ponytail block, unconditional by default (spec:
    // "every Lykos session boots with the ponytail ladder"). A specialist can
    // replace its content (see `ponytail-head.ts`'s replace-marker
    // convention) instead of appending after it — `heads.replaced` says
    // which happened for this config.
    // Specialists ticket 01: the specialist's own instructions, last in assembly
    // order (spec: "a specialist's own text is the last word"), empty when the
    // specialist's text was consumed as the ponytail replacement instead.
    block(
      PONYTAIL_HEADING,
      "specialists ticket 03",
      heads.replaced ? "replaced by specialist instructions (MIT, see attribution in block text)" : "default minimalism ladder (ponytail, MIT)",
      true,
      null,
      heads.ponytail,
    ),
    // Specialists ticket 05: which skills the active specialist loaded. Skills sit
    // in Pi's base prompt, not a Lykos append block, so this block documents
    // them.
    block(
      SKILLS_HEADING,
      "specialists ticket 05",
      loadedSkills.length > 0
        ? `${loadedSkills.length} skill(s) loaded from .lykos/skills: ${loadedSkills.map((s) => s.name).join(", ")}`
        : "no skills loaded (no .lykos/skills, or the specialist declared none)",
      skillsText.length > 0,
      null,
      skillsText,
    ),
    // Specialists ticket 06 / T227: the plan-against-skill block — guidance to present
    // a plan mapped to the loaded skills' steps before acting. Dropped whole in a
    // lean head unless opted in via skills.roster.
    shouldDropPlanAgainstSkill({
      neutralHead: opts.neutralHead,
      delegated: opts.delegated,
      skills: opts.skills,
    })
      ? block(
          PLAN_AGAINST_SKILL_HEADING,
          "specialists ticket 06",
          "lean head dropped plan-against-skill (ADR-0055)",
          false,
          null,
          "",
        )
      : block(
          PLAN_AGAINST_SKILL_HEADING,
          "specialists ticket 06",
          planText.length > 0
            ? `plan guidance for: ${loadedSkills.map((s) => s.name).join(", ")}`
            : "no skills loaded — no plan guidance",
          planText.length > 0,
          null,
          planText,
        ),
    block(
      SPECIALIST_HEADING,
      "specialists ticket 01",
      heads.specialist
        ? "specialist-selected instructions"
        : heads.replaced
          ? "consumed as the ponytail replacement above"
          : opts.neutralHead
            ? "neutral head — specialist text sent via stream message"
            : "no specialist instructions in the resolved config",
      Boolean(heads.specialist),
      null,
      heads.specialist,
    ),
    block(
      OUTPUT_STYLE_HEADING,
      "T217 output style",
      outputStyleEnabled
        ? `reply shape (${outputStyleName})`
        : "default (no extra instruction)",
      outputStyleEnabled,
      null,
      outputStyleEnabled ? assembleOutputStyleHead(outputStyleText) : "",
    ),
    // T148: the repo map is the `lykos-repo-map` default extension now. It
    // appends to the END of Pi's assembled prompt through `before_agent_start`,
    // after every Lykos block, so it is listed last.
    block(
      REPO_MAP_HEADING,
      "T148 lykos-repo-map",
      repoMap.enabled
        ? `${repoMap.files} of ${repoMap.tracked} tracked files, cap ${repoMapPolicy.maxTokens} tokens` +
          (repoMap.dropped > 0 ? ` (${repoMap.dropped} not listed)` : "")
        : "off — lykos-repo-map is not in the extensions: list",
      repoMap.enabled && repoMap.text.length > 0,
      "extensions: without lykos-repo-map",
      repoMap.text,
    ),
  ];

  // T21 freezes context files only when the prompt diet is on — the same
  // condition that gates agentsFilesOverride, not a separate one.
  const ingested = dietEnabled ? ingestContextFiles({ cwd: hostCwd }) : [];
  const contextFiles: HeadContextFile[] = contextFileMeta(ingested).map((meta) => ({
    path: meta.path,
    name: meta.name,
    kind: meta.kind,
    bytes: meta.bytes,
    // Same chars/4 basis as every other token figure here; a context file
    // enters the prompt as text, so the byte count is the input.
    tokens: Math.ceil(meta.bytes / 4),
  }));

  const toolset = measureToolset(toolNames);
  const toolResultMaxBytes = toolResultMaxBytesFromEnv(env);

  const headTokens = blocks.filter((b) => b.enabled).reduce((n, b) => n + b.tokens, 0);
  const contextTokens = contextFiles.reduce((n, f) => n + f.tokens, 0);
  const schemaTokens = toolset.tokens;

  let specialistStreamMsg = opts.specialistStreamMessage;
  if (
    specialistStreamMsg === undefined &&
    opts.neutralHead &&
    (opts.specialistName !== undefined || opts.specialistInstructions !== undefined)
  ) {
    specialistStreamMsg = specialistStreamMessage({
      name: opts.specialistName ?? "build",
      ...(opts.specialistInstructions !== undefined ? { instructions: opts.specialistInstructions } : {}),
      modeLabel: opts.modeLabel ?? "Manual",
    });
  }

  return {
    environment,
    blocks,
    bootFields: bootFieldValues(bootArtifacts),
    contextFiles,
    contextFilesEnabled: dietEnabled,
    toolset,
    toolResultMaxBytes,
    tokensBasis: SCHEMA_TOKENS_BASIS,
    fingerprints: {
      bootHead: fingerprintHead(bootHead, toolNames),
      note:
        "boot-block scope only. calls.prefix_fingerprint hashes Pi's FULL assembled system prompt " +
        "(Pi's own base included) plus the active tool names, and Pi's base is not readable from the " +
        "host — so the two values differ by construction and a difference between them is not drift. " +
        "What is checkable here is the block text T18 names when it does fire.",
    },
    totals: {
      headTokens,
      contextTokens,
      schemaTokens,
      total: schemaTokens === null ? null : headTokens + contextTokens + schemaTokens,
    },
    ...(specialistStreamMsg !== undefined ? { specialistStreamMessage: specialistStreamMsg } : {}),
  };
}
