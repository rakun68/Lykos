// The five memory tools, over the store `lykos/memory/` already is.
//
// **ONE MODULE, FIVE DEFINITIONS (D1).** Five files for five tools over one
// store would put `retain` and `recall` in different files for no reason
// either of them cares about, and would need the dependency object copied
// five times. `MemoryStoreAccess` below is that object, injected, so a test
// never touches the developer's own `.lykos/memory/` (D9) — including the
// GLOBAL scope, which `memoryFilePath` resolves under `homedir()` and which a
// test pointing only `cwd` at a temporary directory would still write into.
//
// **`retain` PROPOSES AND NEVER ACTIVATES, AND THAT IS STRUCTURAL (D2).**
// ADR-0017 dropped the mistakes-only scope restriction and KEPT the
// acceptance rule, because a model that believes it has taught the system
// something it has not is worse than no memory at all: it will stop
// re-deriving a fact that was never stored, and it will say so to a human who
// has no reason to doubt it. So every write a tool can reach ends in
// `proposeMemory`, which writes `.lykos/memory/proposed.md` — a file
// `MEMORY_SOURCE_ORDER` does not name and therefore a file no prompt can ever
// be assembled from. `acceptProposal` is NOT a member of `MemoryStoreAccess`;
// it is reachable only from `lykos memory accept`. "No tool can activate a
// memory" is thus a fact about what these definitions are handed, not a rule
// somebody has to remember, and `memory-tools.test.ts` asserts it by trying.
//
// The result text says so in a sentence the model reads, every time, and says
// what to do instead. A quiet success is exactly the failure mode above.
//
// **WHERE A PROPOSAL LIVES (D3) — READ, NOT ASSUMED.** `lykos/memory/` HAS a
// proposal mechanism: T81's queue, with a repetition gate, a human-only
// accept and provenance, in the same markdown format as the store. It was
// sitting in `cli/memory-propose.ts`, so this ticket moved its domain half to
// `memory/proposals.ts` and changed nothing about how it works. No second
// storage format was invented and no database was added; the one new thing in
// the format is `from=`, a recognised meta key for D7's exchange.
//
// **`recall` SEARCHES WHAT THE STORE SUPPORTS (D4).** Substring and scope
// filters over the parsed entries, honouring `isEntryValid` so an invalidated
// entry is never returned. No embeddings and no index — ADR-0016 makes that a
// later, separately-built backend, and a half-built index is worse than none.
// Every hit carries its identifier and its provenance, because `memory_edit`
// takes an identifier and a model that cannot see one cannot use it.
//
// **`reflect` DOES NOT READ THE STORE INTO CONTEXT (D5).** Counts, the newest
// few titles truncated, and how many proposals are waiting. The question is
// "what do you know", and answering it by pasting everything defeats the
// point of asking.
//
// **`memory_edit` INVALIDATES; IT DOES NOT DELETE (D6).** `removeMemoryEntry`
// exists for the CLI's `--purge` and is likewise not a member of
// `MemoryStoreAccess`. An amend is an invalidation plus a fresh proposal, so
// the superseded claim stays on the line where it was and the replacement
// waits for a human like every other proposal.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOLS ARE ADDED (CLAUDE.md
// rule 3): these five ride NO request.** All mounted with `hidden` prompt
// presence (D8), reached through `tool_call`. The measured numbers are
// asserted in `memory-tools.test.ts`, so a description that doubles the bill
// fails a test rather than passing silently.

import { existsSync, readFileSync } from "node:fs";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  invalidateMemoryEntry,
  isEntryValid,
  isMemoryFile,
  isMemoryScope,
  MEMORY_FILES,
  MEMORY_SCOPES,
  memoryFilePath,
  parseMemoryEntries,
  proposalSeenCount,
  proposeMemory,
  readProposals,
  renderEntryMeta,
  DEFAULT_PROMOTE_AFTER,
  type InvalidateResult,
  type MemoryEntry,
  type MemoryFile,
  type MemoryScope,
  type ProposeOptions,
  type ProposeResult,
} from "../memory.js";

export const RETAIN_TOOL_NAME = "retain";
export const RECALL_TOOL_NAME = "recall";
export const REFLECT_TOOL_NAME = "reflect";
export const MEMORY_EDIT_TOOL_NAME = "memory_edit";
export const LEARN_TOOL_NAME = "learn";

