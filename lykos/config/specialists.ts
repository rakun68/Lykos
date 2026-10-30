// Specialist discovery and resolution into the sixth config layer, for all
// eighteen fields (ADR-0015).
//
// A specialist is a named, file-backed YAML document. It is discovered in three
// locations, the same global/project split `config/load.ts` already uses for
// `config.yaml` plus a repo-shipped library:
//
//   <lykos>/specialists/<name>.yaml       (the shipped library — lowest priority)
//   <globalDir>/specialists/<name>.yaml   (e.g. ~/.lykos/specialists/<name>.yaml)
//   <cwd>/.lykos/specialists/<name>.yaml
//
// Precedence by name is shipped < global < project (spec: "my project's
// specialists override the global ones by name", and both override the shipped
// library), so a repository can carry its own opinion without touching the
// user's global roster or the shipped files. The shipped library is what
// makes `lykos run --specialist minimal` work with zero user configuration
// while every specialist stays copyable as a starting point.
//
// **The vocabulary is closed at nineteen** (spec, "The shape of a specialist";
// ADR-0015, ADR-0023, ADR-0037). `SPECIALIST_FIELD_NAMES` is the single list
// every check below reads from — a key not in it is rejected naming itself, and
// `specialists.test.ts` asserts its length against the spec's own table so the
// count the spec once got wrong (nine, then twelve while the table listed
// fourteen) cannot drift again silently.
//
// **Seventeen fields are live** (resolve into `ConfigFile` and reach the
// session): `instructions` (ticket 01), `provider`, `model`, `thinkingLevel`,
// `tools`, `read_only`, `role`, `skills`, `feedback`, `gate`, `tools_add`, `tools_remove`,
// `description`, `prompt_mode` and `tools_mode` (band 2 tickets 01 and 02),
// `delegate`, which band 2 ticket 04 made mean something — a specialist
// declaring `delegate: false` is refused as a subagent, and `containment`
// (T177, ADR-0037). **Two are accepted, validated and inert**: `rules` (P11) and
// `memory` (P10) — accepting them now means the file format does not change when
// each phase lands.
//
// Fifteen plus two is the seventeen ADR-0023 fixes, and `containment` (ADR-0037) is the eighteenth, and `read_only` replaces `mode` while `role` is added (ADR-0043, T214), making nineteen. This comment stated eleven
// while listing twelve, which is the same stated-versus-listed drift ADR-0015
// exists to prevent; the count here is now the one `INERT_FIELDS` and
// `SPECIALIST_FIELD_NAMES` actually implement. A specialist that sets one gets a
// notice on the returned `ConfigLayer`, not silence and not an error.
//
// **Availability checks are split by what is actually checkable here.**
// `mode` and every tool name are validated synchronously against the real,
// local registries (`gate/modes.ts`, `tools.ts`'s `TOOL_RISKS`) — cheap and
// exact, so they are checked here. `provider`/`model` are NOT re-validated
// here: the SDK's own model registry is only assembled after
// `ModelRuntime.create()`, downstream of config loading and asynchronous, and
// duplicating it here would be a second, weaker copy of `resolveHostModel`'s
// own check (`session/session.ts`) — which already throws a clear error
// ("is not in the SDK's model registry") before any agent turn runs. That
// satisfies "rejected at selection time" in the sense that matters: before
// the session does anything, not literally inside this function.
//
// **Volatile content is rejected here, at load**, not later at prompt
// assembly — the spec is explicit that a specialist whose instructions embed a
// timestamp, a git status, or a session overview is rejected before it ever
// reaches a session. `detectVolatile` is the same detector the cache-stable
// head contract already uses (`session/head-contract.ts`), reused rather
// than reimplemented.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gateRerunCommandProblem } from "../gate/rerun-failures.js";
import { TOOL_REGISTRY, TOOL_RISKS, canonicalToolName } from "../tools.js";
import { detectVolatile } from "../session/head-contract.js";
import { discoverSkillNames } from "../session/skills.js";
import { readYamlObjectFile } from "./yaml-file.js";
import type { ConfigFile, ConfigLayer, ThinkingLevel, SpecialistMode } from "./types.js";

export type { SpecialistMode } from "./types.js";
export const SPECIALIST_MODES: readonly SpecialistMode[] = ["append", "override"];

