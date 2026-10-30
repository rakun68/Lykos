// T100 — the mechanical verification gate
// (`docs/24-strength-and-tooling-audit.md` §2.3, `docs/27-phase12-tasks.md`).
//
// CLAUDE.md has said this twice and it has stayed unbuilt through two
// phases: D6.2's free mechanical gate is "the cheapest available writer of
// `outcome = 'success'`", it costs zero tokens, and skipping Phase 6 is why
// the ledger held zero verified successes for its whole life until T90.
//
// WHY IT IS A CAPABILITY AND NOT BOOKKEEPING. A gate that runs the project's
// own test command and refuses to let the session call the task done
// converts "agents report success by default and are not reliable narrators
// of their own work" from a known hazard into a *caught* one. The first
// mechanically-written `success` rows are a by-product, not the point.
//
// §2.3's instruction, followed literally: **all three are one mechanism at
// three granularities — post-edit (per write), verify-per-item (per step),
// gate (per task) — built as one thing with three call sites, not three
// subsystems.** So:
//
//   per write  → T99, `loop/post-edit.ts`, hooked on `tool_result`;
//   per step   → T98's `verify` field on a task item, enforced here by
//                `buildTaskVerifier()`, which is passed into the `todo`
//                tool as its gate;
//   per task   → `runSessionGate()` below, at session end.
//
// All three run a shell command in the project and read its exit code, and
// all three share `spawnCommandRunner` from `loop/post-edit.ts`. There is no
// second runner, no second timeout policy, and no second idea of what
// "passed" means.
//
// THE ONE WRITER RULE IS NOT RELAXED. `cli/verify.ts`'s `runVerify()` stays
// the only thing in the product that writes `outcome = 'success'`, and this
// module calls it rather than touching the ledger. `outcome_source` is
// `verification_command` because an exit code decided; `agent_claim` is not
// reachable from here, and the ledger writer rejects it anyway. That is what
// makes the row trustworthy: nothing on this path can record a success that
// no command produced.
//
// T167 (ADR-0030) — A FLAKY TEST NO LONGER FAILS CORRECT WORK. When the
// session gate's command fails, the failed test files are parsed out of its
// output and rerun once (`buildRerunHook`, `rerun-failures.ts`); a test that
// then passes is recorded as flaky, and the session is `success` unless the
// session edited that test's file. The hook reports FACTS; `runVerify`, the one
// writer, applies the rule. Only this call site reruns: the post-edit loop and
// `buildTaskVerifier` never do.
//
// WHAT THE GATE REFUSES TO INVENT. A command that could not be *started*
// records nothing — T52's rule, kept for T52's reason: a typo'd command says
// nothing about whether the work was good, and a fabricated `fail` would sit
// in the one column every cost claim depends on. A session that edited no
// files is not gated at all, because running a test suite to grade a
// read-only conversation produces a row about the repository rather than
// about the session.

import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { createCommandRunner, spawnCommandRunner, type CommandRunner } from "../loop/post-edit.js";
import type { ProjectExecutor } from "../tools/executor.js";
import type { RerunReport, VerificationRun } from "../session/verify-outcome.js";
import {
  deriveRerunCommand,
  failedFilesToRerun,
  failuresAccountedFor,
  parseFailedTests,
  parseTestSummary,
  rerunShowsPass,
  renderRerunCommand,
  scriptOfGateCommand,
} from "./rerun-failures.js";
import { NULL_EVENT_SINK, type LykosEventSink, type LykosExtensionHost, type VerificationVerdictEvent } from "../extensions/api.js";
import type { TaskItem } from "../tools.js";

export interface GateConfig {
  enabled?: boolean;
  command?: string;
  timeout_seconds?: number;
  /** Gate a session that edited nothing. Off by default; see the header. */
  gate_read_only_sessions?: boolean;
  /**
   * T167 (ADR-0030): when the gate's command fails, rerun only the failed
   * test files, once; a test that then passes is a flaky test and does not
   * fail the session. On by default.
   */
  rerun_failures?: boolean;
  /** T167: the rerun command, with `{files}` standing for the failed files. Overrides the derived one. */
  rerun_command?: string;
}

