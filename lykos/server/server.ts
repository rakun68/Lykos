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
 *
 * An MCP or `lykos run` session runs in the process that owns it; `session.watch` shows one as a session here
 * (`watch.ts`, P5 #51).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, existsSync, rmSync, statSync, type WriteStream } from "node:fs";
import { homedir } from "node:os";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { tuiColors, tuiKeybinds } from "../config/keybinds.js";
import { sessionDefaults } from "../session/session-options.js";
import { globalConfigPath, loadConfig, projectConfigPath } from "../config/load.js";
import { providerCatalog } from "../config/provider-catalog.js";
import { baseUrlProblem, CUSTOM_PROVIDER_APIS, modelIds, providerIdProblem, writeProviderToConfig } from "../config/provider-add.js";
import { BUILTIN_PROVIDERS, PI_NATIVE_PROVIDERS } from "../config/provider-table.js";
import { defaultCredentialDbPath } from "../credentials/db.js";
import { addToPool } from "../credentials/login-flow.js";
import { poolSummary, summaryPoolSizes } from "../credentials/presence.js";
import { defaultChildCommand, type ChildCommand } from "../delegate/session-process.js";
import { isWithinRoot } from "../gate/approval.js";
import { ensureWorkspaceTrust, WorkspaceTrustError } from "../gate/trust.js";
import type { InteractionMode } from "../gate/modes.js";
import { workspaceDiff, type DiffMode } from "../git/diff.js";
import { createNamedWorktree, listNamedWorktrees, removeNamedWorktree } from "../git/worktree.js";
import { resolveProject } from "../session/identity.js";
import { archiveHistorySession, exportHistorySession, historyRows, ledgerFor, projectRoot, renameHistorySession } from "./history.js";
import { engineAddress, ensureEngineDir, readOrCreateKey, type EngineAddress } from "./address.js";
import type { ChildStartParams, FromChild, ToChild } from "./session-child.js";
import type { DelegatedWatch } from "./watch.js";
import { PROTOCOL_VERSION, type AsideResult, type Event, type KeybindsResult, type ProvidersResult, type EventData, type SessionOptions, type Method, type Request, type Response, type SessionStatus, type SessionSummary } from "./protocol.js";
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
  /** The global config directory `config.keybinds` reads. Default `~/.lykos`; tests pass their own. */
  globalDir?: string;
  /** The project registry `sessions.history` with `all` reads. Default `~/.lykos/projects.json`; tests pass their own. */
  registryPath?: string;
  /** Where `worktree.create` makes worktrees. Default `~/.lykos/worktrees`; tests pass their own. */
  worktreesRoot?: string;
  /** Called once the server has stopped listening and every child has exited. */
  onExit?: (reason: string) => void;
}

interface LiveSession {
  summary: SessionSummary;
  /** Its `lykos server-session` child, or the watch of a delegated session. */
  child: ChildProcess | DelegatedWatch;
  events: Event[];
  exited: Promise<void>;
  /** The ledger the session writes, fixed when it starts: a later `session.cd` moves its cwd, never its ledger. */
  ledgerPath: string;
  /** `session.aside` and `session.options` calls waiting on the child, by id. */
  asides: Map<string, (msg: Extract<FromChild, { kind: "aside" | "options" | "job" }>) => void>;
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

/** When this module's file was last written: a rebuild changes it under a server that keeps running the old one. */
function builtAt(): number {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtimeMs;
  } catch {
    return 0;
  }
}
const STARTED_BUILD = builtAt();

export class EngineServer {
  readonly address: EngineAddress;
  private readonly key: Buffer;
  private readonly sessions = new Map<string, LiveSession>();
  private readonly clients = new Set<Client>();
  private asideSeq = 0;
  /** Ledger sessions a `session.start` is resuming, until its child is live: one ledger row runs in one child. */
  private readonly resuming = new Set<string>();
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
    const hs = await serverHandshake(socket, reader, this.key, `lykos ${process.pid}`, builtAt() !== STARTED_BUILD);
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

