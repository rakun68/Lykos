// Project identity (T8.2, docs/08-sessions-and-archive.md §1 and §4).
//
// A project is identified by its git remote where one exists, and otherwise
// by root path plus the first commit's SHA — so a repository that gets
// moved or renamed is still recognised as the same project. Registered in
// ~/.lykos/projects.json by `lykos init`, repaired by `lykos doctor`.
//
// This module never touches a project's own ledger; lykos/ledger/ingest.ts
// wires resolveProject() into Ledger.ensureProject() so each ledger carries a
// local mirror of the one project row it needs as a FK target.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hostGit } from "../git/host-git.js";
import { defaultWorktreesRoot } from "../git/worktree.js";

export interface ProjectRecord {
  id: string;
  root_path: string;
  git_remote: string | null;
  first_commit: string | null;
  name: string | null;
  created_utc: string;
  last_seen_utc: string | null;
}

interface Registry {
  version: 1;
  projects: ProjectRecord[];
}

export interface ResolveProjectResult {
  id: string;
  created: boolean;
  /** root_path was stale (project moved/renamed) and has been corrected. */
  repaired: boolean;
  record: ProjectRecord;
}

function git(args: string[], cwd: string): string | undefined {
  // T170: through the host git helper, so a repository's hooks and fsmonitor
  // never run. A failing call (no remote, not a repo, no commits yet) is an
  // EXPECTED outcome here and is simply undefined; the helper captures git's
  // own stderr so none of it reaches the terminal.
  const run = hostGit(args, cwd);
  return run.ok && run.stdout.length > 0 ? run.stdout : undefined;
}

export function detectGitRemote(workspace: string): string | undefined {
  return git(["remote", "get-url", "origin"], workspace);
}

export function detectFirstCommit(workspace: string): string | undefined {
  const out = git(["rev-list", "--max-parents=0", "HEAD"], workspace);
  // A history with multiple roots (rare — e.g. a merged-in unrelated
  // history) lists more than one; the first line is stable across a normal
  // linear history and good enough for identity.
  return out?.split("\n")[0]?.trim() || undefined;
}

export function currentGitCommit(workspace: string): string | undefined {
  return git(["rev-parse", "HEAD"], workspace);
}

export function isGitDirty(workspace: string): boolean {
  return git(["status", "--porcelain"], workspace) !== undefined;
}

/** Exact status text used to distinguish a real tree change from a no-op edit. */
export function gitStatus(workspace: string): string | undefined {
  return git(["status", "--porcelain=v1", "--untracked-files=all"], workspace);
}

export function defaultRegistryPath(globalDir?: string): string {
  return join(globalDir ?? join(homedir(), ".lykos"), "projects.json");
}

function loadRegistry(path: string): Registry {
  if (!existsSync(path)) return { version: 1, projects: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Registry>;
    return { version: 1, projects: Array.isArray(parsed.projects) ? parsed.projects : [] };
  } catch {
    // The registry is a rebuildable cache (docs/08 §4), not the ledger —
    // recover by starting empty rather than throwing away a person's session.
    return { version: 1, projects: [] };
  }
}

function saveRegistry(path: string, registry: Registry): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
}

/**
 * Every project the registry knows about, newest-seen first.
 *
 * T58's `--all` is the first caller: the picker fans out across per-project
 * ledgers rather than reading a cross-project index, which is `08` §8's
 * answer ("ten projects is ten small SQLite opens") and the reason
 * `index.db` is explicitly not in this phase.
 */
export function listProjects(opts?: { registryPath?: string }): ProjectRecord[] {
  const registry = loadRegistry(opts?.registryPath ?? defaultRegistryPath());
  return registry.projects
    .slice()
    .sort((a, b) => (b.last_seen_utc ?? b.created_utc).localeCompare(a.last_seen_utc ?? a.created_utc));
}