export interface GatePolicy {
  enabled: boolean;
  command: string | undefined;
  timeoutMs: number;
  gateReadOnlySessions: boolean;
  /** T167: rerun the failed test files once. */
  rerunFailures: boolean;
  /** T167: `gate.rerun_command`, or undefined to derive one. */
  rerunCommand: string | undefined;
  cwd: string;
}

export const GATE_DEFAULT_TIMEOUT_SECONDS = 900;

/**
 * The per-task command, derived from the project the same way T52's
 * `suggestedVerificationCommand()` derives the one it offers a human — and
 * deliberately the same answer, so the gate and the session-end question
 * never disagree about what "does it work" means for this project.
 *
 * Unlike T99's per-edit check, a test suite IS what belongs here: it runs
 * once per session, not once per edit.
 */
export function discoverGateCommand(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return pkg.scripts?.test ? "npm test" : undefined;
  } catch {
    return undefined;
  }
}

export function resolveGatePolicy(cwd: string, config?: GateConfig): GatePolicy {
  const configured = config?.command?.trim();
  return {
    enabled: config?.enabled ?? true,
    command: configured !== undefined && configured.length > 0 ? configured : discoverGateCommand(cwd),
    timeoutMs: Math.max(1, config?.timeout_seconds ?? GATE_DEFAULT_TIMEOUT_SECONDS) * 1000,
    gateReadOnlySessions: config?.gate_read_only_sessions ?? false,
    rerunFailures: config?.rerun_failures ?? true,
    rerunCommand: config?.rerun_command?.trim() ? config.rerun_command.trim() : undefined,
    cwd,
  };
}

// ---------------------------------------------------------------------------
// Granularity 2: the per-item gate the `todo` tool consults before `done`.
// ---------------------------------------------------------------------------

/**
 * Turns T98's `verify` field into a real check. The tool's `TaskItemVerifier`
 * contract is what this satisfies; passing none is T98's behaviour, where
 * `done` is taken at the model's word.
 *
 * A per-item command gets a much shorter leash than the session gate — it
 * runs inside a tool call the model is waiting on, and a step check that
 * takes ten minutes is a step check nobody will ever attach.
 */
export function buildTaskVerifier(opts: {
  cwd: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  run?: CommandRunner;
  /** T172: where the command runs when `run` is not given. Absent means this machine. */
  executor?: ProjectExecutor;
}): (item: TaskItem) => Promise<{ ok: boolean; exitCode: number | null; output: string }> {
  const run = opts.run ?? (opts.executor !== undefined ? createCommandRunner(opts.executor) : spawnCommandRunner);
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const maxOutputBytes = opts.maxOutputBytes ?? 2000;
  return async (item) => {
    const result = await run(item.verify!, opts.cwd, timeoutMs);
    if (result.problem !== undefined) {
      // A command that could not run is NOT a failed step. Refusing `done`
      // here would trap the model behind a broken command it cannot fix and
      // did not write. It passes, and says why.
      return {
        ok: true,
        exitCode: null,
        output: `lykos: the verify command could not run (${result.problem}) — the step is not being blocked on it`,
      };
    }
    return {
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      output: clamp(result.output.trim(), maxOutputBytes),
    };
  };
}

function clamp(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor((limit - 40) / 2);
  return `${text.slice(0, half)}\n… ${text.length - half * 2} bytes elided …\n${text.slice(-half)}`;
}

// ---------------------------------------------------------------------------
// Granularity 3: the per-task gate at session end.
// ---------------------------------------------------------------------------

/**
 * T167: the rerun the gate made of the failed test files, when it made one.
 * `exitCode` on the outcome is the FIRST run's; this carries the second.
 */
