/**
 * The local engine server's protocol (P5 ticket #35, ADR-0064 decisions 1–3). Newline-delimited JSON over a named
 * pipe (Windows) or a Unix socket (Linux). The reference is `docs/reference/engine-server.md`; this file is its
 * source of truth for field names, and the Rust client (`crates/client`) mirrors it.
 */

import type { KeybindSetting } from "../config/keybinds.js";
import type { CacheGaugeEntry } from "../surface/cache-gauge.js";
import type { Alert, OutcomeView, TokenCounters } from "../surface/types.js";
import type { ContextBreakdown } from "../session/context-breakdown.js";
import type { ProviderEntry } from "../config/provider-catalog.js";
import type { ProviderModel } from "../session/provider-models.js";
export type { ModelOption, ProviderOption, SessionOptions, SpecialistOption } from "../session/session-options.js";

/** Bumped on any change a client of the previous version would misread. A client of another version is refused. */
export const PROTOCOL_VERSION = 1;

// --- The handshake -----------------------------------------------------------------------------------------------

/** First line a client sends. `nonce` is 32 random bytes, hex. */
export interface Hello {
  type: "hello";
  protocol: number;
  client: string;
  nonce: string;
}

/** The server proves it holds the user's key before the client proves it: a squatter on the pipe name learns nothing. */
export interface Challenge {
  type: "challenge";
  nonce: string;
  /** HMAC-SHA256(key, "server:" + client nonce), hex. */
  proof: string;
}

export interface Auth {
  type: "auth";
  /** HMAC-SHA256(key, "client:" + server nonce), hex. */
  proof: string;
}

export interface Welcome {
  type: "welcome";
  protocol: number;
  server: string;
  pid: number;
  /** The server's code changed on disk since it started: it serves an older build until every client has gone. */
  stale?: boolean;
}

export interface Refused {
  type: "refused";
  reason: "protocol" | "auth";
  message: string;
  server?: number;
  client?: number;
}

// --- Requests and responses --------------------------------------------------------------------------------------

export interface Request {
  id: number;
  method: Method;
  params?: Record<string, unknown>;
}

export type Response = { id: number; result: unknown } | { id: number; error: { message: string } };

export type Method =
  | "server.info"
  | "server.shutdown"
  /** Closes every other connection: how a client's reconnect is tested, and how a stuck client is let go. */
  | "server.disconnect"
  | "sessions.list"
  | "session.start"
  | "session.prompt"
  | "session.interrupt"
  | "session.answer"
  | "session.close"
  /** A side question (`/btw`): one answer from the session's context, with no tools, kept out of the conversation. */
  | "session.aside"
  /** `lykos-tui`'s key bindings for a workspace, each with the layer that set it (P5 #39). */
  | "config.keybinds"
  /** Every provider `/connect` offers, `{ cwd }`: a `ProvidersResult`. Needs no session. */
  | "providers.list"
  /** A custom provider into a config file, `{ cwd, scope: "global" | "project", id, api, baseUrl, models }`: `{ path }`. */
  | "provider.add"
  /** An API key into a provider's credential pool, `{ provider, key }`: `{ message }`. The key is never sent back. */
  | "credential.add"
  /** A sign-in with no session, `{ provider, apiKey? }`: `{ login }`, the id the three below take. */
  | "provider.login"
  /** What a new session would offer, `{ cwd, model? }`: `{ efforts, specialists }`, for the lists before one runs. */
  | "session.preview"
  /** `{ login }`: `{ lines, ask?: { prompt, secret }, done?: { ok } }`. A finished sign-in is forgotten once read. */
  | "provider.login.status"
  /** The answer to the question a sign-in waits on, `{ login, answer }`. */
  | "provider.login.answer"
  /** Ends a sign-in, `{ login }`. */
  | "provider.login.cancel"
  | "credentials.list"
  | "skills.list"
  | "credential.remove"
  /** Every model a provider offers, `{ cwd, provider }`: a `ProviderModelsResult`. Needs no session. */
  | "provider.models"
  /** A model into a declared provider's `models:` in the config file that declares it, `{ cwd, provider, model }`: `{ path }`. */
  | "provider.model.add"
  | "session.options"
  /** P5 #42: the ledger's sessions for the session list, and which are live here. */
  | "sessions.history"
  | "session.rename"
  /** OpenCode's delete, as an archive: the session stays in `lykos session --all`, resumable. */
  | "session.archive"
  | "session.export"
  | "session.move"
  | "worktree.list"
  | "worktree.create"
  | "worktree.remove"
  /** P5 #46: the workspace's changes for the diff viewer, `{ cwd, mode: "branch" | "committed" | "working" }`. */
  | "vcs.diff"
  /** P5 #48: a background job's log, `{ sessionId, jobId, offset? }`: a `JobLogResult`. */
  | "session.job.logs"
  /** P5 #48: stops a background job and its process tree, `{ sessionId, jobId }`. */
  | "session.job.stop"
  /** P5 #48: moves the session's running shell calls to the background (OpenCode's `session.background`). */
  | "session.background"
  /**
   * P5 #51: `{ cwd, id }`: a live session that shows an MCP or `lykos run` session of the project. A prompt to it
   * steers the session as `lykos steer` does, an interrupt stops it as `lykos stop` does; its owner keeps running it.
   */
  | "session.watch"
  | "subscribe";

// --- Events ------------------------------------------------------------------------------------------------------

export type SessionStatus = "starting" | "idle" | "running" | "waiting" | "closed";

