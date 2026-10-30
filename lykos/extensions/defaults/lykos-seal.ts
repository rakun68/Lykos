// Lykos-seal default extension (ADR-0034, ADR-0035).
//
// Blocks write/edit operations on sealed paths, warns on bash/powershell references
// to sealed paths, and logs vetoed/bash-warned events in the ledger.

import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import type { LykosExtension, LykosExtensionApi } from "../api.js";
import { Type } from "typebox";
import { activeSeals, type ActiveSeal } from "../../seal/active.js";
import { loadConfig } from "../../config/load.js";
import { DEFAULT_SEAL_ENFORCE_FOR, DEFAULT_SEAL_WEAKENING_PATTERNS } from "../../config/defaults.js";
import { DEFAULT_SPECIALIST } from "../../config/specialists.js";
import { commandPathAccesses } from "../../gate/bash-paths.js";
import { defaultLedgerPath, recordSealEvent, openLedgerSync, type SealEventKind } from "../../ledger/use.js";
import { matchesRule } from "../../gate/path-rules.js";
import { matchGlob, matchAnyGlob } from "../../seal/matcher.js";
import { isFileChangingCall, resolveActualToolArgs, resolveActualToolName } from "../../tools/tool-call.js";
import { verifySeals } from "../../seal/verify.js";
import { runSealedTests } from "../../seal/runner.js";
import { createTemporaryWorktree, getBranchOrNull, getChangedFilesBetween, getWorkingTreeModifiedFiles, getWorkingTreeUncommittedFiles, isAncestor, gitExec } from "../../seal/git.js";
import { localExecutor } from "../../tools/executor.js";
import { scanWeakening } from "../../seal/weakening.js";
import { sealCreate } from "../../seal/create.js";

export const SEAL_EXTENSION = "lykos-seal";

function normalizePath(cwd: string, p: string): string {
  const norm = p.replace(/\\/g, "/");
  if (isAbsolute(norm)) {
    return relative(cwd, norm).replace(/\\/g, "/");
  }
  return norm.replace(/^\.\//, "");
}

const GLOB_CHARS = /[*?[\]{}]/;

export function isGlobPattern(p: string): boolean {
  return GLOB_CHARS.test(p);
}

export function isExactPathMatch(cwd: string, targetPath: string, sPath: string): boolean {
  const normTarget = normalizePath(cwd, targetPath).replace(/\/+$/, "");
  const normSp = sPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (normTarget === normSp) return true;
  try {
    return resolve(cwd, normTarget) === resolve(cwd, normSp);
  } catch {
    return false;
  }
}

export function findSealedPathMatches(
  cwd: string,
  targetPath: string,
  sealedPaths: readonly string[],
): string[] {
  const normTarget = normalizePath(cwd, targetPath);
  const cleanTarget = normTarget.replace(/\/+$/, "");
  const absTarget = resolve(cwd, normTarget);
  const absCwd = resolve(cwd);
  const home = homedir();
  const ctx = { cwd, home, extraDirs: [], outside: { read: "ask" as const, write: "ask" as const } };

  const matches: string[] = [];

  for (const sPath of sealedPaths) {
    const normSp = sPath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    const absSp = resolve(cwd, normSp);

    // 1. Exact match
    if (cleanTarget === normSp || absTarget === absSp) {
      matches.push(sPath);
      continue;
    }

    // 2. Target is inside the sealed path (e.g. sPath was a directory)
    if (normTarget.startsWith(normSp + "/")) {
      matches.push(sPath);
      continue;
    }

    // 3. Sealed path is a glob and target matches it
    if (isGlobPattern(normSp)) {
      if (matchGlob(normTarget, normSp) || matchesRule(normSp, absTarget, ctx)) {
        matches.push(sPath);
        continue;
      }
    }

    // 4. Target is a directory that contains the sealed path (. and repo root included)
    const isRepoRoot = cleanTarget === "." || cleanTarget === "" || absTarget === absCwd;
    if (isRepoRoot && !normSp.startsWith("../")) {
      matches.push(sPath);
      continue;
    }

    if (!isGlobPattern(cleanTarget)) {
      const absTargetDir = absTarget.endsWith("/") ? absTarget : absTarget + "/";
      if (normSp.startsWith(cleanTarget + "/") || absSp.startsWith(absTargetDir)) {
        matches.push(sPath);
        continue;
      }
    }

    // 5. Target is a glob that matches the sealed path
    if (isGlobPattern(cleanTarget) || isGlobPattern(targetPath)) {
      if (
        matchGlob(normSp, cleanTarget) ||
        matchGlob(normSp, targetPath) ||
        matchesRule(cleanTarget, absSp, ctx) ||
        matchesRule(targetPath, absSp, ctx)
      ) {
        matches.push(sPath);
        continue;
      }
    }
  }

  return matches;
}

export function findSealedPathMatch(cwd: string, targetPath: string, sealedPaths: readonly string[]): string | undefined {
  const normTarget = normalizePath(cwd, targetPath);
  const absTarget = resolve(cwd, normTarget);
  const home = homedir();
  const ctx = { cwd, home, extraDirs: [], outside: { read: "ask" as const, write: "ask" as const } };

  for (const sPath of sealedPaths) {
    const normSp = sPath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (normTarget === normSp) return sPath;
    if (normTarget.startsWith(normSp + "/")) return sPath;
    if (matchGlob(normTarget, normSp)) return sPath;
    if (matchesRule(normSp, absTarget, ctx)) return sPath;
  }
  return undefined;
}

function extractTouchedPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)) {
    paths.push(...extractTouchedPaths(input.arguments as Record<string, unknown>));
  } else if (typeof input.arguments === "string") {
    try {
      const parsed = JSON.parse(input.arguments);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        paths.push(...extractTouchedPaths(parsed as Record<string, unknown>));
      }
    } catch {}
  }
  if (input.args && typeof input.args === "object" && !Array.isArray(input.args)) {
    paths.push(...extractTouchedPaths(input.args as Record<string, unknown>));
  }
  if (typeof input.path === "string") paths.push(input.path);
  if (typeof input.file_path === "string") paths.push(input.file_path);
  if (typeof input.filePath === "string") paths.push(input.filePath);
  if (typeof input.file === "string") paths.push(input.file);
  if (typeof input.target === "string") paths.push(input.target);
  if (typeof input.target_path === "string") paths.push(input.target_path);
  if (typeof input.targetPath === "string") paths.push(input.targetPath);
  if (typeof input.destination === "string") paths.push(input.destination);
  if (typeof input.dest === "string") paths.push(input.dest);
  if (Array.isArray(input.paths)) {
    for (const p of input.paths) {
      if (typeof p === "string") paths.push(p);
    }
  }
  if (Array.isArray(input.files)) {
    for (const p of input.files) {
      if (typeof p === "string") paths.push(p);
    }
  }
  if (Array.isArray(input.targets)) {
    for (const p of input.targets) {
      if (typeof p === "string") paths.push(p);
    }
  }
  return paths;
}

