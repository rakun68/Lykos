// `lykos tools`.
//
// The `unmeasured` tests come first on purpose. The whole reason this command
// exists is that residency stops being a taste decision, and the only way that
// works is if a reader can always tell "zero uses" from "no data" (CLAUDE.md
// rule 4, plan D4). A report that prints 0 for an absent measurement would
// arm ADR-0014's kill criterion against a tool nobody has evidence about.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { PI_DEFAULT_TOOLS } from "../ledger/tool-schema.js";
import type { ToolRegistryEntry } from "../tools/tool-surface.js";
import {
  DEFAULT_WINDOW_DAYS,
  UNMEASURED,
  formatCount,
  measureRegistry,
  readDispatchCounts,
  runTools,
  suggestDemotions,
  surfaceTotal,
  type DispatchCounts,
} from "./tools.js";

function captureStdout(fn: () => number): { code: number; out: string } {
  const original = process.stdout.write.bind(process.stdout);
  let out = "";
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = fn();
    return { code, out };
  } finally {
    process.stdout.write = original;
  }
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lykos-tools-")), "ledger.db");
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString();
}

const ENTRY = (over: Partial<ToolRegistryEntry> & { name: string }): ToolRegistryEntry => ({
  residency: "resident",
  promptPresence: "full",
  rationale: "test row",
  risk: { tier: "read", idempotent: true, openWorld: false },
  ...over,
});

// ---------------------------------------------------------------------------
// "unmeasured" is a value, and it is never the same answer as zero.
// ---------------------------------------------------------------------------

describe("lykos tools — unmeasured is distinguishable from zero", () => {
  it("a window with no session at all leaves BOTH identity columns unmeasured", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    ledger.close();

    const counts = readDispatchCounts(Ledger.open(path), daysAgo(90), new Date().toISOString());
    assert.equal(counts.wire, null, "no rows means no wire evidence, not an empty tally");
    assert.equal(counts.actual, null, "no rows means no actual evidence, not an empty tally");
    assert.equal(counts.sessionsInWindow, 0);
    assert.equal(formatCount(counts.wire, "read"), UNMEASURED);
    assert.equal(formatCount(counts.actual, "read"), UNMEASURED);
  });

  it("a session that ran but recorded no tool_call_counts is unmeasured, and is counted as such", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    // No endSession, so tool_call_counts stays NULL: the "session predates the
    // column" case the schema comment calls out, reproduced exactly.
    ledger.startSession({ brief: "pre-column", startedUtc: daysAgo(3) });
    ledger.close();

    const counts = readDispatchCounts(Ledger.open(path), daysAgo(90), new Date().toISOString());
    assert.equal(counts.sessionsInWindow, 1);
    assert.equal(counts.sessionsWithWireCounts, 0);
    assert.equal(counts.sessionsPredatingColumn, 1);
    assert.equal(counts.wire, null);
    assert.equal(formatCount(counts.wire, "read"), UNMEASURED);
  });

  it("zero uses and no data are different answers in the same report", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    const id = ledger.startSession({ brief: "measured", startedUtc: daysAgo(3) });
    ledger.endSession({ id, toolCallCounts: JSON.stringify({ read: 3 }) });
    ledger.close();

    const counts = readDispatchCounts(Ledger.open(path), daysAgo(90), new Date().toISOString());
    // `read` was dispatched three times; `bash` was on the same surface and was
    // not dispatched at all. That is a measured zero.
    assert.equal(formatCount(counts.wire, "read"), "3");
    assert.equal(formatCount(counts.wire, "bash"), "0");
    // Nothing on this path wrote an actual identity, so the other column is
    // not zero — it is unknown.
    assert.equal(formatCount(counts.actual, "bash"), UNMEASURED);
  });

  it("a tool with no catalog entry prints unmeasured for its schema tokens", () => {
    const rows = measureRegistry(
      [ENTRY({ name: "read" }), ENTRY({ name: "no_such_tool", residency: "mounted", promptPresence: "hidden" })],
      new Set(["read", "no_such_tool"]),
    );
    assert.equal(rows.length, 2);
    assert.ok((rows[0]!.schemaTokens ?? 0) > 0, "a known tool measures");
    assert.equal(rows[1]!.schemaTokens, null, "an unknown tool is NULL, never 0");
  });

  it("a surface containing an unknown tool is unmeasured in total, never a partial sum", () => {
    const partial = surfaceTotal(["read", "no_such_tool"]);
    assert.equal(partial.tokens, null);
    assert.deepEqual(partial.unknown, ["no_such_tool"]);
    const known = surfaceTotal(["read"]);
    assert.ok((known.tokens ?? 0) > 0);
    assert.deepEqual(known.unknown, []);
  });

  it("with no ledger on disk, every use figure prints unmeasured and none prints 0", () => {
    const path = tmpLedgerPath();
    const { code, out } = captureStdout(() => runTools(path));
    assert.equal(code, 0);
    assert.match(out, /no ledger at/);
    const useSection = out.slice(out.indexOf("use —"));
    assert.match(useSection, new RegExp(`read\\s+${UNMEASURED}\\s+${UNMEASURED}`));
    // The registry and cost sections still measure — only USE is unknown.
    assert.match(out, /resident \(standalone\)/);
  });
});

