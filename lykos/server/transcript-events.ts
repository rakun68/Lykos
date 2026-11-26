/**
 * Transcript records as the events a live session sends for them (`event-ui.ts`): how a watched session (P5 #51)
 * and a resumed one show the conversation the archive holds.
 */
import type { TranscriptRecord } from "../session/replay.js";
import { activeBranch } from "../session/active-branch.js";
import { readTranscript, transcriptFilePath } from "../session/transcript.js";
import { toolSummary } from "../surface/s0.js";
import { toolEndData } from "./event-ui.js";
import type { EventData } from "./protocol.js";

/**
 * An archived session's conversation, as its resume would show it (the active branch, without the turns a rewind
 * undid), read from its transcript file. Returns false when there is no transcript to read.
 */
export function emitHistory(ledgerPath: string, sessionId: string, emit: (data: EventData) => void): boolean {
  let records: TranscriptRecord[];
  try {
    records = readTranscript(transcriptFilePath(ledgerPath, sessionId)).events as TranscriptRecord[];
  } catch {
    return false;
  }
  const events = new TranscriptEvents(emit);
  for (const r of activeBranch(records)) events.record(r);
  events.endTurn();
  return true;
}

export class TranscriptEvents {
  private assistantOpen = false;
  private toolSeq = 0;
  /** Each open tool call's arguments, until its result: an edit's diff is read from them. */
  private readonly args = new Map<string, unknown>();

  constructor(private readonly emit: (data: EventData) => void) {}

  endTurn(): void {
    if (this.assistantOpen) this.emit({ type: "message.end" });
    this.assistantOpen = false;
  }

  record(r: TranscriptRecord): void {
    switch (r.kind) {
      case "user_message":
        this.endTurn();
        this.emit({ type: "message.user", text: r.typed ?? r.text });
        return;
      case "steer":
        this.endTurn();
        this.emit({ type: "message.followup", text: r.text });
        return;
      case "turn_start":
        this.endTurn();
        return;
      case "thinking":
        this.emit({ type: "thinking.delta", text: r.text });
        return;
      case "assistant_message":
        this.emit({ type: "message.delta", text: r.text });
        this.assistantOpen = true;
        this.endTurn();
        return;
      case "tool_call": {
        this.endTurn();
        const toolId = r.tool_call_id ?? `tool-${++this.toolSeq}`;
        this.args.set(toolId, r.args);
        this.emit({ type: "tool.start", toolId, name: r.name, summary: toolSummary(r.name, r.args), args: r.args ?? null });
        return;
      }
      case "tool_result": {
        const toolId = r.tool_call_id ?? `tool-${this.toolSeq}`;
        const args = this.args.get(toolId);
        this.args.delete(toolId);
        this.emit(toolEndData(toolId, r.name, args, r.result, r.state === "error"));
        return;
      }
      case "compaction":
        this.emit({ type: "system", text: r.phase === "start" ? "compacting…" : "compacted" });
        return;
      case "error":
        this.emit({ type: "system", text: `error: ${r.message}` });
        return;
      default:
        return;
    }
  }
}
