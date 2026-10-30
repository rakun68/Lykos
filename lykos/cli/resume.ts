// `lykos resume <session>` — T57 (docs/19-phase4-tasks.md), D4.2, and this
// phase's headline feature.
//
// The shape, in one sentence: **run T56's preflight, stop on any refusal,
// then start a NEW session that continues the old one.**
//
// Three rules it inherits and cannot bend:
//
//  1. **A resume continues the session it names.** Same id, same transcript,
//     same row — amended 2026-09-07 (UI feedback item 1). It used to mint a
//     new session linked back with `resumed_from`; the maintainer's
//     objection was that a chain of near-identical rows is a messier
//     workspace with no benefit a reader could point at, and there is no
//     counter-argument left once the metric is checked: a session's cost is
//     the sum of its `calls` rows, so continuing one recomputes the same
//     total over a strictly larger set, and the headline metric still
//     cannot be improved by giving up and restarting. What history is
//     rewritten is exactly three fields — `ended_utc`, `closed_utc` and an
//     unverified `outcome` — and every one of them was a statement that the
//     run was over, which is the thing that stopped being true.
//  2. **The task's cost is the sum over its sessions.** The resumed session
//     carries the ORIGINAL's `task_id`, so a task resumed four times is one
//     expensive task rather than four cheap ones — and the headline metric
//     can never be improved by giving up and restarting.
//  3. **Replay is appended after the head, never merged into it.** The
//     session boots through the ordinary `bootStandaloneSession()` path and
//     gets the ordinary frozen head; the conversation arrives afterwards as
//     a custom message. Nothing in this file touches prompt assembly.
//
// Two decisions this task makes rather than leaving open:
//
//  - **Mechanism flags are inherited by default, with an explicit override.**
//    `08` §8 left this open and leaned this way; the reasoning stands —
//    `--compare` is confounded either way, and inheritance is at least
//    predictable. `--prompt-diet` / `--no-prompt-diet` (and the output-diet
//    pair) override, and the override is RECORDED in the new session's
//    transcript marker, not just accepted.
//  - **The estimate is checked against reality.** T56's estimate goes into
//    the resume marker; the actual replay cost is the first `calls` row on
//    the new session. This command prints the comparison when the session
//    ends. That is Phase 4's own measurement (T62) and it costs nothing to
//    collect.
//
// What it explicitly does not do: resume a LIVE session (that is G13's
// problem and is not in this phase), fork mid-conversation (`/fork`, `/tree`
// are not in `02-plan.md` §6 and adding them here would be scope taken from
// Phase 5), or touch the original in any way.

import { existsSync } from "node:fs";
import { AGENT_TOOL_NAME, canonicalToolName } from "../tools/tool-surface.js";

import { openLedgerSync, type Ledger } from "../ledger/use.js";

import { preflightResume, formatPreflight, type ResumePreflight } from "../session/resume-preflight.js";
import type { ResumePlan } from "../session/interactive.js";
import type { LineSource } from "../session/interactive.js";
import { stdoutWrite } from "../tui/io-mode.js";

export interface ResumeOptions {
  /** Skip the confirmation for cost and a moved working tree. Never skips a refusal. */
  yes?: boolean;
  /** Proceed past the "a file this session edited is gone" refusal. */
  force?: boolean;
  /** Explicit mechanism-flag overrides. Absent means inherit the original's. */
  promptDiet?: boolean;
  outputDiet?: boolean;
  /** Name a substitute model. Recorded as `caller_override`; a model is never substituted silently. */
  model?: string;
  /** Report the preflight and start nothing. */
  dryRun?: boolean;
  /** Injected by tests; production reads the real terminal. */
  lineSource?: LineSource;
  /** Called with the reason, once, whenever resume refuses or is declined, in addition to saying it on stderr. A caller with no one reading stderr (an MCP continuation) reports it itself. */
  onRefusal?: (reason: string) => void;
  /** Injected by tests so no real agent is booted. */
  launch?: (input: LaunchInput) => Promise<{ status: "ok" | "error"; sessionId?: string; message?: string }>;
  now?: Date;
}

export interface LaunchInput {
  workspace: string;
  ledgerPath: string;
  model: string | undefined;
  resume: ResumePlan;
}

/**
 * Resolves a session id or unique prefix, the same way `lykos show` does.
 * Kept here rather than shared because the failure messages differ: `show`
 * lists recent sessions to pick from, and so should this.
 */
function resolveSessionId(ledger: Ledger, idOrPrefix: string, refuse: (message: string) => void): string | null {
  const exact = ledger.db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(idOrPrefix) as
    | { id: string }
    | undefined;
  if (exact) return exact.id;
  const matches = ledger.db
    .prepare(`SELECT id FROM sessions WHERE id LIKE ? ORDER BY started_utc DESC`)
    .all(`${idOrPrefix}%`) as Array<{ id: string }>;
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    refuse(`lykos resume: ambiguous session prefix — ${matches.length} sessions match "${idOrPrefix}"\n`);
    return null;
  }
  refuse(`lykos resume: no session matches "${idOrPrefix}"\n`);
  return null;
}