// ---------------------------------------------------------------------------
// D3 — the two identities stay apart.
// ---------------------------------------------------------------------------

describe("lykos tools — wire and actual identity are never summed", () => {
  it("a transport dispatch lands in two different rows under two different names", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    const id = ledger.startSession({ brief: "transport", startedUtc: daysAgo(1) });
    ledger.recordCall({
      sessionId: id,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
      ts: new Date(Date.now() - 86_400_000),
      wireToolName: "tool_call",
      toolName: "lsp",
    });
    ledger.endSession({ id, toolCallCounts: JSON.stringify({ tool_call: 1 }) });
    ledger.close();

    const counts = readDispatchCounts(Ledger.open(path), daysAgo(90), new Date().toISOString());
    // One source per column, never two summed: this ledger carries BOTH a
    // session tally and a per-call wire name for the same dispatch, and adding
    // them would turn one real event into a fabricated 2.
    assert.equal(counts.wireSource, "sessions.tool_call_counts");
    assert.equal(formatCount(counts.wire, "tool_call"), "1");
    assert.equal(formatCount(counts.wire, "lsp"), "0");
    // The actual identity saw `lsp` once and never saw `tool_call`.
    assert.equal(formatCount(counts.actual, "lsp"), "1");
    assert.equal(formatCount(counts.actual, "tool_call"), "0");
  });

  it("reads the actual identity from the session tally, and never adds the per-call column to it (D26)", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    const id = ledger.startSession({ brief: "transport", startedUtc: daysAgo(1) });
    ledger.recordCall({
      sessionId: id,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
      ts: new Date(Date.now() - 86_400_000),
      toolName: "lsp",
    });
    ledger.endSession({
      id,
      toolCallCounts: JSON.stringify({ tool_call: 2 }),
      actualToolCallCounts: JSON.stringify({ lsp: 1, web_fetch: 1 }),
    });
    ledger.close();

    const counts = readDispatchCounts(Ledger.open(path), daysAgo(90), new Date().toISOString());
    assert.equal(counts.actualSource, "sessions.actual_tool_call_counts");
    // The per-call row and the session tally describe the same dispatch;
    // summing them would report lsp twice.
    assert.equal(formatCount(counts.actual, "lsp"), "1");
    assert.equal(formatCount(counts.actual, "web_fetch"), "1");
  });

  it("the printed table keeps them in two columns and offers no total", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    const id = ledger.startSession({ brief: "transport", startedUtc: daysAgo(1) });
    ledger.recordCall({
      sessionId: id,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
      ts: new Date(Date.now() - 86_400_000),
      wireToolName: "tool_call",
      toolName: "lsp",
    });
    ledger.endSession({ id, toolCallCounts: JSON.stringify({ tool_call: 1, read: 4 }) });
    ledger.close();

    const { code, out } = captureStdout(() => runTools(path));
    assert.equal(code, 0);
    assert.match(out, /wire\s+actual/);
    assert.doesNotMatch(out, /\btotal dispatches\b/);
    assert.match(out, /^\s+lsp\s+0\s+1\s*$/m, "lsp: never on the wire, dispatched once");
    assert.match(out, /^\s+tool_call\s+1\s+0\s*$/m, "tool_call: once on the wire, dispatched nothing itself");
  });
});

// ---------------------------------------------------------------------------
// D5 — the suggestion comes from the ledger, and names nobody without data.
// ---------------------------------------------------------------------------

