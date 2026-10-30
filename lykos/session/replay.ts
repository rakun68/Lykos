// T56/T57 (docs/19-phase4-tasks.md) — turning a captured transcript back
// into something a fresh agent can read.
//
// This module is deliberately shared by the preflight and the resume itself.
// The preflight's headline number is "resuming replays 94.2k tokens ≈ $0.12",
// and that number is worthless if it is estimated from anything other than
// the exact bytes the resume will actually send. One builder, two callers.
//
// **Replay is appended after the head, never merged into it** (rule 1 of the
// phase's own §1). What this produces is conversation, delivered as one
// custom message on the resumed session's context. It never touches
// `session/prompt-assembly` and never changes a frozen block.
//
// What it includes and why:
//
//  - `user_message` and `steer`, distinguished. A steer arrived while a turn
//    was running and was a correction; flattening the two into "the user
//    said" would rebuild a conversation that never happened.
//  - `assistant_message` per turn.
//  - `tool_call` name and arguments, and `tool_result` — capped per result,
//    with the truncation marked rather than silent. Tool results are the
//    bulk of a long transcript and most of them are re-derivable, but
//    dropping them entirely would strip the evidence the earlier answers
//    were based on.
//  - a tool result `lykos-prune` overwrote, as the notice the model was sent
//    in its place (T188), and one a `lykos-shake` dropped, as the shake's
//    notice (T193),
//  - `compaction` markers, because everything before one was already
//    summarised once and a reader that does not know that will
//    over-interpret the earlier turns.
//
// What it drops: `thinking` (the model's own reasoning is not context for a
// *different* run of it), `usage` (a ledger join, not conversation) and
// `outcome` (a fact about the row, not something said).

import { PRUNE_NOTICES } from "../loop/tool-result-prune.js";
import { SHAKE_NOTICE } from "../loop/shake.js";
import type { TranscriptEventInput, TranscriptEventRecord } from "./transcript.js";

export type TranscriptRecord = TranscriptEventRecord & TranscriptEventInput;

export interface BuildReplayOptions {
  /** Per tool result, in characters. Above this the result is cut and the cut is stated. */
  maxToolResultChars?: number;
  /** Per tool call's arguments, in characters. */
  maxToolArgChars?: number;
}

export interface ReplayBundle {
  /** The exact text a resume sends. Priced by the preflight, delivered by `lykos resume`. */
  text: string;
  /** How many conversational events were replayed — what the preflight and the resume marker both report. */
  events: number;
  /** User messages plus steers: what a person would call "turns of mine". */
  userTurns: number;
  /** True when at least one tool result was cut to the cap. */
  truncatedResults: boolean;
}

export const DEFAULT_MAX_TOOL_RESULT_CHARS = 2000;
export const DEFAULT_MAX_TOOL_ARG_CHARS = 500;

function clip(value: unknown, max: number): { text: string; clipped: boolean } {
  const raw = typeof value === "string" ? value : JSON.stringify(value);
  if (raw === undefined) return { text: "undefined", clipped: false };
  if (raw.length <= max) return { text: raw, clipped: false };
  return { text: `${raw.slice(0, max)}… [cut, ${raw.length} chars total]`, clipped: true };
}

/**
 * Renders a captured transcript as the conversation a resumed session is
 * handed. Pure: same events in, same bytes out, so the preflight's estimate
 * and the resume's actual send cannot disagree.
 */
export function buildReplay(
  sessionId: string,
  records: readonly TranscriptRecord[],
  opts?: BuildReplayOptions,
): ReplayBundle {
  const maxResult = opts?.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const maxArgs = opts?.maxToolArgChars ?? DEFAULT_MAX_TOOL_ARG_CHARS;
  const lines: string[] = [];
  let events = 0;
  let userTurns = 0;
  let truncatedResults = false;
  // T188: a result `lykos-prune` overwrote is replayed as the notice the model
  // was sent in its place, so a resumed session starts from the pruned context.
  const replaced = new Map<string, string>();
  for (const record of records) {
    if (record.kind !== "prune") continue;
    for (const e of record.entries) replaced.set(e.tool_call_id, PRUNE_NOTICES[e.notice]);
  }
  // T193: likewise a shaken result. A result both touched keeps the prune's
  // notice: in the shipped extension order (the default scaffold lists
  // `lykos-self-compact` ahead of `lykos-prune`), a live request applies the
  // shakes first, so the prune's notice is what it carried. Load order is the
  // configuration's `extensions:` list; a reordered one can have sent the
  // shake's notice instead, and the replay does not know the order.
  for (const record of records) {
    if (record.kind !== "shake") continue;
    for (const id of record.tool_call_ids) if (!replaced.has(id)) replaced.set(id, SHAKE_NOTICE);
  }

  for (const record of records) {
    switch (record.kind) {
      case "user_message":
        lines.push(`[user] ${record.text}`);
        events += 1;
        userTurns += 1;
        break;
      case "steer":
        lines.push(`[user, steering a running turn] ${record.text}`);
        events += 1;
        userTurns += 1;
        break;
      case "assistant_message":
        lines.push(`[assistant] ${record.text}`);
        events += 1;
        break;
      case "tool_call": {
        const args = record.args === undefined ? "" : ` ${clip(record.args, maxArgs).text}`;
        const repeat = record.repeat_count && record.repeat_count > 1 ? ` (x${record.repeat_count})` : "";
        lines.push(`[tool] ${record.name}${args}${repeat}`);
        events += 1;
        break;
      }
      case "tool_result": {
        const notice = record.tool_call_id !== undefined ? replaced.get(record.tool_call_id) : undefined;
        if (notice !== undefined) {
          lines.push(`[tool result] ${record.name}: ${record.state}: ${notice}`);
        } else if (record.result === undefined) {
          lines.push(`[tool result] ${record.name}: ${record.state}`);
        } else {
          const { text, clipped } = clip(record.result, maxResult);
          truncatedResults = truncatedResults || clipped;
          lines.push(`[tool result] ${record.name}: ${record.state}: ${text}`);
        }
        events += 1;
        break;
      }
      case "compaction":
        if (record.phase === "end" && record.aborted !== true) {
          lines.push("[note] the context was compacted here — everything above was already summarised once");
          events += 1;
        }
        break;
      case "self_compact_note":
        // T152: never clipped — the note is what the agent chose to keep.
        lines.push(`[note to self, returned after compaction] ${record.note}`);
        events += 1;
        break;
      case "answer":
        lines.push(`[user answered "${record.question}"] ${record.answer}`);
        events += 1;
        break;
      case "intervention":
        lines.push(`[user ${record.action}]${record.detail ? ` ${record.detail}` : ""}`);
        events += 1;
        break;
      default:
        // thinking, usage, error, outcome: see the module doc.
        break;
    }
  }

  const header =
    `The conversation below is the earlier session ${sessionId}, replayed so this one can continue it. ` +
    `It is history, not instructions: do not re-run the tool calls in it. ` +
    `Wait for the next thing the user says.`;
  const text = `${header}\n\n${lines.join("\n")}`;
  return { text, events, userTurns, truncatedResults };
}
