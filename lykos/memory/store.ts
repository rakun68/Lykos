import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import {
  parseMemoryEntries,
  renderMemoryEntry,
  type MemoryEntry,
  type MemoryFile,
  type MemoryMeta,
} from "./entries.js";

const DEFAULT_HEADERS: Record<MemoryFile, string> = {
  gotchas: "# Project gotchas\n\nNon-obvious constraints and traps discovered while working in this repo.\n",
  "failed-approaches": "# Failed approaches\n\nThings tried and abandoned, and why, so the same dead end is not paid for twice.\n",
};

export interface AppendOptions {
  /** Session that produced the lesson (provenance). */
  src?: string;
  /** Paths the claim depends on — T79's staleness trigger. */
  paths?: string[];
  /**
   * P10.6 (D7): the exchange the lesson came from, flattened to one line.
   * Carried here and not only on the proposal, so accepting a `learn`
   * proposal does not throw away the evidence the human accepted it on.
   */
  from?: string;
}

function entryId(text: string, addedUtc: string): string {
  return createHash("sha256").update(`${text}\n${addedUtc}`).digest("hex").slice(0, 8);
}

/**
 * Appends one entry, creating the file (with a minimal header) if it doesn't
 * exist yet — global scope has no `lykos init` to scaffold it.
 */
export function appendMemoryEntry(
  path: string,
  text: string,
  optsOrNow: AppendOptions | Date = {},
  maybeNow: Date = new Date(),
): MemoryEntry {
  const opts: AppendOptions = optsOrNow instanceof Date ? {} : optsOrNow;
  const now = optsOrNow instanceof Date ? optsOrNow : maybeNow;
  const id = entryId(text, now.toISOString());
  const meta: MemoryMeta = {
    added: now.toISOString().slice(0, 10),
    ...(opts.src ? { src: opts.src } : {}),
    ...(opts.paths && opts.paths.length > 0 ? { paths: opts.paths } : {}),
    ...(opts.from ? { from: opts.from } : {}),
  };
  const line = renderMemoryEntry(id, text, meta);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    const file: MemoryFile = path.includes("failed-approaches") ? "failed-approaches" : "gotchas";
    writeFileSync(path, `${DEFAULT_HEADERS[file]}\n${line}\n`, "utf8");
    return { id, text, lineIndex: -1, meta };
  }
  const raw = readFileSync(path, "utf8");
  const sep = raw.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${raw}${sep}${line}\n`, "utf8");
  return { id, text, lineIndex: -1, meta };
}

export type RemoveResult =
  | { status: "removed"; entry: MemoryEntry }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: MemoryEntry[] };

/**
 * Removes exactly one entry matching `idOrMatch` — first by exact id, then
 * by substring against entry text.
 */
export function removeMemoryEntry(path: string, idOrMatch: string): RemoveResult {
  if (!existsSync(path)) return { status: "not_found" };
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const entries = parseMemoryEntries(raw);

  const byId = entries.filter((e) => e.id === idOrMatch);
  const matches = byId.length > 0 ? byId : entries.filter((e) => e.text.includes(idOrMatch));

  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "ambiguous", matches };

  const entry = matches[0]!;
  lines.splice(entry.lineIndex, 1);
  writeFileSync(path, lines.join("\n"), "utf8");
  return { status: "removed", entry };
}

export type InvalidateResult =
  | { status: "invalidated"; entry: MemoryEntry }
  | { status: "already_invalid"; entry: MemoryEntry }
  | { status: "not_found" }
  | { status: "ambiguous"; matches: MemoryEntry[] };

/** T78 — invalidate, never delete. Rewrites the line in place with `invalid=`. */
export function invalidateMemoryEntry(
  path: string,
  idOrMatch: string,
  opts: { reason?: string; by?: string; now?: Date } = {},
): InvalidateResult {
  if (!existsSync(path)) return { status: "not_found" };
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  const entries = parseMemoryEntries(raw);

  const byId = entries.filter((e) => e.id === idOrMatch);
  const matches = byId.length > 0 ? byId : entries.filter((e) => e.text.includes(idOrMatch));
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length > 1) return { status: "ambiguous", matches };

  const entry = matches[0]!;
  if (entry.meta.invalid) return { status: "already_invalid", entry };

  const now = opts.now ?? new Date();
  const meta: MemoryMeta = {
    ...entry.meta,
    invalid: now.toISOString().slice(0, 10),
    ...(opts.by ? { by: opts.by } : {}),
    ...(opts.reason ? { reason: opts.reason } : {}),
  };
  lines[entry.lineIndex] = renderMemoryEntry(entry.id, entry.text, meta);
  writeFileSync(path, lines.join("\n"), "utf8");
  return { status: "invalidated", entry: { ...entry, meta } };
}