export interface GateRerun {
  command: string;
  exitCode: number | null;
  /** The files that were rerun. */
  files: string[];
  /** Tests that failed, then passed on rerun. Empty unless the rerun exited 0. */
  flakyTests: Array<{ file: string; name: string; editedBySession: boolean }>;
}

export type GateOutcome =
  | {
      status: "recorded";
      outcome: "success" | "fail";
      cmd: string;
      exitCode: number | null;
      /** T176: the signal that killed the run. The outcome is then `fail`. */
      signal?: string;
      /** T176: set when the gate's own timeout stopped the run. */
      timedOutAfterMs?: number;
      rerun?: GateRerun;
    }
  /** Ran, but produced nothing the ledger may record. `outcome` stays NULL. */
  | { status: "skipped"; reason: string };

/**
 * The extension-facing shape of a gate outcome — `verification_verdict`'s
 * payload, and (T149) the verdict `session_end` carries. One mapping, so the
 * two events can never describe one verdict differently.
 */
export function verdictEventOf(outcome: GateOutcome): VerificationVerdictEvent {
  return {
    status: outcome.status,
    ...(outcome.status === "recorded"
      ? {
          outcome: outcome.outcome,
          command: outcome.cmd,
          exitCode: outcome.exitCode,
          ...(outcome.rerun !== undefined
            ? {
                rerun: {
                  command: outcome.rerun.command,
                  exitCode: outcome.rerun.exitCode,
                  flakyTests: outcome.rerun.flakyTests.map((t) => ({ ...t })),
                },
              }
            : {}),
        }
      : { reason: outcome.reason }),
  };
}

export interface SessionGateInput {
  policy: GatePolicy;
  sessionId: string;
  ledgerPath: string;
  /** Whether this session actually changed a file. A read-only session is not graded. */
  edited: boolean;
  /**
   * T167: the paths the session edited, as its trace and git name them
   * (`sessionEditedPaths`; relative to the project or absolute). A flaky test in one of these files, or under
   * one that is a directory, keeps the verdict `fail`. Absent means none are
   * known, which can only make a flaky test look unedited — so the caller
   * passes what it has.
   */
  editedFiles?: readonly string[];
  /** Injected so tests never open a ledger or spawn a shell. */
  verify?: (cmd: string) => Promise<GateOutcome>;
  /** T172: where the test command and its rerun run. Absent means this machine. */
  executor?: ProjectExecutor;
  /**
   * P10.9 (ticket 21, D2): where `verification_verdict` fires from. On the
   * input rather than as a parameter because every caller already builds this
   * object, and every early return below is a verdict worth hearing about —
   * "the gate did not run, and here is why" is exactly what an extension
   * watching for a verdict must not mistake for a pass.
   */
  events?: LykosEventSink;
  /**
   * Called once, just before the command runs, and never on a skip. A test
   * suite can take minutes; with nothing on screen the person at the terminal
   * takes the session for hung and closes it, and the verdict is lost (P4
   * demo run 1, 2026-10-05). The caller prints it; this function prints nothing.
   */
  onStart?: (cmd: string) => void;
  /** T201: extension host holding registered gate checks. */
  extensionHost?: LykosExtensionHost | undefined;
  /** T201: start commit at boot. */
  startCommit?: string | undefined;
  /** T201: session specialist. */
  specialist?: string | undefined;
}

/** What the session says on screen before the gate's command runs. */
export function renderGateStart(cmd: string, timeoutMs: number): string {
  return (
    `lykos gate: running \`${cmd}\` (up to ${Math.round(timeoutMs / 60_000)} min) — keep this terminal open; ` +
    "the verdict, then the reviewer, follow"
  );
}

