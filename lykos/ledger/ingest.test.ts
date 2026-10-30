import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  type DelegateToolCall,
  ingestDelegateSnapshot,
  pricedSnapshotTotal,
  snapshotsFromMcpResult,
  tryIngestMcpJsonRpcLine,
} from "./ingest.js";
import { Ledger } from "./ledger.js";
import { priceCall } from "./prices.js";
import { loadSessionSummary, formatSessionSummary } from "./summary.js";
import { readTranscript, transcriptDir, verifyTranscriptHash } from "../session/transcript.js";
import { LiveTranscriptRecorder } from "../session/live-capture.js";
import { PI_DEFAULT_PLUS_SUBAGENTS, PI_DEFAULT_TOOLS, measureToolset, piDefaultBaseline } from "./tool-schema.js";
import { resolveResidentTools } from "../tools/tool-surface.js";

const OFF_PEAK = new Date("2026-08-29T12:00:00Z");

const nestedSnap = {
  sessionId: "e1c4ce40-nested-fixture",
  label: "nested-check",
  state: "done" as const,
  model: "deepseek/deepseek-v4-flash",
  turns: 2,
  toolCalls: [{ name: "agent" }],
  finishedAt: OFF_PEAK.toISOString(),
  usage: {
    input: 5315,
    output: 209,
    cacheRead: 5248,
    cacheWrite: 0,
    reasoning: 92,
    nestedInput: 4346,
    nestedOutput: 43,
    nestedCacheRead: 0,
    nestedCacheWrite: 0,
    nestedBasis: "reported_usage",
    nestedCostUsd: 0.00062048,
    calls: [
      {
        hop: "direct",
        source: "assistant_message",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        input: 5315,
        output: 209,
        cacheRead: 5248,
        cacheWrite: 0,
        reasoning: 92,
        ts: OFF_PEAK.toISOString(),
      },
      {
        hop: "nested",
        source: "reported_usage",
        input: 4346,
        output: 43,
        cacheRead: 0,
        cacheWrite: 0,
        ts: OFF_PEAK.toISOString(),
      },
      {
        hop: "nested",
        source: "tool_details",
        costUsd: 0.00062048,
        tokens: "4.4k token",
      },
    ],
  },
};

function hop1SessionId(db: Ledger, parentSessionId: string): string {
  const row = db.db
    .prepare(`SELECT id FROM sessions WHERE parent_session_id = ?`)
    .get(parentSessionId) as { id: string } | undefined;
  assert.ok(row, `expected a hop-1 child session under ${parentSessionId}`);
  return row!.id;
}

