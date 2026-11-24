/**
 * One server session, in its own process (P5 #35): `lykos server-session`, spawned by the engine server with an
 * IPC channel. A process per session keeps each session's module-level registries (skill and specialist names, the
 * commands extensions registered) its own, and a crash in one session from taking the others down.
 *
 * It runs the ordinary interactive session (`runInteractiveStandaloneSession`) on the append-only surface, with
 * three seams swapped: lines come from the server, approvals and questions are asked over the server, and what the
 * surface would print becomes protocol events (`event-ui.ts`).
 */
import { readFileSync } from "node:fs";
import { createTwoFilesPatch } from "diff";
import { folderOfPath, TerminalApprovalGate, type ApprovalRequest } from "../gate/approval.js";
import { resolveProject } from "../session/identity.js";
import type { InteractionMode } from "../gate/modes.js";
import { resolveApprovalGate } from "../session/session.js";
import type { InteractiveHandle, LaunchResult, LineSource, ResumePlan, ResumeRunner } from "../session/interactive.js";
import { defaultLedgerPath } from "../ledger/ledger.js";
import { TerminalAsk, type AskRequest } from "../tools/ask.js";
import { slashCandidates } from "../surface/commands.js";
import type { AsideAnswer } from "../session/aside.js";
import type { SessionOptions } from "../session/session-options.js";
import { createEventUi } from "./event-ui.js";
import { TranscriptEvents } from "./transcript-events.js";
import type { ResumePreflight } from "../session/resume-preflight.js";
import type { EventData, JobLogResult, RequestData, SessionStatus } from "./protocol.js";
import type { JobRegistry } from "../tools/job-runner.js";

/** What the server sends a session child. */
export type ToChild =
  | { kind: "start"; params: ChildStartParams }
  | { kind: "prompt"; text: string }
  | { kind: "interrupt" }
  | { kind: "answer"; requestId: string; answer: string }
  | { kind: "aside"; id: string; text: string }
  | { kind: "options"; id: string }
  /** P5 #48: a job's log, a job's stop, or the running shell calls to the background. */
  | { kind: "job"; id: string; op: "logs" | "stop" | "background"; jobId?: string; offset?: number }
  | { kind: "close" };

/** What a session child sends the server. */
export type FromChild =
  | { kind: "event"; data: EventData }
  | { kind: "status"; status: SessionStatus; ledgerSessionId?: string; model?: string }
  | { kind: "aside"; id: string; answer?: string; model?: string; error?: string }
  | { kind: "options"; id: string; options?: SessionOptions; error?: string }
  | { kind: "job"; id: string; result?: unknown; error?: string }
  | { kind: "exit"; ok: boolean; message?: string; ledgerSessionId?: string };

export interface ChildStartParams {
  cwd: string;
  /** The ledger the session writes: the project's, also for a Lykos worktree (`history.ts`'s `ledgerFor`). */
  ledgerPath?: string;
  /** P5 #42: a ledger session to resume, as `lykos resume` does, or to fork with `fork`. */
  resume?: string;
  fork?: boolean;
  model?: string;
  mode?: InteractionMode;
  autoApprove?: boolean;
  trustSource: "stored" | "flag" | "prompt";
}

/** A line source the server feeds. */
class QueuedLines implements LineSource {
  private readonly lines: string[] = [];
  private readonly waiting: Array<(line: string | null) => void> = [];
  private closed = false;

  /** P5 #42: a prompt put back in the input box (a rewind or an undo) goes to the client's prompt. */
  constructor(private readonly onPrefill: (text: string) => void) {}

  prefill(text: string): void {
    this.onPrefill(text);
  }

  push(line: string): void {
    const w = this.waiting.shift();
    if (w) w(line);
    else this.lines.push(line);
  }

  /** Set once the child can open requests: a secret is asked as a request the client masks. */
  secret: (() => Promise<string | null>) | undefined;

  nextSecret(): Promise<string | null> {
    return this.secret !== undefined ? this.secret() : this.next();
  }