/** Lykos's own worktrees (T184) are places a session works, never where the project lives. */
function isLykosWorktree(workspace: string): boolean {
  const rel = relative(resolve(defaultWorktreesRoot()), resolve(workspace));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Find-or-create the project identity for `workspace`. Matches by git
 * remote first, then by first-commit SHA — never by root_path alone, since
 * a path match proves nothing about identity and a remote/commit match is
 * exactly what lets a moved or renamed checkout repair itself.
 */
export function resolveProject(
  workspace: string,
  opts?: { registryPath?: string },
): ResolveProjectResult {
  const path = opts?.registryPath ?? defaultRegistryPath();
  const registry = loadRegistry(path);
  const gitRemote = detectGitRemote(workspace) ?? null;
  const firstCommit = detectFirstCommit(workspace) ?? null;
  const now = new Date().toISOString();

  const match =
    (gitRemote ? registry.projects.find((p) => p.git_remote === gitRemote) : undefined) ??
    (firstCommit ? registry.projects.find((p) => p.first_commit === firstCommit) : undefined);

  if (match) {
    const linked = isLykosWorktree(workspace);
    const repaired = match.root_path !== workspace && !linked;
    if (!linked) match.root_path = workspace;
    match.last_seen_utc = now;
    saveRegistry(path, registry);
    return { id: match.id, created: false, repaired, record: { ...match } };
  }

  const record: ProjectRecord = {
    id: randomUUID(),
    root_path: workspace,
    git_remote: gitRemote,
    first_commit: firstCommit,
    name: basename(workspace),
    created_utc: now,
    last_seen_utc: now,
  };
  registry.projects.push(record);
  saveRegistry(path, registry);
  return { id: record.id, created: true, repaired: false, record };
}

/**
 * T113 (docs/29 §2): audit the whole registry, not just the project the
 * caller happens to be standing in.
 *
 * `resolveProject()` already self-heals the ONE row it touches — that is why
 * every session registers itself without `lykos init` ever running (the call
 * sits in `ledger/ingest.ts`, so a session that ingests is a session that
 * registered). What nothing has ever looked at is the rest of the file: a
 * checkout that was deleted, a project whose ledger is gone, or two rows that
 * claim the same identity because one was written before its remote existed.
 *
 * **It reports and never deletes.** A missing root is far more often an
 * unmounted drive or a detached external disk than a dead project, and
 * `08-sessions-and-archive.md` §4's "the registry is a rebuildable cache"
 * cuts the other way here: a cache may be rebuilt, but a row that is silently
 * dropped takes a project's history out of the cross-project browser (T115)
 * with no trace of why.
 */
export interface RegistryAudit {
  total: number;
  /** root_path no longer exists on disk. */
  missingRoot: ProjectRecord[];
  /** The project's own `.lykos/ledger.db` is absent — registered but never run, or moved. */
  missingLedger: ProjectRecord[];
  /** Two or more rows sharing a git remote or first commit: one identity, several ids. */
  duplicateIdentities: ProjectRecord[][];
}

export function auditRegistry(opts?: { registryPath?: string }): RegistryAudit {
  const projects = listProjects(opts?.registryPath !== undefined ? { registryPath: opts.registryPath } : {});
  const missingRoot: ProjectRecord[] = [];
  const missingLedger: ProjectRecord[] = [];
  for (const p of projects) {
    if (!existsSync(p.root_path)) {
      missingRoot.push(p);
      // A row whose root is gone cannot be asked about its ledger; reporting
      // it under both headings would double-count one fact.
      continue;
    }
    if (!existsSync(join(p.root_path, ".lykos", "ledger.db"))) missingLedger.push(p);
  }

  const byKey = new Map<string, ProjectRecord[]>();
  for (const p of projects) {
    // Match on the same two keys resolveProject() matches on, in the same
    // order, so a duplicate reported here is exactly a duplicate that would
    // have been prevented had both rows been written by today's code.
    const key = p.git_remote ? `remote:${p.git_remote}` : p.first_commit ? `commit:${p.first_commit}` : null;
    if (key === null) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(p);
    else byKey.set(key, [p]);
  }

  return {
    total: projects.length,
    missingRoot,
    missingLedger,
    duplicateIdentities: [...byKey.values()].filter((g) => g.length > 1),
  };
}
