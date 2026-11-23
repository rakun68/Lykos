/**
 * The local engine server's protocol (P5 ticket #35, ADR-0064 decisions 1–3). Newline-delimited JSON over a named
 * pipe (Windows) or a Unix socket (Linux). The reference is `docs/reference/engine-server.md`; this file is its
 * source of truth for field names, and the Rust client (`crates/client`) mirrors it.
 */

import type { KeybindSetting } from "../config/keybinds.js";
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
  | "session.options"
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
  /** "tui" for a client's session; "mcp" and "run" for the shapes ADR-0064 decision 3 moves onto the server. */
  origin: string;
  /** The ledger's session id once the session has booted: what `lykos sessions` and resume name. */
  ledgerSessionId: string | null;
}

/** The status line's numbers, read from Pi and the ledger as the old TUI's HUD reads them (`deriveHud`). */
export interface UsageData {
  model: string | null;
  effort: string | null;
  contextTokens: number | null;
  contextWindow: number | null;
  contextPercent: number | null;
  runUsd: number | null;
  todayUsd: number | null;
  cacheHitRatio: number | null;
  calls: number;
}

export interface RequestData {
  requestId: string;
  kind: "approval" | "question";
  title: string;
  detail: string;
  body?: string;
  /** For an approval: decisions; for a question: labels. Empty for a free-text question. */
  options: { value: string; label: string }[];
  /** A question's stated assumption, used when nobody answers. */
  assumption?: string;
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
  | { type: "usage"; usage: UsageData }
  | { type: "request"; request: RequestData }
  | { type: "request.resolved"; requestId: string; answer: string }
  /** The slash commands the session runs, sent once it has booted: what a client completes `/` from. */
  | { type: "commands"; commands: CommandInfo[] };

export interface CommandInfo {
  /** As typed, with its slash. */
  name: string;
  description: string;
  /** "builtin", "skill", "extension" or "pi-extension". */
  source: string;
}

/** What `config.keybinds` answers: only what a config layer sets; the client holds the defaults. */
export interface KeybindsResult {
  keybinds: Record<string, KeybindSetting>;
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
