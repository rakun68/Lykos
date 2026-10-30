// P17 T190 -- shake: a compaction that makes no model call.
//
// Shake drops what the agent
// can get again -- the text of tool results, which is where the file bodies
// and command output are -- and leaves the conversation, the agent's own
// words and every tool call as they were. Large fenced and XML blocks inside
// messages are kept: those are the agent's and the person's words, not output
// a tool would give again.
//
// The most recent 16 000 tokens are kept whole, and nothing is done unless it
// frees at least 4 000. Both are starting values, unmeasured.
//
// **Persisted by decision, like a prune** (ADR-0039). Pi's session is
// append-only and a model request is built from it afresh, so a shake is a
// `lykos-shake` record -- which tool calls, how many tokens -- applied to every
// later request (`applyShakes`) and never reconsidered. The content stays in
// the archive; only what the model is sent changes. A shake is a compaction,
// so unlike a prune it does not mind the prompt cache: it rewrites the warm
// prefix, which is why it sits after the methods that keep one.
//
// The estimate is Pi's chars/4, the same one the prune and the suffix guard
// use. `tokens_saved` is therefore an estimate and never a measurement
// (AGENTS.md rule 4).

import { randomUUID } from "node:crypto";
import { messageTokens, type MessageLike } from "./tool-result-prune.js";

/** The custom entry type a shake is persisted under. */
export const SHAKE_ENTRY_TYPE = "lykos-shake";

/** What replaces a shaken result's text. Worded for the model: what happened, and how to get it back. */
export const SHAKE_NOTICE = "[Shaken out of context: run the tool again if you need this result]";

/** The recent tail kept whole. */
export const SHAKE_PROTECT_TOKENS = 16_000;

/** Below this a shake does nothing. */
export const SHAKE_MIN_SAVINGS = 4_000;

export interface ShakeConfig {
  protectTokens: number;
  minSavings: number;
  /** Tools whose results are never dropped: their output is not something to run again. */
  protectedTools: readonly string[];
}

/** One shake, as persisted. */
export interface ShakeRecord {
  id: string;
  ts: string;
  /** The tool calls whose results were dropped. */
  tool_call_ids: string[];
  /** Estimated at Pi's chars/4 -- never a measurement. */
  tokens_saved: number;
}

const NOTICE_TOKENS = Math.ceil(SHAKE_NOTICE.length / 4);

/** The tool calls any shake has dropped. */
export function shakenIds(records: ReadonlyArray<ShakeRecord>): Set<string> {
  const ids = new Set<string>();
  for (const r of records) for (const id of r.tool_call_ids) ids.add(id);
  return ids;
}

/** Overwrite, in place, the text of every tool result named in `ids`; non-text content (an image) stays. */
export function applyShakes(messages: ReadonlyArray<object>, ids: ReadonlySet<string>): void {
  if (ids.size === 0) return;
  for (const raw of messages) {
    const m = raw as MessageLike;
    if (m.role !== "toolResult" || m.toolCallId === undefined || !ids.has(m.toolCallId)) continue;
    const kept = Array.isArray(m.content) ? (m.content as Array<{ type?: string }>).filter((b) => b.type !== "text") : [];
    m.content = [{ type: "text", text: SHAKE_NOTICE }, ...kept];
  }
}

/**
 * Decide a shake over `messages` (already carrying `already`'s shakes).
 * Returns undefined when nothing is worth dropping: no eligible result, or
 * fewer than `minSavings` tokens to free.
 */
export function planShake(
  messages: ReadonlyArray<object>,
  already: ReadonlySet<string>,
  config: ShakeConfig,
  now: number = Date.now(),
): ShakeRecord | undefined {
  const list = messages as ReadonlyArray<MessageLike & { toolName?: string }>;
  let after = 0;
  const ids: string[] = [];
  let saved = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    const tokens = messageTokens(m);
    const inTail = after < config.protectTokens;
    after += tokens;
    if (inTail || m.role !== "toolResult" || m.toolCallId === undefined || already.has(m.toolCallId)) continue;
    if (m.toolName !== undefined && config.protectedTools.includes(m.toolName)) continue;
    const gain = tokens - NOTICE_TOKENS;
    if (gain <= 0) continue;
    ids.push(m.toolCallId);
    saved += gain;
  }
  if (ids.length === 0 || saved < config.minSavings) return undefined;
  return { id: randomUUID(), ts: new Date(now).toISOString(), tool_call_ids: ids.reverse(), tokens_saved: saved };
}

/** Every shake record in a Pi session's entries, in order. */
export function shakeRecordsFromEntries(
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): ShakeRecord[] {
  const out: ShakeRecord[] = [];
  for (const e of entries) {
    if (e.type !== "custom" || e.customType !== SHAKE_ENTRY_TYPE) continue;
    const record = shakeRecordFromData(e.data);
    if (record !== undefined) out.push(record);
  }
  return out;
}

/** One `lykos-shake` entry's data as a record, or undefined when it is not a whole one. */
export function shakeRecordFromData(data: unknown): ShakeRecord | undefined {
  const d = data as Partial<ShakeRecord> | undefined;
  if (
    d !== undefined && d !== null && typeof d.id === "string" && typeof d.ts === "string" && typeof d.tokens_saved === "number" &&
    Array.isArray(d.tool_call_ids) && d.tool_call_ids.every((id) => typeof id === "string")
  ) {
    return d as ShakeRecord;
  }
  return undefined;
}
