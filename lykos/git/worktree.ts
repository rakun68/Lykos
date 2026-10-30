// The worktree manager (T184, P15, spec old issue 22 stories 42-47, ADR-0036).
//
// A writing delegated session never shares git state with the caller. Each call
// gets a worktree and a `lykos/`-prefixed branch of its own, outside the project
// (`~/.lykos/worktrees/<project id>/<session id>`), so the caller's search,
// compiler and test runner never see a second copy of its files. The worktree is
// removed when the call ends; the branch is never deleted ("nothing it runs is
// ever deleted"). A continuation finds the branch and recreates the worktree
// from it.
//
// One lock per session, held from acquire to release, so two calls on one
// session cannot both hold the worktree. A lock whose owner is gone is taken
// over. Every git call goes through the protected host helper (hooks and
// fsmonitor off), because creating a worktree runs git on the host.
//
// Work the session left uncommitted is committed onto the branch before the
// worktree is removed: removing the directory must not be how work is lost. The
// ignored files it wrote (not caches) are copied to `<session id>.ignored`
// beside the worktree for the same reason, and the result names where.

import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, rmdirSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { hostGit, probeGit, type GitRun } from "./host-git.js";

export const BRANCH_PREFIX = "lykos/";

/** The branch a session's work is on. */
export function branchOf(sessionId: string): string {
  return `${BRANCH_PREFIX}${sessionId}`;
}

/** `~/.lykos/worktrees`: every project's worktrees live under it. */
export function defaultWorktreesRoot(): string {
  return join(homedir(), ".lykos", "worktrees");
}

export type WorktreeErrorKind = "not-a-repo" | "git-missing" | "busy" | "git";

