// The wire between `lykos mcp` (the parent) and the `lykos session-child` it
// starts for each call (ADR-0036, ADR-0038). docs/reference/mcp.md is the
// contract; this file is the one place it is written in code, so the parent and
// the child cannot disagree about it.
//
// Framing: one JSON object per line (JSON Lines), UTF-8, "\n"-terminated.
//   parent -> child, on stdin:  exactly one `request` line.
//   child -> parent, on stdout: any number of `progress` lines, then exactly
//                               one `result` line, then the child exits.
// Nothing else is written to the child's stdout. Diagnostics go to stderr.

import type { InteractionMode } from "../gate/modes.js";
import type { CommitSummary } from "../git/worktree.js";
import type { TrustSource } from "../gate/trust.js";
import type { DeniedAction } from "../gate/delegated.js";

export const PROTOCOL_VERSION = 1;

/** What a delegated session runs in when nothing names a mode: it writes, on a branch of its own. */
export const DEFAULT_DELEGATED_MODE: InteractionMode = "auto";

/** The one place a tool names its interaction mode: all MCP tools map to auto. */
const TOOL_MODES: Readonly<Record<string, InteractionMode>> = {
  lykos_implement: "auto",
  lykos_refactor: "auto",
  lykos_debug: "auto",
  lykos_review: "auto",
};

export function modeOfTool(tool: string): InteractionMode {
  return TOOL_MODES[tool] ?? DEFAULT_DELEGATED_MODE;
}

const TOOL_SPECIALISTS: Readonly<Record<string, string>> = {
  lykos_review: "review",
};

export function specialistOfTool(tool: string): string | undefined {
  return TOOL_SPECIALISTS[tool];
}

export type ContainmentChoice = "off" | "auto" | "required";

/** What one MCP call asks a session to do. */
export interface SessionRequest {
  version: typeof PROTOCOL_VERSION;
  /** The MCP tool, kept for the session's label and the ledger. */
  tool: string;
  workspace: string;
  /** The framed brief the session receives as its first message. */
  prompt: string;
  label: string;
  model?: string;
  /** Per-run USD cap, the tool's `budget`. */
  budgetUsd?: number;
  /** The caller's containment choice: the highest layer, under the floor. */
  containment?: ContainmentChoice;
  /** Continue this session instead of starting one. */
  sessionId?: string;
  /** For a new session, the ID minted by the server (T220). */
  newSessionId?: string;
  /** The caller opted in to writing in its own tree. */
  writeInPlace?: boolean;
  /**
   * The interaction mode the session runs in, and the one input that decides whether it writes (T184, story 49):
   * `auto` for the tools that change code, `ask` for a review. Absent, the tool decides the same way.
   */
  mode?: InteractionMode;
  /** The specialist to run, or the default for the tool / branch. */
  specialist?: string;
  /** The starting branch for a new worktree. Ignored when continuing a session (sessionId). */
  base?: string;
}

export type { CommitSummary } from "../git/worktree.js";

export type SealStatus = "none" | "created" | "intact" | "tampered" | "tamper_attempted";

export interface SessionSealReport {
  status: SealStatus;
  paths?: string[];
  contained?: boolean;
  attempts?: Array<{ tool: string; detail: string; paths: string[] }>;
  disputes?: SessionDispute[];
}

export interface SessionVerification {
  command: string | null;
  exit: number | null;
  outcome: "passed" | "failed" | "unverified";
  output_tail: string;
}

export interface DiffStat {
  files_changed: number;
  insertions: number;
  deletions: number;
}

export type NextToken =
  | "review_or_accept"
  | "inspect_flags"
  | "inspect_seal"
  | "answer_question"
  | "resolve_test_dispute"
  | "continue_with_failure"
  | "run_verification"
  | "fix_environment";

export type ResultFlagKind = "OUT-OF-SCOPE" | "MISREPORT";

export interface SessionFlag {
  flag: ResultFlagKind;
  detail: string;
  files?: string[];
}

export interface SessionDispute {
  test: {
    file: string;
    describe: string[];
    name: string;
  };
  reason: string;
  evidence: string;
  status: string;
}

