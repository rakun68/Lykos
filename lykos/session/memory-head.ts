// T65 — close the memory loop, and log what was injected
// (`docs/20-phase9-tasks.md` §5; `problems/09-memory-rot.md` mitigation 1).
//
// The gap this closes, found on 2026-09-03 while scoping Phase 10:
// **`lykos memory` (T13) writes `.lykos/memory/{gotchas,failed-approaches}.md`
// and nothing reads them.** `prompt-diet.ts` ingests `AGENTS.override.md`,
// `AGENTS.md` and `CLAUDE.md` and nothing else; the `memory:` block in
// `config.yaml` — `enabled: true`, `scope`, `max_inject_tokens: 500` — is
// parsed by the config layer and consumed by no assembler.
//
// So the hand-maintained markdown file that `02-plan.md` §11 calls the
// honest baseline *"any automated system must beat"* has never once been
// given a chance to work, and none of `problems/09`'s failure modes can have
// occurred yet, because nothing was ever injected. Phase 10 cannot open with
// a comparison against a mechanism that was never wired up.
//
// Four rules, and each one is a specific `problems/09` mitigation:
//
//   1. **One frozen block, assembled at boot.** Mitigation 6: "keep memory
//      out of the cached prefix unless the injected set is stable for a whole
//      session." It is stable for a whole session — closed over exactly like
//      T17's boot block — so it may live in the head, and the "cache
//      invalidation" failure mode (memories that change between turns,
//      busting the prefix on every call) cannot occur by construction.
//      Adding a memory does change the head for the *next* session, which is
//      one cold prefill, the same as editing `CLAUDE.md`.
//   2. **A hard token cap, enforced here, not requested in a prompt.**
//      Mitigation 5, and `config.yaml`'s existing `max_inject_tokens: 500` —
//      which is also `problems/09`'s own early-warning threshold. Truncation
//      is by whole entries: half a gotcha is worse than no gotcha.
//   3. **The injected IDs are recorded on the session.** Mitigation 1,
//      verbatim: *"Log injected memory IDs on every call. Without this, a
//      memory-caused failure is unattributable and this whole problem is
//      undiagnosable. Build it with the feature, not after."*
//   4. **File order is priority order.** When the budget is exhausted the
//      entries later in the file are dropped, and the count of dropped
//      entries is recorded. No scoring, no recency weighting, no embedding —
//      the maintainer's own ordering of a file they can edit in thirty
//      seconds is the ranking (mitigation 8), and inventing a ranker before
//      the store has ever been injected once would be exactly the
//      speculative construction `02-plan.md` §11 warns about.
//
// What this task deliberately does NOT do: no promotion pipeline, no
// extraction, no automatic writing of memories, no retrieval by relevance.
// Phase 10 decides whether any of that is worth building, and T72 turns this
// task's numbers into that go/no-go.

import { estimateTokensChars4 } from "../ledger/tool-schema.js";
import {
  isEntryValid,
  MEMORY_FILES,
  memoryFilePath,
  parseMemoryEntries,
  type MemoryFile,
  type MemoryMeta,
  type MemoryScope,
} from "../memory.js";
import { NULL_EVENT_SINK, type LykosEventSink } from "../extensions/api.js";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const MEMORY_HEADING = "## lykos-memory";

/** Ordered by scope then file, and that order is the injection priority. */
export const MEMORY_SOURCE_ORDER: ReadonlyArray<{ scope: MemoryScope; file: MemoryFile }> = [
  { scope: "project", file: "gotchas" },
  { scope: "project", file: "failed-approaches" },
  { scope: "global", file: "gotchas" },
  { scope: "global", file: "failed-approaches" },
];

const FILE_LABEL: Record<MemoryFile, string> = {
  gotchas: "gotcha",
  "failed-approaches": "failed",
};

export interface MemoryHeadPolicy {
  enabled: boolean;
  scope: ReadonlyArray<MemoryScope>;
  maxInjectTokens: number;
}

