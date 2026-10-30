// Transcript store (T9, docs/08-sessions-and-archive.md §2). One append-only
// JSONL file per session plus a meta.json, written beside live.json under
// .lykos/session/<id>/ (lykos/ledger/live.ts's sessionsDir()).
//
// Honest subset, the same shape as T4.2's prefix-hash decision: the
// first capture path was the retired delegate server's TERMINAL snapshot —
// one JSON object returned once a delegate run finished. That gave per-call
// token usage, the tool-call trace (name + args, and result when the caller
// asked for `verbose`), and the LAST assistant text — not a live per-turn
// stream. Sessions recorded that way keep their rows, and the path is NAMED:
// a transcript captured from it is `capture_mode = "snapshot"`, carries `tool_call`,
// `usage`, one final `assistant_message`, `error` and `outcome`, and has no
// user message in it anywhere.
//
// T53 (docs/19-phase4-tasks.md) adds the second source. The standalone agent
// runs in Lykos's own process, so `session/live-capture.ts` subscribes to
// its `AgentSessionEvent` stream and appends events AS THEY HAPPEN through
// this same writer. A transcript captured that way is `capture_mode =
// "stream"` and carries the kinds this file gained for it: `user_message`,
// `steer`, `thinking`, `tool_result`, `compaction`, `answer`,
// `intervention`, plus an `assistant_message` per turn rather than one final
// blob. Only a `stream` transcript can be replayed as a conversation — see
// docs/19 §T56, which refuses a `snapshot` one and offers it as a brief
// instead. Neither mode is ever inferred for a session that predates the
// distinction.
//
// `turn_index` on every event is CAPTURE ORDER (an incrementing counter as
// events are appended), not Pi's own turn boundary — neither source exposes
// that directly. Documented here rather than silently relabelling it.

import type { ContainmentRecord } from "../containment/containment.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { sessionsDir } from "../ledger/live.js";
import { redactValue } from "../ledger/redact.js";

export interface ToolCallEvent {
  kind: "tool_call";
  name: string;
  state: string;
  ms?: number;
  args?: unknown;
  result?: unknown;
  /** T9.4: the same tool call repeated with identical args this many times in a row, collapsed into one line. */
  repeat_count?: number;
}

export interface UsageEvent {
  kind: "usage";
  /**
   * Joins this line back to the ledger's `calls` table (docs/08 §2) — "that
   * join is the whole point". Cost is deliberately NOT duplicated here: the
   * ledger's `priceCall()` is the one place that computation happens, and a
   * cached number here could drift from it. Look up `cost_usd` by this id.
   */
  call_id: string;
  hop: number;
  source?: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  tool_name?: string;
  phase?: string;
}

export interface AssistantMessageEvent {
  kind: "assistant_message";
  text: string;
  /**
   * Snapshot capture writes exactly one of these, with `final: true`: it is
   * the run's last text and nothing else was ever available. Stream capture
   * writes one per turn with `final: false`, because on that path the flag
   * means what it says rather than describing the capture path's limits.
   */
  final: boolean;
}

/** T53: a prompt the human typed at the top level. Stream capture only — the snapshot path never saw one. */
export interface UserMessageEvent {
  kind: "user_message";
  text: string;
}

/**
 * T53: a line that arrived while a turn was already running. Distinct from
 * `user_message` on purpose — `human_interventions` counts exactly these,
 * and a replay that turned a steer into an ordinary prompt would rebuild a
 * conversation that never happened.
 */
export interface SteerEvent {
  kind: "steer";
  text: string;
  /** `steer` interrupts the running turn; `follow_up` queues behind it. Pi exposes both. */
  mode: "steer" | "follow_up";
}

/**
 * T57: the first line of a resumed session's transcript. It names the
 * original, how much was replayed, and what the replay was ESTIMATED to
 * cost, so the archive explains itself without a join. The ACTUAL cost of
 * the replay is the first `calls` row on this session — the two sit side by
 * side deliberately, and their difference is this phase's own measurement
 * (T62), collected for free.
 */
