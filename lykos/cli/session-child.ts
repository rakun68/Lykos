// `lykos session-child`: the process one MCP call runs in (T181, spec #22
// stories 70-74, ADR-0036/ADR-0038). Not a command a person types; `lykos mcp`
// starts one per call (delegate/session-process.ts).
//
// It reads one request line from stdin (delegate/session-protocol.ts), runs the
// same delegated session `lykos run` runs (`sessionInput` in cli/run.ts), and
// writes progress lines and one result line to stdout. stdout is the protocol:
// nothing else may be written there, so lykos/tui/io-mode.ts owns the stream
// (`claimProtocolStream`): it hands this file the writer for frames and routes
// every other write to stderr.

import { randomUUID } from "node:crypto";
import { runResume } from "./resume.js";
import { sessionInput } from "./run.js";
import { defaultLedgerPath, openLedger } from "../ledger/use.js";
import { ensureWorkspaceTrust, type TrustSource } from "../gate/trust.js";
import type { InteractionMode } from "../gate/modes.js";
import { stderrWrite } from "../tui/io-mode.js";
import { recordWork, rootSessionOf, withWorkTarget, workFields, type WorkReport } from "../delegate/work-target.js";
import { runStandaloneTask, type RunStandaloneTaskInput, type RunStandaloneTaskResult } from "../session/session.js";
import {
  encodeFrame,
  parseRequest,
  type Frame,
  type SessionDispute,
  type SessionOutcome,
  type SessionRequest,
  modeOfTool,
  specialistOfTool,
  ASK_TIMEOUT_NOTICE,
} from "../delegate/session-protocol.js";
import type { Coordinator } from "../tools/coordinator.js";
import { resolveSpecialist, DEFAULT_SPECIALIST } from "../config/specialists.js";
import { activeSeals, type ActiveSeal } from "../seal/active.js";
import { resolveRef } from "../seal/git.js";
import { findSealedPathMatch } from "../extensions/defaults/lykos-seal.js";
import { commandPathAccesses } from "../gate/bash-paths.js";
import type { BootDeps } from "../session/boot.js";
import { createAgentSession, type AgentSession } from "@earendil-works/pi-coding-agent";

const DEFAULT_PROGRESS_INTERVAL_MS = 15_000;

/**
 * How the parent says it established trust. A claim, never a grant: the child
 * reads the user's trust store itself, and the claim only lets a project the
 * store does not hold pass the gate as `flag`. It can never produce `stored`,
 * which is the one source that trusts a project's own binaries (`lsp`, #24).
 */
export async function resolveChildTrust(opts: {
  workspace: string;
  env: NodeJS.ProcessEnv;
  trustPath?: string;
}): Promise<TrustSource> {
  const claim = opts.env.LYKOS_TRUST_SOURCE;
  const claimed = claim === "stored" || claim === "flag" || claim === "prompt";
  const decision = await ensureWorkspaceTrust({
    workspace: opts.workspace,
    interactive: false,
    ...(claimed ? { trustWorkspace: true } : {}),
    ...(opts.trustPath !== undefined ? { trustPath: opts.trustPath } : {}),
  });
  return decision.source;
}

/**
 * Reads stdin: parses the first newline-terminated line as the request, retains any bytes
 * buffered after the first newline, and processes subsequent lines as steer frames.
 * Its closing later means the parent is gone.
 */
function readInputStream(
  input: NodeJS.ReadableStream,
  onSteer: (message: string) => void,
  onParentGone?: () => void,
): Promise<string | undefined> {
  return new Promise((resolve) => {
    let buffer = "";
    let requestResolved = false;
    let parentGoneFired = false;

    const fireParentGone = (): void => {
      if (requestResolved && !parentGoneFired) {
        parentGoneFired = true;
        onParentGone?.();
      }
    };

    const processBuffer = (): void => {
      if (!requestResolved) {
        const end = buffer.indexOf("\n");
        if (end >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          requestResolved = true;
          resolve(line);
        }
      }
      if (requestResolved) {
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (line.length === 0) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === "object" && parsed.type === "steer" && typeof parsed.message === "string") {
              onSteer(parsed.message);
            }
          } catch {
            // Stray or unparseable lines are ignored
          }
        }
      }
    };

    const onData = (chunk: Buffer | string): void => {
      buffer += String(chunk);
      processBuffer();
    };

    const onEnd = (): void => {
      if (!requestResolved) {
        requestResolved = true;
        resolve(buffer.length > 0 ? buffer : undefined);
      } else {
        fireParentGone();
      }
    };

    input.on("data", onData);
    input.on("end", onEnd);
    input.on("close", onEnd);
    input.resume();
  });
}