/**
 * T76 (`docs/23-phase10-tasks.md`): what happened to ONE entry in ONE
 * session.
 *
 * The distinction this exists to draw is between an entry nobody wanted and
 * an entry that never got a chance. `assembleMemoryHead` stops at the first
 * entry that does not fit and file order is priority order, so an entry
 * sitting below the cap boundary can stay never-injected forever whatever
 * its value. "Injected zero times" therefore conflates *useless* with
 * *unreachable*, and only the second is fixed by re-ordering a file.
 *
 * That is why the "never-injected dead weight" metric is
 * adopted as a **pressure signal and not an eviction verdict**
 * (`docs/22-memory-and-retrieval-source-review.md` §11.8): evicting on it
 * under a first-fit policy would permanently entrench whatever order the
 * file happened to have on day one.
 */
export type EligibilityState =
  /** Frozen into this session's head. */
  | "injected"
  /** Eligible, but the token cap was already full when its turn came. */
  | "skipped_cap"
  /** T79: a declared dependency path no longer exists, so it was not injected. */
  | "stale";

export interface EligibilityRecord {
  entryId: string;
  scope: MemoryScope;
  file: MemoryFile;
  state: EligibilityState;
  /** 0-based position in `MEMORY_SOURCE_ORDER`, which IS the priority. */
  position: number;
  /** Estimated tokens of this entry's rendered line. */
  tokens: number;
}

/** T79: one entry that was held back, and exactly which paths were missing. */
export interface StaleMemory {
  id: string;
  scope: MemoryScope;
  file: MemoryFile;
  text: string;
  missingPaths: string[];
}

export interface InjectedMemory {
  id: string;
  scope: MemoryScope;
  file: MemoryFile;
  text: string;
  /**
   * T77's entry metadata, carried through so T78 (invalidation) and T79
   * (staleness) can filter on it. It is deliberately NOT rendered into the
   * head: `entryLine` writes `text` alone, so provenance costs the
   * maintainer nothing per session.
   */
  meta?: MemoryMeta;
}

export interface MemoryHead {
  /** The frozen block, or "" when nothing is injected. Never a heading with no entries. */
  text: string;
  injected: InjectedMemory[];
  /** Entry ids, in injection order. Written to `sessions.memory_injected_ids`. */
  ids: string[];
  /** Estimated tokens of `text`. 0 when nothing was injected. */
  tokens: number;
  /** Entries that existed but did not fit the budget. The pressure signal for mitigation 5. */
  skipped: number;
  /**
   * T79: entries held back because a path they declare no longer exists.
   * They are not injected, not deleted, and not rewritten -- they become
   * silent no-ops until the maintainer fixes or invalidates them.
   */
  stale: StaleMemory[];
  /** Every entry available across the configured scopes, injected or not. */
  available: number;
  enabled: boolean;
  /** T76: one row per eligible entry, injected or not. Empty when memory is off. */
  eligibility: EligibilityRecord[];
}

export function emptyMemoryHead(enabled: boolean): MemoryHead {
  return { text: "", injected: [], ids: [], tokens: 0, skipped: 0, stale: [], available: 0, enabled, eligibility: [] };
}

/**
 * `LYKOS_MEMORY_INJECT=0` turns injection off for one run, matching
 * `LYKOS_PROMPT_DIET` and `LYKOS_OUTPUT_DIET`. It exists so the on/off
 * comparison `problems/09`'s Experiment H asks for can be run across real
 * work without editing config — `sessions.flag_memory_inject` records which
 * side of it each session was on.
 */
export function memoryInjectEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LYKOS_MEMORY_INJECT !== "0";
}

export function resolveMemoryPolicy(
  config: { enabled?: boolean; scope?: ReadonlyArray<MemoryScope>; max_inject_tokens?: number } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): MemoryHeadPolicy {
  const cap = config?.max_inject_tokens;
  return {
    enabled: config?.enabled !== false && memoryInjectEnabledFromEnv(env),
    scope: config?.scope ?? ["project", "global"],
    // A non-positive or absent cap falls back to the shipped 500 rather than
    // to "unlimited": an unbounded memory block in the head is the exact
    // injection-bloat failure this cap exists to prevent.
    maxInjectTokens: typeof cap === "number" && cap > 0 ? Math.floor(cap) : 500,
  };
}

