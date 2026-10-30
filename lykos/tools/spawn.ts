// Lykos spawns its own subagents. D3.4: a child spawned here is a Lykos session
// with a Lykos identity and a Lykos transcript — `session/session.ts` called
// recursively, not `pi-subagents`.
//
// The host path carries `noExtensions: true` (T33); the Agent tool on this
// path is therefore a Lykos-owned `customTools` entry that shadows the name
// T20 already justified for the hop-0 surface when subagents are opted in.
// It runs foreground (blocks until the child finishes) so
// `get_subagent_result` / `steer_subagent` are not needed and are not
// registered — those exist for pi-subagents' background agents, which this
// path deliberately does not use (T30: "the host path does not need that
// extension at all").
//
// Cost: the child writes its own ledger rows via the same
// `ingestDelegateSnapshot()` path; the parent does NOT also fold the
// child's tokens into `nested*` (T39.2). Budget: before each spawn, T7's
// kill switch checks the *task* total, not the node (T39.4).

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResolvedConfig } from "../config/types.js";
import { resolveSpecialist } from "../config/specialists.js";
import { applySpecialist, type SpecialistFields } from "../session/specialist-apply.js";
import type { BootDeps } from "../session/boot.js";
import { openLedger, openLedgerSync, type Ledger } from "../ledger/use.js";
import { resolveProject } from "../session/identity.js";
import {
  guardToolCall,
  taskExceedsRunCap,
  type BudgetVerdict,
} from "../ledger/budget.js";
import { resolvePathRulesAndContext, type ApprovalGate } from "../gate/approval.js";
import { getAllowedPatterns, getGateVerifyCommand, inheritPermissions, SubagentGate } from "../gate/delegated.js";
import { isInteractionMode, type InteractionMode } from "../gate/modes.js";
import type { PathRule, PathDecision } from "../gate/path-rules.js";
import type { PeerBus } from "./mailbox.js";
import type { TrustSource } from "../gate/trust.js";
import type { ProjectExecutor } from "./executor.js";
import { loadConfig } from "../config/load.js";
import type { ContainmentLevel, ContainmentRecord } from "../containment/containment.js";
import { resolveChildContainment, type ChildContainment } from "../containment/request.js";
import type { ContainerRuntimeDriver } from "../containment/runtime.js";
import type { Provider } from "../session/model-runtime.js";
import type { WorkTree } from "../session/session.js";

