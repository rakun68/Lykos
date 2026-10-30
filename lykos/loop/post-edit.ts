// T99 — the post-edit feedback loop, cheap half
// (`docs/24-strength-and-tooling-audit.md` §2.1, `docs/27-phase12-tasks.md`).
//
// THE SINGLE BIGGEST GAP IN THE PRODUCT, and the premise checks out against
// source. Lykos writes a file and learns nothing: between `edit` returning
// `ok` and the model deciding it is finished there is no typecheck, no lint,
// no diagnostic of any kind. `lykos verify` (T52) exists and is a
// human-invoked CLI command, not a step in the loop — so the agent's rate of
// feedback is *zero until a person runs something*.
//
// Pocock's axiom, quoted in §2.1: the rate of feedback is the speed limit.
// Every other item in the register makes the agent do a better thing; this
// one makes it *notice it did a wrong thing*, which is the difference
// between a harness that converges and one that confidently diverges. It is
// also the failure class the cheap tier produces most — syntactically
// plausible, semantically wrong — and the class no amount of prompt text
// prevents.
//
// WHY THIS IS BUILT RATHER THAN ADOPTED. §2.1 gives two routes: adopt
// `pi-lens` (five tool schemas resident forever, an unmeasured package, a
// third-party component sitting in the write path) or build the cheap half.
// The recommendation was to build first and judge `pi-lens` against the
// resulting number, for three reasons that all still hold: it keeps the
// write path in Lykos's hands (rule 2 — never delegate what Lykos must own),
// it registers **zero tool schemas** because it is not a tool the model
// calls, and the intake bar for `pi-lens` would otherwise have no baseline
// to measure against.
//
// ZERO SCHEMAS, and this is the load-bearing design fact. The check is not a
// tool. It is a fact appended to the tool result the model is already
// reading, through the same `tool_result` channel T85's brake, T86's budget
// notice and T98's list reminder use. Nothing is added to hop-0.
//
// WHAT IT DELIBERATELY DOES NOT RUN. Not the test suite. A typecheck is
// seconds and answers "is this coherent"; a test run is minutes and answers
// "is this correct", which is a question worth asking once per task rather
// than once per edit. That per-task question is T100's gate, and the two are
// the same mechanism at two granularities exactly as §2.3 says.
//
// SILENCE IS THE DEFAULT OUTPUT. A check that passes says nothing, because a
// line of reassurance after every edit is pure tail cost for a model that
// already assumed it succeeded. It speaks on three transitions only: the
// first pass of the session (so the model learns the loop exists), a
// failure, and the recovery after a failure.
//
// A CHECK THAT COSTS MORE THAN IT IS WORTH TURNS ITSELF OFF. On a large repo
// a typecheck can take half a minute, and paying that after every edit is a
// harness that feels broken. A run slower than `slowDisableMs`, a timeout, or
// a command that cannot be started at all disables the loop for the rest of
// the session and says so once. The counters record that it happened, so
// "the loop was on and never ran" is distinguishable from "the loop ran and
// found nothing" — a distinction T63's exploration metric had to be rebuilt
// to recover, and which is cheaper to get right at the start.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capToolResultText } from "./prompt-diet.js";
import { isFileChangingCall } from "../tools/tool-call.js";
import { TREE_KILL_SPAWN_OPTIONS, killExecChild } from "../tools/job-runner.js";
import { localExecutor, type ProjectExecutor } from "../tools/executor.js";
import { NULL_EVENT_SINK, type LykosEventSink } from "../extensions/api.js";
import { redactValue } from "../ledger/redact.js";

export interface PostEditPolicy {
  enabled: boolean;
  /** The command to run. `undefined` with `enabled: true` means "nothing was discovered". */
  command: string | undefined;
  timeoutMs: number;
  maxOutputBytes: number;
  /** A single run slower than this disables the loop for the rest of the session. */
  slowDisableMs: number;
  /** Where the command runs. The project root, never wherever the CLI was invoked from. */
  cwd: string;
}

/** Live counters, one object per session. Read at snapshot time, like `HarnessObservation`. */
export interface PostEditState {
  runs: number;
  failures: number;
  /** Runs that came back clean. `runs - failures` minus the ones that never produced a verdict. */
  passes: number;
  totalMs: number;
  disabled: boolean;
  disabledReason: string | undefined;
  /** Whether the previous run failed — the recovery message's trigger. */
  lastFailed: boolean;
  /** Whether the "this loop exists" line has been said. */
  announced: boolean;
  /**
   * P4 T145: where each run is written as it happens. Set by the session once
   * its directory exists (`startLiveCapture`); absent in unit tests and in a
   * session with no transcript, where the counters above are the only record.
   */
  record?: (run: PostEditRunRecord) => void;
}

