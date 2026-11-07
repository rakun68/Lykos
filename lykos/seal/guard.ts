// T232 (spec decision 11): the seal guard's comparison and its restore.
//
// After every tool call and every job end, the explicit sealed paths of each active seal are compared against the
// seal commit in BOTH the working tree and the index, and what differs is restored in both. Untracked files beside
// a sealed path are not compared: only the named paths are, and git does not list an untracked file under them.
// Nothing is committed here: a restored file is a change in the tree like any other and is committed with the rest
// at the session's end.
//
// A glob in `sealed_paths` is not an explicit path: the veto covers it, and a file it matched is sealed by name in
// the seal's own list when `seal create` expands it.

import type { ActiveSeal } from "./active.js";
import { gitExec } from "./git.js";

/** One sealed path whose working tree or index differs from its seal commit. */
export interface SealedDrift {
  path: string;
  /** Where it differed: the working tree, the index, or both. */
  where: Array<"worktree" | "index">;
  sealCommit: string;
  branch: string;
}

export interface SealRestore {
  /** What differed and was put back. */
  restored: SealedDrift[];
  /** Paths still different after the restore. When git could not compare at all, every explicit sealed path: none of them is known to be intact. */
  failed: string[];
  /** Set when git could not compare or restore; the guard is then unsure, not clean. */
  error?: string;
}

const GLOB_CHARS = /[*?[\]{}]/;

function normalize(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** The paths of `seal` the guard compares: named, inside the repository, and not the seal's own record. */
export function explicitSealedPaths(seal: ActiveSeal): string[] {
  return seal.seal.sealed_paths
    .map(normalize)
    .filter((p) => p.length > 0 && p !== normalize(seal.relPath) && !p.startsWith(".lykos/") && !p.startsWith("../") && !GLOB_CHARS.test(p));
}

function names(out: string): string[] {
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Sealed paths whose working tree or index differs from the seal commit. */
export function sealedDrift(cwd: string, seals: readonly ActiveSeal[], env?: NodeJS.ProcessEnv): SealedDrift[] {
  const found: SealedDrift[] = [];
  for (const s of seals) {
    const paths = explicitSealedPaths(s);
    if (paths.length === 0) continue;
    const tree = new Set(names(gitExec(["-c", "core.quotepath=false", "diff", "--name-only", s.sealCommit, "--", ...paths], cwd, env)));
    const index = new Set(names(gitExec(["-c", "core.quotepath=false", "diff", "--cached", "--name-only", s.sealCommit, "--", ...paths], cwd, env)));
    for (const path of new Set([...tree, ...index])) {
      found.push({
        path,
        where: [...(tree.has(path) ? (["worktree"] as const) : []), ...(index.has(path) ? (["index"] as const) : [])],
        sealCommit: s.sealCommit,
        branch: s.seal.branch,
      });
    }
  }
  return found;
}

/**
 * Puts every drifted sealed path back to its seal commit, in the working tree and the index. Never throws: a
 * comparison git could not make is a failed restore of every path it should have compared, with the reason, so a
 * caller that sees nothing wrong has seen nothing wrong.
 */
export function restoreSealed(cwd: string, seals: readonly ActiveSeal[], env?: NodeJS.ProcessEnv): SealRestore {
  let drift: SealedDrift[];
  try {
    drift = sealedDrift(cwd, seals, env);
  } catch (err) {
    return { restored: [], failed: seals.flatMap(explicitSealedPaths), error: `sealed paths could not be compared: ${err instanceof Error ? err.message : String(err)}` };
  }
  const failed: string[] = [];
  const bySeal = new Map<string, SealedDrift[]>();
  for (const d of drift) bySeal.set(d.sealCommit, [...(bySeal.get(d.sealCommit) ?? []), d]);
  for (const [commit, list] of bySeal) {
    try {
      gitExec(["checkout", commit, "--", ...list.map((d) => d.path)], cwd, env);
    } catch {
      // The comparison below says which paths are still different.
    }
  }
  if (drift.length > 0) {
    let still: Set<string>;
    try {
      still = new Set(sealedDrift(cwd, seals, env).map((d) => d.path));
    } catch (err) {
      return { restored: [], failed: drift.map((d) => d.path), error: `sealed paths could not be compared after the restore: ${err instanceof Error ? err.message : String(err)}` };
    }
    for (const d of drift) if (still.has(d.path)) failed.push(d.path);
  }
  return { restored: drift.filter((d) => !failed.includes(d.path)), failed };
}
