// T188 -- prune superseded reads and useless results every turn, without
// breaking the prompt cache.
//
// Two prunes, both on by default:
//
//   - **supersede reads.** An earlier `read` result that a newer read of the
//     same file has made stale is overwritten with `[Superseded by a newer read
//     of this file]`. A selector-free read supersedes a read of the same path
//     with a selector; two reads with the same selector supersede; a selector
//     read never supersedes a selector-free one. The selector is the pair
//     `offset`/`limit`.
//   - **drop useless.** A result whose tool flagged it useless
//     (`details.useless === true`) is overwritten with `[Uneventful result
//     elided]`. No tool sets the flag today: it is a hook for a tool that knows
//     its own result says nothing (zero matches, an elapsed wait).
//
// **The cache guard** is three rules. A result is rewritten only when
// at most 8 000 estimated tokens follow it (`DEFAULT_SUFFIX_TOKEN_LIMIT`): a
// rewrite inside the warm, already-sent prefix turns every cache read after it
// into a cache write. A deeper
// candidate waits, and the whole sent region is rewritten only once the last
// model response is older than the cache retention (`cacheRetentionMs`), when
// the provider's cache has expired anyway. The idle cutoff is the retention Pi
// is configured with plus a margin, and the comparison is strictly greater. The third rule -- never touch entries before the
// latest compaction's kept boundary -- needs no code here: the `context` event
// carries only what Pi sends, so a summarised-away entry is not in the messages.
//
// **Persisted by decision, not by rewrite.** Pi's session is append-only, and
// the history Lykos resumes is the transcript, not Pi's entries. So a prune is
// a `lykos-prune` record (this file's `PruneRecord`): which tool calls, which
// notice, how many tokens it freed. Every model request applies the recorded
// prunes to Pi's messages (`applyPrunes`) and decides new ones (`planPrunes`).
// A decision is made once and never reconsidered, so the sent prefix stays
// byte-stable; the live-capture copies the record into the transcript and the
// replay a resume sends renders the result as its notice.
//
// **What is never a superseder.** A failed read (it says nothing about the
// file), and a read the diet collapsed to the unchanged stub (it points back at
// the earlier read, which must therefore stay whole).

import { randomUUID } from "node:crypto";
import { PRUNE_EXTENSION } from "../extensions/defaults/index.js";
import { unchangedMarker } from "./prompt-diet.js";
import { resolveActualToolArgs, resolveActualToolName } from "../tools/tool-call.js";

/** Exact text written over a superseded read. */
export const SUPERSEDED_NOTICE = "[Superseded by a newer read of this file]";

/** Exact text written over a result its tool flagged useless. */
export const USELESS_NOTICE = "[Uneventful result elided]";

/** The custom entry type a prune is persisted under. */
export const PRUNE_ENTRY_TYPE = "lykos-prune";

export const DEFAULT_SUFFIX_TOKEN_LIMIT = 8_000;

export type PruneKind = "superseded" | "useless";

/** `tail`: inside the cheap-to-recache suffix. `idle`: the cache had expired. */
export type PruneReason = "tail" | "idle";

/** The one lookup from a prune's kind to the text the model is sent. */
export const PRUNE_NOTICES: Readonly<Record<PruneKind, string>> = { superseded: SUPERSEDED_NOTICE, useless: USELESS_NOTICE };

/**
 * The one way a tool marks a result useless: spread this into the result's
 * `details`, for a bare empty lookup (no definition, no references, zero
 * matches) -- a result that says nothing once it has been read.
 * It is never set on a failed result, and a clean diagnostics run is evidence,
 * not uselessness.
 */
export interface UselessMark {
  useless: true;
}
export const USELESS_DETAILS: Readonly<UselessMark> = { useless: true };

/** True only for an explicit `useless: true` in a result's `details`. */
export function isUselessResult(details: unknown): boolean {
  return typeof details === "object" && details !== null && (details as { useless?: unknown }).useless === true;
}

/** The two rule switches `lykos-prune` reads at load: `compaction.supersede_reads` and `compaction.drop_useless`. */
export const PRUNE_POLICY_ENV = "LYKOS_PRUNE_POLICY";

export interface PrunePolicyEnv {
  supersedeReads: boolean;
  dropUseless: boolean;
}

export function encodePrunePolicyEnv(policy: PrunePolicyEnv): string {
  return JSON.stringify(policy);
}

