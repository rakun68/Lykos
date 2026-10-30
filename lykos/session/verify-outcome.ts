import { openLedger, type Ledger } from "../ledger/use.js";
import type { Outcome } from "../ledger/ledger.js";
import { redactSecrets } from "../ledger/redact.js";
import { TREE_KILL_SPAWN_OPTIONS, killExecChild } from "../tools/job-runner.js";
import { exitCodeOfSignal, localExecutor, type ProjectExecutor } from "../tools/executor.js";

/**
 * How much verification output the ledger keeps. A failing test suite can
 * emit megabytes, and the column exists to answer "what did it say" at a
 * glance — the transcript directory is where the full record belongs.
 */
export const VERIFICATION_OUTPUT_LIMIT = 4000;

export function clampVerificationOutput(text: string, limit = VERIFICATION_OUTPUT_LIMIT): string {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 40) / 2);
  const dropped = text.length - half * 2;
  return `${text.slice(0, half)}\n… ${dropped} bytes elided …\n${text.slice(-half)}`;
}

export interface VerificationRun {
  cmd: string;
  exitCode: number | null;
  output: string;
  /** Set when the command could not be started at all — distinct from a command that ran and failed. */
  spawnError?: string;
  /** Set when a signal ended the command, the gate's own timeout included: it ran, it did not finish, and that is a failure. */
  signal?: NodeJS.Signals;
  /** Set when the gate's own timeout is what stopped it. */
  timedOutAfterMs?: number;
}

/** How much of a verification command's output is held in memory. The ledger keeps far less; this is the ceiling on what a runaway suite can make this process allocate. */
export const VERIFICATION_OUTPUT_BUFFER_LIMIT = 32 * 1024 * 1024;

/**
 * Run the command the human named and report what it said.
 *
 * **P10.5 (ticket 16, D9) — defect D11 closed here.** This used `spawnSync`
 * with a `timeout`, which sends SIGTERM to the direct child. Through
 * `shell: true` on Windows that child is the command interpreter, so a
 * verification run that overran its fifteen minutes left the real test runner
 * alive, detached, writing into a buffer that had already been abandoned —
 * and `lykos verify` then wrote "could not run" into the ledger while the
 * suite it started kept going.
 *
 * It is async now, and that is the cost of the fix rather than a
 * modernisation: a tree kill cannot be done from inside a `spawnSync`, because
 * `spawnSync` is holding the only thread that could do it. The kill is the
 * same one `hub` and the post-edit runner use (`tools/job-runner.ts`) — one
 * kill, one implementation — and it brings its spawn half,
 * `TREE_KILL_SPAWN_OPTIONS`, with it.
 *
 * T176: the timeout is a kill like any other. The run is a failure that names
 * SIGTERM and carries the shell's exit code for it (143), not a NULL outcome: a
 * test run that was stopped did not pass, and the gate must not read it as
 * anything else.
 */
/**
 * The environment a verification command runs in: this process's, minus
 * `NODE_TEST_CONTEXT`. The command is a test run of its own, at the top. When
 * Lykos itself runs inside a node:test runner, that marker makes a nested
 * `node --test` report to a parent that is not listening: no summary, and an
 * exit code that says nothing. A test that had to delete it for its whole file
 * instead printed a second summary into the suite's output, and the gate's
 * rerun refused output with two (P4 demo run 3, 2026-10-06).
 */
export function verificationEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { NODE_TEST_CONTEXT: _dropped, ...rest } = env;
  return rest;
}

/**
 * A run that was killed: it ran, it did not finish, and that is a failure. The
 * exit code is the shell's, so the ledger column is never NULL for it. A run
 * the gate's own timeout stopped says so in its output and in `timedOutAfterMs`,
 * so a timeout reads differently from a test run that crashed.
 */
function killedRun(cmd: string, signal: NodeJS.Signals, output: string, timedOutAfterMs?: number): VerificationRun {
  const note =
    timedOutAfterMs !== undefined ? `[timed out after ${timedOutAfterMs / 1000}s (${signal})]` : `[killed by ${signal}]`;
  return {
    cmd,
    exitCode: exitCodeOfSignal(signal),
    signal,
    ...(timedOutAfterMs !== undefined ? { timedOutAfterMs } : {}),
    output: [output.trim(), note].filter((part) => part !== "").join("\n"),
  };
}