describe("lykos tools — the ninety-day suggestion", () => {
  const rows = () =>
    measureRegistry(
      [
        ENTRY({ name: "read" }),
        ENTRY({ name: "powershell" }),
        ENTRY({ name: "lsp", residency: "mounted", promptPresence: "hidden" }),
      ],
      new Set(["read", "powershell", "lsp"]),
    );

  it("names a resident tool with a measured zero", () => {
    const counts: DispatchCounts = {
      wire: { read: 9 },
      wireSource: "sessions.tool_call_counts",
      actual: null,
      actualSource: "none",
      sessionsInWindow: 1,
      sessionsWithWireCounts: 1,
      sessionsWithActualCounts: 0,
      sessionsPredatingColumn: 0,
      callsWithWireIdentity: 0,
      callsWithActualIdentity: 0,
    };
    const suggestion = suggestDemotions(rows(), counts);
    assert.equal(suggestion.measured, true);
    assert.deepEqual(suggestion.names, ["powershell"]);
  });

  it("names nobody when the window has no dispatch data — absence of evidence is not evidence", () => {
    const counts: DispatchCounts = {
      wire: null,
      wireSource: "none",
      actual: null,
      actualSource: "none",
      sessionsInWindow: 2,
      sessionsWithWireCounts: 0,
      sessionsWithActualCounts: 0,
      sessionsPredatingColumn: 2,
      callsWithWireIdentity: 0,
      callsWithActualIdentity: 0,
    };
    const suggestion = suggestDemotions(rows(), counts);
    assert.equal(suggestion.measured, false);
    assert.deepEqual(suggestion.names, []);
  });

  it("never names a mounted tool — there is nowhere to demote it to", () => {
    const counts: DispatchCounts = {
      wire: { read: 1, powershell: 1 },
      wireSource: "sessions.tool_call_counts",
      actual: null,
      actualSource: "none",
      sessionsInWindow: 1,
      sessionsWithWireCounts: 1,
      sessionsWithActualCounts: 0,
      sessionsPredatingColumn: 0,
      callsWithWireIdentity: 0,
      callsWithActualIdentity: 0,
    };
    assert.deepEqual(suggestDemotions(rows(), counts).names, []);
  });

  it("never names a tool the actual column saw, even when the wire column did not", () => {
    const counts: DispatchCounts = {
      wire: { read: 1 },
      wireSource: "sessions.tool_call_counts",
      actual: { powershell: 2 },
      actualSource: "calls.tool_name",
      sessionsInWindow: 1,
      sessionsWithWireCounts: 1,
      sessionsWithActualCounts: 0,
      sessionsPredatingColumn: 0,
      callsWithWireIdentity: 0,
      callsWithActualIdentity: 2,
    };
    assert.deepEqual(suggestDemotions(rows(), counts).names, []);
  });

  it("prints the suggestion and demotes nothing (ADR-0014: it SUGGESTS)", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    const id = ledger.startSession({ brief: "one tool only", startedUtc: daysAgo(2) });
    ledger.endSession({ id, toolCallCounts: JSON.stringify({ read: 5 }) });
    ledger.close();

    const { code, out } = captureStdout(() => runTools(path));
    assert.equal(code, 0);
    assert.match(out, /resident tool\(s\) had no dispatch/);
    assert.match(out, /powershell/);
    assert.match(out, /Nothing was demoted, deleted or changed/);
    assert.match(out, /tool-surface\.ts/, "it names the file a human edits");
  });

  it("says how thin the evidence is, and warns when every measured session ran no tools", () => {
    // A window whose only measured session used nothing names the entire
    // resident surface. That is the rule working, and a reader about to demote
    // fourteen tools on the strength of one empty session needs to see why.
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    const id = ledger.startSession({ brief: "ran nothing", startedUtc: daysAgo(2) });
    ledger.endSession({ id, toolCallCounts: "{}" });
    ledger.close();

    const { out } = captureStdout(() => runTools(path));
    assert.match(out, /evidence\s+1 of 1 session\(s\)/);
    assert.match(out, /recording 0 dispatch\(es\) between them/);
    assert.match(out, /Every measured session in this window ran no tools at all/);
  });

  it("does not warn about an empty window when dispatches were actually recorded", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    const id = ledger.startSession({ brief: "ran something", startedUtc: daysAgo(2) });
    ledger.endSession({ id, toolCallCounts: JSON.stringify({ read: 4 }) });
    ledger.close();

    const { out } = captureStdout(() => runTools(path));
    assert.match(out, /recording 4 dispatch\(es\) between them/);
    assert.doesNotMatch(out, /ran no tools at all/);
  });

  it("says unmeasured, and names nobody, when the window has no counts", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    ledger.startSession({ brief: "no counts", startedUtc: daysAgo(2) });
    ledger.close();

    const { code, out } = captureStdout(() => runTools(path));
    assert.equal(code, 0);
    const tail = out.slice(out.indexOf("ninety-day suggestion"));
    assert.match(tail, new RegExp(UNMEASURED));
    assert.doesNotMatch(tail, /had no dispatch/);
  });
});

// ---------------------------------------------------------------------------
// D2 — three sections, and the cost section shows both kinds of surface.
// ---------------------------------------------------------------------------