/**
 * P4 T145: one post-edit run, as `lykos show` prints it. `shown` is the exact
 * note appended to the tool result — the text the model saw — or null for the
 * silent pass. `verdict` is `none` when the command could not run at all, so a
 * command that failed to start never reads as a failing check.
 */
export interface PostEditRunRecord {
  seq: number;
  ts_utc: string;
  command: string;
  verdict: "pass" | "fail" | "none";
  exit_code: number | null;
  ms: number;
  disabled_reason?: string;
  shown: string | null;
}

/** P4 T145: the per-run record, one JSON line per run, beside `tasks.json` in the session directory. */
export const POST_EDIT_RUNS_FILE = "post-edit.jsonl";

/** Appends one run, redacted: compiler output can quote a secret, and this file is kept forever. */
export function appendPostEditRun(sessionDir: string, run: PostEditRunRecord): void {
  appendFileSync(join(sessionDir, POST_EDIT_RUNS_FILE), `${JSON.stringify(redactValue(run))}\n`, "utf8");
}

/** The runs recorded for a session, oldest first; null when none were ever written. A damaged line is skipped, not guessed at. */
export function readPostEditRuns(sessionDir: string): PostEditRunRecord[] | null {
  const path = join(sessionDir, POST_EDIT_RUNS_FILE);
  if (!existsSync(path)) return null;
  const runs: PostEditRunRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      runs.push(JSON.parse(line) as PostEditRunRecord);
    } catch {
      // A partial last line from a killed process. The earlier runs stand.
    }
  }
  return runs;
}

export function newPostEditState(): PostEditState {
  return {
    runs: 0,
    failures: 0,
    passes: 0,
    totalMs: 0,
    disabled: false,
    disabledReason: undefined,
    lastFailed: false,
    announced: false,
  };
}

export interface PostEditConfig {
  enabled?: boolean;
  command?: string;
  timeout_seconds?: number;
  max_output_bytes?: number;
  slow_disable_seconds?: number;
}

export const POST_EDIT_DEFAULTS = {
  timeoutSeconds: 120,
  maxOutputBytes: 4000,
  slowDisableSeconds: 45,
} as const;

/**
 * What runs after an edit, resolved from the project rather than demanded
 * from configuration.
 *
 * The order is deliberate and narrow. A `typecheck` script is a project
 * saying, in its own words, what "does this still hold together" means for
 * it. `tsc --noEmit` is the same answer for a TypeScript project that never
 * wrote the script down. Nothing else is guessed: a `lint` script may be
 * slow, opinionated, or auto-fixing, and `build` and `test` are minutes, not
 * seconds. A project wanting any of those says so in `config.yaml`, which is
 * the same division T52's `suggestedVerificationCommand()` already uses —
 * derive the obvious default, never invent a config key nobody sets.
 */
export function discoverPostEditCommand(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    if (pkg.scripts?.typecheck) return "npm run typecheck --silent";
    const hasTs =
      pkg.devDependencies?.typescript !== undefined || pkg.dependencies?.typescript !== undefined;
    if (hasTs && existsSync(join(cwd, "tsconfig.json"))) return "npx tsc --noEmit";
  } catch {
    // No package.json, or an unreadable one. Not an error: a project with no
    // discoverable check simply has no post-edit loop until it configures one.
  }
  return undefined;
}

export function resolvePostEditPolicy(cwd: string, config?: PostEditConfig): PostEditPolicy {
  const enabled = config?.enabled ?? true;
  const configured = config?.command?.trim();
  return {
    enabled,
    command: configured !== undefined && configured.length > 0 ? configured : discoverPostEditCommand(cwd),
    timeoutMs: Math.max(1, config?.timeout_seconds ?? POST_EDIT_DEFAULTS.timeoutSeconds) * 1000,
    maxOutputBytes: Math.max(200, config?.max_output_bytes ?? POST_EDIT_DEFAULTS.maxOutputBytes),
    slowDisableMs: Math.max(1, config?.slow_disable_seconds ?? POST_EDIT_DEFAULTS.slowDisableSeconds) * 1000,
    cwd,
  };
}

