// `lykos mcp`'s tool contract: `lykos_implement`/`refactor`/`debug`/`review`.
// docs/reference/mcp.md is the contract.
//
// T181 (spec #22, ADR-0036, ADR-0038): each call runs a delegated session, an
// ordinary Lykos session, in a `lykos session-child` process of its own. This
// file holds only the MCP surface: the tool schemas and descriptions, the trust
// gate, and the mapping between a call and a `SessionRunner`. The runner is the
// seam: production starts a process (session-process.ts); tests, and P3's
// spec, pass a stand-in. Nothing here runs a session in this process, so a
// session that crashes cannot take the server down, and nothing a session
// writes can reach the MCP transport's stdout.

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { loadConfig } from "../config/load.js";
import {
  DEFAULT_SPECIALIST,
  discoverSpecialists,
  isReservedAsyncTool,
  resolveSpecialist,
  resolveSpecialistToolWinners,
  specialistToolName,
  type SpecialistLocation,
} from "../config/specialists.js";
import { baselineSummary } from "./baseline.js";
import { contextPackSummary } from "./context-pack.js";
import { judgedClaimsOf } from "./claims.js";
import { judgeSessionClaims } from "./session-claims.js";
import { CAUSES, DECISIONS, decideAt, decisionsOf, findingDecisionsOf } from "./decisions.js";
import { defaultLedgerPath, openLedgerSync, withLedgerSync, type Ledger, type SealEventRow } from "../ledger/use.js";
import { resolveProject } from "../session/identity.js";
import { readTranscript, transcriptFilePath, type TranscriptEventInput, type TranscriptEventRecord } from "../session/transcript.js";
import { activeSeals, type ActiveSeal } from "../seal/active.js";
import { sealCreate } from "../seal/create.js";
import { createTemporaryWorktree, fallbackGitIdentity, getBranchOrNull, gitExec, resolveRef } from "../seal/git.js";
import { addedLines, changeFlags, parseNameStatus, type ChangedPath } from "./result-flags.js";
import { verifySeals } from "../seal/verify.js";
import { ensureWorkspaceTrust, type TrustSource } from "../gate/trust.js";
import type { InteractionMode } from "../gate/modes.js";
import {
  admit,
  askQuestion,
  closeQuestions,
  finish,
  openQuestions,
  ownerRow,
  ownerRows,
  postSteer,
  requestStop,
  settled,
  stopRequested,
  takeInbox,
  viewOf,
  type Admission,
  type OpenQuestion,
  ownerLiveness,
  type OwnerKind,
  type SessionView,
} from "./ownership.js";
import { stderrWrite } from "../tui/io-mode.js";
import { createProcessRunner, createWarmPool, type WarmPool } from "./session-process.js";
import { rootSessionOf } from "./work-target.js";
import {
  modeOfTool,
  PROTOCOL_VERSION,
  specialistOfTool,
  type ContainmentChoice,
  type DiffStat,
  type NextToken,
  type ResultFlagKind,
  type SealStatus,
  type SessionFlag,
  type SessionOutcome,
  type SessionRequest,
  type SessionRunner,
  type SessionSealReport,
  type SessionVerification,
  ASK_TIMEOUT_NOTICE,
} from "./session-protocol.js";

export type LykosToolName = "lykos_implement" | "lykos_refactor" | "lykos_debug" | "lykos_review";

export interface ToolDef {
  name: string;
  description: string;
  framing?: string | undefined;
  specialist?: string | undefined;
  isAlias?: boolean | undefined;
  readOnly?: boolean | undefined;
}

const CONTINUE_NOTE =
  "A result carries a sessionId whenever a session was started (not when the call was refused before one); pass it back as session_id to continue that session with a follow-up brief.";
const SESSION_NOTE =
  "It runs as a Lykos session of its own, with Lykos's tools, gate, extensions and ledger. Its commands run in a container " +
  "when the containment level asks for one and a runtime is available.";
const BRANCH_NOTE =
  "It writes on a worktree and a lykos/ branch of its own, never in your tree: the result names the branch and its commits for you to review and merge, " +
  "and a continuation (session_id) adds commits to the same branch. In a folder that is not a git repository it refuses, unless write_in_place is set, " +
  "which writes in your folder with no commits.";
const READ_ONLY_NOTE =
  "Its tools are read-only (read, grep, find, ls): it cannot edit, write, run commands or commit, its mount is read-only, and it needs no worktree or git repository.";

const TOOL_DEFS: ToolDef[] = [
  {
    name: "lykos_implement",
    description: `Delegate an implementation task to a Lykos session. ${SESSION_NOTE} ${BRANCH_NOTE} ${CONTINUE_NOTE} Deprecated: use lykos_implementer or lykos_general instead.`,
    framing: "Implement the following change. Make the change in the workspace and report what you did.",
    isAlias: true,
  },
  {
    name: "lykos_refactor",
    description: `Delegate a refactoring task to a Lykos session. ${SESSION_NOTE} ${BRANCH_NOTE} ${CONTINUE_NOTE} Deprecated: use lykos_general instead.`,
    framing: "Refactor the following, preserving behavior. Make the change in the workspace and report what you did.",
    isAlias: true,
  },
  {
    name: "lykos_debug",
    description: `Delegate a diagnosis task to a Lykos session. ${SESSION_NOTE} ${BRANCH_NOTE} ${CONTINUE_NOTE} Deprecated: use lykos_general instead.`,
    framing: "Diagnose the following. Find the root cause and report it with the evidence; fix it if the brief asks.",
    isAlias: true,
  },
  {
    name: "lykos_review",
    description: `Delegate a code-review task to a Lykos session. ${SESSION_NOTE} ${READ_ONLY_NOTE} ${CONTINUE_NOTE} Deprecated: the framed alias and model input are deprecated.`,
    framing: "Review the following for correctness, simplification, and efficiency issues. Report findings; do not modify files.",
    specialist: "review",
    isAlias: true,
    readOnly: true,
  },
];

const TaskInputShape = {
  brief: z.string().min(1).describe("The task to delegate: a specific, self-contained brief."),
  constraints: z.string().optional().describe("Additional constraints, conventions, or context the session should follow."),
  model: z.string().optional().describe('Model override, e.g. "deepseek/deepseek-v4-pro". Defaults to the configured model.'),
  budget: z.number().positive().optional().describe("Per-run USD cap override for this call only."),
  max_steps: z.number().int().positive().optional().describe("Stop the session after this many model turns. Default: no cap."),
  request_id: z.string().min(1).optional().describe("Your id for this request. A retry with the same id finds the session it started instead of starting another."),
  sealed: z.array(z.string().min(1)).optional().describe("T254: test files, as they are in your tree, to seal before the model runs. They are committed over the base as the writer commit and must fail first: one that already passes ends the call with WEAK-SPEC and next answer_spec."),
  red: z.boolean().optional().describe("T254: false skips the check that the sealed tests fail; the seal records it. Default true."),
  reseal: z.string().min(1).optional().describe("T254 (R9), with session_id: the commit on the session's branch that corrects a sealed test. The branch is sealed again there before the session continues."),
  files: z.array(z.string().min(1)).optional().describe("T248: the files the task is about. A new session is given a context pack built from them: the project's rules and traps, the glossary terms the task uses, the docs naming them, their recent history and related tests, read at the base commit with absolute paths, and recorded in the ledger."),
  test: z.string().min(1).optional().describe("T248: the exact verification command the session may run; it is in the context pack."),
  containment: z
    .enum(["off", "auto", "required"])
    .optional()
    .describe(
      "Where the session's commands run. off: on this machine. auto: in a container when Docker or Podman works, else on this machine. " +
        "required: in a container, or refuse to start. A floor in the user's or project's config.containment.minimum cannot be lowered here. " +
        "Default: off.",
    ),
  session_id: z.string().min(1).optional().describe("Continue this earlier session (the sessionId of a previous result) instead of starting a new one."),
  write_in_place: z.boolean().optional().describe(
      "Opt in to the session writing in your own working tree instead of on a branch of its own. The result then has no branch to review: its changes are in your tree, and a commit it made is on your current branch. Needed to write in a folder that is not a git repository, where it writes with no commits and the result says so. Ignored by a review.",
    ),
  specialist: z.string().optional().describe("Specialist to run. lykos_implement defaults to implementer when starting from a branch with an active seal and build otherwise. An explicit specialist always wins."),
  base: z.string().optional().describe("The starting branch for a new worktree. Ignored when continuing a session (session_id). Default: HEAD."),
  scope: z.array(z.string()).optional().describe("Glob patterns for repo-relative paths the change is expected to touch. A changed file outside scope raises an OUT-OF-SCOPE flag."),
};

const StartInputShape = {
  specialist: z.string().min(1).describe("Specialist to run (required)."),
  brief: z.string().min(1).describe("The task to delegate: a specific, self-contained brief."),
  constraints: z.string().optional().describe("Additional constraints, conventions, or context the session should follow."),
  budget: z.number().positive().optional().describe("Per-run USD cap override for this call only."),
  max_steps: z.number().int().positive().optional().describe("Stop the session after this many model turns. Default: no cap."),
  request_id: z.string().min(1).optional().describe("Your id for this request. A retry with the same id finds the session it started instead of starting another."),
  sealed: z.array(z.string().min(1)).optional().describe("T254: test files, as they are in your tree, to seal before the model runs. They are committed over the base as the writer commit and must fail first: one that already passes ends the call with WEAK-SPEC and next answer_spec."),
  red: z.boolean().optional().describe("T254: false skips the check that the sealed tests fail; the seal records it. Default true."),
  reseal: z.string().min(1).optional().describe("T254 (R9), with session_id: the commit on the session's branch that corrects a sealed test. The branch is sealed again there before the session continues."),
  files: z.array(z.string().min(1)).optional().describe("T248: the files the task is about. A new session is given a context pack built from them: the project's rules and traps, the glossary terms the task uses, the docs naming them, their recent history and related tests, read at the base commit with absolute paths, and recorded in the ledger."),
  test: z.string().min(1).optional().describe("T248: the exact verification command the session may run; it is in the context pack."),
  containment: z
    .enum(["off", "auto", "required"])
    .optional()
    .describe(
      "Where the session's commands run. off: on this machine. auto: in a container when Docker or Podman works, else on this machine. " +
        "required: in a container, or refuse to start. A floor in the user's or project's config.containment.minimum cannot be lowered here. " +
        "Default: off.",
    ),
  session_id: z.string().min(1).optional().describe("Continue this earlier session instead of starting a new one."),
  write_in_place: z.boolean().optional().describe(
    "Opt in to the session writing in your own working tree instead of on a branch of its own. The result then has no branch to review: its changes are in your tree, and a commit it made is on your current branch. Needed to write in a folder that is not a git repository, where it writes with no commits and the result says so. Ignored by a review.",
  ),
  base: z.string().optional().describe("The starting branch for a new worktree. Ignored when continuing a session (session_id). Default: HEAD."),
  scope: z.array(z.string()).optional().describe("Glob patterns for repo-relative paths the change is expected to touch."),
};

