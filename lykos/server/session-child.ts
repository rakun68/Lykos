/**
 * One server session, in its own process (P5 #35): `lykos server-session`, spawned by the engine server with an
 * IPC channel. A process per session keeps each session's module-level registries (skill and specialist names, the
 * commands extensions registered) its own, and a crash in one session from taking the others down.
 *
 * It runs the ordinary interactive session (`runInteractiveStandaloneSession`) on the append-only surface, with
 * three seams swapped: lines come from the server, approvals and questions are asked over the server, and what the
 * surface would print becomes protocol events (`event-ui.ts`).
 */
import { TerminalApprovalGate } from "../gate/approval.js";
import { resolveProject } from "../session/identity.js";
import type { InteractionMode } from "../gate/modes.js";
import { resolveApprovalGate } from "../session/session.js";
import type { InteractiveHandle, LineSource } from "../session/interactive.js";
import { TerminalAsk, type AskRequest } from "../tools/ask.js";
import { slashCandidates } from "../tui/commands.js";
import type { AsideAnswer } from "../session/aside.js";
import type { SessionOptions } from "../session/session-options.js";
import { createEventUi } from "./event-ui.js";
import type { EventData, RequestData, SessionStatus } from "./protocol.js";

/** What the server sends a session child. */
export type ToChild =
  | { kind: "start"; params: ChildStartParams }
  | { kind: "prompt"; text: string }
  | { kind: "interrupt" }
  | { kind: "answer"; requestId: string; answer: string }
  | { kind: "aside"; id: string; text: string }
  | { kind: "options"; id: string }
  | { kind: "close" };

/** What a session child sends the server. */
export type FromChild =
  | { kind: "event"; data: EventData }
  | { kind: "status"; status: SessionStatus; ledgerSessionId?: string; model?: string }
  | { kind: "aside"; id: string; answer?: string; model?: string; error?: string }
  | { kind: "options"; id: string; options?: SessionOptions; error?: string }
  | { kind: "exit"; ok: boolean; message?: string; ledgerSessionId?: string };

export interface ChildStartParams {
  cwd: string;
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

  push(line: string): void {
    const w = this.waiting.shift();
    if (w) w(line);
    else this.lines.push(line);
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
function approvalOptions(req: { kind: string; pathAsk?: { protected?: boolean } }): RequestData["options"] {
  if ((req.kind === "bash" && req.pathAsk !== undefined) || req.pathAsk?.protected) {
    return [
      { value: "y", label: req.pathAsk?.protected ? "Allow for this session" : "Allow once" },
      { value: "n", label: "Deny" },
    ];
  }
  return [
    { value: "y", label: "Allow once" },
    { value: "a", label: `Always allow ${req.kind} this session` },
    { value: "f", label: "Allow this folder" },
    { value: "n", label: "Deny" },
  ];
}

export async function runSessionChild(send: (msg: FromChild) => void, receive: (fn: (msg: ToChild) => void) => void): Promise<number> {
  const params = await new Promise<ChildStartParams>((resolve) => {
    receive((msg) => {
      if (msg.kind === "start") resolve(msg.params);
    });
  });
  const lines = new QueuedLines();
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

  /** Opens a request: the event goes out, and the next read waits for its answer. */
  const open = (data: Omit<RequestData, "requestId">): void => {
    current = `r${++requestSeq}`;
    emit({ type: "request", request: { requestId: current, ...data } });
    status("waiting");
  };
  const answer = (): Promise<string | null> => {
    const id = current;
    if (id === undefined) return Promise.resolve(null);
    const settle = (value: string | null): string | null => {
      emit({ type: "request.resolved", requestId: id, answer: value ?? "" });
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
          ...(req.pathAsk !== undefined ? { body: `rule: ${req.pathAsk.rule}` } : {}),
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
  const result = await runInteractiveStandaloneSession({
    workspace: params.cwd,
    ...(params.model !== undefined ? { model: params.model } : {}),
    ...(params.mode !== undefined ? { mode: params.mode } : {}),
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
    },
  });
  if (result.status === "error") {
    send({ kind: "exit", ok: false, message: result.message });
    return 1;
  }
  send({ kind: "exit", ok: true, ledgerSessionId: result.sessionId });
  return 0;
}