/** Null on anything malformed or absent -- the extension then does nothing, as outside Lykos. */
export function decodePrunePolicyEnv(raw: string | undefined): PrunePolicyEnv | null {
  if (raw === undefined || raw === "") return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    if (typeof p.supersedeReads !== "boolean" || typeof p.dropUseless !== "boolean") return null;
    return { supersedeReads: p.supersedeReads, dropUseless: p.dropUseless };
  } catch {
    return null;
  }
}

/** The knobs and the cache guard, as the extension resolves them for one request. */
export interface PrunePolicy {
  supersedeReads: boolean;
  dropUseless: boolean;
  /** A candidate with more than this many tokens after it waits. */
  suffixTokenLimit: number;
  /** The last model response strictly older than this means the provider cache has expired. */
  idleFlushMs: number;
}

/** One prune pass, as persisted and as the ledger's `prunes` row. */
export interface PruneRecord {
  id: string;
  ts: string;
  /** The tool calls whose results were overwritten, each with the notice kind. */
  entries: Array<{ id: string; kind: PruneKind }>;
  superseded: number;
  useless: number;
  /** Estimated at Pi's chars/4, the same estimate the suffix guard uses -- never a measurement. */
  tokens_saved: number;
  reason: PruneReason;
}

export interface PrunePlan {
  record: PruneRecord;
}

/** The slice of a Pi message this module reads and writes. */
export interface MessageLike {
  role?: string;
  content?: unknown;
  timestamp?: number;
  toolCallId?: string;
  isError?: boolean;
  details?: unknown;
}

const IMAGE_TOKENS = 1_200;

function blockTokens(block: unknown): number {
  if (block === null || typeof block !== "object") return 0;
  const b = block as { type?: string; text?: string; thinking?: string; arguments?: unknown; name?: string };
  if (b.type === "text") return Math.ceil((b.text ?? "").length / 4);
  if (b.type === "thinking") return Math.ceil((b.thinking ?? "").length / 4);
  if (b.type === "image") return IMAGE_TOKENS;
  if (b.type === "toolCall") return Math.ceil(((b.name ?? "").length + JSON.stringify(b.arguments ?? {}).length) / 4);
  return 0;
}

export function messageTokens(message: MessageLike): number {
  if (typeof message.content === "string") return Math.ceil(message.content.length / 4);
  if (!Array.isArray(message.content)) return 0;
  return message.content.reduce((sum: number, block: unknown) => sum + blockTokens(block), 0);
}

function noticeTokens(kind: PruneKind): number {
  return Math.ceil(PRUNE_NOTICES[kind].length / 4);
}

/** The recorded prunes as a lookup: tool call id to notice kind. */
export function pruneMap(records: ReadonlyArray<PruneRecord>): Map<string, PruneKind> {
  const map = new Map<string, PruneKind>();
  for (const r of records) for (const e of r.entries) map.set(e.id, e.kind);
  return map;
}

/** Overwrite, in place, the content of every tool result named in `pruned`. */
export function applyPrunes(messages: ReadonlyArray<object>, pruned: ReadonlyMap<string, PruneKind>): void {
  if (pruned.size === 0) return;
  for (const raw of messages) {
    const m = raw as MessageLike;
    if (m.role !== "toolResult" || m.toolCallId === undefined) continue;
    const kind = pruned.get(m.toolCallId);
    if (kind !== undefined) m.content = [{ type: "text", text: PRUNE_NOTICES[kind] }];
  }
}

/**
 * How long the provider keeps a prompt prefix, from Pi's `PI_CACHE_RETENTION`
 * (`short` unless `long`) and the model's api. Read from Pi 0.84.3's provider
 * code, not its README: `long` sends `ttl: "1h"` on the `anthropic-messages`
 * api and `prompt_cache_retention: "24h"` on the OpenAI apis; `short` names no
 * figure anywhere in Pi; Bedrock `long` sends a one-hour cache point TTL
 * (`bedrock-converse-stream.js`). So Anthropic and Bedrock long, one hour, are
 * Pi's figures. The five
 * minutes for Anthropic short is Anthropic's documented default for an
 * ephemeral breakpoint with no ttl, and every other pairing takes the
 * conservative (longer) figure, because a flush that comes too early rewrites a
 * still-warm prefix while one that comes late costs nothing.
 */