const StatusInputShape = {
  session_id: z.string().min(1).optional().describe("Check status of one session."),
  session_ids: z.array(z.string().min(1)).optional().describe("Check status of several sessions."),
  wait_seconds: z.number().optional().describe("Wait up to this many seconds (clamped at 300) for sessions to finish before returning."),
  any: z.boolean().optional().describe("With wait_seconds and session_ids, return as soon as any one session finishes."),
};

const SteerInputShape = {
  session_id: z.string().min(1).describe("Session ID to steer (required)."),
  message: z.string().min(1).describe("Steering message to deliver to the running session (required)."),
};

const StopInputShape = {
  session_id: z.string().min(1).describe("Session ID to stop (required)."),
};

const DecideInputShape = {
  session_id: z.string().min(1).describe("Session ID to decide on (required)."),
  decision: z.enum(DECISIONS).describe("accept or reject its result, record that it is merged, or discard it."),
  reason: z.string().describe("Why (required)."),
  cause: z.string().optional().describe(`One of: ${CAUSES.join(", ")}.`),
  actor: z.string().optional().describe("Who decided. Default: coordinator."),
};

const SpecialistInputShape = {
  brief: z.string().min(1).describe("The task to delegate: a specific, self-contained brief."),
  constraints: z.string().optional().describe("Additional constraints, conventions, or context the session should follow."),
  budget: z.number().positive().optional().describe("Per-run USD cap override for this call only."),
  max_steps: z.number().int().positive().optional().describe("Stop the session after this many model turns. Default: no cap."),
  request_id: z.string().min(1).optional().describe("Your id for this request. A retry with the same id finds the session it started instead of starting another."),
  sealed: z.array(z.string().min(1)).optional().describe("T254: test files, as they are in your tree, to seal before the model runs. They are committed over the base as the writer commit and must fail first: one that already passes ends the call with WEAK-SPEC and next answer_spec."),
  red: z.boolean().optional().describe("T254: false skips the check that the sealed tests fail; the seal records it. Default true."),
  reseal: z.string().min(1).optional().describe("T254 (R9), with session_id: the commit on the session's branch that corrects a sealed test. The branch is sealed again there before the session continues."),
  files: z.array(z.string().min(1)).optional().describe("T248: the files the task is about. A new session is given a context pack built from them: the project's rules and traps, the glossary terms the task uses, the docs naming them, their recent history and related tests, read at the base commit with absolute paths, and recorded in the ledger."),
  test: z.string().min(1).optional().describe("T248: the exact verification command the session may run; it is in the context pack."),
  containment: z
    .enum(["off", "auto", "required"])
    .optional()
    .describe(
      "Where the session's commands run. off: on this machine. auto: in a container when Docker or Podman works, else on this machine. " +
        "required: in a container, or refuse to start. A floor in the user's or project's config.containment.minimum cannot be lowered here. " +
        "Default: off.",
    ),
  session_id: z.string().min(1).optional().describe("Continue this earlier session (the sessionId of a previous result) instead of starting one."),
  write_in_place: z.boolean().optional().describe(
      "Opt in to the session writing in your own working tree instead of on a branch of its own. The result then has no branch to review: its changes are in your tree, and a commit it made is on your current branch. Needed to write in a folder that is not a git repository, where it writes with no commits and the result says so. Ignored by a review.",
    ),
  base: z.string().optional().describe("The starting branch for a new worktree. Ignored when continuing a session (session_id). Default: HEAD."),
};

export type SessionState = "running" | "waiting" | "done" | "stopped" | "error";

interface TrackedSession {
  sessionId: string;
  workspace: string;
  specialist: string;
  request: SessionRequest;
  state: SessionState;
  startTime: number;
  endTime?: number | undefined;
  abortController: AbortController;
  stoppedReason?: "stopped: lykos_stop" | "stopped: server shutdown" | undefined;
  runnerPromise: Promise<void>;
  builtResult?: Record<string, unknown> | undefined;
  onSteer?: ((message: string) => void | Promise<void>) | undefined;
  queuedSteers: string[];
  listeners: Array<() => void>;
  /** T243/T244: polls the ledger for a stop or a steer another process asked for. */
  stopPoll?: NodeJS.Timeout | undefined;
  /** T243: the id its owner row is keyed by, and who owns it. */
  ownedId: string;
  ownerKind: OwnerKind;
  isBlocking: boolean;
  pendingQuestion?: string | undefined;
  unansweredQuestions: string[];
  askTimeoutTimer?: NodeJS.Timeout | undefined;
}

/** How often an owner reads the ledger for a stop or a steer another process asked for (T243, T244). */
const STOP_POLL_MS = 500;

type TaskInput = {
  brief: string;
  constraints?: string | undefined;
  model?: string | undefined;
  budget?: number | undefined;
  max_steps?: number | undefined;
  containment?: ContainmentChoice | undefined;
  session_id?: string | undefined;
  write_in_place?: boolean | undefined;
  specialist?: string | undefined;
  base?: string | undefined;
  scope?: string[] | undefined;
  request_id?: string | undefined;
  /** T254: the task's sealed tests, its red check, and a reseal on a continuation. */
  sealed?: string[] | undefined;
  red?: boolean | undefined;
  reseal?: string | undefined;
  /** T248: the files the task is about and its verification command; the child builds the context pack from them. */
  files?: string[] | undefined;
  test?: string | undefined;
  /** T243, `lykos run` only: the interaction mode, and the session fields the CLI carries. */
  mode?: InteractionMode | undefined;
  cli?: SessionRequest["cli"] | undefined;
};

function buildSpecialistDescription(loc: SpecialistLocation, toolName?: string): string {
  const baseDesc = loc.description ?? `Run the ${loc.name} specialist as a Lykos session.`;
  const isReadOnly = loc.read_only === true || toolName === "lykos_review";
  const note = isReadOnly ? READ_ONLY_NOTE : BRANCH_NOTE;
  return `${baseDesc} ${SESSION_NOTE} ${note} ${CONTINUE_NOTE}`;
}

function buildPrompt(framing: string, brief: string, constraints: string | undefined): string {
  let prompt = `${framing}\n\n${brief}`;
  if (constraints) prompt += `\n\nConstraints:\n${constraints}`;
  return prompt;
}

function buildSpecialistPrompt(brief: string, constraints: string | undefined): string {
  let prompt = brief;
  if (constraints) prompt += `\n\nConstraints:\n${constraints}`;
  return prompt;
}

/** A seal event's `paths`: the JSON array the ledger stores, an array already, or (an older row) one path held as text. */
function sealEventPaths(paths: unknown): string[] {
  if (Array.isArray(paths)) return paths.filter((p): p is string => typeof p === "string");
  if (typeof paths !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(paths);
  } catch {
    return [paths];
  }
  return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [paths];
}

/** A seal event's `detail` as a record: a veto's detail is a command line, not JSON, and then there is no record. */
function sealEventDetail(detail: unknown): Record<string, unknown> {
  let parsed: unknown = detail;
  if (typeof detail === "string") {
    try {
      parsed = JSON.parse(detail);
    } catch {
      return {};
    }
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

// MCP tool hints, all four set on every tool. They are fixed per tool name, so a tool
// that can start a writing session declares the worst case.
/** A session that may edit and commit, and on seal rewrite or delete files in a checked-out worktree. Calls model providers and the web. */
const WRITER_HINTS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
/** A read-only session. Calls model providers and the web; writes only Lykos's own ledger and transcript. */
const READER_HINTS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const STATUS_HINTS: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const STEER_HINTS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Stopping leaves the session resumable; stopping it twice changes nothing more. */
const STOP_HINTS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** A decision is a row appended to the ledger: it changes no session's work, and a second call records a second decision. */
const DECIDE_HINTS: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

function taskHints(readOnly: boolean | undefined): ToolAnnotations {
  return readOnly === true ? READER_HINTS : WRITER_HINTS;
}

function toResult(outcome: Record<string, unknown> | SessionOutcome): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
    ...(outcome.outcome === "blocked" || outcome.outcome === "error" ? { isError: true } : {}),
  };
}

function syncCheckedOutWorktrees(workspace: string, branch: string, tipSha: string, sealCommit: string): void {
  try {
    const targetRef = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
    const diffOut = gitExec(["diff", "--name-only", tipSha, sealCommit], workspace);
    const changedPaths = diffOut.split("\n").map((s) => s.trim()).filter(Boolean);
    if (changedPaths.length === 0) return;

    const out = gitExec(["worktree", "list", "--porcelain"], workspace);
    const blocks = out.split("\n\n");
    for (const block of blocks) {
      const lines = block.split("\n");
      const wtLine = lines.find((l) => l.startsWith("worktree "));
      const branchLine = lines.find((l) => l.startsWith("branch "));
      if (wtLine && branchLine) {
        const wtPath = wtLine.slice("worktree ".length).trim();
        const wtBranch = branchLine.slice("branch ".length).trim();
        if (wtBranch === targetRef && existsSync(wtPath)) {
          try {
            gitExec(["reset", "-q"], wtPath);
            try {
              gitExec(["checkout", "HEAD", "--", ...changedPaths], wtPath);
            } catch {
              for (const p of changedPaths) {
                try {
                  gitExec(["checkout", "HEAD", "--", p], wtPath);
                } catch {
                  const full = join(wtPath, p);
                  if (existsSync(full)) {
                    try { unlinkSync(full); } catch {}
                  }
                }
              }
            }
          } catch {}
        }
      }
    }
  } catch {}
}