/** The five, in the order the plan builds them. Exported so the registration site cannot drift from this module. */
export const MEMORY_TOOL_NAMES = [
  RETAIN_TOOL_NAME,
  RECALL_TOOL_NAME,
  MEMORY_EDIT_TOOL_NAME,
  REFLECT_TOOL_NAME,
  LEARN_TOOL_NAME,
] as const;

/** How many hits `recall` returns before it says it stopped. */
export const RECALL_DEFAULT_LIMIT = 20;

/** How many titles `reflect` prints. D5: a summary, not a dump. */
export const REFLECT_TITLE_COUNT = 5;

/** How wide one `reflect` title is printed before it is elided. */
const REFLECT_TITLE_WIDTH = 80;

/** How much of a `learn` exchange is kept as provenance. A whole transcript on one markdown line is not readable by the human who has to accept it. */
export const LEARN_EXCHANGE_WIDTH = 400;

/**
 * Everything these five tools may do to the store, and deliberately nothing
 * more.
 *
 * What is ABSENT is the load-bearing part: no `acceptProposal`, so no tool can
 * activate a memory (D2), and no `removeMemoryEntry`, so no tool can delete
 * one (D6). Both exist in `memory.ts` and both are reachable from the CLI,
 * where a human is the one typing.
 */
export interface MemoryStoreAccess {
  filePath: (cwd: string, scope: MemoryScope, file: MemoryFile) => string;
  /** Every entry in one file, invalidated ones included. Empty for a file that does not exist. */
  readEntries: (path: string) => MemoryEntry[];
  propose: (cwd: string, text: string, opts: ProposeOptions) => ProposeResult;
  /** Every row of the proposal queue, accepted ones included. */
  proposals: (cwd: string) => MemoryEntry[];
  invalidate: (path: string, idOrMatch: string, opts: { reason?: string; by?: string }) => InvalidateResult;
}

/** The real store. A test passes its own, pointed at a temporary directory (D9). */
export const LOCAL_MEMORY_STORE: MemoryStoreAccess = {
  filePath: memoryFilePath,
  readEntries(path) {
    if (!existsSync(path)) return [];
    try {
      return parseMemoryEntries(readFileSync(path, "utf8"));
    } catch {
      // An unreadable memory file is skipped, never guessed at — the same
      // answer `collectMemoryEntries` gives, for the same reason.
      return [];
    }
  },
  propose: proposeMemory,
  proposals: (cwd) => readProposals(cwd).entries,
  invalidate: invalidateMemoryEntry,
};

export interface MemoryToolsOpts {
  cwd: string;
  /** Omitted, the real store. Injected by every test (D9). */
  store?: MemoryStoreAccess;
  /** Stamped on a proposal as `src=`, so a bad memory is traceable to the session that proposed it. */
  sessionId?: string;
  /** Injectable clock, so a test can assert a date. */
  now?: () => Date;
}

// --------------------------------------------------------------- shared bits

/**
 * One lesson is one line of markdown, because the store IS markdown and
 * `parseMemoryEntries` reads a line at a time. A model handed a free-text
 * field will eventually send a paragraph, and a paragraph written unflattened
 * would put every line after the first into the file as prose — silently
 * losing most of the memory while reporting success.
 */