/** What a call returns. `sessionId` is present on every `ok` and whenever a session got far enough to have one. */
export type SessionOutcome =
  | {
      outcome: "ok";
      answer?: string;
      answer_is_self_report?: boolean;
      sessionId: string;
      next?: NextToken;
      flags?: SessionFlag[];
      verification?: SessionVerification;
      diff_stat?: DiffStat;
      /** The containment level the session actually used. */
      containment?: ContainmentChoice;
      /** `docker` or `podman`, when commands ran in a container. */
      runtime?: string;
      /** The branch the work is on, when it is not the caller's own. */
      branch?: string;
      /** Commits on that branch, or, writing in place, the ones the session made through `commit`. */
      commits?: CommitSummary[];
      /** The session wrote in the caller's own tree. */
      write_in_place?: true;
      /** What the caller should know about where the work is: what writing in place gave up, or work that was saved. */
      note?: string;
      /** Project-local extensions that were not loaded because the project is not trusted. */
      skipped_extensions?: string[];
      /** Actions denied by the gate (T213, ADR-0041). Omitted when empty. */
      denied?: DeniedAction[];
      seal?: SessionSealReport;
      disputes?: SessionDispute[];
      refusals?: string[];
    }
  | {
      outcome: "unverified";
      answer?: string;
      answer_is_self_report?: boolean;
      sessionId: string;
      next?: NextToken;
      flags?: SessionFlag[];
      verification?: SessionVerification;
      diff_stat?: DiffStat;
      containment?: ContainmentChoice;
      runtime?: string;
      branch?: string;
      commits?: CommitSummary[];
      write_in_place?: true;
      note?: string;
      skipped_extensions?: string[];
      denied?: DeniedAction[];
      seal?: SessionSealReport;
      disputes?: SessionDispute[];
      refusals?: string[];
    }
  | {
      outcome: "disputed";
      answer?: string;
      answer_is_self_report?: boolean;
      sessionId?: string;
      next?: NextToken;
      flags?: SessionFlag[];
      verification?: SessionVerification;
      diff_stat?: DiffStat;
      containment?: ContainmentChoice;
      runtime?: string;
      branch?: string;
      commits?: CommitSummary[];
      write_in_place?: true;
      note?: string;
      skipped_extensions?: string[];
      denied?: DeniedAction[];
      seal?: SessionSealReport;
      disputes?: SessionDispute[];
    }
  | {
      outcome: "blocked";
      reason: string;
      next?: NextToken;
      verification?: SessionVerification;
      diff_stat?: DiffStat;
      sessionId?: string;
      branch?: string;
      commits?: CommitSummary[];
      write_in_place?: true;
      note?: string;
      skipped_extensions?: string[];
      seal?: SessionSealReport;
      disputes?: SessionDispute[];
    }
  | {
      outcome: "error";
      message: string;
      answer?: string;
      answer_is_self_report?: boolean;
      next?: NextToken;
      flags?: SessionFlag[];
      verification?: SessionVerification;
      diff_stat?: DiffStat;
      sessionId?: string;
      containment?: ContainmentChoice;
      runtime?: string;
      branch?: string;
      commits?: CommitSummary[];
      write_in_place?: true;
      note?: string;
      skipped_extensions?: string[];
      denied?: DeniedAction[];
      seal?: SessionSealReport;
      disputes?: SessionDispute[];
      refusals?: string[];
    }
  | NeedsAnswerOutcome;

export interface NeedsAnswerOutcome {
  outcome: "needs_answer";
  question: string;
  sessionId?: string;
  containment?: ContainmentChoice;
  runtime?: string;
  branch?: string;
  commits?: CommitSummary[];
  write_in_place?: true;
  note?: string;
  skipped_extensions?: string[];
  denied?: DeniedAction[];
  disputes?: SessionDispute[];
  next?: NextToken;
}

export interface QuestionFrame {
  type: "question";
  question: string;
}

export type Frame =
  | { type: "progress"; message: string }
  | { type: "result"; result: SessionOutcome }
  | QuestionFrame;

export const ASK_TIMEOUT_NOTICE = "lykos: coordinator ask timed out; decide alone: proceed with what you have or give_up";

export interface SessionRunInput {
  request: SessionRequest;
  /** How the parent established trust. The child may only treat it as a claim (see session-child.ts). */
  trustSource: TrustSource;
  /** Report liveness or a milestone; the server turns each call into an MCP progress notification. */
  onProgress: (message: string) => void;
  /** Aborts the session when the MCP client cancels the call or goes away. */
  signal: AbortSignal;
  /** T223: called once the session can take a steering message. */
  onSteerable?: (steer: (message: string) => void | Promise<void>) => void;
  /** T224: called when the child asks a question via ask_coordinator. */
  onQuestion?: (question: string) => void;
}

/** The seam: runs one session and reports its outcome. Production starts a process; tests pass a stand-in. */
export type SessionRunner = (input: SessionRunInput) => Promise<SessionOutcome>;

export function encodeFrame(frame: Frame | SessionRequest): string {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Splits a byte stream into frames. A line that is not a frame is returned in
 * `stray` rather than dropped, so the parent can tell a child that printed
 * something it should not have from one that said nothing.
 */
export class FrameReader {
  private buffer = "";

  push(chunk: string): { frames: Frame[]; stray: string[] } {
    this.buffer += chunk;
    return this.drain(false);
  }

  /** Whatever is left once the stream has ended (a final line with no newline). */
  end(): { frames: Frame[]; stray: string[] } {
    return this.drain(true);
  }

  private drain(final: boolean): { frames: Frame[]; stray: string[] } {
    const frames: Frame[] = [];
    const stray: string[] = [];
    const lines = this.buffer.split("\n");
    this.buffer = final ? "" : (lines.pop() ?? "");
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "");
      if (line.trim().length === 0) continue;
      const frame = parseFrame(line);
      if (frame === undefined) stray.push(line);
      else frames.push(frame);
    }
    return { frames, stray };
  }
}

export function parseFrame(line: string): Frame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { type?: unknown; message?: unknown; result?: unknown; question?: unknown };
  if (v.type === "progress" && typeof v.message === "string") return { type: "progress", message: v.message };
  if (v.type === "question" && typeof v.question === "string") return { type: "question", question: v.question };
  if (v.type === "result" && typeof v.result === "object" && v.result !== null) {
    const outcome = (v.result as { outcome?: unknown }).outcome;
    if (
      outcome === "ok" ||
      outcome === "blocked" ||
      outcome === "error" ||
      outcome === "disputed" ||
      outcome === "unverified" ||
      outcome === "needs_answer"
    ) {
      return { type: "result", result: v.result as SessionOutcome };
    }
  }
  return undefined;
}

export function parseRequest(line: string): SessionRequest | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Partial<SessionRequest>;
  if (v.version !== PROTOCOL_VERSION) return undefined;
  if (v.newSessionId !== undefined && typeof v.newSessionId !== "string") return undefined;
  if (typeof v.workspace !== "string" || typeof v.prompt !== "string" || typeof v.tool !== "string" || typeof v.label !== "string") return undefined;
  return v as SessionRequest;
}
