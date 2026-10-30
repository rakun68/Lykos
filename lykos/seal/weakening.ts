// The weakening scan.
//
// Scans lines added outside the seal since the seal commit for forbidden
// weakening patterns (such as .skip, .only, xit(, process.env.VITEST, etc.).
// Only lines added in the diff from seal commit to HEAD and working tree are scanned.

import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { gitExec } from "./git.js";
import { matchGlob } from "./matcher.js";
import type { ActiveSeal } from "./active.js";

export interface WeakeningMatch {
  branch: string;
  file: string;
  line: number;
  pattern: string;
}

export interface ScanWeakeningOptions {
  cwd: string;
  seals: readonly ActiveSeal[];
  patterns: readonly string[];
  env?: NodeJS.ProcessEnv;
  isSealed?: (file: string, allSealedPaths: readonly string[]) => boolean;
}

export function parseDiffWeakening(
  diffOutput: string,
  branch: string,
  patterns: readonly string[],
  isExcluded: (file: string) => boolean,
  addMatch: (match: WeakeningMatch) => void,
): void {
  const lines = diffOutput.split("\n");
  let currentFile: string | null = null;
  let skipCurrentFile = false;
  let currentLine = 1;
  let inHunk = false;

  for (const rawLine of lines) {
    if (rawLine.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (!inHunk && rawLine.startsWith("+++ b/")) {
      let file = rawLine.slice(6).trim();
      if (file.includes("\t")) {
        file = file.split("\t")[0]!.trim();
      }
      if (file.startsWith('"') && file.endsWith('"')) {
        file = file.slice(1, -1);
      }
      currentFile = file.replace(/\\/g, "/");
      skipCurrentFile = isExcluded(currentFile);
      currentLine = 1;
      continue;
    }
    if (!inHunk && rawLine.startsWith("+++ /dev/null")) {
      currentFile = null;
      skipCurrentFile = true;
      continue;
    }

    if (rawLine.startsWith("@@ ")) {
      const match = rawLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (match && match[1]) {
        currentLine = parseInt(match[1], 10);
        if (currentLine === 0) {
          currentLine = 1;
        }
      }
      inHunk = true;
      continue;
    }

    if (inHunk && currentFile && !skipCurrentFile) {
      if (rawLine.startsWith("+")) {
        const lineContent = rawLine.slice(1).replace(/\r$/, "");
        for (const pattern of patterns) {
          if (lineContent.includes(pattern)) {
            addMatch({
              branch,
              file: currentFile,
              line: currentLine,
              pattern,
            });
          }
        }
        currentLine++;
      } else if (rawLine.startsWith(" ")) {
        currentLine++;
      }
    }
  }
}

export function scanWeakening(opts: ScanWeakeningOptions): WeakeningMatch[] {
  const { cwd, seals, patterns, env } = opts;
  if (seals.length === 0 || patterns.length === 0) return [];

  // Union all sealed paths across all active seals (Ruling 6)
  const allSealedPaths: string[] = [];
  for (const s of seals) {
    allSealedPaths.push(...s.seal.sealed_paths);
    allSealedPaths.push(s.relPath);
  }

  const isExcluded = (file: string): boolean => {
    const norm = file.replace(/\\/g, "/").replace(/^\.\//, "");
    // Ruling 5: Skip .lykos/.
    if (norm === ".lykos" || norm.startsWith(".lykos/")) return true;
    // Ruling 6: Exclude every active seal's sealed paths.
    if (opts.isSealed) {
      if (opts.isSealed(file, allSealedPaths)) return true;
    } else {
      for (const sp of allSealedPaths) {
        const normSp = sp.replace(/\\/g, "/").replace(/^\.\//, "");
        if (norm === normSp || norm.startsWith(normSp + "/") || matchGlob(norm, normSp)) {
          return true;
        }
      }
    }
    return false;
  };

  const matches: WeakeningMatch[] = [];
  const seen = new Set<string>();

  const addMatch = (m: WeakeningMatch): void => {
    const key = `${m.file}:${m.line}:${m.pattern}`;
    if (!seen.has(key)) {
      seen.add(key);
      matches.push(m);
    }
  };

  // Scan per active seal from its own seal commit (Ruling 6)
  for (const s of seals) {
    try {
      const diffOut = gitExec(
        ["-c", "core.quotepath=false", "diff", "-U0", s.sealCommit],
        cwd,
        env,
      );
      parseDiffWeakening(diffOut, s.seal.branch, patterns, isExcluded, addMatch);
    } catch {}
  }

  // Untracked files in working tree
  try {
    const statusOut = gitExec(
      ["-c", "core.quotepath=false", "status", "--porcelain", "-uall"],
      cwd,
      env,
    );
    for (const rawLine of statusOut.split("\n")) {
      const trimmed = rawLine.trimEnd();
      if (!trimmed.startsWith("?? ")) continue;
      let file = trimmed.slice(3).trim();
      if (file.startsWith('"') && file.endsWith('"')) {
        file = file.slice(1, -1);
      }
      file = file.replace(/\\/g, "/");
      if (!file || isExcluded(file)) continue;

      try {
        const fullPath = resolve(cwd, file);
        if (existsSync(fullPath) && statSync(fullPath).isFile()) {
          const content = readFileSync(fullPath, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const lineContent = lines[i]!.replace(/\r$/, "");
            for (const pattern of patterns) {
              if (lineContent.includes(pattern)) {
                addMatch({
                  branch: seals[0]?.seal.branch ?? "",
                  file,
                  line: i + 1,
                  pattern,
                });
              }
            }
          }
        }
      } catch {}
    }
  } catch {}

  return matches;
}