  next(): Promise<string | null> {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  close(): void {
    this.closed = true;
    while (this.waiting.length > 0) this.waiting.shift()!(null);
  }
}

/** The approval decisions `TerminalApprovalGate` reads, per request shape; the gate's own prompt lists the same. */
function approvalOptions(req: { kind: string; detail: string; pathAsk?: { protected?: boolean } }): RequestData["options"] {
  if ((req.kind === "bash" && req.pathAsk !== undefined) || req.pathAsk?.protected) {
    return [
      { value: "y", label: req.pathAsk?.protected ? "Allow for this session" : "Allow once" },
      { value: "n", label: "Deny" },
    ];
  }
  return [
    { value: "y", label: "Allow once" },
    { value: "a", label: `Always allow ${req.kind} this session`, note: `This will allow every ${req.kind} for the rest of this session.` },
    { value: "f", label: "Allow this folder", note: `This will allow every ${req.kind} in ${folderOfPath(req.detail)} for this project.` },
    { value: "n", label: "Deny" },
  ];
}

/**
 * P5 #46: what an approval shows besides its title (OpenCode `routes/session/permission.tsx` `EditBody`): a write or
 * an edit as a diff of the file on disk against what it would hold, anything else with its body.
 */
function approvalBody(req: ApprovalRequest): Pick<RequestData, "body" | "patch"> {
  const rule = req.pathAsk !== undefined ? `rule: ${req.pathAsk.rule}` : undefined;
  if ((req.kind === "write" || req.kind === "edit") && req.body !== undefined) {
    let before = "";
    try {
      before = readFileSync(req.detail, "utf8");
    } catch {
      // A new file: everything in it is added.
    }
    const patch = createTwoFilesPatch(req.detail, req.detail, before, req.body, undefined, undefined, { context: 3 });
    return { patch, ...(rule !== undefined ? { body: rule } : {}) };
  }
  const body = [req.body, rule].filter((s) => s !== undefined).join("\n");
  return body.length > 0 ? { body } : {};
}

/** P5 #48: the composer's calls on a session's jobs: a log window, a stop (the process tree), or the move to the background. */
export async function answerJobCall(jobs: JobRegistry | undefined, msg: Extract<ToChild, { kind: "job" }>): Promise<unknown> {
  if (jobs === undefined) throw new Error("the session has not started");
  if (msg.op === "background") return { jobs: jobs.backgroundAll().map((j) => j.id) };
  const id = msg.jobId ?? "";
  if (jobs.get(id) === undefined) throw new Error(`no job ${id}`);
  if (msg.op === "stop") {
    const record = await jobs.stop(id, "stopped by the user");
    return { status: record?.status };
  }
  const offset = msg.offset;
  const window = offset !== undefined ? jobs.logs(id, { offset }) : jobs.logs(id, { lines: 10_000 });
  return { text: window?.text ?? "", nextOffset: window?.nextOffset ?? 0, size: window?.size ?? 0 } satisfies JobLogResult;
}

/** P5 #48: the jobs event, whole, on every change to a session's jobs, batched to one per tick. */
export function watchJobs(jobs: JobRegistry, emit: (data: EventData) => void): void {
  let queued = false;
  jobs.watch(() => {
    if (queued) return;
    queued = true;
    setImmediate(() => {
      queued = false;
      emit({
        type: "jobs",
        jobs: jobs.list().map((j) => ({ id: j.id, command: j.command, status: j.status, startedAt: j.startedAt, ...(j.exitCode !== undefined ? { exitCode: j.exitCode } : {}) })),
        foreground: jobs.foregroundShells().map((f) => ({ id: f.id, command: f.command })),
      });
    });
  });
}

export async function runSessionChild(
  send: (msg: FromChild) => void,
  receive: (fn: (msg: ToChild) => void) => void,
  runResume: ResumeRunner,
): Promise<number> {
  const params = await new Promise<ChildStartParams>((resolve) => {
    receive((msg) => {
      if (msg.kind === "start") resolve(msg.params);
    });
  });
  const lines = new QueuedLines((text) => emit({ type: "prompt.set", text }));
  const answers = new Map<string, (answer: string | null) => void>();
  const early = new Map<string, string>();
  let handle: InteractiveHandle | undefined;
  let requestSeq = 0;
  let current: string | undefined;
  let aside: ((question: string) => Promise<AsideAnswer>) | undefined;
  let options: (() => SessionOptions) | undefined;
  const emit = (data: EventData): void => send({ kind: "event", data });
  const status = (s: SessionStatus): void => send({ kind: "status", status: s });

  receive((msg) => {
    switch (msg.kind) {
      case "prompt":
        lines.push(msg.text);
        break;
      case "interrupt":
        handle?.interrupt();
        break;
      case "answer": {
        const resolve = answers.get(msg.requestId);
        if (resolve) {
          answers.delete(msg.requestId);
          resolve(msg.answer);
        } else early.set(msg.requestId, msg.answer);
        break;
      }
      case "aside": {
        const id = msg.id;
        if (aside === undefined) {
          send({ kind: "aside", id, error: "the session has not started" });
          break;
        }
        aside(msg.text).then(
          (a) => send({ kind: "aside", id, answer: a.answer, model: a.model }),
          (err: unknown) => send({ kind: "aside", id, error: err instanceof Error ? err.message : String(err) }),
        );
        break;
      }
      case "options":
        if (options === undefined) send({ kind: "options", id: msg.id, error: "the session has not started" });
        else {
          try {
            send({ kind: "options", id: msg.id, options: options() });
          } catch (err) {
            send({ kind: "options", id: msg.id, error: err instanceof Error ? err.message : String(err) });
          }
        }
        break;
      case "job":
        void jobCall(msg).then(
          (result) => send({ kind: "job", id: msg.id, result }),
          (err: unknown) => send({ kind: "job", id: msg.id, error: err instanceof Error ? err.message : String(err) }),
        );
        break;
      case "close":
        lines.close();
        for (const resolve of answers.values()) resolve(null);
        answers.clear();
        handle?.interrupt();
        break;
      default:
        break;
    }
  });

  const jobCall = (msg: Extract<ToChild, { kind: "job" }>): Promise<unknown> => answerJobCall(handle?.jobs, msg);

  /** Opens a request: the event goes out, and the next read waits for its answer. */
  const open = (data: Omit<RequestData, "requestId">): void => {
    current = `r${++requestSeq}`;
    emit({ type: "request", request: { requestId: current, ...data } });
    status("waiting");
  };
  const answer = (secret = false): Promise<string | null> => {
    const id = current;
    if (id === undefined) return Promise.resolve(null);
    const settle = (value: string | null): string | null => {
      emit({ type: "request.resolved", requestId: id, answer: secret ? "" : (value ?? "") });
      status("running");
      return value;
    };
    const ready = early.get(id);
    if (ready !== undefined) {
      early.delete(id);
      return Promise.resolve(settle(ready));
    }
    return new Promise((resolve) => answers.set(id, (v) => resolve(settle(v))));
  };
  const silent = { write: (): boolean => true };
  // `/login <provider> --api-key` asks for the key here. `/login` runs only while the session is idle, so it is idle
  // again once the key is in.
  lines.secret = async () => {
    open({ kind: "question", title: "API key", detail: "The key itself, $VAR to read an environment variable, or !command to run one.", options: [], secret: true });
    const key = await answer(true);
    status("idle");
    return key;
  };

  const gate = resolveApprovalGate({
    autoApprove: params.autoApprove === true,
    interactiveGate: new TerminalApprovalGate(
      answer,
      silent,
      (req) =>
        open({
          kind: "approval",
          title: `${req.kind}: ${req.summary}`,
          detail: req.detail,
          ...approvalBody(req),
          options: approvalOptions(req),
        }),
      { projectId: resolveProject(params.cwd).id, cwd: params.cwd },
    ),
  });
  const ask = new TerminalAsk(answer, silent, (req: AskRequest) =>
    open({
      kind: "question",
      title: req.question,
      detail: "",
      options: req.options.map((o, i) => ({ value: String(i + 1), label: o })),
      assumption: req.assumption,
    }),
  ).ask;

  const { runInteractiveStandaloneSession } = await import("../session/interactive.js");
  const ledgerPath = params.ledgerPath;
  /** One process of the session on the server's seams: a new session, or the plan a resume made. */
  const launch = async (input: { model?: string | undefined; resume?: ResumePlan }): Promise<LaunchResult> => {
    const result = await runInteractiveStandaloneSession({
      workspace: params.cwd,
      ...(ledgerPath !== undefined ? { ledgerPath } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      interactionModes: true,
      ...(input.resume?.tools !== undefined ? { tools: input.resume.tools } : {}),
      ...(input.resume !== undefined ? { resume: input.resume } : {}),
      trustSource: params.trustSource,
      lineSource: lines,
      approvalGate: gate,
      askHuman: ask,
      createUi: (opts, session, askAside, listOptions) => {
        aside = askAside;
        options = listOptions;
        send({ kind: "status", status: "idle", ledgerSessionId: session.sessionId, model: opts.header.model });
        // The surface registered this session's skills and extension commands before it made the UI.
        emit({ type: "commands", commands: slashCandidates("/skill:").map((c) => ({ name: c.name, description: c.description, source: c.source })) });
        return createEventUi(opts, session, { emit, status });
      },
      onReady: (h) => {
        handle = h;
        if (h.jobs !== undefined) watchJobs(h.jobs, emit);
      },
    });
    return result.status === "ok"
      ? {
          status: "ok",
          sessionId: result.sessionId,
          ...(result.forkRequested ? { forkRequested: true } : {}),
          ...(result.rewindRebuild !== undefined ? { rewindRebuild: result.rewindRebuild } : {}),
        }
      : { status: "error", message: result.message };
  };
  /** P5 #42: `lykos resume` on these seams: the preflight's agreement is a question to the client. */
  const resume = async (id: string, opts: { fork?: boolean; inputText?: string; show?: boolean }): Promise<number> => {
    let refusal: string | undefined;
    const code = await runResume(params.cwd, ledgerPath ?? defaultLedgerPath(params.cwd), id, {
      ...(opts.fork === true ? { fork: true } : {}),
      // A session opened from the list shows its conversation so far; a fork or a rewind in this process already has.
      ...(opts.show === true
        ? {
            onPreflight: (pre: ResumePreflight) => {
              const events = new TranscriptEvents(emit);
              for (const r of pre.branch?.records ?? []) events.record(r);
              events.endTurn();
            },
          }
        : {}),
      ...(opts.inputText !== undefined ? { inputText: opts.inputText } : {}),
      confirm: async (preflight) => {
        open({ kind: "question", title: "Resume this session?", detail: preflight, options: [{ value: "y", label: "Resume" }, { value: "n", label: "Cancel" }] });
        return (await answer()) === "y";
      },
      onRefusal: (reason) => {
        refusal = reason;
      },
      launch: (input) => launch({ model: input.model, resume: input.resume }),
    });
    if (code !== 0) send({ kind: "exit", ok: false, message: refusal ?? "the session could not be resumed" });
    return code;
  };

  try {
    return await run();
  } catch (err) {
    // A session that throws while it boots still ends with a reason the client is shown.
    send({ kind: "exit", ok: false, message: err instanceof Error ? err.message : String(err) });
    return 1;
  }

  async function run(): Promise<number> {
    if (params.resume !== undefined) {
      const code = await resume(params.resume, { ...(params.fork === true ? { fork: true } : {}), show: true });
      if (code === 0) send({ kind: "exit", ok: true });
      return code;
    }
    const result = await launch(params.model !== undefined ? { model: params.model } : {});
    if (result.status === "error") {
      send({ kind: "exit", ok: false, message: result.message ?? "the session ended in error" });
      return 1;
    }
    // `/fork` and a rewind past this process continue as `lykos run` continues them, through a resume.
    let code = 0;
    if (result.forkRequested === true && result.sessionId !== undefined) code = await resume(result.sessionId, { fork: true });
    else if (result.rewindRebuild !== undefined && result.sessionId !== undefined) {
      code = await resume(result.sessionId, { inputText: result.rewindRebuild.inputText });
    }
    if (code === 0) send({ kind: "exit", ok: true, ...(result.sessionId !== undefined ? { ledgerSessionId: result.sessionId } : {}) });
    return code;
  }
}
