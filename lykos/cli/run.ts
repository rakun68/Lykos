// `lykos run` — a thin CLI wrapper over the one session engine
// (session/session.ts): prints the final answer, the containment the session
// used (T180), then the session-summary box T5.1 built (ledger/summary.ts).
// Delegated and standalone are the same session; they differ in the default
// containment level.

import { defaultLedgerPath, openLedger } from "../ledger/use.js";
import { formatSessionSummary, loadSessionSummary } from "../ledger/summary.js";
import { formatContainmentResult } from "../containment/request.js";
import { runStandaloneTask, type RunStandaloneTaskInput } from "../session/session.js";
import { randomUUID } from "node:crypto";
import { describeWork, recordWork, withWorkTarget } from "../delegate/work-target.js";
import type { InteractionMode } from "../gate/modes.js";
import { DEFAULT_DELEGATED_MODE } from "../delegate/session-protocol.js";
import { stderrWrite, stdoutWrite } from "../tui/io-mode.js";
import { ensureWorkspaceTrust, WorkspaceTrustError } from "../gate/trust.js";
import { DEFAULT_SPECIALIST } from "../config/specialists.js";

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
    process.stderr.write('lykos run: expected a brief, e.g. `lykos run "..."`\n');
    return 1;
  }
  let trust;
  try {
    trust = await ensureWorkspaceTrust({
      workspace: cwd,
      ...(opts.trustWorkspace !== undefined ? { trustWorkspace: opts.trustWorkspace } : {}),
      interactive: opts.interactive === true && Boolean(process.stdin.isTTY),
    });
  } catch (err) {
    const message = err instanceof WorkspaceTrustError ? err.message : String(err);
    process.stderr.write(`lykos run: refused — ${message}\n`);
    return 1;
  }
  if (opts.interactive && opts.inPlace === true) {
    process.stderr.write("lykos run: --in-place is read by delegated sessions only; an interactive session edits the workspace directly.\n");
    return 1;
  }
  if (opts.interactive && (opts.containment !== undefined || opts.network !== undefined)) {
    process.stderr.write(
      "lykos run: --containment and --network are not read by --interactive; set containment.level and containment.network in config.\n",
    );
    return 1;
  }
  if (opts.interactive) {
    // T37: interactive is the standalone conversation.
    return runInteractive(cwd, opts, trust.source);
  }

  // T184: a delegated session runs in an explicit interaction mode, which decides whether it writes and so where its
  // work lands (the same code an MCP call goes through).
  const mode: InteractionMode = opts.mode ?? DEFAULT_DELEGATED_MODE;
  const sessionId = randomUUID();
  const input = sessionInput(cwd, prompt ?? "", { ...opts, mode }, trust.source);
  const worked = await withWorkTarget(
    { workspace: cwd, interactionMode: mode, sessionId, ...(opts.inPlace === true ? { writeInPlace: true } : {}) },
    (target) => runStandaloneTask({ ...input, sessionId, ...(target.workTree !== undefined ? { workTree: target.workTree } : {}) }),
  );
  const ledgerPath = defaultLedgerPath(cwd);
  const report = (line: string): void => stderrWrite(`lykos run: ${line}\n`);
  if (!worked.ok) {
    report(worked.message);
    if (worked.work !== undefined) {
      const work = await recordWork(ledgerPath, sessionId, worked.work, report);
      stderrWrite(describeWork(work));
    }
    return 1;
  }
  const result = worked.value;
  const work = await recordWork(
    ledgerPath,
    (result.status === "ok" || result.status === "error" ? result.sessionId : undefined) ?? sessionId,
    worked.work,
    report,
  );

  if (result.status === "blocked" || result.status === "error") {
    report(result.status === "blocked" ? `blocked — ${result.reason}` : result.message);
    if (result.status === "error" && result.denied && result.denied.length > 0) {
      stderrWrite(`\ndenied actions (${result.denied.length}):\n${result.denied.map((d) => `  - ${d.summary} (${d.rule})`).join("\n")}\n`);
    }
    if (result.skippedExtensions && result.skippedExtensions.length > 0) {
      stderrWrite(`\nwithheld (${result.skippedExtensions.length}):\n${result.skippedExtensions.map((s) => `  - ${s}`).join("\n")}\n`);
    }
    stderrWrite(describeWork(work));
    return 1;
  }

  stdoutWrite(`${result.text ?? "(no answer)"}\n`);
  if (result.denied && result.denied.length > 0) {
    stdoutWrite(`\ndenied actions (${result.denied.length}):\n${result.denied.map((d) => `  - ${d.summary} (${d.rule})`).join("\n")}\n`);
  }
  if (result.skippedExtensions && result.skippedExtensions.length > 0) {
    stdoutWrite(`\nwithheld (${result.skippedExtensions.length}):\n${result.skippedExtensions.map((s) => `  - ${s}`).join("\n")}\n`);
  }
  // T180: the level used and the runtime, where an orchestrator reading this output will see them.
  if (result.containment !== undefined) stdoutWrite(`\n${formatContainmentResult(result.containment)}\n`);
  stdoutWrite(describeWork(work));

  const ledger = await openLedger(ledgerPath);
  try {
    const summary = loadSessionSummary(ledger, result.sessionId);
    if (summary) stdoutWrite(`\n${formatSessionSummary(summary)}\n`);
  } finally {
    ledger.close();
  }
  return 0;
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
    process.stderr.write(`lykos run: ${result.message}\n`);
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