function resolveProjectRoot(cwd: string): string {
  try {
    const dotGit = join(cwd, ".git");
    if (existsSync(dotGit)) {
      const stat = statSync(dotGit);
      if (stat.isFile()) {
        const content = readFileSync(dotGit, "utf8");
        const match = content.match(/^gitdir:\s*(.+)$/m);
        const rawGitDir = match?.[1]?.trim();
        if (rawGitDir) {
          const gitDir = resolve(cwd, rawGitDir);
          const commondirFile = join(gitDir, "commondir");
          if (existsSync(commondirFile)) {
            const commonDirRel = readFileSync(commondirFile, "utf8").trim();
            const commonDir = resolve(gitDir, commonDirRel);
            return dirname(commonDir);
          }
        }
      }
    }
  } catch {}
  return cwd;
}

function resolveLedgerPath(cwd: string, configured?: string, apiLedger?: string): string {
  if (apiLedger) {
    return apiLedger;
  }
  if (configured && configured !== ".lykos/ledger.db") {
    return configured;
  }
  return defaultLedgerPath(resolveProjectRoot(cwd));
}

function testKey(file: string, describe: readonly string[], name: string): string {
  const normFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
  return `${normFile}::${describe.join(" > ")}::${name}`;
}

function isUpheldSealInLedger(sealCommit: string, sessionId: string | null, ledgerPath: string): boolean {
  if (!sessionId) return false;
  try {
    const ledger = openLedgerSync(ledgerPath);
    try {
      const rows = ledger.db
        .prepare(`
          WITH RECURSIVE session_tree(id) AS (
            SELECT ?
            UNION ALL
            SELECT s.id FROM sessions s JOIN session_tree st ON s.parent_session_id = st.id
          )
          SELECT detail FROM seal_events
          WHERE kind = 'dispute upheld'
            AND session_id IN (SELECT id FROM session_tree)
        `)
        .all(sessionId) as Array<{ detail: string | null }>;
      for (const r of rows) {
        if (!r.detail) continue;
        try {
          const parsed = JSON.parse(r.detail);
          if (parsed.sealCommit === sealCommit) {
            return true;
          }
        } catch {}
      }
      return false;
    } finally {
      ledger.close();
    }
  } catch {
    return false;
  }
}