  /** `loadConfig`'s `globalDir`, when this server was given one. */
  private globalOpt(): { globalDir?: string } {
    return this.opts.globalDir !== undefined ? { globalDir: this.opts.globalDir } : {};
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
      case "providers.list": {
        if (typeof params.cwd !== "string" || params.cwd === "") throw new Error("providers.list needs cwd");
        const { resolved } = loadConfig({ cwd: resolvePath(params.cwd), ...this.globalOpt() });
        const poolSizes = summaryPoolSizes(poolSummary(defaultCredentialDbPath()));
        return { providers: providerCatalog({ providers: resolved.providers, env: process.env, poolSizes }) } satisfies ProvidersResult;
      }
      case "provider.add": {
        const { cwd, scope, id, api, baseUrl, models } = params;
        if (typeof cwd !== "string" || cwd === "" || (scope !== "global" && scope !== "project")) throw new Error("provider.add needs cwd and scope");
        if (typeof id !== "string" || typeof api !== "string" || typeof baseUrl !== "string" || typeof models !== "string") throw new Error("provider.add needs id, api, baseUrl and models");
        const root = resolvePath(cwd);
        const { resolved } = loadConfig({ cwd: root, ...this.globalOpt() });
        const taken = [...Object.keys(BUILTIN_PROVIDERS), ...PI_NATIVE_PROVIDERS, ...Object.keys(resolved.providers)];
        const problem =
          providerIdProblem(id, taken) ??
          (CUSTOM_PROVIDER_APIS.some((a) => a.value === api) ? undefined : `"${api}" is not one of the API kinds offered`) ??
          baseUrlProblem(baseUrl) ??
          (modelIds(models).length === 0 ? "a provider needs at least one model id" : undefined);
        if (problem !== undefined) throw new Error(problem);
        const path = scope === "global" ? globalConfigPath(this.opts.globalDir ?? join(homedir(), ".lykos")) : projectConfigPath(root);
        writeProviderToConfig(path, { id, api, baseUrl, models: modelIds(models) });
        return { path };
      }
      case "credential.add": {
        const { provider, key } = params;
        if (typeof provider !== "string" || provider === "" || typeof key !== "string" || key.trim() === "") throw new Error("credential.add needs provider and key");
        return { message: addToPool(defaultCredentialDbPath(), provider, { type: "api_key", key: key.trim() }) };
      }
      case "config.keybinds": {
        if (typeof params.cwd !== "string" || params.cwd === "") throw new Error("config.keybinds needs cwd");
        const cwd = resolvePath(params.cwd);
        const { layers } = loadConfig({ cwd, ...this.globalOpt() });
        // A config the default specialist cannot load leaves the defaults out; the session reports its own.
        let defaults;
        try {
          defaults = sessionDefaults(cwd, this.opts.globalDir);
        } catch {
          defaults = undefined;
        }
        const result: KeybindsResult = { keybinds: tuiKeybinds(layers), colors: tuiColors(layers), ...(defaults !== undefined ? { defaults } : {}) };
        return result;
      }
      case "session.aside": {
        if (typeof params.text !== "string" || params.text.trim() === "") throw new Error("session.aside needs text");
        const s = this.session(params);
        if (s.summary.status === "starting" || s.summary.status === "closed") throw new Error(`the session is ${s.summary.status}`);
        const text = params.text;
        const reply = await this.ask(s, (id) => ({ kind: "aside", id, text }));
        if (reply.error !== undefined) throw new Error(reply.error);
        if (reply.kind !== "aside") throw new Error("the session answered something else");
        return { answer: reply.answer ?? "", model: reply.model ?? s.summary.model } satisfies AsideResult;
      }
      case "session.options": {
        const s = this.session(params);
        if (s.summary.status === "starting" || s.summary.status === "closed") throw new Error(`the session is ${s.summary.status}`);
        const reply = await this.ask(s, (id) => ({ kind: "options", id }));
        if (reply.kind !== "options" || reply.options === undefined) throw new Error(reply.error ?? "no options");
        return reply.options satisfies SessionOptions;
      }
      case "session.close": {
        const s = this.session(params);
        this.toChild(s, { kind: "close" });
        return { ok: true };
      }
      case "session.job.logs":
      case "session.job.stop":
      case "session.background": {
        const s = this.session(params);
        if (s.summary.status === "starting" || s.summary.status === "closed") throw new Error(`the session is ${s.summary.status}`);
        const op = method === "session.job.logs" ? "logs" : method === "session.job.stop" ? "stop" : "background";
        if (op !== "background" && typeof params.jobId !== "string") throw new Error(`${method} needs jobId`);
        const jobId = typeof params.jobId === "string" ? params.jobId : undefined;
        const offset = typeof params.offset === "number" ? params.offset : undefined;
        const reply = await this.ask(s, (id) => ({ kind: "job", id, op, ...(jobId !== undefined ? { jobId } : {}), ...(offset !== undefined ? { offset } : {}) }));
        if (reply.error !== undefined) throw new Error(reply.error);
        if (reply.kind !== "job") throw new Error("the session answered something else");
        return reply.result;
      }
      case "sessions.history": {
        const cwd = needCwd(params, method);
        const rows = historyRows(cwd, {
          all: params.all === true,
          archived: params.archived === true,
          ...(this.opts.registryPath !== undefined ? { registryPath: this.opts.registryPath } : {}),
        });
        const live: Record<string, string> = {};
        for (const s of this.sessions.values()) if (s.summary.ledgerSessionId !== null) live[s.summary.ledgerSessionId] = s.summary.id;
        // P5 #51: the project's MCP and `lykos run` sessions that run now. One whose ledger row is not written yet
        // still lists, from its owner row.
        const { delegatedLive } = await import("./watch.js");
        const delegated = delegatedLive(projectRoot(cwd));
        for (const [id, d] of Object.entries(delegated)) {
          if (rows.some((r) => r.id === id)) continue;
          rows.unshift({ id, title: null, startedUtc: d.startedAt, endedUtc: null, model: null, parentSessionId: null, forkedFrom: null, resumedFrom: null, depth: 0, archived: false, resumable: false, costUsd: null, projectPath: projectRoot(cwd), projectName: null });
        }
        return { rows, live, delegated };
      }
      case "session.rename": {
        const cwd = needCwd(params, method);
        const id = needString(params, "ledgerSessionId", method);
        if (typeof params.title !== "string") throw new Error("session.rename needs title");
        renameHistorySession(this.ledgerOf(cwd, id), id, params.title);
        for (const s of this.sessions.values()) {
          if (s.summary.ledgerSessionId !== id) continue;
          s.summary.title = params.title.trim();
          this.emit(s, { type: "session.status", session: { ...s.summary } });
        }
        return { ok: true };
      }
      case "session.archive": {
        const cwd = needCwd(params, method);
        const id = needString(params, "ledgerSessionId", method);
        const ledgerPath = this.ledgerOf(cwd, id);
        // A live session ends first, as OpenCode's delete of an open session does; its row is then archived.
        for (const s of [...this.sessions.values()]) {
          if (s.summary.ledgerSessionId !== id) continue;
          this.toChild(s, { kind: "close" });
          await s.exited;
        }
        archiveHistorySession(ledgerPath, id);
        return { ok: true };
      }
      case "session.export": {
        const cwd = needCwd(params, method);
        const id = needString(params, "ledgerSessionId", method);
        return exportHistorySession(this.ledgerOf(cwd, id), cwd, id, typeof params.file === "string" ? params.file : undefined);
      }
      case "session.move": {
        // OpenCode `session.move`: the session continues in another directory, a worktree of the project or another.
        const s = this.session(params);
        const cwd = needCwd(params, method);
        const id = s.summary.ledgerSessionId;
        if (id === null) throw new Error("the session has not started");
        if (s.summary.status === "running" || s.summary.status === "waiting") throw new Error(`the session is ${s.summary.status}`);
        // The target is checked before the session closes: a typo or an untrusted directory leaves it running.
        if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${cwd} is not a directory`);
        const trustSource = await this.trustOf(cwd, params.trust === true);
        this.toChild(s, { kind: "close" });
        await s.exited;
        return this.start({ cwd, resume: id, model: s.summary.model, origin: s.summary.origin }, s.ledgerPath, trustSource);
      }
      case "worktree.list": {
        const cwd = needCwd(params, method);
        const cwds = [...this.sessions.values()].map((s) => s.summary.cwd);
        return listNamedWorktrees(projectRoot(cwd)).map((w) => ({ ...w, sessions: cwds.some((c) => isWithinRoot(w.path, c)) }));
      }
      case "worktree.create": {
        const root = projectRoot(needCwd(params, method));
        const name = needString(params, "name", method);
        return createNamedWorktree({
          workspace: root,
          projectId: resolveProject(root).id,
          name,
          ...(this.opts.worktreesRoot !== undefined ? { root: this.opts.worktreesRoot } : {}),
        });
      }
      case "worktree.remove": {
        const root = projectRoot(needCwd(params, method));
        const path = resolvePath(needString(params, "path", method));
        for (const s of this.sessions.values()) {
          if (isWithinRoot(path, s.summary.cwd)) throw new Error("a session runs in that worktree; move or close it first");
        }
        return removeNamedWorktree({
          workspace: root,
          projectId: resolveProject(root).id,
          path,
          ...(this.opts.worktreesRoot !== undefined ? { root: this.opts.worktreesRoot } : {}),
        });
      }
      case "vcs.diff": {
        const mode = needString(params, "mode", method);
        if (mode !== "branch" && mode !== "committed" && mode !== "working") throw new Error(`vcs.diff: unknown mode ${mode}`);
        return workspaceDiff(needCwd(params, method), mode satisfies DiffMode);
      }
      case "session.watch":
        return this.watch(params);
      case "subscribe":
        return this.subscribe(client, params);
      default:
        throw new Error(`unknown method ${String(method)}`);
    }
  }

  /** The ledger `id` is in: a live session's own, else the one a session in `cwd` writes. */
  private ledgerOf(cwd: string, id: string): string {
    for (const s of this.sessions.values()) if (s.summary.ledgerSessionId === id) return s.ledgerPath;
    return ledgerFor(cwd);
  }

  private async trustOf(cwd: string, trust: boolean): Promise<ChildStartParams["trustSource"]> {
    try {
      return this.opts.trust ? await this.opts.trust(cwd, trust) : (await ensureWorkspaceTrust({ workspace: cwd, trustWorkspace: trust, interactive: false })).source;
    } catch (err) {
      if (err instanceof WorkspaceTrustError) throw new Error(`untrusted workspace: ${err.message}. Start it with trust: true to trust it for this session.`);
      throw err;
    }
  }

  private async start(params: Record<string, unknown>, ledgerPathOverride?: string, trusted?: ChildStartParams["trustSource"]): Promise<SessionSummary> {
    if (this.stopping) throw new Error("the server is stopping");
    if (typeof params.cwd !== "string" || params.cwd === "") throw new Error("session.start needs cwd");
    const cwd = resolvePath(params.cwd);
    const resume = typeof params.resume === "string" && params.resume !== "" && params.fork !== true ? params.resume : undefined;
    if (resume !== undefined) {
      const open = [...this.sessions.values()].find((s) => s.summary.ledgerSessionId === resume);
      if (open !== undefined || this.resuming.has(resume)) throw new Error(`session ${resume} is already open${open !== undefined ? ` (${open.summary.id})` : ""}`);
      this.resuming.add(resume);
    }
    let trustSource: ChildStartParams["trustSource"];
    try {
      trustSource = trusted ?? (await this.trustOf(cwd, params.trust === true));
    } catch (err) {
      if (resume !== undefined) this.resuming.delete(resume);
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
      // A resumed session keeps the title its history row has, so its tab is not "New session".
      title: resume === undefined ? null : resumedTitle(cwd, resume),
      startedAt: new Date().toISOString(),
      origin: typeof params.origin === "string" ? params.origin : "tui",
      ledgerSessionId: null,
    };
    const ledgerPath = ledgerPathOverride ?? ledgerFor(cwd);
    const live: LiveSession = {
      summary,
      child,
      events: [],
      exited: new Promise((resolve) => child.once("exit", () => resolve())),
      ledgerPath,
      asides: new Map(),
    };
    this.sessions.set(id, live);
    child.on("message", (msg: FromChild) => this.fromChild(live, msg));
    child.once("exit", (code) => {
      this.log(`[${tag}] exited ${String(code)}`);
      if (live.summary.status !== "closed") this.setStatus(live, "closed");
      for (const settle of live.asides.values()) settle({ kind: "aside", id: "", error: "the session ended" });
      live.asides.clear();
      if (resume !== undefined) this.resuming.delete(resume);
      this.sessions.delete(id);
      this.checkIdle();
    });
    this.log(`[${tag}] started in ${cwd}, pid ${String(child.pid)}`);
    this.emit(live, { type: "session.status", session: { ...summary } });
    const start: ChildStartParams = {
      cwd,
      trustSource,
      ledgerPath,
      ...(typeof params.resume === "string" && params.resume !== "" ? { resume: params.resume } : {}),
      ...(params.fork === true ? { fork: true } : {}),
      ...(typeof params.model === "string" ? { model: params.model } : {}),
      ...(typeof params.mode === "string" ? { mode: params.mode as InteractionMode } : {}),
      ...(params.autoApprove === true ? { autoApprove: true } : {}),
    };
    this.toChild(live, { kind: "start", params: start });
    this.checkIdle();
    return summary;
  }

  /**
   * P5 #51: a delegated session of the project as a session here. It runs in its owner; this reads its owner row
   * and transcript, and a prompt or an interrupt reaches it through the ledger as `lykos steer` and `lykos stop` do.
   */
  private async watch(params: Record<string, unknown>): Promise<SessionSummary> {
    if (this.stopping) throw new Error("the server is stopping");
    const cwd = needCwd(params, "session.watch");
    const ledgerId = needString(params, "id", "session.watch");
    const open = [...this.sessions.values()].find((s) => s.summary.ledgerSessionId === ledgerId);
    if (open !== undefined) return open.summary;
    const { DelegatedWatch, delegatedView } = await import("./watch.js");
    const root = projectRoot(cwd);
    const view = delegatedView(root, ledgerId);
    if (view === undefined) throw new Error(`no MCP or lykos run session ${ledgerId} in ${root}`);
    const id = randomUUID();
    const title = historyRows(root).find((r) => r.id === ledgerId)?.title ?? null;
    const summary: SessionSummary = { id, cwd: root, status: "starting", model: "", title, startedAt: view.started_at, origin: view.owner, ledgerSessionId: ledgerId };
    let ended: () => void = () => {};
    const tag = id.slice(0, 8);
    const watch = new DelegatedWatch({
      workspace: root,
      id: ledgerId,
      onMessage: (msg) => this.fromChild(live, msg),
      onExit: () => {
        this.log(`[${tag}] stopped watching ${ledgerId}`);
        if (live.summary.status !== "closed") this.setStatus(live, "closed");
        for (const settle of live.asides.values()) settle({ kind: "aside", id: "", error: "the session ended" });
        live.asides.clear();
        this.sessions.delete(id);
        ended();
        this.checkIdle();
      },
    });
    const live: LiveSession = { summary, child: watch, events: [], exited: new Promise((resolve) => (ended = resolve)), ledgerPath: ledgerFor(root), asides: new Map() };
    this.sessions.set(id, live);
    this.log(`[${tag}] watching ${view.owner} session ${ledgerId}`);
    this.emit(live, { type: "session.status", session: { ...summary } });
    watch.start();
    this.checkIdle();
    return live.summary;
  }

  /** Sends the child a call and waits for the reply with its id; a child that exits first settles it with an error. */
  private async ask(s: LiveSession, msg: (id: string) => ToChild): Promise<Extract<FromChild, { kind: "aside" | "options" | "job" }>> {
    const id = `a${++this.asideSeq}`;
    const reply = await new Promise<Extract<FromChild, { kind: "aside" | "options" | "job" }>>((resolve) => {
      // A child already gone never answers, and its exit has already settled the calls it had.
      if (!s.child.connected) return resolve({ kind: "aside", id, error: "the session ended" });
      s.asides.set(id, resolve);
      this.toChild(s, msg(id));
    });
    s.asides.delete(id);
    return reply;
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
        if (msg.ledgerSessionId !== undefined) {
          s.summary.ledgerSessionId = msg.ledgerSessionId;
          this.resuming.delete(msg.ledgerSessionId);
        }
        if (msg.model !== undefined) s.summary.model = msg.model;
        this.setStatus(s, msg.status);
        return;
      case "aside":
      case "options":
      case "job":
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
      // A watched session runs in its owner: watching it keeps nothing running here.
      if (s.summary.origin === "mcp" || s.summary.origin === "run") continue;
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
/** The title of the ledger session `id` resumes, or null when its history has none or cannot be read. */
function resumedTitle(cwd: string, id: string): string | null {
  try {
    return historyRows(projectRoot(cwd)).find((r) => r.id === id)?.title ?? null;
  } catch {
    return null;
  }
}

function needString(params: Record<string, unknown>, key: string, method: string): string {
  const v = params[key];
  if (typeof v !== "string" || v === "") throw new Error(`${method} needs ${key}`);
  return v;
}

function needCwd(params: Record<string, unknown>, method: string): string {
  return resolvePath(needString(params, "cwd", method));
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
