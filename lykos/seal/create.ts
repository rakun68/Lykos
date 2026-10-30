import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { detectDefaultBase, loadConfig } from "../config/load.js";
import { defaultLedgerPath, recordSealEvent } from "../ledger/use.js";
import { localExecutor, type ProjectExecutor } from "../tools/executor.js";
import { parseYaml } from "../config/yaml-file.js";
import { activeSeals, findSealCommit } from "./active.js";
import { canonicalJson, listPrivateKeys, signPayload } from "./crypto.js";
import {
  commitSealFile,
  commitSingleFile,
  createTemporaryWorktree,
  getBranchOrNull,
  getCommitChangedFiles,
  getFileAtCommit,
  getMergeBase,
  getModifiedFilesSince,
  gitExec,
  isAncestor,
  listTrackedFiles,
  resolveHead,
  resolveRef,
} from "./git.js";
import { matchAnyGlob } from "./matcher.js";
import { runRedCheck } from "./runner.js";
import type { SealAdapter, SealFile, SealRedTest } from "./types.js";
import type { ContainmentChoice } from "../delegate/session-protocol.js";

export interface SealCreateOptions {
  cwd: string;
  targetCommit?: string | undefined;
  sessionId?: string | null | undefined;
  creator?: string | undefined;
  specialist?: string | null | undefined;
  homeDir?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  ledgerPath?: string | undefined;
  branch?: string | undefined;
  containmentLevel?: ContainmentChoice | undefined;
}

export interface SealCreateResult {
  ok: boolean;
  seal?: SealFile | undefined;
  sealCommit?: string | undefined;
  pruned?: string[] | undefined;
  errors?: string[] | undefined;
  warnings?: string[] | undefined;
}

