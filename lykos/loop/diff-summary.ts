// P4 T149 — the diff summary `session_end` carries.
//
// Computed ONCE, at the one firing site that knows the session is over, from
// git, and handed to every extension listening — so two extensions never read
// two different versions of what a session changed.
//
// **Against the commit the session booted on**, not HEAD: a session that
// committed its own work would otherwise show an empty diff. Untracked files
// count, as additions, because a new file the agent wrote is the most common
// change there is and `git diff` never shows one. `.lykos/` is runtime state,
// not the project's, and is left out even where a project forgot to ignore it.
//
// The text half is bounded (`SESSION_DIFF_MAX_BYTES`), keeping head and tail;
// the per-file half is not, since it is one short row per path. The body of
// T110's `getWorkingTreeDiff` lives on here; the reviewer that used to call it
// is now an extension and reads this instead.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SessionDiffSummary } from "../extensions/api.js";
import { spawnGit, type GitRunner } from "./checkpoint.js";

export const SESSION_DIFF_MAX_BYTES = 64 * 1024;
/** An untracked file larger than this is listed, not inlined. */
const UNTRACKED_INLINE_MAX_BYTES = 64 * 1024;

const RUNTIME_STATE = /^\.lykos\//;

export const EMPTY_DIFF_SUMMARY: SessionDiffSummary = { base: null, files: [], text: "", truncated: false };

export function sessionDiffSummary(cwd: string, bootHead: string | undefined, gitRunner?: GitRunner): SessionDiffSummary {
  const git = gitRunner ?? spawnGit;
  if (!git(["rev-parse", "--git-dir"], cwd).ok) return EMPTY_DIFF_SUMMARY;
  const base = bootHead !== undefined && /^[0-9a-f]{7,64}$/i.test(bootHead) ? bootHead : undefined;
  const against = base ?? "HEAD";

  const files: Array<{ path: string; added: number | null; removed: number | null; untracked: boolean }> = [];
  const numstat = git(["diff", "--numstat", against, "--", ".", ":(exclude).lykos"], cwd);
  if (numstat.ok) {
    for (const line of numstat.stdout.split("\n")) {
      const m = line.match(/^(\S+)\t(\S+)\t(.+)$/);
      if (m === null) continue;
      files.push({
        path: m[3]!.trim(),
        added: m[1] === "-" ? null : Number(m[1]),
        removed: m[2] === "-" ? null : Number(m[2]),
        untracked: false,
      });
    }
  }

  const chunks: string[] = [];
  const diff = git(["diff", against, "--", ".", ":(exclude).lykos"], cwd);
  if (diff.ok && diff.stdout.trim().length > 0) chunks.push(diff.stdout.trimEnd());

  const status = git(["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  if (status.ok) {
    const untracked = status.stdout
      .split("\n")
      .filter((l) => l.startsWith("?? "))
      .map((l) => l.slice(3).trim().replace(/^"|"$/g, ""))
      .filter((p) => p.length > 0 && !RUNTIME_STATE.test(p));
    for (const rel of untracked) {
      const abs = join(cwd, rel);
      let body: string | undefined;
      try {
        if (existsSync(abs) && statSync(abs).size <= UNTRACKED_INLINE_MAX_BYTES) {
          const raw = readFileSync(abs);
          body = raw.includes(0) ? undefined : raw.toString("utf8");
        }
      } catch {
        body = undefined;
      }
      if (body === undefined) {
        files.push({ path: rel, added: null, removed: null, untracked: true });
        chunks.push(`--- /dev/null\n+++ b/${rel}\n(untracked file, not shown)`);
        continue;
      }
      const lines = body.endsWith("\n") ? body.slice(0, -1).split("\n") : body.split("\n");
      files.push({ path: rel, added: body.length === 0 ? 0 : lines.length, removed: 0, untracked: true });
      chunks.push(
        `--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}`,
      );
    }
  }

  const combined = chunks.join("\n").trim();
  if (Buffer.byteLength(combined, "utf8") <= SESSION_DIFF_MAX_BYTES) {
    return { base: base ?? null, files, text: combined, truncated: false };
  }
  const half = Math.floor((SESSION_DIFF_MAX_BYTES - 80) / 2);
  return {
    base: base ?? null,
    files,
    text: `${combined.slice(0, half)}\n\n… [diff truncated: ${combined.length - half * 2} characters elided] …\n\n${combined.slice(-half)}`,
    truncated: true,
  };
}

/**
 * T167 R1 (ADR-0030): every path git says changed since the session booted,
 * relative to `cwd` — tracked changes against the boot commit, staged or not,
 * and untracked files that are not ignored. `.lykos/` is left out, as above.
 *
 * The gate's rerun unions this with the trace's own edited paths, because a
 * test file rewritten through `bash` is invisible to the trace, and a flaky
 * test in it must not clear the session. A file that was already dirty when
 * the session booted is in here too. That can only keep a verdict at `fail`,
 * never turn one into `success`. Outside a repository, or if git fails, it is
 * empty, and the trace's paths stand alone as before.
 */
export function sessionChangedPaths(cwd: string, bootHead: string | undefined, gitRunner?: GitRunner): string[] {
  const git = gitRunner ?? spawnGit;
  if (!git(["rev-parse", "--git-dir"], cwd).ok) return [];
  const base = bootHead !== undefined && /^[0-9a-f]{7,64}$/i.test(bootHead) ? bootHead : "HEAD";
  const paths = new Set<string>();
  const add = (out: string): void => {
    for (const line of out.split("\n")) {
      const p = line.trim();
      if (p.length > 0 && !RUNTIME_STATE.test(p)) paths.add(p);
    }
  };
  // `--relative` and `ls-files` both answer relative to `cwd`, which is what
  // the gate resolves test files against. `-c core.quotePath=false` keeps a
  // non-ASCII name as itself rather than an octal-escaped string.
  const tracked = git(["-c", "core.quotePath=false", "diff", "--name-only", "--relative", base, "--", "."], cwd);
  if (tracked.ok) add(tracked.stdout);
  const untracked = git(["-c", "core.quotePath=false", "ls-files", "--others", "--exclude-standard", "--", "."], cwd);
  if (untracked.ok) add(untracked.stdout);
  return [...paths];
}