/** Mutable handle shared by the parent session and every Agent call it makes. */
export interface SpawnContext {
  parentSessionId: string;
  /** The project's root: where config, the ledger and `.lykos` state are. A child's state lives here, never in a worktree. */
  workspace: string;
  /** T184: when the parent works on a worktree of its own, a child works on the same one. `workspace` stays the root. */
  workTree?: WorkTree;
  ledgerPath: string;
  config: ResolvedConfig;
  modelSpec: string;
  gate: ApprovalGate;
  autoApprove: boolean;
  parentMode?: InteractionMode | (() => InteractionMode);
  /** Filled on first spawn when the parent row is ensured. */
  taskId?: string;
  projectId?: string;
  /** Brief the parent will ingest under — used when ensuring the parent row early. */
  parentBrief: string;
  executionShape: "standalone" | "subagent";
  /** Set when this context itself belongs to a child — children do not get Agent. */
  allowSpawn: boolean;
  /**
   * P10.5 (ticket 17, D2): the peer bus of the session family this context
   * represents.
   *
   * It is HERE and nowhere else because this object is the family: it is
   * created once per parent session, it is what every Agent call goes through,
   * and it is therefore the only thing that knows which sessions are relatives
   * and which are strangers sharing a process. A child joins it on the way in
   * and leaves it on the way out, so a family's roster is exactly the agents
   * that are actually running.
   */
  bus?: PeerBus;
  bootDeps?: BootDeps;
  /** T172: the parent's executor, inherited by every child it spawns so a child's commands run where the parent's do. */
  executor?: ProjectExecutor;
  /**
   * T182: what the parent asked of containment and got. A child inherits its `requested` level unless the call
   * names one, and a child that keeps the parent's level shares `executor` and this record. Absent, a child
   * simply shares `executor`, as before.
   */
  containment?: ContainmentRecord;
  /** T182: the container runtimes a child that needs its own container may use. Tests only; absent means the machine's. */
  containmentDrivers?: readonly ContainerRuntimeDriver[];
  /** Native providers the parent's model runtime was given, handed to a child so it resolves the same models. Tests only. */
  nativeProviders?: readonly Provider[];
  /** T194: the parent is a delegated session; its children are too, so the untrusted-project narrowing applies to them. */
  delegated?: boolean;
  /** T194: how the parent crossed the trust boundary, handed to every child. */
  trustSource?: TrustSource;
  /** Environment the child's credential check reads. Omitted = `process.env`. Tests only. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Ensure the parent session row (and its task) exist so a child's
 * `parent_session_id` FK can resolve. Standalone sessions otherwise only
 * land in the ledger at end-of-run ingest (T33); the first Agent call has
 * to promote that to "row exists now."
 */
export function ensureParentSessionForSpawn(
  ledger: Ledger,
  ctx: SpawnContext,
): { taskId: string; projectId: string } {
  const existing = ledger.db
    .prepare(`SELECT id, task_id, project_id FROM sessions WHERE id = ?`)
    .get(ctx.parentSessionId) as
    | { id: string; task_id: string | null; project_id: string | null }
    | undefined;

  if (existing?.task_id && existing.project_id) {
    ctx.taskId = existing.task_id;
    ctx.projectId = existing.project_id;
    return { taskId: existing.task_id, projectId: existing.project_id };
  }

  const resolved = resolveProject(ctx.workspace);
  ledger.ensureProject({
    id: resolved.id,
    rootPath: resolved.record.root_path,
    gitRemote: resolved.record.git_remote,
    firstCommit: resolved.record.first_commit,
    name: resolved.record.name,
    createdUtc: resolved.record.created_utc,
    lastSeenUtc: resolved.record.last_seen_utc,
  });

  const taskId =
    existing?.task_id ??
    ctx.taskId ??
    ledger.startTask({ projectId: resolved.id, brief: ctx.parentBrief });
  const projectId = existing?.project_id ?? resolved.id;

  if (!existing) {
    const modelId = ctx.modelSpec.includes("/") ? ctx.modelSpec.split("/")[1]! : ctx.modelSpec;
    ledger.startSession({
      id: ctx.parentSessionId,
      taskId,
      projectId,
      brief: ctx.parentBrief,
      workspace: ctx.workspace,
      executionShape: ctx.executionShape,
      runtime: "host",
      model: modelId,
      agentRole: "worker",
      resumable: true,
      flags: { delegation: true, cacheStableHead: true },
    });
  } else if (!existing.task_id || !existing.project_id) {
    // Row was somehow created without identity — backfill the FKs we need.
    ledger.db
      .prepare(`UPDATE sessions SET task_id = COALESCE(task_id, ?), project_id = COALESCE(project_id, ?) WHERE id = ?`)
      .run(taskId, projectId, ctx.parentSessionId);
  }

  ctx.taskId = taskId;
  ctx.projectId = projectId;
  return { taskId, projectId };
}

/**
 * P10.6 (ticket 20, D3): what one child run needs, and nothing about how the
 * answer is rendered.
 *
 * This was the body of `Agent`'s `execute` until `new_context` needed the same
 * thing. D3 says to reuse the spawn machinery rather than build a second child
 * mechanism, and the only way to actually do that is for the machinery to be a
 * function rather than a closure inside one tool's definition. `Agent` and
 * `new_context` differ in exactly two ways — the default specialist, and how
 * much of the result the parent is shown — and both of those are above this
 * line, not inside it.
 */
export interface ChildRunRequest {
  prompt: string;
  /** Short label, used for the child's session name in the ledger and the UI. */
  description: string;
  /** Specialist to run as. */
  role: string;
  /** `provider/modelId`. Omitted, the child inherits whatever the specialist and config resolve to. */
  model?: string;
  /** T182: the containment level the child is to run at. Omitted, it inherits the parent's, under the same floor. */
  containment?: ContainmentLevel;
}

/**
 * The four ways a child run ends. Deliberately not a thrown error: every one
 * of these is something the model has to read and act on, and a thrown error
 * would reach it as a failed tool call with no structure.
 */
export type ChildRunOutcome =
  | { status: "refused"; message: string; details: Record<string, unknown> }
  | { status: "blocked"; message: string; details: Record<string, unknown> }
  | { status: "error"; message: string; details: Record<string, unknown> }
  | { status: "finished"; sessionId: string; role: string; text: string | undefined; peer?: string };

/**
 * Runs one child session to completion: specialist resolution, the budget
 * checks, the ledger rows, the family's bus seat and the recursive
 * `runStandaloneTask`. Everything a child run is, and no rendering.
 */
export async function runChildSession(ctx: SpawnContext, req: ChildRunRequest): Promise<ChildRunOutcome> {
  if (!ctx.allowSpawn) {
    return {
      status: "refused",
      message: "lykos: Agent is not available on a subagent session (no recursive spawn from hop-1).",
      details: { blocked: true },
    };
  }

  const role = req.role;
  let resolvedSpecialist;
  try {
    resolvedSpecialist = resolveSpecialist(role, ctx.workspace);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "refused", message: msg, details: { error: msg } };
  }

