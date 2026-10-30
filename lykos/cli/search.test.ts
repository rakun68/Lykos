// `lykos search`.
//
// The test this task most needs is the archive one: a search must find the
// same text before and after `lykos archive` has compressed a transcript,
// or the archive has quietly stopped being searchable at exactly the moment
// it became old enough to matter.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { TranscriptWriter } from "../session/transcript.js";
import { archiveSessions } from "./archive.js";
import { matchesFilters, parseWhen, runSearch, searchSessions, searchableText } from "./search.js";
import type { SessionSource } from "./sessions.js";
import type { SessionListRow } from "../session/listing.js";

const NOW = new Date("2026-09-03T12:00:00Z");

function project(): { source: SessionSource; ledger: Ledger; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t59-"));
  const ledgerPath = join(dir, "ledger.db");
  return { source: { ledgerPath, workspace: dir, projectName: null }, ledger: Ledger.open(ledgerPath), dir };
}

function seed(
  ledger: Ledger,
  ledgerPath: string,
  id: string,
  lines: readonly string[],
  over: {
    brief?: string;
    outcome?: "success" | "fail" | "abandoned";
    outcomeSource?: "verification_command" | "human" | "agent_claim";
    model?: string;
    shape?: "standalone" | "mcp_worker" | "subagent" | "cli_delegate";
    startedUtc?: string;
    endedUtc?: string;
    cost?: number;
  } = {},
): void {
  const writer = new TranscriptWriter(ledgerPath, id);
  for (const line of lines) writer.append({ kind: "user_message", text: line });
  const fin = writer.finalize();
  ledger.startSession({
    id,
    brief: over.brief ?? `brief for ${id}`,
    model: over.model ?? "deepseek/deepseek-v4-flash",
    captureMode: "stream",
    startedUtc: over.startedUtc ?? "2026-09-01T00:00:00.000Z",
    ...(over.shape ? { executionShape: over.shape } : {}),
  });
  ledger.endSession({
    id,
    endedUtc: over.endedUtc ?? "2026-09-01T01:00:00.000Z",
    transcriptPath: fin.path,
    transcriptSha256: fin.sha256,
    transcriptBytes: fin.bytes,
    ...(over.outcome ? { outcome: over.outcome } : {}),
    ...(over.outcomeSource ? { outcomeSource: over.outcomeSource } : {}),
    ...(over.cost !== undefined ? { totalCostUsd: over.cost } : {}),
  });
}

function row(over: Partial<SessionListRow> = {}): SessionListRow {
  return {
    id: "s",
    taskId: null,
    taskBrief: null,
    brief: null,
    startedUtc: "2026-09-01T00:00:00.000Z",
    endedUtc: null,
    model: "deepseek/deepseek-v4-flash",
    executionShape: "standalone",
    outcome: null,
    outcomeSource: null,
    archiveState: null,
    captureMode: "stream",
    resumable: true,
    notResumableReason: null,
    parentSessionId: null,
    resumedFrom: null,
    costUsd: null,
    durationSeconds: null,
    depth: 0,
    edge: null,
    ...over,
  };
}

describe("T59 plain substring", () => {
  it("finds a line in a transcript and points at it with session, turn and timestamp", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111", ["rename the parser entry point", "and update the callers"]);
    p.ledger.close();
    const result = searchSessions([p.source], "callers", { now: NOW });
    assert.equal(result.hits.length, 1);
    const hit = result.hits[0]!;
    assert.equal(hit.sessionId, "aaaa1111");
    assert.equal(hit.kind, "user_message");
    assert.equal(hit.turnIndex, 1);
    assert.match(hit.line, /update the callers/);
  });

  it("is case-insensitive", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111", ["Rename The Parser"]);
    p.ledger.close();
    assert.equal(searchSessions([p.source], "rename the parser", { now: NOW }).hits.length, 1);
  });

  it("searches the brief too, and marks a brief hit as having no turn behind it", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111", ["nothing relevant here"], { brief: "fix the ledger footer" });
    p.ledger.close();
    const hits = searchSessions([p.source], "footer", { now: NOW }).hits;
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.kind, "brief");
    assert.equal(hits[0]!.turnIndex, -1);
  });

  it("returns one line, not the whole event, when the match is inside a large body", () => {
    const p = project();
    const big = ["preamble", "x".repeat(500), "the needle is here", "y".repeat(500)].join("\n");
    seed(p.ledger, p.source.ledgerPath, "aaaa1111", [big]);
    p.ledger.close();
    const hit = searchSessions([p.source], "needle", { now: NOW }).hits[0]!;
    assert.equal(hit.line, "the needle is here");
  });

  it("caps the hits from any one session so a chatty transcript cannot fill the page", () => {
    const p = project();
    seed(
      p.ledger,
      p.source.ledgerPath,
      "aaaa1111",
      Array.from({ length: 20 }, (_, i) => `match ${i}`),
    );
    p.ledger.close();
    const result = searchSessions([p.source], "match", { now: NOW, perSession: 3 });
    assert.equal(result.hits.length, 3);
    assert.equal(result.capped, true);
  });
});

