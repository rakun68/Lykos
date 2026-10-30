import { detectDefaultBase, loadConfig } from "../config/load.js";
import { parseYaml } from "../config/yaml-file.js";
import { computeKeyId, verifySignature } from "./crypto.js";
import {
  getFileAtCommit,
  gitExec,
  getMergeBase,
  isAncestor,
  resolveHead,
  resolveRef,
} from "./git.js";
import type { SealFile } from "./types.js";

export interface ActiveSealsOptions {
  cwd?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  base?: string | undefined;
  branch?: string | undefined;
  commit?: string | undefined;
}

export interface ActiveSeal {
  relPath: string;
  sealCommit: string;
  seal: SealFile;
  missingAtHead: boolean;
  modifiedAtHead: boolean;
  rolledBackAtHead?: boolean | undefined;
  deletedInHistory?: boolean | undefined;
  baseChanged?: boolean | undefined;
  untrustedKey?: boolean | undefined;
  invalidSignature?: boolean | undefined;
}

function isPrunedBySealCommit(
  relPath: string,
  seal: SealFile,
  sealCommit: string,
  head: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  let deletingCommit = "";
  try {
    deletingCommit = gitExec(
      ["-c", "core.quotepath=false", "log", "-1", "--diff-filter=D", "--format=%H", `${sealCommit}..${head}`, "--", relPath],
      cwd,
      env,
    );
  } catch {
    return false;
  }
  if (!deletingCommit) return false;

  if (!isAncestor(sealCommit, deletingCommit, cwd, env)) {
    return false;
  }

  let parents: string[] = [];
  try {
    parents = gitExec(["rev-list", "--parents", "-n", "1", deletingCommit], cwd, env)
      .split(" ")
      .slice(1);
  } catch {
    return false;
  }

  const parentList = parents.length > 0 ? parents : ["--root"];
  for (const p of parentList) {
    let diffTree = "";
    try {
      const args =
        p === "--root"
          ? ["-c", "core.quotepath=false", "diff-tree", "--no-commit-id", "--name-status", "-r", "--root", deletingCommit]
          : ["-c", "core.quotepath=false", "diff-tree", "--no-commit-id", "--name-status", "-r", p, deletingCommit];
      diffTree = gitExec(args, cwd, env);
    } catch {
      continue;
    }

    const lines = diffTree.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      const status = parts[0];
      const pathPart = parts.length > 2 ? parts[2] : parts[1];
      if (!status || !pathPart) continue;
      if (!status.startsWith("A") && !status.startsWith("M") && !status.startsWith("R") && !status.startsWith("C")) {
        continue;
      }

      const otherPath = pathPart.replace(/\\/g, "/");
      if (
        otherPath.startsWith(".lykos/seals/") &&
        otherPath.endsWith(".json") &&
        !otherPath.startsWith(".lykos/seals/keys/") &&
        otherPath !== relPath
      ) {
        const deletingOtherContent = getFileAtCommit(deletingCommit, otherPath, cwd, env);
        if (!deletingOtherContent) continue;

        let otherParsed: SealFile;
        try {
          otherParsed = JSON.parse(deletingOtherContent);
        } catch {
          continue;
        }
        if (!otherParsed.signature || !otherParsed.key_id) continue;
        if (otherPath !== `.lykos/seals/${otherParsed.branch}.json`) continue;

        // The pruning seal must be a reseal whose writer commit descends from the deleted seal's commit
        if (
          !otherParsed.writer_commit ||
          otherParsed.writer_commit === sealCommit ||
          !isAncestor(sealCommit, otherParsed.writer_commit, cwd, env)
        ) {
          continue;
        }

        // Its sealed_paths must include every sealed path of the deleted seal (excluding seal files)
        const requiredPaths = (Array.isArray(seal.sealed_paths) ? seal.sealed_paths : []).filter(
          (p) => typeof p === "string" && !(p.replace(/\\/g, "/").startsWith(".lykos/seals/") && p.endsWith(".json")),
        );
        const candidatePaths = new Set(Array.isArray(otherParsed.sealed_paths) ? otherParsed.sealed_paths : []);
        if (!requiredPaths.every((p) => candidatePaths.has(p))) {
          continue;
        }

        // It must be new or changed in this commit (not byte-identical to a version earlier in history)
        if (parents.length > 0) {
          let existedEarlier = false;
          try {
            const blobSha = gitExec(["rev-parse", `${deletingCommit}:${otherPath}`], cwd, env).trim();
            if (blobSha) {
              const foundPrior = gitExec(["log", ...parents, "-1", `--find-object=${blobSha}`, "--format=%H"], cwd, env).trim();
              if (foundPrior) {
                existedEarlier = true;
              }
            }
          } catch {}
          if (!existedEarlier) {
            for (const p of parents) {
              try {
                const priorContent = getFileAtCommit(p, otherPath, cwd, env);
                if (priorContent !== null && priorContent === deletingOtherContent) {
                  existedEarlier = true;
                  break;
                }
              } catch {}
            }
          }
          if (existedEarlier) {
            continue;
          }
        }

        let otherBase = otherParsed.base;
        if (!otherBase) {
          const cfgContent = getFileAtCommit(deletingCommit, ".lykos/config.yaml", cwd, env);
          if (cfgContent) {
            try {
              const parsedCfg = parseYaml(cfgContent) as Record<string, any>;
              if (parsedCfg?.seal?.base && typeof parsedCfg.seal.base === "string") {
                otherBase = parsedCfg.seal.base.trim();
              }
            } catch {}
          }
        }
        if (!otherBase) {
          otherBase = detectDefaultBase(cwd);
        }

        const otherBaseSha = resolveRef(otherBase, cwd, env);
        if (!otherBaseSha) continue;
        let otherMergeBase: string;
        try {
          otherMergeBase = getMergeBase(deletingCommit, otherBaseSha, cwd, env);
        } catch {
          continue;
        }
        const pubKey = getFileAtCommit(otherMergeBase, `.lykos/seals/keys/${otherParsed.key_id}.pub`, cwd, env);
        if (!pubKey || computeKeyId(pubKey) !== otherParsed.key_id) continue;
        if (verifySignature(otherParsed as unknown as Record<string, unknown>, otherParsed.signature, pubKey)) {
          return true;
        }
      }
    }
  }

  return false;
}