  if (resolvedSpecialist.file.delegate === false) {
    const msg = `lykos: specialist "${role}" declines to configure a delegated agent`;
    return { status: "refused", message: msg, details: { error: msg } };
  }

  // T182: the child's containment, decided once and before a row, a budget check or a seat on the bus: the
  // level it runs at, the floor, and whether the parent's container is the right one (resolveChildContainment).
  const level = req.containment ?? ctx.containment?.requested;
  let childContainment: ChildContainment = { kind: "unmanaged" };
  if (level !== undefined) {
    try {
      const { resolved, layers } = loadConfig({
        cwd: ctx.workspace,
        specialistName: role,
        flags: { containment: { level } },
        ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      });
      childContainment = resolveChildContainment({ parent: ctx.containment, asked: req.containment, config: resolved, layers });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: "refused", message: msg, details: { error: msg } };
    }
    if (childContainment.kind === "refused") {
      return { status: "refused", message: childContainment.message, details: { error: childContainment.message } };
    }
  }

  const specialistFields: SpecialistFields = {
    ...(resolvedSpecialist.file.instructions !== undefined
      ? { instructions: resolvedSpecialist.file.instructions }
      : {}),
    ...(resolvedSpecialist.file.prompt_mode !== undefined
      ? { prompt_mode: resolvedSpecialist.file.prompt_mode }
      : {}),
    ...(resolvedSpecialist.file.tools_mode !== undefined
      ? { tools_mode: resolvedSpecialist.file.tools_mode }
      : {}),
    ...(resolvedSpecialist.file.provider !== undefined
      ? { provider: resolvedSpecialist.file.provider }
      : {}),
    ...(resolvedSpecialist.file.model !== undefined
      ? { model: resolvedSpecialist.file.model }
      : {}),
  };

  const app = applySpecialist({
    name: role,
    specialist: specialistFields,
    context: "subagent",
    parentModel: ctx.modelSpec,
    ...(req.model !== undefined ? { callerModel: req.model } : {}),
    ...(ctx.config.models.delegate !== undefined ? { delegateModel: ctx.config.models.delegate } : {}),
    defaultToolNames: [],
  });

  const ledger = await openLedger(ctx.ledgerPath);
  let taskId: string;
  let projectId: string;
  try {
    ({ taskId, projectId } = ensureParentSessionForSpawn(ledger, ctx));

    if (taskExceedsRunCap(ledger, ctx.parentSessionId, ctx.config.budget.per_run_usd)) {
      return {
        status: "blocked",
        message:
          `lykos: blocked — task tree already exceeds the ` +
          `$${ctx.config.budget.per_run_usd.toFixed(4)} per-run cap (T39.4)`,
        details: { blocked: true, capKind: "run" },
      };
    }

    const preflight: BudgetVerdict = guardToolCall({
      toolName: "spawn",
      args: { prompt: req.prompt, model: app.model ?? ctx.modelSpec },
      ledgerPath: ctx.ledgerPath,
      budget: ctx.config.budget,
      defaultModel: ctx.modelSpec,
      trippedSessions: new Set(),
      taskSpentUsd: ledger.taskCallTotals(ctx.parentSessionId).costUsd ?? 0,
    });
    if (preflight.tripped) {
      return {
        status: "blocked",
        message: `lykos: blocked — ${preflight.reason}`,
        details: { blocked: true, capKind: preflight.capKind },
      };
    }
  } finally {
    ledger.close();
  }

  // P10.5 (ticket 17, D2): the child joins the family's bus under its
  // specialist's name before it boots, so the parent can address it and it
  // can address the parent, and leaves in the `finally` below — a child
  // that stayed on the roster after it finished would be a name every
  // later `send` failed against for a reason nothing explained.
  const childMailbox = ctx.bus?.join(role);
  try {
    // Dynamic import breaks the session.ts ↔ spawn.ts load cycle: spawn's
    // execute is the only place that needs runStandaloneTask, and session
    // statically imports loadTools at boot.
    const { runStandaloneTask } = await import("../session/session.js");

    const toolCwd = ctx.workTree?.path ?? ctx.workspace;
    const { rules: parentRules, ctx: parentPathCtx } =
      ctx.gate.pathRules !== undefined && ctx.gate.pathContext !== undefined
        ? { rules: ctx.gate.pathRules, ctx: ctx.gate.pathContext }
        : await resolvePathRulesAndContext(toolCwd);

    let parentMode: InteractionMode;
    if (ctx.parentMode !== undefined) {
      parentMode = typeof ctx.parentMode === "function" ? ctx.parentMode() : ctx.parentMode;
    } else if ((ctx.gate as any).mode !== undefined && isInteractionMode((ctx.gate as any).mode)) {
      parentMode = (ctx.gate as any).mode;
    } else {
      parentMode = ctx.autoApprove ? "auto" : "manual";
    }

    const childRules: PathRule[] = [];
    const rawRules = (resolvedSpecialist.file as any).path_rules;
    if (rawRules && typeof rawRules === "object") {
      for (const access of ["read", "write"] as const) {
        const accessRules = rawRules[access];
        if (accessRules && typeof accessRules === "object") {
          for (const [pattern, decision] of Object.entries(accessRules)) {
            childRules.push({
              pattern,
              access,
              decision: decision as PathDecision,
              source: "subagent",
            });
          }
        }
      }
    }
    const specialistReadOnly = resolvedSpecialist.file.read_only === true;

    const inherited = inheritPermissions(
      { mode: parentMode, rules: parentRules, ctx: parentPathCtx },
      {
        rules: childRules,
      },
    );

    const childGate = new SubagentGate({
      name: role,
      parentGate: ctx.gate,
      mode: inherited.mode,
      rules: inherited.rules,
      ctx: inherited.ctx,
      allowed: getAllowedPatterns(ctx.gate),
      readOnly: specialistReadOnly,
      verifyCommand: getGateVerifyCommand(ctx.gate),
    });

    const result = await runStandaloneTask({
      workspace: ctx.workspace,
      ...(ctx.workTree !== undefined ? { workTree: ctx.workTree } : {}),
      prompt: req.prompt,
      label: `${req.description} — ${role}`,
      ledgerPath: ctx.ledgerPath,
      autoApprove: ctx.autoApprove,
      parentSessionId: ctx.parentSessionId,
      taskId,
      projectId,
      agentRole: role,
      specialist: role,
      specialistContext: "subagent",
      specialistFields,
      executionShape: "subagent",
      gate: childGate,
      interactionMode: inherited.mode,
      ...(specialistReadOnly ? { readOnly: true } : {}),
      ...(childMailbox !== undefined ? { mailbox: childMailbox } : {}),
      ...(ctx.bootDeps !== undefined ? { bootDeps: ctx.bootDeps } : {}),
      ...(ctx.delegated === true ? { delegated: true } : {}),
      ...(ctx.trustSource !== undefined ? { trustSource: ctx.trustSource } : {}),
      ...(childContainment.kind === "own"
        ? {
            containmentLevel: childContainment.level,
            containmentAskedFrom: req.containment !== undefined ? "the spawn call" : "the parent session",
            ...(childContainment.network !== undefined ? { containmentNetwork: childContainment.network } : {}),
            ...(ctx.containmentDrivers !== undefined ? { containmentDrivers: ctx.containmentDrivers } : {}),
          }
        : {
            ...(ctx.executor !== undefined ? { executor: ctx.executor } : {}),
            ...(childContainment.kind === "share" ? { containmentRecord: childContainment.record } : {}),
          }),
      ...(ctx.nativeProviders !== undefined ? { nativeProviders: ctx.nativeProviders } : {}),
      ...(ctx.env !== undefined ? { env: ctx.env } : {}),
      ...(app.model !== undefined ? { model: app.model } : {}),
      ...(app.modelSource !== undefined ? { modelSource: app.modelSource } : {}),
    });

    if (result.status === "blocked") {
      return { status: "blocked", message: `lykos: blocked — ${result.reason}`, details: { blocked: true } };
    }
    if (result.status === "error") {
      return {
        status: "error",
        message: `lykos: subagent error — ${result.message}`,
        details: { error: result.message },
      };
    }

    return {
      status: "finished",
      sessionId: result.sessionId,
      role,
      text: result.text,
      ...(childMailbox !== undefined ? { peer: childMailbox.name } : {}),
    };
  } finally {
    // Idempotent, and deliberately belt-and-braces with the child's own
    // teardown: a child that threw on its way up must still come off the
    // roster, or every later `send` to that name fails against a ghost.
    childMailbox?.leave();
  }
}