export interface SessionChildDeps {
  input?: NodeJS.ReadableStream;
  /** Writes one protocol line. */
  write: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Tests only: the user trust store. */
  trustPath?: string;
  /** Tests only: the session engine, and what the engine needs to run on a scripted model. */
  runTask?: (input: RunStandaloneTaskInput) => Promise<RunStandaloneTaskResult>;
  sessionExtras?: Partial<RunStandaloneTaskInput>;
  /** Tests only: where worktrees are made. */
  worktreesRoot?: string;
  /** Called when stdin closes after the request was read: the parent went away. */
  onParentGone?: () => void;
}

/** Runs one request. Returns the process exit code: 0 when a result was written, 2 when there was no usable request. */
export async function runSessionChild(deps: SessionChildDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const input = deps.input ?? process.stdin;
  const send = (frame: Frame): void => deps.write(encodeFrame(frame));

  let activeAgentSession: { steer: (msg: string) => Promise<void> } | undefined;
  const pendingSteers: string[] = [];
  let steerChain: Promise<void> = Promise.resolve();
  let pendingAskResolver: ((message: string) => void) | undefined;

  const onParentGone = (): void => {
    if (pendingAskResolver !== undefined) {
      const resolve = pendingAskResolver;
      pendingAskResolver = undefined;
      resolve(ASK_TIMEOUT_NOTICE);
    }
    deps.onParentGone?.();
  };

  const deliverSteer = (session: { steer: (msg: string) => Promise<void> }, message: string): Promise<void> => {
    if (typeof session.steer !== "function") {
      send({ type: "progress", message: "steer refused: session does not support steering" });
      return Promise.resolve();
    }
    return Promise.resolve(session.steer(message))
      .then(() => {
        send({ type: "progress", message: `steer queued: ${message}` });
      })
      .catch((err) => {
        send({ type: "progress", message: `steer refused: ${err instanceof Error ? err.message : String(err)}` });
      });
  };

  const handleSteer = (message: string): void => {
    if (pendingAskResolver !== undefined) {
      const resolve = pendingAskResolver;
      pendingAskResolver = undefined;
      send({ type: "progress", message: `question answered: ${message}` });
      resolve(message);
      return;
    }
    steerChain = steerChain.then(async () => {
      if (activeAgentSession !== undefined) {
        await deliverSteer(activeAgentSession, message);
      } else {
        pendingSteers.push(message);
      }
    });
  };

  const onSessionCreated = (session: unknown): void => {
    steerChain = steerChain.then(async () => {
      activeAgentSession = session as { steer: (msg: string) => Promise<void> };
      while (pendingSteers.length > 0) {
        const msg = pendingSteers.shift()!;
        await deliverSteer(activeAgentSession, msg);
      }
    });
  };

  let givenUpQuestion: string | undefined;
  const coordinator: Coordinator = {
    ask: (question: string, signal?: AbortSignal): Promise<string> => {
      return new Promise<string>((resolve) => {
        let settled = false;
        const finish = (ans: string) => {
          if (settled) return;
          settled = true;
          pendingAskResolver = undefined;
          if (signal && onAbort) signal.removeEventListener("abort", onAbort);
          resolve(ans);
        };
        pendingAskResolver = finish;
        const onAbort = () => finish(ASK_TIMEOUT_NOTICE);
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        send({ type: "question", question });
      });
    },
    giveUp: (question: string): void => {
      givenUpQuestion = question;
    },
  };

  const line = await readInputStream(input, handleSteer, onParentGone);
  const request = line === undefined ? undefined : parseRequest(line);
  if (request === undefined) {
    send({ type: "result", result: { outcome: "error", message: "session-child: expected one JSON request line on stdin (protocol version 1)" } });
    return 2;
  }

  const startedAt = Date.now();
  send({ type: "progress", message: "session starting" });
  const interval = setInterval(
    () => send({ type: "progress", message: `session running, ${Math.round((Date.now() - startedAt) / 1000)}s elapsed` }),
    progressIntervalFromEnv(env),
  );
  try {
    send({
      type: "result",
      result: await runRequest(
        request,
        deps,
        env,
        (message) => send({ type: "progress", message }),
        onSessionCreated,
        coordinator,
        () => givenUpQuestion,
      ),
    });
  } catch (err) {
    send({ type: "result", result: { outcome: "error", message: err instanceof Error ? err.message : String(err) } });
  } finally {
    clearInterval(interval);
  }
  return 0;
}

function progressIntervalFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.LYKOS_SESSION_PROGRESS_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PROGRESS_INTERVAL_MS;
}

async function runRequest(
  request: SessionRequest,
  deps: SessionChildDeps,
  env: NodeJS.ProcessEnv,
  progress: (message: string) => void,
  onSessionCreated?: (session: unknown) => void,
  coordinator?: Coordinator,
  getGivenUpQuestion?: () => string | undefined,
): Promise<SessionOutcome> {
  let trustSource: TrustSource;
  try {
    trustSource = await resolveChildTrust({ workspace: request.workspace, env, ...(deps.trustPath !== undefined ? { trustPath: deps.trustPath } : {}) });
  } catch (err) {
    return { outcome: "blocked", reason: err instanceof Error ? err.message : String(err) };
  }
  // The interaction mode is the one input that decides whether the session writes (T184, story 49). The parent
  // names it; a request that does not gets the one its tool implies.
  const mode: InteractionMode = request.mode ?? modeOfTool(request.tool);
  const specialistName = request.specialist ?? specialistOfTool(request.tool) ?? DEFAULT_SPECIALIST;
  let specialistReadOnly = false;
  if (specialistName !== undefined) {
    try {
      const resolved = resolveSpecialist(specialistName, request.workspace);
      if (resolved.file.read_only === true) specialistReadOnly = true;
    } catch {
      // Specialist not found or unresolvable
    }
  }
  // Ruling 1: lykos_review keeps a hard read-only floor as a tool invariant,
  // and still resolves the review specialist for its instructions.
  const readOnly = request.tool === "lykos_review" || specialistReadOnly;
  // The id the work is named from exists before the session does: it names the branch and the worktree.
  const runTask = deps.runTask ?? runStandaloneTask;
  const ledgerPath = deps.sessionExtras?.ledgerPath ?? defaultLedgerPath(request.workspace);
  // A continuation reaches the branch of the session the call began, even through a context-limit successor's id.
  const sessionId = request.sessionId === undefined ? (request.newSessionId ?? randomUUID()) : await rootSessionOf(ledgerPath, request.sessionId);

  const worked = await withWorkTarget(
    {
      workspace: request.workspace,
      interactionMode: mode,
      readOnly,
      sessionId,
      ...(request.sessionId === undefined && request.base !== undefined ? { base: request.base } : {}),
      ...(request.writeInPlace !== undefined ? { writeInPlace: request.writeInPlace } : {}),
      ...(deps.worktreesRoot !== undefined ? { worktreesRoot: deps.worktreesRoot } : {}),
    },
    async (target) => {
      const existingCreateSession = deps.sessionExtras?.bootDeps?.createSession;
      const wrappedCreateSession: typeof createAgentSession = async (bootOpts) => {
        const create = existingCreateSession ?? createAgentSession;
        const booted = await create(bootOpts);
        if (onSessionCreated && booted && booted.session) {
          onSessionCreated(booted.session);
        }
        return booted;
      };
      const bootDeps: BootDeps = {
        ...deps.sessionExtras?.bootDeps,
        createSession: wrappedCreateSession,
      };

      const base: RunStandaloneTaskInput = {
        ...sessionInput(
          request.workspace,
          request.prompt,
          {
            ...(request.model !== undefined ? { model: request.model } : {}),
            ...(request.budgetUsd !== undefined ? { budgetPerRunUsd: String(request.budgetUsd) } : {}),
            ...(request.containment !== undefined ? { containment: request.containment } : {}),
            ...(specialistName !== undefined ? { specialist: specialistName } : {}),
            mode,
          },
          trustSource,
        ),
        label: request.label,
        readOnly,
        // A new session gets the id its branch was named from.
        ...(request.sessionId === undefined ? { sessionId } : {}),
        ...(target.workTree !== undefined ? { workTree: target.workTree } : {}),
        ...deps.sessionExtras,
        bootDeps,
        ...(coordinator !== undefined ? { coordinator } : {}),
      };
      if (request.sessionId === undefined) return { result: await runTask(base) };
      const continued = await continueSession(
        request.sessionId,
        target.preflightWorkspace,
        ledgerPath,
        request.model,
        (launched) =>
          runTask({ ...base, ...(launched.model !== undefined && request.model === undefined ? { model: launched.model } : {}), resume: launched.resume, ledgerPath }),
        progress,
      );
      return continued;
    },
  );
  // Whatever the outcome, the call says where its work is (branch, commits, note), and the commit that saved
  // leftover changes is in the ledger.
  const report = (line: string): void => stderrWrite(`${line}\n`);
  if (!worked.ok) {
    const work = worked.work !== undefined ? workFields(await recordWork(ledgerPath, request.sessionId ?? sessionId, worked.work, report)) : {};
    return { outcome: "error", message: worked.message, ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}), ...work };
  }
  const continued = worked.value;
  if ("refused" in continued) {
    const work = workFields(await recordWork(ledgerPath, request.sessionId!, worked.work, report));
    return { outcome: "error", message: continued.refused, sessionId: request.sessionId!, ...work };
  }
  const { result } = continued;
  const id = (result.status === "blocked" ? undefined : result.sessionId) ?? request.sessionId ?? sessionId;
  return outcomeOf(result, ledgerPath, request.sessionId, await recordWork(ledgerPath, id, worked.work, report), request, sessionId, getGivenUpQuestion?.());
}

