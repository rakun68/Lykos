// L3 (#93 item 3) SEALED ACCEPTANCE: an unpriced call never reads as $0.
//
// Today: a call with no price is already stored honestly (price_basis
// 'unpriced', cost_usd NULL, T25.2). The distinction is lost one layer up, in
// Ledger.callTotals() / taskCallTotals(): `COALESCE(SUM(cost_usd), 0)` turns
// "no priced call" into 0. endSession() writes that 0 into
// sessions.total_cost_usd, and lykos_status (mcp-server.ts querySessionMetrics)
// prefers the row's total, so an all-unpriced session reports cost_usd: 0.
//
// Rulings (l3-rulings.txt):
// 1. calls: unchanged. An unpriced call keeps price_basis 'unpriced' and cost_usd NULL.
// 2. CallTotals gains `unpricedCalls` (calls with cost_usd NULL). `costUsd` is the
//    sum of the priced calls; NULL when the session has calls and none is priced;
//    0 when it has no calls (nothing was spent). Same for taskCallTotals().
// 3. sessions gains `unpriced_calls INTEGER`, added by migrateSessionsTable's
//    ADD COLUMN list (and schema.sql). endSession() writes it and writes
//    total_cost_usd from ruling 2: priced sum, NULL when every call is unpriced.
//    A partly priced total is the priced sum with unpriced_calls > 0 beside it,
//    the convention `lykos cost` already uses ("excluded from cost claims: N
//    unpriced call(s)").
// 4. Nothing is backfilled: an existing row keeps its total_cost_usd and gets
//    unpriced_calls NULL.
// 5. lykos_status: each entry carries `cost_usd` (null when every call is
//    unpriced) and `unpriced_calls` (a count, 0 when all priced).
//
// Seams: the Ledger API over temp ledgers, and the MCP server over an
// in-memory transport with a stand-in runner that writes the ledger rows the
// way the child does (pattern: lykos/delegate/async-sessions-t223.test.ts).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Ledger } from "./ledger.js";
import { priceCall } from "./prices.js";
import { createMcpServer } from "../delegate/mcp-server.js";
import type { SessionOutcome, SessionRunner } from "../delegate/session-protocol.js";
import { defaultLedgerPath, openLedgerSync } from "./use.js";

const TS = new Date("2026-10-01T12:00:00Z");
const PRICED = {
  agent: "worker" as const,
  provider: "deepseek",
  model: "deepseek-v4-flash",
  tokens: { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 },
  ts: TS,
};
const UNPRICED = {
  agent: "worker" as const,
  provider: "google",
  model: "gemini-unpriced-l3",
  tokens: { input: 5000, output: 200, cacheRead: 0, cacheWrite: 0 },
  ts: TS,
  authMode: "gateway" as const,
  priceBasis: "unpriced" as const,
};
const PRICED_USD = priceCall({ provider: PRICED.provider, model: PRICED.model, tokens: PRICED.tokens, ts: TS }).costUsd;

type Kind = "priced" | "unpriced";

function record(ledger: Ledger, sessionId: string, kinds: Kind[]): void {
  for (const k of kinds) ledger.recordCall({ sessionId, ...(k === "priced" ? PRICED : UNPRICED) });
}

/** The CallTotals fields this ticket rules, read loosely so this file compiles against today's type. */
function totalsOf(t: unknown): { costUsd: unknown; unpricedCalls: unknown; n: unknown } {
  const r = t as Record<string, unknown>;
  return { costUsd: r.costUsd, unpricedCalls: r.unpricedCalls, n: r.n };
}

function sessionRow(ledger: Ledger, id: string): Record<string, unknown> {
  return ledger.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Record<string, unknown>;
}

function close(a: unknown, b: number): void {
  assert.equal(typeof a, "number", `expected a number near ${b}, got ${String(a)}`);
  assert.equal(Math.round((a as number) * 1e9), Math.round(b * 1e9));
}

