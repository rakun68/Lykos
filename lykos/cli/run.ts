// `lykos run` — a thin CLI wrapper over the one session engine
// (session/session.ts): prints the final answer, the containment the session
// used (T180), then the session-summary box T5.1 built (ledger/summary.ts).
// Delegated and standalone are the same session; they differ in the default
// containment level.

import { defaultLedgerPath, openLedger } from "../ledger/use.js";
import { formatSessionSummary, loadSessionSummary } from "../ledger/summary.js";
import type { InteractionMode } from "../gate/modes.js";
import { DEFAULT_DELEGATED_MODE } from "../delegate/session-protocol.js";
import { stderrWrite, stdoutWrite } from "../tui/io-mode.js";
import { ensureWorkspaceTrust, WorkspaceTrustError, type TrustDecision } from "../gate/trust.js";
import { DEFAULT_SPECIALIST } from "../config/specialists.js";
import { loadConfig } from "../config/load.js";
import type { ResolvedConfig } from "../config/types.js";
import type { RunStandaloneTaskInput } from "../session/session.js";
import { readFileSync } from "node:fs";
import { runDelegated } from "../delegate/mcp-server.js";
import { parseTaskFile, resolveTestCommand, testCommandBrief, type TaskFile } from "../delegate/task-file.js";
import { taskBrief } from "../delegate/issue-fetch.js";
import { noBashMessage, resolveHostBash } from "../process/host-bash.js";
import { delegatedExitCode } from "./delegation.js";

export interface RunCliOptions {
  model?: string;
  tools?: string[];
  /** `--budget <usd>` — a per-invocation per_run_usd override. Threaded to
   * the spawned sandbox as LYKOS_BUDGET_PER_RUN_USD, the env-layer override
   * `config/load.ts` already supports; T7's guard reads it like any other
   * resolved config value, so this needs no new plumbing in the guard itself. */
  budgetPerRunUsd?: string;
  /** T180: `--containment off|auto|required`. Absent, the specialist, config and the default (`off`) decide. */
  containment?: "off" | "auto" | "required";
  /** T180: `--network open|none`. */
  network?: "open" | "none";
  /**
   * T184: `--mode manual|auto|plan|ask`, the interaction mode of a delegated session and the one input that decides
   * whether it writes. Absent, a delegated session runs in `auto`: it writes, on a worktree and branch of its own.
   */
  mode?: InteractionMode;
  /** T184: `--in-place`, the opt-in to a delegated session writing in this tree instead of on a branch of its own. */
  inPlace?: boolean;
  /** T34.2: `--yes` — every gated write/edit/bash call is allowed with no prompt. */
  autoApprove?: boolean;
  /** T34.1/T37: `--interactive` — S0 conversation: the standalone terminal session, containment `off` by default. */
  interactive?: boolean;
  /**
   * T39: register the Lykos-owned Agent tool.
   */
  subagents?: boolean;
  /**
   * T61: `--task <id>` — join an EXISTING task instead of letting ingest
   * auto-create one from this brief.
   */
  taskId?: string;
  projectId?: string;
  /** T117/T118: trust this workspace for this run without persisting it. */
  trustWorkspace?: boolean;
  /**
   * 2026-09-07 (UI feedback item 4): `--ask-outcome` re-arms T52.1's
   * end-of-session "did that work?" block, which is off unless asked for.
   * `LYKOS_ASK_OUTCOME=1` does the same for a whole shell — the shape a
   * person testing the outcome column actually wants.
   */
  askOutcome?: boolean;
  /**
   * Specialists ticket 01: `--specialist <name>`.
   */
  specialist?: string;
  /**
   * T217: `--output-style <name>`.
   */
  outputStyle?: string;
  /** T243: `lykos run <task.md>`: the task file the brief comes from. */
  taskFile?: string;
  /** T243: `--max-steps <n>`, the step cap. A task file's `steps:` when absent. */
  maxSteps?: number;
  /** T243: `--request-id <id>`: a retry with the same id finds the session it started. */
  requestId?: string;
  /** T243: `--base <ref>`, the branch a new worktree starts from. */
  base?: string;
}

/** The env half of `--ask-outcome`. Any value but `0`/`false`/empty counts as on. */
export function askOutcomeFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.LYKOS_ASK_OUTCOME;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v.length > 0 && v !== "0" && v !== "false" && v !== "no";
}

/**
 * The one place a one-shot `lykos run` becomes a session request. `lykos mcp`'s
 * per-call child (cli/session-child.ts) builds its session through this too, so
 * a delegated `lykos run` and an MCP call start the same session (spec #22
 * story 74) and cannot drift apart.
 */