/**
 * Whether this call's success means a file on disk changed. P4 T143: no list
 * of its own any more — it reads `ToolRegistryEntry.changesFiles`, the one
 * declaration the gate and the edit counters read too, so `ast_edit` and an
 * `lsp` rename trigger the loop exactly as `edit` does.
 */
export function isMutatingTool(toolName: string | undefined, input?: unknown, result?: unknown): boolean {
  return isFileChangingCall(toolName, input, result);
}

export interface CommandRun {
  exitCode: number | null;
  output: string;
  ms: number;
  /** Set when the command could not be started, or was killed by the timeout. */
  problem?: string;
}

export type CommandRunner = (command: string, cwd: string, timeoutMs: number) => Promise<CommandRun>;

/**
 * The real runner. `spawn` rather than `spawnSync`: Pi's `tool_result`
 * handler may return a promise (`ExtensionHandler<E, R> = ... Promise<R|void>`),
 * so there is no reason to block the event loop for the length of a
 * typecheck — the UI's spinner and the transcript writer both keep running.
 *
 * **P10.5 (ticket 16, D9) — defect D11 closed here.** This used to spawn
 * through a shell and, at the timeout, call `child.kill()`. On Windows that
 * child is the command interpreter: killing it leaves `tsc` running, detached,
 * writing into a string nobody reads, and the post-edit loop then disables
 * itself and reports a clean timeout while the compiler it started is still
 * burning a core. Several timeouts in one long session leave several
 * compilers running concurrently, which is the failure the backlog recorded.
 *
 * The fix is the SAME kill `hub` uses (`tools/job-runner.ts`) rather than a
 * second one written here — one kill, one implementation, because the second
 * one would be the one nobody reads and the one that is wrong. It brings its
 * spawn half with it: `TREE_KILL_SPAWN_OPTIONS` is what makes the POSIX group
 * kill have a group to signal, and the two halves cannot be separated.
 *
 * The timeout path now AWAITS the kill before resolving. That is a deliberate
 * few tens of milliseconds: resolving the moment the kill was requested is how
 * a caller ends up reporting on a process that is still shutting down, and it
 * is the difference between a test that proves the tree is gone and one that
 * proves a function was called.
 */
export function createCommandRunner(executor: ProjectExecutor): CommandRunner {
  return (command, cwd, timeoutMs) => runCommand(executor, command, cwd, timeoutMs);
}

/** The runner for this machine, which is what a session without a container has. */
export const spawnCommandRunner: CommandRunner = createCommandRunner(localExecutor);

const runCommand = (executor: ProjectExecutor, command: string, cwd: string, timeoutMs: number): Promise<CommandRun> =>
  new Promise<CommandRun>((resolve) => {
    const started = Date.now();
    let settled = false;
    const finish = (run: Omit<CommandRun, "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...run, ms: Date.now() - started });
    };
    const child = executor.spawn(command, [], { cwd, shell: true, windowsHide: true, ...TREE_KILL_SPAWN_OPTIONS });
    let output = "";
    // Bounded in memory as well as in what is shown: a compiler in a loop can
    // emit megabytes, and holding all of it to then keep 4 KB is pointless.
    const append = (chunk: Buffer) => {
      if (output.length < 1_000_000) output += chunk.toString("utf8");
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    // Claimed BEFORE the kill, not after it. Killing the tree makes the shell
    // exit, so `close` fires while the kill is still being awaited — and a
    // `close` allowed to settle the promise there would report the shell's
    // exit code as though the command had finished on its own, turning "it
    // hung and we killed it" into "it failed", which is the one thing the
    // post-edit loop must never get wrong.
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killExecChild(child).then(() => {
        finish({ exitCode: null, output, problem: `timed out after ${Math.round(timeoutMs / 1000)}s` });
      });
    }, timeoutMs);
    child.on("error", (err) => {
      if (timedOut) return;
      finish({ exitCode: null, output, problem: (err as Error).message });
    });
    child.on("close", (code) => {
      if (timedOut) return;
      finish({ exitCode: code, output });
    });
  });

/**
 * Runs the check and returns what the model should be told, or `undefined`
 * for the silent case — which is most of the time, by design.
 *
 * The state machine is the whole of the behaviour and is worth reading as
 * one thing: disabled → nothing, ever again. Failure → say so, every time,
 * because the model needs the current error text and not a reference to an
 * earlier one. Pass after a failure → say it cleared, once. First pass of
 * the session → say the loop exists, once. Every other pass → silence.
 */