export interface ResumeEvent {
  kind: "resume";
  from: string;
  events: number;
  user_turns: number;
  estimate_tokens: number;
  /** NULL when the model is not in the price table — tokens recorded, dollars never invented. */
  estimate_usd: number | null;
  price_version: string | null;
  /** Mechanism flags this session booted with, and whether the caller overrode the original's. */
  inherited_flags?: { promptDiet?: boolean; outputDiet?: boolean; overridden?: boolean };
}

/** T53: the model's reasoning for one turn, where the stream exposes it (`thinking_end`). */
export interface ThinkingEvent {
  kind: "thinking";
  text: string;
}

/**
 * T53: the result half of a tool call, as its own line. The snapshot path
 * folds the result INTO its `tool_call` (it only ever saw the finished
 * pair); the stream sees start and end at different times and must not
 * pretend otherwise, because the interval between them is where a kill
 * lands.
 */
export interface ToolResultEvent {
  kind: "tool_result";
  name: string;
  state: "ok" | "error";
  tool_call_id?: string;
  result?: unknown;
  /**
   * P4 T146: this call succeeded and is file-changing by the tool registry's
   * one declaration (`isFileChangingCall`). Absent means it is not, or the
   * transcript predates T146 — `lykos show` tells the two apart by whether
   * the transcript has `turn_start` markers at all.
   */
  changes_files?: true;
  /** T146: the file it changed, when the call named one (`path`/`file_path`). */
  path?: string;
}

/**
 * P4 T146: the start of a model turn, counted across the whole session from
 * 0. The same count the harness writes on that turn's checkpoint
 * (`Lykos-Turn:`), which is what ties a turn that changed files to the
 * checkpoint taken before it. Stream capture only.
 */
export interface TurnStartEvent {
  kind: "turn_start";
  turn: number;
}

/**
 * T53: compaction as a real marker rather than only a `usage` row with
 * `phase: "compact"`. A replay has to know where the model's own context was
 * cut, because everything before that point was already summarised once.
 */
export interface CompactionEvent {
  kind: "compaction";
  phase: "start" | "end";
  reason?: string;
  aborted?: boolean;
  tokens_before?: number;
  tokens_after?: number;
}

/** T53: an answer the human gave to a question Lykos asked (an approval prompt, the T52.1 outcome question). */
export interface AnswerEvent {
  kind: "answer";
  question: string;
  answer: string;
}

/**
 * T53: something the human did to the session that is neither a prompt nor
 * an answer — an abort, a `/effort` change, a `/compact`. Recorded because a
 * resumed session that silently dropped them would be a different run.
 */
export interface InterventionEvent {
  kind: "intervention";
  action: string;
  detail?: string;
}

/**
 * P4 T152: the note to self `lykos-self-compact` returned to the agent after a
 * compaction, word for word. Recorded so a replay carries the note whole
 * rather than as a clipped tool argument.
 */
export interface SelfCompactNoteEvent {
  kind: "self_compact_note";
  note: string;
}

/**
 * T188: `lykos-prune` overwrote these tool results in what the model is sent
 * (`loop/tool-result-prune.ts`). The `tool_result` lines stay as they were
 * produced -- the transcript is the archive and nothing is deleted -- so this
 * line is how a replay or `lykos show` learns what the model saw instead.
 */
export interface PruneEvent {
  kind: "prune";
  entries: Array<{ tool_call_id: string; notice: PruneKind }>;
  /** Absent when the record did not carry it: never 0, never a guess. */
  tokens_saved?: number;
  reason?: PruneReason;
}

/**
 * T193: a `lykos-shake` record (`loop/shake.ts`) dropped these tool results'
 * text from what the model is sent. As with a prune, the `tool_result` lines
 * stay as produced; this line is how a replay or `lykos show` learns of it.
 */
export interface ShakeEvent {
  kind: "shake";
  tool_call_ids: string[];
  /** Estimated at Pi's chars/4, never a measurement. */
  tokens_saved: number;
}

export interface ErrorEvent {
  kind: "error";
  message: string;
}

export interface OutcomeEvent {
  kind: "outcome";
  state?: string;
  turns?: number;
  tool_calls?: number;
  outcome?: "success" | "fail" | "abandoned";
}