/**
 * `lykos resume`'s own preflight and bookkeeping, then the one-shot session in
 * place of the interactive one. A refusal (no such session, a file the session
 * edited is gone) comes back as the reason `runResume` gives, since nobody
 * reads this process's stderr.
 *
 * Resume's paid-context confirmation is skipped (`yes: true`): over MCP there
 * is no human to ask, so the caller's `session_id` is the confirmation
 * (ADR-0038). Resume's own price is a characters/4 estimate, so the progress frame says the
 * size and price are unmeasured instead (describeReplayCost).
 */
async function continueSession(
  sessionId: string,
  workspace: string,
  ledgerPath: string,
  model: string | undefined,
  launch: (launched: { model: string | undefined; resume: NonNullable<RunStandaloneTaskInput["resume"]> }) => Promise<RunStandaloneTaskResult>,
  progress: (message: string) => void,
): Promise<{ result: RunStandaloneTaskResult } | { refused: string }> {
  let result: RunStandaloneTaskResult | undefined;
  let reason: string | undefined;
  await runResume(workspace, ledgerPath, sessionId, {
    yes: true,
    ...(model !== undefined ? { model } : {}),
    onRefusal: (why) => {
      reason = why;
    },
    launch: async (launched) => {
      progress(describeReplayCost());
      result = await launch({ model: launched.model, resume: launched.resume });
      return result.status === "ok"
        ? { status: "ok", sessionId: result.sessionId }
        : { status: "error", message: result.status === "error" ? result.message : result.reason };
    },
  });
  if (result === undefined) return { refused: `could not continue session ${sessionId}${reason ? `: ${reason}` : ""}` };
  return { result };
}

/**
 * What a continuation says about the cost of the replayed context. Resume's own figure is a characters/4
 * estimate, priced as if it were measured, and 0 when there is nothing to estimate from; neither is a
 * measurement, so none is reported (AGENTS.md rule 4). The real cost is in the ledger's `calls` once the
 * first call has been made.
 */
export function describeReplayCost(): string {
  return "continuing session: the replayed context's size and price are unmeasured until its first call is recorded";
}

async function resolveSessionBranch(workspace: string, sessionId: string): Promise<string | undefined> {
  if (resolveRef(`lykos/${sessionId}`, workspace)) return `lykos/${sessionId}`;
  if (resolveRef(sessionId, workspace)) return sessionId;
  try {
    const rootId = await rootSessionOf(defaultLedgerPath(workspace), sessionId);
    if (rootId && rootId !== sessionId) {
      if (resolveRef(`lykos/${rootId}`, workspace)) return `lykos/${rootId}`;
      if (resolveRef(rootId, workspace)) return rootId;
    }
  } catch {}
  return undefined;
}