export interface FoundSealCommit {
  sealCommit: string;
  seal: SealFile;
  firstValidSeal?: SealFile | undefined;
  commits: string[];
  reversedCommits: string[];
  headContent: string | null;
  rolledBackAtHead?: boolean | undefined;
}

export function findSealCommit(
  relPath: string,
  cwd: string,
  env?: NodeJS.ProcessEnv,
  headRef: string = "HEAD",
): FoundSealCommit | null {
  let commitLog = "";
  try {
    commitLog = gitExec(["-c", "core.quotepath=false", "log", "--format=%H", headRef, "--", relPath], cwd, env);
  } catch {
    return null;
  }

  const commits = commitLog.split("\n").map((c) => c.trim()).filter(Boolean);
  if (commits.length === 0) return null;

  const reversedCommits = [...commits].reverse();
  const headContent = getFileAtCommit(headRef, relPath, cwd, env);

  interface IntroducedSeal {
    commit: string;
    seal: SealFile;
    signature: string;
  }

  const introducedSeals: IntroducedSeal[] = [];
  const seenSignatures = new Set<string>();

  for (const commit of reversedCommits) {
    const cContent = getFileAtCommit(commit, relPath, cwd, env);
    if (!cContent) continue;
    try {
      const parsed = JSON.parse(cContent) as SealFile;
      if (parsed?.key_id && parsed?.signature) {
        if (!seenSignatures.has(parsed.signature)) {
          seenSignatures.add(parsed.signature);
          introducedSeals.push({
            commit,
            seal: parsed,
            signature: parsed.signature,
          });
        }
      }
    } catch {}
  }

  if (introducedSeals.length === 0) {
    return null;
  }

  const firstValidSeal = introducedSeals[0]!.seal;
  // The active seal for a branch is the latest signed seal commit for that file in history
  const latest = introducedSeals[introducedSeals.length - 1]!;
  const sealCommit = latest.commit;
  const currentSeal = latest.seal;

  let rolledBackAtHead = false;
  if (headContent !== null) {
    try {
      const headParsed = JSON.parse(headContent) as SealFile;
      if (headParsed?.signature && headParsed?.key_id) {
        if (headParsed.signature !== latest.signature) {
          const earlier = introducedSeals.find((s) => s.signature === headParsed.signature);
          if (earlier && earlier.commit !== latest.commit) {
            rolledBackAtHead = true;
          }
        }
      }
    } catch {}
  }

  return {
    sealCommit,
    seal: currentSeal,
    firstValidSeal,
    commits,
    reversedCommits,
    headContent,
    rolledBackAtHead,
  };
}