export type TranscriptEventInput =
  | ToolCallEvent
  | UsageEvent
  | AssistantMessageEvent
  | UserMessageEvent
  | SteerEvent
  | ThinkingEvent
  | ToolResultEvent
  | TurnStartEvent
  | CompactionEvent
  | AnswerEvent
  | InterventionEvent
  | ResumeEvent
  | SelfCompactNoteEvent
  | PruneEvent
  | ShakeEvent
  | ErrorEvent
  | OutcomeEvent;

export interface TranscriptEventRecord {
  ts_utc: string;
  turn_index: number;
}

/**
 * T54 (docs/19-phase4-tasks.md): the parts of a v2 meta.json that exist so a
 * session can be *reconstructed* rather than merely described.
 *
 * Every field here is COPIED from something the boot path already computed.
 * Nothing is derived a second time: a second computation is a second thing
 * that can drift, and this file's whole job is to be the thing a resume
 * checks itself against.
 *
 * All of it is optional, because a v1 file has none of it and a reader must
 * fill nothing it cannot know. Absent means "not recorded", never a default.
 */
export interface SessionResumeContract {
  /** T35.3's `SessionModelSource` — who chose the boot model. */
  modelSource?: string;
  /** T25's pair, as of the run. Prices change; `08` §5 forbids silent recosting, so a resume has to be able to SAY the basis moved. */
  priceBasis?: string;
  priceVersion?: string;
  /** Reasoning effort at boot, and the capability specialist in force. A resume reproduces the session, not a cheaper or dearer relative of it. */
  effort?: string;
  specialist?: string;
  /**
   * The head's identity: the boot block's fingerprint and the frozen
   * context-file list `lykos prompt --show` already computes. A resume onto
   * a different head is a different experiment — allowed, but visible.
   */
  head?: {
    bootFingerprint?: string;
    contextFiles?: Array<{ name: string; bytes: number; kind?: string }>;
  };
  /**
   * The tool surface. A conversation full of `Agent` calls resumed without
   * `--subagents` fails in a confusing way; this is what lets the preflight
   * say so first.
   */
  tools?: {
    active?: string[];
    extensions?: Array<{ name: string; version?: string }>;
  };
  /** The mechanism flags in force. T57 inherits these by default, and records any override. */
  flags?: {
    headContract?: boolean;
    promptDiet?: boolean;
    outputDiet?: boolean;
  };
  /**
   * The working tree at session start. Already in the ledger; duplicated
   * here so the session directory is self-describing when copied to another
   * machine, which `08` §2 gives as a reason files were chosen over rows.
   */
  git?: { commit?: string; dirty?: boolean };
  /** Where the session ran, and against which image where one applies. `null` is the honest value for a host session — there is no image. */
  runtime?: string;
  executionShape?: string;
  sandboxImage?: string | null;
  /** T173: the containment the session asked for and got. Absent on a session before T173. */
  containment?: ContainmentRecord;
  /** T219: Items withheld from an untrusted project (extensions, commands, gate discovery). */
  withheld?: string[];
}

export interface SessionMeta extends SessionResumeContract {
  /**
   * v1 is every meta.json written before T53. v2 is written from session
   * BOOT rather than from ingest — so a session that crashes still leaves a
   * self-describing directory behind — and carries `captureMode` (T53) plus
   * the resume contract above (T54). A reader accepts either and fills
   * nothing it cannot know.
   */
  schemaVersion: 1 | 2;
  sessionId: string;
  taskId: string | null;
  projectId: string | null;
  parentSessionId: string | null;
  resumedFrom: string | null;
  agentRole: string | null;
  model: string | null;
  cwd: string | null;
  startedUtc: string;
  /** T53. Absent on a v1 file, which is "unknown", never "snapshot by assumption". */
  captureMode?: CaptureMode;
}

import type { PruneKind, PruneReason } from "../loop/tool-result-prune.js";

/** Mirrors `ledger/ledger.ts`'s `CaptureMode`; re-declared here so the transcript store does not import the ledger. */
export type CaptureMode = "stream" | "snapshot";