export function cacheRetentionMs(env: Readonly<Record<string, string | undefined>>, api: string | undefined): number {
  const MIN = 60_000;
  const anthropic = api === "anthropic-messages";
  if (env.PI_CACHE_RETENTION === "long") return anthropic || api === "bedrock-converse-stream" ? 60 * MIN : 24 * 60 * MIN;
  return anthropic ? 5 * MIN : 60 * MIN;
}

/** Beyond the retention, so the flush never lands while the cache is merely expiring. */
export const IDLE_MARGIN_MS = 60_000;

/** The idle cutoff for `PrunePolicy.idleFlushMs`: it must exceed the cache retention. */
export function idleFlushMs(env: Readonly<Record<string, string | undefined>>, api: string | undefined): number {
  return cacheRetentionMs(env, api) + IDLE_MARGIN_MS;
}

/** `read`'s supersede key: the path, plus the range when `offset` or `limit` narrows it. */
function readKey(args: unknown): { path: string; selector: string | undefined } | undefined {
  if (args === null || typeof args !== "object") return undefined;
  const a = args as { path?: unknown; offset?: unknown; limit?: unknown };
  if (typeof a.path !== "string" || a.path.length === 0 || a.path.includes("://")) return undefined;
  const path = a.path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  const hasSelector = typeof a.offset === "number" || typeof a.limit === "number";
  return { path, selector: hasSelector ? `${String(a.offset ?? "")}:${String(a.limit ?? "")}` : undefined };
}

function resultText(m: MessageLike): string | undefined {
  if (!Array.isArray(m.content) || m.content.length !== 1) return undefined;
  const block = m.content[0] as { type?: string; text?: string };
  return block.type === "text" ? block.text : undefined;
}

/**
 * Decide this request's new prunes. `messages` already have `prior` applied.
 * Returns undefined when nothing is to be pruned; otherwise the record to
 * persist, whose map the caller then applies with `applyPrunes`.
 */
export function planPrunes(
  messages: ReadonlyArray<object>,
  prior: ReadonlyMap<string, PruneKind>,
  policy: PrunePolicy,
  now: number,
): PrunePlan | undefined {
  if (!policy.supersedeReads && !policy.dropUseless) return undefined;
  const list = messages as ReadonlyArray<MessageLike>;
  const calls = new Map<string, { name: string | undefined; args: unknown }>();
  for (const m of list) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as Array<{ type?: string; id?: string; name?: string; arguments?: unknown }>) {
      if (block.type === "toolCall" && typeof block.id === "string") {
        calls.set(block.id, { name: resolveActualToolName(block.name, block.arguments), args: resolveActualToolArgs(block.name, block.arguments) });
      }
    }
  }

  const candidates: Array<{ index: number; id: string; kind: PruneKind; saved: number }> = [];
  const seen = new Set<string>();
  const bareSeen = new Set<string>();
  const consider = (index: number, kind: PruneKind): void => {
    const m = list[index]!;
    const saved = messageTokens(m) - noticeTokens(kind);
    if (saved > 0) candidates.push({ index, id: m.toolCallId!, kind, saved });
  };
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!;
    if (m.role !== "toolResult" || m.toolCallId === undefined || m.isError === true) continue;
    if (prior.has(m.toolCallId)) continue;
    if (policy.dropUseless && isUselessResult(m.details)) {
      consider(i, "useless");
      continue;
    }
    if (!policy.supersedeReads) continue;
    const call = calls.get(m.toolCallId);
    if (call?.name !== "read") continue;
    const key = readKey(call.args);
    if (key === undefined) continue;
    if (resultText(m) === unchangedMarker(key.path)) continue;
    const superseded = key.selector === undefined ? bareSeen.has(key.path) : bareSeen.has(key.path) || seen.has(`${key.path}\0${key.selector}`);
    if (key.selector === undefined) bareSeen.add(key.path);
    else seen.add(`${key.path}\0${key.selector}`);
    if (superseded) consider(i, "superseded");
  }
  if (candidates.length === 0) return undefined;

  let lastResponse: number | undefined;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]!.role === "assistant" && typeof list[i]!.timestamp === "number") {
      lastResponse = list[i]!.timestamp;
      break;
    }
  }
  const idle = lastResponse !== undefined && now - lastResponse > policy.idleFlushMs;

  let chosen = candidates;
  if (!idle) {
    const suffix = new Array<number>(list.length);
    let after = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      suffix[i] = after;
      after += messageTokens(list[i]!);
    }
    chosen = candidates.filter((c) => suffix[c.index]! <= policy.suffixTokenLimit);
  }
  if (chosen.length === 0) return undefined;

  chosen.sort((a, b) => a.index - b.index);
  return {
    record: {
      id: randomUUID(),
      ts: new Date(now).toISOString(),
      entries: chosen.map((c) => ({ id: c.id, kind: c.kind })),
      superseded: chosen.filter((c) => c.kind === "superseded").length,
      useless: chosen.filter((c) => c.kind === "useless").length,
      tokens_saved: chosen.reduce((sum, c) => sum + c.saved, 0),
      reason: idle ? "idle" : "tail",
    },
  };
}