export type SpecialistRole = "primary" | "subagent" | "all";
export const SPECIALIST_ROLES: readonly SpecialistRole[] = ["primary", "subagent", "all"];

export const DEFAULT_SPECIALIST = "build";

export const DELETED_SPECIALIST_REPLACEMENTS: Readonly<Record<string, string>> = {
  minimal: "build",
  deliberate: "build",
  scout: "explore",
};

export const SPECIALISTS_DIRNAME = "specialists";

/**
 * The closed vocabulary (spec, "The shape of a specialist" table; ADR-0015, ADR-0023, ADR-0043).
 * Exactly nineteen (T214 replaced `mode` with `read_only` and `role`) — `specialists.test.ts`
 * pins the count against the spec's own table rather than against this constant, so the two cannot
 * silently agree with each other while both being wrong.
 */
export const SPECIALIST_FIELD_NAMES = [
  "provider",
  "model",
  "thinkingLevel",
  "tools",
  "instructions",
  "read_only",
  "role",
  "skills",
  "feedback",
  "gate",
  "tools_add",
  "tools_remove",
  "description",
  "prompt_mode",
  "tools_mode",
  "rules",
  "delegate",
  "memory",
  "containment",
] as const;

/** The two fields accepted, validated and inert until their owning phase lands. */
const INERT_FIELDS: Record<string, string> = {
  rules: "P11 (stream rules)",
  memory: "P10 (memory backend choice)",
};

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * The directory name this concept used before ADR-0020 reverted its name to
 * "specialist". P2 shipped `profiles/` on 2026-09-11 and the rename landed days
 * later, so a user's directory may still carry the old name.
 */
export const LEGACY_SPECIALISTS_DIRNAME = "profiles";

/** Emitted once per legacy directory so a resolve loop cannot spam the notice. */
const legacyNoticesGiven = new Set<string>();

/**
 * Resolve a user-writable specialist directory, falling back to the pre-ADR-0020
 * `profiles/` name when that is the only one present. The new name wins whenever
 * it exists, so a user who has migrated never sees the old directory again, and
 * a user who has not is told once rather than being failed.
 */
function withLegacyFallback(parent: string): string {
  const current = join(parent, SPECIALISTS_DIRNAME);
  if (existsSync(current)) return current;
  const legacy = join(parent, LEGACY_SPECIALISTS_DIRNAME);
  if (!existsSync(legacy)) return current;
  if (!legacyNoticesGiven.has(legacy)) {
    legacyNoticesGiven.add(legacy);
    process.stderr.write(
      `lykos: reading specialists from "${legacy}" — that directory is now called "${SPECIALISTS_DIRNAME}" (ADR-0020). Rename it to silence this notice.\n`,
    );
  }
  return legacy;
}

/** `.lykos/specialists` — the project-local location. */
export function projectSpecialistsDir(cwd: string): string {
  return withLegacyFallback(join(cwd, ".lykos"));
}

/** `<globalDir>/specialists` — e.g. `~/.lykos/specialists`. */
export function globalSpecialistsDir(globalDir: string): string {
  return withLegacyFallback(globalDir);
}

/**
 * The repo-shipped specialist library — `<lykos>/specialists`, i.e. this package's
 * own `specialists/` directory next to `config/`. The lowest-precedence
 * discovery source (shipped < global < project), so `--specialist minimal`
 * works with zero user configuration and every shipped specialist stays
 * copyable as a starting point (spec story 23, ticket 07).
 */
export function shippedSpecialistsDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", SPECIALISTS_DIRNAME);
}

/**
 * The shape of a specialist file on disk — all nineteen fields (ADR-0015, ADR-0023, ADR-0037, ADR-0043).
 * Every field is optional: "declares only the fields it cares about" (spec story
 * 20), and an absent field inherits from the layer below rather than
 * resetting to a default.
 */