function branchHasNewCommits(workspace: string, branch: string, base?: string): boolean {
  try {
    const baseRef = base ?? "HEAD";
    const out = gitExec(["rev-list", "-n", "1", `${baseRef}..${branch}`], workspace);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

function snapshotBranchTips(workspace: string): Map<string, string> {
  const tips = new Map<string, string>();
  try {
    const out = gitExec(["for-each-ref", "--format=%(refname) %(refname:short) %(objectname)", "refs/heads/"], workspace);
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [full, short, sha] = trimmed.split(" ");
      if (full && sha) tips.set(full, sha);
      if (short && sha) tips.set(short, sha);
    }
  } catch {}
  return tips;
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

function hasSealFilesInRepo(workspace: string, branch?: string): boolean {
  const sealsDir = join(workspace, ".lykos", "seals");
  if (existsSync(sealsDir)) {
    try {
      const entries = readdirSync(sealsDir, { withFileTypes: true });
      if (entries.some((e) => e.isFile() && e.name.endsWith(".json"))) return true;
    } catch {}
  }
  try {
    const gitSeals = gitExec(["log", "--all", "--name-only", "--format=", "-n", "1", "--", ".lykos/seals/*.json"], workspace);
    if (gitSeals.trim().length > 0) return true;
  } catch {}
  if (branch) {
    try {
      const branchFiles = gitExec(["ls-tree", "-r", "--name-only", branch, "--", ".lykos/seals/"], workspace);
      if (branchFiles.split("\n").some((f) => f.startsWith(".lykos/seals/") && f.endsWith(".json") && !f.startsWith(".lykos/seals/keys/"))) {
        return true;
      }
    } catch {}
  }
  return false;
}

/** The part of the SDK's request handler context this file uses. */
interface Extra {
  signal: AbortSignal;
  _meta?: { progressToken?: string | number | undefined } | undefined;
  sendNotification: (n: {
    method: "notifications/progress";
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
}

function recordSessionStoppedInLedger(workspace: string, sessionId: string, specialist: string, startTime: number, reason: string): void {
  const ledgerPath = defaultLedgerPath(workspace);
  if (!existsSync(ledgerPath)) return;
  try {
    const ledger = openLedgerSync(ledgerPath);
    try {
      const row = ledger.db.prepare("SELECT id, ended_utc FROM sessions WHERE id = ?").get(sessionId) as { id: string; ended_utc: string | null } | undefined;
      if (row && row.ended_utc == null) {
        ledger.endSession({ id: sessionId, notes: reason });
      }
    } finally {
      ledger.close();
    }
  } catch {}
}

function querySessionMetrics(workspace: string, sessionId: string): {
  turns: number | null;
  last_tool: string | null;
  cost_usd: number | null;
  unpriced_calls: number | null;
} {
  const ledgerPath = defaultLedgerPath(workspace);
  if (!existsSync(ledgerPath)) {
    return { turns: null, last_tool: null, cost_usd: null, unpriced_calls: null };
  }
  try {
    const ledger = openLedgerSync(ledgerPath);
    try {
      const sRow = ledger.db
        .prepare("SELECT turns FROM sessions WHERE id = ?")
        .get(sessionId) as { turns: number | null } | undefined;

      const callRow = ledger.db
        .prepare("SELECT tool_name, cost_usd FROM calls WHERE session_id = ? ORDER BY ts_utc DESC, id DESC LIMIT 1")
        .get(sessionId) as { tool_name: string | null; cost_usd: number | null } | undefined;

      const callsSum = ledger.db
        .prepare(
          `SELECT
             COUNT(*) as count,
             COUNT(CASE WHEN cost_usd IS NULL THEN 1 END) as unpriced_count,
             SUM(cost_usd) as total_cost
           FROM calls WHERE session_id = ?`,
        )
        .get(sessionId) as { count: number; unpriced_count: number; total_cost: number | null } | undefined;

      let turns: number | null = null;
      if (sRow?.turns != null) {
        turns = sRow.turns;
      }

      let last_tool: string | null = null;
      if (callRow?.tool_name != null) {
        last_tool = callRow.tool_name;
      }

      let cost_usd: number | null = null;
      let unpriced_calls: number | null = null;
      if (callsSum) {
        cost_usd = callsSum.total_cost;
        unpriced_calls = callsSum.unpriced_count;
      }

      return { turns, last_tool, cost_usd, unpriced_calls };
    } finally {
      ledger.close();
    }
  } catch {
    return { turns: null, last_tool: null, cost_usd: null, unpriced_calls: null };
  }
}

interface McpSessionRow {
  ended_utc?: string | null;
  transcript_path?: string | null;
  outcome?: string | null;
  outcome_source?: string | null;
  verification_cmd?: string | null;
  verification_exit_code?: number | null;
  verification_output?: string | null;
  [key: string]: unknown;
}

async function buildSessionOutcomeResult(
  workspace: string,
  request: SessionRequest,
  outcome: SessionOutcome | undefined,
  runnerError: unknown,
  branchTipsBefore: Map<string, string>,
  headAtStart: string | undefined,
  diffBase: string | undefined,
  isEffectiveReadOnly: boolean,
  scope: string[] | undefined,
  passedTargetSessionId?: string,
  stoppedReason?: string,
  unansweredQuestions?: string[],
  trustSource?: TrustSource,
): Promise<Record<string, unknown>> {
  const targetSessionId = outcome?.sessionId ?? passedTargetSessionId;

  const ledgerPath = defaultLedgerPath(workspace);
  let sessionRow: McpSessionRow | undefined = undefined;
  let sealEventsForSession: SealEventRow[] = [];
  if (existsSync(ledgerPath)) {
    try {
      const ledger = openLedgerSync(ledgerPath);
      try {
        if (targetSessionId) {
          sessionRow = ledger.db.prepare("SELECT * FROM sessions WHERE id = ?").get(targetSessionId) as McpSessionRow | undefined;
          sealEventsForSession = ledger.sealEvents().filter((e) => e.session_id === targetSessionId);
        }
      } finally {
        ledger.close();
      }
    } catch {}
  }
  const hasEndedSession = Boolean(sessionRow && sessionRow.ended_utc);

  if (outcome?.outcome === "blocked") {
    return {
      outcome: "blocked",
      reason: outcome.reason,
      next: "fix_environment",
      ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      ...(outcome.branch ? { branch: outcome.branch } : {}),
      ...(outcome.commits ? { commits: outcome.commits } : {}),
      ...(outcome.note ? { note: outcome.note } : {}),
      ...(outcome.skipped_extensions ? { skipped_extensions: outcome.skipped_extensions } : {}),
      ...(unansweredQuestions && unansweredQuestions.length > 0 ? { unanswered_questions: unansweredQuestions } : {}),
    };
  }

  try {
    const effectiveBranch = outcome?.branch ?? (request.writeInPlace ? getBranchOrNull(workspace) ?? undefined : undefined);
    const targetBranch = effectiveBranch ?? (request.writeInPlace ? "HEAD" : request.base ?? "HEAD");

    const { resolved: config } = loadConfig({ cwd: workspace });
    const writers = config.seal.writers ?? ["test-writer"];
    const runSpecialist = request.specialist ?? specialistOfTool(request.tool) ?? DEFAULT_SPECIALIST;
    const isWriter = writers.includes(runSpecialist);

    const isContinuation = request.sessionId !== undefined;
    let hasNewCommits = false;
    if (effectiveBranch) {
      if (isContinuation || request.writeInPlace) {
        const preTip = branchTipsBefore.get(effectiveBranch) ?? (effectiveBranch.startsWith("refs/heads/") ? undefined : branchTipsBefore.get(`refs/heads/${effectiveBranch}`));
        hasNewCommits = preTip !== undefined ? resolveRef(effectiveBranch, workspace) !== preTip : (outcome?.commits !== undefined && outcome.commits.length > 0);
      } else {
        hasNewCommits = resolveRef(effectiveBranch, workspace)
          ? branchHasNewCommits(workspace, effectiveBranch, request.base)
          : (outcome?.commits !== undefined && outcome.commits.length > 0);
      }
    }

    let isContained = Boolean(outcome && "runtime" in outcome && outcome.runtime !== undefined);
    let commits = outcome?.commits ? [...outcome.commits] : [];
    let sealReport: SessionSealReport | undefined;
    let hasSealsReport = false;
    let initialStatus: SealStatus = "none";
    let sealPaths: string[] | undefined;

    const attempts: Array<{ tool: string; detail: string; paths: string[] }> = [];
    // T232: every veto and every restore of a sealed path raises SEALED-EDIT.
    const sealedEditPaths = new Set<string>();
    const sealedEditDetails: string[] = [];
    for (const ev of sealEventsForSession) {
      const evPaths = sealEventPaths(ev.paths);
      if (ev.kind === "vetoed" || ev.kind === "restored") {
        for (const p of evPaths) sealedEditPaths.add(p);
        sealedEditDetails.push(ev.kind === "vetoed" ? `vetoed: ${typeof ev.detail === "string" ? ev.detail : evPaths.join(", ")}` : `restored: ${evPaths.join(", ")}`);
      }
      if (ev.kind === "restored") {
        const by = String(sealEventDetail(ev.detail)["by"] ?? "restore");
        attempts.push({ tool: "restore", detail: `${by}: ${evPaths.join(", ")}`, paths: evPaths });
      }
      if (ev.kind === "tamper_attempted") {
        const parsedDetail = sealEventDetail(ev.detail);
        attempts.push({
          tool: typeof parsedDetail["tool"] === "string" ? parsedDetail["tool"] : "bash",
          detail: typeof parsedDetail["detail"] === "string" ? parsedDetail["detail"] : typeof ev.detail === "string" ? ev.detail : "",
          paths: evPaths,
        });
      } else if (ev.kind === "vetoed") {
        const detailStr = typeof ev.detail === "string" ? ev.detail : "";
        const tool = detailStr.trim().split(/\s+/)[0] ?? "";
        attempts.push({ tool, detail: detailStr, paths: evPaths });
      }
    }

    let sealError: { message: string; refusals?: string[] } | undefined;
    let writerTipSha: string | undefined;

    // Case A: run by a seal.writers specialist that left a new commit
    if (isWriter && effectiveBranch && hasNewCommits) {
      const branch = effectiveBranch;
      const targetRef = branch.startsWith("refs/heads/") ? branch : `refs/heads/${branch}`;
      const tipSha = resolveRef(targetRef, workspace);
      if (!tipSha) {
        sealError = {
          message: `seal creation failed: branch "${branch}" cannot be resolved`,
        };
      } else {
        const sealEnv: NodeJS.ProcessEnv = {
          ...process.env,
          ...fallbackGitIdentity(workspace),
        };
        const wt = createTemporaryWorktree(workspace, tipSha, sealEnv);
        try {
          const containmentChoice =
            outcome?.containment ??
            (outcome?.runtime !== undefined ? "auto" : (request.containment ?? config.containment.level ?? "off"));
          const createRes = await sealCreate({
            cwd: wt.dir,
            branch,
            sessionId: targetSessionId,
            creator: "mcp",
            specialist: runSpecialist,
            containmentLevel: containmentChoice,
            ledgerPath: defaultLedgerPath(workspace),
            env: sealEnv,
          });

          if (!createRes.ok) {
            const refusalList = createRes.errors ?? ["seal creation refused"];
            sealError = {
              message: `seal creation refused:\n${refusalList.join("\n")}`,
              refusals: refusalList,
            };
          } else {
            const sealCommit = createRes.sealCommit!;
            try {
              gitExec(["update-ref", targetRef, sealCommit, tipSha], workspace);
              syncCheckedOutWorktrees(workspace, branch, tipSha, sealCommit);
              sealPaths = createRes.seal!.sealed_paths;
              commits.unshift({ sha: sealCommit, subject: `seal: ${branch}` });
              initialStatus = "created";
              hasSealsReport = true;
              writerTipSha = tipSha;
            } catch {
              sealError = {
                message: `seal creation failed: branch "${branch}" moved concurrently`,
              };
            }
          }
        } finally {
          wt.cleanup();
        }
      }
    } else {
      if (runnerError !== undefined && !hasEndedSession && stoppedReason === undefined) {
        return {
          outcome: "error",
          message: runnerError instanceof Error ? runnerError.message : String(runnerError),
          ...(targetSessionId ? { sessionId: targetSessionId } : {}),
          next: "fix_environment",
          ...(unansweredQuestions && unansweredQuestions.length > 0 ? { unanswered_questions: unansweredQuestions } : {}),
        };
      }

      if (outcome?.outcome === "error" && !hasEndedSession && stoppedReason === undefined) {
        return {
          outcome: "error",
          message: outcome.message,
          ...(targetSessionId ? { sessionId: targetSessionId } : {}),
          next: "fix_environment",
          ...(outcome.containment ? { containment: outcome.containment } : {}),
          ...(outcome.runtime ? { runtime: outcome.runtime } : {}),
          ...(outcome.branch ? { branch: outcome.branch } : {}),
          ...(outcome.commits ? { commits: outcome.commits } : {}),
          ...(outcome.note ? { note: outcome.note } : {}),
          ...(outcome.skipped_extensions ? { skipped_extensions: outcome.skipped_extensions } : {}),
          ...(outcome.denied ? { denied: outcome.denied } : {}),
          ...(outcome.refusals ? { refusals: outcome.refusals } : {}),
          ...(unansweredQuestions && unansweredQuestions.length > 0 ? { unanswered_questions: unansweredQuestions } : {}),
        };
      }

      if (hasSealFilesInRepo(workspace, targetBranch)) {
        hasSealsReport = true;
        let active: ActiveSeal[] = [];
        if (targetBranch) {
          try {
            active = activeSeals({ cwd: workspace, commit: targetBranch });
          } catch {}
        }

        if (active.length > 0) {
          const verifyRes = await verifySeals({
            cwd: workspace,
            commit: targetBranch,
            record: true,
            ledgerPath: defaultLedgerPath(workspace),
          });

          if (verifyRes.ok) {
            initialStatus = "intact";
            sealPaths = Array.from(new Set(verifyRes.seals.flatMap((s) => s.sealedPaths))).sort();
          } else {
            initialStatus = "tampered";
            sealPaths = verifyRes.changedPaths && verifyRes.changedPaths.length > 0
              ? verifyRes.changedPaths
              : Array.from(new Set(verifyRes.seals.flatMap((s) => s.changedPaths))).sort();
          }
        } else {
          initialStatus = "none";
        }
      }
    }

    if (hasSealsReport) {
      let finalSealStatus: SealStatus = initialStatus;
      if (initialStatus === "tampered") {
        finalSealStatus = "tampered";
      } else if (attempts.length > 0) {
        finalSealStatus = "tamper_attempted";
      }

      sealReport = {
        status: finalSealStatus,
        ...(finalSealStatus !== "none" && sealPaths !== undefined ? { paths: sealPaths } : {}),
        ...(finalSealStatus !== "none" ? { contained: isContained } : {}),
        ...(attempts.length > 0 ? { attempts } : {}),
        disputes: outcome?.disputes ?? [],
      };
    }

    let transcriptPath = sessionRow?.transcript_path;
    if (!transcriptPath && targetSessionId) {
      transcriptPath = transcriptFilePath(ledgerPath, targetSessionId);
    }
    let transcriptEvents: Array<TranscriptEventRecord & TranscriptEventInput> = [];
    if (transcriptPath && existsSync(transcriptPath)) {
      try {
        transcriptEvents = readTranscript(transcriptPath).events;
      } catch {}
    }

    let answer: string | undefined;
    for (let i = transcriptEvents.length - 1; i >= 0; i--) {
      const ev = transcriptEvents[i]!;
      if (ev.kind === "assistant_message" && typeof ev.text === "string") {
        answer = ev.text;
        break;
      }
    }
    if (answer === undefined && outcome && "answer" in outcome && typeof outcome.answer === "string") {
      answer = outcome.answer;
    }
    const answerIsSelfReport = answer !== undefined ? true : undefined;

    let verification: SessionVerification | undefined;
    if (sessionRow || (outcome && outcome.sessionId) || targetSessionId) {
      let vOutcome: "passed" | "failed" | "unverified";
      if (sessionRow?.outcome === "success" && sessionRow?.outcome_source === "verification_command") {
        vOutcome = "passed";
      } else if (sessionRow?.verification_cmd) {
        vOutcome = "failed";
      } else {
        vOutcome = "unverified";
      }
      verification = {
        command: sessionRow?.verification_cmd ?? null,
        exit: sessionRow?.verification_exit_code !== undefined && sessionRow?.verification_exit_code !== null ? sessionRow.verification_exit_code : null,
        outcome: vOutcome,
        output_tail: (sessionRow?.verification_output ?? "").slice(-2000),
      };
    }

    const sessionWroteInPlace = !isEffectiveReadOnly && ((outcome && "write_in_place" in outcome && outcome.write_in_place === true) || (request.writeInPlace === true && !outcome?.branch));
    let diffStat: DiffStat | undefined;
    let changedPaths: ChangedPath[] = [];
    let addedDiffLines: string[] = [];
    const removedLines = new Map<string, number>();
    if (outcome?.branch || sessionWroteInPlace) {
      const baseForDiff = sessionWroteInPlace ? headAtStart : diffBase;
      if (baseForDiff) {
        try {
          const gitArgs = outcome?.branch
            ? ["diff", "--shortstat", `${baseForDiff}..${outcome.branch}`]
            : ["diff", "--shortstat", baseForDiff];
          const statOut = gitExec(gitArgs, workspace).trim();
          if (statOut) {
            const filesMatch = statOut.match(/(\d+)\s+files?\s+changed/);
            const insMatch = statOut.match(/(\d+)\s+insertions?\(\+\)/);
            const delMatch = statOut.match(/(\d+)\s+deletions?\(-\)/);
            diffStat = {
              files_changed: filesMatch ? parseInt(filesMatch[1]!, 10) : 0,
              insertions: insMatch ? parseInt(insMatch[1]!, 10) : 0,
              deletions: delMatch ? parseInt(delMatch[1]!, 10) : 0,
            };
          } else {
            diffStat = { files_changed: 0, insertions: 0, deletions: 0 };
          }
        } catch {
          diffStat = { files_changed: 0, insertions: 0, deletions: 0 };
        }

        try {
          const branchTargetForFiles =
            writerTipSha !== undefined ? writerTipSha : outcome?.branch;
          const range = branchTargetForFiles ? [`${baseForDiff}..${branchTargetForFiles}`] : [baseForDiff];
          changedPaths = parseNameStatus(gitExec(["-c", "core.quotepath=false", "diff", "--name-status", "--no-renames", ...range], workspace));
          addedDiffLines = addedLines(gitExec(["diff", "-U0", "--no-renames", ...range], workspace));
          for (const line of gitExec(["-c", "core.quotepath=false", "diff", "--numstat", "--no-renames", ...range], workspace).split("\n")) {
            const [, del, file] = line.replace(/\r$/, "").split("\t");
            if (file !== undefined) removedLines.set(file, del === "-" ? 1 : Number(del));
          }
        } catch {}
      }
    }

    let finalOutcome: "ok" | "unverified" | "disputed" | "error" | "needs_answer";
    if (sealError !== undefined) {
      finalOutcome = "error";
    } else if (sealReport?.status === "tampered") {
      finalOutcome = "error";
    } else if (outcome?.outcome === "needs_answer") {
      finalOutcome = "needs_answer";
    } else if (outcome?.outcome === "disputed") {
      finalOutcome = "disputed";
    } else if (sealReport?.status === "created") {
      finalOutcome = "ok";
    } else if (verification?.outcome === "failed") {
      finalOutcome = "error";
    } else if (verification?.outcome === "passed") {
      finalOutcome = "ok";
    } else {
      finalOutcome = "unverified";
    }

    const isRefused = finalOutcome === "error" && !hasEndedSession;
    // T234: the harness runs the checks of the claims the session made with `claim`, at the final head.
    const judged =
      !isRefused && targetSessionId !== undefined
        ? await judgeSessionClaims({
            workspace,
            ledgerPath,
            sessionId: targetSessionId,
            head: targetBranch,
            ...(diffBase !== undefined ? { base: diffBase } : {}),
            wroteInPlace: sessionWroteInPlace,
            trust: trustSource,
            containment: outcome?.containment ?? (outcome?.runtime !== undefined ? "auto" : (request.containment ?? config.containment.level ?? "off")),
            testCommand: config.seal.test_command,
            shellPath: config.delegation.shell_path,
          })
        : undefined;
    const flags: SessionFlag[] = [];
    if (!isRefused) {
      if (!isEffectiveReadOnly) {
        flags.push(
          ...changeFlags({
            ...(targetSessionId !== undefined ? { sessionId: targetSessionId } : {}),
            changed: changedPaths,
            added: addedDiffLines,
            commits,
            ...(scope !== undefined ? { scope } : {}),
            removedLines,
          }),
        );
      }

      if (sealedEditDetails.length > 0) {
        flags.push({
          flag: "SEALED-EDIT",
          detail: sealedEditDetails.join("; "),
          files: [...sealedEditPaths],
          ...(targetSessionId !== undefined ? { session: targetSessionId } : {}),
        });
      }

      const GREEN_OVER_RED_PATTERNS = [
        /\b(all )?tests? (now )?(pass|passed|passing)\b/i,
        /(?<!\b(?:not|isn't|is not|never) )\bgreen\b/i,
        /\bverification (passed|passes|succeeded)\b/i,
      ];
      const misreportReasons: string[] = [...(judged?.misreports ?? [])];
      if (answer) {
        if (verification?.outcome === "failed") {
          if (GREEN_OVER_RED_PATTERNS.some((p) => p.test(answer!))) {
            misreportReasons.push("answer claims tests pass or suite is green but verification failed");
          }
        }

        const shaMatches = answer.match(/\b[0-9a-f]{7,40}\b/gi) ?? [];
        const ghostShas: string[] = [];
        for (const token of shaMatches) {
          if (!/\d/.test(token)) continue;
          const lowerToken = token.toLowerCase();
          const isCommitPrefix = commits.some((c) => c.sha && c.sha.toLowerCase().startsWith(lowerToken));
          if (isCommitPrefix) continue;
          let resolves = false;
          try {
            gitExec(["cat-file", "-e", `${lowerToken}^{commit}`], workspace);
            resolves = true;
          } catch {
            resolves = false;
          }
          if (!resolves) {
            ghostShas.push(token);
          }
        }
        if (ghostShas.length > 0) {
          const uniqueGhostShas = Array.from(new Set(ghostShas));
          misreportReasons.push(`answer references unresolvable commit sha: ${uniqueGhostShas.join(", ")}`);
        }
      }

      if (misreportReasons.length > 0) {
        flags.push({
          flag: "MISREPORT",
          detail: misreportReasons.join("; "),
          ...(targetSessionId !== undefined ? { session: targetSessionId } : {}),
        });
      }
    }

    // T254: a flag the session child raised before any model ran (WEAK-SPEC).
    if (outcome?.outcome === "needs_answer" && outcome.flags !== undefined) flags.push(...outcome.flags);

    let nextToken: NextToken;
    if (sealError !== undefined) {
      nextToken = "fix_environment";
    } else if (finalOutcome === "error" && !hasEndedSession) {
      nextToken = "fix_environment";
    } else if (sealReport?.status === "tampered" || sealReport?.status === "tamper_attempted") {
      nextToken = "inspect_seal";
    } else if (finalOutcome === "disputed") {
      nextToken = "resolve_test_dispute";
    } else if (finalOutcome === "needs_answer" && outcome?.next === "answer_spec") {
      nextToken = "answer_spec";
    } else if (finalOutcome === "needs_answer") {
      nextToken = "answer_question";
    } else if (outcome && "next" in outcome && outcome.next === "answer_question") {
      nextToken = "answer_question";
    } else if (flags.length > 0) {
      nextToken = "inspect_flags";
    } else if (sealReport?.status === "created") {
      nextToken = "review_or_accept";
    } else if (verification?.outcome === "failed") {
      nextToken = "continue_with_failure";
    } else if (finalOutcome === "error") {
      nextToken = "fix_environment";
    } else if (finalOutcome === "unverified" || verification?.outcome === "unverified") {
      nextToken = "run_verification";
    } else {
      nextToken = "review_or_accept";
    }

    const resultObj: Record<string, unknown> = {
      outcome: finalOutcome,
      ...(finalOutcome === "needs_answer" && outcome?.outcome === "needs_answer" ? { question: outcome.question } : {}),
      ...(answer !== undefined ? { answer } : {}),
      ...(answerIsSelfReport ? { answer_is_self_report: true } : {}),
      ...(targetSessionId !== undefined ? { sessionId: targetSessionId } : {}),
      next: nextToken,
      ...(flags.length > 0 ? { flags } : {}),
      ...(judged !== undefined ? { claims: judged.claims } : {}),
      ...(verification !== undefined ? { verification } : {}),
      ...(diffStat !== undefined ? { diff_stat: diffStat } : {}),
      ...(outcome && "containment" in outcome && outcome.containment ? { containment: outcome.containment } : {}),
      ...(outcome && "runtime" in outcome && outcome.runtime ? { runtime: outcome.runtime } : {}),
      ...(outcome?.branch !== undefined ? { branch: outcome.branch } : {}),
      ...(commits.length > 0 ? { commits } : {}),
      ...(sessionWroteInPlace ? { write_in_place: true } : {}),
      ...(outcome && "note" in outcome && outcome.note ? { note: outcome.note } : (stoppedReason !== undefined ? { note: stoppedReason } : {})),
      ...(outcome && "skipped_extensions" in outcome && outcome.skipped_extensions ? { skipped_extensions: outcome.skipped_extensions } : {}),
      ...(outcome && "denied" in outcome && outcome.denied ? { denied: outcome.denied } : {}),
      ...(outcome && "refusals" in outcome && outcome.refusals ? { refusals: outcome.refusals } : {}),
      ...(unansweredQuestions && unansweredQuestions.length > 0 ? { unanswered_questions: unansweredQuestions } : {}),
    };

    if (hasSealsReport) {
      if (sealReport !== undefined) {
        resultObj.seal = sealReport;
      }
      resultObj.disputes = outcome?.disputes ?? [];
    }

    if (finalOutcome === "error") {
      const errMsg = sealError?.message
        ?? ((outcome && "message" in outcome && outcome.message) ? outcome.message : undefined)
        ?? stoppedReason
        ?? (verification?.command ? `verification failed: ${verification.command}` : "verification failed");
      resultObj.message = errMsg;
      if (sealError?.refusals) {
        resultObj.refusals = sealError.refusals;
      }
    }

    return resultObj;
  } catch (err) {
    return {
      outcome: "error",
      message: err instanceof Error ? err.message : String(err),
      ...(targetSessionId !== undefined ? { sessionId: targetSessionId } : {}),
      next: "fix_environment",
      ...(unansweredQuestions && unansweredQuestions.length > 0 ? { unanswered_questions: unansweredQuestions } : {}),
    };
  }
}

async function startTrackedSession(
  workspace: string,
  def: ToolDef,
  args: TaskInput,
  extra: Extra,
  deps: McpServerDeps,
  registry: Map<string, TrackedSession>,
  isBlocking: boolean,
  owner: { kind: OwnerKind; trustSource?: TrustSource; adopt?: boolean } = { kind: "mcp" },
): Promise<ToolResult> {
  let trust: { source: TrustSource };
  if (owner.trustSource !== undefined) {
    trust = { source: owner.trustSource };
  } else {
    try {
      trust = await ensureWorkspaceTrust({
        workspace,
        interactive: false,
        ...(deps.trustPath !== undefined ? { trustPath: deps.trustPath } : {}),
      });
    } catch (err) {
      return toResult({ outcome: "blocked", reason: String(err), next: "fix_environment" });
    }
  }

  let specialistName: string;
  let specialistReadOnly = false;
  if (def.name === "lykos_start") {
    if (!args.specialist) {
      return toResult({ outcome: "error", message: "lykos_start requires specialist" });
    }
    let resolved;
    try {
      resolved = resolveSpecialist(args.specialist, workspace);
    } catch (err) {
      return toResult({ outcome: "error", message: err instanceof Error ? err.message : String(err) });
    }
    specialistName = args.specialist;
    specialistReadOnly = resolved.file.read_only === true;
  } else {
    let spec = def.specialist;
    if (spec === undefined && def.isAlias) {
      spec = args.specialist;
      if (spec === undefined && def.name === "lykos_implement") {
        let active: ActiveSeal[] = [];
        const checkCommit = args.write_in_place
          ? (getBranchOrNull(workspace) ?? "HEAD")
          : (args.session_id !== undefined
            ? await resolveSessionBranch(workspace, args.session_id)
            : args.base);
        try {
          active = activeSeals({
            cwd: workspace,
            ...(checkCommit !== undefined ? { commit: checkCommit } : {}),
          });
        } catch {}
        spec = active.length > 0 ? "implementer" : "build";
      }
    }
    specialistName = spec ?? DEFAULT_SPECIALIST;
    if (def.readOnly) {
      specialistReadOnly = true;
    } else {
      try {
        const resolved = resolveSpecialist(specialistName, workspace);
        if (resolved.file.read_only === true) specialistReadOnly = true;
      } catch {}
    }
  }

  if (args.session_id !== undefined) {
    const existing = registry.get(args.session_id);
    if (existing && (existing.state === "running" || existing.state === "waiting")) {
      return toResult({
        outcome: "blocked",
        reason: `session ${args.session_id} is already running on this server`,
        next: "fix_environment",
      });
    }
  }

  // T243: `mcp.max_sessions` caps this server; `delegation.max_sessions` caps the project, from the ledger. The
  // smallest wins, and a refusal names the holders.
  let maxSessions = 4;
  let projectCap = 4;
  try {
    const { resolved: config } = loadConfig({ cwd: workspace });
    if (config.mcp?.max_sessions !== undefined) {
      maxSessions = config.mcp.max_sessions;
    }
    projectCap = config.delegation.max_sessions;
  } catch {}
  const runningSessions = [...registry.values()].filter((s) => s.state === "running" || s.state === "waiting");
  if (owner.kind === "mcp" && runningSessions.length >= maxSessions) {
    const runningIds = runningSessions.map((s) => s.sessionId);
    return toResult({
      outcome: "blocked",
      reason: `mcp.max_sessions (${maxSessions}) reached; running sessions: ${runningIds.join(", ")}`,
      next: "fix_environment",
      running: runningIds,
    });
  }

  const isEffectiveReadOnly = def.name === "lykos_review" || def.readOnly === true || specialistReadOnly;
  const newSessionId = args.session_id === undefined ? randomUUID() : undefined;
  const targetSessionId = args.session_id ?? newSessionId!;
  const ledgerPath = defaultLedgerPath(workspace);
  let admission: Admission;
  try {
    admission = withLedgerSync(ledgerPath, (ledger) =>
      admit(ledger, {
        sessionId: targetSessionId,
        requestId: args.request_id,
        owner: owner.kind,
        specialist: specialistName,
        ...(!isEffectiveReadOnly && args.write_in_place === true ? { writeInPlaceTree: workspace } : {}),
        projectCap,
        ...(owner.adopt === true ? { adopt: true } : {}),
      }),
    );
  } catch (err) {
    return toResult({ outcome: "blocked", reason: `the ledger refused the session: ${err instanceof Error ? err.message : String(err)}`, next: "fix_environment" });
  }
  if (!admission.ok) {
    if (admission.kind === "duplicate") return duplicateRequest(workspace, admission.sessionId, registry, isBlocking);
    if (admission.kind === "cap") {
      return toResult({ outcome: "blocked", reason: admission.reason, next: "fix_environment", running: admission.holders });
    }
    if (admission.kind === "tree") {
      return toResult({
        outcome: "blocked",
        reason: `cannot start write_in_place session: ${admission.reason}`,
        next: "fix_environment",
        holder: admission.holder,
      });
    }
    return toResult({ outcome: "blocked", reason: admission.reason, next: admission.liveness === "dead" ? "recover" : "fix_environment" });
  }

  let headAtStart: string | undefined;
  try {
    headAtStart = resolveRef("HEAD", workspace) ?? undefined;
  } catch {}
  const diffBase = args.base ?? headAtStart;

  const prompt = def.framing
    ? buildPrompt(def.framing, args.brief, args.constraints)
    : buildSpecialistPrompt(args.brief, args.constraints);

  const toolName = def.name === "lykos_start" ? specialistToolName(specialistName) : def.name;
  const label = def.name === "lykos_start" ? specialistToolName(specialistName) : def.name;
  const mode = args.mode ?? (def.name === "lykos_start"
    ? "auto"
    : modeOfTool(def.name));

  const request: SessionRequest = {
    version: PROTOCOL_VERSION,
    tool: toolName,
    workspace,
    prompt,
    label,
    mode,
    specialist: specialistName,
    ...(args.base !== undefined && args.session_id === undefined ? { base: args.base } : {}),
    // `lykos run --model` is the CLI's own flag; on MCP only the deprecated aliases take a model.
    ...((def.isAlias || owner.kind === "run") && args.model !== undefined ? { model: args.model } : {}),
    ...(args.budget !== undefined ? { budgetUsd: args.budget } : {}),
    ...(args.max_steps !== undefined ? { maxSteps: args.max_steps } : {}),
    ...(args.containment !== undefined ? { containment: args.containment } : {}),
    ...(args.session_id !== undefined ? { sessionId: args.session_id } : (newSessionId !== undefined ? { newSessionId } : {})),
    ...(args.write_in_place !== undefined ? { writeInPlace: args.write_in_place } : {}),
    ...(args.request_id !== undefined ? { requestId: args.request_id } : {}),
    ...(args.sealed !== undefined && args.sealed.length > 0 && args.session_id === undefined ? { sealed: args.sealed } : {}),
    ...(args.red === false ? { red: false } : {}),
    ...(args.session_id === undefined && ((args.files?.length ?? 0) > 0 || args.test !== undefined)
      ? { context: { files: args.files ?? [], ...(args.test !== undefined ? { test: args.test } : {}) } }
      : {}),
    ...(args.reseal !== undefined && args.session_id !== undefined ? { reseal: args.reseal } : {}),
    ...(args.cli !== undefined ? { cli: args.cli } : {}),
  };

  const branchTipsBefore = snapshotBranchTips(workspace);

  const abortController = new AbortController();
  const signal = extra.signal
    ? (typeof AbortSignal.any === "function"
        ? AbortSignal.any([abortController.signal, extra.signal])
        : abortController.signal)
    : abortController.signal;
  if (extra.signal && typeof AbortSignal.any !== "function") {
    extra.signal.addEventListener("abort", () => abortController.abort(), { once: true });
  }

  const sessionEntry: TrackedSession = {
    sessionId: targetSessionId,
    workspace,
    specialist: specialistName,
    request,
    state: "running",
    startTime: Date.now(),
    abortController,
    runnerPromise: Promise.resolve(),
    queuedSteers: [],
    listeners: [],
    isBlocking,
    unansweredQuestions: [],
    ownedId: targetSessionId,
    ownerKind: owner.kind,
  };
  registry.set(targetSessionId, sessionEntry);
  // T243/T244: a stop or a steer another process asks for reaches this owner through the ledger.
  sessionEntry.stopPoll = setInterval(() => {
    if (sessionEntry.stoppedReason !== undefined) return;
    let asked = false;
    let messages: string[] = [];
    try {
      [asked, messages] = withLedgerSync(ledgerPath, (ledger) => [stopRequested(ledger, targetSessionId), takeInbox(ledger, targetSessionId)] as const);
    } catch {}
    for (const message of messages) deliverSteer(sessionEntry, message);
    if (!asked) return;
    if (sessionEntry.askTimeoutTimer !== undefined) {
      clearTimeout(sessionEntry.askTimeoutTimer);
      sessionEntry.askTimeoutTimer = undefined;
    }
    sessionEntry.stoppedReason = "stopped: lykos_stop";
    sessionEntry.abortController.abort();
  }, STOP_POLL_MS);
  sessionEntry.stopPoll.unref();

  sessionEntry.runnerPromise = (async () => {
    const token = extra._meta?.progressToken;
    let progress = 0;
    let outcome: SessionOutcome | undefined;
    let runnerError: unknown;
    try {
      outcome = await (deps.run ?? defaultRunner())({
        request,
        trustSource: trust.source,
        signal,
        onProgress: (message) => {
          if (token === undefined) return;
          progress += 1;
          void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, message } }).catch(() => {});
        },
        onQuestion: (question: string) => {
          handleSessionQuestion(sessionEntry, question, workspace);
        },
        onSteerable: (steerFn) => {
          sessionEntry.onSteer = steerFn;
          while (sessionEntry.queuedSteers.length > 0) {
            const msg = sessionEntry.queuedSteers.shift()!;
            void steerFn(msg);
          }
        },
      });
    } catch (err) {
      runnerError = err;
    }

    const finalSessionId = outcome?.sessionId ?? targetSessionId;
    if (finalSessionId !== sessionEntry.sessionId) {
      sessionEntry.sessionId = finalSessionId;
      registry.set(finalSessionId, sessionEntry);
    }

    if (sessionEntry.stoppedReason !== undefined) {
      recordSessionStoppedInLedger(workspace, finalSessionId, specialistName, sessionEntry.startTime, sessionEntry.stoppedReason);
    }

    let builtResult: Record<string, unknown>;
    try {
      builtResult = await buildSessionOutcomeResult(
        workspace,
        request,
        outcome,
        runnerError,
        branchTipsBefore,
        headAtStart,
        diffBase,
        isEffectiveReadOnly,
        args.scope,
        targetSessionId,
        sessionEntry.stoppedReason,
        sessionEntry.unansweredQuestions,
        trust.source,
      );
    } catch (err) {
      builtResult = {
        outcome: "error",
        message: err instanceof Error ? err.message : String(err),
        sessionId: finalSessionId,
        next: "fix_environment",
        ...(sessionEntry.unansweredQuestions.length > 0 ? { unanswered_questions: sessionEntry.unansweredQuestions } : {}),
      };
    }

    // T243 (R13): the steps the session took, from the count its cap is enforced from.
    if (outcome?.steps !== undefined) builtResult.steps = outcome.steps;
    if (request.maxSteps !== undefined) builtResult.max_steps = request.maxSteps;

    if (sessionEntry.askTimeoutTimer !== undefined) {
      clearTimeout(sessionEntry.askTimeoutTimer);
      sessionEntry.askTimeoutTimer = undefined;
    }

    sessionEntry.endTime = Date.now();
    if (sessionEntry.stoppedReason !== undefined) {
      sessionEntry.state = "stopped";
    } else if (runnerError !== undefined || builtResult.outcome === "error" || builtResult.outcome === "blocked") {
      sessionEntry.state = "error";
    } else {
      sessionEntry.state = "done";
    }
    sessionEntry.builtResult = builtResult;
    endOwnership(sessionEntry, targetSessionId);

    const notifyList = sessionEntry.listeners;
    sessionEntry.listeners = [];
    for (const fn of notifyList) {
      try { fn(); } catch {}
    }
  })();

  if (isBlocking) {
    await sessionEntry.runnerPromise;
    return toResult(sessionEntry.builtResult!);
  } else {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          session_id: targetSessionId,
          state: "running",
          specialist: specialistName,
        }, null, 2),
      }],
    };
  }
}