/** A prune record without its entry list: the `prunes` ledger row's figures. */
export type PruneRow = Omit<PruneRecord, "entries">;

/**
 * A prune record's `prunes` ledger row, or undefined when the record lacks a
 * field (a malformed entry writes no row rather than a guessed one). The one
 * place boot and the transcript read a record's figures.
 */
export function pruneRowFromEntry(data: unknown): PruneRow | undefined {
  const d = prunePartialFromEntry(data);
  if (
    d.id === undefined || d.ts === undefined || d.superseded === undefined || d.useless === undefined ||
    d.tokens_saved === undefined || d.reason === undefined
  ) {
    return undefined;
  }
  return { id: d.id, ts: d.ts, superseded: d.superseded, useless: d.useless, tokens_saved: d.tokens_saved, reason: d.reason };
}

/**
 * The fields of a prune record that are present and well typed, each one
 * absent otherwise: never 0, never a guessed reason. The transcript line keeps
 * what a record carries; `pruneRowFromEntry` insists on all of it.
 */
export function prunePartialFromEntry(data: unknown): Partial<PruneRecord> {
  const d = (data ?? {}) as Partial<PruneRecord>;
  const out: Partial<PruneRecord> = {};
  if (typeof d.id === "string") out.id = d.id;
  if (typeof d.ts === "string") out.ts = d.ts;
  if (Array.isArray(d.entries)) out.entries = d.entries;
  if (typeof d.superseded === "number") out.superseded = d.superseded;
  if (typeof d.useless === "number") out.useless = d.useless;
  if (typeof d.tokens_saved === "number") out.tokens_saved = d.tokens_saved;
  if (d.reason === "tail" || d.reason === "idle") out.reason = d.reason;
  return out;
}

/** Whether either prune rule is on, i.e. whether `lykos-prune` has anything to do. */
export function pruneRulesOn(knobs: { supersedeReads: boolean; dropUseless: boolean }): boolean {
  return knobs.supersedeReads || knobs.dropUseless;
}

/**
 * A warning when a rule is on but nothing will run it. An `extensions:` list
 * replaces the shipped one, so a project with its own list that omits
 * `lykos-prune` prunes nothing while `compaction.supersede_reads: true` reads
 * as on. `extensionNames` is the resolved list.
 */
export function pruneNotice(
  knobs: { supersedeReads: boolean; dropUseless: boolean },
  extensionNames: readonly string[],
): string | undefined {
  if (!pruneRulesOn(knobs)) return undefined;
  if (extensionNames.includes(PRUNE_EXTENSION)) return undefined;
  return (
    `lykos: compaction.supersede_reads / drop_useless are on but ${PRUNE_EXTENSION} is not in the resolved ` +
    `extensions: list (a project's list replaces the shipped one), so no tool result will be pruned; ` +
    `add \`- { name: ${PRUNE_EXTENSION} }\` to extensions:`
  );
}

/** Every prune record in a Pi session's entries, in order. */
export function pruneRecordsFromEntries(
  entries: ReadonlyArray<{ type: string; customType?: string; data?: unknown }>,
): PruneRecord[] {
  const out: PruneRecord[] = [];
  for (const e of entries) {
    if (e.type !== "custom" || e.customType !== PRUNE_ENTRY_TYPE) continue;
    const d = prunePartialFromEntry(e.data);
    if (d.id !== undefined && d.entries !== undefined) out.push(d as PruneRecord);
  }
  return out;
}