export function runVerificationCommand(
  cmd: string,
  cwd: string,
  timeoutMs = 15 * 60_000,
  /** T172: where the command runs. Absent means this machine. */
  executor: ProjectExecutor = localExecutor,
): Promise<VerificationRun> {
  return new Promise<VerificationRun>((resolvePromise) => {
    let settled = false;
    const finish = (run: VerificationRun): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(run);
    };
    const child = executor.spawn(cmd, [], { cwd, shell: true, windowsHide: true, env: verificationEnv(), ...TREE_KILL_SPAWN_OPTIONS });
    let output = "";
    const append = (chunk: Buffer): void => {
      if (output.length < VERIFICATION_OUTPUT_BUFFER_LIMIT) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    // Claimed BEFORE the kill, not after it. Killing the tree makes the shell
    // exit, so `close` fires while the kill is still being awaited — and a
    // `close` allowed to settle the promise there would report the shell's
    // own exit code as though the command had finished. The run is settled
    // once, as a kill, after the tree is gone.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Awaited, not fired and forgotten: returning before the tree is
      // actually gone is the half of this defect that is easy to leave behind.
      void killExecChild(child, "SIGTERM").then(() => {
        finish(killedRun(cmd, "SIGTERM", output, timeoutMs));
      });
    }, timeoutMs);
    child.on("error", (err) => {
      if (timedOut) return;
      finish({ cmd, exitCode: null, output: output.trim(), spawnError: err.message });
    });
    child.on("close", (code, signal) => {
      if (timedOut) return;
      if (signal !== null) {
        // T176 (Sandcastle #933): a run that was killed did not pass. It is a failure that names the signal,
        // not a command that could not start, so it is not skipped and cannot read as success.
        finish(killedRun(cmd, signal, output));
        return;
      }
      finish({ cmd, exitCode: code, output: output.trim() });
    });
  });
}

export function resolveSessionId(ledger: Ledger, idOrPrefix: string): { id: string } | { error: string } {
  const exact = ledger.db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(idOrPrefix) as { id: string } | undefined;
  if (exact) return { id: exact.id };
  const matches = ledger.db
    .prepare(`SELECT id FROM sessions WHERE id LIKE ? ORDER BY started_utc DESC`)
    .all(`${idOrPrefix}%`) as Array<{ id: string }>;
  if (matches.length === 1) return { id: matches[0]!.id };
  if (matches.length > 1) {
    return { error: `ambiguous session prefix "${idOrPrefix}" — ${matches.length} sessions match; use more characters` };
  }
  return { error: `no session matches "${idOrPrefix}"` };
}

export type VerifyAnswer =
  | { kind: "command"; cmd: string }
  | { kind: "human"; worked: boolean }
  | { kind: "gate_check_only"; reason: string; cmd?: string }
  | { kind: "skip" };

/** T167: a test that failed in the first run and passed in the rerun of its file. */
export interface RerunFlakyTest {
  file: string;
  name: string;
  /** The session edited this test's file. */
  editedBySession: boolean;
}

/**
 * T167 (ADR-0030): what the session gate's rerun of the failed test files
 * found. FACTS only — the decision stays in `runVerify`, the one writer.
 * `flaky` is empty unless the rerun exited 0.
 */
export interface RerunReport {
  cmd: string;
  /** The test files the rerun was given. */
  files: string[];
  exitCode: number | null;
  output: string;
  flaky: RerunFlakyTest[];
  /** Set when the rerun could not be started; the first verdict stands. */
  spawnError?: string;
}

export interface RunVerifyOptions {
  ledgerPath: string;
  cwd: string;
  answer: VerifyAnswer;
  /** D9: the gate's `timeout_seconds`, in ms. Absent keeps the built-in fifteen minutes. */
  timeoutMs?: number;
  /** T172: where the command runs. Absent means this machine. */
  executor?: ProjectExecutor;
  /**
   * T167: asked once, and only when the command ran and exited non-zero. It
   * may rerun the failed tests and report what it found, or return
   * `undefined` for "no rerun" — an unparseable output, a rerun switched off,
   * no command to rerun with. Only the session gate passes it; `lykos verify`
   * and every other caller get today's behaviour.
   */
  rerunFailures?: (first: VerificationRun) => Promise<RerunReport | undefined>;
  /**
   * T201: registered gate checks to execute after the verification command.
   * If any check blocks, success turns into failure.
   */
  gateChecks?: (run: VerificationRun) => Promise<{ pass: boolean; blockReason?: string } | undefined>;
}

/**
 * T167: does the rerun clear a failed first run? Only when the rerun exited 0,
 * it named at least one flaky test, and the session edited none of their
 * files. This is the whole rule that turns a `fail` into a `success`, and it
 * lives beside the one writer so nothing else can apply it.
 */
export function rerunClearsFailure(rerun: RerunReport | undefined): boolean {
  return (
    rerun !== undefined &&
    rerun.spawnError === undefined &&
    rerun.exitCode === 0 &&
    rerun.flaky.length > 0 &&
    rerun.flaky.every((f) => !f.editedBySession)
  );
}

/** What the ledger keeps of a run that was rerun: the first run's output, then the rerun's, each bounded. */
function outputWithRerun(first: string, rerun: RerunReport): string {
  const part = clampVerificationOutput(redactSecrets(first), 2600);
  const status =
    rerun.spawnError !== undefined
      ? `could not run: ${rerun.spawnError}`
      : rerun.exitCode === 0 && rerun.flaky.length === 0
        ? "exit 0, but its summary does not show the failed tests passing"
        : `exit ${rerun.exitCode}`;
  const second = clampVerificationOutput(redactSecrets(rerun.output), 1100);
  return `${part}
--- rerun of the failed test files (${status}): ${rerun.cmd} ---
${second}`;
}