/** The id a session's owner row is keyed by: the one it was admitted under. */
function ownedIdOf(s: TrackedSession): string {
  return s.ownedId;
}

/** Runs `fn` on the session's ledger; a ledger that cannot be written is reported, never fatal to the session. */
function onLedger(s: TrackedSession, what: string, fn: (ledger: Ledger) => void): void {
  try {
    withLedgerSync(defaultLedgerPath(s.workspace), fn);
  } catch (err) {
    stderrWrite(`lykos: could not record ${what} for session ${s.ownedId}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** T244: a steering message for a live session. A session waiting on a question takes it as the answer. */
function deliverSteer(s: TrackedSession, message: string): void {
  if (s.state === "waiting") {
    if (s.askTimeoutTimer !== undefined) {
      clearTimeout(s.askTimeoutTimer);
      s.askTimeoutTimer = undefined;
    }
    s.state = "running";
    s.pendingQuestion = undefined;
  }
  onLedger(s, "the answer", (ledger) => void closeQuestions(ledger, s.ownedId, "steer"));
  if (s.onSteer) {
    void s.onSteer(message);
  } else {
    s.queuedSteers.push(message);
  }
}

/** T244: the open questions of these sessions, from the ledger. */
export function ledgerQuestions(workspace: string, ids: readonly string[]): OpenQuestion[] {
  const ledgerPath = defaultLedgerPath(workspace);
  if (!existsSync(ledgerPath)) return [];
  return withLedgerSync(ledgerPath, (ledger) => openQuestions(ledger, ids));
}

/**
 * T244: waits until one of these sessions has a question nobody answered (never one already answered, G8), or all
 * of them have settled. Returns the open questions, empty when they settled or the timeout passed.
 */
export async function waitForQuestions(workspace: string, ids: readonly string[], timeoutMs?: number): Promise<{ questions: OpenQuestion[]; sessions: SessionView[] }> {
  const until = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
  for (;;) {
    const questions = ledgerQuestions(workspace, ids);
    const sessions = ledgerViews(workspace, ids);
    if (questions.length > 0 || sessions.every(settled)) return { questions, sessions };
    if (until !== undefined && Date.now() >= until) return { questions, sessions };
    await new Promise((r) => setTimeout(r, LEDGER_POLL_MS));
  }
}

/** T244: posts a steer for a session another process owns. Undefined when the ledger has no such session. */
export function steerElsewhere(workspace: string, sessionId: string, message: string): { session_id: string; steered: boolean; state: string } | undefined {
  const ledgerPath = defaultLedgerPath(workspace);
  if (!existsSync(ledgerPath)) return undefined;
  return withLedgerSync(ledgerPath, (ledger) => {
    const row = ownerRow(ledger, sessionId);
    if (row === undefined) return undefined;
    const steered = postSteer(ledger, sessionId, message);
    return { session_id: sessionId, steered, state: viewOf(row, ownerLiveness, () => ownerRow(ledger, sessionId)).state };
  });
}

/**
 * T243: the session's owner row ends with its state and result, and its tree lock goes. A forced stop ends it with
 * a stop result; the runner that ends later writes its built result over it.
 */
function endOwnership(s: TrackedSession, ownedId: string): void {
  if (s.stopPoll !== undefined) {
    clearInterval(s.stopPoll);
    s.stopPoll = undefined;
  }
  const state = s.state === "running" || s.state === "waiting" ? "stopped" : s.state;
  const result = s.builtResult ?? { outcome: "stopped", sessionId: s.sessionId, reason: s.stoppedReason ?? "stopped" };
  try {
    withLedgerSync(defaultLedgerPath(s.workspace), (ledger) => finish(ledger, ownedId, state, result));
  } catch (err) {
    stderrWrite(`lykos: could not record the end of session ${ownedId} in the ledger: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

/** How often a process waiting on another process's session reads the ledger. */
const LEDGER_POLL_MS = 250;

/** What the ledger says of these sessions now. */
export function ledgerViews(workspace: string, ids?: readonly string[]): SessionView[] {
  const ledgerPath = defaultLedgerPath(workspace);
  if (!existsSync(ledgerPath)) return [];
  return withLedgerSync(ledgerPath, (ledger) =>
    ownerRows(ledger, ids).map((row) => {
      const view = viewOf(row, ownerLiveness, () => ownerRow(ledger, row.session_id));
      const pack = contextPackSummary(ledger, row.session_id);
      const baseline = baselineSummary(ledger, row.session_id);
      const decisions = decisionsOf(ledger, row.session_id);
      const findings = findingDecisionsOf(ledger, row.session_id);
      const claims = judgedClaimsOf(ledger, row.session_id);
      return {
        ...view,
        ...(pack !== undefined ? { context_pack: pack } : {}),
        ...(baseline !== undefined ? { baseline } : {}),
        ...(decisions.length > 0 ? { decisions } : {}),
        ...(findings.length > 0 ? { finding_decisions: findings } : {}),
        ...(claims.length > 0 ? { claims } : {}),
      };
    }),
  );
}

/**
 * Waits, through the ledger, until every session (or, with `any`, one) has settled: ended, or crashed with its owner
 * gone. A session that ends without a result still wakes it (R4). `timeoutMs` undefined waits as long as it takes.
 */
export async function waitForSessions(workspace: string, ids: readonly string[], any: boolean, timeoutMs?: number): Promise<SessionView[]> {
  const until = timeoutMs !== undefined ? Date.now() + timeoutMs : undefined;
  for (;;) {
    const views = ledgerViews(workspace, ids);
    const done = views.filter(settled);
    if (any ? done.length > 0 : done.length === ids.length) return views;
    if (until !== undefined && Date.now() >= until) return views;
    await new Promise((r) => setTimeout(r, LEDGER_POLL_MS));
  }
}

/** A retried request: its session, never a second one. */
async function duplicateRequest(workspace: string, sessionId: string, registry: Map<string, TrackedSession>, isBlocking: boolean): Promise<ToolResult> {
  const local = registry.get(sessionId);
  if (local !== undefined) {
    if (isBlocking) {
      await local.runnerPromise;
      return toResult({ ...local.builtResult!, duplicate: true });
    }
    return { content: [{ type: "text", text: JSON.stringify({ session_id: sessionId, state: local.state, specialist: local.specialist, duplicate: true }, null, 2) }] };
  }
  const [view] = isBlocking ? await waitForSessions(workspace, [sessionId], false) : ledgerViews(workspace, [sessionId]);
  if (view === undefined) return toResult({ outcome: "error", message: `the request's session ${sessionId} is not in the ledger` });
  if (isBlocking && view.result !== undefined) return toResult({ ...(view.result as Record<string, unknown>), duplicate: true });
  return { content: [{ type: "text", text: JSON.stringify({ ...view, duplicate: true }, null, 2) }] };
}

function handleSessionQuestion(sessionEntry: TrackedSession, question: string, workspace: string): void {
  // T244 (F1): the question is in the ledger, and so in every process's `status`, before anything else happens.
  onLedger(sessionEntry, "the question", (ledger) => askQuestion(ledger, sessionEntry.ownedId, question));
  // A blocking MCP call has a caller that cannot answer mid-call: it decides alone at once. `lykos run` blocks too,
  // but another process can answer through the inbox, so it waits like a started session.
  if (sessionEntry.isBlocking && sessionEntry.ownerKind === "mcp") {
    onLedger(sessionEntry, "the decide-alone answer", (ledger) => void closeQuestions(ledger, sessionEntry.ownedId, "timeout"));
    sessionEntry.unansweredQuestions.push(question);
    if (sessionEntry.onSteer) {
      void sessionEntry.onSteer(ASK_TIMEOUT_NOTICE);
    } else {
      sessionEntry.queuedSteers.push(ASK_TIMEOUT_NOTICE);
    }
    return;
  }

  sessionEntry.state = "waiting";
  sessionEntry.pendingQuestion = question;

  const notifyList = sessionEntry.listeners;
  sessionEntry.listeners = [];
  for (const fn of notifyList) {
    try {
      fn();
    } catch {}
  }

  let askTimeoutSeconds = 600;
  try {
    const { resolved: config } = loadConfig({ cwd: workspace });
    if (config.mcp?.ask_timeout !== undefined) {
      askTimeoutSeconds = config.mcp.ask_timeout;
    }
  } catch {}

  sessionEntry.askTimeoutTimer = setTimeout(() => {
    if (sessionEntry.state === "waiting") {
      sessionEntry.state = "running";
      sessionEntry.pendingQuestion = undefined;
      onLedger(sessionEntry, "the decide-alone answer", (ledger) => void closeQuestions(ledger, sessionEntry.ownedId, "timeout"));
      sessionEntry.unansweredQuestions.push(question);
      if (sessionEntry.onSteer) {
        void sessionEntry.onSteer(ASK_TIMEOUT_NOTICE);
      } else {
        sessionEntry.queuedSteers.push(ASK_TIMEOUT_NOTICE);
      }
    }
  }, askTimeoutSeconds * 1000);
  sessionEntry.askTimeoutTimer.unref();
}

async function handleStatus(
  workspace: string,
  args: { session_id?: string | undefined; session_ids?: string[] | undefined; wait_seconds?: number | undefined; any?: boolean | undefined },
  registry: Map<string, TrackedSession>,
): Promise<ToolResult> {
  if (
    (args.session_id !== undefined && args.session_ids !== undefined) ||
    (args.session_id === undefined && args.session_ids === undefined)
  ) {
    return toResult({
      outcome: "error",
      message: "lykos_status requires exactly one of session_id or session_ids",
    });
  }
  if (args.session_ids !== undefined && args.session_ids.length === 0) {
    return toResult({
      outcome: "error",
      message: "lykos_status requires a non-empty session_ids array",
    });
  }
  const ids = args.session_id !== undefined ? [args.session_id] : args.session_ids!;

  // T243: a session another process owns (`lykos run`, another server) is read from the ledger. A mix of this
  // server's sessions and others' is read from the ledger too: this server's are admitted there as well.
  const elsewhere = ids.filter((id) => !registry.has(id));
  if (elsewhere.length > 0) {
    const views = ledgerViews(workspace, ids);
    if (views.length === ids.length) {
      const waitSeconds = Math.min(Math.max(args.wait_seconds ?? 0, 0), 300);
      const settledViews = waitSeconds > 0 ? await waitForSessions(workspace, ids, args.any === true, waitSeconds * 1000) : views;
      return { content: [{ type: "text", text: JSON.stringify({ sessions: settledViews }, null, 2) }] };
    }
  }
  const unknownIds = elsewhere;
  if (unknownIds.length > 0) {
    return toResult({
      outcome: "error",
      message: `unknown session id: ${unknownIds.join(", ")}. Pass session_id on lykos_start (or a specialist tool) to continue an earlier session.`,
    });
  }

  let waitSeconds = args.wait_seconds ?? 0;
  if (waitSeconds < 0) waitSeconds = 0;
  if (waitSeconds > 300) waitSeconds = 300;

  const isSatisfied = (): boolean => {
    if (args.any) {
      return ids.some((id) => registry.get(id)!.state !== "running");
    } else {
      return ids.every((id) => registry.get(id)!.state !== "running");
    }
  };

  if (waitSeconds > 0 && !isSatisfied()) {
    await new Promise<void>((resolve) => {
      let resolved = false;
      let timer: NodeJS.Timeout | undefined;

      const done = (): void => {
        if (resolved) return;
        resolved = true;
        if (timer !== undefined) clearTimeout(timer);
        for (const id of ids) {
          const s = registry.get(id);
          if (s) {
            const idx = s.listeners.indexOf(check);
            if (idx >= 0) s.listeners.splice(idx, 1);
          }
        }
        resolve();
      };

      const check = (): void => {
        if (isSatisfied()) {
          done();
        }
      };

      timer = setTimeout(done, waitSeconds * 1000);

      for (const id of ids) {
        const s = registry.get(id);
        if (s) {
          s.listeners.push(check);
        }
      }
    });
  }

  const sessions = ids.map((id) => {
    const s = registry.get(id)!;
    const metrics = querySessionMetrics(s.workspace, id);
    const elapsed_seconds = Math.round(((s.endTime ?? Date.now()) - s.startTime) / 1000);
    return {
      session_id: id,
      state: s.state,
      elapsed_seconds,
      turns: metrics.turns,
      last_tool: metrics.last_tool,
      cost_usd: metrics.cost_usd,
      unpriced_calls: metrics.unpriced_calls,
      question: s.state === "waiting" ? (s.pendingQuestion ?? null) : null,
      ...(s.state !== "running" && s.state !== "waiting" && s.builtResult !== undefined ? { result: s.builtResult } : {}),
    };
  });

  return {
    content: [{
      type: "text",
      text: JSON.stringify({ sessions }, null, 2),
    }],
  };
}

function handleSteer(workspace: string, args: { session_id: string; message: string }, registry: Map<string, TrackedSession>): ToolResult {
  const s = registry.get(args.session_id);
  if (!s) {
    // T244: a session another process owns takes the steer through the ledger inbox.
    const elsewhere = steerElsewhere(workspace, args.session_id, args.message);
    if (elsewhere !== undefined) {
      if (!elsewhere.steered) {
        return toResult({ outcome: "error", message: `session ${args.session_id} is ${elsewhere.state}; cannot steer it. Continue it with session_id.` });
      }
      return { content: [{ type: "text", text: JSON.stringify(elsewhere, null, 2) }] };
    }
    return toResult({
      outcome: "error",
      message: `unknown session id: ${args.session_id}. Pass session_id on lykos_start (or a specialist tool) to resume an earlier session.`,
    });
  }
  if (s.state !== "running" && s.state !== "waiting") {
    return toResult({
      outcome: "error",
      message: `session ${args.session_id} has ended with state "${s.state}"; cannot steer a finished session. Pass session_id on lykos_start (or a specialist tool) to resume it.`,
    });
  }
  deliverSteer(s, args.message);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        session_id: args.session_id,
        steered: true,
      }, null, 2),
    }],
  };
}