/**
 * The mechanism flags the resumed session boots with.
 *
 * The standalone boot path reads these off the environment
 * (`dietEnabledFromEnv` / `outputDietEnabledFromEnv`), so inheritance is
 * implemented by setting those variables before booting — which keeps ONE
 * reader of the flag rather than adding a second, parallel one that could
 * disagree with it.
 */
export function applyInheritedFlags(
  meta: { flags?: { promptDiet?: boolean; outputDiet?: boolean } } | null | undefined,
  opts: ResumeOptions,
  env: NodeJS.ProcessEnv = process.env,
): { promptDiet: boolean; outputDiet: boolean; overridden: boolean } {
  const inheritedPrompt = meta?.flags?.promptDiet;
  const inheritedOutput = meta?.flags?.outputDiet;
  const promptDiet = opts.promptDiet ?? inheritedPrompt ?? env.LYKOS_PROMPT_DIET !== "0";
  const outputDiet = opts.outputDiet ?? inheritedOutput ?? env.LYKOS_OUTPUT_DIET !== "0";
  env.LYKOS_PROMPT_DIET = promptDiet ? "1" : "0";
  env.LYKOS_OUTPUT_DIET = outputDiet ? "1" : "0";
  const overridden =
    (opts.promptDiet !== undefined && opts.promptDiet !== inheritedPrompt) ||
    (opts.outputDiet !== undefined && opts.outputDiet !== inheritedOutput);
  return { promptDiet, outputDiet, overridden };
}

/** Builds the plan the interactive session runs on, from a preflight that already passed. */
/**
 * T60: the tool surface a resumed session boots with.
 *
 * The original's, from T54's meta — **never the parent's**. A Lykos-spawned
 * child is denied the `Agent` tool at boot (`resolveStandaloneTools`'s
 * `isChild` branch), and a resume that put it back would let a subagent
 * spawn subagents through the back door. The strip is unconditional here
 * rather than trusting the recorded list, because the recorded list is data
 * and this is an invariant.
 */
export function inheritedTools(
  recorded: readonly string[] | undefined,
  isChild: boolean,
): string[] | undefined {
  if (!recorded || recorded.length === 0) return undefined;
  const names = recorded.map(canonicalToolName);
  return isChild ? names.filter((t) => t !== AGENT_TOOL_NAME) : names;
}

export function planFromPreflight(
  pre: ResumePreflight,
  flags: { promptDiet: boolean; outputDiet: boolean; overridden: boolean },
  taskIdentity: { taskId: string | null; projectId: string | null; isChild?: boolean },
): ResumePlan {
  const tools = inheritedTools(pre.meta?.tools?.active, taskIdentity.isChild === true);
  return {
    ...(tools !== undefined ? { tools } : {}),
    fromSessionId: pre.sessionId,
    ...(taskIdentity.taskId !== null ? { taskId: taskIdentity.taskId } : {}),
    ...(taskIdentity.projectId !== null ? { projectId: taskIdentity.projectId } : {}),
    replayText: pre.replay?.text ?? "",
    replayEvents: pre.replay?.events ?? 0,
    replayUserTurns: pre.replay?.userTurns ?? 0,
    estimateTokens: pre.cost?.tokens ?? 0,
    estimateUsd: pre.cost?.usd ?? null,
    priceVersion: pre.cost?.priceVersion ?? null,
    flags: { promptDiet: flags.promptDiet, outputDiet: flags.outputDiet, overridden: flags.overridden },
  };
}

async function confirm(lineSource: LineSource | undefined, question: string): Promise<boolean> {
  if (!lineSource) return false;
  process.stderr.write(`${question} [y/N] `);
  const answer = await lineSource.next();
  return answer !== null && /^\s*y(es)?\s*$/i.test(answer);
}

/**
 * The actual cost of the replay, for comparison with the estimate the
 * marker recorded. It is the FIRST call on the resumed session: the replay
 * is the whole of that call's fresh context.
 */
export function actualReplayCost(
  ledger: Ledger,
  sessionId: string,
): { tokens: number; usd: number | null } | null {
  const row = ledger.db
    .prepare(
      `SELECT input_tokens, cache_write_tokens, cost_usd
         FROM calls WHERE session_id = ? ORDER BY ts_utc ASC, rowid ASC LIMIT 1`,
    )
    .get(sessionId) as
    | { input_tokens: number | null; cache_write_tokens: number | null; cost_usd: number | null }
    | undefined;
  if (!row) return null;
  return {
    tokens: (row.input_tokens ?? 0) + (row.cache_write_tokens ?? 0),
    usd: row.cost_usd,
  };
}

