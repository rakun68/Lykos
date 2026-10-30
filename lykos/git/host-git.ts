// The one way Lykos runs git on the HOST.
//
// A repository's own configuration is code the host would otherwise run: a
// `post-checkout` or `pre-commit` hook, a `core.fsmonitor` command. Sandcastle's
// issue #1010 is the concrete escape: anything that can write `.git/hooks` or
// `.git/config` makes the host's next `git` command execute it, and Lykos's
// checkpoints, project identity and repo map are all host git commands.
//
// So every host git call goes through `hostGit`, which
//   * switches hooks off (`core.hooksPath` at the null device) and fsmonitor off,
//   * names the git directory and work tree itself rather than letting git
//     rediscover them by walking up from the working directory, and
//   * says WHY when there is no git to run: `not-a-repo` and `git-missing` are
//     different problems with different fixes, and every silent fallback used
//     to collapse them into the same "undefined".
//
// The probe that finds the git directory runs with the same two switches, so
// discovery is not the one unprotected call.
//
// What this does NOT cover: attribute filter drivers (`filter.*.clean` run by
// `git add`) and `diff.external`/textconv. Hooks and fsmonitor are what the
// spec names; those are a separate surface.

import { spawnSync } from "node:child_process";
import { devNull } from "node:os";

export interface GitRun {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Set when git could not run at all, not when it ran and failed. */
  state?: Exclude<GitState, "repo">;
}

export type GitRunner = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => GitRun;

export type GitState = "repo" | "not-a-repo" | "git-missing";

export interface GitProbe {
  state: GitState;
  /** Absolute git directory; present when `state` is `repo`. */
  gitDir?: string;
  /** Absolute work tree root; present when `state` is `repo`. */
  workTree?: string;
}

/** `-c` pairs that make git run nothing the repository configured. */
const PROTECTION = ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsmonitor=false"] as const;

export interface HostGitOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBuffer?: number;
  /** Keep stdout byte-for-byte (NUL-separated output). Default trims. */
  raw?: boolean;
}

function isMissing(error: Error | undefined): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

// Only a found repository is cached: a folder that is not one today may be
// `git init`ed tomorrow, but a repository's git directory does not move.
const found = new Map<string, GitProbe>();

/** Where git lives for `cwd`, or why it does not. */
export function probeGit(cwd: string): GitProbe {
  const cached = found.get(cwd);
  if (cached !== undefined) return cached;
  const result = spawnSync("git", [...PROTECTION, "rev-parse", "--absolute-git-dir", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (isMissing(result.error)) return { state: "git-missing" };
  const lines = (result.stdout ?? "").split(/\r?\n/).filter((l) => l.length > 0);
  if (result.error !== undefined || result.status !== 0 || lines.length < 2) return { state: "not-a-repo" };
  const probe: GitProbe = { state: "repo", gitDir: lines[0]!, workTree: lines[1]! };
  found.set(cwd, probe);
  return probe;
}

/**
 * The argv for a host git that is run some way other than `hostGit` (the
 * github tool streams output and needs a kill). Hooks and fsmonitor are off;
 * the git directory and work tree are named when `cwd` is a repository, and
 * git is left to complain itself when it is not.
 */
export function protectedGitArgs(cwd: string, args: readonly string[]): string[] {
  const probe = probeGit(cwd);
  const named = probe.state === "repo" ? [`--git-dir=${probe.gitDir}`, `--work-tree=${probe.workTree}`] : [];
  return [...PROTECTION, ...named, ...args];
}

/**
 * Environment that gives the same protection to any git a PROGRAM starts for
 * us (`gh` runs git for some operations). Git reads these as config.
 */
export const PROTECTION_ENV: NodeJS.ProcessEnv = {
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: devNull,
  GIT_CONFIG_KEY_1: "core.fsmonitor",
  GIT_CONFIG_VALUE_1: "false",
};

/**
 * Run git on the host with hooks and fsmonitor off and the git directory and
 * work tree named. Outside a repository nothing runs and `state` says why.
 */
export function hostGit(args: string[], cwd: string, opts: HostGitOptions = {}): GitRun {
  const probe = probeGit(cwd);
  if (probe.state !== "repo") {
    return { ok: false, stdout: "", stderr: gitStateReason(probe.state), state: probe.state };
  }
  const result = spawnSync("git", [...PROTECTION, `--git-dir=${probe.gitDir}`, `--work-tree=${probe.workTree}`, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...(opts.env ?? {}) },
    maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
    windowsHide: true,
    ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
  });
  const text = (s: string | null | undefined) => (opts.raw === true ? (s ?? "") : (s ?? "").trim());
  if (isMissing(result.error)) return { ok: false, stdout: "", stderr: gitStateReason("git-missing"), state: "git-missing" };
  return {
    ok: result.error === undefined && result.status === 0,
    stdout: text(result.stdout),
    stderr: (result.stderr ?? "").trim(),
  };
}

/** The `GitRunner` shape checkpoints take, backed by `hostGit`. */
export const spawnGit: GitRunner = (args, cwd, env) => hostGit(args, cwd, env !== undefined ? { env } : {});

/** The reason a state is not `repo`, in the words a person is shown. */
export function gitStateReason(state: Exclude<GitState, "repo">): string {
  return state === "git-missing" ? "git is not installed" : "not a git repository";
}

/**
 * The one line a standalone session shows when it runs without git, or
 * undefined when it has a repository. Names every feature that is off so
 * nothing degrades silently.
 */
export function gitStateNotice(state: GitState): string | undefined {
  if (state === "repo") return undefined;
  return `lykos: ${gitStateReason(state)} — checkpoints, the repo map and commit are off for this session`;
}

/** Is a git binary on PATH at all, and which version? For `lykos doctor`. */
export function gitVersion(): string | undefined {
  const result = spawnSync("git", ["--version"], { encoding: "utf8", windowsHide: true });
  if (result.error !== undefined || result.status !== 0) return undefined;
  return (result.stdout ?? "").trim();
}