function flattenLesson(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * A metadata VALUE additionally may not contain a brace: the meta group is
 * matched with `[^{}]*`, so one brace inside it would send the whole line back
 * to being plain text and lose every other key on it. Braces are stripped from
 * values only — the lesson text itself keeps them, because a gotcha about code
 * usually is code.
 */
function flattenForMeta(text: string, width: number): string {
  const flat = flattenLesson(text).replace(/[{}]/g, "");
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

function text(s: string) {
  return [{ type: "text" as const, text: s }];
}

/**
 * One result shape for every branch. `memory_edit` returns five different
 * `details` objects and TypeScript, under `exactOptionalPropertyTypes`, will
 * not unify them on its own — naming the shape once is cheaper than five
 * casts, and keeps `isError` from being forgotten on a refusal.
 */
interface MemoryToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  details: Record<string, unknown>;
}

function out(body: string, details: Record<string, unknown>, isError = false): MemoryToolResult {
  return { content: text(body), isError, details };
}

function resolveFile(raw: string | undefined): MemoryFile {
  if (raw === undefined) return "gotchas";
  if (!isMemoryFile(raw)) {
    throw new Error(
      `lykos memory: unknown file "${raw}". There are two: ${MEMORY_FILES.join(", ")}.`,
    );
  }
  return raw;
}

function resolveScopes(raw: string | undefined): MemoryScope[] {
  if (raw === undefined) return [...MEMORY_SCOPES];
  if (!isMemoryScope(raw)) {
    throw new Error(`lykos memory: unknown scope "${raw}". There are two: ${MEMORY_SCOPES.join(", ")}.`);
  }
  return [raw];
}

interface LocatedEntry {
  entry: MemoryEntry;
  scope: MemoryScope;
  file: MemoryFile;
  path: string;
}

/** Every entry in scope, in `MEMORY_SOURCE_ORDER`'s order, tagged with where it came from. */
function collect(
  store: MemoryStoreAccess,
  cwd: string,
  scopes: readonly MemoryScope[],
  files: readonly MemoryFile[],
): LocatedEntry[] {
  const out: LocatedEntry[] = [];
  for (const scope of scopes) {
    for (const file of files) {
      const path = store.filePath(cwd, scope, file);
      for (const entry of store.readEntries(path)) out.push({ entry, scope, file, path });
    }
  }
  return out;
}

function located(hit: LocatedEntry): string {
  return `[${hit.entry.id}] (${hit.scope}/${hit.file}) ${hit.entry.text}${renderEntryMeta(hit.entry.meta)}`;
}

/**
 * The sentence D2 is about. It is exported, and asserted verbatim by the
 * test, so it cannot be softened into "saved" by a later edit that means well.
 */
export const PROPOSAL_NOTICE =
  "This is a PROPOSAL, not an active memory. It is queued in .lykos/memory/proposed.md, which no prompt is " +
  "ever assembled from, and only a human running `lykos memory accept <id>` can activate it. No tool can — " +
  "not this one, not on a later call. Do not assume Lykos now knows this: if it matters for the work in front " +
  "of you, act on it yourself and say it out loud.";

function proposalReport(r: ProposeResult, target: MemoryFile): string {
  const seen =
    r.seen >= DEFAULT_PROMOTE_AFTER
      ? `Proposed ${r.seen} times, so a human may now accept it.`
      : `Proposed ${r.seen} time${r.seen === 1 ? "" : "s"}; a human may accept it after ${DEFAULT_PROMOTE_AFTER} independent proposals.`;
  return `Queued [${r.id}] for ${target}. ${seen}\n\n${PROPOSAL_NOTICE}`;
}

// --------------------------------------------------------------------- retain

export const RETAIN_DESCRIPTION =
  "Propose a durable memory about this project. It is NOT stored as something Lykos knows: it is queued for a " +
  "human to accept, and until they do it is never injected into any prompt and never returned by recall. No " +
  "tool can accept it, including this one. Write one self-contained sentence — what is true, and why it is not " +
  "cheaply rediscoverable — because the human reading the queue has only that line. `file` picks which of the " +
  "two stores it would land in: gotchas for a constraint or a trap, failed-approaches for something tried and " +
  "abandoned. `paths` names the files the claim depends on, and a memory whose paths have moved is held back " +
  "as stale rather than asserted.";

export const RETAIN_PARAMETERS = Type.Object({
  memory: Type.String({
    description: "One self-contained sentence. What is true about this project, and why it was expensive to find out.",
  }),
  file: Type.Optional(
    Type.String({ description: "gotchas (a constraint or trap) or failed-approaches (tried and abandoned). Default gotchas." }),
  ),
  paths: Type.Optional(
    Type.Array(Type.String(), { description: "Files this claim depends on. If one of them disappears the memory is held back as stale." }),
  ),
});

export function buildRetainTool(opts: MemoryToolsOpts): ToolDefinition {
  const store = opts.store ?? LOCAL_MEMORY_STORE;
  return defineTool({
    name: RETAIN_TOOL_NAME,
    label: "Retain",
    description: RETAIN_DESCRIPTION,
    promptSnippet: "Propose a memory for a human to accept",
    promptGuidelines: [
      "Proposing is not storing. Never tell anyone Lykos has learned something because retain returned successfully.",
    ],
    parameters: RETAIN_PARAMETERS,
    async execute(_id, params) {
      const lesson = flattenLesson(params.memory);
      if (lesson.length === 0) {
        throw new Error("lykos retain: memory is empty. An empty proposal is a mistake, not a no-op.");
      }
      const target = resolveFile(params.file);
      const paths = (params.paths ?? []).map((p) => p.trim()).filter((p) => p.length > 0);
      const result = store.propose(opts.cwd, lesson, {
        file: target,
        ...(opts.sessionId !== undefined ? { src: opts.sessionId } : {}),
        ...(paths.length > 0 ? { paths } : {}),
        ...(opts.now !== undefined ? { now: opts.now() } : {}),
      });
      return {
        content: text(proposalReport(result, target)),
        // `active: false` is in the details for the same reason the sentence
        // is in the text: a caller reading the structured half must not have
        // to infer it.
        details: {
          id: result.id,
          seen: result.seen,
          status: result.status,
          target,
          active: false,
          awaitingHuman: true,
        },
      };
    },
  }) as ToolDefinition;
}

// --------------------------------------------------------------------- recall

export const RECALL_DESCRIPTION =
  "Search the memories a human has accepted. Matching is a plain case-insensitive substring over the memory " +
  "text, or an exact identifier — there is no index and no semantic search, so search for a word that would " +
  "literally appear, and omit `query` to list everything in scope. Every hit carries its identifier, which is " +
  "what memory_edit takes, and its provenance: when it was added, which session proposed it, and which files " +
  "it depends on. Invalidated memories are never returned, and neither are proposals: a proposal is not a " +
  "memory until a human accepts it.";

export const RECALL_PARAMETERS = Type.Object({
  query: Type.Optional(
    Type.String({ description: "Case-insensitive substring of the memory text, or an exact id. Omit to list everything in scope." }),
  ),
  scope: Type.Optional(Type.String({ description: "project or global. Omit for both." })),
  file: Type.Optional(Type.String({ description: "gotchas or failed-approaches. Omit for both." })),
  limit: Type.Optional(Type.Number({ description: `Maximum hits to return (default ${RECALL_DEFAULT_LIMIT}).` })),
});

export function buildRecallTool(opts: MemoryToolsOpts): ToolDefinition {
  const store = opts.store ?? LOCAL_MEMORY_STORE;
  return defineTool({
    name: RECALL_TOOL_NAME,
    label: "Recall",
    description: RECALL_DESCRIPTION,
    promptSnippet: "Search the memories a human has accepted",
    parameters: RECALL_PARAMETERS,
    async execute(_id, params) {
      const scopes = resolveScopes(params.scope);
      const files = params.file === undefined ? [...MEMORY_FILES] : [resolveFile(params.file)];
      const limit =
        params.limit !== undefined && params.limit > 0 ? Math.floor(params.limit) : RECALL_DEFAULT_LIMIT;
      const all = collect(store, opts.cwd, scopes, files);
      // T78 / `isEntryValid`: a superseded entry is not a low-ranked hit, it
      // is not a candidate at all. Counted, though, so "no matches" and "three
      // matches you retired" are distinguishable answers.
      const active = all.filter((h) => isEntryValid(h.entry));
      const invalidated = all.length - active.length;

      const q = params.query?.trim().toLowerCase() ?? "";
      const hits =
        q.length === 0
          ? active
          : active.filter((h) => h.entry.id === q || h.entry.text.toLowerCase().includes(q));
      const shown = hits.slice(0, limit);

      const body = shown.map(located);
      const footer: string[] = [];
      if (hits.length === 0) {
        footer.push(
          "No accepted memory matches. This is not evidence the claim is false — it is evidence nobody has " +
            "written it down and had it accepted.",
        );
      } else {
        footer.push(`${hits.length} memor${hits.length === 1 ? "y" : "ies"} matched.`);
      }
      if (shown.length < hits.length) footer.push(`Stopped at the ${limit}-hit limit; narrow the query or raise limit.`);
      if (invalidated > 0) {
        footer.push(
          `${invalidated} invalidated entr${invalidated === 1 ? "y was" : "ies were"} skipped: superseded, kept on ` +
            "the line where they were, never recalled.",
        );
      }
      const pending = store.proposals(opts.cwd).filter((e) => !e.meta.invalid).length;
      if (pending > 0) {
        footer.push(
          `${pending} proposal${pending === 1 ? " is" : "s are"} queued and NOT searched here — a proposal is not a ` +
            "memory until a human accepts it.",
        );
      }

      return {
        content: text([...body, ...(body.length > 0 ? [""] : []), ...footer].join("\n").trimEnd()),
        details: { matched: hits.length, returned: shown.length, invalidatedSkipped: invalidated, pending },
      };
    },
  }) as ToolDefinition;
}

// ---------------------------------------------------------------- memory_edit

export const MEMORY_EDIT_DESCRIPTION =
  "Retire an accepted memory by identifier, or amend one. `invalidate` marks it superseded: the line stays in " +
  "the file with a date and your reason, and it stops being recalled and injected from that moment. `amend` is " +
  "an invalidation plus a fresh PROPOSAL of the corrected `text` — never an in-place rewrite, so the claim that " +
  "was wrong and the correction are both on the record, and the correction waits for a human exactly like any " +
  "other proposal. Nothing here deletes anything. Get the identifier from recall; if it matches entries in more " +
  "than one file the call is refused and names them.";

export const MEMORY_EDIT_PARAMETERS = Type.Object({
  op: Type.String({ description: "invalidate or amend." }),
  id: Type.String({ description: "The identifier from recall, e.g. a1b2c3d4. A substring of the memory text also works if it is unambiguous." }),
  reason: Type.Optional(Type.String({ description: "Why it is no longer true. Recorded on the line, for the human who reads it later." })),
  text: Type.Optional(Type.String({ description: "The corrected memory. Required for amend, and proposed rather than activated." })),
});

export function buildMemoryEditTool(opts: MemoryToolsOpts): ToolDefinition {
  const store = opts.store ?? LOCAL_MEMORY_STORE;
  return defineTool({
    name: MEMORY_EDIT_TOOL_NAME,
    label: "Memory edit",
    description: MEMORY_EDIT_DESCRIPTION,
    promptSnippet: "Retire or amend an accepted memory",
    parameters: MEMORY_EDIT_PARAMETERS,
    async execute(_callId, params) {
      const op = params.op.trim();
      if (op !== "invalidate" && op !== "amend") {
        throw new Error(`lykos memory_edit: unknown op "${params.op}". There are two: invalidate, amend.`);
      }
      const needle = params.id.trim();
      if (needle.length === 0) {
        throw new Error("lykos memory_edit: id is empty. Call recall first; every hit carries its identifier.");
      }
      const amended = op === "amend" ? flattenLesson(params.text ?? "") : "";
      if (op === "amend" && amended.length === 0) {
        throw new Error("lykos memory_edit: amend needs `text`, the corrected memory. Use invalidate to retire one without replacing it.");
      }

      // The whole store is searched rather than one file, because the model
      // has an identifier and no reason to know which of four files it came
      // from. Ambiguity is refused rather than resolved by picking the first:
      // invalidating the wrong memory is silent and permanent.
      const all = collect(store, opts.cwd, MEMORY_SCOPES, MEMORY_FILES);
      const byId = all.filter((h) => h.entry.id === needle);
      const matches = byId.length > 0 ? byId : all.filter((h) => h.entry.text.includes(needle));
      if (matches.length === 0) {
        return {
          content: text(
            `No memory matches "${needle}". Call recall to see what is accepted; an invalidated entry is already ` +
              "retired and will not match here.",
          ),
          isError: true,
          details: { status: "not_found", needle },
        };
      }
      if (matches.length > 1) {
        return {
          content: text(
            [`"${needle}" matches ${matches.length} memories. Use one of their identifiers instead:`, ...matches.map(located)].join("\n"),
          ),
          isError: true,
          details: { status: "ambiguous", matches: matches.map((h) => h.entry.id) },
        };
      }

      const hit = matches[0]!;
      const reason = params.reason === undefined ? undefined : flattenForMeta(params.reason, LEARN_EXCHANGE_WIDTH);
      // D6: `invalidateMemoryEntry`, and the dependency object holds no
      // `removeMemoryEntry` for a later edit to reach for.
      const result = store.invalidate(hit.path, hit.entry.id, {
        ...(reason !== undefined && reason.length > 0 ? { reason } : {}),
        ...(opts.sessionId !== undefined ? { by: opts.sessionId } : {}),
      });
      if (result.status === "already_invalid") {
        return out(`[${hit.entry.id}] was already invalidated on ${result.entry.meta.invalid}; nothing changed.`, {
          status: "already_invalid",
          id: hit.entry.id,
        });
      }
      if (result.status !== "invalidated") {
        throw new Error(`lykos memory_edit: unexpected store result "${result.status}" for [${hit.entry.id}].`);
      }

      const retired =
        `Invalidated [${hit.entry.id}] in ${hit.scope}/${hit.file}. The line is still there, dated and kept; it ` +
        "stops being recalled and stops being injected. Nothing was deleted.";
      if (op === "invalidate") {
        return out(retired, {
          status: "invalidated",
          id: hit.entry.id,
          scope: hit.scope,
          file: hit.file,
          active: false,
        });
      }

      const proposed = store.propose(opts.cwd, amended, {
        file: hit.file,
        ...(opts.sessionId !== undefined ? { src: opts.sessionId } : {}),
        ...(hit.entry.meta.paths !== undefined ? { paths: hit.entry.meta.paths } : {}),
        ...(opts.now !== undefined ? { now: opts.now() } : {}),
      });
      return {
        content: text(`${retired}\n\n${proposalReport(proposed, hit.file)}`),
        details: {
          status: "amended",
          id: hit.entry.id,
          scope: hit.scope,
          file: hit.file,
          proposalId: proposed.id,
          seen: proposed.seen,
          active: false,
          awaitingHuman: true,
        },
      };
    },
  }) as ToolDefinition;
}

// -------------------------------------------------------------------- reflect

export const REFLECT_DESCRIPTION =
  "Report what is in memory without reading it: how many accepted memories there are per scope and file, how " +
  "many have been invalidated, the newest few by title only, and how many proposals are waiting for a human. " +
  "It answers \"what do you actually know\" cheaply — use recall to read any of it in full.";

export const REFLECT_PARAMETERS = Type.Object({
  scope: Type.Optional(Type.String({ description: "project or global. Omit for both." })),
});

/** Newest first by `added`, then by the order the files list them, which is the maintainer's own priority order. */
function newestFirst(a: LocatedEntry, b: LocatedEntry): number {
  const da = a.entry.meta.added ?? "";
  const db = b.entry.meta.added ?? "";
  if (da !== db) return db.localeCompare(da);
  return b.entry.lineIndex - a.entry.lineIndex;
}

function title(t: string): string {
  return t.length > REFLECT_TITLE_WIDTH ? `${t.slice(0, REFLECT_TITLE_WIDTH - 1)}…` : t;
}

export function buildReflectTool(opts: MemoryToolsOpts): ToolDefinition {
  const store = opts.store ?? LOCAL_MEMORY_STORE;
  return defineTool({
    name: REFLECT_TOOL_NAME,
    label: "Reflect",
    description: REFLECT_DESCRIPTION,
    promptSnippet: "Summarise what is in memory, without reading it",
    parameters: REFLECT_PARAMETERS,
    async execute(_id, params) {
      const scopes = resolveScopes(params.scope);
      const all = collect(store, opts.cwd, scopes, MEMORY_FILES);
      const active = all.filter((h) => isEntryValid(h.entry));

      const counts: string[] = [];
      for (const scope of scopes) {
        for (const file of MEMORY_FILES) {
          const n = active.filter((h) => h.scope === scope && h.file === file).length;
          counts.push(`${scope}/${file} ${n}`);
        }
      }

      const lines: string[] = [
        `${active.length} accepted memor${active.length === 1 ? "y" : "ies"}: ${counts.join(", ")}.`,
      ];
      const invalidated = all.length - active.length;
      if (invalidated > 0) {
        lines.push(`${invalidated} invalidated and no longer recalled, kept on the lines where they were.`);
      }

      if (active.length > 0) {
        const newest = [...active].sort(newestFirst).slice(0, REFLECT_TITLE_COUNT);
        lines.push("", `Newest ${newest.length}, by title only — recall reads one in full:`);
        for (const h of newest) {
          lines.push(`  [${h.entry.id}] (${h.scope}/${h.file}) ${title(h.entry.text)}`);
        }
      }

      const queue = store.proposals(opts.cwd);
      const open = queue.filter((e) => !e.meta.invalid);
      const ready = open.filter((e) => proposalSeenCount(e) >= DEFAULT_PROMOTE_AFTER).length;
      lines.push("");
      if (open.length === 0) {
        lines.push("No proposals are waiting. Nothing is pending a human's decision.");
      } else {
        lines.push(
          `${open.length} proposal${open.length === 1 ? "" : "s"} waiting for a human (${ready} ready to accept). ` +
            "None of them is active, none is recalled, and no tool can accept one.",
        );
      }

      return {
        content: text(lines.join("\n").trimEnd()),
        details: {
          active: active.length,
          invalidated,
          pending: open.length,
          readyToAccept: ready,
          accepted: queue.length - open.length,
        },
      };
    },
  }) as ToolDefinition;
}

// ---------------------------------------------------------------------- learn

export const LEARN_DESCRIPTION =
  "Propose a memory from a correction a human just made, with the exchange that produced it attached as " +
  "provenance. Use this instead of retain when the lesson came from being told you were wrong: the `exchange` " +
  "is what lets whoever reads the queue later see what you were corrected about, rather than taking the lesson " +
  "on trust. Like retain, this only QUEUES the memory — a human accepts it or it never becomes active, and no " +
  "tool can accept it. State the lesson in your own words as one self-contained sentence; do not paste the " +
  "correction into `memory` and call it a lesson.";

export const LEARN_PARAMETERS = Type.Object({
  memory: Type.String({ description: "The lesson, in your own words. One self-contained sentence." }),
  exchange: Type.String({ description: "What was actually said that corrected you. Kept as provenance on the entry." }),
  file: Type.Optional(
    Type.String({ description: "gotchas (a constraint or trap) or failed-approaches (tried and abandoned). Default gotchas." }),
  ),
});

export function buildLearnTool(opts: MemoryToolsOpts): ToolDefinition {
  const store = opts.store ?? LOCAL_MEMORY_STORE;
  return defineTool({
    name: LEARN_TOOL_NAME,
    label: "Learn",
    description: LEARN_DESCRIPTION,
    promptSnippet: "Propose a memory from a correction, with its provenance",
    promptGuidelines: [
      "Proposing is not storing. A correction you were given is not a thing Lykos knows until a human accepts it.",
    ],
    parameters: LEARN_PARAMETERS,
    async execute(_id, params) {
      const lesson = flattenLesson(params.memory);
      if (lesson.length === 0) {
        throw new Error("lykos learn: memory is empty. An empty proposal is a mistake, not a no-op.");
      }
      // D7: the exchange is the point of this tool as opposed to `retain`, so
      // an empty one is a mis-call rather than a missing optional.
      const exchange = flattenForMeta(params.exchange, LEARN_EXCHANGE_WIDTH);
      if (exchange.length === 0) {
        throw new Error(
          "lykos learn: exchange is empty. The exchange is what this tool adds over retain — a lesson with no " +
            "provenance is a lesson nobody can check. Use retain if there was no correction.",
        );
      }
      const target = resolveFile(params.file);
      const result = store.propose(opts.cwd, lesson, {
        file: target,
        from: exchange,
        ...(opts.sessionId !== undefined ? { src: opts.sessionId } : {}),
        ...(opts.now !== undefined ? { now: opts.now() } : {}),
      });
      return {
        content: text(
          `${proposalReport(result, target)}\n\nThe exchange is attached to the entry as provenance and survives acceptance.`,
        ),
        details: {
          id: result.id,
          seen: result.seen,
          status: result.status,
          target,
          from: exchange,
          active: false,
          awaitingHuman: true,
        },
      };
    },
  }) as ToolDefinition;
}

/** All five, built over one dependency object (D1). The order is `MEMORY_TOOL_NAMES`. */
export function buildMemoryTools(opts: MemoryToolsOpts): ToolDefinition[] {
  return [
    buildRetainTool(opts),
    buildRecallTool(opts),
    buildMemoryEditTool(opts),
    buildReflectTool(opts),
    buildLearnTool(opts),
  ];
}