async function checkRegisteredGateChecks(
  input: SessionGateInput,
  cmdOverride?: string,
): Promise<GateOutcome | undefined> {
  if (!input.extensionHost?.hasGateChecks) return undefined;
  const checkRes = await input.extensionHost.runGateChecks({
    sessionId: input.sessionId,
    cwd: input.policy.cwd,
    ledgerPath: input.ledgerPath,
    executor: input.executor,
    edited: input.edited,
    editedFiles: input.editedFiles,
    startCommit: input.startCommit,
    specialist: input.specialist,
  });
  if (!checkRes.pass) {
    const { runVerify } = await import("../session/verify-outcome.js");
    const cmd = cmdOverride ?? "(gate check)";
    await runVerify(input.sessionId, {
      ledgerPath: input.ledgerPath,
      cwd: input.policy.cwd,
      answer: { kind: "gate_check_only", reason: checkRes.blockReason!, cmd },
    });
    return {
      status: "recorded",
      outcome: "fail",
      cmd,
      exitCode: null,
    };
  }
  return undefined;
}

/**
 * Runs the gate and records what it found, through `cli/verify.ts` — the one
 * writer. Returns what happened so the caller can print it; it prints
 * nothing itself, because `07-ui-and-hud.md` §1.1 keeps rendering and
 * mutation apart and this is the mutation half.
 */
export async function runSessionGate(input: SessionGateInput): Promise<GateOutcome> {
  const { policy } = input;
  const events = input.events ?? NULL_EVENT_SINK;
  // One announcement for every path out of this function, built from the
  // OUTCOME rather than from the branch that produced it — so a new skip
  // reason cannot arrive without an event, and no path can announce an
  // outcome the gate did not record. A `skipped` carries no `outcome` at all
  // rather than a zero or a guess (rule 4).
  const announce = (outcome: GateOutcome): GateOutcome => {
    events.emit("verification_verdict", verdictEventOf(outcome));
    return outcome;
  };
  if (!policy.enabled) {
    const blocked = await checkRegisteredGateChecks(input);
    if (blocked) return announce(blocked);
    return announce({ status: "skipped", reason: "the gate is off in config" });
  }

  if (policy.command === undefined) {
    const blocked = await checkRegisteredGateChecks(input);
    if (blocked) return announce(blocked);
    return announce({
      status: "skipped",
      reason: "no verification command — the project declares no test script",
    });
  }

  if (!input.edited && !policy.gateReadOnlySessions) {
    const blocked = await checkRegisteredGateChecks(input, policy.command);
    if (blocked) return announce(blocked);
    // Grading a read-only conversation with the project's test suite produces
    // a row about the repository, not about the session.
    return announce({ status: "skipped", reason: "the session edited no files" });
  }

  const verify = input.verify ?? defaultVerify(input);
  input.onStart?.(policy.command);
  return announce(await verify(policy.command));
}