describe("ingestDelegateSnapshot", () => {
  it("re-prices per-call token counts and skips the tool_details cross-check", () => {
    const db = Ledger.open(":memory:");
    const id = ingestDelegateSnapshot(db, nestedSnap);
    assert.equal(id, nestedSnap.sessionId);

    // T8.3: hop-1 spend now lives in its own child session, linked by
    // parent_session_id, not tagged inline in the parent's own calls.
    const parentTotals = db.callTotals(nestedSnap.sessionId);
    assert.equal(parentTotals.n, 1);
    assert.equal(parentTotals.input, 5315);
    assert.equal(parentTotals.output, 209);
    assert.equal(parentTotals.cacheRead, 5248);

    const childId = hop1SessionId(db, nestedSnap.sessionId);
    const childTotals = db.callTotals(childId);
    assert.equal(childTotals.n, 1);
    assert.equal(childTotals.input, 4346);
    assert.equal(childTotals.output, 43);

    const combinedCostUsd = (parentTotals.costUsd ?? 0) + (childTotals.costUsd ?? 0);
    const expected = pricedSnapshotTotal(nestedSnap, OFF_PEAK);
    assert.equal(combinedCostUsd, expected);
    const direct = priceCall({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 5315, output: 209, cacheRead: 5248, cacheWrite: 0 },
      ts: OFF_PEAK,
    }).costUsd;
    const nested = priceCall({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 4346, output: 43, cacheRead: 0, cacheWrite: 0 },
      ts: OFF_PEAK,
    }).costUsd;
    assert.equal(combinedCostUsd, direct + nested);
    assert.notEqual(combinedCostUsd, nestedSnap.usage.nestedCostUsd);

    const parentSchema = db.db
      .prepare(`SELECT tool_schema_tokens, prefix_changed FROM calls WHERE session_id = ?`)
      .get(nestedSnap.sessionId) as { tool_schema_tokens: number | null; prefix_changed: number | null };
    assert.equal(parentSchema.tool_schema_tokens, null);
    assert.equal(parentSchema.prefix_changed, null);
    const childSchema = db.db
      .prepare(`SELECT tool_schema_tokens FROM calls WHERE session_id = ?`)
      .get(childId) as { tool_schema_tokens: number | null };
    assert.equal(childSchema.tool_schema_tokens, null);

    // The child session is a first-class row of its own (T8.3 acceptance),
    // marked not-resumable per T9.1's confirmed finding (DECISIONS.md 2026-08-29).
    const childRow = db.db
      .prepare(`SELECT parent_session_id, resumable, not_resumable_reason FROM sessions WHERE id = ?`)
      .get(childId) as { parent_session_id: string; resumable: number; not_resumable_reason: string | null };
    assert.equal(childRow.parent_session_id, nestedSnap.sessionId);
    assert.equal(childRow.resumable, 0);
    assert.ok(childRow.not_resumable_reason);
    db.close();
  });

  it("is idempotent: a second ingest of the same session writes nothing", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, nestedSnap);
    const childId = hop1SessionId(db, nestedSnap.sessionId);
    assert.equal(ingestDelegateSnapshot(db, nestedSnap), null);
    assert.equal(db.callTotals(nestedSnap.sessionId).n, 1);
    assert.equal(db.callTotals(childId).n, 1);
    db.close();
  });

  it("synthesizes hop rows when the snapshot has totals but no calls array", () => {
    const db = Ledger.open(":memory:");
    const snap = {
      sessionId: "plain-run",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 873,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "none",
      },
    };
    ingestDelegateSnapshot(db, snap);
    const totals = db.callTotals("plain-run");
    assert.equal(totals.n, 1);
    assert.equal(totals.input, 873);
    assert.equal(
      totals.costUsd,
      priceCall({
        provider: "deepseek",
        model: "deepseek-v4-flash",
        tokens: { input: 873, output: 4 },
        ts: OFF_PEAK,
      }).costUsd,
    );
    db.close();
  });

  it("pulls a snapshot out of an MCP JSON-RPC tools/call result line", () => {
    const payload = {
      content: [{ type: "text", text: JSON.stringify({
        sessionId: "mcp-line",
        state: "done",
        model: "deepseek/deepseek-v4-flash",
        finishedAt: OFF_PEAK.toISOString(),
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, nestedBasis: "none" },
      }) }],
    };
    const line = JSON.stringify({ jsonrpc: "2.0", id: 4, result: payload });
    const snaps = snapshotsFromMcpResult((JSON.parse(line) as { result: unknown }).result);
    assert.equal(snaps.length, 1);
    const db = Ledger.open(":memory:");
    const id = ingestDelegateSnapshot(db, snaps[0]!);
    assert.equal(id, "mcp-line");
    assert.equal(db.callTotals("mcp-line").input, 10);
    db.close();
  });

  it("prices a direct call by its own provider, not the snapshot's default", () => {
    // Regression: the patched worker puts `provider` and a BARE `model` (no
    // slash) on every "direct"/"assistant_message" call entry. Before the fix,
    // a present call.model always won outright and call.provider was ignored,
    // so a non-DeepSeek direct call silently priced as DeepSeek's default
    // model instead of throwing or pricing correctly. This snapshot's own
    // `model` field is a DeepSeek ref; the one call entry is Anthropic — if
    // provider were still being ignored, this would price it against
    // deepseek/claude-haiku-4-5, which does not exist, and throw.
    const snap = {
      sessionId: "mixed-provider-fixture",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "anthropic",
            model: "claude-haiku-4-5",
            input: 1000,
            output: 100,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap, {
      // T36: anthropic is priced in prices.yaml but not in shipped defaults.
      // Declaring it here is what lets this regression test still check the
      // mixed-provider pricing path rather than recording unpriced.
      providers: {
        deepseek: { auth: "api_key", priced: true },
        anthropic: { auth: "api_key", priced: true },
      },
    });
    const row = db.db
      .prepare(`SELECT provider, model, cost_usd FROM calls WHERE session_id = ?`)
      .get(snap.sessionId) as { provider: string; model: string; cost_usd: number };
    assert.equal(row.provider, "anthropic");
    assert.equal(row.model, "claude-haiku-4-5");
    const expected = priceCall({
      provider: "anthropic",
      model: "claude-haiku-4-5",
      tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
      ts: OFF_PEAK,
    }).costUsd;
    assert.equal(row.cost_usd, expected);
    db.close();
  });

  it("measures hop-0 schema tokens from activeTools and leaves hop-1 NULL", () => {
    const tools = [...PI_DEFAULT_PLUS_SUBAGENTS];
    const expected = measureToolset(tools);
    assert.ok(expected.complete && expected.tokens !== null);
    const snap = {
      sessionId: "schema-tax-fixture",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      activeTools: tools,
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        nestedInput: 50,
        nestedOutput: 5,
        nestedCacheRead: 0,
        nestedCacheWrite: 0,
        nestedBasis: "reported_usage",
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
          {
            hop: "nested",
            source: "reported_usage",
            input: 50,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);

    // T8.3: hop-0 stays on the parent session; hop-1 moves to the
    // synthesized child session (see hop1SessionId above), so each is
    // queried against its own session_id rather than one shared list.
    const hop0 = db.db
      .prepare(
        `SELECT hop, tool_schema_tokens, tool_count, tool_schema_hash, prefix_changed, tool_names
         FROM calls WHERE session_id = ?`,
      )
      .get(snap.sessionId) as {
      hop: number;
      tool_schema_tokens: number | null;
      tool_count: number | null;
      tool_schema_hash: string | null;
      prefix_changed: number | null;
      tool_names: string | null;
    };
    assert.equal(hop0.hop, 0);
    assert.equal(hop0.tool_schema_tokens, expected.tokens);
    assert.equal(hop0.tool_count, 8);
    assert.equal(hop0.tool_schema_hash, expected.hash);
    assert.equal(hop0.prefix_changed, 0);
    assert.deepEqual(JSON.parse(hop0.tool_names!), tools);

    const childId = hop1SessionId(db, snap.sessionId);
    const hop1 = db.db
      .prepare(
        `SELECT hop, tool_schema_tokens, tool_schema_hash, prefix_changed, tool_names
         FROM calls WHERE session_id = ?`,
      )
      .get(childId) as {
      hop: number;
      tool_schema_tokens: number | null;
      tool_schema_hash: string | null;
      prefix_changed: number | null;
      tool_names: string | null;
    };
    assert.equal(hop1.hop, 1);
    assert.equal(hop1.tool_schema_tokens, null);
    assert.equal(hop1.tool_schema_hash, null);
    assert.equal(hop1.prefix_changed, null);
    assert.equal(hop1.tool_names, null);
    db.close();
  });

  it("a Lykos child records its own tool surface, even on the aggregate path", () => {
    // A Lykos-spawned child is hop 1, and hop 1 normally carries no tool surface
    // because it is somebody else's agent. This child is not: it is a Lykos
    // session with its own request, and `calls.tool_names` / `tool_count` for it
    // are the evidence `npm run specialists:live` asserts a delegate's tool list
    // against. The aggregate branch — usage present, no per-call entries — used to
    // drop both to NULL, so the leg had nothing to read.
    const childTools = ["read"];
    const snap = {
      sessionId: "lykos-child-aggregate",
      state: "done" as const,
      model: "anthropic/claude-haiku-4-5",
      finishedAt: OFF_PEAK.toISOString(),
      activeTools: childTools,
      usage: {
        input: 120,
        output: 12,
        cacheRead: 0,
        cacheWrite: 0,
      },
    };
    const db = Ledger.open(":memory:");
    db.startSession({ id: "parent-of-aggregate", model: "deepseek/deepseek-v4-flash" });
    ingestDelegateSnapshot(db, snap, { parentSessionId: "parent-of-aggregate" });

    const row = db.db
      .prepare(`SELECT tool_count, tool_names FROM calls WHERE session_id = ?`)
      .get(snap.sessionId) as { tool_count: number | null; tool_names: string | null };
    assert.ok(row, "the child must have a calls row");
    assert.equal(row.tool_count, childTools.length, "tool_count must not be NULL for a Lykos child");
    assert.deepEqual(JSON.parse(row.tool_names!), childTools);
    db.close();
  });

  it("treats a missing activeTools as unmeasured, not a silent 0", () => {
    const snap = {
      sessionId: "plain-run-no-tools",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 873,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "none",
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const row = db.db
      .prepare(`SELECT tool_schema_tokens, tool_count FROM calls WHERE session_id = ?`)
      .get(snap.sessionId) as { tool_schema_tokens: number | null; tool_count: number | null };
    assert.equal(row.tool_schema_tokens, null);
    assert.equal(row.tool_count, null);
    db.close();
  });

  it("T16.2/T17: writes prefix_fingerprint on hop-0 only, never attributing the parent's head to hop-1", () => {
    const snap = {
      sessionId: "head-fp-fixture",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      headContract: { enabled: true, cacheOptimizerLoaded: true },
      usage: {
        input: 100,
        output: 10,
        cacheRead: 80,
        cacheWrite: 0,
        nestedInput: 50,
        nestedOutput: 5,
        nestedCacheRead: 0,
        nestedCacheWrite: 0,
        nestedBasis: "reported_usage",
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 50,
            output: 5,
            cacheRead: 40,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
            headFingerprint: "aaa111",
          },
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 50,
            output: 5,
            cacheRead: 40,
            cacheWrite: 0,
            ts: new Date(OFF_PEAK.getTime() + 1000).toISOString(),
            headFingerprint: "aaa111",
          },
          {
            hop: "nested",
            source: "reported_usage",
            input: 50,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
            headFingerprint: "should-be-ignored",
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const hop0 = db.db
      .prepare(
        `SELECT prefix_fingerprint, prefix_fingerprint_changed FROM calls WHERE session_id = ? ORDER BY ts_utc`,
      )
      .all(snap.sessionId) as Array<{ prefix_fingerprint: string | null; prefix_fingerprint_changed: number | null }>;
    assert.equal(hop0.length, 2);
    assert.deepEqual(hop0.map((r) => r.prefix_fingerprint), ["aaa111", "aaa111"]);
    assert.deepEqual(hop0.map((r) => r.prefix_fingerprint_changed), [0, 0]);
    const childId = hop1SessionId(db, snap.sessionId);
    const hop1 = db.db
      .prepare(`SELECT prefix_fingerprint FROM calls WHERE session_id = ?`)
      .get(childId) as { prefix_fingerprint: string | null };
    assert.equal(hop1.prefix_fingerprint, null);
    const flags = db.db
      .prepare(`SELECT flag_cache_stable_head, flag_delegation FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { flag_cache_stable_head: number; flag_delegation: number };
    assert.equal(flags.flag_cache_stable_head, 1);
    assert.equal(flags.flag_delegation, 1);
    db.close();
  });

  it("T19: records threshold on the session and snip/prune reductions on the compaction call, using source=compaction", () => {
    const snap = {
      sessionId: "t19-compact-fixture",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      compaction: { enabled: true, threshold: 0.8, reserveTokens: 200_000, contextWindow: 1_000_000 },
      usage: {
        input: 500,
        output: 80,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "none",
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 200,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
          {
            hop: "direct",
            source: "compaction",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 300,
            output: 60,
            cacheRead: 0,
            cacheWrite: 0,
            ts: new Date(OFF_PEAK.getTime() + 1000).toISOString(),
            contextBefore: 12_000,
            contextAfter: 3_400,
            snipTokensRemoved: 7_100,
            pruneTokensRemoved: 1_500,
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const session = db.db
      .prepare(`SELECT compaction_threshold, flag_proactive_compaction, compactions FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as {
        compaction_threshold: number;
        flag_proactive_compaction: number;
        compactions: number;
      };
    assert.equal(session.compaction_threshold, 0.8);
    assert.equal(session.flag_proactive_compaction, 1);
    assert.equal(session.compactions, 1);
    const compact = db.db
      .prepare(
        `SELECT phase, compaction_triggered, snip_tokens_removed, prune_tokens_removed, context_before, context_after
         FROM calls WHERE session_id = ? AND phase = 'compact'`,
      )
      .get(snap.sessionId) as {
        phase: string;
        compaction_triggered: number;
        snip_tokens_removed: number;
        prune_tokens_removed: number;
        context_before: number;
        context_after: number;
      };
    assert.equal(compact.phase, "compact");
    assert.equal(compact.compaction_triggered, 1);
    assert.equal(compact.snip_tokens_removed, 7_100);
    assert.equal(compact.prune_tokens_removed, 1_500);
    assert.equal(compact.context_before, 12_000);
    assert.equal(compact.context_after, 3_400);
    assert.ok(
      compact.snip_tokens_removed + compact.prune_tokens_removed === compact.context_before - compact.context_after,
      "ledger must show snip then prune reducing tokens before the summariser row",
    );
    const n = db.db.prepare(`SELECT COUNT(*) AS n FROM calls WHERE session_id = ?`).get(snap.sessionId) as { n: number };
    assert.equal(n.n, 2, "summariser spend is its own calls row, not folded into the assistant message");
    db.close();
  });

  it("T26.1: passes latencyMs/ttftMs through to the calls row, and leaves them NULL when the worker omitted them", () => {
    const snap = {
      sessionId: "t26-latency-fixture",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 300,
        output: 40,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "none",
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 200,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
            latencyMs: 850,
            ttftMs: 180,
          },
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            ts: new Date(OFF_PEAK.getTime() + 1000).toISOString(),
            // no latencyMs/ttftMs -- the worker did not observe message_start
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const rows = db.db
      .prepare(`SELECT latency_ms, ttft_ms FROM calls WHERE session_id = ? ORDER BY ts_utc`)
      .all(snap.sessionId) as Array<{ latency_ms: number | null; ttft_ms: number | null }>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.latency_ms, 850);
    assert.equal(rows[0]?.ttft_ms, 180);
    assert.equal(rows[1]?.latency_ms, null);
    assert.equal(rows[1]?.ttft_ms, null);
    db.close();
  });

  it("T20: records flag_trimmed_tool_surface from the hop-0 allowlist, not from SubagentWorkflow", () => {
    const trimmed = {
      sessionId: "t20-trimmed-fixture",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      // The documented resident surface, read from the registry rather than
      // spelled out: this test is about whether the FLAG recognises the
      // documented surface, not about which tools are on it this month. It
      // was a hard-coded four-tool list until P10.4 made three more tools
      // resident, at which point the fixture stopped describing a documented
      // surface at all and the flag correctly said so.
      activeTools: resolveResidentTools(),
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "none",
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    const withWorkflow = {
      ...trimmed,
      sessionId: "t20-workflow-fixture",
      // The documented host surface plus one tool that is not on it. The
      // flag must say "not the documented surface" for this, which is the
      // half of the assertion that would silently pass if the comparison
      // were a subset check rather than an equality one.
      activeTools: [...resolveResidentTools({ subagents: true }), "subagent_workflow"],
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, trimmed);
    ingestDelegateSnapshot(db, withWorkflow);
    const on = db.db
      .prepare(`SELECT flag_trimmed_tool_surface FROM sessions WHERE id = ?`)
      .get(trimmed.sessionId) as { flag_trimmed_tool_surface: number };
    const off = db.db
      .prepare(`SELECT flag_trimmed_tool_surface FROM sessions WHERE id = ?`)
      .get(withWorkflow.sessionId) as { flag_trimmed_tool_surface: number };
    assert.equal(on.flag_trimmed_tool_surface, 1);
    assert.equal(off.flag_trimmed_tool_surface, 0);
    db.close();
  });

  it("T21: records flag_prompt_diet, context_files, and explore_tool_calls from the snapshot", () => {
    const snap = {
      sessionId: "t21-diet-fixture",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      activeTools: ["read", "bash", "edit", "write"],
      toolCalls: [
        { name: "read" },
        { name: "read" },
        { name: "bash" },
        { name: "edit" },
      ],
      promptDiet: {
        enabled: true,
        toolResultMaxBytes: 32768,
        truncatedResults: 1,
        unchangedStubs: 0,
        contextFiles: [
          { name: "AGENTS.md", kind: "AGENTS.md", bytes: 40 },
          { name: "CLAUDE.md", kind: "CLAUDE.md", bytes: 80 },
        ],
      },
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "none",
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    const off = {
      ...snap,
      sessionId: "t21-diet-off-fixture",
      promptDiet: { enabled: false, contextFiles: [] },
      toolCalls: [{ name: "bash" }],
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    ingestDelegateSnapshot(db, off);
    const onRow = db.db
      .prepare(`SELECT flag_prompt_diet, explore_tool_calls, context_files FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { flag_prompt_diet: number; explore_tool_calls: number; context_files: string };
    const offRow = db.db
      .prepare(`SELECT flag_prompt_diet, explore_tool_calls, context_files FROM sessions WHERE id = ?`)
      .get(off.sessionId) as { flag_prompt_diet: number; explore_tool_calls: number; context_files: string | null };
    assert.equal(onRow.flag_prompt_diet, 1);
    assert.equal(onRow.explore_tool_calls, 2);
    assert.match(onRow.context_files, /AGENTS\.md/);
    assert.match(onRow.context_files, /CLAUDE\.md/);
    assert.equal(offRow.flag_prompt_diet, 0);
    assert.equal(offRow.explore_tool_calls, 0);
    assert.equal(offRow.context_files, null);
    db.close();
  });

  it("T23: records flag_output_diet from the snapshot, and the specialist it actually ran under", () => {
    const base = {
      sessionId: "t23-output-diet-fixture",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      activeTools: ["read", "bash", "edit", "write"],
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "none",
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    // Specialists ticket 01: `specialist` on the snapshot is what a real session
    // now carries (`session/session.ts`'s `buildStandaloneSnapshot`) — this
    // used to be hardcoded to "budget" (T23.3, predating specialists existing
    // as a real mechanism) regardless of what the snapshot said.
    const on = { ...base, outputDiet: { enabled: true }, specialist: "deliberate" };
    const off = { ...base, sessionId: "t23-output-diet-off-fixture", outputDiet: { enabled: false } };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, on);
    ingestDelegateSnapshot(db, off);
    const onRow = db.db
      .prepare(`SELECT flag_output_diet, specialist FROM sessions WHERE id = ?`)
      .get(on.sessionId) as { flag_output_diet: number; specialist: string };
    const offRow = db.db
      .prepare(`SELECT flag_output_diet, specialist FROM sessions WHERE id = ?`)
      .get(off.sessionId) as { flag_output_diet: number; specialist: string | null };
    assert.equal(onRow.flag_output_diet, 1);
    assert.equal(onRow.specialist, "deliberate");
    assert.equal(offRow.flag_output_diet, 0);
    // `off` selected no specialist at all — NULL, not a guessed default.
    assert.equal(offRow.specialist, null);
    db.close();
  });

  it("T17: a changed hop-0 fingerprint sets prefix_fingerprint_changed=1", () => {
    const snap = {
      sessionId: "head-fp-drift-fixture",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      headContract: { enabled: false },
      usage: {
        input: 20,
        output: 4,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "none",
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
            headFingerprint: "head-a",
          },
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 10,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            ts: new Date(OFF_PEAK.getTime() + 1000).toISOString(),
            headFingerprint: "head-b",
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const rows = db.db
      .prepare(
        `SELECT prefix_fingerprint, prefix_fingerprint_changed FROM calls WHERE session_id = ? ORDER BY ts_utc`,
      )
      .all(snap.sessionId) as Array<{ prefix_fingerprint: string; prefix_fingerprint_changed: number }>;
    assert.deepEqual(rows.map((r) => r.prefix_fingerprint), ["head-a", "head-b"]);
    assert.deepEqual(rows.map((r) => r.prefix_fingerprint_changed), [0, 1]);
    const flag = db.db
      .prepare(`SELECT flag_cache_stable_head FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { flag_cache_stable_head: number };
    assert.equal(flag.flag_cache_stable_head, 0);
    db.close();
  });
});

describe("T6.2: delegation avoided cost", () => {
  it("no delegation-accounting row is written when the trace has no get_subagent_result call", () => {
    // nestedSnap has real hop-1 spend but its toolCalls list is only
    // [{ name: "agent" }] -- no get_subagent_result. Already implicitly
    // proven by the childTotals.n === 1 assertion above; asserted directly
    // here so the guard has its own named coverage.
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, nestedSnap);
    const childId = hop1SessionId(db, nestedSnap.sessionId);
    const row = db.db
      .prepare(`SELECT COUNT(*) AS n FROM calls WHERE session_id = ? AND child_input_tokens IS NOT NULL`)
      .get(childId) as { n: number };
    assert.equal(row.n, 0);
    db.close();
  });

  it("records a positive avoided figure when the subagent's own work was cheap (heavily cached) relative to what it returned", () => {
    const snap = {
      sessionId: "t62-positive-fixture",
      label: "t6.2 positive",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      turns: 3,
      // 400 chars -> ceil(400/4) = 100 briefing tokens; 200 chars -> 50 summary tokens.
      toolCalls: [
        { name: "agent", args: "x".repeat(400) },
        { name: "get_subagent_result", result: "y".repeat(200) },
      ],
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 500,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        calls: [
          {
            hop: "direct",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 500,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
          {
            // The subagent did 100k tokens' worth of reading, but 99% of it
            // was its own cache hits, so its real cost is tiny relative to
            // what the parent would have paid to read the same content fresh.
            hop: "nested",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 1000,
            output: 0,
            cacheRead: 99000,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const childId = hop1SessionId(db, snap.sessionId);

    const row = db.db
      .prepare(
        `SELECT child_input_tokens, summary_tokens, briefing_tokens, handoff_loss, avoided_usd, avoided_basis
         FROM calls WHERE session_id = ? AND child_input_tokens IS NOT NULL`,
      )
      .get(childId) as {
      child_input_tokens: number;
      summary_tokens: number;
      briefing_tokens: number;
      handoff_loss: number;
      avoided_usd: number;
      avoided_basis: string;
    };
    assert.equal(row.child_input_tokens, 100_000); // 1000 fresh + 99000 cached
    assert.equal(row.summary_tokens, 50);
    assert.equal(row.briefing_tokens, 100);
    assert.equal(row.handoff_loss, 0);
    assert.match(row.avoided_basis, /T6\.2/);

    // child's real cost: 1000/1e6*0.22 (fresh, off-peak) + 99000/1e6*0.007 (cached) = 0.000913
    // avoided = (100000 - 50 - 100)/1e6 * 0.22 (parent's own off-peak input rate) - 0.000913
    const expected = (99_850 / 1e6) * 0.22 - 0.000913;
    assert.ok(Math.abs(row.avoided_usd - expected) < 1e-9, `expected ~${expected}, got ${row.avoided_usd}`);
    assert.ok(row.avoided_usd > 0.02, "a heavily-cached subagent should show a clearly positive avoided figure");
    db.close();
  });

  it("goes negative — a cost inversion — when briefing and summary tokens outweigh what the subagent actually avoided reading", () => {
    const snap = {
      sessionId: "t62-negative-fixture",
      label: "t6.2 negative",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      turns: 3,
      // A long briefing and a long summary for a trivially small subagent task.
      toolCalls: [
        { name: "agent", args: "x".repeat(4000) },
        { name: "get_subagent_result", result: "y".repeat(4000) },
      ],
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        calls: [
          {
            hop: "direct",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
          {
            hop: "nested",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 50,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);

    const inversions = db.db
      .prepare(`SELECT id, avoided_usd FROM v_cost_inversions`)
      .all() as Array<{ id: string; avoided_usd: number }>;
    assert.equal(inversions.length, 1, "the delegation-accounting row should be the one cost inversion");
    assert.ok(inversions[0]!.avoided_usd < 0);
    db.close();
  });

  it("v_delegation_by_hop returns a sensible row after a real delegated task", () => {
    const snap = {
      sessionId: "t62-view-fixture",
      label: "t6.2 view",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      turns: 2,
      toolCalls: [
        { name: "agent", args: "x".repeat(400) },
        { name: "get_subagent_result", result: "y".repeat(200) },
      ],
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 500,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        calls: [
          {
            hop: "direct",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 500,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
          {
            hop: "nested",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 1000,
            output: 0,
            cacheRead: 99000,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);

    const rows = db.db.prepare(`SELECT * FROM v_delegation_by_hop`).all() as Array<{
      hop: number;
      calls: number;
      child_input: number;
      returned: number;
      briefing: number;
      avoided_usd: number;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.hop, 1);
    assert.equal(rows[0]!.calls, 1);
    assert.equal(rows[0]!.child_input, 100_000);
    assert.equal(rows[0]!.returned, 50);
    assert.equal(rows[0]!.briefing, 100);
    assert.ok(rows[0]!.avoided_usd > 0);
    db.close();
  });

  it("the parent's own session summary includes hop-1 cost and avoided figures, not just its own hop-0 calls", () => {
    // T8.3 files hop-1 spend under a SEPARATE child session (parent_session_id
    // links it back), so a summary scoped to session_id = the parent alone
    // would silently omit every delegated dollar and every delegation-avoided
    // figure -- caught by rendering this fixture and comparing against a
    // hand-summed total before trusting loadSessionSummary() here.
    const snap = {
      sessionId: "t62-family-fixture",
      label: "t6.2 family rollup",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      turns: 3,
      toolCalls: [
        { name: "agent", args: "x".repeat(400) },
        { name: "get_subagent_result", result: "y".repeat(200) },
      ],
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 500,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        calls: [
          {
            hop: "direct",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 500,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
          {
            hop: "nested",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 1000,
            output: 0,
            cacheRead: 99000,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);

    const parentTotals = db.callTotals(snap.sessionId);
    const childId = hop1SessionId(db, snap.sessionId);
    const childTotals = db.callTotals(childId);

    const summary = loadSessionSummary(db, snap.sessionId)!;
    assert.equal(summary.tokens.input, parentTotals.input + childTotals.input);
    assert.equal(summary.tokens.cacheRead, parentTotals.cacheRead + childTotals.cacheRead);
    assert.ok(
      Math.abs(summary.totalCostUsd - ((parentTotals.costUsd ?? 0) + (childTotals.costUsd ?? 0))) < 1e-9,
      "the displayed cost must be the family total, not the parent session's own total_cost_usd column",
    );
    assert.ok(summary.avoidedUsd !== null && summary.avoidedUsd > 0.04);

    const text = formatSessionSummary(summary);
    assert.match(text, /hop 0 \(direct\)/);
    assert.match(text, /hop 1 \(subagent\)/);
    db.close();
  });
});

describe("T9: transcript capture", () => {
  function realLedger(): { ledger: Ledger; ledgerPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t9-ingest-"));
    const ledgerPath = join(dir, "ledger.db");
    return { ledger: Ledger.open(ledgerPath), ledgerPath };
  }

  it("produces a hash-verified transcript whose usage events all join back to `calls` rows", () => {
    const { ledger } = realLedger();
    const id = ingestDelegateSnapshot(ledger, nestedSnap);
    assert.equal(id, nestedSnap.sessionId);

    const row = ledger.db
      .prepare(`SELECT transcript_path, transcript_sha256, transcript_bytes FROM sessions WHERE id = ?`)
      .get(nestedSnap.sessionId) as { transcript_path: string; transcript_sha256: string; transcript_bytes: number };
    assert.ok(row.transcript_path);
    assert.equal(verifyTranscriptHash(row.transcript_path, row.transcript_sha256), true);
    const buf = readFileSync(row.transcript_path);
    assert.equal(buf.length, row.transcript_bytes);

    const { events, truncated } = readTranscript(row.transcript_path);
    assert.equal(truncated, false);
    const usageEvents = events.filter((e) => e.kind === "usage") as Array<{ call_id: string }>;
    assert.ok(usageEvents.length > 0);
    const callIds = new Set(
      (ledger.db.prepare(`SELECT id FROM calls WHERE session_id = ?`).all(nestedSnap.sessionId) as Array<{
        id: string;
      }>).map((c) => c.id),
    );
    for (const e of usageEvents) assert.ok(callIds.has(e.call_id), `usage event call_id ${e.call_id} has no matching calls row`);
    ledger.close();
  });

  it("never writes a planted secret from a tool result to the transcript file", () => {
    const { ledger } = realLedger();
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuv";
    const snap = {
      sessionId: "secret-fixture",
      label: "leaky task",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      turns: 1,
      toolCalls: [
        {
          seq: 1,
          name: "bash",
          state: "ok",
          args: { command: `echo ${secret}` },
          result: `printed ${secret}`,
        },
      ],
      lastText: `done, used key ${secret}`,
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "none",
      },
    };
    ingestDelegateSnapshot(ledger, snap);
    const row = ledger.db
      .prepare(`SELECT transcript_path FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { transcript_path: string };
    const raw = readFileSync(row.transcript_path, "utf8");
    assert.equal(raw.includes(secret), false);
    assert.ok(raw.includes("[REDACTED]"));
    ledger.close();
  });

  it("writes no transcript at all for a :memory: ledger", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, nestedSnap);
    const row = db.db
      .prepare(`SELECT transcript_path FROM sessions WHERE id = ?`)
      .get(nestedSnap.sessionId) as { transcript_path: string | null };
    assert.equal(row.transcript_path, null);
    db.close();
  });
});

describe("session row timing reflects the real run, not ingestion time", () => {
  it("stamps started_utc/ended_utc from the snapshot's startedAt/finishedAt", () => {
    const db = Ledger.open(":memory:");
    const startedAt = "2026-08-29T12:00:00.000Z";
    const finishedAt = "2026-08-29T12:00:47.000Z";
    const snap = {
      sessionId: "timing-fixture",
      label: "timing check",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      turns: 1,
      startedAt,
      finishedAt,
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, nestedBasis: "none" },
    };
    ingestDelegateSnapshot(db, snap);
    const row = db.db
      .prepare(`SELECT started_utc, ended_utc FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { started_utc: string; ended_utc: string };
    assert.equal(row.started_utc, startedAt);
    assert.equal(row.ended_utc, finishedAt);
    db.close();
  });
});

describe("resumed session ingest", () => {
  it("appends the second run's calls, totals, transcript and counters to the same session", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-resume-ingest-"));
    const ledger = Ledger.open(join(dir, "ledger.db"));
    const id = "resumed-same-session";
    const first = {
      sessionId: id,
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      startedAt: "2026-09-01T00:00:00.000Z",
      finishedAt: "2026-09-01T00:01:00.000Z",
      turns: 1,
      toolCalls: [{ name: "read", result: "first" }],
      usage: {
        input: 100,
        output: 10,
        cacheRead: 20,
        cacheWrite: 0,
        calls: [
          {
            hop: "direct" as const,
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 10,
            cacheRead: 20,
            cacheWrite: 0,
            ts: "2026-09-01T00:00:30.000Z",
          },
        ],
      },
    };
    ingestDelegateSnapshot(ledger, first, { executionShape: "standalone", runtime: "host" });
    ledger.recordOutcome({ id, outcome: "success", outcomeSource: "verification_command", verificationCmd: "npm test" });
    ledger.reopenSession(id);

    const second = {
      sessionId: id,
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      startedAt: "2026-09-01T00:02:00.000Z",
      finishedAt: "2026-09-01T00:03:00.000Z",
      turns: 2,
      toolCalls: [{ name: "bash", args: { command: "rg -n resume ." }, result: "second" }],
      compaction: { enabled: true, threshold: 0.8 },
      humanInterventions: 3,
      artifactBytes: 4096,
      approvals: { requested: 4, denied: 1, autoDenied: 1, byTier: '{"soft":4}', byMode: '{"ask":4}' },
      hooks: { registered: 2, denials: 1, notes: 3 },
      checkpoints: { enabled: true, written: 2 },
      ask: { asked: 2, answered: 1, unanswered: 1 },
      skills: { available: 3, invoked: ["tdd"], reads: 2, headTokens: 80 },
      postEdit: { enabled: true, command: "npm test", runs: 2, failures: 1, passes: 1, totalMs: 1500 },
      taskList: { calls: 3, created: 2, completed: 1, open: 1, reminders: 1, gateRefusals: 1, verified: 1 },
      stagnation: { trips: 1, key: "same-output" },
      retry: { starts: 2, recovered: 1, exhausted: 1, maxAttempt: 2, lastError: "timeout" },
      usage: {
        input: 200,
        output: 20,
        cacheRead: 30,
        cacheWrite: 0,
        calls: [
          {
            hop: "direct" as const,
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 200,
            output: 20,
            cacheRead: 30,
            cacheWrite: 0,
            ts: "2026-09-01T00:02:30.000Z",
          },
          {
            hop: "direct" as const,
            source: "compaction",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 20,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            ts: "2026-09-01T00:02:40.000Z",
          },
          {
            hop: "direct" as const,
            source: "compaction",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 20,
            output: 2,
            cacheRead: 0,
            cacheWrite: 0,
            ts: "2026-09-01T00:02:50.000Z",
          },
        ],
      },
    };
    ingestDelegateSnapshot(ledger, second, { executionShape: "standalone", runtime: "host" });

    const row = ledger.db
      .prepare(
        `SELECT ended_utc, total_cost_usd, transcript_path, transcript_sha256,
                turns, tool_calls, explore_tool_calls, outcome, outcome_source, verification_cmd,
                compactions, human_interventions, artifact_bytes, approvals_requested,
                approvals_denied, approvals_auto_denied, hooks_registered, hook_denials,
                hook_notes, checkpoints_written, ask_calls, ask_answered, ask_unanswered,
                skills_available, skill_reads, skills_head_tokens, post_edit_runs,
                post_edit_failures, post_edit_passes, post_edit_ms, task_list_calls,
                task_list_created, task_list_completed, task_list_open, task_list_reminders,
                task_gate_refusals, task_items_verified, stagnation_trips, retry_starts,
                retries_recovered, retries_exhausted, retry_max_attempt
         FROM sessions WHERE id = ?`,
      )
      .get(id) as {
      ended_utc: string | null;
      total_cost_usd: number;
      transcript_path: string;
      transcript_sha256: string;
      turns: number;
      tool_calls: number;
      explore_tool_calls: number;
      outcome: string;
      outcome_source: string;
      verification_cmd: string;
      compactions: number;
      human_interventions: number;
      artifact_bytes: number;
      approvals_requested: number;
      approvals_denied: number;
      approvals_auto_denied: number;
      hooks_registered: number;
      hook_denials: number;
      hook_notes: number;
      checkpoints_written: number;
      ask_calls: number;
      ask_answered: number;
      ask_unanswered: number;
      skills_available: number;
      skill_reads: number;
      skills_head_tokens: number;
      post_edit_runs: number;
      post_edit_failures: number;
      post_edit_passes: number;
      post_edit_ms: number;
      task_list_calls: number;
      task_list_created: number;
      task_list_completed: number;
      task_list_open: number;
      task_list_reminders: number;
      task_gate_refusals: number;
      task_items_verified: number;
      stagnation_trips: number;
      retry_starts: number;
      retries_recovered: number;
      retries_exhausted: number;
      retry_max_attempt: number;
    };
    assert.equal(row.ended_utc, second.finishedAt);
    assert.equal(row.total_cost_usd, ledger.callTotals(id).costUsd);
    assert.equal(ledger.callTotals(id).n, 4);
    assert.equal(row.turns, 3);
    assert.equal(row.tool_calls, 2);
    assert.equal(row.explore_tool_calls, 2);
    assert.equal(row.outcome, "success");
    assert.equal(row.outcome_source, "verification_command");
    assert.equal(row.verification_cmd, "npm test");
    assert.equal(row.compactions, 2);
    assert.equal(row.human_interventions, 3);
    assert.equal(row.artifact_bytes, 4096);
    assert.equal(row.approvals_requested, 4);
    assert.equal(row.approvals_denied, 1);
    assert.equal(row.approvals_auto_denied, 1);
    assert.equal(row.hooks_registered, 2);
    assert.equal(row.hook_denials, 1);
    assert.equal(row.hook_notes, 3);
    assert.equal(row.checkpoints_written, 2);
    assert.equal(row.ask_calls, 2);
    assert.equal(row.ask_answered, 1);
    assert.equal(row.ask_unanswered, 1);
    assert.equal(row.skills_available, 3);
    assert.equal(row.skill_reads, 2);
    assert.equal(row.skills_head_tokens, 80);
    assert.equal(row.post_edit_runs, 2);
    assert.equal(row.post_edit_failures, 1);
    assert.equal(row.post_edit_passes, 1);
    assert.equal(row.post_edit_ms, 1500);
    assert.equal(row.task_list_calls, 3);
    assert.equal(row.task_list_created, 2);
    assert.equal(row.task_list_completed, 1);
    assert.equal(row.task_list_open, 1);
    assert.equal(row.task_list_reminders, 1);
    assert.equal(row.task_gate_refusals, 1);
    assert.equal(row.task_items_verified, 1);
    assert.equal(row.stagnation_trips, 1);
    assert.equal(row.retry_starts, 2);
    assert.equal(row.retries_recovered, 1);
    assert.equal(row.retries_exhausted, 1);
    assert.equal(row.retry_max_attempt, 2);
    assert.equal(verifyTranscriptHash(row.transcript_path, row.transcript_sha256), true);
    ledger.close();
  });

  it("preserves an earlier verified outcome and records a conflicting resumed verdict", () => {
    const ledger = Ledger.open(":memory:");
    const id = "resumed-conflicting-verdict";
    ingestDelegateSnapshot(ledger, {
      sessionId: id,
      state: "done",
      model: "deepseek/deepseek-v4-flash",
      finishedAt: "2026-09-01T00:01:00.000Z",
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    ledger.recordOutcome({ id, outcome: "success", outcomeSource: "verification_command", verificationCmd: "npm test" });
    ledger.reopenSession(id);
    ingestDelegateSnapshot(ledger, {
      sessionId: id,
      state: "error",
      model: "deepseek/deepseek-v4-flash",
      finishedAt: "2026-09-01T00:02:00.000Z",
      error: "second run failed",
      usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
    const row = ledger.db
      .prepare(`SELECT outcome, outcome_source, verification_cmd, notes FROM sessions WHERE id = ?`)
      .get(id) as {
      outcome: string;
      outcome_source: string;
      verification_cmd: string;
      notes: string;
    };
    assert.equal(row.outcome, "success");
    assert.equal(row.outcome_source, "verification_command");
    assert.equal(row.verification_cmd, "npm test");
    assert.match(row.notes, /later run verdict 'fail' was not applied/);
    assert.match(row.notes, /existing outcome 'success'/);
    ledger.close();
  });

  it("records a resumed run's failure when no earlier outcome exists", () => {
    const ledger = Ledger.open(":memory:");
    const id = "resumed-failure";
    ingestDelegateSnapshot(ledger, {
      sessionId: id,
      state: "done",
      model: "deepseek/deepseek-v4-flash",
      finishedAt: "2026-09-01T00:01:00.000Z",
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
    });
    ledger.reopenSession(id);
    ingestDelegateSnapshot(ledger, {
      sessionId: id,
      state: "error",
      model: "deepseek/deepseek-v4-flash",
      finishedAt: "2026-09-01T00:02:00.000Z",
      usage: { input: 20, output: 2, cacheRead: 0, cacheWrite: 0 },
    });
    const row = ledger.db.prepare(`SELECT outcome, outcome_source FROM sessions WHERE id = ?`).get(id) as {
      outcome: string;
      outcome_source: string | null;
    };
    assert.equal(row.outcome, "fail");
    assert.equal(row.outcome_source, null);
    ledger.close();
  });
});

describe("T5.1: session summary is written beside the transcript and printed to stderr", () => {
  it("writes summary.txt for the parent session next to transcript.jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t5-ingest-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    ingestDelegateSnapshot(ledger, nestedSnap);

    const summaryPath = join(transcriptDir(ledgerPath, nestedSnap.sessionId), "summary.txt");
    const text = readFileSync(summaryPath, "utf8");
    assert.match(text, /lykos {2}session [0-9a-f]{8}/);
    // T6.1: real cache-avoided figure now, not "not yet computed" -- nestedSnap
    // carries real cache-read tokens on its hop-0 calls.
    assert.match(text, /avoided\s+~\$0\.0011/);
    ledger.close();
  });

  it("never writes summary.txt for a hop-1 child session, only the parent's", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t5-ingest-child-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    ingestDelegateSnapshot(ledger, nestedSnap);

    const childRow = ledger.db
      .prepare(`SELECT id FROM sessions WHERE parent_session_id = ?`)
      .get(nestedSnap.sessionId) as { id: string } | undefined;
    assert.ok(childRow, "expected a hop-1 child session from the nested fixture");
    assert.throws(() => readFileSync(join(transcriptDir(ledgerPath, childRow!.id), "summary.txt"), "utf8"));
    ledger.close();
  });

  it("prints the finished summary to stderr, never stdout, when a JSON-RPC line completes a run", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t5-stderr-"));
    const ledgerPath = join(dir, "ledger.db");
    const payload = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            sessionId: "mcp-summary-line",
            label: "stderr print check",
            state: "done",
            model: "deepseek/deepseek-v4-flash",
            finishedAt: OFF_PEAK.toISOString(),
            usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, nestedBasis: "none" },
          }),
        },
      ],
    };
    const line = JSON.stringify({ jsonrpc: "2.0", id: 5, result: payload });

    const originalStderr = process.stderr.write.bind(process.stderr);
    const originalStdout = process.stdout.write.bind(process.stdout);
    let stderrOut = "";
    let stdoutOut = "";
    process.stderr.write = ((chunk: string) => {
      stderrOut += chunk;
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutOut += chunk;
      return true;
    }) as typeof process.stdout.write;
    try {
      tryIngestMcpJsonRpcLine(line, { workspace: dir, ledgerPath });
    } finally {
      process.stderr.write = originalStderr;
      process.stdout.write = originalStdout;
    }
    assert.equal(stdoutOut, "");
    assert.match(stderrOut, /lykos {2}session .{8}\s+│\s+stderr print check/);
    // T6.1: no cache activity in this fixture (cacheRead: 0), so the real,
    // exactly-computed avoided figure is zero -- a measured zero, not an
    // absence, so it renders as "~$0.0000" rather than "not yet computed."
    assert.match(stderrOut, /avoided\s+~\$0\.0000/);
  });
});

describe("ingestDelegateSnapshot — T29 declarative extension surface", () => {
  function baseSnap(id: string, activeTools: string[]) {
    return {
      sessionId: id,
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      activeTools,
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "none",
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
  }

  it("records extensions and extension_set from snap.extensions.declared, in declaration order", () => {
    const snap = {
      ...baseSnap("t29-declared-fixture", [...PI_DEFAULT_TOOLS]),
      extensions: {
        declared: [
          { name: "pi-hashline-edit", version: "0.8.3", path: "/home/node/.pi/agent/npm/node_modules/pi-hashline-edit" },
          { name: "pi-cache-optimizer", version: "2.8.6" },
        ],
        loaded: ["pi-hashline-edit", "pi-cache-optimizer"],
        source: "env" as const,
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const row = db.db
      .prepare(`SELECT extensions, extension_set FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { extensions: string; extension_set: string };
    assert.deepEqual(JSON.parse(row.extensions), [
      { name: "pi-hashline-edit", version: "0.8.3" },
      { name: "pi-cache-optimizer", version: "2.8.6" },
    ]);
    assert.notEqual(row.extension_set, "none");
    assert.match(row.extension_set, /^[0-9a-f]{12}$/);
    db.close();
  });

  it("records extension_set='none' and extensions NULL when nothing was declared", () => {
    const snap = baseSnap("t29-none-declared-fixture", [...PI_DEFAULT_TOOLS]);
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const row = db.db
      .prepare(`SELECT extensions, extension_set FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { extensions: string | null; extension_set: string };
    assert.equal(row.extensions, null);
    assert.equal(row.extension_set, "none");
    db.close();
  });

  it("measures a 0-token, 0-share tax when the active toolset matches Pi's own built-ins", () => {
    const snap = baseSnap("t29-baseline-fixture", [...PI_DEFAULT_TOOLS]);
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const row = db.db
      .prepare(`SELECT extension_schema_tokens, extension_schema_share, notes FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { extension_schema_tokens: number; extension_schema_share: number; notes: string | null };
    assert.equal(row.extension_schema_tokens, 0);
    assert.equal(row.extension_schema_share, 0);
    assert.ok(!row.notes || !row.notes.includes("kill line"));
    db.close();
  });

  it("measures the tax as the delta above Pi's own built-ins, and flags a share past the 10% kill line", () => {
    const tools = [...PI_DEFAULT_PLUS_SUBAGENTS];
    const measured = measureToolset(tools);
    assert.ok(measured.complete && measured.tokens !== null);
    const expectedTokens = measured.tokens! - piDefaultBaseline().tokens;
    // The share's denominator is BILLED input (fresh + cache_read), the same one
    // v_schema_tax uses and the one problems/14 states its thresholds in -- not
    // the tool schema, which would put pi-subagents alone near 75% and trip the
    // line on every session. baseSnap bills 100 input tokens and no cache read.
    const expectedShare = expectedTokens / 100;
    assert.ok(expectedShare > 0.1, "fixture must actually cross the kill line to test it");

    const snap = {
      ...baseSnap("t29-over-line-fixture", tools),
      extensions: {
        declared: [{ name: "@tintinweb/pi-subagents", version: "0.19.0" }],
        loaded: ["@tintinweb/pi-subagents"],
        source: "env" as const,
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const row = db.db
      .prepare(`SELECT extension_schema_tokens, extension_schema_share, notes FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { extension_schema_tokens: number; extension_schema_share: number; notes: string | null };
    assert.equal(row.extension_schema_tokens, expectedTokens);
    assert.equal(row.extension_schema_share, expectedShare);
    assert.match(row.notes ?? "", /crosses the 10% kill line/);
    db.close();
  });

  it("leaves both schema-tax columns NULL, never a partial number, when the catalog does not know a tool", () => {
    const snap = baseSnap("t29-unknown-tool-fixture", ["read", "bash", "edit", "write", "totally-unknown-extension-tool"]);
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const row = db.db
      .prepare(`SELECT extension_schema_tokens, extension_schema_share, notes FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { extension_schema_tokens: number | null; extension_schema_share: number | null; notes: string | null };
    assert.equal(row.extension_schema_tokens, null);
    assert.equal(row.extension_schema_share, null);
    assert.match(row.notes ?? "", /catalog does not know: totally-unknown-extension-tool/);
    db.close();
  });

  it("records declared-but-missing extensions in notes so the gap is never silent", () => {
    const snap = {
      ...baseSnap("t29-missing-fixture", [...PI_DEFAULT_TOOLS]),
      extensions: {
        declared: [{ name: "pi-hashline-edit", version: "0.8.3" }],
        loaded: [] as string[],
        missing: ["pi-hashline-edit"],
        source: "env" as const,
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const row = db.db.prepare(`SELECT notes FROM sessions WHERE id = ?`).get(snap.sessionId) as {
      notes: string | null;
    };
    assert.match(row.notes ?? "", /declared but missing from image: pi-hashline-edit/);
    db.close();
  });
});

describe("ingestDelegateSnapshot — T31 execution_shape and runtime", () => {
  function baseSnap(id: string, extra: Partial<Parameters<typeof ingestDelegateSnapshot>[1]> = {}) {
    return {
      sessionId: id,
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      activeTools: [...PI_DEFAULT_TOOLS],
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "none",
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
      ...extra,
    };
  }

  it("labels a session mcp_worker when snap.label is one of the four lykos_ tool names", () => {
    const snap = baseSnap("t31-mcp-fixture", { label: "lykos_implement" });
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const row = db.db
      .prepare(`SELECT execution_shape, runtime FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { execution_shape: string; runtime: string };
    assert.equal(row.execution_shape, "mcp_worker");
    assert.equal(row.runtime, "container");
    db.close();
  });

  // 2026-09-07 (UI feedback item 9): "Why if past sessions called
  // (delegate)?" — because every unlabelled session got that literal brief,
  // including the interactive one a person drives, and every listing then
  // treated it as a human-chosen name and showed it in preference to
  // anything real.
  it("names a standalone session nothing rather than calling it (delegate)", () => {
    const snap = baseSnap("brief-standalone");
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap, { executionShape: "standalone" });
    const row = db.db.prepare(`SELECT brief FROM sessions WHERE id = ?`).get(snap.sessionId) as { brief: string | null };
    // NULL, not a placeholder: the browser reads NULL as "nobody named
    // this" and fills it in from the first thing that was typed, and a
    // placeholder would outrank the truth.
    assert.equal(row.brief, null);
    db.close();
  });

  it("keeps (delegate) for the shape it was ever true of", () => {
    const snap = baseSnap("brief-delegate");
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const row = db.db.prepare(`SELECT brief, execution_shape FROM sessions WHERE id = ?`).get(snap.sessionId) as {
      brief: string | null;
      execution_shape: string;
    };
    assert.equal(row.execution_shape, "cli_delegate");
    assert.equal(row.brief, "(delegate)");
    db.close();
  });

  it("writes the session's own name when the caller supplies one", () => {
    const snap = baseSnap("brief-named", { label: "fix the exploration metric" });
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap, { executionShape: "standalone" });
    const row = db.db.prepare(`SELECT brief FROM sessions WHERE id = ?`).get(snap.sessionId) as { brief: string | null };
    assert.equal(row.brief, "fix the exploration metric");
    db.close();
  });

  it("labels a session cli_delegate when snap.label is unset (lykos run's own default)", () => {
    const snap = baseSnap("t31-cli-fixture");
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const row = db.db
      .prepare(`SELECT execution_shape FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { execution_shape: string };
    assert.equal(row.execution_shape, "cli_delegate");
    db.close();
  });

  it("labels a session cli_delegate when snap.label is set but is not one of the four MCP tool names", () => {
    const snap = baseSnap("t31-cli-labelled-fixture", { label: "not-a-real-mcp-tool" });
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const row = db.db
      .prepare(`SELECT execution_shape FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { execution_shape: string };
    assert.equal(row.execution_shape, "cli_delegate");
    db.close();
  });

  it("labels a hop-1 child session subagent, independent of the parent's shape", () => {
    const snap = baseSnap("t31-subagent-parent-fixture", {
      label: "lykos_refactor",
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        nestedBasis: "tokens",
        nestedInput: 50,
        nestedOutput: 5,
        nestedCacheRead: 0,
        nestedCacheWrite: 0,
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
          {
            hop: "nested",
            source: "tool_result",
            subagentType: "scout",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 50,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    });
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap);
    const rows = db.db
      .prepare(`SELECT id, execution_shape, parent_session_id FROM sessions ORDER BY started_utc`)
      .all() as Array<{ id: string; execution_shape: string; parent_session_id: string | null }>;
    const parent = rows.find((r) => r.parent_session_id === null);
    const child = rows.find((r) => r.parent_session_id !== null);
    assert.equal(parent?.execution_shape, "mcp_worker");
    assert.equal(child?.execution_shape, "subagent");
    db.close();
  });

  it("opts.executionShape/opts.runtime override the label-based auto-detect — the standalone path (T33) states its shape directly", () => {
    const snap = baseSnap("t31-standalone-fixture");
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap, { executionShape: "standalone", runtime: "host" });
    const row = db.db
      .prepare(`SELECT execution_shape, runtime FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { execution_shape: string; runtime: string };
    assert.equal(row.execution_shape, "standalone");
    assert.equal(row.runtime, "host");
    db.close();
  });
});

describe("ingestDelegateSnapshot — T34.3 human_interventions", () => {
  function baseSnap(id: string, extra: Partial<Parameters<typeof ingestDelegateSnapshot>[1]> = {}) {
    return {
      sessionId: id,
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      finishedAt: OFF_PEAK.toISOString(),
      activeTools: [...PI_DEFAULT_TOOLS],
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
      ...extra,
    };
  }

  it("a snapshot's humanInterventions reaches sessions.human_interventions — the first writer that column has ever had", () => {
    const snap = baseSnap("t34-steer-fixture", { humanInterventions: 2 });
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap, { executionShape: "standalone", runtime: "host" });
    const row = db.db
      .prepare(`SELECT human_interventions FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { human_interventions: number };
    assert.equal(row.human_interventions, 2);
    db.close();
  });

  it("a snapshot with no humanInterventions field leaves the column at its default (0), never a guess", () => {
    const snap = baseSnap("t34-no-steer-fixture");
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap, { executionShape: "standalone", runtime: "host" });
    const row = db.db
      .prepare(`SELECT human_interventions FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { human_interventions: number };
    assert.equal(row.human_interventions, 0);
    db.close();
  });

  it("T35.3 / T36: a second declared provider records model_source, auth_mode, and unpriced dollars as NULL", () => {
    const snap = {
      sessionId: "t35-second-provider-fixture",
      label: "second-provider",
      state: "done" as const,
      model: "local-proxy/proxy-model",
      turns: 1,
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "local-proxy",
            model: "proxy-model",
            input: 100,
            output: 10,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap, {
      executionShape: "standalone",
      runtime: "host",
      modelSource: "caller_override",
      providers: {
        deepseek: { auth: "api_key", priced: true },
        "local-proxy": { auth: "gateway", priced: false },
      },
    });
    const session = db.db
      .prepare(`SELECT model, model_source FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { model: string; model_source: string };
    assert.equal(session.model, "proxy-model");
    assert.equal(session.model_source, "caller_override");
    const call = db.db
      .prepare(`SELECT auth_mode, price_basis, cost_usd, input_tokens, output_tokens FROM calls WHERE session_id = ?`)
      .get(snap.sessionId) as {
      auth_mode: string;
      price_basis: string;
      cost_usd: number | null;
      input_tokens: number;
      output_tokens: number;
    };
    assert.equal(call.auth_mode, "gateway");
    assert.equal(call.price_basis, "unpriced");
    assert.equal(call.cost_usd, null);
    assert.equal(call.input_tokens, 100);
    assert.equal(call.output_tokens, 10);
    db.close();
  });

  it("T36.1: an undeclared provider records unknown / unpriced rather than guessing api_key", () => {
    const snap = {
      sessionId: "t36-undeclared-fixture",
      state: "done" as const,
      model: "mystery/mystery-model",
      turns: 1,
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 10,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        calls: [
          {
            hop: "direct",
            provider: "mystery",
            model: "mystery-model",
            input: 10,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap, {
      providers: { deepseek: { auth: "api_key", priced: true } },
    });
    const call = db.db
      .prepare(`SELECT auth_mode, price_basis, cost_usd FROM calls WHERE session_id = ?`)
      .get(snap.sessionId) as { auth_mode: string; price_basis: string; cost_usd: number | null };
    assert.equal(call.auth_mode, "unknown");
    assert.equal(call.price_basis, "unpriced");
    assert.equal(call.cost_usd, null);
    db.close();
  });
});

describe("T53: capture_mode, and one writer per transcript", () => {
  function realLedger(): { ledger: Ledger; ledgerPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t53-ingest-"));
    const ledgerPath = join(dir, "ledger.db");
    return { ledger: Ledger.open(ledgerPath), ledgerPath };
  }

  it("labels a snapshot-derived session `snapshot` — the delegate path is named, not downgraded", () => {
    const { ledger } = realLedger();
    ingestDelegateSnapshot(ledger, nestedSnap);
    const row = ledger.db
      .prepare(`SELECT capture_mode FROM sessions WHERE id = ?`)
      .get(nestedSnap.sessionId) as { capture_mode: string };
    assert.equal(row.capture_mode, "snapshot");
    ledger.close();
  });

  it("labels a live-captured session `stream`, keeps the recorder's events, and re-appends none of them", () => {
    const { ledger, ledgerPath } = realLedger();
    const snap = { ...nestedSnap, sessionId: "t53-live-session", lastText: "the final answer" };
    const recorder = new LiveTranscriptRecorder(ledgerPath, snap.sessionId);
    recorder.userMessage("do the thing");
    recorder.append({ kind: "assistant_message", text: "the final answer", final: false });

    ingestDelegateSnapshot(ledger, snap, { liveTranscript: recorder });

    const row = ledger.db
      .prepare(`SELECT capture_mode, transcript_path, transcript_sha256 FROM sessions WHERE id = ?`)
      .get(snap.sessionId) as { capture_mode: string; transcript_path: string; transcript_sha256: string };
    assert.equal(row.capture_mode, "stream");
    // Still hashed at session end, and still verifiable — moving capture
    // earlier must not cost the integrity check.
    assert.equal(verifyTranscriptHash(row.transcript_path, row.transcript_sha256), true);

    const { events } = readTranscript(row.transcript_path);
    // The user message the snapshot path could never record survives ingest.
    assert.equal(events.filter((e) => e.kind === "user_message").length, 1);
    // And the snapshot's copy of the last reply is NOT appended on top of
    // the live one — that would make the final turn look like two.
    assert.equal(events.filter((e) => e.kind === "assistant_message").length, 1);
    // turn_index stays a single monotonic sequence: two writers on one file
    // would produce two counters and an interleaved mess.
    assert.deepEqual(
      events.map((e) => e.turn_index),
      events.map((_, i) => i),
    );
    // Ingest still owns the closing outcome line and the ledger-joining
    // usage lines — it is still the only writer of `sessions` and `calls`.
    assert.equal(events.filter((e) => e.kind === "outcome").length, 1);
    assert.ok(events.some((e) => e.kind === "usage"));
    ledger.close();
  });

  it("does not overwrite the boot-written meta.json with the subset ingest can see", () => {
    const { ledger, ledgerPath } = realLedger();
    const snap = { ...nestedSnap, sessionId: "t53-meta-session" };
    const recorder = new LiveTranscriptRecorder(ledgerPath, snap.sessionId);
    recorder.writeMeta({
      taskId: null,
      projectId: null,
      parentSessionId: null,
      resumedFrom: null,
      agentRole: "worker",
      model: "deepseek/deepseek-v4-flash",
      cwd: "/work",
      startedUtc: "2026-09-03T00:00:00.000Z",
    });
    ingestDelegateSnapshot(ledger, snap, { liveTranscript: recorder });
    const meta = JSON.parse(
      readFileSync(join(transcriptDir(ledgerPath, snap.sessionId), "meta.json"), "utf8"),
    ) as { schemaVersion: number; captureMode?: string };
    assert.equal(meta.schemaVersion, 2);
    assert.equal(meta.captureMode, "stream");
    ledger.close();
  });
});

describe("T63: the repaired exploration metric, end to end", () => {
  /** A snapshot whose exploration happens where it really happens after T20: through bash. */
  const snapWith = (sessionId: string, toolCalls: DelegateToolCall[]) => ({
    sessionId,
    state: "done" as const,
    model: "deepseek/deepseek-v4-flash",
    finishedAt: OFF_PEAK.toISOString(),
    activeTools: ["read", "bash", "edit", "write"],
    toolCalls,
    usage: {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      nestedBasis: "none",
      calls: [
        {
          hop: "direct",
          source: "assistant_message",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          ts: OFF_PEAK.toISOString(),
        },
      ],
    },
  });

  it("counts search through bash — the 4.6x the v1 counter could not see", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      db,
      snapWith("t63-bash", [
        { name: "bash", args: { command: 'grep -rn "sessions" lykos/cli/*.ts | head -20' }, result: "x".repeat(400) },
        { name: "bash", args: { command: "git status --short && git log --oneline -5" }, result: "y".repeat(100) },
        { name: "read", result: "z".repeat(500) },
        { name: "bash", args: { command: "npm test" }, result: "w".repeat(1000) },
        { name: "edit", result: "ok" },
      ]),
    );
    const row = db.db
      .prepare(
        `SELECT explore_tool_calls, explore_metric_version, explore_result_bytes,
                tool_result_bytes, explore_breakdown FROM sessions WHERE id = ?`,
      )
      .get("t63-bash") as {
      explore_tool_calls: number;
      explore_metric_version: number;
      explore_result_bytes: number;
      tool_result_bytes: number;
      explore_breakdown: string;
    };
    // v1 would have counted 1 (the lone `read`). v3 counts 3.
    assert.equal(row.explore_tool_calls, 3);
    assert.equal(row.explore_metric_version, 3);
    assert.equal(row.explore_result_bytes, 1000);
    assert.equal(row.tool_result_bytes, 2002);
    const breakdown = JSON.parse(row.explore_breakdown) as Record<string, { calls: number; bytes: number } | undefined>;
    assert.equal(breakdown.search?.calls, 1);
    assert.equal(breakdown.history?.calls, 1);
    assert.equal(breakdown.read?.calls, 1);
    db.close();
  });

  it("does not count a bash call that ran the tests, or an edit", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      db,
      snapWith("t63-nonexplore", [
        { name: "bash", args: { command: "npm run build && npm test" }, result: "out" },
        { name: "write", result: "ok" },
      ]),
    );
    const row = db.db
      .prepare(`SELECT explore_tool_calls, explore_result_bytes, tool_result_bytes FROM sessions WHERE id = ?`)
      .get("t63-nonexplore") as { explore_tool_calls: number; explore_result_bytes: number; tool_result_bytes: number };
    assert.equal(row.explore_tool_calls, 0);
    assert.equal(row.explore_result_bytes, 0);
    // The denominator still counts them: 3 bytes of "out" + 2 of "ok".
    assert.equal(row.tool_result_bytes, 5);
    db.close();
  });

  it("surfaces the session in v_exploration with a computed share", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      db,
      snapWith("t63-view", [
        { name: "bash", args: { command: "rg -n foo ." }, result: "a".repeat(750) },
        { name: "bash", args: { command: "npm test" }, result: "b".repeat(250) },
      ]),
    );
    const row = db.db.prepare(`SELECT * FROM v_exploration WHERE session_id = ?`).get("t63-view") as {
      share: number;
      explore_calls: number;
      explore_bytes: number;
      tool_bytes: number;
    };
    assert.equal(row.share, 0.75);
    assert.equal(row.explore_calls, 1);
    assert.equal(row.explore_bytes, 750);
    assert.equal(row.tool_bytes, 1000);
    db.close();
  });

  it("v_exploration excludes v1 rows, and the summary says how many it left out", () => {
    const db = Ledger.open(":memory:");
    // A genuine pre-T63 row: ended without any of the v3 fields.
    db.startSession({ id: "t63-v1-row", harnessCommit: "deadbeef" });
    db.endSession({ id: "t63-v1-row", toolCalls: 9, exploreToolCalls: 4 });
    ingestDelegateSnapshot(
      db,
      snapWith("t63-v3-row", [{ name: "bash", args: { command: "ls -la" }, result: "a".repeat(10) }]),
    );

    const v1 = db.db
      .prepare(`SELECT explore_metric_version, explore_result_bytes, tool_result_bytes FROM sessions WHERE id = ?`)
      .get("t63-v1-row") as {
      explore_metric_version: number | null;
      explore_result_bytes: number | null;
      tool_result_bytes: number | null;
    };
    // NULL, never 0: the row was written under a definition that did not measure this.
    assert.equal(v1.explore_metric_version, null);
    assert.equal(v1.explore_result_bytes, null);
    assert.equal(v1.tool_result_bytes, null);

    const ids = db.db.prepare(`SELECT session_id FROM v_exploration`).all() as Array<{ session_id: string }>;
    assert.deepEqual(
      ids.map((r) => r.session_id),
      ["t63-v3-row"],
    );

    const summary = db.db.prepare(`SELECT * FROM v_exploration_summary`).get() as {
      sessions_v1: number;
      sessions_v2: number;
      sessions_v3: number;
      share: number;
    };
    assert.equal(summary.sessions_v1, 1);
    assert.equal(summary.sessions_v2, 0);
    assert.equal(summary.sessions_v3, 1);
    assert.equal(summary.share, 1);
    db.close();
  });

  it("leaves share NULL for a session that ran no tool at all", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snapWith("t63-no-tools", []));
    const row = db.db.prepare(`SELECT share, tool_bytes FROM v_exploration WHERE session_id = ?`).get("t63-no-tools") as {
      share: number | null;
      tool_bytes: number;
    };
    assert.equal(row.tool_bytes, 0);
    assert.equal(row.share, null);
    db.close();
  });
});

describe("T64: hit quality, recorded from the session's own answer key", () => {
  const snapWith = (sessionId: string, toolCalls: DelegateToolCall[]) => ({
    sessionId,
    state: "done" as const,
    model: "deepseek/deepseek-v4-flash",
    finishedAt: OFF_PEAK.toISOString(),
    activeTools: ["read", "bash", "edit", "write"],
    toolCalls,
    usage: {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      nestedBasis: "none",
      calls: [
        {
          hop: "direct",
          source: "assistant_message",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          ts: OFF_PEAK.toISOString(),
        },
      ],
    },
  });

  const row = (db: Ledger, id: string) =>
    db.db
      .prepare(
        `SELECT edited_files, edited_file_count, blind_edits, first_touch_rank,
                hit_quality, hit_quality_version
         FROM sessions WHERE id = ?`,
      )
      .get(id) as {
      edited_files: string | null;
      edited_file_count: number | null;
      blind_edits: number | null;
      first_touch_rank: number | null;
      hit_quality: number | null;
      hit_quality_version: number | null;
    };

  it("records the rank of the exploration that found each edited file", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      db,
      snapWith("t64-rank", [
        { name: "bash", args: { command: "ls lykos/" }, state: "ok" },
        { name: "bash", args: { command: "grep -rn nope lykos/cli" }, state: "ok" },
        { name: "read", args: { path: "lykos/session/session.ts" }, state: "ok" },
        { name: "edit", args: { path: "lykos/session/session.ts" }, state: "ok" },
      ]),
    );
    const r = row(db, "t64-rank");
    assert.equal(r.edited_file_count, 1);
    assert.equal(r.blind_edits, 0);
    assert.equal(r.first_touch_rank, 3);
    assert.equal(r.hit_quality, 1);
    assert.equal(r.hit_quality_version, 3);
    const files = JSON.parse(r.edited_files ?? "[]") as Array<{ path: string; rank: number }>;
    assert.equal(files[0]?.path, "lykos/session/session.ts");
    assert.equal(files[0]?.rank, 3);
    db.close();
  });

  it("does not write calls.retrieval_hit_quality — that column scores a retrieval call, and there is no retrieval", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      db,
      snapWith("t64-not-retrieval", [
        { name: "read", args: { path: "a.ts" }, state: "ok" },
        { name: "edit", args: { path: "a.ts" }, state: "ok" },
      ]),
    );
    // sessions.hit_quality is the pre-retrieval baseline; calls.retrieval_hit_quality
    // means "did retrieval's returned set contain the edited files". Different
    // columns, different claims, and only the first one has a writer today.
    assert.equal(row(db, "t64-not-retrieval").hit_quality, 1);
    const call = db.db
      .prepare(`SELECT retrieval_calls, retrieval_hit_quality FROM calls WHERE session_id = ?`)
      .get("t64-not-retrieval") as { retrieval_calls: number; retrieval_hit_quality: number | null };
    assert.equal(call.retrieval_hit_quality, null);
    assert.equal(call.retrieval_calls, 0);
    db.close();
  });

  it("keeps a blind write out of the rank mean instead of scoring it as found instantly", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      db,
      snapWith("t64-blind", [
        { name: "bash", args: { command: "ls docs" }, state: "ok" },
        { name: "write", args: { file_path: "docs/20-new.md" }, state: "ok" },
      ]),
    );
    const r = row(db, "t64-blind");
    assert.equal(r.edited_file_count, 1);
    assert.equal(r.blind_edits, 1);
    assert.equal(r.hit_quality, 0);
    assert.equal(r.first_touch_rank, null);
    db.close();
  });

  it("credits a file read through bash, which is where reads go after T20", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      db,
      snapWith("t64-bash-read", [
        { name: "bash", args: { command: "sed -n '1,40p' docs/02-plan.md" }, state: "ok" },
        { name: "edit", args: { path: "docs/02-plan.md" }, state: "ok" },
      ]),
    );
    const r = row(db, "t64-bash-read");
    assert.equal(r.blind_edits, 0);
    assert.equal(r.first_touch_rank, 1);
    db.close();
  });

  it("leaves hit_quality NULL on an exploration-only session, but still records the version", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      db,
      snapWith("t64-no-edits", [{ name: "bash", args: { command: "grep -rn x ." }, state: "ok" }]),
    );
    const r = row(db, "t64-no-edits");
    assert.equal(r.edited_file_count, 0);
    assert.equal(r.hit_quality, null);
    // Version present: "measured, and the answer is that there was no answer
    // key" — distinct from a pre-T64 row, where every column is NULL.
    assert.equal(r.hit_quality_version, 3);
    db.close();
  });

  it("leaves every column NULL on a session ended without the measurement — no backfill", () => {
    const db = Ledger.open(":memory:");
    db.startSession({ id: "t64-pre", harnessCommit: "deadbeef" });
    db.endSession({ id: "t64-pre", toolCalls: 4 });
    const r = row(db, "t64-pre");
    assert.equal(r.hit_quality_version, null);
    assert.equal(r.edited_file_count, null);
    assert.equal(r.blind_edits, null);
    assert.equal(r.edited_files, null);
    db.close();
  });
});

