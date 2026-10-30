// The proposal queue.
//
// P10.6 (ticket 18, D3) MOVED this file. It was `cli/memory-propose.ts`, and
// everything below is that file's domain half, unchanged except where noted.
// The move is the whole of D3's answer: the plan said to use whatever proposal
// mechanism `lykos/memory/` already has and to add the smallest one that fits
// only if it has none — and it HAS one, complete with a repetition gate, a
// human-only accept and its own markdown file. What it did not have was a home
// a tool could import. `memory.ts` is the module's public surface, the CLI is
// supposed to sit ON the domain rather than inside it, and no tool in this
// repository imports from `cli/`. So the domain moved down and the CLI verbs
// stayed up, and `cli/memory-propose.ts` re-exports these names so its own
// tests and `cli.ts` are untouched.
//
// Two `problems/09` mitigations, in one mechanism:
//
//   **4. Require repetition before promotion.** *"A lesson observed once is
//   an anecdote. Promote on the second or third independent occurrence,
//   which naturally filters noise and single-instance overgeneralization."*
//   So `propose` on a lesson already in the queue increments its count
//   rather than adding a second row, and `accept` refuses below the
//   threshold.
//
//   **3. Promote only procedural knowledge.** This one is SUPERSEDED, and
//   the supersession is the point of ADR-0017: the mistakes-only scope
//   restriction is gone and a model may propose any memory. The two target
//   files are still the only places a proposal can land, because they are the
//   only two files `MEMORY_SOURCE_ORDER` injects from — that is a fact about
//   the store, not a filter on what may be said.
//
// **The queue is never injected, and that is structural rather than a
// setting.** `session/memory-head.ts` reads `MEMORY_SOURCE_ORDER`, which names
// the two real files; `proposed.md` is not in it and cannot be added to it
// without editing that constant. A proposal has no route into a prompt.
//
// **Only a human accepts.** `retain`, `learn` and `memory_edit`'s amend all
// end at `proposeMemory`, and NOTHING in `tools/` imports `acceptProposal`.
// `problems/09` names "promotion of noise" and "poisoning" as two of the
// four forces that turn memory into a liability, and both are entered
// through automatic acceptance -- a wrong memory promoted from a session
// where the agent was wrong is permanent and propagates. There is no
// `--yes`, no auto-accept threshold, and no config key that turns one on.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  isMemoryFile,
  parseMemoryEntries,
  renderMemoryEntry,
  type MemoryEntry,
  type MemoryFile,
} from "./entries.js";
import { memoryFilePath } from "./paths.js";
import { appendMemoryEntry } from "./store.js";

/** How many independent proposals before `accept` will take one. mitigation 4's "second or third". */
export const DEFAULT_PROMOTE_AFTER = 2;

const PROPOSED_HEADER =
  "# Proposed memories\n\n" +
  "Nothing here is ever injected. An entry moves into gotchas.md or\n" +
  "failed-approaches.md only when a human runs `lykos memory accept <id>`,\n" +
  "and only after it has been proposed independently more than once.\n";

export function proposedPath(cwd: string): string {
  return join(cwd, ".lykos", "memory", "proposed.md");
}

/**
 * Two proposals are the same lesson when their text matches after case,
 * whitespace and trailing punctuation are normalised.
 *
 * Deliberately crude. A cleverer matcher -- embeddings, a model call, fuzzy
 * distance -- would collapse *distinct* lessons into one and inflate the
 * repetition count that the whole gate depends on. Under-matching costs a
 * duplicate row the maintainer can see and merge; over-matching silently
 * manufactures the evidence for promotion.
 */
export function normalizeLesson(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
}

function proposalId(text: string): string {
  return createHash("sha256").update(normalizeLesson(text)).digest("hex").slice(0, 8);
}

/**
 * Every row in the queue, accepted ones included. Exported for `reflect`
 * (D5), which reports how many proposals are waiting — the one number that
 * tells a human there is something for them to do.
 */
export function readProposals(cwd: string): { raw: string; entries: MemoryEntry[] } {
  const path = proposedPath(cwd);
  if (!existsSync(path)) return { raw: "", entries: [] };
  const raw = readFileSync(path, "utf8");
  return { raw, entries: parseMemoryEntries(raw) };
}