function defaultVerify(input: SessionGateInput): (cmd: string) => Promise<GateOutcome> {
  return async (cmd) => {
    // Imported lazily for the same reason `session/interactive.ts` does it: the
    // gate must not statically depend on the CLI layer, and this is the one
    // edge where it needs its single ledger writer.
    const { runVerify, runVerificationCommand } = await import("../session/verify-outcome.js");
    const result = await runVerify(input.sessionId, {
      ledgerPath: input.ledgerPath,
      cwd: input.policy.cwd,
      answer: { kind: "command", cmd },
      // D9: the configured timeout was computed into the policy and then
      // dropped here, so every run took the fifteen-minute default.
      timeoutMs: input.policy.timeoutMs,
      ...(input.executor !== undefined ? { executor: input.executor } : {}),
      // T167: only this call site reruns. The post-edit loop and per-item
      // verify never reach `runVerify`.
      rerunFailures: buildRerunHook({
        policy: input.policy,
        editedFiles: input.editedFiles ?? [],
        run: (rerunCmd, rerunCwd, rerunTimeoutMs) =>
          runVerificationCommand(rerunCmd, rerunCwd, rerunTimeoutMs, input.executor),
      }),
      gateChecks: async (run) => {
        if (!input.extensionHost?.hasGateChecks) return undefined;
        return input.extensionHost.runGateChecks({
          sessionId: input.sessionId,
          cwd: input.policy.cwd,
          ledgerPath: input.ledgerPath,
          commandOutcome: {
            status: "recorded",
            outcome: run.exitCode === 0 ? "success" : "fail",
            cmd: run.cmd,
            exitCode: run.exitCode,
          },
          executor: input.executor,
          edited: input.edited,
          editedFiles: input.editedFiles,
          startCommit: input.startCommit,
          specialist: input.specialist,
        });
      },
    });
    if (result.status === "recorded") {
      return {
        status: "recorded",
        outcome: result.outcome === "success" ? "success" : "fail",
        cmd,
        exitCode: result.run?.exitCode ?? null,
        ...(result.run?.signal !== undefined ? { signal: result.run.signal } : {}),
        ...(result.run?.timedOutAfterMs !== undefined ? { timedOutAfterMs: result.run.timedOutAfterMs } : {}),
        ...(result.rerun !== undefined
          ? {
              rerun: {
                command: result.rerun.cmd,
                exitCode: result.rerun.exitCode,
                files: result.rerun.files,
                flakyTests: result.rerun.flaky,
              },
            }
          : {}),
      };
    }
    if (result.status === "skipped") return { status: "skipped", reason: result.reason };
    return { status: "skipped", reason: result.message };
  };
}

function readTestScript(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    return pkg.scripts?.test;
  } catch {
    return undefined;
  }
}

/** Does `file` (a test file) lie in what the session edited — the same file, or under an edited directory? */
function inEditedPaths(cwd: string, file: string, edited: readonly string[]): boolean {
  const norm = (p: string): string => {
    const abs = resolve(cwd, p.replace(/\\/g, "/"));
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  };
  const target = norm(file);
  return edited.some((e) => {
    const path = norm(e);
    return target === path || target.startsWith(path.endsWith(sep) ? path : path + sep);
  });
}

/**
 * T167 (ADR-0030): the session gate's rerun. Given the first run, which has
 * failed, it answers with what a second run of ONLY the failed test files
 * found — or `undefined`, meaning "do not rerun; the first verdict stands":
 *
 *  - `gate.rerun_failures` is false;
 *  - the output names no failed test, or one in a file that is not in the
 *    project (a partial rerun that passes would hide the failure it skipped);
 *  - the first run's reporter summary is unreadable, or counts more failed or
 *    cancelled tests than the parser found (`failuresAccountedFor`);
 *  - there is no command to rerun with: `gate.rerun_command` is unset, and
 *    the gate command's script is not a plain `node --test` / `tsx --test`.
 *
 * It reports facts and decides nothing. A test that failed and then passed is
 * flaky; whether that clears the session is `runVerify`'s rule
 * (`rerunClearsFailure`), because `runVerify` is the one writer of outcome.
 * The rerun runs once. There is no second retry here and no loop.
 */
