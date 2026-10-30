// Live transcript capture.
//
// The blocking task of Phase 4. Before it, the only writer of a transcript
// was `ledger/ingest.ts`, working from a TERMINAL snapshot: one JSON
// object describing a run that had already finished. That shape is right for
// the ledger — "one ledger, one ingest path" — and wrong for a transcript,
// for two reasons the phase cannot live with:
//
//  1. **It contains no user message.** The snapshot never carried one, so a
//     resume replaying it would rebuild a context holding the agent's tool
//     calls and its last sentence with none of the human side. That is a
//     summary wearing a conversation's clothes.
//  2. **A crashed session leaves nothing at all**, because the whole file
//     was written at ingest time — so "nothing Lykos ever runs is deleted"
//     was false for exactly the sessions most worth keeping.
//
// This module is the second source. The standalone agent runs in Lykos's own
// process, so there IS an event stream to read: `attach()` subscribes to the
// same `AgentSessionEvent`s the UI already renders and appends each one
// through the existing `TranscriptWriter`, one `appendFileSync` per line, so
// a SIGKILL mid-turn leaves every earlier line intact and parseable.
//
// What it deliberately does NOT do:
//
//  - **It is not a second ledger writer.** No `sessions` or `calls` row is
//    touched here; `ingestDelegateSnapshot()` remains the only writer of
//    both, and still runs at session end from the same snapshot it always
//    did. This owns the transcript file and nothing else.
//  - **It does not write `usage` events.** A `usage` line's whole purpose is
//    its `call_id` join back to the ledger's `calls` row, and that id does
//    not exist until ingest. Writing one here with a fabricated id would
//    break the only join the transcript has, so ingest still appends them at
//    session end — through THIS recorder's writer, so there is still exactly
//    one writer on the file.
//  - **It does not touch the delegate/MCP path**, which has no event stream
//    to read and keeps its snapshot-derived subset — labelled `snapshot`, so
//    the difference is recorded rather than silently smoothed over.
//
// Redaction: every event goes through `TranscriptWriter.append()`, which
// runs `redactValue()` before it writes. This module adds no path around it.

import {
  TranscriptWriter,
  writeSessionMeta,
  type CaptureMode,
  type ResumeEvent,
  type SessionMeta,
  type TranscriptEventInput,
} from "./transcript.js";
import { isFileChangingCall, resolveActualToolArgs } from "../tools/tool-call.js";
import { SELF_COMPACT_NOTE_TYPE } from "../loop/self-compact.js";
import { PRUNE_ENTRY_TYPE, prunePartialFromEntry } from "../loop/tool-result-prune.js";
import { SHAKE_ENTRY_TYPE, shakeRecordFromData } from "../loop/shake.js";

/** The subset of `AgentSession` this module needs — narrow so tests can drive it with a fake emitter. */
export interface EventSource {
  subscribe(listener: (event: unknown) => void): () => void;
}

/**
 * What `session/interactive.ts`'s loop calls. Deliberately an interface rather
 * than the class: the loop is tested against a scripted session with no
 * ledger directory at all, and must not be made to construct a real writer
 * to run.
 */
export interface TranscriptRecorder {
  userMessage(text: string): void;
  steer(text: string, mode?: "steer" | "follow_up"): void;
  answer(question: string, answer: string): void;
  intervention(action: string, detail?: string): void;
}

interface AgentEventish {
  type?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  reason?: string;
  aborted?: boolean;
  assistantMessageEvent?: { type?: string; content?: string };
  message?: { role?: string; customType?: string; content?: unknown };
}

/**
 * Owns one session's transcript file for the whole life of the session.
 *
 * Constructed at BOOT (not at ingest), which is what makes a crashed session
 * leave a readable directory behind: `meta.json` is written immediately, and
 * every event lands as it happens. `finalize()` — the hash — runs at session
 * end from ingest, so a session that dies never reaches it and its
 * `transcript_sha256` is legitimately NULL. That is a correct answer, not a
 * gap: `lykos doctor` distinguishes UNHASHED (the process died) from DAMAGED
 * (a hash is recorded and no longer matches), and only the second is a fault.
 */
export class LiveTranscriptRecorder implements TranscriptRecorder {
  readonly captureMode: CaptureMode = "stream";
  readonly writer: TranscriptWriter;
  private toolCallNames = new Map<string, string>();
  /** T146: each running call's arguments, so its result can say whether it changed a file. */
  private toolCallArgs = new Map<string, unknown>();
  /** T146: the next `turn_start`'s number — the same session-wide count the harness writes on checkpoints. */
  private nextTurn = 0;

  constructor(
    readonly ledgerPath: string,
    readonly sessionId: string,
  ) {
    this.writer = new TranscriptWriter(ledgerPath, sessionId);
  }

  /**
   * `:memory:` ledgers (every unit test that does not ask for a real path)
   * have no directory to write into — the same guard `live.ts` uses for
   * live.json and `ingest.ts` uses for its own writer.
   */
  static create(ledgerPath: string, sessionId: string): LiveTranscriptRecorder | undefined {
    if (ledgerPath === ":memory:") return undefined;
    return new LiveTranscriptRecorder(ledgerPath, sessionId);
  }

  /** Writes the session directory's `meta.json` at boot, so a session that never reaches ingest still describes itself. */
  writeMeta(meta: Omit<SessionMeta, "schemaVersion" | "sessionId" | "captureMode">): void {
    writeSessionMeta(this.ledgerPath, {
      schemaVersion: 2,
      sessionId: this.sessionId,
      captureMode: this.captureMode,
      ...meta,
    });
  }

  append(event: TranscriptEventInput): void {
    this.writer.append(event);
  }

  userMessage(text: string): void {
    this.append({ kind: "user_message", text });
  }

