/**
 * P5 #46: the workspace's changes for `lykos-tui`'s diff viewer, as OpenCode's `core/src/plugin/vcs/git.ts` at
 * `4332e24` computes them. `branch` is everything since the merge base with the default branch (committed, staged,
 * unstaged and untracked), `committed` only what is committed since it, `working` what is not committed yet.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { hostGit, type GitRun } from "./host-git.js";

export type DiffMode = "branch" | "committed" | "working";

export interface FileChange {
  /** The path from the repository's root, with forward slashes. */
  file: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  /** The unified patch, empty for a binary file or one too large to show. */
  patch: string;
}

export interface WorkspaceDiff {
  /** What the changes are against: a commit, `HEAD`, or nothing in a repository with no commit yet. */
  base?: string;
  /** The default branch's name, when the base is its merge base. */
  branch?: string;
  files: FileChange[];
}

/** The lines of context around a change (OpenCode's viewer asks for 12). */
const CONTEXT = 12;
/** An untracked file larger than this is listed without its patch. */
const MAX_UNTRACKED_BYTES = 1024 * 1024;

/** Lykos's own runtime state in the workspace is never a change to review. */
const PATHSPEC = [":/", ":(exclude,top).lykos"];

const git = (args: string[], cwd: string): GitRun => hostGit(args, cwd, { raw: true, maxBuffer: 256 * 1024 * 1024 });

/** `VcsGit.defaultBranch`: the remote's HEAD, else `init.defaultBranch`, else `main`, else `master`. */
export function defaultBranch(cwd: string): { name: string; ref: string } | undefined {
  const remotes = git(["remote"], cwd).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : remotes[0];
  if (remote !== undefined) {
    const head = git(["symbolic-ref", `refs/remotes/${remote}/HEAD`], cwd);
    if (head.ok) {
      const ref = head.stdout.trim().replace(/^refs\/remotes\//, "");
      const name = ref.startsWith(`${remote}/`) ? ref.slice(remote.length + 1) : "";
      if (name) return { name, ref };
    }
  }
  const heads = git(["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"], cwd).stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const configured = git(["config", "init.defaultBranch"], cwd).stdout.trim();
  for (const name of [configured, "main", "master"]) {
    if (name && heads.includes(name)) return { name, ref: name };
  }
  return undefined;
}

function hasHead(cwd: string): boolean {
  return git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], cwd).ok;
}

function mergeBase(cwd: string, ref: string): string | undefined {
  if (!git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`], cwd).ok) return undefined;
  const r = git(["merge-base", ref, "HEAD"], cwd);
  return r.ok ? r.stdout.trim() || undefined : undefined;
}

function counts(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) inHunk = true;
    else if (!inHunk) continue;
    else if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/** Splits `git diff` output into one change per file. */
export function splitPatch(text: string): FileChange[] {
  const out: FileChange[] = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    const head = chunk.split("\n", 1)[0] ?? "";
    const added = /^new file mode/m.test(chunk);
    const deleted = /^deleted file mode/m.test(chunk);
    const plus = /^\+\+\+ b\/(.*)$/m.exec(chunk)?.[1];
    const minus = /^--- a\/(.*)$/m.exec(chunk)?.[1];
    const file = plus ?? minus ?? head.replace(/^diff --git a\/(.*) b\/.*$/, "$1");
    const binary = /^Binary files /m.test(chunk);
    out.push({ file, status: added ? "added" : deleted ? "deleted" : "modified", ...counts(chunk), patch: binary ? "" : chunk.replace(/\n$/, "") });
  }
  return out;
}

function untracked(cwd: string): FileChange[] {
  const root = git(["rev-parse", "--show-toplevel"], cwd).stdout.trim();
  const names = git(["ls-files", "--others", "--exclude-standard", "-z", "--full-name", "--", ...PATHSPEC], cwd).stdout.split("\0").filter(Boolean);
  return names.map((file) => {
    const path = join(root, file);
    let text = "";
    try {
      if (statSync(path).size <= MAX_UNTRACKED_BYTES) text = readFileSync(path, "utf8");
    } catch {
      // Gone since git listed it.
    }
    if (text.includes("\0")) text = "";
    const patch = text === "" ? "" : createTwoFilesPatch(`a/${file}`, `b/${file}`, "", text, undefined, undefined, { context: CONTEXT });
    return { file, status: "added" as const, ...counts(patch), patch: patch.replace(/\n$/, "") };
  });
}

/** The changes for `mode` in the repository at `cwd`. */
export function workspaceDiff(cwd: string, mode: DiffMode): WorkspaceDiff {
  const probe = git(["rev-parse", "--show-toplevel"], cwd);
  if (!probe.ok) throw new Error(probe.stderr || "not a git repository");
  const diffArgs = ["diff", "--no-ext-diff", "--no-renames", "--no-color", `-U${CONTEXT}`];
  const tracked = (ref: string, target?: string): FileChange[] => {
    const r = git([...diffArgs, ref, ...(target !== undefined ? [target] : []), "--", ...PATHSPEC], cwd);
    if (!r.ok) throw new Error(r.stderr || "git diff failed");
    return splitPatch(r.stdout);
  };
  const sorted = (files: FileChange[]) => files.sort((a, b) => a.file.localeCompare(b.file));
  if (!hasHead(cwd)) {
    return { files: mode === "committed" ? [] : sorted(untracked(cwd)) };
  }
  if (mode === "working") {
    return { base: "HEAD", files: sorted([...tracked("HEAD"), ...untracked(cwd)]) };
  }
  const branch = defaultBranch(cwd);
  const base = branch !== undefined ? mergeBase(cwd, branch.ref) : undefined;
  if (base === undefined) throw new Error(branch !== undefined ? `No merge base available for ${branch.ref}` : "No review base available");
  if (mode === "committed") return { base, branch: branch!.name, files: sorted(tracked(base, "HEAD")) };
  return { base, branch: branch!.name, files: sorted([...tracked(base), ...untracked(cwd)]) };
}