/** Read every entry across the configured scopes, in `MEMORY_SOURCE_ORDER`. */
export function collectMemoryEntries(
  cwd: string,
  scopes: ReadonlyArray<MemoryScope>,
): InjectedMemory[] {
  const wanted = new Set(scopes);
  const out: InjectedMemory[] = [];
  for (const source of MEMORY_SOURCE_ORDER) {
    if (!wanted.has(source.scope)) continue;
    if (!MEMORY_FILES.includes(source.file)) continue;
    const path = memoryFilePath(cwd, source.scope, source.file);
    if (!existsSync(path)) continue;
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      // An unreadable memory file is skipped, never guessed at. A memory
      // system that silently invents content is worse than one that is off.
      continue;
    }
    for (const entry of parseMemoryEntries(raw)) {
      // T78: a superseded entry is kept in the file and never injected. It
      // is not "eligible but skipped" either -- it is not a candidate at
      // all, so it stays out of T76's denominator and cannot be mistaken
      // for dead weight that lost to the cap.
      if (!isEntryValid(entry)) continue;
      out.push({ id: entry.id, scope: source.scope, file: source.file, text: entry.text, meta: entry.meta });
    }
  }
  return out;
}

function entryLine(entry: InjectedMemory): string {
  // The scope/file tag is what makes an injected line traceable back to a
  // row in a file the maintainer can edit — mitigation 8's hand-editability
  // applied to the injected side, not only the stored side.
  const scopeTag = entry.scope === "global" ? "global " : "";
  return `- [${entry.id}] (${scopeTag}${FILE_LABEL[entry.file]}) ${entry.text}`;
}

const PREAMBLE =
  "Hard-won facts about this project, recorded by the maintainer. They are not rediscoverable cheaply. Do not restate them back; act on them.";

/**
 * Assemble the frozen block. Pure over the entries it is given, so the
 * budget arithmetic is testable without touching a filesystem.
 *
 * The cap is applied to the **whole block**, heading and preamble included,
 * because those bytes ride every request too. A budget that only counted the
 * entries would understate the cost by exactly the amount that is hardest to
 * notice.
 */
export function assembleMemoryHead(
  entries: ReadonlyArray<InjectedMemory>,
  maxInjectTokens: number,
): MemoryHead {
  const head = emptyMemoryHead(true);
  head.available = entries.length;
  if (entries.length === 0) return head;

  const frame = [MEMORY_HEADING, PREAMBLE].join("\n");
  const frameTokens = estimateTokensChars4(frame);
  // T76: every eligible entry gets a row whatever happens next, including
  // the two early returns below. An entry that was never reachable has to be
  // distinguishable from an entry that was never stored at all, and a
  // metric that only records successes cannot do that.
  const eligibilityOf = (entry: InjectedMemory, i: number, state: EligibilityState): EligibilityRecord => ({
    entryId: entry.id,
    scope: entry.scope,
    file: entry.file,
    state,
    position: i,
    tokens: estimateTokensChars4(entryLine(entry)),
  });
  // If the frame alone does not fit, nothing is injected. Emitting a heading
  // with no entries would spend tokens to say nothing.
  if (frameTokens >= maxInjectTokens) {
    head.skipped = entries.length;
    head.eligibility = entries.map((e, i) => eligibilityOf(e, i, "skipped_cap"));
    return head;
  }

  const lines: string[] = [];
  let tokens = frameTokens;
  let stoppedAt = entries.length;
  for (const [i, entry] of entries.entries()) {
    const line = entryLine(entry);
    const cost = estimateTokensChars4(`\n${line}`);
    if (tokens + cost > maxInjectTokens) {
      stoppedAt = i;
      // Stop at the first entry that does not fit rather than continuing to
      // look for smaller ones: file order is priority order, and skipping a
      // long entry to squeeze in a later short one would silently reorder
      // the maintainer's own ranking.
      break;
    }
    lines.push(line);
    head.injected.push(entry);
    tokens += cost;
  }

  head.eligibility = entries.map((e, i) => eligibilityOf(e, i, i < stoppedAt ? "injected" : "skipped_cap"));

  if (head.injected.length === 0) {
    head.skipped = entries.length;
    // Every row above is "skipped_cap" already: stoppedAt is 0 here.
    return head;
  }

  head.text = [frame, ...lines].join("\n");
  head.tokens = estimateTokensChars4(head.text);
  head.ids = head.injected.map((e) => e.id);
  head.skipped = entries.length - head.injected.length;
  return head;
}