export interface SpecialistFile {
  // Pi-compatible five.
  provider?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  tools?: string[];
  /**
   * Appended after the always-on ponytail block by default (`prompt_mode: append`).
   * A specialist with `prompt_mode: override` replaces the ponytail block entirely.
   * A value whose FIRST LINE is exactly `PONYTAIL_REPLACE_MARKER`
   * (`session/ponytail-head.ts`) also replaces the ponytail block; that is the
   * older spelling from before `prompt_mode` existed, kept for backward compatibility.
   */
  instructions?: string;
  // Lykos live ten (description counted once, below).
  read_only?: boolean;
  role?: SpecialistRole;
  skills?: string[];
  feedback?: { enabled?: boolean; command?: string; timeout_seconds?: number; max_output_bytes?: number; slow_disable_seconds?: number };
  gate?: {
    enabled?: boolean;
    command?: string;
    timeout_seconds?: number;
    gate_read_only_sessions?: boolean;
    rerun_failures?: boolean;
    rerun_command?: string;
  };
  tools_add?: string[];
  tools_remove?: string[];
  description?: string;
  // Mode controls (band 2).
  prompt_mode?: SpecialistMode;
  tools_mode?: SpecialistMode;
  // Accepted, validated, inert (see module doc comment).
  rules?: string[];
  delegate?: boolean;
  memory?: string;
  /** ADR-0037: where this specialist's commands run. Every sub-key is optional; unset means no opinion. */
  containment?: { level?: "off" | "auto" | "required"; network?: "open" | "none"; image?: string };
}

export function specialistRole(file: SpecialistFile): SpecialistRole {
  return file.role ?? "all";
}

/** One specialist's resolved location, before its content is read. */
export interface SpecialistLocation {
  name: string;
  /** Present when a repo-shipped file exists; lowest precedence by name (ticket 07). */
  shippedPath?: string;
  /** Present when a project-local file exists; this always wins by name. */
  projectPath?: string;
  /** Present when a global file exists. */
  globalPath?: string;
  /** Specialists ticket 02: the specialist's one-line `description`, when it has one — "appears when specialists are listed" (ticket 02 checkbox). */
  description?: string;
  /** T214/T215: role of the specialist (primary | subagent | all). Defaults to "all". */
  role?: SpecialistRole;
  /** T222: whether this specialist is configured as read-only. */
  read_only?: boolean;
  /** T222: whether the file could not be read or has an invalid role. */
  unreadable?: boolean;
}

/** T222: the MCP tool name a specialist is served under, `lykos_<name>` in the MCP tool-name alphabet. */
export function specialistToolName(name: string): string {
  return "lykos_" + name.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** T223: the four asynchronous orchestration MCP tool names. */
export const ASYNC_TOOL_NAMES: ReadonlySet<string> = new Set(["lykos_start", "lykos_status", "lykos_steer", "lykos_stop"]);

/** Whether a tool name matches one of the reserved asynchronous orchestration tools. */
export function isReservedAsyncTool(toolName: string): boolean {
  return ASYNC_TOOL_NAMES.has(toolName);
}

/**
 * Resolves collisions when multiple specialists sanitize to the same MCP tool name.
 * Exact raw name matching the sanitized suffix wins first; otherwise alphabetical precedence.
 */
export function resolveToolCollision(candidates: SpecialistLocation[]): SpecialistLocation {
  if (candidates.length === 1) return candidates[0]!;
  const rawEqualsSanitised = candidates.find((c) => specialistToolName(c.name) === "lykos_" + c.name);
  if (rawEqualsSanitised) return rawEqualsSanitised;
  const sorted = [...candidates].sort((a, b) => a.name.localeCompare(b.name));
  return sorted[0]!;
}

/**
 * Groups discovered subagent/all specialists by their sanitized MCP tool name and selects
 * one deterministic winner per tool name using `resolveToolCollision`.
 */
export function resolveSpecialistToolWinners(specialists: SpecialistLocation[]): Map<string, SpecialistLocation> {
  const eligible = specialists.filter((loc) => !loc.unreadable && (loc.role === "subagent" || loc.role === "all"));
  const byToolName = new Map<string, SpecialistLocation[]>();
  for (const loc of eligible) {
    const toolName = specialistToolName(loc.name);
    const list = byToolName.get(toolName) ?? [];
    list.push(loc);
    byToolName.set(toolName, list);
  }

  const winningSpecialists = new Map<string, SpecialistLocation>();
  for (const [toolName, candidates] of byToolName) {
    winningSpecialists.set(toolName, resolveToolCollision(candidates));
  }
  return winningSpecialists;
}

function listYamlNames(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
      .map((e) => e.name.replace(/\.ya?ml$/, ""));
  } catch {
    return [];
  }
}