describe("L3: the ledger keeps unpriced apart from $0", () => {
  it("an unpriced call is stored with cost_usd NULL and price_basis 'unpriced' (unchanged)", () => {
    const ledger = Ledger.open(":memory:");
    const id = ledger.startSession({ harnessCommit: "x" });
    record(ledger, id, ["unpriced"]);
    const row = ledger.db.prepare("SELECT cost_usd, price_basis FROM calls WHERE session_id = ?").get(id) as {
      cost_usd: number | null;
      price_basis: string;
    };
    assert.equal(row.cost_usd, null);
    assert.equal(row.price_basis, "unpriced");
    ledger.close();
  });

  it("callTotals: every call unpriced -> costUsd null, unpricedCalls = the count", () => {
    const ledger = Ledger.open(":memory:");
    const id = ledger.startSession({ harnessCommit: "x" });
    record(ledger, id, ["unpriced", "unpriced"]);
    const t = totalsOf(ledger.callTotals(id));
    assert.equal(t.n, 2);
    assert.equal(t.costUsd, null, "no priced call: the total is unmeasured, never 0");
    assert.equal(t.unpricedCalls, 2);
    const task = totalsOf(ledger.taskCallTotals(id));
    assert.equal(task.costUsd, null, "taskCallTotals follows the same rule");
    assert.equal(task.unpricedCalls, 2);
    ledger.close();
  });

  it("callTotals: mixed -> costUsd is the priced sum, unpricedCalls counts the rest", () => {
    const ledger = Ledger.open(":memory:");
    const id = ledger.startSession({ harnessCommit: "x" });
    record(ledger, id, ["priced", "unpriced", "priced"]);
    const t = totalsOf(ledger.callTotals(id));
    close(t.costUsd, 2 * PRICED_USD);
    assert.equal(t.unpricedCalls, 1);
    ledger.close();
  });

  it("callTotals: all priced -> unpricedCalls 0; no calls -> costUsd 0, unpricedCalls 0", () => {
    const ledger = Ledger.open(":memory:");
    const priced = ledger.startSession({ harnessCommit: "x" });
    record(ledger, priced, ["priced"]);
    const t = totalsOf(ledger.callTotals(priced));
    close(t.costUsd, PRICED_USD);
    assert.equal(t.unpricedCalls, 0);
    const empty = ledger.startSession({ harnessCommit: "x" });
    const e = totalsOf(ledger.callTotals(empty));
    assert.equal(e.costUsd, 0, "no calls spent nothing: 0 is a measurement here");
    assert.equal(e.unpricedCalls, 0);
    ledger.close();
  });

  it("endSession: an all-unpriced session writes total_cost_usd NULL and unpriced_calls", () => {
    const ledger = Ledger.open(":memory:");
    const id = ledger.startSession({ harnessCommit: "x" });
    record(ledger, id, ["unpriced", "unpriced", "unpriced"]);
    ledger.endSession({ id });
    const row = sessionRow(ledger, id);
    assert.ok("unpriced_calls" in row, "sessions has an unpriced_calls column");
    assert.equal(row.total_cost_usd, null, "an all-unpriced session's total is NULL, never 0");
    assert.equal(row.unpriced_calls, 3);
    ledger.close();
  });

  it("endSession: a mixed session writes the priced sum beside unpriced_calls > 0", () => {
    const ledger = Ledger.open(":memory:");
    const id = ledger.startSession({ harnessCommit: "x" });
    record(ledger, id, ["priced", "unpriced"]);
    ledger.endSession({ id });
    const row = sessionRow(ledger, id);
    close(row.total_cost_usd, PRICED_USD);
    assert.equal(row.unpriced_calls, 1);
    ledger.close();
  });

  it("endSession: an all-priced session writes unpriced_calls 0", () => {
    const ledger = Ledger.open(":memory:");
    const id = ledger.startSession({ harnessCommit: "x" });
    record(ledger, id, ["priced"]);
    ledger.endSession({ id });
    const row = sessionRow(ledger, id);
    close(row.total_cost_usd, PRICED_USD);
    assert.equal(row.unpriced_calls, 0);
    ledger.close();
  });

  it("a pre-L3 ledger gains unpriced_calls on open, and its old rows are not backfilled", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-l3-migrate-"));
    const path = join(dir, "ledger.db");
    const first = Ledger.open(path);
    const id = first.startSession({ harnessCommit: "x" });
    record(first, id, ["unpriced"]);
    first.endSession({ id });
    first.close();

    // Make it a pre-L3 file: no unpriced_calls column, and the 0 today's code wrote.
    const raw = new Database(path);
    const cols = new Set((raw.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name));
    if (cols.has("unpriced_calls")) raw.exec("ALTER TABLE sessions DROP COLUMN unpriced_calls");
    raw.prepare("UPDATE sessions SET total_cost_usd = 0 WHERE id = ?").run(id);
    raw.close();

    const reopened = Ledger.open(path);
    const row = sessionRow(reopened, id);
    assert.ok("unpriced_calls" in row, "the migration adds unpriced_calls");
    assert.equal(row.unpriced_calls, null, "an old row is not backfilled");
    assert.equal(row.total_cost_usd, 0, "an old row's total is left as it was written");
    reopened.close();
  });
});