/** How many times this lesson has been proposed independently. */
export function proposalSeenCount(entry: MemoryEntry): number {
  const n = Number(entry.meta.seen ?? "1");
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

export interface ProposeOptions {
  file?: MemoryFile;
  src?: string;
  paths?: string[];
  /** P10.6 (D7): the exchange `learn` was given, flattened to one line. */
  from?: string;
  now?: Date;
}

export interface ProposeResult {
  id: string;
  seen: number;
  status: "new" | "repeated";
}

/** Append a proposal, or increment the count of one already queued. */
export function proposeMemory(cwd: string, text: string, opts: ProposeOptions = {}): ProposeResult {
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const id = proposalId(text);
  const path = proposedPath(cwd);
  const { raw, entries } = readProposals(cwd);
  const existing = entries.find((e) => e.id === id);

  if (existing !== undefined) {
    const seen = proposalSeenCount(existing) + 1;
    const lines = raw.split(/\r?\n/);
    lines[existing.lineIndex] = renderMemoryEntry(existing.id, existing.text, {
      ...existing.meta,
      seen: String(seen),
      last: today,
    });
    writeFileSync(path, lines.join("\n"), "utf8");
    return { id, seen, status: "repeated" };
  }

  const line = renderMemoryEntry(id, text.trim(), {
    seen: "1",
    first: today,
    last: today,
    target: opts.file ?? "gotchas",
    ...(opts.src ? { src: opts.src } : {}),
    ...(opts.paths && opts.paths.length > 0 ? { paths: opts.paths } : {}),
    ...(opts.from ? { from: opts.from } : {}),
  });
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${PROPOSED_HEADER}\n${line}\n`, "utf8");
  } else {
    const sep = raw.endsWith("\n") ? "" : "\n";
    writeFileSync(path, `${raw}${sep}${line}\n`, "utf8");
  }
  return { id, seen: 1, status: "new" };
}

export type AcceptResult =
  | { status: "accepted"; entry: MemoryEntry; newId: string; target: MemoryFile }
  | { status: "not_found" }
  | { status: "already_accepted"; entry: MemoryEntry }
  | { status: "below_threshold"; entry: MemoryEntry; seen: number; needed: number };

/**
 * Move one proposal into the real store. Human-invoked only.
 *
 * The accepted proposal is marked in the queue rather than removed, for the
 * same reason T78 supersedes instead of deleting: the record of what was
 * proposed and when is part of the evidence for whether this pipeline is
 * worth its own weight.
 */
export function acceptProposal(
  cwd: string,
  idOrMatch: string,
  opts: { promoteAfter?: number; now?: Date } = {},
): AcceptResult {
  const needed = opts.promoteAfter ?? DEFAULT_PROMOTE_AFTER;
  const { raw, entries } = readProposals(cwd);
  const byId = entries.filter((e) => e.id === idOrMatch);
  const matches = byId.length > 0 ? byId : entries.filter((e) => e.text.includes(idOrMatch));
  if (matches.length !== 1) return { status: "not_found" };

  const entry = matches[0]!;
  if (entry.meta.invalid) return { status: "already_accepted", entry };

  const seen = proposalSeenCount(entry);
  if (seen < needed) return { status: "below_threshold", entry, seen, needed };

  const target: MemoryFile = isMemoryFile(entry.meta.target ?? "") ? (entry.meta.target as MemoryFile) : "gotchas";
  const written = appendMemoryEntry(memoryFilePath(cwd, "project", target), entry.text, {
    ...(entry.meta.src ? { src: entry.meta.src } : {}),
    ...(entry.meta.paths ? { paths: entry.meta.paths } : {}),
    // P10.6 (D7): a `learn` proposal's exchange survives its acceptance.
    ...(entry.meta.from ? { from: entry.meta.from } : {}),
  });

  const now = opts.now ?? new Date();
  const lines = raw.split(/\r?\n/);
  lines[entry.lineIndex] = renderMemoryEntry(entry.id, entry.text, {
    ...entry.meta,
    invalid: now.toISOString().slice(0, 10),
    reason: `accepted as ${written.id}`,
  });
  writeFileSync(proposedPath(cwd), lines.join("\n"), "utf8");
  return { status: "accepted", entry, newId: written.id, target };
}
