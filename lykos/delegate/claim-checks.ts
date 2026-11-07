// The harness runs each claim's check (T234, ADR-0059, ADR-0061, spec decision 12). The reviewer never does, and the
// worker's words decide nothing: a verdict says what a tool saw.
//
// Where a check runs:
//   - `line` and `search` are read from a temporary worktree at the final head by this module: no shell, no project
//     code, so they run whatever the project's trust or containment.
//   - `command` and `reproduction` run project code, in a temporary worktree of their own:
//       containment on  -> in the container (the worktree is mounted into it); not marked
//       containment off, project trusted by the user's store -> on the host behind a recorded spawn guard, and the
//                          verdict is marked `uncontained` (ADR-0061)
//       containment off, project not trusted -> not run: `unchecked`, with the reason
//   - A reproduction also runs at the base commit, to say whether the change broke it. A lockfile that differs
//     between base and head makes the base verdict `unknown`.
//
// Before a worktree is removed the check's processes are proven stopped (T256): what the check left running is
// killed, then confirmed through the process records. A process that cannot be proven stopped keeps the worktree
// (fail-closed) and the verdict says so.
//
// A check that cannot run (the command is not found, it timed out, the runner reports no test names) is `unchecked`,
// never `failed`: `failed` is reserved for a check that ran and found the claim false.

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { loadConfig } from "../config/load.js";
import type { Containment } from "../containment/containment.js";
import { isStoreTrusted, type TrustSource } from "../gate/trust.js";
import { hostGit } from "../git/host-git.js";
import { openLedgerSync } from "../ledger/use.js";
import { createGuardedExecutor } from "../process/shell.js";
import { confirmQuiescence, type NotStopped, type QuiescenceDeps } from "../process/quiescence.js";
import { createTemporaryWorktree } from "../seal/git.js";
import { runSealedTests, type RunSealedTestsResult, type SealedTestResult } from "../seal/runner.js";
import { startWorktreeContainment } from "../seal/contained-worktree.js";
import { runVerificationCommand, VERIFICATION_TIMEOUT_MS } from "../session/verify-outcome.js";
import type { ExecChild, ProjectExecutor } from "../tools/executor.js";
import { killExecChild, killProcessTree } from "../tools/job-runner.js";
import { lockfileHashAt } from "./baseline.js";
import { reportedCheck, type BaseVerdict, type ClaimCheck, type ClaimResult, type StoredClaim } from "./claims.js";
import type { ContainmentChoice } from "./session-protocol.js";

export interface ClaimCheckDeps {
  /** Tests: the worktree maker, to see when a worktree is removed. */
  createWorktree?: (cwd: string, commit: string, env?: NodeJS.ProcessEnv) => { dir: string; cleanup: () => void };
  /** Tests: the container for a worktree. Absent: the project's containment, started over the worktree. */
  startContained?: (worktreeDir: string, level: ContainmentChoice) => Promise<Containment>;
  /** Tests: how a process is proven gone. */
  quiescence?: QuiescenceDeps;
}

export interface CheckClaimsInput {
  /** The caller's tree: the project's root, whose repository the worktrees are made from. */
  repo: string;
  ledgerPath: string;
  /** The session the claims belong to; process records are filed under it with the claim's id. */
  sessionId: string;
  claims: readonly StoredClaim[];
  /** The final head: the commit the claims are about. */
  head: string;
  /** The commit the work started from; a reproduction is also run there. */
  base?: string | undefined;
  /** How the project's trust was established. Only the user's store (and the prompt that writes it) trusts. */
  trust: TrustSource | undefined;
  containment: ContainmentChoice;
  /** `seal.test_command`, with `{files}`. */
  testCommand: string;
  /** The limit on one check. Default: the verification timeout. */
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  /** `delegation.shell_path`. */
  shellPath?: string | undefined;
  deps?: ClaimCheckDeps | undefined;
}

type Execution<T> = { ran: true; value: T; uncontained: boolean; kept?: string } | { ran: false; reason: string };

type Checked = Pick<ClaimResult, "verdict" | "reason"> & Partial<Pick<ClaimResult, "uncontained" | "base" | "regression">>;

