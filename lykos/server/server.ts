/**
 * The local engine server (P5 #35, ADR-0064 decisions 1–2): `lykos serve`.
 *
 * A router. Clients connect on the user's pipe or socket, prove the key, then send requests and subscribe to
 * events. Each session runs in a `lykos server-session` child (`session-child.ts`); the server numbers its events
 * per session and keeps every one, so a client that reconnects asks for what came after the last it saw.
 *
 * It exits after `tui.server_idle_seconds` once no client is connected and no session runs (`0`: at once). A session
 * runs while it is starting, running a turn, or waiting on an answer; an idle session left open is closed at exit,
 * and like every session it stays archived and resumable.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, rmSync, type WriteStream } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { resolve as resolvePath } from "node:path";
import { defaultChildCommand, type ChildCommand } from "../delegate/session-process.js";
import { ensureWorkspaceTrust, WorkspaceTrustError } from "../gate/trust.js";
import type { InteractionMode } from "../gate/modes.js";
import { engineAddress, ensureEngineDir, readOrCreateKey, type EngineAddress } from "./address.js";
import type { ChildStartParams, FromChild, ToChild } from "./session-child.js";
import { PROTOCOL_VERSION, type AsideResult, type Event, type EventData, type Method, type Request, type Response, type SessionStatus, type SessionSummary } from "./protocol.js";
import { LineReader, send, serverHandshake } from "./wire.js";

export interface EngineServerOptions {
  address?: EngineAddress;
  idleSeconds: number;
  /** How long to wait for the first client before the idle rule applies. Default 30 s; tests shorten it. */
  firstClientMs?: number;
  /** How a session child is started; tests start a scripted one. */
  child?: ChildCommand;
  /** Extra environment for session children, over this process's. */
  env?: NodeJS.ProcessEnv;
  /** Where the server's own lines go. Default: the run directory's `engine.log`. */
  log?: (line: string) => void;
  /** How a session start decides trust. Default: `ensureWorkspaceTrust`, never prompting. Tests pass their own. */
  trust?: (cwd: string, trustFlag: boolean) => Promise<ChildStartParams["trustSource"]>;
  /** Called once the server has stopped listening and every child has exited. */
  onExit?: (reason: string) => void;
}

interface LiveSession {
  summary: SessionSummary;
  child: ChildProcess;
  events: Event[];
  exited: Promise<void>;
  /** `session.aside` calls waiting on the child, by id. */
  asides: Map<string, (msg: Extract<FromChild, { kind: "aside" }>) => void>;
}

interface Client {
  socket: Socket;
  name: string;
  /** null: not subscribed. A set: the sessions it follows. "all": every session, including later ones. */
  follows: Set<string> | "all" | null;
}

const CHILD_EXIT_GRACE_MS = 10_000;
/** How long a server waits for its first client: the client that started it allows 20 s for it to listen. */
const FIRST_CLIENT_MS = 30_000;