// ---------------------------------------------------------------------------
// The MCP seam: lykos_status.

const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-l3-home-"));
  for (const k of ["HOME", "USERPROFILE", "LYKOS_TRUST_WORKSPACE", "NODE_TEST_CONTEXT"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LYKOS_TRUST_WORKSPACE = "1";
  delete process.env.NODE_TEST_CONTEXT;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function git(cwd: string, ...args: string[]): string {
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  return execFileSync("git", args, { cwd, encoding: "utf8", env }).trim();
}

function plainRepo(): string {
  const ws = mkdtempSync(join(tmpdir(), "lykos-l3-ws-"));
  git(ws, "init", "-q", "-b", "main");
  writeFileSync(join(ws, ".gitignore"), ".lykos/\n");
  writeFileSync(join(ws, "README.md"), "one\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "first");
  return ws;
}

/** A stand-in child: starts the row, records the given calls, ends the row, returns. */
function finishingRunner(ws: string, kinds: Kind[]): SessionRunner {
  let n = 0;
  return async (input) => {
    const id = input.request.sessionId ?? input.request.newSessionId ?? `l3-standin-${++n}-${Date.now()}`;
    const ledger = openLedgerSync(defaultLedgerPath(ws));
    try {
      ledger.startSession({ id, brief: "do it", executionShape: "mcp_worker", runtime: "host", workspace: ws, captureMode: "stream" });
      record(ledger, id, kinds);
      ledger.endSession({ id });
    } finally {
      ledger.close();
    }
    const out: SessionOutcome = { outcome: "ok", answer: "runner: done", sessionId: id };
    return out;
  };
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string; json: Record<string, unknown> | undefined }> {
  const res = await client.callTool({ name, arguments: args });
  const text = ((res.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
  let json: Record<string, unknown> | undefined;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = undefined;
  }
  return { isError: res.isError === true, text, json };
}

async function statusAfterRun(kinds: Kind[]): Promise<Record<string, unknown>> {
  const ws = plainRepo();
  const server = createMcpServer({
    workspace: ws,
    version: "0.0.1-test",
    trustPath: join(mkdtempSync(join(tmpdir(), "lykos-l3-store-")), "trust.json"),
    run: finishingRunner(ws, kinds),
  });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "l3", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const started = await callTool(client, "lykos_start", { specialist: "implementer", brief: "do it" });
    assert.equal(started.isError, false, started.text);
    const id = started.json?.session_id;
    assert.equal(typeof id, "string", started.text);
    const st = await callTool(client, "lykos_status", { session_id: id, wait_seconds: 10 });
    assert.equal(st.isError, false, st.text);
    const sessions = (st.json?.sessions ?? []) as Array<Record<string, unknown>>;
    assert.equal(sessions.length, 1, st.text);
    const entry = sessions[0]!;
    assert.notEqual(entry.state, "running", `the stand-in finished: ${st.text}`);
    return entry;
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

describe("L3: lykos_status reports unpriced as null with a count", () => {
  it("an all-unpriced session -> cost_usd null, unpriced_calls 2", async () => {
    const entry = await statusAfterRun(["unpriced", "unpriced"]);
    assert.ok("cost_usd" in entry, JSON.stringify(entry));
    assert.equal(entry.cost_usd, null, `an all-unpriced session is not $0: ${JSON.stringify(entry)}`);
    assert.equal(entry.unpriced_calls, 2, JSON.stringify(entry));
  });

  it("a mixed session -> cost_usd is the priced sum, unpriced_calls 1", async () => {
    const entry = await statusAfterRun(["priced", "unpriced"]);
    close(entry.cost_usd, PRICED_USD);
    assert.equal(entry.unpriced_calls, 1, JSON.stringify(entry));
  });

  it("an all-priced session -> cost_usd the sum, unpriced_calls 0", async () => {
    const entry = await statusAfterRun(["priced"]);
    close(entry.cost_usd, PRICED_USD);
    assert.equal(entry.unpriced_calls, 0, JSON.stringify(entry));
  });
});
