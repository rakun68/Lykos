// `lykos search`. D4.4.
//
// **Nothing clever until plain fails.** No index, no embeddings, no ranking,
// no stemming. A case-insensitive substring across briefs and transcript
// text, plus the metadata filters the ledger can already answer without
// opening a file. `02-plan.md` asks for search and for exactly this
// restraint in the same paragraph, and if plain substring turns out to be
// too slow at real archive sizes, the fix is measured first and named in
// `DECISIONS.md` — not guessed at now.
//
// Two properties it inherits rather than invents:
//
//   * **Archives read transparently.** `readTranscript()` resolves
//     `transcript.jsonl.gz` and decompresses it (T55), so a search finds the
//     same text before and after an archive run. Nothing here knows about
//     gzip.
//   * **A hit is a pointer, not a viewer.** Session id, turn index,
//     timestamp and the matching line; `lykos show <session>` is how the
//     rest is read. That is the division `02-plan.md` §6 draws and it keeps
//     this command from growing a second transcript renderer.

import { existsSync } from "node:fs";

import { openLedgerSync, type Ledger } from "../ledger/use.js";

import { readTranscript } from "../session/transcript.js";
import { loadSessions, type SessionListRow } from "../session/listing.js";
import { stdoutWrite } from "../tui/io-mode.js";
import { truncate } from "../tui/format.js";
import type { SessionSource } from "./sessions.js";

export interface SearchFilters {
  /** Exact task id, or a prefix of one. */
  task?: string;
  outcome?: string;
  outcomeSource?: string;
  /** Substring of the recorded model spec. */
  model?: string;
  shape?: string;
  /** `<N>d`, or an ISO date. */
  since?: string;
  until?: string;
  minCostUsd?: number;
  captureMode?: string;
}

export interface SearchHit {
  sessionId: string;
  /**
   * The event's capture-order index, which is what `lykos show` prints
   * beside the same line. `-1` marks a hit on the session's BRIEF rather
   * than on a transcript event — a real hit with no turn behind it, said
   * plainly rather than dressed up as turn 0.
   */
  turnIndex: number;
  tsUtc: string;
  kind: string;
  line: string;
}

export interface SearchResult {
  hits: SearchHit[];
  /** Rows the metadata filters admitted. */
  sessionsSearched: number;
  /** Rows that had no readable transcript — a crashed session, or one from before capture. Counted, never hidden. */
  transcriptsMissing: number;
  /** Sessions whose last line did not parse (a kill mid-write). The hits above them are still real. */
  truncatedTranscripts: number;
  /** True when `limit` cut the list short, so the caller can say so rather than implying it found everything. */
  capped: boolean;
}

/** `<N>d` relative, or an ISO timestamp. Anything else is a caller error and returns null. */
export function parseWhen(value: string, now: Date): Date | null {
  const rel = /^(\d+)d$/.exec(value.trim());
  if (rel) return new Date(now.getTime() - Number(rel[1]) * 86_400_000);
  const t = Date.parse(value.trim());
  return Number.isFinite(t) ? new Date(t) : null;
}

/** The ledger-only half of the query: everything answerable without opening a transcript. */
export function matchesFilters(row: SessionListRow, filters: SearchFilters, now: Date): boolean {
  if (filters.task && !(row.taskId ?? "").startsWith(filters.task)) return false;
  if (filters.outcome && row.outcome !== filters.outcome) return false;
  if (filters.outcomeSource && row.outcomeSource !== filters.outcomeSource) return false;
  if (filters.shape && row.executionShape !== filters.shape) return false;
  if (filters.captureMode && row.captureMode !== filters.captureMode) return false;
  if (filters.model && !(row.model ?? "").toLowerCase().includes(filters.model.toLowerCase())) return false;
  if (filters.minCostUsd !== undefined && (row.costUsd ?? 0) < filters.minCostUsd) return false;
  if (filters.since) {
    const from = parseWhen(filters.since, now);
    if (from && Date.parse(row.startedUtc) < from.getTime()) return false;
  }
  if (filters.until) {
    const to = parseWhen(filters.until, now);
    if (to && Date.parse(row.startedUtc) > to.getTime()) return false;
  }
  return true;
}

/**
 * The text a transcript event contributes to the search.
 *
 * Every event kind is listed explicitly rather than JSON-stringifying the
 * record: a stringified event matches on its own field names, so searching
 * for "error" would hit every tool result that merely HAS an error field.
 */
export function searchableText(event: Record<string, unknown>): string[] {
  const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));
  switch (event.kind) {
    case "user_message":
    case "steer":
    case "assistant_message":
    case "thinking":
      return [str(event.text)];
    case "answer":
      return [str(event.question), str(event.answer)];
    case "tool_call":
      return [`${str(event.name)} ${str(event.args)}`];
    case "tool_result":
      return [`${str(event.name)} ${str(event.result)}`];
    case "error":
      return [str(event.message ?? event.text)];
    case "intervention":
      return [`${str(event.action)} ${str(event.detail)}`];
    case "outcome":
      return [`${str(event.outcome)} ${str(event.source)}`];
    default:
      // usage, compaction, resume: numbers and pointers, nothing a person
      // searches for as text. Deliberately not stringified.
      return [];
  }
}

export interface SearchOpts {
  filters?: SearchFilters;
  now?: Date;
  /** Maximum hits returned. The count exists so a one-word query over a year of archives is still readable. */
  limit?: number;
  /** Maximum hits from any one session, so a single chatty transcript cannot fill the page. */
  perSession?: number;
}

const DEFAULT_LIMIT = 50;
const DEFAULT_PER_SESSION = 5;

