import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

export function gitExec(args: string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", args, {
    cwd,
    env: env ?? process.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function resolveHead(cwd: string, env?: NodeJS.ProcessEnv): string {
  return gitExec(["rev-parse", "HEAD"], cwd, env);
}

export function resolveRef(ref: string, cwd: string, env?: NodeJS.ProcessEnv): string | null {
  try {
    return gitExec(["rev-parse", "--verify", ref], cwd, env);
  } catch {
    return null;
  }
}

export function getCurrentBranch(cwd: string, env?: NodeJS.ProcessEnv): string {
  try {
    return gitExec(["symbolic-ref", "--short", "HEAD"], cwd, env);
  } catch {
    return gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd, env);
  }
}

export function getBranchOrNull(cwd: string, env?: NodeJS.ProcessEnv): string | null {
  try {
    const branch = gitExec(["symbolic-ref", "--short", "HEAD"], cwd, env);
    return branch && branch !== "HEAD" ? branch : null;
  } catch {
    try {
      const abbrev = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd, env);
      return abbrev && abbrev !== "HEAD" ? abbrev : null;
    } catch {
      return null;
    }
  }
}

export function getMergeBase(ref1: string, ref2: string, cwd: string, env?: NodeJS.ProcessEnv): string {
  return gitExec(["merge-base", ref1, ref2], cwd, env);
}

export function isAncestor(ancestor: string, descendant: string, cwd: string, env?: NodeJS.ProcessEnv): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      env: env ?? process.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function listTrackedFiles(commit: string, cwd: string, env?: NodeJS.ProcessEnv): string[] {
  try {
    const out = gitExec(["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", commit], cwd, env);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function getChangedFilesBetween(from: string, to: string, cwd: string, env?: NodeJS.ProcessEnv): string[] {
  try {
    const out = gitExec(["-c", "core.quotepath=false", "diff", "--name-only", "--diff-filter=ACMR", from, to], cwd, env);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function getModifiedFilesSince(
  commit: string,
  paths: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
  headRef: string = "HEAD",
): string[] {
  if (paths.length === 0) return [];
  try {
    const out = gitExec(["-c", "core.quotepath=false", "diff", "--name-only", commit, headRef, "--", ...paths], cwd, env);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function getWorkingTreeModifiedFiles(
  commit: string,
  paths: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string[] {
  if (paths.length === 0) return [];
  try {
    const out = gitExec(["-c", "core.quotepath=false", "diff", "--name-only", commit, "--", ...paths], cwd, env);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function getWorkingTreeUncommittedFiles(
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string[] {
  try {
    const out = gitExec(["-c", "core.quotepath=false", "status", "--porcelain", "-uall"], cwd, env);
    if (!out) return [];
    const files: string[] = [];
    for (const line of out.split("\n")) {
      const trimmed = line.trimEnd();
      if (!trimmed || trimmed.length < 4) continue;
      let file = trimmed.slice(3).trim();
      if (file.includes(" -> ")) {
        file = file.split(" -> ")[1]!;
      }
      if (file.startsWith('"') && file.endsWith('"')) {
        file = file.slice(1, -1);
      }
      if (file) files.push(file.replace(/\\/g, "/"));
    }
    return files;
  } catch {
    return [];
  }
}

export function getFileAtCommit(
  commit: string,
  relPath: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string | null {
  try {
    return gitExec(["show", `${commit}:${relPath}`], cwd, env);
  } catch {
    return null;
  }
}

export function getCommitChangedFiles(commit: string, cwd: string, env?: NodeJS.ProcessEnv): string[] {
  try {
    const parents = gitExec(["rev-list", "--parents", "-n", "1", commit], cwd, env)
      .split(" ")
      .slice(1);
    if (parents.length > 0 && parents[0]) {
      const out = gitExec(["-c", "core.quotepath=false", "diff-tree", "--no-commit-id", "--name-only", "-r", parents[0], commit], cwd, env);
      return out.split("\n").map((s) => s.trim()).filter(Boolean);
    }
    const out = gitExec(["-c", "core.quotepath=false", "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", commit], cwd, env);
    return out.split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export function createTemporaryWorktree(
  cwd: string,
  commit: string,
  env?: NodeJS.ProcessEnv,
): { dir: string; cleanup: () => void } {
  let baseDir: string;
  try {
    baseDir = join(cwd, ".lykos", "worktrees");
    mkdirSync(baseDir, { recursive: true });
  } catch {
    baseDir = tmpdir();
  }
  const dir = mkdtempSync(join(baseDir, "seal-worktree-"));
  gitExec(["worktree", "add", "--detach", dir, commit], cwd, env);

  const nm = join(cwd, "node_modules");
  const targetNm = join(dir, "node_modules");
  if (existsSync(nm) && !existsSync(targetNm)) {
    try {
      const symlinkTarget = process.platform === "win32" ? nm : relative(dir, nm);
      symlinkSync(symlinkTarget, targetNm, "junction");
    } catch {}
  }

  const cleanup = () => {
    try {
      unlinkSync(targetNm);
    } catch {}

    let junctionStillExists = false;
    try {
      lstatSync(targetNm);
      junctionStillExists = true;
    } catch {
      junctionStillExists = false;
    }

    if (junctionStillExists) {
      process.stderr.write(
        `lykos seal: warning: node_modules junction at "${targetNm}" could not be unlinked; leaving worktree directory "${dir}" in place\n`,
      );
      try {
        gitExec(["worktree", "prune"], cwd, env);
      } catch {}
      return;
    }

    try {
      gitExec(["worktree", "remove", "--force", dir], cwd, env);
    } catch {}
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  };

  return { dir, cleanup };
}

export function commitSealFile(
  cwd: string,
  sealRelPath: string,
  prunedRelPaths: readonly string[],
  message: string,
  env?: NodeJS.ProcessEnv,
): string {
  gitExec(["add", sealRelPath], cwd, env);
  for (const p of prunedRelPaths) {
    try {
      gitExec(["rm", "-f", p], cwd, env);
    } catch {
      try {
        gitExec(["add", "-u", p], cwd, env);
      } catch {}
    }
  }
  const paths = [sealRelPath, ...prunedRelPaths];
  gitExec(["commit", "-m", message, "--", ...paths], cwd, env);
  return resolveHead(cwd, env);
}

export function commitSingleFile(
  cwd: string,
  relPath: string,
  message: string,
  env?: NodeJS.ProcessEnv,
): string {
  return commitSealFile(cwd, relPath, [], message, env);
}

export function findCommitIntroducingFile(
  mergeBase: string,
  head: string,
  relPath: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string | null {
  try {
    const out = gitExec(["log", "-1", "--format=%H", `${mergeBase}..${head}`, "--", relPath], cwd, env);
    return out || null;
  } catch {
    return null;
  }
}