/** Reads a meta.json of either version. Returns null when the file is missing or unparseable — a damaged meta is not a reason to throw out of a reader. */
export function readSessionMeta(ledgerPath: string, sessionId: string): SessionMeta | null {
  const path = metaFilePath(ledgerPath, sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SessionMeta;
  } catch {
    return null;
  }
}

export function transcriptDir(ledgerPath: string, sessionId: string): string {
  return join(sessionsDir(ledgerPath), sessionId);
}

export function transcriptFilePath(ledgerPath: string, sessionId: string): string {
  return join(transcriptDir(ledgerPath, sessionId), "transcript.jsonl");
}

/** T55: where `lykos archive` puts the compressed form. The raw path plus `.gz`, nothing cleverer. */
export function transcriptGzFilePath(ledgerPath: string, sessionId: string): string {
  return `${transcriptFilePath(ledgerPath, sessionId)}.gz`;
}

/**
 * T55: resolve whichever form of a transcript is actually on disk.
 *
 * `sessions.transcript_path` always names the RAW file, because that is what
 * `transcript_sha256` is the hash of and archiving must never invalidate an
 * integrity check. A reader therefore has to look for both, and prefers the
 * raw one when a half-finished archive run left both behind.
 *
 * Returns null when neither exists.
 */
export function resolveTranscriptFile(rawPath: string): { path: string; gzipped: boolean } | null {
  if (existsSync(rawPath)) return { path: rawPath, gzipped: false };
  const gz = rawPath.endsWith(".gz") ? rawPath : `${rawPath}.gz`;
  if (existsSync(gz)) return { path: gz, gzipped: true };
  return null;
}

/**
 * The transcript's bytes as they were WRITTEN — decompressed when the file on
 * disk is the archived form. Every hash check and every reader goes through
 * here, so `transcript_sha256` keeps meaning the same thing before and after
 * `lykos archive` has run.
 */
export function readTranscriptBytes(path: string): Buffer {
  const buf = readFileSync(path);
  return path.endsWith(".gz") ? gunzipSync(buf) : buf;
}

export function metaFilePath(ledgerPath: string, sessionId: string): string {
  return join(transcriptDir(ledgerPath, sessionId), "meta.json");
}

/** Above this many redacted-JSON bytes, a tool_call's args/result spill to artifacts/ (T9.4) rather than bloating the transcript inline. */
const SPILL_THRESHOLD_BYTES = 8192;