export function searchSessions(
  sources: readonly SessionSource[],
  query: string,
  opts: SearchOpts = {},
): SearchResult {
  const now = opts.now ?? new Date();
  const filters = opts.filters ?? {};
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const perSession = opts.perSession ?? DEFAULT_PER_SESSION;
  const needle = query.trim().toLowerCase();

  const hits: SearchHit[] = [];
  let sessionsSearched = 0;
  let transcriptsMissing = 0;
  let truncatedTranscripts = 0;
  let capped = false;

  for (const source of sources) {
    if (!existsSync(source.ledgerPath)) continue;
    const ledger = openLedgerSync(source.ledgerPath);
    let rows: SessionListRow[];
    let paths: Map<string, string | null>;
    try {
      rows = loadSessions(ledger);
      paths = new Map(
        (
          ledger.db.prepare(`SELECT id, transcript_path FROM sessions`).all() as Array<{
            id: string;
            transcript_path: string | null;
          }>
        ).map((r) => [r.id, r.transcript_path]),
      );
    } finally {
      ledger.close();
    }

    for (const row of rows) {
      if (!matchesFilters(row, filters, now)) continue;
      sessionsSearched += 1;
      if (hits.length >= limit) {
        capped = true;
        break;
      }
      let fromThisSession = 0;
      const push = (hit: SearchHit): void => {
        if (fromThisSession >= perSession || hits.length >= limit) {
          capped = true;
          return;
        }
        fromThisSession += 1;
        hits.push(hit);
      };

      // A query-less search is a metadata query: `lykos search --outcome
      // fail` is a real question the ledger alone can answer, and answering
      // it with "no matches" because there was no text to match would be
      // wrong. Each admitted session is itself the hit.
      if (needle.length === 0) {
        push({
          sessionId: row.id,
          turnIndex: -1,
          tsUtc: row.startedUtc,
          kind: "session",
          line: row.brief ?? "(no brief)",
        });
        continue;
      }

      // The brief is part of what is searched (`02-plan.md`: "across briefs
      // and transcript text"), and it exists for sessions whose transcript
      // does not — which is most of what a ledger holds from before T53.
      {
        const brief = row.brief ?? "";
        if (brief.toLowerCase().includes(needle)) {
          push({ sessionId: row.id, turnIndex: -1, tsUtc: row.startedUtc, kind: "brief", line: brief });
        }
      }

      const path = paths.get(row.id) ?? null;
      if (!path) {
        transcriptsMissing += 1;
        continue;
      }
      let events;
      try {
        const read = readTranscript(path);
        events = read.events;
        if (read.truncated) truncatedTranscripts += 1;
      } catch {
        // A transcript that cannot be read is counted and skipped. It is
        // never deleted and never repaired — `doctor` is what reports it.
        transcriptsMissing += 1;
        continue;
      }
      for (const event of events) {
        for (const text of searchableText(event as unknown as Record<string, unknown>)) {
          if (!text.toLowerCase().includes(needle)) continue;
          push({
            sessionId: row.id,
            turnIndex: event.turn_index,
            tsUtc: event.ts_utc,
            kind: String((event as { kind?: unknown }).kind ?? "?"),
            line: matchingLine(text, needle),
          });
        }
      }
    }
  }

  return { hits, sessionsSearched, transcriptsMissing, truncatedTranscripts, capped };
}

/** The one line the match is on, so a hit in a 40 KB tool result is one line and not forty kilobytes. */
export function matchingLine(text: string, needle: string): string {
  const lines = text.split("\n");
  const found = lines.find((l) => l.toLowerCase().includes(needle));
  return (found ?? lines[0] ?? "").trim();
}

export interface RunSearchOpts extends SearchOpts {
  sources: readonly SessionSource[];
  json?: boolean;
  write?: (text: string) => void;
}

export function runSearch(query: string, opts: RunSearchOpts): number {
  const write = opts.write ?? stdoutWrite;
  const hasFilters = Object.keys(opts.filters ?? {}).length > 0;
  if (query.trim().length === 0 && !hasFilters) {
    process.stderr.write(
      'lykos search: expected something to search for, e.g. `lykos search "parser"` or `lykos search --outcome fail`\n',
    );
    return 1;
  }
  const result = searchSessions(opts.sources, query, opts);
  if (opts.json) {
    write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  if (result.hits.length === 0) {
    write(
      `no matches in ${result.sessionsSearched} session${result.sessionsSearched === 1 ? "" : "s"}` +
        (result.transcriptsMissing > 0 ? ` (${result.transcriptsMissing} with no readable transcript)` : "") +
        "\n",
    );
    return 0;
  }
  for (const hit of result.hits) {
    // A hit with no turn behind it says so instead of borrowing turn 0.
    const where = hit.turnIndex < 0 ? "—" : `turn ${hit.turnIndex}`;
    write(`${hit.sessionId.slice(0, 8)}  ${where.padEnd(9)} ${hit.kind.padEnd(17)} ${hit.tsUtc}  ${truncate(hit.line, 100)}\n`);
  }
  write(
    `\n${result.hits.length} hit${result.hits.length === 1 ? "" : "s"} across ${result.sessionsSearched} searched` +
      (result.capped ? " (list capped — narrow it with a filter)" : "") +
      (result.transcriptsMissing > 0 ? `; ${result.transcriptsMissing} session(s) had no readable transcript` : "") +
      (result.truncatedTranscripts > 0
        ? `; ${result.truncatedTranscripts} transcript(s) end mid-line (a crash, not damage)`
        : "") +
      "\nread one with `lykos show <session>`.\n",
  );
  return 0;
}