async function outcomeOf(
  result: RunStandaloneTaskResult,
  ledgerPath: string,
  continuing: string | undefined,
  work: WorkReport,
  request: SessionRequest,
  assignedSessionId: string,
  givenUpQuestion?: string,
): Promise<SessionOutcome> {
  const id = (result.status === "blocked" ? undefined : result.sessionId) ?? continuing;
  const eventSessionId = id ?? assignedSessionId;
  let disputes: SessionDispute[] | undefined;
  let isDisputed = false;
  if (eventSessionId !== undefined) {
    try {
      const ledger = await openLedger(ledgerPath);
      try {
        if ("denied" in result && result.denied && result.denied.length > 0 && request) {
          let active: ActiveSeal[] = [];
          const checkRefs = [
            request.base,
            request.sessionId ? await resolveSessionBranch(request.workspace, request.sessionId) : undefined,
            "HEAD",
          ].filter((c): c is string => typeof c === "string" && c.length > 0);
          for (const c of checkRefs) {
            try {
              const found = activeSeals({ cwd: request.workspace, commit: c });
              if (found.length > 0) {
                active = found;
                break;
              }
            } catch {}
          }
          if (active.length > 0) {
            for (const denied of result.denied) {
              const targetPaths = (denied.kind === "bash" || denied.kind === "powershell")
                ? commandPathAccesses(denied.detail).map((a) => a.path)
                : [denied.detail];
              const matchedPaths: string[] = [];
              let matchedBranch: string | undefined;
              for (const tp of targetPaths) {
                for (const s of active) {
                  const m = findSealedPathMatch(request.workspace, tp, s.seal.sealed_paths);
                  if (m !== undefined) {
                    if (!matchedPaths.includes(m)) matchedPaths.push(m);
                    matchedBranch ??= s.seal.branch;
                  }
                }
              }
              if (matchedPaths.length > 0) {
                ledger.recordSealEvent({
                  sessionId: eventSessionId,
                  creator: eventSessionId,
                  specialist: request.specialist ?? null,
                  branch: matchedBranch ?? active[0]?.seal.branch ?? (request.base ?? "main"),
                  kind: "tamper_attempted",
                  paths: matchedPaths,
                  detail: { tool: denied.kind, detail: denied.detail, rule: denied.rule },
                });
              }
            }
          }
        }
        if (id !== undefined) {
          const rows = ledger.db
            .prepare(
              `WITH RECURSIVE session_tree(id) AS (
                SELECT ?
                UNION ALL
                SELECT s.id FROM sessions s JOIN session_tree st ON s.parent_session_id = st.id
              )
              SELECT id, session_id, kind, paths, detail FROM seal_events
              WHERE session_id IN (SELECT id FROM session_tree)
                AND kind IN ('dispute filed', 'dispute escalated', 'dispute upheld', 'dispute rejected')
              ORDER BY id ASC`,
            )
            .all(id) as Array<{ id: number; session_id: string; kind: string; paths: string; detail: string | null }>;
          if (rows.length > 0) {
            const list: SessionDispute[] = [];
            const latestByTest = new Map<string, SessionDispute>();
            for (const r of rows) {
              let parsed: any = {};
              if (r.detail) {
                try {
                  parsed = JSON.parse(r.detail);
                } catch {}
              }
              const file = String(parsed.file ?? r.paths);
              const describe = Array.isArray(parsed.describe) ? parsed.describe.map(String) : [];
              const name = String(parsed.name ?? "");
              const reason = String(parsed.reason ?? "");
              const evidence = String(parsed.evidence ?? "");
              const normFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
              const key = `${normFile}::${describe.join(" > ")}::${name}`;

              if (r.kind === "dispute filed") {
                const entry: SessionDispute = {
                  test: { file, describe, name },
                  reason,
                  evidence,
                  status: "open",
                };
                latestByTest.set(key, entry);
                list.push(entry);
              } else if (r.kind === "dispute escalated") {
                const existing = latestByTest.get(key);
                if (existing) {
                  existing.status = "escalated";
                } else {
                  const entry: SessionDispute = {
                    test: { file, describe, name },
                    reason,
                    evidence,
                    status: "escalated",
                  };
                  latestByTest.set(key, entry);
                  list.push(entry);
                }
              } else if (r.kind === "dispute upheld") {
                const existing = latestByTest.get(key);
                if (existing) {
                  existing.status = "upheld";
                } else {
                  const entry: SessionDispute = {
                    test: { file, describe, name },
                    reason,
                    evidence,
                    status: "upheld",
                  };
                  latestByTest.set(key, entry);
                  list.push(entry);
                }
              } else if (r.kind === "dispute rejected") {
                const existing = latestByTest.get(key);
                if (existing) {
                  existing.status = "rejected";
                } else {
                  const entry: SessionDispute = {
                    test: { file, describe, name },
                    reason,
                    evidence,
                    status: "rejected",
                  };
                  latestByTest.set(key, entry);
                  list.push(entry);
                }
              }
            }
            if (list.length > 0) {
              disputes = list;
            }
          }
          const taskRows = ledger.db
            .prepare(
              `WITH RECURSIVE session_tree(id) AS (
                SELECT ?
                UNION ALL
                SELECT s.id FROM sessions s JOIN session_tree st ON s.parent_session_id = st.id
              )
              SELECT t.state FROM tasks t JOIN sessions s ON s.task_id = t.id
              WHERE s.id IN (SELECT id FROM session_tree)`,
            )
            .all(id) as Array<{ state: string | null }>;
          if (taskRows.some((r) => r.state === "disputed")) {
            isDisputed = true;
          }
        }
      } finally {
        ledger.close();
      }
    } catch {}
  }

  const record = (result.status === "ok" || result.status === "error") ? result.containment : undefined;

  // A call that did not finish still names its branch, its commits and its note: the work is there to find.
  const found = {
    ...workFields(work),
    ...(result.status !== "ok" && result.skippedExtensions !== undefined ? { skipped_extensions: result.skippedExtensions } : {}),
    ...(disputes && disputes.length > 0 ? { disputes } : {}),
  };
  if (result.status === "blocked") return { outcome: "blocked", reason: result.reason, ...(continuing !== undefined ? { sessionId: continuing } : {}), ...found };
  if (result.status === "error" && !isDisputed) {
    return {
      outcome: "error",
      message: result.message,
      ...(id !== undefined ? { sessionId: id } : {}),
      ...(record !== undefined ? { containment: record.used } : {}),
      ...(record?.runtime !== undefined ? { runtime: record.runtime } : {}),
      ...found,
      ...(result.denied && result.denied.length > 0 ? { denied: result.denied } : {}),
    };
  }
  // On a branch of its own, git says what is on it. Writing in place, the commits are the ones the session made through `commit`.
  const commits = work.branch !== undefined ? (work.commits ?? []) : (id !== undefined ? await commitsOf(ledgerPath, id) : []);
  if (givenUpQuestion !== undefined) {
    return {
      outcome: "needs_answer",
      question: givenUpQuestion,
      sessionId: id ?? assignedSessionId,
      ...(record !== undefined ? { containment: record.used } : {}),
      ...(record?.runtime !== undefined ? { runtime: record.runtime } : {}),
      ...(work.branch !== undefined ? { branch: work.branch } : {}),
      ...(commits.length > 0 ? { commits } : {}),
      ...(work.inPlace === true ? { write_in_place: true as const } : {}),
      ...(work.note !== undefined ? { note: work.note } : {}),
      ...(result.skippedExtensions !== undefined && result.skippedExtensions.length > 0 ? { skipped_extensions: result.skippedExtensions } : {}),
      ...(result.denied && result.denied.length > 0 ? { denied: result.denied } : {}),
      ...(disputes && disputes.length > 0 ? { disputes } : {}),
    };
  }
  const answer = result.status === "ok" ? (result.text ?? "") : (result.status === "error" ? result.message : "");
  const base = {
    answer,
    ...(record !== undefined ? { containment: record.used } : {}),
    ...(record?.runtime !== undefined ? { runtime: record.runtime } : {}),
    ...(work.branch !== undefined ? { branch: work.branch } : {}),
    ...(commits.length > 0 ? { commits } : {}),
    ...(work.inPlace === true ? { write_in_place: true as const } : {}),
    ...(work.note !== undefined ? { note: work.note } : {}),
    ...(result.skippedExtensions !== undefined && result.skippedExtensions.length > 0 ? { skipped_extensions: result.skippedExtensions } : {}),
    ...(result.denied && result.denied.length > 0 ? { denied: result.denied } : {}),
    ...(disputes && disputes.length > 0 ? { disputes } : {}),
  };
  if (isDisputed) {
    return {
      outcome: "disputed",
      ...(id !== undefined ? { sessionId: id } : {}),
      ...base,
    };
  }
  if (result.status !== "ok") {
    return {
      outcome: "error",
      message: (result as any).message ?? "unexpected status",
      ...(record !== undefined ? { containment: record.used } : {}),
      ...(record?.runtime !== undefined ? { runtime: record.runtime } : {}),
      ...found,
    };
  }
  return {
    outcome: "ok",
    sessionId: result.sessionId,
    ...base,
  };
}

async function commitsOf(ledgerPath: string, sessionId: string): Promise<Array<{ sha: string; subject: string }>> {
  try {
    const ledger = await openLedger(ledgerPath);
    try {
      return ledger.commits(sessionId).map((c) => ({ sha: c.sha, subject: c.subject }));
    } finally {
      ledger.close();
    }
  } catch {
    return [];
  }
}