const unchecked = (reason: string): Checked => ({ verdict: "unchecked", reason });
const short = (text: string, max = 300): string => (text.length > max ? `${text.slice(0, max)}...` : text);
const tail = (text: string, max = 300): string => (text.length > max ? `...${text.slice(-max)}` : text);
const seconds = (ms: number): string => `${Math.round(ms / 1000)}s`;

/** Runs every claim's check. Never throws: a check that could not run is `unchecked`, with why. */
export async function checkClaims(input: CheckClaimsInput): Promise<ClaimResult[]> {
  const head = resolveCommit(input.repo, input.head);
  if (head === undefined) {
    return input.claims.map((c) => ({ id: c.id, text: c.text, check: reportedCheck(c.check), ...unchecked(`the final head "${input.head}" names no commit`) }));
  }
  const base = input.base !== undefined ? resolveCommit(input.repo, input.base) : undefined;
  const ctx = new CheckContext(input, head, base);
  const results: ClaimResult[] = [];
  try {
    for (const claim of input.claims) {
      let checked: Checked;
      try {
        checked = await ctx.check(claim);
      } catch (err) {
        checked = unchecked(`the check could not run: ${err instanceof Error ? err.message : String(err)}`);
      }
      results.push({ id: claim.id, text: claim.text, check: reportedCheck(claim.check), ...checked });
    }
  } finally {
    ctx.close();
  }
  return results;
}

function resolveCommit(repo: string, ref: string): string | undefined {
  const r = hostGit(["rev-parse", "--verify", `${ref}^{commit}`], repo);
  return r.ok ? r.stdout : undefined;
}

class CheckContext {
  private readTree: { dir: string; cleanup: () => void } | undefined;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly makeWorktree: NonNullable<ClaimCheckDeps["createWorktree"]>;

  constructor(
    private readonly input: CheckClaimsInput,
    private readonly head: string,
    private readonly base: string | undefined,
  ) {
    this.timeoutMs = input.timeoutMs ?? VERIFICATION_TIMEOUT_MS;
    this.env = input.env ?? process.env;
    this.makeWorktree = input.deps?.createWorktree ?? createTemporaryWorktree;
  }

  close(): void {
    this.readTree?.cleanup();
    this.readTree = undefined;
  }

  async check(claim: StoredClaim): Promise<Checked> {
    const c = claim.check;
    switch (c.kind) {
      case "line":
        return this.line(c);
      case "search":
        return this.search(c);
      case "command":
        return this.command(claim, c);
      case "reproduction":
        return this.reproduction(claim, c);
    }
  }

  // --- read-only checks ------------------------------------------------------------------------------------------

  private tree(): string {
    this.readTree ??= this.makeWorktree(this.input.repo, this.head, this.env);
    return this.readTree.dir;
  }

  /** A tracked file's text at the head, or why not. The path stays inside the worktree. */
  private readTracked(rel: string): { text: string } | { missing: string } {
    const dir = this.tree();
    const full = join(dir, rel);
    try {
      const real = realpathSync(full);
      const root = realpathSync(dir);
      if (real !== root && !real.startsWith(root + sep)) return { missing: `${rel} resolves outside the repository` };
      if (lstatSync(full).isSymbolicLink() || !statSync(real).isFile()) return { missing: `${rel} is not a file` };
      return { text: readFileSync(real, "utf8") };
    } catch {
      return { missing: `${rel} does not exist at ${this.head.slice(0, 12)}` };
    }
  }

  private line(c: Extract<ClaimCheck, { kind: "line" }>): Checked {
    const file = this.readTracked(c.path);
    if ("missing" in file) return { verdict: "failed", reason: file.missing };
    const lines = file.text.split("\n").map((l) => l.replace(/\r$/, ""));
    if (lines.at(-1) === "") lines.pop();
    if (c.line > lines.length) return { verdict: "failed", reason: `${c.path} has ${lines.length} line${lines.length === 1 ? "" : "s"}; line ${c.line} does not exist` };
    const actual = lines[c.line - 1]!;
    return actual.includes(c.text)
      ? { verdict: "verified", reason: `line ${c.line} of ${c.path} contains the text` }
      : { verdict: "failed", reason: `line ${c.line} of ${c.path} is ${JSON.stringify(short(actual, 200))}, which does not contain the text` };
  }