describe("T59 archives read transparently", () => {
  it("finds the same text after `lykos archive` has compressed the transcript", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111", ["the needle is in this transcript"]);
    const before = searchSessions([p.source], "needle", { now: NOW });
    assert.equal(before.hits.length, 1);

    // Compress everything, then search again. Nothing in search.ts knows
    // about gzip; `readTranscript()` resolves the `.gz` form for it.
    const archived = archiveSessions(p.ledger, { days: 0, now: NOW });
    assert.equal(archived.compressed.length, 1);
    p.ledger.close();

    const after = searchSessions([p.source], "needle", { now: NOW });
    assert.deepEqual(
      after.hits.map((h) => [h.sessionId, h.turnIndex, h.line]),
      before.hits.map((h) => [h.sessionId, h.turnIndex, h.line]),
    );
  });
});

describe("T59 metadata filters answer from the ledger alone", () => {
  it("filters by outcome, outcome source, model, shape and cost", () => {
    assert.equal(matchesFilters(row({ outcome: "fail" }), { outcome: "fail" }, NOW), true);
    assert.equal(matchesFilters(row({ outcome: "success" }), { outcome: "fail" }, NOW), false);
    assert.equal(
      matchesFilters(row({ outcomeSource: "agent_claim" }), { outcomeSource: "verification_command" }, NOW),
      false,
    );
    assert.equal(matchesFilters(row(), { model: "deepseek" }, NOW), true);
    assert.equal(matchesFilters(row(), { model: "claude" }, NOW), false);
    assert.equal(matchesFilters(row({ executionShape: "subagent" }), { shape: "standalone" }, NOW), false);
    assert.equal(matchesFilters(row({ costUsd: 0.5 }), { minCostUsd: 0.2 }, NOW), true);
    assert.equal(matchesFilters(row({ costUsd: 0.1 }), { minCostUsd: 0.2 }, NOW), false);
  });

  it("accepts both a relative window and an ISO date", () => {
    assert.equal(parseWhen("7d", NOW)?.toISOString(), "2026-08-27T12:00:00.000Z");
    assert.equal(parseWhen("2026-09-01", NOW)?.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(parseWhen("last tuesday", NOW), null);
  });

  it("answers a query-less metadata search with the sessions themselves", () => {
    // `lykos search --outcome fail` is a real question the ledger alone can
    // answer; replying "no matches" because there was no text to match
    // would be wrong.
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111", ["something"], { outcome: "fail", brief: "the failing one" });
    p.ledger.close();
    const hits = searchSessions([p.source], "", { now: NOW, filters: { outcome: "fail" } }).hits;
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.kind, "session");
    assert.equal(hits[0]!.line, "the failing one");
  });

  it("narrows a real search by filter alone, with no query", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111", ["something"], { outcome: "fail" });
    seed(p.ledger, p.source.ledgerPath, "bbbb2222", ["something"], { outcome: "abandoned" });
    p.ledger.close();
    const result = searchSessions([p.source], "", { now: NOW, filters: { outcome: "fail" } });
    assert.equal(result.sessionsSearched, 1);
  });
});

describe("T59 what it counts rather than hides", () => {
  it("counts a session with no transcript instead of pretending it searched it", () => {
    const p = project();
    p.ledger.startSession({ id: "notranscript", brief: "old one", startedUtc: "2026-09-01T00:00:00.000Z" });
    p.ledger.endSession({ id: "notranscript", endedUtc: "2026-09-01T00:10:00.000Z" });
    p.ledger.close();
    const result = searchSessions([p.source], "anything", { now: NOW });
    assert.equal(result.sessionsSearched, 1);
    assert.equal(result.transcriptsMissing, 1);
    assert.equal(result.hits.length, 0);
  });

  it("does not match on an event's own field names", () => {
    // A JSON.stringify of the record would make "kind", "text" and "name"
    // match every event in the archive.
    assert.deepEqual(searchableText({ kind: "user_message", text: "hello" }), ["hello"]);
    assert.deepEqual(searchableText({ kind: "usage", input: 5 }), []);
  });
});

describe("T59 runSearch output", () => {
  it("prints a pointer per hit and names `lykos show` as the way to read the rest", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111", ["the needle"]);
    p.ledger.close();
    const out: string[] = [];
    assert.equal(runSearch("needle", { sources: [p.source], now: NOW, write: (t) => out.push(t) }), 0);
    const text = out.join("");
    assert.match(text, /aaaa1111/);
    assert.match(text, /lykos show <session>/);
  });

  it("refuses an empty query with no filters rather than dumping the archive", () => {
    const p = project();
    p.ledger.close();
    assert.equal(runSearch("  ", { sources: [p.source], now: NOW, write: () => {} }), 1);
  });

  it("says plainly when nothing matched", () => {
    const p = project();
    seed(p.ledger, p.source.ledgerPath, "aaaa1111", ["nothing here"]);
    p.ledger.close();
    const out: string[] = [];
    runSearch("zzzzz", { sources: [p.source], now: NOW, write: (t) => out.push(t) });
    assert.match(out.join(""), /no matches in 1 session/);
  });
});