/** What the TUI shows about a live session; the `session.status` event's data. */
export interface SessionSummary {
  id: string;
  cwd: string;
  status: SessionStatus;
  model: string;
  title: string | null;
  startedAt: string;
  /** "tui" for a client's session; "mcp" and "run" for a delegated session it watches (`session.watch`). */
  origin: string;
  /** The ledger's session id once the session has booted: what `lykos sessions` and resume name. */
  ledgerSessionId: string | null;
}

/** P5 #51: a delegated session of the project that runs now: `sessions.history`'s `delegated`, by ledger id. */
export interface DelegatedInfo {
  owner: "run" | "mcp";
  state: "running" | "waiting";
  startedAt: string;
  specialist: string | null;
}

/** The status line's numbers, read from Pi and the ledger as the old TUI's HUD reads them (`deriveHud`). */
export interface UsageData {
  model: string | null;
  effort: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  /** The system prompt and tool schemas, estimated at 4 characters a token: what the context holds before a message. */
  headTokens: number | null;
  runUsd: number | null;
  todayUsd: number | null;
  cacheHitRatio: number | null;
  calls: number;
  /** P5 #53: the old footer's counters: fresh input, cache read, cache write, output, reasoning. */
  tokens: TokenCounters;
  /** P5 #53: the provider-backed cache reading of the model in use, or null before one. */
  cache: CacheGaugeEntry | null;
  /** P5 #53: the HUD's warnings, as the old footer's badge and alert panel list them. */
  alerts: Alert[];
  /** P5 #53: the session's recorded outcome; `verified` only from a verification command or a human. */
  outcome: OutcomeView | null;
}

export interface RequestData {
  requestId: string;
  kind: "approval" | "question";
  title: string;
  detail: string;
  body?: string;
  /** P5 #46: a write's or an edit's change, as a unified diff of the file on disk against the content proposed. */
  patch?: string;
  /**
   * For an approval: decisions; for a question: labels. Empty for a free-text question. `note` says what a decision
   * keeps allowing, for a client to show while it is picked (OpenCode's `permissionAlwaysLines`).
   */
  options: { value: string; label: string; note?: string }[];
  /** A question's stated assumption, used when nobody answers. */
  assumption?: string;
  /** A typed answer that is a secret (an API key): shown masked, kept out of history, never sent back in an event. */
  secret?: boolean;
}

export type EventData =
  | { type: "session.status"; session: SessionSummary }
  | { type: "message.user"; text: string }
  | { type: "message.followup"; text: string }
  | { type: "message.delta"; text: string }
  | { type: "message.end" }
  | { type: "thinking.delta"; text: string }
  | { type: "tool.start"; toolId: string; name: string; summary: string; args: unknown }
  | { type: "tool.end"; toolId: string; name: string; ok: boolean; preview?: string; diff?: DiffData }
  | { type: "turn.end" }
  | { type: "system"; text: string }
  /** A slash command's answer: the TUI shows it in a popup (one line: a toast), out of the conversation. `/context` carries its parts. */
  | { type: "report"; command: string; text: string; context?: ContextBreakdown }
  | { type: "usage"; usage: UsageData }
  | { type: "request"; request: RequestData }
  | { type: "request.resolved"; requestId: string; answer: string }
  /** The slash commands the session runs, sent once it has booted: what a client completes `/` from. */
  | { type: "commands"; commands: CommandInfo[] }
  /** P5 #42: what goes in the client's prompt: the prompt a rewind or an undo took back. */
  | { type: "prompt.set"; text: string }
  /** P5 #48: the session's background jobs and running shell calls, whole, whenever one starts or ends. */
  | { type: "jobs"; jobs: JobInfo[]; foreground: ForegroundInfo[] };

/** P5 #48: one background job, as the composer's Shell list shows it. */
export interface JobInfo {
  id: string;
  command: string;
  status: "running" | "exited" | "stopped" | "capped" | "failed";
  startedAt: string;
  exitCode?: number | null;
}

/** P5 #48: a shell call holding the turn, which `session.background` would move. */
export interface ForegroundInfo {
  id: string;
  command: string;
}

/** P5 #48: what `session.job.logs` answers: the log from `offset` (the whole log's last 40,000 bytes without one). */
export interface JobLogResult {
  text: string;
  nextOffset: number;
  size: number;
}

export interface CommandInfo {
  /** As typed, with its slash. */
  name: string;
  description: string;
  /** "builtin", "skill", "extension" or "pi-extension". */
  source: string;
}

/** What `config.keybinds` answers: only what a config layer sets; the client holds the defaults. */
export interface ProvidersResult {
  providers: ProviderEntry[];
}

export interface ProviderModelsResult {
  models: ProviderModel[];
}

export interface KeybindsResult {
  keybinds: Record<string, KeybindSetting>;
  /** #58 item 9: `tui.colors`, each role from the last layer that sets it. */
  colors: Record<string, { value: string; source: string }>;
  /** #58 item 10: what a new session in this workspace starts with, so a client shows it before one runs. */
  defaults?: SessionDefaults;
}

/** The model, effort and specialist a new session starts with, as its boot resolves them. */
export interface SessionDefaults {
  /** `provider/id`. */
  model: string;
  effort: string;
  specialist: string;
}

/** What `session.aside` answers. */
export interface AsideResult {
  answer: string;
  model: string;
}

/** One event, in order: `seq` counts from 1 per session, so a client that has seen `seq` asks for what came after. */
export interface Event {
  event: EventData["type"];
  session: string;
  seq: number;
  data: EventData;
}

/** A file change a tool made, as the old TUI's diff block holds it. */
export interface DiffData {
  path: string;
  lines: { kind: "add" | "del" | "ctx" | "hunk"; text: string }[];
}