export function sessionInput(
  cwd: string,
  brief: string,
  opts: RunCliOptions,
  trustSource: "stored" | "flag" | "prompt" | undefined,
): RunStandaloneTaskInput {
  return {
    workspace: cwd,
    prompt: brief,
    delegated: true,
    ...(opts.containment !== undefined ? { containmentLevel: opts.containment } : {}),
    ...(opts.network !== undefined ? { containmentNetwork: opts.network } : {}),
    ...(opts.mode !== undefined ? { interactionMode: opts.mode } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.budgetPerRunUsd !== undefined ? { budgetPerRunUsd: opts.budgetPerRunUsd } : {}),
    ...(opts.autoApprove !== undefined ? { autoApprove: opts.autoApprove } : {}),
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    ...(opts.projectId !== undefined && opts.projectId !== null ? { projectId: opts.projectId } : {}),
    ...(opts.subagents !== undefined ? { subagents: opts.subagents } : {}),
    ...(trustSource !== undefined ? { trustSource } : {}),
    specialist: opts.specialist ?? DEFAULT_SPECIALIST,
    ...(opts.outputStyle !== undefined ? { outputStyle: opts.outputStyle } : {}),
  };
}

export async function runRun(cwd: string, prompt: string | undefined, opts: RunCliOptions = {}): Promise<number> {
  // Validate a required CLI argument before touching the workspace. This is
  // not a trust bypass: no workspace content is read, and an invalid command
  // cannot start a session regardless of trust.
  if (!opts.interactive && (!prompt || prompt.trim().length === 0)) {
    stderrWrite('lykos run: expected a brief, e.g. `lykos run "..."`\n');
    return 1;
  }
  let trust: TrustDecision;
  try {
    trust = await ensureWorkspaceTrust({
      workspace: cwd,
      ...(opts.trustWorkspace !== undefined ? { trustWorkspace: opts.trustWorkspace } : {}),
      interactive: opts.interactive === true && Boolean(process.stdin.isTTY),
    });
  } catch (err) {
    const message = err instanceof WorkspaceTrustError ? err.message : String(err);
    stderrWrite(`lykos run: refused — ${message}\n`);
    return 1;
  }
  if (opts.interactive && opts.inPlace === true) {
    stderrWrite("lykos run: --in-place is read by delegated sessions only; an interactive session edits the workspace directly.\n");
    return 1;
  }
  if (opts.interactive && (opts.containment !== undefined || opts.network !== undefined)) {
    stderrWrite(
      "lykos run: --containment and --network are not read by --interactive; set containment.level and containment.network in config.\n",
    );
    return 1;
  }
  if (opts.interactive) {
    // T37: interactive is the standalone conversation.
    return runInteractive(cwd, opts, trust.source);
  }

  // T247: every delegated host shell is the resolved bash; without one the run never starts.
  let config: ResolvedConfig;
  try {
    config = loadConfig({ cwd }).resolved;
  } catch (err) {
    stderrWrite(`lykos run: refused — ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  const bash = resolveHostBash(config.delegation.shell_path);
  if (!bash.ok) {
    stderrWrite(`lykos run: refused — ${noBashMessage(bash)}\n`);
    return 1;
  }

  // T231/T243: a task file is Boxie's format: its body, the issues it names, and the verification command it may run.
  let brief = prompt ?? "";
  let taskScope: string[] | undefined;
  let taskSteps: number | undefined;
  let taskSealed: { sealed: string[]; red: boolean } | undefined;
  if (opts.taskFile !== undefined) {
    let task: TaskFile;
    try {
      task = parseTaskFile(readFileSync(opts.taskFile, "utf8"));
      for (const warning of task.warnings) stderrWrite(`lykos run: ${warning}\n`);
      brief = taskBrief(task, { cwd });
    } catch (err) {
      stderrWrite(`lykos run: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }
    brief = `${brief.trim()}\n\n${testCommandBrief(resolveTestCommand(task, config))}`;
    if (task.scope.length > 0 || task.files.length > 0) taskScope = [...task.files, ...task.scope];
    taskSteps = task.steps;
    // T254: the sealed tests are sealed before the model runs.
    if (task.sealed.length > 0) taskSealed = { sealed: task.sealed, red: task.red };
  }

  // T243: one delegation core. This process owns the session (it holds the session child's stdin); the result is the
  // MCP result contract, printed as JSON with `next`.
  const mode: InteractionMode = opts.mode ?? DEFAULT_DELEGATED_MODE;
  const maxSteps = opts.maxSteps ?? taskSteps;
  const abort = new AbortController();
  const onSigint = (): void => abort.abort();
  process.once("SIGINT", onSigint);
  let result: Record<string, unknown>;
  try {
    result = await runDelegated(
      cwd,
      {
        brief,
        mode,
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.budgetPerRunUsd !== undefined ? { budget: Number(opts.budgetPerRunUsd) } : {}),
        ...(maxSteps !== undefined ? { max_steps: maxSteps } : {}),
        ...(opts.containment !== undefined ? { containment: opts.containment } : {}),
        ...(opts.inPlace === true ? { write_in_place: true } : {}),
        ...(opts.specialist !== undefined ? { specialist: opts.specialist } : {}),
        ...(opts.base !== undefined ? { base: opts.base } : {}),
        ...(opts.requestId !== undefined ? { request_id: opts.requestId } : {}),
        ...(taskScope !== undefined ? { scope: taskScope } : {}),
        ...(taskSealed !== undefined ? { sealed: taskSealed.sealed, ...(taskSealed.red ? {} : { red: false }) } : {}),
        cli: {
          ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
          ...(opts.network !== undefined ? { network: opts.network } : {}),
          ...(opts.outputStyle !== undefined ? { outputStyle: opts.outputStyle } : {}),
          ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
          ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
          ...(opts.autoApprove === true ? { autoApprove: true } : {}),
          ...(opts.subagents === true ? { subagents: true } : {}),
        },
      },
      { trustSource: trust.source, signal: abort.signal, onProgress: (message) => stderrWrite(`lykos run: ${message}\n`) },
    );
  } finally {
    process.off("SIGINT", onSigint);
  }
  stdoutWrite(`${JSON.stringify(result, null, 2)}\n`);
  return delegatedExitCode(result);
}