/**
 * Lykos-owned spawn tool. The wire name is `agent`. `canonicalToolName`
 * still accepts Pi's `Agent` on an old allowlist. The implementation is
 * recursive `runStandaloneTask`, not pi-subagents.
 */
export function buildAgentTool(ctx: SpawnContext): ToolDefinition {
  return defineTool({
    name: "agent",
    label: "agent",
    description:
      "Spawn a Lykos subagent as its own session (own transcript, own ledger rows, resumable). " +
      "Runs to completion and returns the child's final answer. Prefer for open-ended search " +
      "or investigation that should not flood this conversation — the child starts with a fresh " +
      "context. Default tool surface is read-only (explore).",
    promptSnippet: "Spawn a resumable Lykos subagent (fresh context, read-only by default)",
    parameters: Type.Object({
      prompt: Type.String({ description: "The task for the subagent to perform." }),
      description: Type.String({
        description: "A short (3-5 word) description of the task (shown in UI).",
      }),
      subagent_type: Type.Optional(
        Type.String({
          description: 'Specialist name to run as. Default "explore".',
        }),
      ),
      model: Type.Optional(
        Type.String({
          description: 'Optional model override as "provider/modelId". Omit to inherit the parent.',
        }),
      ),
      containment: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("required"), Type.Literal("off")], {
          description:
            "Where the subagent's commands run: required (in a container, refuse without a runtime), auto (in a container " +
            "when a runtime works, else on this machine) or off (on this machine). Omit to inherit this session's level. " +
            "A level below the configured floor is refused.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const text = (s: string) => [{ type: "text" as const, text: s }];

      const outcome = await runChildSession(ctx, {
        prompt: params.prompt,
        description: params.description,
        role: params.subagent_type ?? "explore",
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.containment !== undefined ? { containment: params.containment } : {}),
      });

      if (outcome.status !== "finished") {
        return { content: text(outcome.message), details: outcome.details };
      }

      let disputeSummary = "";
      if (ctx.ledgerPath && outcome.sessionId) {
        try {
          const ledger = openLedgerSync(ctx.ledgerPath);
          try {
            const disputes = ledger.db
              .prepare(
                "SELECT paths, detail FROM seal_events WHERE session_id = ? AND kind = 'dispute filed' ORDER BY id ASC",
              )
              .all(outcome.sessionId) as Array<{ paths: string; detail: string | null }>;
            if (disputes.length > 0) {
              const lines = disputes.map((d) => {
                let name = d.paths;
                let reason = "";
                let evidence = "";
                if (d.detail) {
                  try {
                    const parsed = JSON.parse(d.detail);
                    name = parsed.name ?? name;
                    reason = parsed.reason ?? "";
                    evidence = parsed.evidence ?? "";
                  } catch {}
                }
                const reasonPart = reason ? ` (reason: ${reason})` : "";
                const evidencePart = evidence ? ` (evidence: ${evidence})` : "";
                return `disputed test: ${name}${reasonPart}${evidencePart}`;
              });
              disputeSummary = `\n\nstatus: disputed\nDisputes:\n${lines.join("\n")}\n`;
            }
          } finally {
            ledger.close();
          }
        } catch {}
      }

      return {
        content: text(
          `subagent ${outcome.sessionId} (${outcome.role}) finished.\n` +
            `resumable=1 — Lykos-spawned child (T39.3).\n\n` +
            `${outcome.text ?? "(no answer)"}` +
            disputeSummary,
        ),
        details: {
          sessionId: outcome.sessionId,
          role: outcome.role,
          resumable: true,
          ...(disputeSummary ? { disputed: true } : {}),
          ...(outcome.peer !== undefined ? { peer: outcome.peer } : {}),
        },
      };
    },
  }) as ToolDefinition;
}