  private search(c: Extract<ClaimCheck, { kind: "search" }>): Checked {
    const dir = this.tree();
    const listed = hostGit(["ls-files", "-z"], dir, { raw: true });
    if (!listed.ok) return unchecked(`could not list the files at ${this.head.slice(0, 12)}: ${listed.stderr}`);
    const re = new RegExp(c.pattern);
    const hits: string[] = [];
    let total = 0;
    let files = 0;
    for (const rel of listed.stdout.split("\0").filter((f) => f !== "")) {
      if (c.paths !== undefined && !c.paths.some((p) => rel === p || rel.startsWith(`${p}/`))) continue;
      const file = this.readTracked(rel);
      if ("missing" in file || file.text.slice(0, 8192).includes("\0")) continue;
      files += 1;
      const lines = file.text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i]!.replace(/\r$/, ""))) continue;
        total += 1;
        if (hits.length < 5) hits.push(`${rel}:${i + 1}`);
      }
    }
    const where = hits.length > 0 ? ` (${hits.join(", ")}${total > hits.length ? ", ..." : ""})` : "";
    const found = `${total} line${total === 1 ? "" : "s"} match${total === 1 ? "es" : ""} in ${files} file${files === 1 ? "" : "s"}${where}`;
    return total === c.matches ? { verdict: "verified", reason: found } : { verdict: "failed", reason: `${found}; expected ${c.matches}` };
  }

  // --- checks that run project code -------------------------------------------------------------------------------

  private trusted(): boolean {
    return isStoreTrusted(this.input.trust);
  }

  /**
   * Runs `body` in a fresh worktree of `commit` on the executor the rules above give, and proves everything it started
   * stopped before the worktree goes. `ran: false` carries the reason the rules say the check may not run. `kept`
   * says a process was not proven stopped and the worktree was therefore left in place.
   */
  private async execute<T>(
    claim: StoredClaim,
    commit: string,
    label: string,
    body: (run: { dir: string; executor: ProjectExecutor }) => Promise<T>,
  ): Promise<Execution<T>> {
    const { containment } = this.input;
    if (containment === "off" && !this.trusted()) {
      return {
        ran: false,
        reason: "the project is not trusted and containment is off: nothing the claim runs is run on this machine (trust the project, or turn containment on)",
      };
    }
    const worktree = this.makeWorktree(this.input.repo, commit, this.env);
    const key = `claim:${this.input.sessionId}:${claim.id}:${label}`;
    const children: ExecChild[] = [];
    let contained: Containment | undefined;
    let removable = true;
    let kept: string | undefined;
    let outcome: Execution<T>;
    try {
      if (containment !== "off") {
        try {
          contained = await (this.input.deps?.startContained ?? this.startContained)(worktree.dir, containment);
        } catch (err) {
          return { ran: false, reason: `containment could not start: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (contained.record.used === "off") {
          await contained.dispose();
          contained = undefined;
          if (!this.trusted()) {
            return { ran: false, reason: "no container runtime is available, the project is not trusted and containment is off: nothing the claim runs is run on this machine" };
          }
        }
      }
      const executor = trackingExecutor(contained?.executor ?? this.guardedHostExecutor(key), children);
      try {
        outcome = { ran: true, value: await body({ dir: worktree.dir, executor }), uncontained: contained === undefined };
      } finally {
        await Promise.all(children.map((child) => killExecChild(child).catch(() => undefined)));
        if (contained === undefined) {
          const notStopped = await this.proveStopped(key);
          if (notStopped.length > 0) {
            removable = false;
            kept = `a process of the check was not proven stopped (${notStopped.map(describeNotStopped).join(", ")}); its worktree was kept at ${worktree.dir}`;
          } else if (!(await directoryFree(worktree.dir))) {
            removable = false;
            kept = `a process still holds the check's worktree after the check ended; the worktree was kept at ${worktree.dir}`;
          }
        }
      }
    } finally {
      try {
        await contained?.dispose();
      } finally {
        if (removable) worktree.cleanup();
      }
    }
    return kept === undefined ? outcome : { ...outcome, kept };
  }

  /** The project's containment, started over a worktree. */
  private startContained = async (worktreeDir: string, level: ContainmentChoice): Promise<Containment> => {
    const { resolved } = loadConfig({ cwd: this.input.repo });
    return startWorktreeContainment({ worktreeDir, level, config: resolved.containment, env: this.env, log: () => {} });
  };

  private guardedHostExecutor(key: string): ProjectExecutor {
    return createGuardedExecutor({
      ...(this.input.shellPath !== undefined ? { shellPath: this.input.shellPath } : {}),
      record: (guardPid, command) => {
        const ledger = openLedgerSync(this.input.ledgerPath);
        try {
          ledger.recordProcess({ kind: "guard", sessionId: key, pid: guardPid, command: command.slice(0, 2000) });
        } finally {
          ledger.close();
        }
      },
    });
  }

  /** Kills what the key's records show still running, then confirms it. Returns what is not proven stopped. */
  private async proveStopped(key: string): Promise<NotStopped[]> {
    let notStopped: NotStopped[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      const ledger = openLedgerSync(this.input.ledgerPath);
      try {
        notStopped = (await confirmQuiescence(ledger, key, { ...this.input.deps?.quiescence, ignoreOwner: true })).notStopped;
      } finally {
        ledger.close();
      }
      if (notStopped.length === 0) return [];
      const killable = notStopped.filter((n) => n.liveness === "alive" && n.pid !== undefined);
      if (killable.length === 0) return notStopped;
      await Promise.all(killable.map((n) => killProcessTree(n.pid)));
      await new Promise((r) => setTimeout(r, 200));
    }
    return notStopped;
  }

  /** A check's time limit: the body races it, and the loser's processes are killed by `execute`. */
  private async withinLimit<T>(body: Promise<T>): Promise<{ value: T } | { timedOut: true }> {
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<{ timedOut: true }>((resolve) => {
      timer = setTimeout(() => resolve({ timedOut: true }), this.timeoutMs);
    });
    try {
      return await Promise.race([body.then((value) => ({ value })), limit]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async command(claim: StoredClaim, c: Extract<ClaimCheck, { kind: "command" }>): Promise<Checked> {
    const ran = await this.execute(claim, this.head, "head", ({ dir, executor }) => runVerificationCommand(c.command, dir, this.timeoutMs, executor));
    if (!ran.ran) return unchecked(ran.reason);
    const run = ran.value;
    const mark = ran.uncontained ? ({ uncontained: true } as const) : {};
    const checked = this.commandVerdict(c, run);
    return { ...checked, ...mark, reason: withKept(checked.reason, ran.kept) };
  }

  private commandVerdict(c: Extract<ClaimCheck, { kind: "command" }>, run: Awaited<ReturnType<typeof runVerificationCommand>>): Checked {
    if (run.spawnError !== undefined) return unchecked(`the command could not run: ${run.spawnError}`);
    if (run.timedOutAfterMs !== undefined) return unchecked(`the command did not finish in ${seconds(run.timedOutAfterMs)}`);
    if (run.signal !== undefined) return unchecked(`the command was killed by ${run.signal}`);
    const exit = run.exitCode;
    if (exit === null) return unchecked("the command ended with no exit code");
    if (exit === c.exit) return { verdict: "verified", reason: `the command exited ${exit}` };
    if (exit === 126 || exit === 127) return unchecked(`the command could not run (exit ${exit}): ${tail(run.output)}`);
    const out = run.output.trim() === "" ? "" : `: ${tail(run.output)}`;
    return { verdict: "failed", reason: `the command exited ${exit}, expected ${c.exit}${out}` };
  }

  private async reproduction(claim: StoredClaim, c: Extract<ClaimCheck, { kind: "reproduction" }>): Promise<Checked> {
    const at = await this.reproduce(claim, c, this.head, "head");
    if (at.kind === "refused") return unchecked(at.reason);
    const mark = at.uncontained ? ({ uncontained: true } as const) : {};
    if (at.kind === "unattributable") return { ...unchecked(at.reason), ...mark };
    if (at.kind === "not-reproduced") return { verdict: "failed", reason: at.reason, ...mark };
    const verified: Checked = { verdict: "verified", reason: at.reason, ...mark };
    if (this.base === undefined || this.base === this.head) return verified;
    const base = await this.reproduceAtBase(claim, c);
    return { ...verified, base, ...(base.verdict === "passes" ? { regression: true as const } : {}) };
  }

  private async reproduceAtBase(claim: StoredClaim, c: Extract<ClaimCheck, { kind: "reproduction" }>): Promise<{ verdict: BaseVerdict; reason: string }> {
    const base = this.base!;
    const headLock = lockfileHashAt(this.input.repo, this.head);
    const baseLock = lockfileHashAt(this.input.repo, base);
    if (headLock === undefined || baseLock === undefined) return { verdict: "unknown", reason: "the lockfiles could not be read, so the base's dependencies are not known to be the branch's" };
    if (headLock !== baseLock) return { verdict: "unknown", reason: "the lockfile differs between the base and the head: the base would run on other dependencies" };
    const at = await this.reproduce(claim, c, base, "base");
    switch (at.kind) {
      case "reproduced":
        return { verdict: "fails", reason: `the named tests fail at the base ${base.slice(0, 12)} too: ${at.reason}` };
      case "not-reproduced":
        return at.passed.length === c.fails.length
          ? { verdict: "passes", reason: `the named tests pass at the base ${base.slice(0, 12)}: ${at.passed.join(", ")}` }
          : { verdict: "unknown", reason: at.reason };
      case "unattributable":
      case "refused":
        return { verdict: "unknown", reason: at.reason };
    }
  }

  /** Writes the reproduction into a worktree of `commit`, runs it, and compares the named tests with what failed. */
  private async reproduce(claim: StoredClaim, c: Extract<ClaimCheck, { kind: "reproduction" }>, commit: string, label: string): Promise<Reproduced> {
    const ran = await this.execute(claim, commit, label, async ({ dir, executor }) => {
      const target = join(dir, c.file);
      if (existsSync(target)) return { exists: true as const };
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, c.content, "utf8");
      const out = await this.withinLimit(runSealedTests({ executor, dir, files: [c.file], template: this.input.testCommand, mode: "green", env: this.env }));
      return "timedOut" in out ? { timedOut: true as const } : { result: out.value };
    });
    if (!ran.ran) return { kind: "refused", reason: ran.reason };
    const mark = { uncontained: ran.uncontained };
    const v = ran.value;
    if ("exists" in v) return { kind: "unattributable", reason: `${c.file} already exists at ${commit.slice(0, 12)}: a reproduction must be a new file, or it would replace one`, ...mark };
    if ("timedOut" in v) return { kind: "unattributable", reason: `the reproduction did not finish in ${seconds(this.timeoutMs)}`, ...mark };
    const judged = judgeReproduction(c, v.result, commit);
    return { ...judged, reason: withKept(judged.reason, ran.kept), ...mark };
  }
}

type Finding =
  | { kind: "refused"; reason: string }
  | { kind: "unattributable"; reason: string }
  | { kind: "reproduced"; reason: string }
  | { kind: "not-reproduced"; reason: string; passed: string[]; failed: string[]; missing: string[] };

type Reproduced = Finding & { uncontained?: boolean };

/**
 * Windows only. A process the guard cannot list (an orphan whose parent is gone) dies with the guard's job object, but
 * not at once. One that has the worktree as its working directory, or a file open in it, keeps Windows from renaming it,
 * so a rename that succeeds proves nothing that matters to removing the worktree is still running in it. Retried for a
 * bounded time; a directory that cannot be proven free is kept. Elsewhere the process-group listing is the proof and
 * this is true.
 */
async function directoryFree(dir: string, waitMs = 15_000): Promise<boolean> {
  if (process.platform !== "win32") return true;
  const probe = `${dir}.free`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      renameSync(dir, probe);
      renameSync(probe, dir);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (existsSync(probe) && !existsSync(dir)) {
        try {
          renameSync(probe, dir);
        } catch {
          return false;
        }
      }
      if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") return false;
      if (Date.now() >= until) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

/** A reason with the note that a worktree was kept, when it was. */
function withKept(reason: string, kept: string | undefined): string {
  return kept === undefined ? reason : `${reason}; ${kept}`;
}

function describeNotStopped(n: NotStopped): string {
  return `${n.kind}${n.pid !== undefined ? ` ${n.pid}` : ""}${n.container !== undefined ? ` ${n.container}` : ""} ${n.liveness}`;
}

/** The title path a test is named by: file, suites, name. */
function titleOf(t: SealedTestResult): string {
  return [t.file, ...t.describe, t.name].filter((s) => s !== "").join(" > ");
}

/** A name matches a test when it is the whole path, or the path's tail from a ` > ` boundary. */
function nameMatches(name: string, full: string): boolean {
  const n = name.replace(/\\/g, "/").trim();
  const f = full.replace(/\\/g, "/");
  return f === n || f.endsWith(` > ${n}`);
}

/** What a run of the reproduction says about the tests it was claimed to fail. Pure: the run's results in, a finding out. */
function judgeReproduction(c: Extract<ClaimCheck, { kind: "reproduction" }>, res: RunSealedTestsResult, commit: string): Finding {
  const where = commit.slice(0, 12);
  if (res.adapter === "exit") {
    return { kind: "unattributable", reason: "the test command reports no test names (it is an exit-code runner), so the tests named cannot be told apart from the rest" };
  }
  if (res.fileErrors.size > 0) {
    const first = [...res.fileErrors.entries()][0]!;
    return { kind: "not-reproduced", reason: `the reproduction did not run at ${where}: ${short(first[1], 240)}`, passed: [], failed: [], missing: c.fails };
  }
  // node:test reports a file that could not run (a syntax error, a missing import) as one failed test named for the file.
  const norm = (p: string): string => p.split("\\").join("/");
  const unrun = res.tests.filter((t) => t.status === "error" && t.describe.length === 0 && norm(t.name) === norm(t.file));
  if (unrun.length > 0) {
    return { kind: "not-reproduced", reason: `the reproduction did not run at ${where}: ${short(res.errors.join(" "), 240)}`, passed: [], failed: [], missing: c.fails };
  }
  if (res.tests.length === 0) {
    return { kind: "unattributable", reason: `the test command produced no test results at ${where}: ${short(res.errors.join(" "), 240)}` };
  }
  const failing = res.tests.filter((t) => t.status === "assertion" || t.status === "error");
  const failed: string[] = [];
  const passed: string[] = [];
  const missing: string[] = [];
  for (const name of c.fails) {
    if (failing.some((t) => nameMatches(name, titleOf(t)))) failed.push(name);
    else if (res.tests.some((t) => t.status === "pass" && nameMatches(name, titleOf(t)))) passed.push(name);
    else missing.push(name);
  }
  if (passed.length === 0 && missing.length === 0) return { kind: "reproduced", reason: `the named tests fail at ${where}: ${failed.join(", ")}` };
  const parts = [
    ...(passed.length > 0 ? [`passed: ${passed.join(", ")}`] : []),
    ...(missing.length > 0 ? [`not found: ${missing.join(", ")}`] : []),
    ...(failed.length > 0 ? [`failed: ${failed.join(", ")}`] : []),
  ];
  return { kind: "not-reproduced", reason: `the named tests did not all fail at ${where} (${parts.join("; ")})`, passed, failed, missing };
}

/** Wraps an executor so every process it starts can be killed when the check ends. */
function trackingExecutor(inner: ProjectExecutor, children: ExecChild[]): ProjectExecutor {
  return {
    name: inner.name,
    spawn: (command, args, options) => {
      const child = inner.spawn(command, args, options);
      children.push(child);
      return child;
    },
    shellOperations: (shell) => inner.shellOperations(shell),
  };
}