describe("T65: what memory was injected, recorded on the session", () => {
  const snapWith = (sessionId: string, memory: unknown) => ({
    sessionId,
    state: "done" as const,
    model: "deepseek/deepseek-v4-flash",
    finishedAt: OFF_PEAK.toISOString(),
    activeTools: ["read", "bash", "edit", "write"],
    toolCalls: [] as DelegateToolCall[],
    ...(memory === undefined ? {} : { memory: memory as never }),
    usage: {
      input: 100,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      nestedBasis: "none",
      calls: [
        {
          hop: "direct",
          source: "assistant_message",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          input: 100,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
          ts: OFF_PEAK.toISOString(),
        },
      ],
    },
  });

  const row = (db: Ledger, id: string) =>
    db.db
      .prepare(
        `SELECT flag_memory_inject, memory_injected_ids, memory_inject_tokens,
                memory_entries_available, memory_entries_skipped
         FROM sessions WHERE id = ?`,
      )
      .get(id) as {
      flag_memory_inject: number;
      memory_injected_ids: string | null;
      memory_inject_tokens: number | null;
      memory_entries_available: number | null;
      memory_entries_skipped: number | null;
    };

  it("records the ids, the token cost, and what did not fit", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      db,
      snapWith("t65-on", {
        enabled: true,
        injectedIds: ["aaaaaaaa", "bbbbbbbb"],
        injectTokens: 87,
        available: 5,
        skipped: 3,
      }),
    );
    const r = row(db, "t65-on");
    assert.equal(r.flag_memory_inject, 1);
    assert.deepEqual(JSON.parse(r.memory_injected_ids ?? "[]"), ["aaaaaaaa", "bbbbbbbb"]);
    assert.equal(r.memory_inject_tokens, 87);
    assert.equal(r.memory_entries_available, 5);
    // The store-pressure signal problems/09 mitigation 5 asks for.
    assert.equal(r.memory_entries_skipped, 3);
    db.close();
  });

  it("records the OFF arm too — Experiment H needs both sides", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      db,
      snapWith("t65-off", { enabled: false, injectedIds: [], injectTokens: 0, available: 0, skipped: 0 }),
    );
    const r = row(db, "t65-off");
    assert.equal(r.flag_memory_inject, 0);
    // Zero, not NULL: this session measured memory and found none injected.
    assert.equal(r.memory_inject_tokens, 0);
    assert.deepEqual(JSON.parse(r.memory_injected_ids ?? "null"), []);
    db.close();
  });

  it("does not set the flag when memory was enabled but nothing was injected", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(
      db,
      snapWith("t65-empty", { enabled: true, injectedIds: [], injectTokens: 0, available: 0, skipped: 0 }),
    );
    // The flag means "a memory block rode this session's head", which is
    // what an on/off comparison has to split on — not "the feature was
    // configured on with an empty store".
    assert.equal(row(db, "t65-empty").flag_memory_inject, 0);
    db.close();
  });

  it("leaves every column NULL for a snapshot that carried no memory section — no backfill", () => {
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snapWith("t65-absent", undefined));
    const r = row(db, "t65-absent");
    assert.equal(r.flag_memory_inject, 0);
    assert.equal(r.memory_injected_ids, null);
    assert.equal(r.memory_inject_tokens, null);
    assert.equal(r.memory_entries_available, null);
    db.close();
  });
});