describe("lykos tools — the three sections", () => {
  it("lists every registry row with residency, prompt presence and risk tier", () => {
    const path = tmpLedgerPath();
    const { out } = captureStdout(() => runTools(path));
    assert.match(out, /registry —/);
    assert.match(out, /^\s+read\s+resident\s+full\s+read\s+/m);
    assert.match(out, /^\s+lsp\s+mounted\s+hidden\s+soft-write\s+/m);
    assert.match(out, /^\s+subagent_workflow\s+off\s+hidden\s+hard-write\s+no\s+/m);
  });

  it("prints the resident total that rides every request AND the mounted total that rides none", () => {
    const path = tmpLedgerPath();
    const { out } = captureStdout(() => runTools(path));
    // The ticket is explicit: a reader who sees only one of these cannot tell
    // which kind of surface grew.
    assert.match(out, /resident \(standalone\)\s+\d+ tokens over\s+\d+ tool\(s\).*rides EVERY request/);
    assert.match(out, /mounted catalog\s+\d+ tokens over\s+\d+ tool\(s\).*rides NO request/);
    assert.match(out, /pi_estimateTokens_chars\/4/);
  });

  it("reports the share of prompt as unmeasured until a call records schema tokens", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    const id = ledger.startSession({ brief: "no schema tokens", startedUtc: daysAgo(1) });
    ledger.recordCall({
      sessionId: id,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      ts: new Date(Date.now() - 86_400_000),
    });
    ledger.close();

    const { out } = captureStdout(() => runTools(path));
    assert.match(out, new RegExp(`share of prompt\\s+${UNMEASURED}`));
  });

  it("reports a measured share once a call records schema tokens", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    const id = ledger.startSession({ brief: "schema tokens", startedUtc: daysAgo(1) });
    ledger.recordCall({
      sessionId: id,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 900, output: 10, cacheRead: 100, cacheWrite: 0 },
      ts: new Date(Date.now() - 86_400_000),
      toolNames: [...PI_DEFAULT_TOOLS],
    });
    ledger.close();

    const { out } = captureStdout(() => runTools(path));
    assert.match(out, /share of prompt\s+\d+\.\d%/);
    assert.match(out, /1 measured call\(s\)/);
  });

  it("names the window it measured and defaults to ninety days", () => {
    const path = tmpLedgerPath();
    const { out } = captureStdout(() => runTools(path));
    assert.equal(DEFAULT_WINDOW_DAYS, 90);
    assert.match(out, /use — dispatches in the last 90 day\(s\)/);
  });

  it("honours --since and rejects a value it cannot parse", () => {
    const path = tmpLedgerPath();
    const ok = captureStdout(() => runTools(path, { since: "7d" }));
    assert.equal(ok.code, 0);
    assert.match(ok.out, /use — dispatches in the last 7 day\(s\)/);

    const bad = captureStdout(() => runTools(path, { since: "last week" }));
    assert.equal(bad.code, 1);
    assert.match(bad.out, /expected "<N>d"/);
  });

  it("reports an off-registry tool the ledger saw rather than dropping it", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    const id = ledger.startSession({ brief: "third-party", startedUtc: daysAgo(1) });
    ledger.endSession({ id, toolCallCounts: JSON.stringify({ mcp__something__do: 2 }) });
    ledger.close();

    const { out } = captureStdout(() => runTools(path));
    assert.match(out, /not in the registry/);
    assert.match(out, /mcp__something__do/);
  });

  it("excludes a session outside the window from the counts", () => {
    const path = tmpLedgerPath();
    const ledger = Ledger.open(path);
    const old = ledger.startSession({ brief: "old", startedUtc: daysAgo(200) });
    ledger.endSession({ id: old, toolCallCounts: JSON.stringify({ read: 50 }) });
    const recent = ledger.startSession({ brief: "recent", startedUtc: daysAgo(2) });
    ledger.endSession({ id: recent, toolCallCounts: JSON.stringify({ read: 1 }) });
    ledger.close();

    const counts = readDispatchCounts(Ledger.open(path), daysAgo(90), new Date().toISOString());
    assert.equal(counts.sessionsInWindow, 1);
    assert.equal(formatCount(counts.wire, "read"), "1");
  });
});

// ---------------------------------------------------------------------------
// The real registry, measured. These assert SHAPE, not a hard-coded number:
// a hard-coded token count here would be a second answer to a question
// `measureToolset` already answers, and it would rot on the next tool.
// ---------------------------------------------------------------------------

describe("lykos tools — against the shipped registry", () => {
  it("measures every shipped registry row", () => {
    const rows = measureRegistry();
    assert.ok(rows.length > 0);
    const missing = rows.filter((r) => r.schemaTokens === null).map((r) => r.name);
    assert.deepEqual(missing, [], "every shipped registry row has a catalog entry today");
  });

  it("the mounted catalog is real and rides no request", () => {
    const rows = measureRegistry();
    const mounted = rows.filter((r) => r.residency === "mounted" && r.wired);
    assert.ok(mounted.length > 0);
    const total = surfaceTotal(mounted.map((r) => r.name));
    assert.ok((total.tokens ?? 0) > 0);
  });
});