async function handleStop(workspace: string, args: { session_id: string }, registry: Map<string, TrackedSession>): Promise<ToolResult> {
  const s = registry.get(args.session_id);
  if (!s) {
    const stopped = await stopElsewhere(workspace, args.session_id);
    if (stopped !== undefined) return { content: [{ type: "text", text: JSON.stringify(stopped, null, 2) }] };
    return toResult({
      outcome: "error",
      message: `unknown session id: ${args.session_id} (to continue an ended session, resume it with session_id)`,
    });
  }
  if (s.state !== "running" && s.state !== "waiting") {
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          session_id: args.session_id,
          state: s.state,
        }, null, 2),
      }],
    };
  }
  if (s.askTimeoutTimer !== undefined) {
    clearTimeout(s.askTimeoutTimer);
    s.askTimeoutTimer = undefined;
  }
  s.stoppedReason = "stopped: lykos_stop";
  s.abortController.abort();
  recordSessionStoppedInLedger(s.workspace, s.sessionId, s.specialist, s.startTime, s.stoppedReason);

  // Fail-closed (ADR-0060): the row and its tree lock are let go only once the runner has ended. A runner still
  // tearing down after 10 s keeps them; it lets go when it ends, or its row reads crashed if this process dies.
  const settled = await Promise.race([
    s.runnerPromise.then(() => true, () => true),
    new Promise<boolean>((r) => setTimeout(() => r(false), 10000)),
  ]);

  if (s.state === "running" || s.state === "waiting") {
    s.state = "stopped";
    if (settled) endOwnership(s, ownedIdOf(s));
    const notifyList = s.listeners;
    s.listeners = [];
    for (const fn of notifyList) {
      try { fn(); } catch {}
    }
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        session_id: args.session_id,
        state: "stopped",
      }, null, 2),
    }],
  };
}

