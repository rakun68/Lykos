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
import { detectAdapter, runRedCheck, type RedOutcome } from "./runner.js";
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
  /**
   * T254: the sealed test files, named. Absent, the writer commit's changed files matching `seal.test_globs`. Every
   * path must exist at the writer commit.
   */
  paths?: readonly string[] | undefined;
  /** T254: false skips the red check; the seal records `red_check: "skipped"`. Default true. */
  red?: boolean | undefined;
  /** T254: the branch the sealed one was made from. Absent, `seal.base`, then the default branch. */
  base?: string | undefined;
}

export interface SealCreateResult {
  ok: boolean;
  /** T254: the red check's outcome, or `skipped`. Absent when creation was refused before it ran. */
  red?: RedOutcome | "skipped" | undefined;
  /** T254, `passing`: the sealed tests that already pass. */
  passing?: string[] | undefined;
  /** T254, `error`: the runner's output. */
  output?: string | undefined;
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
      const parsedCfg = parseYaml(headConfigContent) as { seal?: { base?: unknown } } | null | undefined;
      if (parsedCfg?.seal?.base && typeof parsedCfg.seal.base === "string") {
        configBase = parsedCfg.seal.base.trim();
      }
    } catch {}
  }
  const { resolved: config } = loadConfig({ cwd, ...(env ? { env } : {}) });
  const baseBranch = opts.base !== undefined && opts.base !== "" ? opts.base : (configBase && configBase.length > 0) ? configBase : detectDefaultBase(cwd);
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

  // All tracked files at writerCommit matching always_sealed
  const allTracked = listTrackedFiles(writerCommit, cwd, env);

  // Files changed by writer commit vs its first parent matching test_globs, or (T254) the paths named
  const explicit = opts.paths?.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""));
  if (explicit !== undefined) {
    const tracked = new Set(allTracked);
    const missing = explicit.filter((p) => !tracked.has(p));
    if (explicit.length === 0 || missing.length > 0) {
      return {
        ok: false,
        errors: [explicit.length === 0 ? "lykos seal create: the path list is empty" : `lykos seal create: not in the writer commit: ${missing.join(", ")}`],
      };
    }
  }
  const writerTestFiles = explicit ?? getCommitChangedFiles(writerCommit, cwd, env).filter((f) => matchAnyGlob(f, config.seal.test_globs));
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
  // Named paths are the tests the coordinator means to run, whatever `run_globs` says.
  const writerRunTests = explicit ?? writerTestFiles.filter((f) => matchAnyGlob(f, config.seal.run_globs));
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

  let redTests: SealRedTest[] = [];
  let adapter: SealAdapter = detectAdapter(config.seal.test_command);
  let redSignature: SealFile["red_signature"];
  let warnings: string[] | undefined;
  let redOutcome: RedOutcome | "skipped" = "skipped";
  if (opts.red !== false) {
    // Execute red check in temporary worktree of writerCommit
    const worktree = createTemporaryWorktree(cwd, writerCommit, env);
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
      redOutcome = checkResult.outcome;
      if (checkResult.outcome === "passing") {
        return { ok: false, red: "passing", passing: checkResult.passing, errors: checkResult.errors };
      }
      if (!checkResult.ok || checkResult.outcome === "error") {
        return { ok: false, red: "error", errors: checkResult.errors, ...(checkResult.output !== undefined ? { output: checkResult.output } : {}) };
      }
      redTests = checkResult.red;
      adapter = checkResult.adapter;
      warnings = checkResult.warnings;
      redSignature = checkResult.signature;
    } finally {
      try {
        if (containment) {
          await containment.dispose();
        }
      } finally {
        worktree.cleanup();
      }
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
    ...(redOutcome === "skipped" ? { red_check: "skipped" as const } : {}),
    ...(adapter === "exit" && redSignature !== undefined ? { red_signature: redSignature } : {}),
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
      red: redOutcome,
      key_id: chosenKey.keyId,
      writer_commit: writerCommit,
    },
  });

  return {
    ok: true,
    red: redOutcome,
    seal: finalSealFile,
    sealCommit,
    pruned: prunedPaths,
    ...(warnings ? { warnings } : {}),
  };
}