export async function sealCreate(opts: SealCreateOptions): Promise<SealCreateResult> {
  const cwd = opts.cwd;
  const env = opts.env ?? process.env;

  const head = resolveHead(cwd, env);
  if (opts.targetCommit) {
    const targetSha = resolveRef(opts.targetCommit, cwd, env);
    if (!targetSha || targetSha !== head) {
      return {
        ok: false,
        errors: [`lykos seal create: commit "${opts.targetCommit}" does not resolve to HEAD`],
      };
    }
  }
  const writerCommit = head;

  const branch = opts.branch || getBranchOrNull(cwd, env);
  if (!branch) {
    return {
      ok: false,
      errors: ["lykos seal create: cannot create seal on detached HEAD without --branch <name>"],
    };
  }

  let configBase: string | undefined;
  const headConfigContent = getFileAtCommit(head, ".lykos/config.yaml", cwd, env);
  if (headConfigContent) {
    try {
      const parsedCfg = parseYaml(headConfigContent) as Record<string, any>;
      if (parsedCfg?.seal?.base && typeof parsedCfg.seal.base === "string") {
        configBase = parsedCfg.seal.base.trim();
      }
    } catch {}
  }
  const { resolved: config } = loadConfig({ cwd, ...(env ? { env } : {}) });
  const baseBranch = (configBase && configBase.length > 0) ? configBase : detectDefaultBase(cwd);
  const baseSha = resolveRef(baseBranch, cwd, env);
  if (!baseSha) {
    return {
      ok: false,
      errors: [`lykos seal create: base branch "${baseBranch}" cannot be resolved`],
    };
  }

  let mergeBase: string | null = null;
  try {
    mergeBase = getMergeBase(head, baseSha, cwd, env);
  } catch {}
  if (mergeBase === head) {
    return {
      ok: false,
      errors: ["lykos seal create: seal.base must be a branch this one was made from"],
    };
  }

  // Files changed by writer commit vs its first parent matching test_globs
  const writerFiles = getCommitChangedFiles(writerCommit, cwd, env);
  const writerTestFiles = writerFiles.filter((f) => matchAnyGlob(f, config.seal.test_globs));

  // All tracked files at writerCommit matching always_sealed
  const allTracked = listTrackedFiles(writerCommit, cwd, env);
  const alwaysSealedFiles = allTracked.filter((f) => matchAnyGlob(f, config.seal.always_sealed));

  const sealRelPath = `.lykos/seals/${branch}.json`;

  // On a reseal, union sealed paths from active seals in writerCommit history that are superseded:
  // - the same branch's seal, or
  // - a parent seal whose sealed tests differ between sealCommit and writerCommit (the upheld-dispute case)
  const previousSealedPaths: string[] = [];
  const supersededSealPaths = new Set<string>();
  const activeAtWriter = activeSeals({ cwd, env, base: baseBranch, commit: writerCommit });

  for (const prev of activeAtWriter) {
    if (prev.untrustedKey || prev.invalidSignature || prev.baseChanged) continue;
    if (!isAncestor(prev.sealCommit, writerCommit, cwd, env)) continue;

    const isSameBranch = prev.relPath === sealRelPath;
    let testsDiffer = false;
    if (!isSameBranch) {
      const testPaths = (Array.isArray(prev.seal.sealed_paths) ? prev.seal.sealed_paths : []).filter(
        (p): p is string =>
          typeof p === "string" && !(p.replace(/\\/g, "/").startsWith(".lykos/seals/") && p.endsWith(".json")),
      );
      const modified = getModifiedFilesSince(prev.sealCommit, testPaths, cwd, env, writerCommit);
      testsDiffer = modified.length > 0;
    }

    if (isSameBranch || testsDiffer) {
      if (!isSameBranch) {
        supersededSealPaths.add(prev.relPath);
      }
      if (Array.isArray(prev.seal.sealed_paths)) {
        for (const p of prev.seal.sealed_paths) {
          if (typeof p === "string") {
            const norm = p.replace(/\\/g, "/");
            if (norm.startsWith(".lykos/seals/") && norm.endsWith(".json") && norm !== sealRelPath) {
              continue;
            }
            previousSealedPaths.push(p);
          }
        }
      }
    }
  }

  const sealedPaths = Array.from(
    new Set([...previousSealedPaths, ...writerTestFiles, ...alwaysSealedFiles, sealRelPath]),
  ).sort();

  // Test files to execute for the red check:
  // On reseal, red requirement applies to tests this writer commit adds or changes.
  // Previously sealed tests the writer did not touch stay sealed but are not required to fail.
  // Reseal with no added/changed test runs all sealed tests matching run_globs.
  const writerRunTests = writerTestFiles.filter((f) => matchAnyGlob(f, config.seal.run_globs));
  const testFiles = writerRunTests.length > 0
    ? writerRunTests
    : sealedPaths.filter((f) => matchAnyGlob(f, config.seal.run_globs));

  if (testFiles.length === 0) {
    return {
      ok: false,
      errors: ["lykos seal create: no test files found matching seal.run_globs to execute"],
    };
  }

  // Find private key
  const privKeys = listPrivateKeys(opts.homeDir);
  if (privKeys.length === 0) {
    return {
      ok: false,
      errors: ['lykos seal create: no private key found in ~/.lykos/seal-keys/. Run "lykos seal key init" first.'],
    };
  }

  // Match key to public keys committed in repo if multiple
  let chosenKey = privKeys[0]!;
  if (privKeys.length > 1) {
    const pubKeyFiles = allTracked.filter(
      (f) => f.startsWith(".lykos/seals/keys/") && f.endsWith(".pub"),
    );
    const matching = privKeys.filter((pk) =>
      pubKeyFiles.some((f) => f === `.lykos/seals/keys/${pk.keyId}.pub`),
    );
    if (matching.length > 0 && matching[0]) {
      chosenKey = matching[0];
    }
  }

  // Execute red check in temporary worktree of writerCommit
  const worktree = createTemporaryWorktree(cwd, writerCommit, env);
  let redTests: SealRedTest[];
  let adapter: SealAdapter;
  let warnings: string[] | undefined;
  let containment: { executor: ProjectExecutor; notice?: string; dispose: () => Promise<void> } | undefined;
  try {
    const containmentLevel = opts.containmentLevel ?? config.containment.level ?? "off";
    let executor: ProjectExecutor = localExecutor;

    if (containmentLevel !== "off") {
      const { startContainment } = await import("../containment/containment.js");
      let gitWorktree: { commonDir: string; gitDir: string } | undefined;
      const gitFilePath = join(worktree.dir, ".git");
      if (existsSync(gitFilePath) && statSync(gitFilePath).isFile()) {
        const gitContent = readFileSync(gitFilePath, "utf8").trim();
        const match = gitContent.match(/^gitdir:\s*(.+)$/);
        if (match && match[1]) {
          const commonOut = gitExec(["rev-parse", "--git-common-dir"], worktree.dir, env);
          const commonDir = resolve(worktree.dir, commonOut);
          gitWorktree = { commonDir, gitDir: resolve(worktree.dir, match[1]) };
        }
      }
      containment = await startContainment({
        config: config.containment.level === containmentLevel ? config.containment : { ...config.containment, level: containmentLevel },
        workspace: worktree.dir,
        ...(gitWorktree !== undefined ? { gitWorktree } : {}),
        hostEnv: env,
        log: (line) => process.stderr.write(`${line}\n`),
      });
      if (containment.notice !== undefined) {
        process.stderr.write(`${containment.notice}\n`);
      }
      executor = containment.executor;
    }

    const checkResult = await runRedCheck({
      worktreeDir: worktree.dir,
      testFiles,
      testCommandTemplate: config.seal.test_command,
      env,
      executor,
    });
    if (!checkResult.ok) {
      return { ok: false, errors: checkResult.errors };
    }
    redTests = checkResult.red;
    adapter = checkResult.adapter;
    warnings = checkResult.warnings;
  } finally {
    try {
      if (containment) {
        await containment.dispose();
      }
    } finally {
      worktree.cleanup();
    }
  }

  // Build seal payload
  const sealPayload: Omit<SealFile, "signature"> = {
    version: 1,
    branch,
    base: baseBranch,
    writer_commit: writerCommit,
    creator: opts.creator ?? "cli",
    specialist: opts.specialist ?? null,
    sealed_paths: sealedPaths,
    test_command: config.seal.test_command,
    adapter,
    red: redTests,
    created_at: new Date().toISOString(),
    key_id: chosenKey.keyId,
  };

  const signature = signPayload(sealPayload as Record<string, unknown>, chosenKey.privateKeyPem);
  const finalSealFile: SealFile = { ...sealPayload, signature };

  // Find merged seals to prune
  const sealsDir = join(cwd, ".lykos", "seals");
  const candidatePaths = new Set<string>();
  if (existsSync(sealsDir)) {
    try {
      for (const entry of readdirSync(sealsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".json")) {
          candidatePaths.add(`.lykos/seals/${entry.name}`);
        }
      }
    } catch {}
  }
  const trackedSeals = listTrackedFiles(writerCommit, cwd, env).filter(
    (f) => f.startsWith(".lykos/seals/") && f.endsWith(".json") && !f.startsWith(".lykos/seals/keys/"),
  );
  for (const f of trackedSeals) {
    candidatePaths.add(f);
  }

  const prunedPathsSet = new Set<string>(supersededSealPaths);

  for (const cand of candidatePaths) {
    if (cand === sealRelPath) continue;
    if (supersededSealPaths.has(cand)) continue;
    // An active seal that was not superseded is kept
    if (activeAtWriter.some((a) => a.relPath === cand)) continue;

    const found = findSealCommit(cand, cwd, env, writerCommit);
    if (found && isAncestor(found.sealCommit, baseSha, cwd, env)) {
      prunedPathsSet.add(cand);
    }
  }

  prunedPathsSet.delete(sealRelPath);
  const prunedPaths = Array.from(prunedPathsSet).sort();

  // Remove pruned seal files from disk
  for (const p of prunedPaths) {
    const full = join(cwd, p);
    if (existsSync(full)) {
      try {
        unlinkSync(full);
      } catch {}
    }
  }

  // Write seal file
  const fullSealPath = join(cwd, sealRelPath);
  mkdirSync(dirname(fullSealPath), { recursive: true });
  writeFileSync(fullSealPath, canonicalJson(finalSealFile) + "\n", "utf8");

  // Commit seal file and any pruned seal files together
  const sealCommit = commitSealFile(cwd, sealRelPath, prunedPaths, `seal: ${branch}`, env);

  // Record ledger event
  const ledgerPath =
    opts.ledgerPath ??
    (config.telemetry.ledger === ".lykos/ledger.db"
      ? defaultLedgerPath(cwd)
      : config.telemetry.ledger);

  await recordSealEvent(ledgerPath, {
    branch,
    kind: "created",
    paths: sealedPaths,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
    creator: opts.creator ?? "cli",
    specialist: opts.specialist ?? null,
    detail: {
      tests: redTests.length,
      key_id: chosenKey.keyId,
      writer_commit: writerCommit,
    },
  });

  return {
    ok: true,
    seal: finalSealFile,
    sealCommit,
    pruned: prunedPaths,
    ...(warnings ? { warnings } : {}),
  };
}