export async function runResume(
  cwd: string,
  ledgerPath: string,
  idOrPrefix: string,
  opts?: ResumeOptions,
): Promise<number> {
  const refuse = (message: string, reason: string = message): void => {
    process.stderr.write(message);
    opts?.onRefusal?.(reason.trim());
  };
  if (!existsSync(ledgerPath)) {
    refuse(`lykos resume: no ledger at ${ledgerPath} — nothing has been recorded yet.\n`);
    return 1;
  }
  const ledger = openLedgerSync(ledgerPath);
  let plan: ResumePlan;
  let model: string | undefined;
  try {
    const sessionId = resolveSessionId(ledger, idOrPrefix, refuse);
    if (!sessionId) return 1;

    const pre = preflightResume({
      ledger,
      sessionId,
      workspace: cwd,
      ...(opts?.force ? { allowMissingFiles: true } : {}),
      ...(opts?.now !== undefined ? { now: opts.now } : {}),
    });

    stdoutWrite(`lykos resume  ${sessionId}\n`);
    stdoutWrite(`${formatPreflight(pre)}\n`);

    if (pre.overall === "refuse") {
      refuse(
        "lykos resume: refused — see the ✗ line(s) above. Nothing was started and nothing was spent.\n",
        `refused: ${formatPreflight(pre).split("\n").filter((l) => l.includes("✗")).map((l) => l.trim()).join("; ")}`,
      );
      return 1;
    }
    if (opts?.dryRun) return 0;

    // Never resume a paid context without showing the price first. The
    // preflight has already printed it; this is the agreement.
    if (pre.overall === "confirm" && opts?.yes !== true) {
      const ok = await confirm(opts?.lineSource, "lykos resume: proceed?");
      if (!ok) {
        refuse("lykos resume: cancelled. Nothing was spent.\n");
        return 1;
      }
    }

    const identity = ledger.db
      .prepare(`SELECT task_id, project_id, model, execution_shape, parent_session_id FROM sessions WHERE id = ?`)
      .get(sessionId) as {
      task_id: string | null;
      project_id: string | null;
      model: string | null;
      execution_shape: string | null;
      parent_session_id: string | null;
    };
    const flags = applyInheritedFlags(pre.meta, opts ?? {});
    plan = planFromPreflight(pre, flags, {
      taskId: identity.task_id,
      projectId: identity.project_id,
      // T60: a Lykos-spawned child resumes with the CHILD's surface. The
      // parent's `Agent` tool is never restored.
      isChild: identity.execution_shape === "subagent" || identity.parent_session_id !== null,
    });
    // A substitute model is always the caller's explicit choice — the
    // preflight refuses rather than picking one.
    model = opts?.model ?? identity.model ?? undefined;

    // 2026-09-07 (UI feedback item 1): reopen the row this resume is about
    // to continue. `endSession()` refuses to end a session that has already
    // ended — correctly, that is the append-only rule — so a continuation
    // could not be ingested at all until the row is live again.
    //
    // This is the last thing done before booting and the first thing that
    // could be undone by a failed boot, which is the right order: every
    // check above can still refuse, and none of them has written anything.
    ledger.reopenSession(sessionId);
  } finally {
    ledger.close();
  }

  const launch =
    opts?.launch ??
    (async (input: LaunchInput) => {
      const { runInteractiveStandaloneSession } = await import("../session/interactive.js");
      const result = await runInteractiveStandaloneSession({
        workspace: input.workspace,
        ledgerPath: input.ledgerPath,
        ...(input.model !== undefined ? { model: input.model } : {}),
        // T60: inherited, not re-derived. A session booted with a different
        // surface from the one the conversation used is a different
        // experiment wearing the same id.
        ...(input.resume.tools !== undefined ? { tools: input.resume.tools } : {}),
        // No label. It used to say `resumed from <id>`, which was the brief
        // of the NEW row a resume used to create; there is no new row now
        // (item 1), and overwriting the session's own name with a sentence
        // about how it was reopened would lose the name it already has.
        resume: input.resume,
      });
      return result.status === "ok"
        ? { status: "ok" as const, sessionId: result.sessionId }
        : { status: "error" as const, message: result.message };
    });

  const result = await launch({ workspace: cwd, ledgerPath, model, resume: plan });
  if (result.status === "error") {
    process.stderr.write(`lykos resume: ${result.message ?? "the resumed session ended in error"}\n`);
    return 1;
  }

  // The estimate against reality — free to collect, and the only number this
  // phase produces about itself.
  if (result.sessionId) {
    const after = openLedgerSync(ledgerPath);
    try {
      const actual = actualReplayCost(after, result.sessionId);
      if (actual) {
        stdoutWrite(
          `lykos resume: replay estimated ${plan.estimateTokens} tokens` +
            (plan.estimateUsd === null ? " (unpriced)" : ` ≈ $${plan.estimateUsd.toFixed(4)}`) +
            `; first call actually sent ${actual.tokens} tokens` +
            (actual.usd === null ? " (unpriced)" : ` ≈ $${actual.usd.toFixed(4)}`) +
            "\n",
        );
      }
    } finally {
      after.close();
    }
  }
  return 0;
}