  steer(text: string, mode: "steer" | "follow_up" = "steer"): void {
    this.append({ kind: "steer", text, mode });
  }

  answer(question: string, answer: string): void {
    this.append({ kind: "answer", question, answer });
  }

  intervention(action: string, detail?: string): void {
    this.append({ kind: "intervention", action, ...(detail !== undefined ? { detail } : {}) });
  }

  /** T57: written before anything else on a resumed session, so the file explains itself from its first line. */
  resumeMarker(event: Omit<ResumeEvent, "kind">): void {
    this.append({ kind: "resume", ...event });
  }

  error(message: string): void {
    this.append({ kind: "error", message });
  }

  finalize(): { path: string; sha256: string; bytes: number } {
    return this.writer.finalize();
  }

  /**
   * Subscribes to the agent's event stream. Returns the unsubscribe.
   *
   * The mapping is deliberately narrow — only events that are part of the
   * conversation are recorded. Streaming deltas (`text_delta`,
   * `thinking_delta`, `bash_execution_update`) are not: they are the same
   * bytes as the matching `*_end` event that follows, and appending them
   * would multiply the size of a permanent, never-deleted file for nothing.
   */
  attach(source: EventSource): () => void {
    return source.subscribe((raw) => {
      const ev = raw as AgentEventish;
      switch (ev.type) {
        case "turn_start":
          this.append({ kind: "turn_start", turn: this.nextTurn++ });
          break;
        case "tool_execution_start": {
          if (ev.toolCallId && ev.toolName) this.toolCallNames.set(ev.toolCallId, ev.toolName);
          if (ev.toolCallId && ev.args !== undefined) this.toolCallArgs.set(ev.toolCallId, ev.args);
          this.append({
            kind: "tool_call",
            name: ev.toolName ?? "(unknown)",
            state: "running",
            ...(ev.args !== undefined ? { args: ev.args } : {}),
          });
          break;
        }
        case "tool_execution_end": {
          const name =
            ev.toolName ?? (ev.toolCallId ? this.toolCallNames.get(ev.toolCallId) : undefined) ?? "(unknown)";
          const args = ev.toolCallId ? this.toolCallArgs.get(ev.toolCallId) : undefined;
          if (ev.toolCallId) {
            this.toolCallNames.delete(ev.toolCallId);
            this.toolCallArgs.delete(ev.toolCallId);
          }
          // T146: marked here, from the registry's one declaration, so
          // `lykos show` reads which turns changed files instead of working
          // it out again from tool names.
          const changed = !ev.isError && isFileChangingCall(name, args, ev.result);
          const target = changed ? resolveActualToolArgs(name, args) : undefined;
          const path =
            target !== null && typeof target === "object"
              ? ((target as { path?: unknown }).path ?? (target as { file_path?: unknown }).file_path)
              : undefined;
          this.append({
            kind: "tool_result",
            name,
            state: ev.isError ? "error" : "ok",
            ...(ev.toolCallId !== undefined ? { tool_call_id: ev.toolCallId } : {}),
            ...(ev.result !== undefined ? { result: ev.result } : {}),
            ...(changed ? { changes_files: true as const } : {}),
            ...(changed && typeof path === "string" ? { path } : {}),
          });
          break;
        }
        case "message_update": {
          const inner = ev.assistantMessageEvent;
          if (!inner) break;
          // `final: false` is the truth on this path, and is what tells a
          // reader the difference between one turn's reply and the snapshot
          // path's single closing blob.
          if (inner.type === "text_end" && inner.content) {
            this.append({ kind: "assistant_message", text: inner.content, final: false });
          } else if (inner.type === "thinking_end" && inner.content) {
            this.append({ kind: "thinking", text: inner.content });
          }
          break;
        }
        case "message_end": {
          // T152: the self-compact note, returned after compaction. Its
          // second text block is the note itself, byte for byte.
          const m = ev.message;
          if (m?.role === "custom" && m.customType === SELF_COMPACT_NOTE_TYPE && Array.isArray(m.content)) {
            const blocks = m.content as Array<{ type?: string; text?: string }>;
            const note = blocks[blocks.length - 1]?.text;
            if (typeof note === "string") this.append({ kind: "self_compact_note", note });
          }
          break;
        }
        case "entry_appended": {
          const entry = (ev as { entry?: { customType?: string; data?: unknown } }).entry;
          if (entry?.customType === SHAKE_ENTRY_TYPE) {
            // T193: a `lykos-shake` record, as the transcript line a replay reads.
            const shake = shakeRecordFromData(entry.data);
            if (shake !== undefined) {
              this.append({ kind: "shake", tool_call_ids: shake.tool_call_ids, tokens_saved: shake.tokens_saved });
            }
            break;
          }
          // T188: a `lykos-prune` record, likewise.
          if (entry?.customType !== PRUNE_ENTRY_TYPE) break;
          const d = prunePartialFromEntry(entry.data);
          if (d.entries === undefined) break;
          this.append({
            kind: "prune",
            entries: d.entries.map((e) => ({ tool_call_id: e.id, notice: e.kind })),
            ...(d.tokens_saved !== undefined ? { tokens_saved: d.tokens_saved } : {}),
            ...(d.reason !== undefined ? { reason: d.reason } : {}),
          });
          break;
        }
        case "compaction_start":
          this.append({ kind: "compaction", phase: "start", ...(ev.reason ? { reason: ev.reason } : {}) });
          break;
        case "compaction_end":
          this.append({
            kind: "compaction",
            phase: "end",
            ...(ev.reason ? { reason: ev.reason } : {}),
            ...(ev.aborted !== undefined ? { aborted: ev.aborted } : {}),
          });
          break;
        default:
          break;
      }
    });
  }
}