function getDisputeCountFromLedger(
  ledgerPath: string,
  sessionId: string | null,
  file: string,
  describe: readonly string[],
  name: string,
): number {
  if (!sessionId) return 0;
  try {
    const ledger = openLedgerSync(ledgerPath);
    try {
      const rows = ledger.db
        .prepare(`
          SELECT kind, detail FROM seal_events
          WHERE session_id = ?
            AND kind IN ('dispute filed', 'dispute rejected', 'dispute upheld', 'dispute escalated')
          ORDER BY id ASC
        `)
        .all(sessionId) as Array<{ kind: string; detail: string | null }>;
      let disputes = 0;
      let activeUnpaired = 0;
      const targetKey = testKey(file, describe, name);
      for (const r of rows) {
        if (!r.detail) continue;
        try {
          const parsed = JSON.parse(r.detail);
          const f = String(parsed.file ?? "");
          const d = Array.isArray(parsed.describe) ? parsed.describe.map(String) : [];
          const n = String(parsed.name ?? "");
          if (testKey(f, d, n) === targetKey) {
            if (r.kind === "dispute filed") {
              disputes++;
              activeUnpaired++;
            } else if (activeUnpaired > 0) {
              // Ruling or escalation for an already-counted dispute: do not count again.
              activeUnpaired--;
            } else {
              // Legacy event without preceding 'dispute filed': count once.
              disputes++;
            }
          }
        } catch {}
      }
      return disputes;
    } finally {
      ledger.close();
    }
  } catch {
    return 0;
  }
}