/**
 * T243: stops a session another process owns: the stop is asked in the ledger, which its owner polls. Waits up to
 * 10 s for it to end. Undefined when the ledger has no such session.
 */
export async function stopElsewhere(workspace: string, sessionId: string): Promise<{ session_id: string; state: string; next?: string } | undefined> {
  const ledgerPath = defaultLedgerPath(workspace);
  if (!existsSync(ledgerPath)) return undefined;
  const asked = withLedgerSync(ledgerPath, (ledger) => (ownerRow(ledger, sessionId) === undefined ? undefined : requestStop(ledger, sessionId)));
  if (asked === undefined) return undefined;
  const [view] = asked ? await waitForSessions(workspace, [sessionId], false, 10_000) : ledgerViews(workspace, [sessionId]);
  if (view === undefined) return undefined;
  return { session_id: sessionId, state: view.state, ...(view.next !== undefined ? { next: view.next } : {}) };
}

/** What `lykos run` asks of the delegation core: an MCP start's input, plus the CLI's own fields. */
export type DelegatedRunInput = TaskInput;

/**
 * T243: `lykos run`'s path into the delegation core. The same admission, session child, result and ownership as an
 * MCP call, with this process as the owner; it blocks until the result. MCP never calls the CLI, and the CLI never
 * calls MCP: both are front ends over this.
 */