function findSpecialistPath(dir: string, name: string): string | undefined {
  for (const ext of [".yaml", ".yml"]) {
    const path = join(dir, `${name}${ext}`);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * Every specialist name discoverable from any of the three locations,
 * deduplicated and sorted, with shipped < global < project precedence by
 * name. Used both for `lykos specialist list` (ticket 04) and for the "here is
 * what does exist" half of the not-found error below.
 *
 * `shippedDir` defaults to the repo-shipped library (`shippedSpecialistsDir()`)
 * so the five shipped specialists are discoverable with zero user config; a
 * test passes an isolated (empty) directory to observe only the global and
 * project sources.
 */
export function discoverSpecialists(cwd: string, globalDir: string, shippedDir: string = shippedSpecialistsDir()): SpecialistLocation[] {
  const globalDirPath = globalSpecialistsDir(globalDir);
  const projectDirPath = projectSpecialistsDir(cwd);
  const byName = new Map<string, SpecialistLocation>();
  // Lowest precedence first, so later (higher-precedence) sources overwrite
  // the path for a name already seen.
  for (const name of listYamlNames(shippedDir)) {
    const shippedPath = findSpecialistPath(shippedDir, name);
    byName.set(name, { name, ...(shippedPath !== undefined ? { shippedPath } : {}) });
  }
  for (const name of listYamlNames(globalDirPath)) {
    const existing = byName.get(name);
    const globalPath = findSpecialistPath(globalDirPath, name);
    byName.set(name, {
      name,
      ...(existing?.shippedPath !== undefined ? { shippedPath: existing.shippedPath } : {}),
      ...(globalPath !== undefined ? { globalPath } : {}),
    });
  }
  for (const name of listYamlNames(projectDirPath)) {
    const existing = byName.get(name);
    const projectPath = findSpecialistPath(projectDirPath, name);
    byName.set(name, {
      name,
      ...(existing?.shippedPath !== undefined ? { shippedPath: existing.shippedPath } : {}),
      ...(existing?.globalPath !== undefined ? { globalPath: existing.globalPath } : {}),
      ...(projectPath !== undefined ? { projectPath } : {}),
    });
  }
  for (const loc of byName.values()) {
    // Highest-precedence path wins by name (same rule as `resolveSpecialistLayer`),
    // so its description is the one read when more than one source carries the name.
    const path = loc.projectPath ?? loc.globalPath ?? loc.shippedPath;
    if (!path) continue;
    try {
      const raw = readYamlObjectFile(path) as SpecialistFile;
      if (typeof raw.description === "string") loc.description = raw.description;
      if (raw.role !== undefined) {
        if (typeof raw.role === "string" && SPECIALIST_ROLES.includes(raw.role as SpecialistRole)) {
          loc.role = raw.role as SpecialistRole;
        } else {
          loc.unreadable = true;
        }
      } else {
        loc.role = "all";
      }
      if (typeof raw.read_only === "boolean") {
        loc.read_only = raw.read_only;
      }
    } catch {
      loc.unreadable = true;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The discovered specialists whose role is primary or all, sorted with build
 * and plan first, then remaining alphabetically.
 * Skips invalid entries safely so Shift+Tab never throws.
 */
export function primarySpecialists(
  cwd: string,
  globalDir: string,
  shippedDir: string = shippedSpecialistsDir(),
): string[] {
  const discovered = discoverSpecialists(cwd, globalDir, shippedDir);
  const primaries: string[] = [];
  for (const loc of discovered) {
    const path = loc.projectPath ?? loc.globalPath ?? loc.shippedPath;
    if (!path) continue;
    try {
      const raw = readYamlObjectFile(path) as Record<string, unknown>;
      const role = raw.role;
      if (role !== undefined && role !== "primary" && role !== "subagent" && role !== "all") {
        continue;
      }
      const effectiveRole = role ?? "all";
      if (effectiveRole === "primary" || effectiveRole === "all") {
        primaries.push(loc.name);
      }
    } catch {
      continue;
    }
  }

  const remaining = primaries.filter((n) => n !== "build" && n !== "plan").sort();
  const sorted: string[] = [];
  if (primaries.includes("build")) sorted.push("build");
  if (primaries.includes("plan")) sorted.push("plan");
  sorted.push(...remaining);
  return sorted;
}

/** Thrown by `resolveSpecialistLayer` when the named specialist exists nowhere. */
export class SpecialistNotFoundError extends Error {
  constructor(name: string, available: readonly string[]) {
    const list = available.length > 0 ? available.join(", ") : "(none discovered)";
    const replacement = DELETED_SPECIALIST_REPLACEMENTS[name];
    const message = replacement
      ? `lykos: specialist "${name}" was removed; use "${replacement}" instead — available specialists: ${list}`
      : `lykos: no specialist named "${name}" — available specialists: ${list}`;
    super(message);
    this.name = "SpecialistNotFoundError";
  }
}

/** Thrown when a specialist file's content is invalid — e.g. volatile instructions. */
export class SpecialistValidationError extends Error {
  constructor(name: string, path: string, reason: string) {
    super(`lykos: specialist "${name}" (${path}) is invalid — ${reason}`);
    this.name = "SpecialistValidationError";
  }
}

function fail(name: string, path: string, reason: string): never {
  throw new SpecialistValidationError(name, path, reason);
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Resolve one specialist by name: project wins over global, which wins over the
 * shipped library (spec: "my project's specialists override the global ones by
 * name"; ticket 07 adds shipped as the lowest rung). Throws
 * `SpecialistNotFoundError` naming every specialist that DOES exist, and
 * `SpecialistValidationError` for any of: an unrecognised field name, a
 * wrong-shaped value, volatile instructions, an unknown tool, invalid read_only,
 * or invalid role. Every check runs against the whole file before anything
 * is applied, so a specialist is validated as a unit rather than partially.
 */
export interface ResolvedSpecialist {
  path: string;
  file: SpecialistFile;
  layer: ConfigLayer;
}

export function resolveSpecialist(
  name: string,
  cwd: string,
  globalDir?: string,
  shippedDir: string = shippedSpecialistsDir(),
): ResolvedSpecialist {
  const resolvedGlobal = globalDir ?? join(homedir(), ".lykos");
  const shippedPath = findSpecialistPath(shippedDir, name);
  const projectPath = findSpecialistPath(projectSpecialistsDir(cwd), name);
  const globalPath = findSpecialistPath(globalSpecialistsDir(resolvedGlobal), name);
  const path = projectPath ?? globalPath ?? shippedPath;
  if (path === undefined) {
    const available = discoverSpecialists(cwd, resolvedGlobal, shippedDir).map((p) => p.name);
    throw new SpecialistNotFoundError(name, available);
  }

  const raw = readYamlObjectFile(path) as Record<string, unknown>;

  // T214 (ADR-0043): mode was replaced by read_only and role.
  if ("mode" in raw) {
    fail(
      name,
      path,
      `"mode" is no longer a specialist field — use "read_only: true" instead (T214, ADR-0043)`,
    );
  }

  // ADR-0043 / T214: the vocabulary is nineteen fields. A specialist naming
  // an unknown field is an error, not an extension point.
  for (const key of Object.keys(raw)) {
    if (!(SPECIALIST_FIELD_NAMES as readonly string[]).includes(key)) {
      fail(name, path, `unknown field "${key}" — a specialist may only set: ${SPECIALIST_FIELD_NAMES.join(", ")}`);
    }
  }

  const file = raw as SpecialistFile;
  const value: ConfigFile = {};
  const notices: string[] = [];

  // --- instructions (ticket 01, unchanged validation) ---
  if (file.instructions !== undefined) {
    if (typeof file.instructions !== "string") fail(name, path, "instructions must be a string");
    const volatile = detectVolatile(file.instructions);
    if (volatile.length > 0) {
      fail(
        name,
        path,
        `instructions contain volatile content (${volatile.join(", ")}) — the head is frozen at boot and can never contain a clock, a git status, or a session overview`,
      );
    }
    value.instructions = file.instructions;
  }

  // --- provider / model (Pi-compatible; paired application, not paired validation — see module doc) ---
  if (file.provider !== undefined) {
    if (typeof file.provider !== "string" || file.provider.length === 0) fail(name, path, "provider must be a non-empty string");
    value.provider = file.provider;
  }
  if (file.model !== undefined) {
    if (typeof file.model !== "string" || file.model.length === 0) fail(name, path, "model must be a non-empty string");
    value.model = file.model;
  }

  // --- thinkingLevel ---
  if (file.thinkingLevel !== undefined) {
    if (!THINKING_LEVELS.includes(file.thinkingLevel as ThinkingLevel)) {
      fail(name, path, `thinkingLevel "${file.thinkingLevel}" is not one of: ${THINKING_LEVELS.join(", ")}`);
    }
    value.thinkingLevel = file.thinkingLevel;
  }

  // --- tools / tools_add / tools_remove: validated against the real, local tool registry ---
  const registryByName = new Map(TOOL_REGISTRY.map((e) => [e.name, e]));
  const knownTools = new Set(registryByName.keys());
  const checkToolList = (field: "tools" | "tools_add" | "tools_remove", list: unknown): string[] | undefined => {
    if (list === undefined) return undefined;
    if (!isStringArray(list)) fail(name, path, `${field} must be a list of tool names`);
    const names = list.map(canonicalToolName);
    const unknown = names.filter((t) => !knownTools.has(t));
    if (unknown.length > 0) {
      fail(name, path, `${field} names tool(s) that do not exist in the tool registry: ${unknown.join(", ")} — registry tools: ${[...knownTools].sort().join(", ")}`);
    }
    if (field === "tools_add") {
      for (const t of names) {
        const entry = registryByName.get(t);
        if (entry && entry.residency === "off") {
          fail(
            name,
            path,
            `tools_add cannot add "${t}" — its registry residency is "off" (specialists may not resurrect off tools)`,
          );
        }
      }
    }
    return names;
  };
  const tools = checkToolList("tools", file.tools);
  if (tools !== undefined) value.tools = tools;
  const toolsAdd = checkToolList("tools_add", file.tools_add);
  if (toolsAdd !== undefined) value.tools_add = toolsAdd;
  const toolsRemove = checkToolList("tools_remove", file.tools_remove);
  if (toolsRemove !== undefined) {
    value.tools_remove = toolsRemove;
    // Ticket 02: tools_remove still drops a name from the resolved surface.
    // A removed resident tool is not auto-mounted, so listing still says so.
    notices.push(
      `tools_remove (${toolsRemove.join(", ")}) genuinely removes capability this session — P10's mounted-tool transport has not landed, so a removed tool is not reachable any other way`,
    );
  }

  // --- read_only (T214, ADR-0043) ---
  if (file.read_only !== undefined) {
    if (typeof file.read_only !== "boolean") {
      fail(name, path, "read_only must be a boolean");
    }
    value.readOnly = file.read_only;
  }

  // --- role (T214, ADR-0043) ---
  if (file.role !== undefined) {
    if (typeof file.role !== "string" || !SPECIALIST_ROLES.includes(file.role as SpecialistRole)) {
      fail(name, path, `role "${String(file.role)}" is not one of: ${SPECIALIST_ROLES.join(", ")}`);
    }
  }

  // --- skills: a named roster, routed onto the existing SkillsConfig section (ticket 05 owns loading it) ---
  if (file.skills !== undefined) {
    if (!isStringArray(file.skills)) fail(name, path, "skills must be a list of skill names");
    // Specialists ticket 05: a skill named but absent from disk is reported at
    // selection time, naming it — a specialist whose procedure is missing looks
    // identical, from the outside, to one that is working, so silence here is
    // the one failure mode that matters most. Compared against the SAME names
    // Pi's loader produces (frontmatter `name`, else parent dir name) via
    // `discoverSkillNames`, so a roster entry that would silently drop in
    // `filterSkillsByRoster` instead fails the selection.
    const available = discoverSkillNames(cwd);
    const missing = file.skills.filter((s) => !available.includes(s));
    if (missing.length > 0) {
      fail(
        name,
        path,
        `skills name(s) not found on disk: ${missing.join(", ")} — available skills: ${
          available.length > 0 ? available.join(", ") : "(none)"
        }`,
      );
    }
    value.skills = { roster: file.skills };
  }

  // --- feedback / gate: pass through onto the sections T99/T100 already merge ---
  if (file.feedback !== undefined) {
    if (typeof file.feedback !== "object" || file.feedback === null || Array.isArray(file.feedback)) {
      fail(name, path, "feedback must be an object");
    }
    if (file.feedback.enabled !== undefined && typeof file.feedback.enabled !== "boolean") {
      fail(name, path, "feedback.enabled must be a boolean");
    }
    value.feedback = file.feedback;
  }
  if (file.gate !== undefined) {
    if (typeof file.gate !== "object" || file.gate === null || Array.isArray(file.gate)) {
      fail(name, path, "gate must be an object");
    }
    if (file.gate.enabled !== undefined && typeof file.gate.enabled !== "boolean") {
      fail(name, path, "gate.enabled must be a boolean");
    }
    if (file.gate.rerun_failures !== undefined && typeof file.gate.rerun_failures !== "boolean") {
      fail(name, path, "gate.rerun_failures must be a boolean");
    }
    if (file.gate.rerun_command !== undefined) {
      const err = gateRerunCommandProblem(file.gate.rerun_command);
      if (err !== undefined) fail(name, path, err);
    }
    value.gate = file.gate;
  }

  // --- description ---
  if (file.description !== undefined) {
    if (typeof file.description !== "string") fail(name, path, "description must be a string");
    value.description = file.description;
  }

  // --- prompt_mode (band 2 ticket 01) ---
  if (file.prompt_mode !== undefined) {
    if (!SPECIALIST_MODES.includes(file.prompt_mode as SpecialistMode)) {
      fail(name, path, `prompt_mode "${file.prompt_mode}" is not one of: ${SPECIALIST_MODES.join(", ")}`);
    }
    value.prompt_mode = file.prompt_mode;
  }

  // --- tools_mode (band 2 ticket 02) ---
  if (file.tools_mode !== undefined) {
    if (!SPECIALIST_MODES.includes(file.tools_mode as SpecialistMode)) {
      fail(name, path, `tools_mode "${file.tools_mode}" is not one of: ${SPECIALIST_MODES.join(", ")}`);
    }
    value.tools_mode = file.tools_mode;
  }

  // --- containment (ADR-0037): the three sub-keys a specialist may have an opinion on ---
  if (file.containment !== undefined) {
    const c: unknown = file.containment;
    if (typeof c !== "object" || c === null || Array.isArray(c)) fail(name, path, "containment must be an object with level, network and image");
    const known = ["level", "network", "image"];
    for (const key of Object.keys(c)) {
      if (!known.includes(key)) fail(name, path, `containment.${key} is not a specialist setting — a specialist may only set containment.${known.join(", containment.")}`);
    }
    const { level, network, image } = c as Record<string, unknown>;
    if (level !== undefined && level !== "off" && level !== "auto" && level !== "required") {
      fail(name, path, `containment.level "${String(level)}" is not one of: off, auto, required`);
    }
    if (network !== undefined && network !== "open" && network !== "none") {
      fail(name, path, `containment.network "${String(network)}" is not one of: open, none`);
    }
    if (image !== undefined && (typeof image !== "string" || image.trim() === "")) fail(name, path, "containment.image must be a non-empty string");
    value.containment = {
      ...(level !== undefined ? { level } : {}),
      ...(network !== undefined ? { network } : {}),
      ...(image !== undefined ? { image: image as string } : {}),
    };
  }

  // --- inert: rules / memory (accepted, validated, never merged into ResolvedConfig) ---
  if (file.rules !== undefined && !isStringArray(file.rules)) fail(name, path, "rules must be a list of strings");
  if (file.delegate !== undefined && typeof file.delegate !== "boolean") fail(name, path, "delegate must be a boolean");
  if (file.memory !== undefined && typeof file.memory !== "string") fail(name, path, "memory must be a string");
  for (const field of ["rules", "memory"] as const) {
    if (file[field] !== undefined) {
      notices.push(`"${field}" is accepted and validated but has no effect yet — it is consumed starting ${INERT_FIELDS[field]}`);
    }
  }

  const layer: ConfigLayer = {
    name: "specialist",
    path,
    present: true,
    value,
    ...(notices.length > 0 ? { notices } : {}),
  };

  return { path, file, layer };
}

export function resolveSpecialistLayer(
  name: string,
  cwd: string,
  globalDir: string,
  shippedDir: string = shippedSpecialistsDir(),
): ConfigLayer {
  return resolveSpecialist(name, cwd, globalDir, shippedDir).layer;
}