describe("P10.2 calls.wire_tool_name", () => {
  it("records wire_tool_name and actual tool_name from usage call", () => {
    const db = Ledger.open(":memory:");
    const snap = {
      sessionId: "p10-t04-transport-snap",
      state: "done" as const,
      model: "deepseek/deepseek-v4-flash",
      turns: 1,
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        calls: [
          {
            hop: "direct",
            source: "assistant_message",
            provider: "deepseek",
            model: "deepseek-v4-flash",
            input: 100,
            output: 20,
            cacheRead: 0,
            cacheWrite: 0,
            tool: "todo",
            wireTool: "tool_call",
            ts: OFF_PEAK.toISOString(),
          },
        ],
      },
    };
    ingestDelegateSnapshot(db, snap);
    const r = db.db
      .prepare(`SELECT tool_name, wire_tool_name, risk_tier FROM calls WHERE session_id = ?`)
      .get("p10-t04-transport-snap") as { tool_name: string; wire_tool_name: string; risk_tier: string };
    assert.equal(r.tool_name, "todo");
    assert.equal(r.wire_tool_name, "tool_call");
    assert.equal(r.risk_tier, "soft-write");
    db.close();
  });
});

describe("P14.6 ticket 06: the credential that served each call", () => {
  it("records each call's credential label, and auth_mode follows each call's credential type", () => {
    const call = (label: string | undefined, type: "oauth" | "api_key" | undefined, minute: number) => ({
      hop: "direct",
      source: "assistant_message",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      input: 10,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      ts: new Date(OFF_PEAK.getTime() + minute * 60_000).toISOString(),
      ...(label !== undefined ? { credentialLabel: label } : {}),
      ...(type !== undefined ? { credentialType: type } : {}),
    });
    const snap = {
      sessionId: "p14-6-credential-label-fixture",
      state: "done" as const,
      model: "anthropic/claude-sonnet-4-5",
      turns: 3,
      finishedAt: OFF_PEAK.toISOString(),
      usage: {
        input: 30,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        calls: [
          call("one@example.com", "oauth", 0),
          // A cross-type fallback (ADR-0026): the same session moves to a metered key.
          call("key#2", "api_key", 1),
          // No Lykos credential served this one (an ambient env key): the declaration decides.
          call(undefined, undefined, 2),
        ],
      },
    };
    const db = Ledger.open(":memory:");
    ingestDelegateSnapshot(db, snap, {
      executionShape: "standalone",
      runtime: "host",
      providers: { anthropic: { auth: "gateway", priced: false } },
    });
    const rows = db.db
      .prepare(`SELECT credential_label, auth_mode, price_basis FROM calls WHERE session_id = ? ORDER BY ts_utc`)
      .all(snap.sessionId) as Array<{ credential_label: string | null; auth_mode: string; price_basis: string }>;
    assert.deepEqual(rows, [
      { credential_label: "one@example.com", auth_mode: "oauth_subscription", price_basis: "unpriced" },
      { credential_label: "key#2", auth_mode: "api_key", price_basis: "unpriced" },
      { credential_label: null, auth_mode: "gateway", price_basis: "unpriced" },
    ]);
    db.close();
  });
});