export async function runDelegated(
  workspace: string,
  args: DelegatedRunInput,
  opts: { trustSource: TrustSource; signal?: AbortSignal; onProgress?: (message: string) => void; run?: SessionRunner; adopt?: boolean },
): Promise<Record<string, unknown>> {
  const specialist = args.specialist ?? DEFAULT_SPECIALIST;
  const def: ToolDef = { name: "lykos_start", description: "lykos run", specialist };
  const registry = new Map<string, TrackedSession>();
  const extra: Extra = {
    signal: opts.signal ?? new AbortController().signal,
    _meta: { progressToken: 0 },
    sendNotification: async (n) => {
      if (n.params.message !== undefined) opts.onProgress?.(n.params.message);
    },
  };
  const deps: McpServerDeps = { run: opts.run ?? defaultRunner() };
  const result = await startTrackedSession(workspace, def, { ...args, specialist }, extra, deps, registry, true, { kind: "run", trustSource: opts.trustSource, ...(opts.adopt === true ? { adopt: true } : {}) });
  const text = result.content[0]?.type === "text" ? result.content[0].text : "{}";
  return JSON.parse(text) as Record<string, unknown>;
}

let processRunner: SessionRunner | undefined;
function defaultRunner(): SessionRunner {
  processRunner ??= createProcessRunner();
  return processRunner;
}