export function writeSessionMeta(ledgerPath: string, meta: SessionMeta): void {
  const path = metaFilePath(ledgerPath, meta.sessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

/**
 * Appends redacted transcript events to one session's transcript.jsonl.
 * Each `append()` is one `appendFileSync` call for one line, so a process
 * killed between two events leaves every earlier line intact and parseable
 * (`readTranscript` below handles a partial trailing line). Consecutive
 * identical tool_call events are buffered and collapsed into one line with
 * a `repeat_count` (T9.4) — flushed on the next non-matching event or on
 * `finalize()`.
 */
export class TranscriptWriter {
  private readonly path: string;
  private readonly artifactsDir: string;
  private turnIndex = 0;
  private artifactSeq = 0;
  private artifactBytesTotal = 0;
  private pending: { key: string; event: ToolCallEvent; ts: string; count: number } | null = null;

  constructor(
    private readonly ledgerPath: string,
    private readonly sessionId: string,
  ) {
    this.path = transcriptFilePath(ledgerPath, sessionId);
    this.artifactsDir = join(transcriptDir(ledgerPath, sessionId), "artifacts");
    mkdirSync(dirname(this.path), { recursive: true });
  }

  append(event: TranscriptEventInput, ts: Date = new Date()): void {
    const tsIso = ts.toISOString();
    if (event.kind === "tool_call") {
      const capped = this.capOversized(event);
      const key = JSON.stringify({ name: capped.name, args: capped.args });
      if (this.pending && this.pending.key === key) {
        this.pending.count += 1;
        return;
      }
      this.flushPending();
      this.pending = { key, event: capped, ts: tsIso, count: 1 };
      return;
    }
    this.flushPending();
    this.writeLine(redactValue(event) as TranscriptEventInput, tsIso);
  }

  private flushPending(): void {
    if (!this.pending) return;
    const { event, ts, count } = this.pending;
    this.pending = null;
    const line = count > 1 ? { ...event, repeat_count: count } : event;
    this.writeLine(redactValue(line) as TranscriptEventInput, ts);
  }

  private writeLine(event: TranscriptEventInput, tsIso: string): void {
    const record: TranscriptEventRecord & TranscriptEventInput = {
      ts_utc: tsIso,
      turn_index: this.turnIndex++,
      ...event,
    };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
  }

  /**
   * Redacted first (never write a secret to any file, including an
   * artifact), then capped by size — an oversized RESULT is a finding
   * (T9.4: "cap the pathological, not the large"), not silent truncation.
   */
  private capOversized(event: ToolCallEvent): ToolCallEvent {
    const redacted = redactValue(event) as ToolCallEvent;
    const inline = { args: redacted.args, result: redacted.result };
    const json = JSON.stringify(inline);
    if (Buffer.byteLength(json, "utf8") <= SPILL_THRESHOLD_BYTES) return redacted;
    this.artifactSeq += 1;
    const fileName = `${String(this.artifactSeq).padStart(4, "0")}-${redacted.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    mkdirSync(this.artifactsDir, { recursive: true });
    writeFileSync(join(this.artifactsDir, fileName), json, "utf8");
    const bytes = Buffer.byteLength(json, "utf8");
    // T111.1: the sum this writer is the only thing in a position to know.
    // Counted here rather than by walking `artifacts/` at session end, so
    // there is one place that decides what an artifact byte is.
    this.artifactBytesTotal += bytes;
    const { args: _args, ...rest } = redacted;
    return {
      ...rest,
      result: { truncated: true, bytes, artifact: `artifacts/${fileName}` },
    };
  }

  /** T111.1: bytes this session spilled to `artifacts/`. 0 means nothing was ever oversized. */
  get artifactBytes(): number {
    return this.artifactBytesTotal;
  }

  /** Flushes any buffered repeat, then hashes the file for the ledger pointer (T9.3). */
  finalize(): { path: string; sha256: string; bytes: number } {
    this.flushPending();
    if (!existsSync(this.path)) writeFileSync(this.path, "", "utf8");
    const buf = readFileSync(this.path);
    return { path: this.path, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
  }
}

export interface ReadTranscriptResult {
  events: (TranscriptEventRecord & TranscriptEventInput)[];
  /** true if the file's last line did not parse — e.g. a kill mid-write. */
  truncated: boolean;
}

/** Parses every complete line; a trailing partial line (process killed mid-write) is reported, not thrown. */
export function readTranscript(path: string): ReadTranscriptResult {
  const resolved = resolveTranscriptFile(path);
  const raw = readTranscriptBytes(resolved?.path ?? path).toString("utf8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  const events: (TranscriptEventRecord & TranscriptEventInput)[] = [];
  let truncated = false;
  for (let i = 0; i < lines.length; i++) {
    try {
      events.push(JSON.parse(lines[i]!) as TranscriptEventRecord & TranscriptEventInput);
    } catch {
      if (i === lines.length - 1) truncated = true;
      else throw new Error(`readTranscript: ${path} has an unparseable line before the last one (${i + 1}/${lines.length})`);
    }
  }
  return { events, truncated };
}

/**
 * T55: the hash is of the UNCOMPRESSED bytes, always. Archiving changes the
 * file on disk and must not change the answer to "is this transcript
 * intact" — so a `.gz` is decompressed first rather than re-hashed in its
 * compressed form, and `doctor` reports the same verdict before and after an
 * archive run.
 */
export function verifyTranscriptHash(path: string, expectedSha256: string): boolean {
  const resolved = resolveTranscriptFile(path);
  if (!resolved) return false;
  return createHash("sha256").update(readTranscriptBytes(resolved.path)).digest("hex") === expectedSha256;
}
