// The approvals Lykos remembers, and the mode a project was last driven in.
//
// **Why this exists.** Auto mode is supposed to reach zero prompts, and the
// mechanism that gets there is an allowlist that learns. What Lykos had
// instead was `alwaysAllowed: Set<GatedToolKind>` in `approval.ts` — a
// per-process set of three tool KINDS, so answering "always" to one `npm
// test` meant "never ask about any bash command again", and only until the
// process exited. Both too blunt to be safe and too forgetful to stop being
// annoying. This replaces the durable half of that: a per-project set of
// command PATTERNS (`npm test`, `git commit` — see `command-safety.ts`)
// that survives a restart.
//
// **Shape and location are copied from `trust.ts` on purpose.** Same global
// directory, same `{ version, projects: { [projectId]: … } }` layout, same
// project identity from `session/identity.ts`, same "a corrupt file reads
// as empty rather than throwing" rule. Two security stores with two shapes
// would be two things to get right; this way, reviewing one teaches you the
// other.
//
// **It is per project, and that is the trust boundary.** Approving `npm
// test` in a repo you trust must not approve it in one you cloned this
// morning — the same reasoning that made trust itself per project rather
// than global. The file is deliberately plain, sorted, pretty-printed JSON:
// it is a security-relevant list, so it has to be reviewable and editable by
// hand without a command.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseInteractionMode, type InteractionMode } from "./modes.js";
import type { PathAccess, PathDecision } from "./path-rules.js";

interface StoredProject {
  allow?: string[];
  mode?: string;
  extraDirs?: string[];
  outside?: { read?: PathDecision; write?: PathDecision };
  updatedUtc?: string;
}

interface PermissionsFile {
  version: 1;
  projects: Record<string, StoredProject>;
}

export interface PermissionsOptions {
  /** Overridden by tests and by callers that keep a store outside the home directory. */
  permissionsPath?: string;
}

export interface ProjectPermissions {
  /** Command patterns approved with "always" in this project. */
  allow: Set<string>;
  /** The mode this project was last driven in, when one was recorded and is still a real mode. */
  mode?: InteractionMode;
  extraDirs: string[];
  outside: { read: PathDecision; write: PathDecision };
}

export function defaultPermissionsPath(globalDir = join(homedir(), ".lykos")): string {
  return join(globalDir, "permissions.json");
}

function read(path: string): PermissionsFile {
  if (!existsSync(path)) return { version: 1, projects: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PermissionsFile>;
    return {
      version: 1,
      projects: parsed.projects && typeof parsed.projects === "object" ? parsed.projects : {},
    };
  } catch {
    // Same rule as `trust.ts`: a store Lykos cannot parse is a store with
    // nothing approved in it. Failing closed here means extra prompts, which
    // is the right direction to fail for a permission file.
    return { version: 1, projects: {} };
  }
}

function write(path: string, file: PermissionsFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

function pathFrom(opts: PermissionsOptions | undefined): string {
  return opts?.permissionsPath ?? defaultPermissionsPath();
}

export function loadPermissions(projectId: string, opts?: PermissionsOptions): ProjectPermissions {
  const stored = read(pathFrom(opts)).projects[projectId];
  const allow = new Set<string>(Array.isArray(stored?.allow) ? stored.allow.filter((a) => typeof a === "string") : []);
  // An unrecognised mode is DROPPED, never mapped onto a current one. A
  // store written before the rename could say `auto-edit` or legacy `plan`/`ask`, and quietly
  // resolving that to `auto` would hand a project a broader permission than
  // anyone chose — the exact hazard the rename created.
  let mode: InteractionMode | undefined;
  if (typeof stored?.mode === "string") {
    const parsed = parseInteractionMode(stored.mode);
    if (parsed.ok) {
      mode = parsed.mode;
    } else {
      process.stderr.write(`lykos: stored permissions for ${projectId}: ${parsed.error}\n`);
    }
  }
  const extraDirs = Array.isArray(stored?.extraDirs)
    ? [...new Set(stored.extraDirs.filter((d) => typeof d === "string"))]
    : [];
  const outsideRead: PathDecision =
    stored?.outside?.read === "allow" || stored?.outside?.read === "ask" || stored?.outside?.read === "deny"
      ? stored.outside.read
      : "ask";
  const outsideWrite: PathDecision =
    stored?.outside?.write === "allow" || stored?.outside?.write === "ask" || stored?.outside?.write === "deny"
      ? stored.outside.write
      : "ask";
  const outside = { read: outsideRead, write: outsideWrite };
  return mode === undefined ? { allow, extraDirs, outside } : { allow, mode, extraDirs, outside };
}

function mutate(projectId: string, opts: PermissionsOptions | undefined, fn: (p: StoredProject) => void): void {
  const path = pathFrom(opts);
  const file = read(path);
  const project = file.projects[projectId] ?? {};
  fn(project);
  project.updatedUtc = new Date().toISOString();
  file.projects[projectId] = project;
  write(path, file);
}

/**
 * Record patterns approved with "always".
 *
 * There is no risk check here, and that is deliberate rather than an
 * oversight: the caller only reaches this when `decideForMode` set
 * `offerAlways`, which is false for destructive commands, and
 * `isAllowlisted` re-checks the destructive tier every time the store is
 * *read*. So even a hand-edited file containing `rm` cannot make `rm -rf`
 * silent. Two independent checks, on the write path and the read path.
 */
export function rememberAllow(projectId: string, patterns: readonly string[], opts?: PermissionsOptions): void {
  if (patterns.length === 0) return;
  mutate(projectId, opts, (project) => {
    const next = new Set(project.allow ?? []);
    for (const p of patterns) next.add(p);
    project.allow = [...next].sort();
  });
}

export function forgetAllow(projectId: string, pattern: string, opts?: PermissionsOptions): void {
  mutate(projectId, opts, (project) => {
    project.allow = (project.allow ?? []).filter((p) => p !== pattern);
  });
}

/** T209 / ADR-0041: clear all remembered command approvals for this project. */
export function clearAllow(projectId: string, opts?: PermissionsOptions): void {
  mutate(projectId, opts, (project) => {
    project.allow = [];
  });
}

export function rememberMode(projectId: string, mode: InteractionMode, opts?: PermissionsOptions): void {
  mutate(projectId, opts, (project) => {
    project.mode = mode;
  });
}

/**
 * T209 / ADR-0041: the starting mode for human-driven sessions in this project.
 * Returns the stored mode, or "manual" when the project has none.
 */
export function startingMode(projectId: string, opts?: PermissionsOptions): InteractionMode {
  return loadPermissions(projectId, opts).mode ?? "manual";
}

export function rememberExtraDir(projectId: string, dir: string, opts?: PermissionsOptions): void {
  mutate(projectId, opts, (project) => {
    const next = new Set(project.extraDirs ?? []);
    next.add(dir);
    project.extraDirs = [...next].sort();
  });
}

/** T209 / ADR-0041: remove a previously remembered extra directory. */
export function forgetExtraDir(projectId: string, dir: string, opts?: PermissionsOptions): void {
  mutate(projectId, opts, (project) => {
    project.extraDirs = (project.extraDirs ?? []).filter((d) => d !== dir);
  });
}

export function rememberOutside(
  projectId: string,
  access: PathAccess,
  decision: PathDecision,
  opts?: PermissionsOptions,
): void {
  mutate(projectId, opts, (project) => {
    project.outside = {
      read: access === "read" ? decision : (project.outside?.read ?? "ask"),
      write: access === "write" ? decision : (project.outside?.write ?? "ask"),
    };
  });
}