/** Seams for tests: the session runner and the trust store. Production passes neither. */
export interface McpServerDeps {
  run?: SessionRunner;
  trustPath?: string;
}

export interface CreateMcpServerOptions extends McpServerDeps {
  workspace: string;
  version: string;
}

/** Builds the server without connecting a transport: testable on its own. */
export function createMcpServer(opts: CreateMcpServerOptions): McpServer & { pool?: WarmPool | undefined } {
  let pool: WarmPool | undefined;
  if (!opts.run) {
    let warmPoolSize = 0;
    try {
      const cfg = loadConfig({ cwd: opts.workspace });
      warmPoolSize = cfg.resolved.mcp.warm_pool;
    } catch (err) {
      stderrWrite(`lykos mcp: could not load config, disabling warm pool: ${err instanceof Error ? err.message : String(err)}\n`);
      warmPoolSize = 0;
    }
    pool = createWarmPool({ size: warmPoolSize });
    void ensureWorkspaceTrust({
      workspace: opts.workspace,
      interactive: false,
      ...(opts.trustPath !== undefined ? { trustPath: opts.trustPath } : {}),
    })
      .then((decision) => {
        pool?.warm(opts.workspace, decision.source);
      })
      .catch(() => {
        // Untrusted workspace: first call warms it if trust is established then
      });
  }

  const deps: McpServerDeps = {
    ...opts,
    run: opts.run ?? pool?.run ?? defaultRunner(),
  };

  const server = new McpServer({ name: "lykos", version: opts.version }) as McpServer & { pool?: WarmPool | undefined };
  server.pool = pool;
  const registry = new Map<string, TrackedSession>();

  const stopAllLiveSessions = async (reason: "stopped: server shutdown"): Promise<void> => {
    const live = [...registry.values()].filter((s) => s.state === "running" || s.state === "waiting");
    for (const s of live) {
      if (s.askTimeoutTimer !== undefined) {
        clearTimeout(s.askTimeoutTimer);
        s.askTimeoutTimer = undefined;
      }
      s.stoppedReason = reason;
      s.state = "stopped";
      s.abortController.abort();
      recordSessionStoppedInLedger(s.workspace, s.sessionId, s.specialist, s.startTime, s.stoppedReason);
      // Fail-closed (ADR-0060): the row and its tree lock stay until the child has torn down; if this server exits
      // first, the row reads crashed and waits for `lykos recover`, which confirms quiescence.
      for (const fn of s.listeners) {
        try { fn(); } catch {}
      }
      s.listeners = [];
    }
    await Promise.all(
      live.map((s) =>
        Promise.race([
          s.runnerPromise,
          new Promise<void>((r) => setTimeout(r, 200)),
        ]),
      ),
    );
  };

  const origClose = server.close.bind(server);
  server.close = async () => {
    await stopAllLiveSessions("stopped: server shutdown");
    if (pool) await pool.shutdown();
    return origClose();
  };

  const origServerOnClose = server.server.onclose;
  server.server.onclose = () => {
    void stopAllLiveSessions("stopped: server shutdown");
    if (pool) void pool.shutdown();
    origServerOnClose?.();
  };

  // Register the four async tools
  server.registerTool(
    "lykos_start",
    {
      description: "Start an asynchronous Lykos session with a specialist and return immediately with its session_id.",
      inputSchema: StartInputShape,
      annotations: WRITER_HINTS,
    },
    async (args, extra) => {
      const def: ToolDef = {
        name: "lykos_start",
        description: "Start an asynchronous Lykos session.",
        specialist: args.specialist,
      };
      return startTrackedSession(opts.workspace, def, args as TaskInput, extra as unknown as Extra, deps, registry, false);
    },
  );

  server.registerTool(
    "lykos_status",
    {
      description: "Check the status of one or more Lykos sessions, optionally waiting for completion.",
      inputSchema: StatusInputShape,
      annotations: STATUS_HINTS,
    },
    async (args) => {
      return handleStatus(opts.workspace, args, registry);
    },
  );

  server.registerTool(
    "lykos_steer",
    {
      description: "Steer a running Lykos session by delivering a message into its agent loop.",
      inputSchema: SteerInputShape,
      annotations: STEER_HINTS,
    },
    async (args) => {
      return handleSteer(opts.workspace, args, registry);
    },
  );

  server.registerTool(
    "lykos_stop",
    {
      description: "Stop a running Lykos session and leave it in a resumable state.",
      inputSchema: StopInputShape,
      annotations: STOP_HINTS,
    },
    async (args) => {
      return handleStop(opts.workspace, args, registry);
    },
  );

  server.registerTool(
    "lykos_decide",
    {
      description: "Record your decision on a session: accept, reject, merged or discard, with a reason and a cause. Same rules as lykos accept|reject|merged|discard.",
      inputSchema: DecideInputShape,
      annotations: DECIDE_HINTS,
    },
    async (args) => {
      const decided = await decideAt(defaultLedgerPath(opts.workspace), args.decision, args.session_id, args, "reason");
      return toResult(decided.kind === "invalid" ? { outcome: "error", message: decided.message } : decided.body);
    },
  );

  const globalDir = join(homedir(), ".lykos");
  const discovered = discoverSpecialists(opts.workspace, globalDir);
  const winningSpecialists = resolveSpecialistToolWinners(discovered);

  const registeredToolNames = new Set<string>();

  // Framed aliases (lykos_implement, lykos_refactor, lykos_debug, lykos_review)
  for (const framedDef of TOOL_DEFS) {
    const aliasName = framedDef.name;
    const clashingSpec = winningSpecialists.get(aliasName);
    if (clashingSpec) {
      const toolDef: ToolDef = {
        name: aliasName,
        description: buildSpecialistDescription(clashingSpec, aliasName),
        framing: framedDef.framing,
        specialist: clashingSpec.name,
        isAlias: true,
        readOnly: clashingSpec.read_only === true || aliasName === "lykos_review",
      };
      registeredToolNames.add(aliasName);
      server.registerTool(
        aliasName,
        { description: toolDef.description, inputSchema: TaskInputShape, annotations: taskHints(toolDef.readOnly) },
        async (args: TaskInput, extra) => startTrackedSession(opts.workspace, toolDef, args, extra as unknown as Extra, deps, registry, true),
      );
    } else {
      const toolDef: ToolDef = {
        ...framedDef,
        isAlias: true,
        readOnly: aliasName === "lykos_review",
      };
      registeredToolNames.add(aliasName);
      server.registerTool(
        aliasName,
        { description: toolDef.description, inputSchema: TaskInputShape, annotations: taskHints(toolDef.readOnly) },
        async (args: TaskInput, extra) => startTrackedSession(opts.workspace, toolDef, args, extra as unknown as Extra, deps, registry, true),
      );
    }
  }

  // Specialist tools
  for (const [toolName, spec] of winningSpecialists) {
    if (isReservedAsyncTool(toolName)) {
      stderrWrite(`lykos mcp: specialist ${spec.name} clashes with async tool ${toolName}, skipping\n`);
      continue;
    }
    if (registeredToolNames.has(toolName)) continue;
    const toolDef: ToolDef = {
      name: toolName,
      description: buildSpecialistDescription(spec, toolName),
      specialist: spec.name,
      isAlias: false,
      readOnly: spec.read_only === true,
    };
    registeredToolNames.add(toolName);
    server.registerTool(
      toolName,
      { description: toolDef.description, inputSchema: SpecialistInputShape, annotations: taskHints(toolDef.readOnly) },
      async (args: TaskInput, extra) => startTrackedSession(opts.workspace, toolDef, args, extra as unknown as Extra, deps, registry, true),
    );
  }

  return server;
}

export { TOOL_DEFS };