export class EngineServer {
  readonly address: EngineAddress;
  private readonly key: Buffer;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly clients = new Set<Client>();
  private asideSeq = 0;
  /** Every open connection, authenticated or not: stop() must close them all, or server.close() never returns. */
  private readonly sockets = new Set<Socket>();
  private server: Server | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private stopping: Promise<void> | undefined;
  private resolveExited: (reason: string) => void = () => {};
  /** Resolves with the reason once the server has stopped. */
  readonly exited: Promise<string> = new Promise((resolve) => (this.resolveExited = resolve));
  private readonly startedAt = new Date().toISOString();
  private everConnected = false;
  private readonly logStream: WriteStream | undefined;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: EngineServerOptions) {
    this.address = opts.address ?? engineAddress();
    ensureEngineDir(this.address.dir);
    this.key = readOrCreateKey(this.address);
    if (opts.log) this.log = opts.log;
    else {
      this.logStream = createWriteStream(this.address.logPath, { flags: "a", mode: 0o600 });
      this.log = (line) => this.logStream?.write(`${new Date().toISOString()} ${line}\n`);
    }
  }

  /** Listens. Fails with EADDRINUSE when another server holds the address. */
  async listen(): Promise<void> {
    if (process.platform !== "win32" && existsSync(this.address.path)) {
      // A socket file outlives a server that was killed. One that still answers is a live server: leave it.
      if (await answers(this.address.path)) throw Object.assign(new Error(`an engine server already listens on ${this.address.path}`), { code: "EADDRINUSE" });
      rmSync(this.address.path, { force: true });
    }
    const server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      void this.accept(socket);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.address.path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.log(`listening on ${this.address.path}, protocol ${PROTOCOL_VERSION}, pid ${process.pid}, idle ${this.opts.idleSeconds}s`);
    this.checkIdle();
  }

  private async accept(socket: Socket): Promise<void> {
    socket.on("error", () => {});
    const reader = new LineReader(socket);
    const hs = await serverHandshake(socket, reader, this.key, `lykos ${process.pid}`);
    if (!hs.ok) {
      this.log(`refused a client: ${hs.reason}`);
      socket.end();
      setTimeout(() => socket.destroy(), 1000).unref();
      return;
    }
    if (this.stopping) {
      socket.destroy();
      return;
    }
    const client: Client = { socket, name: hs.client, follows: null };
    this.clients.add(client);
    this.everConnected = true;
    this.checkIdle();
    socket.on("close", () => {
      this.clients.delete(client);
      this.checkIdle();
    });
    reader.listen((value) => void this.handle(client, value));
  }

  private async handle(client: Client, value: unknown): Promise<void> {
    const req = value as Partial<Request>;
    if (typeof req !== "object" || req === null || typeof req.id !== "number" || typeof req.method !== "string") {
      send(client.socket, { id: -1, error: { message: "a request is {id, method, params}" } });
      return;
    }
    const id = req.id;
    let response: Response;
    try {
      response = { id, result: await this.call(client, req.method as Method, req.params ?? {}) };
    } catch (err) {
      response = { id, error: { message: err instanceof Error ? err.message : String(err) } };
    }
    send(client.socket, response);
  }

  private session(params: Record<string, unknown>): LiveSession {
    const id = params.session;
    const s = typeof id === "string" ? this.sessions.get(id) : undefined;
    if (!s) throw new Error(`no session ${String(id)}`);
    return s;
  }

  private async call(client: Client, method: Method, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "server.info":
        return { protocol: PROTOCOL_VERSION, pid: process.pid, startedAt: this.startedAt, idleSeconds: this.opts.idleSeconds, clients: this.clients.size, sessions: this.sessions.size };
      case "server.shutdown":
        setImmediate(() => void this.stop("shutdown requested"));
        return { stopping: true };
      case "server.disconnect": {
        let closed = 0;
        for (const c of this.clients) {
          if (c === client) continue;
          c.socket.destroy();
          closed++;
        }
        return { closed };
      }
      case "sessions.list":
        return [...this.sessions.values()].map((s) => s.summary);
      case "session.start":
        return this.start(params);
      case "session.prompt": {
        if (typeof params.text !== "string" || params.text === "") throw new Error("session.prompt needs text");
        this.toChild(this.session(params), { kind: "prompt", text: params.text });
        return { ok: true };
      }
      case "session.interrupt":
        this.toChild(this.session(params), { kind: "interrupt" });
        return { ok: true };
      case "session.answer": {
        if (typeof params.requestId !== "string" || typeof params.answer !== "string") throw new Error("session.answer needs requestId and answer");
        this.toChild(this.session(params), { kind: "answer", requestId: params.requestId, answer: params.answer });
        return { ok: true };
      }
      case "session.aside": {
        if (typeof params.text !== "string" || params.text.trim() === "") throw new Error("session.aside needs text");
        const s = this.session(params);
        if (s.summary.status === "starting" || s.summary.status === "closed") throw new Error(`the session is ${s.summary.status}`);
        const id = `a${++this.asideSeq}`;
        const reply = await new Promise<Extract<FromChild, { kind: "aside" }>>((resolve) => {
          s.asides.set(id, resolve);
          this.toChild(s, { kind: "aside", id, text: params.text as string });
        });
        s.asides.delete(id);
        if (reply.error !== undefined) throw new Error(reply.error);
        return { answer: reply.answer ?? "", model: reply.model ?? s.summary.model } satisfies AsideResult;
      }
      case "session.close": {
        const s = this.session(params);
        this.toChild(s, { kind: "close" });
        return { ok: true };
      }
      case "subscribe":
        return this.subscribe(client, params);
      default:
        throw new Error(`unknown method ${String(method)}`);
    }
  }

  private async start(params: Record<string, unknown>): Promise<SessionSummary> {
    if (this.stopping) throw new Error("the server is stopping");
    if (typeof params.cwd !== "string" || params.cwd === "") throw new Error("session.start needs cwd");
    const cwd = resolvePath(params.cwd);
    let trustSource: ChildStartParams["trustSource"];
    try {
      trustSource = this.opts.trust
        ? await this.opts.trust(cwd, params.trust === true)
        : (await ensureWorkspaceTrust({ workspace: cwd, trustWorkspace: params.trust === true, interactive: false })).source;
    } catch (err) {
      if (err instanceof WorkspaceTrustError) throw new Error(`untrusted workspace: ${err.message}. Start it with trust: true to trust it for this session.`);
      throw err;
    }
    const id = randomUUID();
    const command = this.opts.child ?? defaultChildCommand();
    const child = spawn(command.command, [...command.args, "server-session"], {
      cwd,
      env: { ...process.env, ...this.opts.env, LYKOS_TRUST_SOURCE: trustSource },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    const tag = id.slice(0, 8);
    const logLines = (chunk: Buffer): void => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) if (line.trim() !== "") this.log(`[${tag}] ${line}`);
    };
    child.stdout?.on("data", logLines);
    child.stderr?.on("data", logLines);
    const summary: SessionSummary = {
      id,
      cwd,
      status: "starting",
      model: typeof params.model === "string" ? params.model : "",
      title: null,
      startedAt: new Date().toISOString(),
      origin: typeof params.origin === "string" ? params.origin : "tui",
      ledgerSessionId: null,
    };
    const live: LiveSession = {
      summary,
      child,
      events: [],
      exited: new Promise((resolve) => child.once("exit", () => resolve())),
      asides: new Map(),
    };
    this.sessions.set(id, live);
    child.on("message", (msg: FromChild) => this.fromChild(live, msg));
    child.once("exit", (code) => {
      this.log(`[${tag}] exited ${String(code)}`);
      if (live.summary.status !== "closed") this.setStatus(live, "closed");
      for (const settle of live.asides.values()) settle({ kind: "aside", id: "", error: "the session ended" });
      live.asides.clear();
      this.sessions.delete(id);
      this.checkIdle();
    });
    this.log(`[${tag}] started in ${cwd}, pid ${String(child.pid)}`);
    this.emit(live, { type: "session.status", session: { ...summary } });
    const start: ChildStartParams = {
      cwd,
      trustSource,
      ...(typeof params.model === "string" ? { model: params.model } : {}),
      ...(typeof params.mode === "string" ? { mode: params.mode as InteractionMode } : {}),
      ...(params.autoApprove === true ? { autoApprove: true } : {}),
    };
    this.toChild(live, { kind: "start", params: start });
    this.checkIdle();
    return summary;
  }

  private toChild(s: LiveSession, msg: ToChild): void {
    if (s.child.connected) s.child.send(msg);
  }

  private fromChild(s: LiveSession, msg: FromChild): void {
    switch (msg.kind) {
      case "event":
        if (msg.data.type === "message.user" && s.summary.title === null) {
          s.summary.title = msg.data.text.split("\n")[0]!.slice(0, 80);
          this.emit(s, msg.data);
          this.emit(s, { type: "session.status", session: { ...s.summary } });
          return;
        }
        this.emit(s, msg.data);
        return;
      case "status":
        if (msg.ledgerSessionId !== undefined) s.summary.ledgerSessionId = msg.ledgerSessionId;
        if (msg.model !== undefined) s.summary.model = msg.model;
        this.setStatus(s, msg.status);
        return;
      case "aside":
        s.asides.get(msg.id)?.(msg);
        return;
      case "exit":
        if (!msg.ok) this.emit(s, { type: "system", text: `the session could not start: ${msg.message ?? "unknown error"}` });
        this.setStatus(s, "closed");
        return;
      default:
        return;
    }
  }

  private setStatus(s: LiveSession, status: SessionStatus): void {
    s.summary.status = status;
    this.emit(s, { type: "session.status", session: { ...s.summary } });
    this.checkIdle();
  }

  private emit(s: LiveSession, data: EventData): void {
    const event: Event = { event: data.type, session: s.summary.id, seq: s.events.length + 1, data };
    s.events.push(event);
    for (const c of this.clients) {
      if (c.follows === "all" || c.follows?.has(event.session)) send(c.socket, event);
    }
  }

  /**
   * `{sessions?: string[], after?: {[session]: seq}}`. Replays what each session emitted after the given seq, then
   * streams. Without `sessions` it follows every session, and every one started later.
   */
  private subscribe(client: Client, params: Record<string, unknown>): { sessions: SessionSummary[] } {
    const wanted = Array.isArray(params.sessions) ? new Set(params.sessions.filter((v): v is string => typeof v === "string")) : "all";
    const after = typeof params.after === "object" && params.after !== null ? (params.after as Record<string, unknown>) : {};
    // The response goes first so the client knows the subscription took. The replay follows it, read when it is
    // sent, and only then does the client follow live events: an event emitted in between is in the replay, never
    // ahead of it (a live event before the replay would leave the client with a gap it never fills).
    setImmediate(() => {
      for (const s of this.sessions.values()) {
        if (wanted !== "all" && !wanted.has(s.summary.id)) continue;
        const from = typeof after[s.summary.id] === "number" ? (after[s.summary.id] as number) : 0;
        for (const e of s.events.slice(from)) send(client.socket, e);
      }
      client.follows = wanted;
    });
    return { sessions: [...this.sessions.values()].filter((s) => wanted === "all" || wanted.has(s.summary.id)).map((s) => s.summary) };
  }

  private busy(): boolean {
    for (const s of this.sessions.values()) {
      if (s.summary.status === "starting" || s.summary.status === "running" || s.summary.status === "waiting") return true;
    }
    return false;
  }

  private checkIdle(): void {
    if (this.stopping || !this.server) return;
    if (this.clients.size > 0 || this.busy()) {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
      return;
    }
    if (this.idleTimer) return;
    // Before its first client the idle time is not the clock: the client that started this server has not connected
    // yet, and with `0` it would find it gone. A server nobody connects to still exits.
    if (!this.everConnected) {
      const wait = Math.max(this.opts.firstClientMs ?? FIRST_CLIENT_MS, this.opts.idleSeconds * 1000);
      this.idleTimer = setTimeout(() => void this.stop(`no client within ${wait / 1000}s of starting`), wait);
      return;
    }
    const ms = this.opts.idleSeconds * 1000;
    this.idleTimer = setTimeout(() => void this.stop(`idle for ${this.opts.idleSeconds}s`), ms);
  }

  /** Stops listening, closes every session, waits for the children, then reports. */
  stop(reason: string): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.log(`stopping: ${reason}`);
      // close() waits for every open connection, so the clients are told to go first; one that does not is dropped.
      const closed = new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
      for (const socket of this.sockets) {
        socket.end();
        setTimeout(() => socket.destroy(), 1000).unref();
      }
      await closed;
      const exits = [...this.sessions.values()].map((s) => {
        this.toChild(s, { kind: "close" });
        const timer = setTimeout(() => s.child.kill(), CHILD_EXIT_GRACE_MS);
        return s.exited.then(() => clearTimeout(timer));
      });
      await Promise.all(exits);
      this.log("stopped");
      await new Promise<void>((resolve) => (this.logStream ? this.logStream.end(() => resolve()) : resolve()));
      this.opts.onExit?.(reason);
      this.resolveExited(reason);
    })();
    return this.stopping;
  }
}

/** Whether something accepts connections at `path`. */
function answers(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}