export function activeSeals(opts: ActiveSealsOptions = {}): ActiveSeal[] {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;

  let head: string;
  try {
    head = opts.commit ? (resolveRef(opts.commit, cwd, env) ?? opts.commit) : resolveHead(cwd, env);
  } catch {
    return [];
  }

  let logOutput = "";
  try {
    logOutput = gitExec(
      ["-c", "core.quotepath=false", "log", "--name-status", "--format=COMMIT:%H", head, "--", ".lykos/seals/"],
      cwd,
      env,
    );
  } catch {
    return [];
  }

  const sealPaths = new Set<string>();
  const lines = logOutput.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("COMMIT:")) continue;
    const parts = trimmed.split(/\s+/);
    const pathPart = parts.length > 2 ? parts[2] : parts[1];
    if (!pathPart) continue;

    const normPath = pathPart.replace(/\\/g, "/");
    if (
      normPath.startsWith(".lykos/seals/") &&
      normPath.endsWith(".json") &&
      !normPath.startsWith(".lykos/seals/keys/")
    ) {
      if (!opts.branch || normPath === `.lykos/seals/${opts.branch}.json`) {
        sealPaths.add(normPath);
      }
    }
  }

  const result: ActiveSeal[] = [];

  for (const relPath of sealPaths) {
    const found = findSealCommit(relPath, cwd, env, head);
    if (!found) continue;

    const { sealCommit, seal: currentSeal, firstValidSeal, reversedCommits, headContent } = found;
    const missingAtHead = headContent === null;

    let firstBase = firstValidSeal?.base || opts.base;
    if (!firstBase) {
      const headConfigContent = getFileAtCommit(head, ".lykos/config.yaml", cwd, env);
      if (headConfigContent) {
        try {
          const parsedCfg = parseYaml(headConfigContent) as Record<string, any>;
          if (parsedCfg?.seal?.base && typeof parsedCfg.seal.base === "string") {
            firstBase = parsedCfg.seal.base.trim();
          }
        } catch {}
      }
    }
    if (!firstBase) {
      firstBase = detectDefaultBase(cwd);
    }

    let baseChanged = false;
    for (const commit of reversedCommits) {
      const cContent = getFileAtCommit(commit, relPath, cwd, env);
      if (!cContent) continue;
      try {
        const parsed = JSON.parse(cContent) as SealFile;
        if (parsed?.key_id && parsed?.signature) {
          if (parsed.base && firstValidSeal?.base && parsed.base !== firstValidSeal.base) {
            baseChanged = true;
            break;
          }
          if (parsed.base && firstBase && parsed.base !== firstBase) {
            baseChanged = true;
            break;
          }
        }
      } catch {}
    }
    if (currentSeal.base && firstValidSeal?.base && currentSeal.base !== firstValidSeal.base) {
      baseChanged = true;
    }
    if (currentSeal.base && firstBase && currentSeal.base !== firstBase) {
      baseChanged = true;
    }

    const firstBaseSha = resolveRef(firstBase, cwd, env);
    if (!firstBaseSha) {
      continue;
    }

    if (!baseChanged && isAncestor(sealCommit, firstBaseSha, cwd, env)) {
      continue;
    }

    let mergeBase: string;
    try {
      mergeBase = getMergeBase(head, firstBaseSha, cwd, env);
    } catch {
      continue;
    }

    let untrustedKey = false;
    let invalidSignature = false;

    const pubKey = getFileAtCommit(mergeBase, `.lykos/seals/keys/${currentSeal.key_id}.pub`, cwd, env);
    if (!pubKey || computeKeyId(pubKey) !== currentSeal.key_id) {
      untrustedKey = true;
    } else if (
      currentSeal.signature &&
      !verifySignature(currentSeal as unknown as Record<string, unknown>, currentSeal.signature, pubKey)
    ) {
      invalidSignature = true;
    }

    if (missingAtHead) {
      if (isPrunedBySealCommit(relPath, currentSeal, sealCommit, head, cwd, env)) {
        continue;
      }
    }

    let deletedInHistory = false;
    if (!missingAtHead) {
      try {
        const delCommit = gitExec(
          ["-c", "core.quotepath=false", "log", "-1", "--diff-filter=D", "--format=%H", `${sealCommit}..${head}`, "--", relPath],
          cwd,
          env,
        );
        if (delCommit.trim() && !isPrunedBySealCommit(relPath, currentSeal, sealCommit, head, cwd, env)) {
          deletedInHistory = true;
        }
      } catch {}
    }

    const modifiedAtHead =
      headContent !== null && headContent !== getFileAtCommit(sealCommit, relPath, cwd, env);

    result.push({
      relPath,
      sealCommit,
      seal: currentSeal,
      missingAtHead,
      modifiedAtHead,
      rolledBackAtHead: found.rolledBackAtHead || false,
      deletedInHistory,
      baseChanged,
      untrustedKey,
      invalidSignature,
    });
  }

  return result;
}