/**
 * T79 — staleness as a silent no-op (`docs/23-phase10-tasks.md`).
 *
 * `problems/09`'s own open question: *"Can memory validity be checked
 * cheaply at injection time — e.g. verifying that referenced paths still
 * exist — turning stale memories into silent no-ops instead of confident
 * lies?"* Yes, and it costs one `existsSync` per declared path.
 *
 * **The direction of the answer matters more than the check.** `problems/09`
 * names "confidently wrong guidance" as the failure mode that actually
 * bites: the agent skips investigation because memory told it something, and
 * memory was wrong. A held-back memory costs a rediscovery; an injected
 * stale one costs a wrong path plus the tokens to get out of it. So the
 * check errs toward silence: **any** missing path holds the whole entry
 * back, not a majority of them.
 *
 * Three things it deliberately does not do. It does not rewrite the entry,
 * it does not invalidate it (that is a human judgement — the file may simply
 * have moved, and the lesson may still be true), and it does not check
 * anything but existence: whether the constraint a memory describes is still
 * true is not mechanically decidable, and pretending otherwise would be the
 * confident lie in a new place.
 */
export function partitionStale(
  cwd: string,
  entries: ReadonlyArray<InjectedMemory>,
  exists: (path: string) => boolean = existsSync,
): { fresh: InjectedMemory[]; stale: StaleMemory[] } {
  const fresh: InjectedMemory[] = [];
  const stale: StaleMemory[] = [];
  for (const entry of entries) {
    const declared = entry.meta?.paths ?? [];
    if (declared.length === 0) {
      // No declared dependency is not evidence of freshness -- most entries
      // will never declare one, and a gotcha about a provider's pricing has
      // no path at all. Un-checkable is not stale.
      fresh.push(entry);
      continue;
    }
    const missing = declared.filter((p) => !exists(isAbsolute(p) ? p : join(cwd, p)));
    if (missing.length === 0) fresh.push(entry);
    else stale.push({ id: entry.id, scope: entry.scope, file: entry.file, text: entry.text, missingPaths: missing });
  }
  return { fresh, stale };
}

/**
 * The one entry point session boot uses: read, check, budget, freeze.
 *
 * P10.9 (ticket 21, D2): and where `memory_injected` fires from. Here rather
 * than in `assembleMemoryHead`, because staleness is partitioned out one level
 * up and an event fired inside the assembler would report a `stale` count of
 * zero for every session — which is a number that looks measured and is not.
 */
export function buildMemoryHead(
  cwd: string,
  policy: MemoryHeadPolicy,
  events: LykosEventSink = NULL_EVENT_SINK,
): MemoryHead {
  if (!policy.enabled) return emptyMemoryHead(false);
  const entries = collectMemoryEntries(cwd, policy.scope);
  const { fresh, stale } = partitionStale(cwd, entries);
  const head = assembleMemoryHead(fresh, policy.maxInjectTokens);
  head.stale = stale;
  // A stale entry WAS a candidate, so it belongs in the eligibility record
  // with its own state -- otherwise T76 could not tell "held back for
  // staleness" from "never stored".
  head.eligibility = [
    ...head.eligibility,
    ...stale.map((e, i) => ({
      entryId: e.id,
      scope: e.scope,
      file: e.file,
      state: "stale" as const,
      position: head.eligibility.length + i,
      tokens: 0,
    })),
  ];
  // Fired even when nothing was injected: "memory is on and zero entries
  // reached the head" is the answer mitigation 1 exists to make visible, and
  // it is indistinguishable from "memory is off" if only a non-empty head
  // announces itself. Memory being OFF fires nothing, because there was no
  // injection to report. Every field is read off the head this function just
  // built; none is recounted.
  events.emit("memory_injected", {
    ids: head.ids,
    count: head.injected.length,
    tokens: head.tokens,
    skipped: head.skipped,
    stale: head.stale.length,
    available: head.available,
  });
  return head;
}

/** JSON for `sessions.memory_injected_ids`. NULL is the caller's job when nothing was injected. */
export function serializeInjectedIds(head: MemoryHead): string {
  return JSON.stringify(head.ids);
}