export async function runPostEditCheck(
  policy: PostEditPolicy,
  state: PostEditState,
  run: CommandRunner = spawnCommandRunner,
  /**
   * P10.9 (ticket 21, D2): where `post_edit_check` fires from.
   *
   * Here rather than at the harness call site, because the harness only ever
   * sees the note this returns — and the note is `undefined` on the silent
   * pass, which is most runs. The verdict, the exit code and the duration
   * exist inside this function and nowhere else, so this is the only place an
   * honest payload can be assembled without recomputing one.
   */
  events: LykosEventSink = NULL_EVENT_SINK,
): Promise<string | undefined> {
  if (!policy.enabled || state.disabled || policy.command === undefined) return undefined;

  const result = await run(policy.command, policy.cwd, policy.timeoutMs);
  state.runs += 1;
  state.totalMs += result.ms;
  const command = policy.command;
  const announce = (passed: boolean, disabledReason?: string): void => {
    events.emit("post_edit_check", {
      command,
      passed,
      exitCode: result.exitCode,
      ms: result.ms,
      disabled: state.disabled,
      ...(disabledReason !== undefined ? { disabledReason } : {}),
    });
  };
  // T145: every exit below goes through here, so every run is recorded with
  // the note it returns — the exact text appended to the model's tool result.
  const seq = state.runs;
  const recorded = (passed: boolean, shown: string | undefined): string | undefined => {
    if (state.record !== undefined) {
      try {
        state.record({
          seq,
          ts_utc: new Date().toISOString(),
          command,
          verdict: result.problem !== undefined ? "none" : passed ? "pass" : "fail",
          exit_code: result.exitCode,
          ms: result.ms,
          ...(state.disabledReason !== undefined && state.disabled ? { disabled_reason: state.disabledReason } : {}),
          shown: shown ?? null,
        });
      } catch {
        // A record that cannot be written must never fail the edit it checks.
      }
    }
    return shown;
  };

  if (result.problem !== undefined) {
    // A command that could not run says nothing about the edit — exactly
    // T52's rule for a verification command that fails to start, and for the
    // same reason: a fabricated failure is worse than a gap.
    state.disabled = true;
    state.disabledReason = result.problem;
    // A command that could not run produced no verdict, so `passed` is false
    // and `disabledReason` says why rather than letting a reader take the
    // false for a failing check.
    announce(false, result.problem);
    return recorded(
      false,
      `lykos: the post-edit check \`${policy.command}\` ${result.problem}. ` +
        `It is off for the rest of this session; nothing is being checked after your edits.`,
    );
  }

  if (result.ms > policy.slowDisableMs) {
    // Recorded as a pass or a failure first — the run happened and its
    // verdict is real — and then switched off, because paying this after
    // every edit is a harness that feels broken.
    const failed = result.exitCode !== 0;
    if (failed) state.failures += 1;
    else state.passes += 1;
    state.lastFailed = failed;
    state.disabled = true;
    state.disabledReason = `too slow (${(result.ms / 1000).toFixed(1)}s)`;
    announce(!failed, state.disabledReason);
    const verdict = failed ? failureText(policy, result) : "passed";
    return recorded(
      !failed,
      `lykos: the post-edit check \`${policy.command}\` took ${(result.ms / 1000).toFixed(1)}s, ` +
        `so it is off for the rest of this session. Last verdict: ${verdict}`,
    );
  }

  if (result.exitCode !== 0) {
    state.failures += 1;
    state.lastFailed = true;
    state.announced = true;
    announce(false);
    return recorded(false, failureText(policy, result));
  }

  state.passes += 1;
  const wasFailing = state.lastFailed;
  state.lastFailed = false;
  // The event fires on the SILENT pass too. Silence is a choice about what
  // the model is told; an extension watching for "did the check pass" needs
  // the answer on every run or it is watching a filtered stream.
  announce(true);
  if (wasFailing) return recorded(true, `lykos: the post-edit check \`${policy.command}\` passes again.`);
  if (!state.announced) {
    state.announced = true;
    return recorded(true, `lykos: \`${policy.command}\` runs after every edit and currently passes.`);
  }
  return recorded(true, undefined);
}

function failureText(policy: PostEditPolicy, result: CommandRun): string {
  const clamped = capToolResultText(result.output.trim(), policy.maxOutputBytes, "both");
  return (
    `lykos: your edit did not survive the post-edit check. ` +
    `\`${policy.command}\` exited ${result.exitCode ?? "?"}:\n\n${clamped.text}\n\n` +
    `Fix this before moving on — it is your own edit that has to compile, not a pre-existing failure to route around.`
  );
}