export function register(api: LykosExtensionApi): void {
  const cwd = api.cwd ?? process.cwd();
  const { resolved: config } = loadConfig({ cwd });
  let cachedSeals: ActiveSeal[] | undefined;
  let needsRefresh = false;

  const parkedTests = new Set<string>();
  const disputeCounts = new Map<string, number>();
  const upheldSealCommits = new Set<string>();

  api.registerTool({
    name: "dispute_test",
    description: "Dispute a sealed test believed to be incorrect or impossible. Parks the test and allows implementation to proceed.",
    parameters: Type.Object({
      file: Type.String({ description: "Path to the test file" }),
      describe: Type.Array(Type.String(), { description: "Full describe path of the test" }),
      name: Type.String({ description: "Name of the test" }),
      reason: Type.String({ description: "Why the test is wrong" }),
      evidence: Type.String({ description: "Evidence supporting the dispute" }),
    }),
    residency: "resident",
    promptPresence: "full",
    async execute(args) {
      const file = String(args.file ?? "");
      const describe = Array.isArray(args.describe) ? args.describe.map(String) : [];
      const name = String(args.name ?? "");
      const reason = String(args.reason ?? "");
      const evidence = String(args.evidence ?? "");

      const normFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
      const key = testKey(file, describe, name);
      const sessionId = api.getSessionId?.() ?? null;
      const ledgerPath = resolveLedgerPath(cwd, config.telemetry.ledger, api.ledgerPath);
      const specialist = api.specialist ?? DEFAULT_SPECIALIST;
      const seals = getSeals();
      const activeSeal = seals.find((s) => findSealedPathMatch(cwd, file, s.seal.sealed_paths));
      if (!activeSeal) {
        return {
          text: `Dispute refused: file ${file} is not covered by any active seal.`,
          isError: true,
        };
      }
      const branch = activeSeal.seal.branch ?? "main";

      async function logDisputeEvent(
        kind: SealEventKind,
        eventSpecialist: string,
        ruling?: string,
        sealCommitSha?: string,
      ): Promise<void> {
        try {
          await recordSealEvent(ledgerPath, {
            branch,
            sessionId,
            creator: sessionId ?? "cli",
            specialist: eventSpecialist,
            kind,
            paths: [file],
            detail: JSON.stringify({
              file,
              describe,
              name,
              reason,
              evidence,
              ...(ruling !== undefined ? { ruling } : {}),
              ...(sealCommitSha !== undefined ? { sealCommit: sealCommitSha } : {}),
            }),
          });
        } catch {}
      }

      // If the disputed file already differs from the seal commit in HEAD or the working tree when dispute_test is called,
      // refuse the dispute with that reason and do not run the child.
      if (activeSeal?.sealCommit) {
        let differsFromSeal = "";
        try {
          differsFromSeal = gitExec(["diff", "--name-only", activeSeal.sealCommit, "--", normFile], cwd);
          if (!differsFromSeal.trim()) {
            differsFromSeal = gitExec(["diff", "--name-only", activeSeal.sealCommit, "HEAD", "--", normFile], cwd);
          }
        } catch {}
        if (differsFromSeal.trim().length > 0) {
          return {
            text: `Dispute refused: test file ${file} already differs from seal commit ${activeSeal.sealCommit.slice(0, 7)} in HEAD or the working tree.`,
            isError: true,
          };
        }
      }

      // Subagent implementers (hop-1 child sessions) cannot spawn child sessions
      let isChildSession = false;
      if (sessionId) {
        try {
          const ledger = openLedgerSync(ledgerPath);
          try {
            const row = ledger.db
              .prepare("SELECT parent_session_id FROM sessions WHERE id = ?")
              .get(sessionId) as { parent_session_id: string | null } | undefined;
            if (row?.parent_session_id) {
              isChildSession = true;
            }
          } finally {
            ledger.close();
          }
        } catch {}
      }

      // Dispute has passed its own checks: record dispute filed before anything else
      await logDisputeEvent("dispute filed", specialist);

      if (isChildSession) {
        parkedTests.add(key);
        return {
          text: `Dispute filed for ${file} > ${describe.join(" > ")} > ${name}. Test parked. Escalated to parent session.`,
        };
      }

      const resolver = config.seal.resolver ?? (api.delegated ? "orchestrator" : "test-writer");
      if (resolver === "orchestrator") {
        parkedTests.add(key);
        return {
          text: `Dispute filed for ${file} > ${describe.join(" > ")} > ${name}. Test parked.`,
        };
      }

      // resolver is "test-writer"
      const inMemory = (disputeCounts.get(key) ?? 0) + 1;
      disputeCounts.set(key, inMemory);
      const ledgerCount = getDisputeCountFromLedger(ledgerPath, sessionId, file, describe, name);
      const count = Math.max(inMemory, ledgerCount);
      const escalateAfter = config.seal.escalate_after ?? 1;
      const testWriterSpecialist = activeSeal.seal.specialist ?? config.seal.writers?.[0] ?? "test-writer";

      if (count > escalateAfter) {
        parkedTests.add(key);
        await logDisputeEvent("dispute escalated", testWriterSpecialist);
        return {
          text: `Dispute escalated: test disputed ${count} times (exceeds escalate_after limit of ${escalateAfter}); no parent session or human channel available. Test parked.`,
        };
      }

      const testPath = describe.length > 0 ? `${describe.join(" > ")} > ${name}` : name;
      const prompt = [
        `A dispute was filed against sealed test: ${file} > ${testPath}`,
        `Reason: ${reason}`,
        `Evidence: ${evidence}`,
        "",
        `Review the test:`,
        `- If the dispute is valid (upheld), update the test file to match the specification and commit the change with git.`,
        `- If the dispute is invalid (rejected), explain why the test is correct without modifying it.`,
        `State your final ruling clearly.`,
      ].join("\n");

      let headBefore = "";
      try {
        headBefore = gitExec(["rev-parse", "HEAD"], cwd).trim();
      } catch {}

      let childRes;
      try {
        childRes = await api.runChildSession({
          prompt,
          specialist: testWriterSpecialist,
          writable: true,
        });
      } catch (err) {
        childRes = { status: "error" as const, model: "", message: err instanceof Error ? err.message : String(err) };
      }

      if (childRes.status === "unavailable") {
        parkedTests.add(key);
        await logDisputeEvent("dispute escalated", testWriterSpecialist);
        return {
          text: `Dispute escalated: child sessions unavailable. Test parked.`,
        };
      }

      if (childRes.status !== "ok") {
        return {
          text: `Failed to resolve dispute with test writer: ${childRes.message}`,
          isError: true,
        };
      }

      let childDiff = "";
      if (headBefore) {
        try {
          const headAfter = gitExec(["rev-parse", "HEAD"], cwd).trim();
          childDiff = gitExec(["diff", "--name-only", headBefore, headAfter, "--", normFile], cwd);
        } catch {}
      }
      const isUpheld = childDiff.trim().length > 0;

      if (isUpheld) {
        const currentBranch = getBranchOrNull(cwd, process.env);
        const sealRes = await sealCreate({
          cwd,
          ...(currentBranch ? {} : { branch }),
          creator: sessionId ?? "cli",
          specialist: testWriterSpecialist,
          ledgerPath,
          env: process.env,
        });
        if (!sealRes.ok || !sealRes.sealCommit) {
          parkedTests.add(key);
          const errDetail = sealRes.errors?.join("; ") ?? "reseal failed";
          return {
            text: `Failed to reseal after upheld dispute: ${errDetail}`,
            isError: true,
          };
        }
        upheldSealCommits.add(sealRes.sealCommit);
        needsRefresh = true;
        getSeals();

        parkedTests.delete(key);

        await logDisputeEvent("dispute upheld", testWriterSpecialist, childRes.text, sealRes.sealCommit);

        return {
          text: `Dispute upheld: ${childRes.text}`,
        };
      } else {
        parkedTests.delete(key);

        await logDisputeEvent("dispute rejected", testWriterSpecialist, childRes.text);

        return {
          text: `Dispute rejected: ${childRes.text}`,
        };
      }
    },
  });

  function getSeals(): ActiveSeal[] {
    if (cachedSeals === undefined || needsRefresh) {
      try {
        cachedSeals = activeSeals({ cwd });
      } catch {
        cachedSeals = [];
      }
      needsRefresh = false;
    }
    return cachedSeals;
  }

  // Pre-load active seals at start
  getSeals();

  api.on("checkpoint_written", () => {
    needsRefresh = true;
  });

  api.on("tool_call", async (event) => {
    if (needsRefresh) {
      getSeals();
    }
    const seals = getSeals();

    const actualToolName = resolveActualToolName(event.toolName, event.input) ?? event.toolName;
    const actualInput =
      (resolveActualToolArgs(event.toolName, event.input) as Record<string, unknown> | undefined) ?? event.input;

    if (actualToolName === "commit" || event.toolName === "commit") {
      needsRefresh = true;
    }

    if (seals.length === 0) return undefined;

    const specialist = api.specialist ?? DEFAULT_SPECIALIST;
    const enforceFor = config.seal.enforce_for ?? DEFAULT_SEAL_ENFORCE_FOR;
    if (!enforceFor.includes(specialist)) {
      return undefined;
    }

    const modifyingTools = new Set(["edit", "write", "ast_edit"]);
    if (
      modifyingTools.has(actualToolName) ||
      modifyingTools.has(event.toolName) ||
      isFileChangingCall(event.toolName, event.input)
    ) {
      const touchedPaths = Array.from(
        new Set([...extractTouchedPaths(event.input), ...extractTouchedPaths(actualInput)]),
      );
      for (const p of touchedPaths) {
        for (const s of seals) {
          const matches = findSealedPathMatches(cwd, p, s.seal.sealed_paths);
          if (matches.length > 0) {
            const isExact = matches.some((m) => isExactPathMatch(cwd, p, m));
            const sessionId = api.getSessionId?.() ?? null;
            const ledgerPath = resolveLedgerPath(cwd, config.telemetry.ledger, api.ledgerPath);
            try {
              await recordSealEvent(ledgerPath, {
                branch: s.seal.branch,
                sessionId,
                creator: sessionId ?? "cli",
                specialist,
                kind: "vetoed",
                paths: matches,
                detail: isExact
                  ? `${event.toolName} ${matches[0]}`
                  : `${event.toolName} ${p} (sealed: ${matches.join(", ")})`,
              });
            } catch {
              // Ignore ledger recording error
            }
            if (isExact) {
              return {
                block: true,
                reason: `[lykos-seal] Veto: cannot modify sealed file "${matches[0]}". This path is protected by an active test seal. Use dispute_test to dispute this test.`,
              };
            }
            const filesDesc = matches.map((f) => `"${f}"`).join(", ");
            return {
              block: true,
              reason: `[lykos-seal] Veto: cannot modify "${p}" because it covers sealed file${matches.length > 1 ? "s" : ""} ${filesDesc}. This path is protected by an active test seal. Pass explicit paths that exclude the sealed files, or use dispute_test to dispute this test.`,
            };
          }
        }
      }
    }

    if (
      actualToolName === "bash" ||
      actualToolName === "powershell" ||
      event.toolName === "bash" ||
      event.toolName === "powershell"
    ) {
      const command =
        typeof actualInput.command === "string"
          ? actualInput.command
          : typeof actualInput.cmd === "string"
          ? actualInput.cmd
          : typeof event.input.command === "string"
          ? event.input.command
          : typeof event.input.cmd === "string"
          ? event.input.cmd
          : undefined;
      if (command) {
        const accesses = commandPathAccesses(command);
        const matched = new Set<string>();
        let matchedBranch: string | undefined;
        for (const acc of accesses) {
          for (const s of seals) {
            const m = findSealedPathMatch(cwd, acc.path, s.seal.sealed_paths);
            if (m !== undefined) {
              matched.add(m);
              if (!matchedBranch) {
                matchedBranch = s.seal.branch;
              }
            }
          }
        }
        if (matched.size > 0) {
          const matchedList = [...matched];
          const sessionId = api.getSessionId?.() ?? null;
          const ledgerPath = resolveLedgerPath(cwd, config.telemetry.ledger, api.ledgerPath);
          try {
            await recordSealEvent(ledgerPath, {
              branch: matchedBranch ?? seals[0]!.seal.branch,
              sessionId,
              creator: sessionId ?? "cli",
              specialist,
              kind: "bash-warned",
              paths: matchedList,
              detail: `${command} (sealed: ${matchedList.join(", ")})`,
            });
          } catch {
            // Ignore ledger recording error
          }
          return {
            block: false,
            warning: `[lykos-seal] Warning: command references sealed path(s): ${matchedList.join(", ")}. Sealed paths cannot be modified; edit and write operations are blocked.`,
          };
        }
      }
    }

    return undefined;
  });

  api.registerGateCheck(async (ctx) => {
    needsRefresh = true;
    const seals = getSeals();
    if (seals.length === 0) return { pass: true };

    const specialist = ctx.specialist ?? api.specialist ?? DEFAULT_SPECIALIST;
    const enforceFor = config.seal.enforce_for ?? DEFAULT_SEAL_ENFORCE_FOR;
    if (!enforceFor.includes(specialist)) {
      return { pass: true };
    }

    const checkCwd = ctx.cwd ?? cwd;
    const ledgerPath = resolveLedgerPath(checkCwd, config.telemetry.ledger, ctx.ledgerPath ?? api.ledgerPath);
    const sessionId = ctx.sessionId ?? api.getSessionId?.() ?? null;

    const activeBranches = new Set(seals.map((s) => s.seal.branch));
    const allParked = new Set<string>(parkedTests);
    if (sessionId) {
      try {
        const ledger = openLedgerSync(ledgerPath);
        try {
          const rows = ledger.db
            .prepare(`
              WITH RECURSIVE session_tree(id) AS (
                SELECT ?
                UNION ALL
                SELECT s.id FROM sessions s JOIN session_tree st ON s.parent_session_id = st.id
              )
              SELECT branch, kind, paths, detail FROM seal_events
              WHERE kind IN ('dispute filed', 'dispute escalated', 'dispute rejected', 'dispute upheld')
                AND session_id IN (SELECT id FROM session_tree)
              ORDER BY id ASC
            `)
            .all(sessionId) as Array<{ branch: string | null; kind: string; paths: string; detail: string | null }>;
          for (const r of rows) {
            if (!r.detail || !r.branch || !activeBranches.has(r.branch)) continue;
            try {
              const parsed = JSON.parse(r.detail);
              if (parsed.file && parsed.name && Array.isArray(parsed.describe)) {
                const k = testKey(parsed.file, parsed.describe, parsed.name);
                if (r.kind === "dispute filed" || r.kind === "dispute escalated") {
                  allParked.add(k);
                } else if (r.kind === "dispute rejected" || r.kind === "dispute upheld") {
                  allParked.delete(k);
                }
              }
            } catch {}
          }
        } finally {
          ledger.close();
        }
      } catch {}
    }

    // Ruling 2: The session's start commit is HEAD when the session boots; record it on the session.
    // A seal whose seal commit is not an ancestor of it is rejected for an enforced specialist, whatever its creator field says.
    // T204: Reseals created by an upheld dispute in-session are recognized and valid.
    if (ctx.startCommit) {
      for (const s of seals) {
        if (!isAncestor(s.sealCommit, ctx.startCommit, checkCwd)) {
          const isUpheldReseal =
            upheldSealCommits.has(s.sealCommit) ||
            isUpheldSealInLedger(s.sealCommit, sessionId, ledgerPath);
          if (!isUpheldReseal) {
            try {
              await recordSealEvent(ledgerPath, {
                branch: s.seal.branch,
                sessionId,
                creator: sessionId ?? "cli",
                specialist,
                kind: "rejected",
                paths: s.seal.sealed_paths,
                detail: `seal commit ${s.sealCommit.slice(0, 7)} was created in-session; rejected for specialist "${specialist}"`,
              });
            } catch {}
            return {
              block: true,
              reason: `[lykos-seal] Seal rejected: seal commit ${s.sealCommit.slice(0, 7)} is not an ancestor of session start commit ${ctx.startCommit.slice(0, 7)}. Seals created in-session are rejected for specialist "${specialist}".`,
            };
          }
        }
      }
    }

    // Check for changed sealed files in working tree or between sealCommit and HEAD
    for (const s of seals) {
      const nonSealPaths = s.seal.sealed_paths.filter((p) => p !== s.relPath && !p.startsWith(".lykos/"));
      const modifiedWorkingTree = getWorkingTreeModifiedFiles(s.sealCommit, nonSealPaths, checkCwd);
      if (modifiedWorkingTree.length > 0) {
        const deletedPaths = modifiedWorkingTree.filter((p) => !existsSync(resolve(checkCwd, p)));
        const detail = deletedPaths.length > 0
          ? `deleted sealed paths: ${deletedPaths.join(", ")}${modifiedWorkingTree.length > deletedPaths.length ? `; modified sealed paths: ${modifiedWorkingTree.filter((p) => !deletedPaths.includes(p)).join(", ")}` : ""}`
          : `changed sealed paths: ${modifiedWorkingTree.join(", ")}`;
        try {
          await recordSealEvent(ledgerPath, {
            branch: s.seal.branch,
            sessionId,
            creator: sessionId ?? "cli",
            specialist,
            kind: "tampered",
            paths: modifiedWorkingTree,
            detail,
          });
        } catch {}
        const desc = deletedPaths.length > 0
          ? `Sealed file(s) modified or deleted: ${modifiedWorkingTree.join(", ")}`
          : `Sealed file(s) modified: ${modifiedWorkingTree.join(", ")}`;
        return {
          block: true,
          reason: `[lykos-seal] ${desc}`,
        };
      }
    }

    // Verify seals (signature, key trust, ancestors, test command, etc.)
    const verifyResult = await verifySeals({
      cwd: checkCwd,
      record: false,
    });
    if (!verifyResult.ok) {
      for (const item of verifyResult.seals) {
        if (!item.valid) {
          try {
            await recordSealEvent(ledgerPath, {
              branch: item.branch,
              sessionId,
              creator: sessionId ?? "cli",
              specialist,
              kind: "tampered",
              paths: item.sealedPaths,
              detail: item.causes.join("; "),
            });
          } catch {}
          return {
            block: true,
            reason: `[lykos-seal] Seal verification failed: ${item.causes.join("; ")}`,
          };
        }
      }
    }

    // If weakening is detected outside the seal, defer to the weakening gate check
    const weakeningPatterns = Array.from(
      new Set([
        ...DEFAULT_SEAL_WEAKENING_PATTERNS,
        ...(config.seal.weakening_patterns ?? []),
      ]),
    );
    const weakeningMatches = scanWeakening({
      cwd: checkCwd,
      seals,
      patterns: weakeningPatterns,
      isSealed: (file, allSealedPaths) => findSealedPathMatch(checkCwd, file, allSealedPaths) !== undefined,
    });
    if (weakeningMatches.length > 0) {
      return { pass: true };
    }

    // Green run of sealed tests in a clean temporary checkout of HEAD
    const executor = ctx.executor ?? localExecutor;
    const allUncommitted = getWorkingTreeUncommittedFiles(checkCwd);

    for (const s of seals) {
      const sealedNormalized = new Set(s.seal.sealed_paths.map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")));
      sealedNormalized.add(s.relPath.replace(/\\/g, "/").replace(/^\.\//, ""));

      const uncommittedOutsideSealed = allUncommitted.filter((p) => {
        const norm = p.replace(/\\/g, "/").replace(/^\.\//, "");
        if (norm.startsWith(".lykos/")) return false;
        return !sealedNormalized.has(norm);
      });
      const uncommittedSuffix =
        uncommittedOutsideSealed.length > 0
          ? "; uncommitted changes are not part of the green run; commit them"
          : "";

      const { dir: tempDir, cleanup } = createTemporaryWorktree(checkCwd, "HEAD");
      try {
        const sealedTestFiles = s.seal.sealed_paths.filter((p) => matchAnyGlob(p, config.seal.run_globs));
        const implementerChanged = getChangedFilesBetween(s.sealCommit, "HEAD", checkCwd);
        const implementerTestFiles = implementerChanged
          .map((p) => p.replace(/\\/g, "/"))
          .filter((p) => matchAnyGlob(p, config.seal.run_globs));
        const testFiles = Array.from(new Set([...sealedTestFiles, ...implementerTestFiles]));
        const runRes = await runSealedTests({
          executor,
          dir: tempDir,
          files: testFiles,
          template: s.seal.test_command,
          mode: "green",
        });

        if (s.seal.adapter === "exit") {
          if (!runRes.ok) {
            const detail = (runRes.errors.join("; ") || "exit-code mode test failed") + uncommittedSuffix;
            try {
              await recordSealEvent(ledgerPath, {
                branch: s.seal.branch,
                sessionId,
                creator: sessionId ?? "cli",
                specialist,
                kind: "failed",
                paths: s.seal.sealed_paths,
                detail,
              });
            } catch {}
            return {
              block: true,
              reason: `[lykos-seal] Green run failed in exit-code mode: ${detail}`,
            };
          }
        } else {
          // If the runner returned errors and collected no tests, report runner errors rather than "not collected" for each test
          if (runRes.errors.length > 0 && runRes.tests.length === 0) {
            if (sessionId) {
              try {
                const ledger = openLedgerSync(ledgerPath);
                try {
                  const row = ledger.db.prepare("SELECT task_id FROM sessions WHERE id = ?").get(sessionId) as { task_id: string | null } | undefined;
                  if (row?.task_id) {
                    const task = ledger.db.prepare("SELECT state FROM tasks WHERE id = ?").get(row.task_id) as { state: string | null } | undefined;
                    if (task?.state === "disputed") {
                      ledger.setTaskState(row.task_id, "open");
                    }
                  }
                } finally {
                  ledger.close();
                }
              } catch {}
            }

            const detail = runRes.errors.join("; ") + uncommittedSuffix;
            try {
              await recordSealEvent(ledgerPath, {
                branch: s.seal.branch,
                sessionId,
                creator: sessionId ?? "cli",
                specialist,
                kind: "failed",
                paths: s.seal.sealed_paths,
                detail,
              });
            } catch {}
            return {
              block: true,
              reason: `[lykos-seal] Green run failed: ${detail}`,
            };
          }

          // Collect failing tests from red list and run results
          const failingTestKeys = new Set<string>();
          const failingDetails: string[] = [];

          for (const redTest of s.seal.red) {
            const normRedFile = redTest.file.replace(/\\/g, "/").replace(/^\.\//, "");
            const matching = runRes.tests.find(
              (t) =>
                t.file.replace(/\\/g, "/").replace(/^\.\//, "") === normRedFile &&
                t.name === redTest.name &&
                t.describe.join(" > ") === redTest.describe.join(" > "),
            );
            if (!matching) {
              const k = testKey(redTest.file, redTest.describe, redTest.name);
              failingTestKeys.add(k);
              failingDetails.push(`${redTest.file}: "${redTest.name}" not collected`);
            } else if (matching.status !== "pass") {
              const k = testKey(redTest.file, redTest.describe, redTest.name);
              failingTestKeys.add(k);
              failingDetails.push(`${redTest.file}: "${redTest.name}" failed: ${matching.status}`);
            }
          }

          for (const t of runRes.tests) {
            if (t.status !== "pass") {
              const k = testKey(t.file, t.describe, t.name);
              failingTestKeys.add(k);
              failingDetails.push(`${t.file}: "${t.name}" failed: ${t.status}`);
            }
          }

          const hasFailures = failingTestKeys.size > 0 || (runRes.fileErrors && runRes.fileErrors.size > 0) || !runRes.ok;

          if (hasFailures) {
            const allFailingParked =
              failingTestKeys.size > 0 &&
              (!runRes.fileErrors || runRes.fileErrors.size === 0) &&
              [...failingTestKeys].every((k) => allParked.has(k));

            if (allFailingParked) {
              if (sessionId) {
                try {
                  const ledger = openLedgerSync(ledgerPath);
                  try {
                    ledger.setTaskStateForSession(sessionId, "disputed");
                  } finally {
                    ledger.close();
                  }
                } catch {}
              }
              const detail = `disputed sealed tests: ${[...failingTestKeys].join(", ")}` + uncommittedSuffix;
              try {
                await recordSealEvent(ledgerPath, {
                  branch: s.seal.branch,
                  sessionId,
                  creator: sessionId ?? "cli",
                  specialist,
                  kind: "disputed",
                  paths: s.seal.sealed_paths,
                  detail,
                });
              } catch {}
              return {
                block: true,
                reason: `[lykos-seal] Sealed tests failed on disputed/parked tests: ${detail}`,
              };
            }

            // Not all failing tests are parked: ordinary failure
            if (sessionId) {
              try {
                const ledger = openLedgerSync(ledgerPath);
                try {
                  const row = ledger.db.prepare("SELECT task_id FROM sessions WHERE id = ?").get(sessionId) as { task_id: string | null } | undefined;
                  if (row?.task_id) {
                    const task = ledger.db.prepare("SELECT state FROM tasks WHERE id = ?").get(row.task_id) as { state: string | null } | undefined;
                    if (task?.state === "disputed") {
                      ledger.setTaskState(row.task_id, "open");
                    }
                  }
                } finally {
                  ledger.close();
                }
              } catch {}
            }

            const notCollected = failingDetails.some((d) => d.includes("not collected")) || runRes.errors.some((e) => e.includes("not collected"));
            const kind = notCollected ? "not collected" : "failed";
            const detail = (failingDetails.join("; ") || runRes.errors.join("; ") || "sealed tests failed in clean checkout") + uncommittedSuffix;
            try {
              await recordSealEvent(ledgerPath, {
                branch: s.seal.branch,
                sessionId,
                creator: sessionId ?? "cli",
                specialist,
                kind,
                paths: s.seal.sealed_paths,
                detail,
              });
            } catch {}
            return {
              block: true,
              reason: `[lykos-seal] Green run failed: ${detail}`,
            };
          }
        }

        try {
          await recordSealEvent(ledgerPath, {
            branch: s.seal.branch,
            sessionId,
            creator: sessionId ?? "cli",
            specialist,
            kind: "verified",
            paths: s.seal.sealed_paths,
            detail:
              s.seal.adapter === "exit"
                ? "green run passed (exit-code mode; weaker guarantee)"
                : `green run passed (${runRes.tests.length} tests)`,
          });
        } catch {}
      } finally {
        cleanup();
      }
    }

    return { pass: true };
  });

  // T202: the weakening scan as a second gate check
  api.registerGateCheck(async (ctx) => {
    needsRefresh = true;
    const seals = getSeals();
    if (seals.length === 0) return { pass: true };

    const specialist = ctx.specialist ?? api.specialist ?? DEFAULT_SPECIALIST;
    const enforceFor = config.seal.enforce_for ?? DEFAULT_SEAL_ENFORCE_FOR;
    if (!enforceFor.includes(specialist)) {
      return { pass: true };
    }

    const checkCwd = ctx.cwd ?? cwd;
    const patterns = Array.from(
      new Set([
        ...DEFAULT_SEAL_WEAKENING_PATTERNS,
        ...(config.seal.weakening_patterns ?? []),
      ]),
    );

    const matches = scanWeakening({
      cwd: checkCwd,
      seals,
      patterns,
      isSealed: (file, allSealedPaths) => findSealedPathMatch(checkCwd, file, allSealedPaths) !== undefined,
    });

    if (matches.length > 0) {
      const ledgerPath = resolveLedgerPath(
        checkCwd,
        config.telemetry.ledger,
        ctx.ledgerPath ?? api.ledgerPath,
      );
      const sessionId = ctx.sessionId ?? api.getSessionId?.() ?? null;

      for (const m of matches) {
        try {
          await recordSealEvent(ledgerPath, {
            branch: m.branch,
            sessionId,
            creator: sessionId ?? "cli",
            specialist,
            kind: "weakened",
            paths: [m.file],
            detail: `${m.file}:${m.line}: ${m.pattern}`,
          });
        } catch {}
      }

      const detail = matches
        .map((m) => `${m.file}:${m.line}: ${m.pattern}`)
        .join("; ");
      return {
        pass: false,
        block: true,
        reason: `[lykos-seal] Test weakening detected: ${detail}`,
      };
    }

    return { pass: true };
  });
}

export const sealExtension: LykosExtension = {
  name: SEAL_EXTENSION,
  register,
};

export default sealExtension;