/** The call cannot have a worktree. The message says why, in the words the caller is shown. */
export class WorktreeError extends Error {
  constructor(
    readonly kind: WorktreeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface CommitSummary {
  sha: string;
  subject: string;
}

/** The commit that saved changes a session left uncommitted, described so it can be recorded like any other. */
export interface SavedCommit {
  sha: string;
  subject: string;
  message: string;
  filesChanged: number | null;
}

export interface AcquireInput {
  /** The caller's tree: a git repository. */
  workspace: string;
  projectId: string;
  sessionId: string;
  /** Where worktrees live. Default: `~/.lykos/worktrees`. */
  root?: string;
  /** The starting branch/commit for a new worktree. Ignored when continuing a session (resumed). */
  base?: string;
}

export interface ReleaseResult {
  /** The worktree directory was removed. False only when git refused and the directory was left in place. */
  removed: boolean;
  /** The session left changes uncommitted, and they were committed onto the branch. */
  savedUncommitted: boolean;
  /** The commit that saved it, described so the caller can record it like any commit the session made. */
  saved?: SavedCommit;
  /** Present when something went wrong that the caller should read. */
  note?: string;
}

export interface WorktreeLease {
  /** The directory the session works in. */
  path: string;
  branch: string;
  /** The caller's HEAD when the call began: the work on the branch is what comes after it. */
  base: string;
  /** True when the branch already existed (a continuation). */
  resumed: boolean;
  /** The main repository's git directory (shared by every worktree of it). */
  commonDir: string;
  /** This worktree's own git directory, inside `commonDir`. */
  gitDir: string;
  /** Commits on the branch the caller's HEAD did not have at the start of the call, newest first. */
  commits(): CommitSummary[];
  /** Ends the call: saves anything left uncommitted, removes the worktree, frees the lock. The branch stays. */
  release(): ReleaseResult;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function takeLock(lockPath: string, sessionId: string): () => void {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      return () => rmSync(lockPath, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = Number(readFileSync(lockPath, "utf8").trim());
      if (Number.isInteger(owner) && owner > 0 && alive(owner)) {
        throw new WorktreeError("busy", `session ${sessionId} is already running a call (pid ${owner}); a session's worktree is held by one call at a time`);
      }
      rmSync(lockPath, { force: true }); // its owner is gone
    }
  }
  throw new WorktreeError("busy", `could not take the lock for session ${sessionId}`);
}

function gitOrThrow(what: string, run: GitRun): string {
  if (!run.ok) throw new WorktreeError("git", `could not ${what}: ${run.stderr || "git failed"}`);
  return run.stdout;
}

/** Identity for the commit that saves leftover work, only when git has none of its own. */
function fallbackIdentity(cwd: string): NodeJS.ProcessEnv {
  const has = hostGit(["config", "user.email"], cwd);
  if (has.ok && has.stdout !== "") return {};
  return { GIT_AUTHOR_NAME: "Lykos", GIT_AUTHOR_EMAIL: "lykos@localhost", GIT_COMMITTER_NAME: "Lykos", GIT_COMMITTER_EMAIL: "lykos@localhost" };
}

/** Takes the session's lock and gives it a worktree on its branch, creating either as needed. Throws `WorktreeError`. */
export function acquireWorktree(input: AcquireInput): WorktreeLease {
  const probe = probeGit(input.workspace);
  if (probe.state !== "repo") {
    throw new WorktreeError(probe.state, probe.state === "git-missing" ? "git is not installed" : "not a git repository");
  }
  const projectDir = join(input.root ?? defaultWorktreesRoot(), input.projectId);
  const path = join(projectDir, input.sessionId);
  const branch = branchOf(input.sessionId);

  const unlock = takeLock(join(projectDir, `${input.sessionId}.lock`), input.sessionId);
  try {
    const resumed = hostGit(["rev-parse", "--verify", "-q", `refs/heads/${branch}`], input.workspace).ok;
    const targetRef = !resumed && input.base !== undefined ? input.base : "HEAD";
    const head = hostGit(["rev-parse", "--verify", "-q", targetRef], input.workspace);
    if (!head.ok || head.stdout === "") {
      throw new WorktreeError(
        "git",
        !resumed && input.base !== undefined
          ? `the base "${input.base}" could not be resolved; make sure the ref exists`
          : "the repository has no commit yet, so there is nothing to branch from; make a first commit",
      );
    }
    const base = head.stdout;

    // A worktree directory a crashed call left behind is still the session's: reuse it, uncommitted work and all.
    hostGit(["worktree", "prune"], input.workspace);
    if (!existsSync(join(path, ".git"))) {
      // Nothing Lykos ran is ever deleted: only an empty directory (its own leftover) is reused. Anything else is the user's.
      if (existsSync(path)) {
        try {
          rmdirSync(path);
        } catch {
          throw new WorktreeError("git", `${path} exists and is not a worktree of this session; move it aside and call again`);
        }
      }
      mkdirSync(projectDir, { recursive: true });
      gitOrThrow(
        "create the worktree",
        hostGit(resumed ? ["worktree", "add", path, branch] : ["worktree", "add", "-b", branch, path, base], input.workspace),
      );
    }

    seedProjectResources(input.workspace, path);
    const inside = probeGit(path);
    const common = hostGit(["rev-parse", "--git-common-dir"], path);
    if (inside.state !== "repo" || inside.gitDir === undefined || !common.ok) {
      throw new WorktreeError("git", `the worktree at ${path} is not usable as a git work tree`);
    }
    const commonDir = resolve(path, common.stdout);

    const lease: WorktreeLease = {
      path,
      branch,
      base,
      resumed,
      commonDir,
      gitDir: inside.gitDir,
      commits() {
        const log = hostGit(["log", "--format=%H%x1f%s", `${base}..${branch}`], input.workspace);
        if (!log.ok || log.stdout === "") return [];
        return log.stdout.split("\n").map((line) => {
          const [sha = "", subject = ""] = line.split("\u001f");
          return { sha, subject };
        });
      },
      release() {
        try {
          return finish(path, input.workspace, input.sessionId, join(projectDir, `${input.sessionId}.ignored`));
        } finally {
          unlock();
        }
      },
    };
    return lease;
  } catch (err) {
    unlock();
    throw err;
  }
}

/**
 * What the project keeps that git does not: its Pi settings and skills and prompts. A session that boots in the
 * worktree would otherwise never see them, as if the project had none. They are copied in when absent, never over
 * a tracked file, and never committed (they are Lykos/Pi state, left out of every commit). The ledger and config
 * stay at the project's root, where the session reads them from.
 */
const PROJECT_RESOURCES = [".pi", join(".lykos", "skills"), join(".lykos", "prompts")] as const;

function seedProjectResources(workspace: string, path: string): void {
  for (const rel of PROJECT_RESOURCES) {
    const from = join(workspace, rel);
    if (!existsSync(from)) continue;
    try {
      cpSync(from, join(path, rel), { recursive: true, force: false, errorOnExist: false });
    } catch {
      // A resource that cannot be copied is as missing as it was; the session still runs.
    }
  }
}

/**
 * Ignored paths that are dependency or build output, rebuilt rather than written by the session, and the Pi and Lykos
 * state carried in. Dependency and tool caches match by name at any depth. `dist`, `build`, `target`, `out` and
 * `coverage` are build output only at the worktree root or in a package root (a directory holding a manifest): a
 * `reports/build/summary.md` is a session's own file. Logs are not caches.
 */
const CACHE_NAMES = new Set(["node_modules", ".cache", ".next", ".nuxt", ".turbo", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".gradle", ".tox"]);
const CACHE_PATTERNS = [/\.egg-info$/, /\.tsbuildinfo$/, /^\.eslintcache$/];
const BUILD_OUTPUT_NAMES = new Set(["dist", "build", "target", "out", "coverage"]);
const PACKAGE_MANIFESTS = ["package.json", "Cargo.toml", "pyproject.toml"];
/** Carried into the worktree, not written by the session: left out without being named. */
const CARRIED = new Set([".pi", ".lykos"]);

/** Whether the ignored path `rel` (forward slashes, relative to the worktree) is a cache itself, not just inside one. */
function isCache(root: string, rel: string): boolean {
  const slash = rel.lastIndexOf("/");
  const name = rel.slice(slash + 1);
  const parent = slash < 0 ? "" : rel.slice(0, slash);
  if (CARRIED.has(name) && parent === "") return true;
  if (CACHE_NAMES.has(name) || CACHE_PATTERNS.some((pattern) => pattern.test(name))) return true;
  return BUILD_OUTPUT_NAMES.has(name) && (parent === "" || PACKAGE_MANIFESTS.some((manifest) => existsSync(join(root, parent, manifest))));
}

/** The shortest prefix of `rel` that is a cache, if any: everything under it is left out with it. */
function cachePrefix(root: string, rel: string): string | undefined {
  const parts = rel.split("/");
  for (let i = 1; i <= parts.length; i += 1) {
    const prefix = parts.slice(0, i).join("/");
    if (isCache(root, prefix)) return prefix;
  }
  return undefined;
}

/** Copies `rel` from the worktree into the archive, leaving caches out (and naming them in `dropped`). Returns the files copied. */
function copyKeeping(root: string, rel: string, archive: string, dropped: Set<string>): number {
  const from = join(root, rel);
  if (!lstatSync(from).isDirectory()) {
    mkdirSync(dirname(join(archive, rel)), { recursive: true });
    cpSync(from, join(archive, rel));
    return 1;
  }
  let copied = 0;
  for (const name of readdirSync(from)) {
    const child = `${rel}/${name}`;
    if (isCache(root, child)) dropped.add(child);
    else copied += copyKeeping(root, child, archive, dropped);
  }
  return copied;
}

/**
 * `worktree remove --force` deletes what git ignores, and nothing Lykos ran is ever deleted. So before the worktree
 * goes, the ignored files the session wrote (a data file, a log, a report) are copied to an archive beside the
 * worktree, caches left out and named. Returns what was done, or undefined when there was nothing to keep. Throws when
 * git cannot list the ignored files or a copy fails, so the caller can keep the worktree.
 */
function archiveIgnored(path: string, archiveBase: string): { archive?: string; files: number; dropped: string[] } | undefined {
  const listed = hostGit(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory"], path);
  if (!listed.ok) throw new Error(`git could not list the ignored files: ${listed.stderr || "git failed"}`);
  const dropped = new Set<string>();
  const entries: string[] = [];
  for (const raw of listed.stdout.split(/\r?\n/)) {
    const entry = raw.replace(/\/$/, "");
    if (entry === "") continue;
    const cache = cachePrefix(path, entry);
    if (cache === undefined) entries.push(entry);
    else dropped.add(cache);
  }
  let archive: string | undefined;
  let copied = 0;
  if (entries.length > 0) {
    archive = archiveBase;
    for (let n = 2; existsSync(archive); n += 1) archive = `${archiveBase}-${n}`;
    for (const entry of entries) copied += copyKeeping(path, entry, archive, dropped);
  }
  const named = [...dropped].filter((rel) => !CARRIED.has(rel)).sort();
  if (copied === 0 && named.length === 0) return undefined;
  return { ...(copied > 0 && archive !== undefined ? { archive } : {}), files: copied, dropped: named };
}

function describeArchive(kept: { archive?: string; files: number; dropped: string[] }): string {
  const saved = kept.archive !== undefined ? `the session wrote files git ignores; ${kept.files} file(s) are saved in ${kept.archive}` : undefined;
  const left = kept.dropped.length > 0 ? `caches left out, not saved: ${kept.dropped.slice(0, 10).join(", ")}${kept.dropped.length > 10 ? `, and ${kept.dropped.length - 10} more` : ""}` : undefined;
  return [saved, left].filter((part): part is string => part !== undefined).join("; ");
}

function finish(path: string, workspace: string, sessionId: string, archiveBase: string): ReleaseResult {
  if (!existsSync(path)) return { removed: true, savedUncommitted: false };
  let savedUncommitted = false;
  let saved: ReleaseResult["saved"];
  let note: string | undefined;
  const subject = `lykos: work left uncommitted when session ${sessionId} ended`;
  const dirty = hostGit(["status", "--porcelain", "--untracked-files=all"], path);
  if (dirty.ok && dirty.stdout !== "") {
    const staged = hostGit(["add", "-A"], path);
    // Lykos's own runtime state is never work: leave it out of the commit, as `commit` does.
    if (staged.ok) hostGit(["reset", "-q", "--", ".lykos", ".pi"], path);
    const made = staged.ok
      ? hostGit(["-c", "commit.gpgsign=false", "commit", "-q", "-m", subject], path, { env: fallbackIdentity(path) })
      : staged;
    // "nothing to commit" after leaving the runtime state out is not a failure.
    const empty = hostGit(["diff", "--cached", "--quiet"], path).ok;
    if (made.ok) {
      savedUncommitted = true;
      const sha = hostGit(["rev-parse", "HEAD"], path);
      const files = hostGit(["show", "--name-only", "--no-renames", "--format=", "HEAD"], path);
      if (sha.ok && sha.stdout !== "") {
        saved = { sha: sha.stdout, subject, message: subject, filesChanged: files.ok ? files.stdout.split(/\r?\n/).filter((l) => l !== "").length : null };
      }
    }
    else if (!empty) note = `could not save the uncommitted work in ${path}: ${made.stderr}; the worktree was left in place`;
  }
  if (note !== undefined) return { removed: false, savedUncommitted, ...(saved ? { saved } : {}), note };
  let kept: ReturnType<typeof archiveIgnored>;
  try {
    kept = archiveIgnored(path, archiveBase);
  } catch (err) {
    return { removed: false, savedUncommitted, ...(saved ? { saved } : {}), note: `could not archive the ignored files the session wrote in ${path}: ${err instanceof Error ? err.message : String(err)}; the worktree was left in place` };
  }
  const archived = kept === undefined ? undefined : describeArchive(kept);
  const removed = hostGit(["worktree", "remove", "--force", path], workspace);
  if (!removed.ok) {
    return { removed: false, savedUncommitted, ...(saved ? { saved } : {}), note: [`could not remove the worktree ${path}: ${removed.stderr}`, archived].filter(Boolean).join("; ") };
  }
  return { removed: true, savedUncommitted, ...(saved ? { saved } : {}), ...(archived !== undefined ? { note: archived } : {}) };
}