/**
 * T34.1/T34.3: `lykos run --interactive`. Real SIGINT
 * wiring lives here — `session/interactive.ts`'s `runInteractiveLoop()` never
 * touches `process.on` itself, so its `InteractiveHandle` is what makes the
 * abort-then-end behaviour real rather than just tested.
 */
async function runInteractive(cwd: string, opts: RunCliOptions, trustSource: "stored" | "flag" | "prompt"): Promise<number> {
  const { runInteractiveStandaloneSession } = await import("../session/interactive.js");
  const result = await runInteractiveStandaloneSession({
    workspace: cwd,
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.tools !== undefined ? { tools: opts.tools } : {}),
    ...(opts.subagents !== undefined ? { subagents: opts.subagents } : {}),
    ...(opts.taskId !== undefined ? { taskId: opts.taskId } : {}),
    ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
    specialist: opts.specialist ?? DEFAULT_SPECIALIST,
    ...(opts.outputStyle !== undefined ? { outputStyle: opts.outputStyle } : {}),
    ...(opts.autoApprove === true ? { autoApprove: true } : {}),
    trustSource,
    askOutcome: opts.askOutcome === true || askOutcomeFromEnv(),
    onReady: (handle) => {
      process.on("SIGINT", handle.interrupt);
    },
  });

  if (result.status === "error") {
    stderrWrite(`lykos run: ${result.message}\n`);
    return 1;
  }

  const ledgerPath = defaultLedgerPath(cwd);
  const ledger = await openLedger(ledgerPath);
  try {
    const summary = loadSessionSummary(ledger, result.sessionId);
    if (summary) stdoutWrite(`\n${formatSessionSummary(summary)}\n`);
  } finally {
    ledger.close();
  }

  // T58: `/resume` ended the session above and asked for the picker. It runs
  // HERE, after this session has been finalised and its numbers written --
  // the resumed session is a separate row, and the one just finished keeps
  // everything it recorded.
  if (result.resumeRequested) {
    const { pickSession } = await import("./sessions.js");
    const { runResume } = await import("./resume.js");
    const { createReadlineLineSource } = await import("../session/interactive.js");
    const lineSource = createReadlineLineSource();
    try {
      // T114: the in-session browser already chose the row, so asking again
      // would be a second picker for a decision the user has made. The
      // resume itself is unchanged — same preflight, same pricing, same
      // "a resume is a new session" rule.
      const picked =
        result.resumeSessionId ??
        (await pickSession({
          sources: [{ ledgerPath, workspace: cwd, projectName: null }],
          read: () => lineSource.next(),
        }));
      if (!picked) return 0;
      return await runResume(cwd, ledgerPath, picked, { lineSource });
    } finally {
      lineSource.close();
    }
  }
  if (result.newRequested) {
    // T130: the browser action ends the current row and re-enters the same
    // in-process path. No child process and no special second boot path.
    return runInteractive(cwd, { ...opts, trustWorkspace: true }, trustSource);
  }
  return 0;
}