export type VerifyResult =
  | {
      status: "recorded";
      sessionId: string;
      outcome: Outcome;
      outcomeSource: "verification_command" | "human";
      run?: VerificationRun;
      /** T167: the rerun, when one happened. `run` is still the first run. */
      rerun?: RerunReport;
    }
  | { status: "skipped"; sessionId: string; reason: string }
  | { status: "error"; message: string };

/** The one place an outcome is written. */
export async function runVerify(sessionIdOrPrefix: string, opts: RunVerifyOptions): Promise<VerifyResult> {
  const ledger = await openLedger(opts.ledgerPath);
  try {
    const resolved = resolveSessionId(ledger, sessionIdOrPrefix);
    if ("error" in resolved) return { status: "error", message: resolved.error };
    const sessionId = resolved.id;

    if (opts.answer.kind === "skip") {
      return { status: "skipped", sessionId, reason: "declined — outcome stays NULL, which is a legitimate answer" };
    }

    if (opts.answer.kind === "gate_check_only") {
      const outcome: Outcome = "fail";
      const cmd = opts.answer.cmd ?? "(gate check)";
      const output = opts.answer.reason;
      try {
        ledger.recordOutcome({
          id: sessionId,
          outcome,
          outcomeSource: "verification_command",
          verificationCmd: cmd,
          verificationOutput: clampVerificationOutput(redactSecrets(output)),
          gateBlocked: true,
        });
      } catch (err) {
        return { status: "error", message: (err as Error).message };
      }
      return {
        status: "recorded",
        sessionId,
        outcome,
        outcomeSource: "verification_command",
      };
    }

    if (opts.answer.kind === "human") {
      const outcome: Outcome = opts.answer.worked ? "success" : "fail";
      try {
        ledger.recordOutcome({ id: sessionId, outcome, outcomeSource: "human" });
      } catch (err) {
        return { status: "error", message: (err as Error).message };
      }
      return { status: "recorded", sessionId, outcome, outcomeSource: "human" };
    }

    const run = await runVerificationCommand(opts.answer.cmd, opts.cwd, opts.timeoutMs, opts.executor);
    if (run.spawnError !== undefined) {
      return {
        status: "skipped",
        sessionId,
        reason: `verification command could not run (${run.spawnError}) — outcome stays NULL rather than a guessed fail`,
      };
    }
    // T167: a failed run may be rerun on its failed files, once, before the
    // verdict is written. A rerun that could not start is no rerun at all.
    let rerun: RerunReport | undefined;
    // A run a signal killed is never rerun: a rerun that exits 0 must not clear a run that did not finish (T176).
    if (run.exitCode !== 0 && run.signal === undefined && opts.rerunFailures !== undefined) {
      try {
        rerun = await opts.rerunFailures(run);
      } catch {
        rerun = undefined;
      }
    }
    let outcome: Outcome = run.exitCode === 0 || (run.signal === undefined && rerunClearsFailure(rerun)) ? "success" : "fail";
    let gateBlocked = false;
    let gateBlockReason: string | undefined;

    if (opts.gateChecks) {
      try {
        const checkRes = await opts.gateChecks(run);
        if (checkRes && !checkRes.pass) {
          outcome = "fail";
          gateBlocked = true;
          gateBlockReason = checkRes.blockReason;
        }
      } catch (err) {
        outcome = "fail";
        gateBlocked = true;
        gateBlockReason = (err as Error).message;
      }
    }

    const baseOutput = rerun !== undefined ? outputWithRerun(run.output, rerun) : run.output;
    const finalOutput = gateBlockReason
      ? `${baseOutput.trim()}\n[gate check blocked: ${gateBlockReason}]`
      : baseOutput;

    try {
      ledger.recordOutcome({
        id: sessionId,
        outcome,
        outcomeSource: "verification_command",
        verificationCmd: run.cmd,
        verificationOutput: clampVerificationOutput(redactSecrets(finalOutput)),
        // T144: no spawn error means the command ran to an exit code; a killed one carries the shell's 128+signal (T176).
        ...(run.exitCode !== null ? { verificationExitCode: run.exitCode } : {}),
        ...(rerun !== undefined && rerun.spawnError === undefined
          ? { rerun: { command: rerun.cmd, exitCode: rerun.exitCode, flaky: rerun.flaky } }
          : {}),
        ...(gateBlocked ? { gateBlocked: true } : {}),
      });
    } catch (err) {
      return { status: "error", message: (err as Error).message };
    }
    return {
      status: "recorded",
      sessionId,
      outcome,
      outcomeSource: "verification_command",
      run: gateBlockReason ? { ...run, output: finalOutput } : run,
      ...(rerun !== undefined && rerun.spawnError === undefined ? { rerun } : {}),
    };
  } finally {
    ledger.close();
  }
}