export function buildRerunHook(opts: {
  policy: GatePolicy;
  editedFiles: readonly string[];
  run: (cmd: string, cwd: string, timeoutMs: number) => Promise<VerificationRun>;
  /** Injected so a unit test needs no files on disk. */
  exists?: (path: string) => boolean;
}): (first: VerificationRun) => Promise<RerunReport | undefined> {
  const { policy } = opts;
  return async (first) => {
    if (!policy.rerunFailures || policy.command === undefined) return undefined;
    const failed = parseFailedTests(first.output, policy.cwd);
    // The parsed failures must account for every failure the reporter counted,
    // or a rerun of the others that passes would hide the one that was missed.
    if (!failuresAccountedFor(failed, parseTestSummary(first.output))) return undefined;
    const files = failedFilesToRerun(failed, policy.cwd, opts.exists);
    if (files === undefined) return undefined;
    let cmd: string | undefined;
    if (policy.rerunCommand !== undefined) {
      cmd = renderRerunCommand(policy.rerunCommand, files);
    } else {
      const script = scriptOfGateCommand(policy.command, readTestScript(policy.cwd));
      cmd = script === undefined ? undefined : deriveRerunCommand(script, files);
    }
    if (cmd === undefined) return undefined;

    const second = await opts.run(cmd, policy.cwd, policy.timeoutMs);
    if (second.spawnError !== undefined) {
      return { cmd, files, exitCode: null, output: second.output, flaky: [], spawnError: second.spawnError };
    }
    return {
      cmd,
      files,
      exitCode: second.exitCode,
      output: second.output,
      // Only a rerun that PASSED, and whose own summary shows tests running
      // and passing, says the failures were flakes. Exit 0 alone is not
      // enough: a run that executed nothing exits 0. A rerun that failed, or
      // that proves nothing, names none.
      flaky:
        second.exitCode === 0 && rerunShowsPass(parseTestSummary(second.output), failed.length)
          ? failed.map((t) => ({
              file: t.file,
              name: t.name,
              editedBySession: inEditedPaths(policy.cwd, t.file, opts.editedFiles),
            }))
          : [],
    };
  };
}

/**
 * What the session says on screen about the gate. One line, and it names the
 * command, because a `fail` row the user cannot attribute to a command is a
 * row they will learn to ignore.
 */
/** How a run that a signal ended is described: a timeout says so, anything else names the signal. */
function stoppedBy(outcome: Extract<GateOutcome, { status: "recorded" }>): string | undefined {
  if (outcome.signal === undefined) return undefined;
  return outcome.timedOutAfterMs !== undefined
    ? `timed out after ${outcome.timedOutAfterMs / 1000}s (${outcome.signal})`
    : `killed by ${outcome.signal}`;
}

export function renderGateOutcome(outcome: GateOutcome): string {
  if (outcome.status === "skipped") return `lykos gate: not run — ${outcome.reason}`;
  const recorded = `recorded as outcome=${outcome.outcome}, source=verification_command`;
  const rerun = outcome.rerun;
  if (rerun !== undefined) {
    // T167: a rerun is said, with the tests that flaked — a verdict rescued
    // by a second run that does not say so would hide the flake.
    const n = rerun.files.length;
    const files = `${n} failed test file${n === 1 ? "" : "s"}`;
    const first = `lykos gate: \`${outcome.cmd}\` FAILED (${stoppedBy(outcome) ?? `exit ${outcome.exitCode ?? "?"}`})`;
    if (rerun.exitCode === 0 && rerun.flakyTests.length === 0) {
      // Exit 0 with nothing shown passing is a rerun that proved nothing.
      return `${first}; rerun of ${files} exited 0 but its summary did not show the failed tests passing — ${recorded}`;
    }
    if (rerun.exitCode !== 0) {
      return `${first}; rerun of ${files} FAILED again (exit ${rerun.exitCode ?? "?"}) — ${recorded}`;
    }
    const names = rerun.flakyTests.map((t) => `${t.file}: ${t.name}`).join("; ");
    const edited = [...new Set(rerun.flakyTests.filter((t) => t.editedBySession).map((t) => t.file))];
    return outcome.outcome === "success"
      ? `${first}; rerun of ${files} PASSED (exit 0) — flaky: ${names} — ${recorded}`
      : `${first}; rerun of ${files} PASSED (exit 0), but a flaky test is in a file this session edited (${edited.join(", ")}) — flaky: ${names} — ${recorded}`;
  }
  const verdict = outcome.outcome === "success" ? "PASSED" : "FAILED";
  const code =
    stoppedBy(outcome) !== undefined
      ? ` (${stoppedBy(outcome)})`
      : outcome.exitCode !== null
        ? ` (exit ${outcome.exitCode})`
        : "";
  return `lykos gate: \`${outcome.cmd}\` ${verdict}${code} — ${recorded}`;
}
