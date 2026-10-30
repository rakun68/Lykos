import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { Ledger } from "./ledger.js";
import { currentPriceTable, priceCall } from "./prices.js";
import { PI_DEFAULT_TOOLS, SCHEMA_TOKENS_BASIS, measureToolset } from "./tool-schema.js";
import { DenialLog } from "../gate/approval.js";

const OFF_PEAK = new Date("2026-08-29T12:00:00Z"); // Saturday — DeepSeek off-peak

describe("Ledger", () => {
  it("applies the schema on open", () => {
    const db = Ledger.open(":memory:");
    const tables = db.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    assert.deepEqual(
      tables.map((t) => t.name),
      // memory_eligibility joined on T76 (docs/23-phase10-tasks.md): one row
      // per memory entry per session, so "never injected" can be told apart
      // from "never reached the cap boundary".
      // rediscovery_annotations joined on T80: human-authored ground truth
      // for the semantic repeats T66's exact-match signal cannot see.
      // sqlite_sequence is SQLite's own, created by the AUTOINCREMENT on it.
      [
        "calls",
        // commits joined on T179: each commit a session made through `commit`.
        "commits",
        // compactions joined on T152: each self-compact compaction attempt.
        "compactions",
        // extension_counters joined on T149: a Lykos extension's own numbers.
        "extension_counters",
        // flaky_tests joined on T167: a test that failed in the gate and passed on rerun.
        "flaky_tests",
        "memory_eligibility",
        "price_versions",
        "projects",
        // prunes joined on T188: each superseded-read / useless-result prune pass.
        "prunes",
        "rediscovery_annotations",
        // seal_events joined on T195: sealed TDD events.
        "seal_events",
        "sessions",
        "sqlite_sequence",
        "tasks",
      ],
    );
    const priced = db.db.prepare(`SELECT version FROM price_versions`).get() as { version: string };
    assert.equal(priced.version, currentPriceTable().version);
    db.close();
  });

  it("refreshes exploration views on a ledger that predates the current metric", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-exploration-view-migration-"));
    const path = join(dir, "ledger.db");
    const ledger = Ledger.open(path);
    const id = ledger.startSession({ harnessCommit: "view-migration" });
    ledger.db
      .prepare(
        `UPDATE sessions
         SET explore_tool_calls = 1, explore_metric_version = 3,
             explore_result_bytes = 1, tool_result_bytes = 1
         WHERE id = ?`,
      )
      .run(id);
    ledger.close();

    const raw = new Database(path);
    raw.exec(`
      DROP VIEW v_exploration;
      DROP VIEW v_exploration_summary;
      CREATE VIEW v_exploration AS
        SELECT id AS session_id, explore_tool_calls AS explore_calls
        FROM sessions WHERE explore_metric_version = 2;
      CREATE VIEW v_exploration_summary AS
        SELECT COUNT(*) AS sessions_v2 FROM v_exploration;
    `);
    raw.close();

    const reopened = Ledger.open(path);
    const row = reopened.db
      .prepare(`SELECT explore_calls FROM v_exploration WHERE session_id = ?`)
      .get(id) as { explore_calls: number } | undefined;
    assert.equal(row?.explore_calls, 1);
    reopened.close();
  });

  it("does not mix exploration metric versions when a session is resumed", () => {
    const ledger = Ledger.open(":memory:");
    const id = ledger.startSession({ harnessCommit: "metric-version" });
    ledger.db
      .prepare(
        `UPDATE sessions
         SET explore_tool_calls = 1, explore_metric_version = 2,
             explore_result_bytes = 10, tool_result_bytes = 20
         WHERE id = ?`,
      )
      .run(id);

    ledger.endSession({
      id,
      toolCalls: 2,
      exploreToolCalls: 2,
      exploreMetricVersion: 3,
      exploreResultBytes: 20,
      toolResultBytes: 40,
      exploreBreakdown: "{}",
    });

    const row = ledger.db
      .prepare(
        `SELECT explore_tool_calls, explore_metric_version,
                explore_result_bytes, tool_result_bytes
         FROM sessions WHERE id = ?`,
      )
      .get(id) as {
      explore_tool_calls: number;
      explore_metric_version: number;
      explore_result_bytes: number;
      tool_result_bytes: number;
    };
    assert.deepEqual(row, {
      explore_tool_calls: 1,
      explore_metric_version: 2,
      explore_result_bytes: 10,
      tool_result_bytes: 20,
    });
    ledger.close();
  });

  it("keeps a zero-exploration legacy session isolated when reopened", () => {
    const ledger = Ledger.open(":memory:");
    const id = ledger.startSession({ harnessCommit: "legacy-zero" });
    ledger.endSession({ id, toolCalls: 0, exploreToolCalls: 0 });
    ledger.reopenSession(id);
    ledger.endSession({
      id,
      toolCalls: 1,
      exploreToolCalls: 1,
      exploreMetricVersion: 3,
      exploreResultBytes: 1,
      toolResultBytes: 1,
      exploreBreakdown: "{}",
    });

    const row = ledger.db
      .prepare(`SELECT explore_tool_calls, explore_metric_version FROM sessions WHERE id = ?`)
      .get(id) as { explore_tool_calls: number; explore_metric_version: number | null };
    assert.deepEqual(row, { explore_tool_calls: 0, explore_metric_version: null });
    ledger.close();
  });

  it("records a call re-priced through priceCall, not a caller-supplied cost", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ brief: "ping", harnessCommit: "abc123" });
    const tokens = { input: 873, output: 4, cacheRead: 0, cacheWrite: 0 };
    db.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens,
      ts: OFF_PEAK,
    });
    const expected = priceCall({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens,
      ts: OFF_PEAK,
    });
    const row = db.db.prepare(`SELECT * FROM calls`).get() as {
      cost_usd: number;
      price_version: string;
      rate_window: string;
      input_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
    };
    assert.equal(row.cost_usd, expected.costUsd);
    assert.equal(row.price_version, expected.priceVersion);
    assert.equal(row.rate_window, "off_peak");
    assert.equal(row.input_tokens, 873);
    assert.equal(row.cache_read_tokens, 0);
    assert.equal(row.cache_write_tokens, 0);
    db.close();
  });

  it("records T109 continuation usage without backfilling older rows", () => {
    const db = Ledger.open(":memory:");
    const predecessor = db.startSession({ brief: "first" });
    const successor = db.startSession({
      brief: "second",
      resumedFrom: predecessor,
      continuationsUsed: 1,
    });
    const rows = db.db
      .prepare(`SELECT id, continuations_used FROM sessions ORDER BY started_utc, id`)
      .all() as Array<{ id: string; continuations_used: number | null }>;
    assert.equal(rows.find((row) => row.id === predecessor)?.continuations_used, null);
    assert.equal(rows.find((row) => row.id === successor)?.continuations_used, 1);
    db.close();
  });

  it("records T149 extension counters under the extension's name, adding, with no row for a session that recorded none", () => {
    const db = Ledger.open(":memory:");
    const quiet = db.startSession({ brief: "quiet" });
    const reviewed = db.startSession({ brief: "reviewed" });

    db.recordExtensionCounters(reviewed, [
      { extension: "lykos-reviewer", name: "invocations", value: 1 },
      { extension: "lykos-reviewer", name: "findings", value: 2 },
    ]);
    // A session that ends twice (a resume) adds rather than overwrites.
    db.recordExtensionCounters(reviewed, [{ extension: "lykos-reviewer", name: "findings", value: 1 }]);

    assert.deepEqual(db.extensionCounters(quiet), [], "absent, never zero");
    assert.deepEqual(db.extensionCounters(reviewed), [
      { extension: "lykos-reviewer", name: "invocations", value: 1 },
      { extension: "lykos-reviewer", name: "findings", value: 3 },
    ]);
    assert.throws(() => db.recordExtensionCounters(reviewed, [{ extension: "x", name: "n", value: -1 }]), /non-negative/);
    // The T110 columns are kept as history and nothing writes them.
    const row = db.db.prepare(`SELECT reviewer_invocations FROM sessions WHERE id = ?`).get(reviewed) as {
      reviewer_invocations: number | null;
    };
    assert.equal(row.reviewer_invocations, null);
    db.close();
  });

  it("redacts secrets in brief before write", () => {
    const db = Ledger.open(":memory:");
    db.startSession({ brief: "key sk-ant-api03-abcdefghijklmnopqrstuv", harnessCommit: "x" });
    const row = db.db.prepare(`SELECT brief, harness_commit FROM sessions`).get() as {
      brief: string;
      harness_commit: string;
    };
    assert.equal(row.brief.includes("sk-ant-"), false);
    assert.equal(row.harness_commit, "x");
    db.close();
  });

  it("refuses a second endSession (append-only)", () => {
    const db = Ledger.open(":memory:");
    const id = db.startSession({ harnessCommit: "x" });
    db.endSession({ id, outcome: "fail" });
    assert.throws(() => db.endSession({ id, outcome: "success" }), /already ended/);
    db.close();
  });

  it("creates the parent directory for a file-backed ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-ledger-"));
    const path = join(dir, ".lykos", "ledger.db");
    const db = Ledger.open(path);
    assert.equal(db.path, path);
    db.close();
  });

  it("throws on an unknown model rather than writing a $0 row", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    assert.throws(
      () =>
        db.recordCall({
          sessionId,
          agent: "worker",
          provider: "deepseek",
          model: "no-such-model",
          tokens: { input: 1, output: 1 },
        }),
      /unknown model/,
    );
    assert.equal(db.callTotals(sessionId).n, 0);
    db.close();
  });
});

const OFF_PEAK_CALL = {
  agent: "worker" as const,
  provider: "deepseek",
  model: "deepseek-v4-flash",
  tokens: { input: 100, output: 10, cacheRead: 50, cacheWrite: 0 },
  ts: OFF_PEAK,
};

// A literal snapshot of the pre-T8 (T4.2-era) sessions/calls shape, not
// derived from the current schema.sql — the point of this fixture is a
// fixed "what a ledger looked like before T8" baseline, not a live mirror
// of today's file. Trimmed to only what open()/startSession()/recordCall()
// actually touch; price_versions is required because Ledger.open() always
// inserts into it. Module-scoped (not nested in one describe) because both
// the T8 and the T25 migration tests below need it.
const PRE_T8_SCHEMA = `
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      started_utc TEXT NOT NULL,
      ended_utc TEXT,
      harness_commit TEXT NOT NULL,
      brief TEXT,
      difficulty_estimate INTEGER,
      outcome TEXT,
      outcome_source TEXT,
      verification_cmd TEXT,
      verification_output TEXT,
      total_cost_usd REAL,
      total_avoided_usd REAL,
      turns INTEGER DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      compactions INTEGER DEFAULT 0,
      escalations INTEGER DEFAULT 0,
      human_interventions INTEGER DEFAULT 0,
      flag_retrieval INTEGER DEFAULT 0,
      flag_proactive_compaction INTEGER DEFAULT 0,
      flag_routing INTEGER DEFAULT 0,
      flag_draft_verify INTEGER DEFAULT 0,
      flag_delegation INTEGER DEFAULT 0,
      notes TEXT
    );
    CREATE TABLE calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      parent_call_id TEXT,
      hop INTEGER NOT NULL DEFAULT 0,
      ts_utc TEXT NOT NULL,
      agent TEXT NOT NULL,
      phase TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      model_version TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      price_version TEXT NOT NULL,
      rate_window TEXT,
      cost_usd REAL NOT NULL,
      recosted INTEGER NOT NULL DEFAULT 0,
      tool_schema_tokens INTEGER,
      tool_schema_bytes INTEGER,
      tool_count INTEGER,
      tool_schema_hash TEXT,
      tool_schema_basis TEXT,
      tool_names TEXT,
      prefix_changed INTEGER
    );
    CREATE TABLE price_versions (
      version TEXT PRIMARY KEY, applied_utc TEXT NOT NULL, source_checked TEXT NOT NULL, note TEXT
    );
  `;

describe("Ledger: T4.1 tool-schema tax", () => {
  it("stores NULL tokens when toolNames is omitted — never a silent 0", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    db.recordCall({ sessionId, ...OFF_PEAK_CALL });
    const row = db.db.prepare(`SELECT tool_schema_tokens, tool_count, prefix_changed, tool_names FROM calls`).get() as {
      tool_schema_tokens: number | null;
      tool_count: number | null;
      prefix_changed: number | null;
      tool_names: string | null;
    };
    assert.equal(row.tool_schema_tokens, null);
    assert.equal(row.tool_count, null);
    assert.equal(row.prefix_changed, null);
    assert.equal(row.tool_names, null);
    db.close();
  });

  it("stores 0 tokens for a known-empty tool set", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    db.recordCall({ sessionId, ...OFF_PEAK_CALL, toolNames: [] });
    const row = db.db.prepare(`SELECT tool_schema_tokens, tool_count, tool_schema_hash, prefix_changed FROM calls`).get() as {
      tool_schema_tokens: number;
      tool_count: number;
      tool_schema_hash: string;
      prefix_changed: number;
    };
    assert.equal(row.tool_schema_tokens, 0);
    assert.equal(row.tool_count, 0);
    assert.equal(row.prefix_changed, 0);
    assert.equal(row.tool_schema_hash, measureToolset([]).hash);
    db.close();
  });

  it("stores NULL tokens on a catalog miss but still records the names", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    db.recordCall({ sessionId, ...OFF_PEAK_CALL, toolNames: ["read", "not-a-real-tool"] });
    const row = db.db.prepare(`SELECT tool_schema_tokens, tool_count, tool_schema_basis, tool_names FROM calls`).get() as {
      tool_schema_tokens: number | null;
      tool_count: number;
      tool_schema_basis: string;
      tool_names: string;
    };
    assert.equal(row.tool_schema_tokens, null);
    assert.equal(row.tool_count, 2);
    assert.equal(row.tool_schema_basis, SCHEMA_TOKENS_BASIS);
    assert.deepEqual(JSON.parse(row.tool_names), ["read", "not-a-real-tool"]);
    db.close();
  });

  it("records the catalog measurement for a known toolset", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    const names = [...PI_DEFAULT_TOOLS];
    const expected = measureToolset(names);
    db.recordCall({ sessionId, ...OFF_PEAK_CALL, toolNames: names });
    const row = db.db.prepare(`SELECT tool_schema_tokens, tool_count, tool_schema_hash, prefix_changed FROM calls`).get() as {
      tool_schema_tokens: number;
      tool_count: number;
      tool_schema_hash: string;
      prefix_changed: number;
    };
    assert.equal(row.tool_schema_tokens, expected.tokens);
    assert.equal(row.tool_count, 4);
    assert.equal(row.tool_schema_hash, expected.hash);
    assert.equal(row.prefix_changed, 0);
    db.close();
  });

  it("sets prefix_changed=0 on the first measured call and =1 when the hash shifts", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    const four = [...PI_DEFAULT_TOOLS];
    const five = [...PI_DEFAULT_TOOLS, "grep"];
    db.recordCall({
      sessionId,
      ...OFF_PEAK_CALL,
      toolNames: four,
      ts: new Date("2026-08-29T12:00:00Z"),
    });
    db.recordCall({
      sessionId,
      ...OFF_PEAK_CALL,
      toolNames: four,
      ts: new Date("2026-08-29T12:00:01Z"),
    });
    db.recordCall({
      sessionId,
      ...OFF_PEAK_CALL,
      toolNames: five,
      ts: new Date("2026-08-29T12:00:02Z"),
    });
    const rows = db.db
      .prepare(`SELECT prefix_changed, tool_count FROM calls WHERE session_id = ? ORDER BY ts_utc`)
      .all(sessionId) as Array<{ prefix_changed: number; tool_count: number }>;
    assert.deepEqual(
      rows.map((r) => r.prefix_changed),
      [0, 0, 1],
    );
    const breaks = db.db.prepare(`SELECT COUNT(*) AS n FROM v_prefix_breaks`).get() as { n: number };
    assert.equal(breaks.n, 1);
    db.close();
  });

  it("excludes unmeasured calls from v_schema_tax's average", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    const expected = measureToolset([...PI_DEFAULT_TOOLS]);
    db.recordCall({ sessionId, ...OFF_PEAK_CALL, toolNames: [...PI_DEFAULT_TOOLS] });
    db.recordCall({ sessionId, ...OFF_PEAK_CALL });
    const tax = db.db.prepare(`SELECT measured_calls, avg_schema_tokens FROM v_schema_tax WHERE session_id = ?`).get(sessionId) as {
      measured_calls: number;
      avg_schema_tokens: number;
    };
    assert.equal(tax.measured_calls, 1);
    assert.equal(tax.avg_schema_tokens, expected.tokens);
    db.close();
  });

  it("creates v_schema_tax and v_prefix_breaks on a fresh ledger", () => {
    const db = Ledger.open(":memory:");
    const views = db.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = views.map((v) => v.name);
    assert.ok(names.includes("v_schema_tax"));
    assert.ok(names.includes("v_prefix_breaks"));
    db.close();
  });

  it("creates v_head_drift on a fresh ledger", () => {
    const db = Ledger.open(":memory:");
    const views = db.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='view' ORDER BY name`)
      .all() as Array<{ name: string }>;
    assert.ok(views.map((v) => v.name).includes("v_head_drift"));
    db.close();
  });

  it("migrates an existing T3 calls table rather than leaving the new columns missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-migrate-"));
    const path = join(dir, "ledger.db");
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
    const full = readFileSync(schemaPath, "utf8");
    const viewsAt = full.indexOf("-- Views");
    assert.ok(viewsAt > 0);
    const oldSql = full
      .slice(0, viewsAt)
      .replace(/\n  -- T4.1 tool-schema tax[\s\S]*?prefix_fingerprint_changed\s+INTEGER[^\n]*/, "")
      .replace(/(handoff_loss\s+INTEGER DEFAULT 0),(\s+-- parent had to re-ask)/, "$1$2");
    assert.equal(oldSql.includes("tool_schema_tokens"), false);
    const raw = new Database(path);
    raw.exec(oldSql);
    const before = new Set(
      (raw.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    assert.equal(before.has("tool_schema_tokens"), false);
    raw.close();

    const ledger = Ledger.open(path);
    const after = new Set(
      (ledger.db.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const col of [
      "tool_schema_tokens",
      "tool_schema_bytes",
      "tool_count",
      "tool_schema_hash",
      "tool_schema_basis",
      "tool_names",
      "prefix_changed",
    ]) {
      assert.ok(after.has(col), `missing migrated column ${col}`);
    }
    const views = new Set(
      (ledger.db.prepare(`SELECT name FROM sqlite_master WHERE type='view'`).all() as Array<{ name: string }>).map(
        (v) => v.name,
      ),
    );
    assert.ok(views.has("v_schema_tax"));
    assert.ok(views.has("v_prefix_breaks"));

    const sessionId = ledger.startSession({ harnessCommit: "migrated" });
    ledger.recordCall({ sessionId, ...OFF_PEAK_CALL, toolNames: [...PI_DEFAULT_TOOLS] });
    const row = ledger.db.prepare(`SELECT tool_schema_tokens FROM calls`).get() as { tool_schema_tokens: number };
    assert.ok(row.tool_schema_tokens > 0);
    ledger.close();
  });

  it("T8: migrates a pre-T8 ledger to project/task identity without losing existing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-migrate-t8-"));
    const path = join(dir, "ledger.db");
    const raw = new Database(path);
    raw.exec(PRE_T8_SCHEMA);
    raw
      .prepare(
        `INSERT INTO sessions (id, started_utc, harness_commit, brief) VALUES (?, ?, ?, ?)`,
      )
      .run("pre-existing-session", "2026-08-01T00:00:00.000Z", "deadbeef", "work that predates T8");
    raw.close();

    const ledger = Ledger.open(path);
    const cols = new Set(
      (ledger.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const col of [
      "project_id",
      "parent_session_id",
      "resumed_from",
      "git_commit",
      "git_dirty",
      "agent_role",
      "model",
      "transcript_path",
      "transcript_sha256",
      "transcript_bytes",
      "archive_state",
      "resumable",
      "not_resumable_reason",
      "flag_cache_stable_head",
      "flag_trimmed_tool_surface",
      "flag_prompt_diet",
      "flag_output_diet",
      "compaction_threshold",
      "specialist",
      "extensions",
      "extension_set",
      "extension_schema_tokens",
      "extension_schema_share",
    ]) {
      assert.ok(cols.has(col), `missing migrated sessions column ${col}`);
    }
    const tables = new Set(
      (ledger.db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as Array<{ name: string }>).map(
        (t) => t.name,
      ),
    );
    assert.ok(tables.has("projects"));
    assert.ok(tables.has("tasks"));
    const views = new Set(
      (ledger.db.prepare(`SELECT name FROM sqlite_master WHERE type='view'`).all() as Array<{ name: string }>).map(
        (v) => v.name,
      ),
    );
    assert.ok(views.has("v_cost_per_successful_task"));

    // No data loss: the pre-existing row is untouched, and the new columns
    // on it read back NULL rather than erroring or vanishing.
    const preExisting = ledger.db
      .prepare(`SELECT brief, harness_commit, project_id, resumable FROM sessions WHERE id = ?`)
      .get("pre-existing-session") as { brief: string; harness_commit: string; project_id: string | null; resumable: number | null };
    assert.equal(preExisting.brief, "work that predates T8");
    assert.equal(preExisting.harness_commit, "deadbeef");
    assert.equal(preExisting.project_id, null);
    ledger.close();
  });

  it("T8.4: v_cost_per_successful_task groups sessions by task, not by day", () => {
    const ledger = Ledger.open(":memory:");
    ledger.ensureProject({ id: "proj-1", rootPath: "/work/lykos", createdUtc: OFF_PEAK.toISOString() });
    const taskId = ledger.startTask({ id: "task-1", projectId: "proj-1", brief: "add retry to fetch client" });

    // Same task, two attempts: the first fails, the second (a resume)
    // succeeds. Cost per successful task must sum BOTH sessions' spend, not
    // report two separate cheap days.
    const s1 = ledger.startSession({ harnessCommit: "x", taskId, projectId: "proj-1" });
    ledger.recordCall({ sessionId: s1, ...OFF_PEAK_CALL });
    ledger.endSession({ id: s1, outcome: "fail", outcomeSource: "verification_command" });

    const s2 = ledger.startSession({ harnessCommit: "x", taskId, projectId: "proj-1", resumedFrom: s1 });
    ledger.recordCall({ sessionId: s2, ...OFF_PEAK_CALL });
    ledger.endSession({ id: s2, outcome: "success", outcomeSource: "verification_command" });

    const row = ledger.db.prepare(`SELECT * FROM v_cost_per_successful_task WHERE task_id = ?`).get(taskId) as {
      sessions: number;
      successes: number;
      failures: number;
      spent_usd: number;
      cost_per_success: number;
    };
    assert.equal(row.sessions, 2);
    assert.equal(row.successes, 1);
    assert.equal(row.failures, 1);
    const s1Totals = ledger.callTotals(s1);
    const s2Totals = ledger.callTotals(s2);
    assert.equal(row.spent_usd, Math.round(((s1Totals.costUsd ?? 0) + (s2Totals.costUsd ?? 0)) * 10000) / 10000);
    assert.equal(row.cost_per_success, row.spent_usd); // 1 success, so per-success == total spent
    ledger.close();
  });

  it("T8: startTask is idempotent on a repeated id", () => {
    const ledger = Ledger.open(":memory:");
    ledger.ensureProject({ id: "proj-1", rootPath: "/work/lykos", createdUtc: OFF_PEAK.toISOString() });
    const first = ledger.startTask({ id: "task-1", projectId: "proj-1", brief: "first brief" });
    const second = ledger.startTask({ id: "task-1", projectId: "proj-1", brief: "ignored — task-1 already exists" });
    assert.equal(first, second);
    const count = ledger.db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number };
    assert.equal(count.n, 1);
    const row = ledger.db.prepare(`SELECT brief FROM tasks WHERE id = ?`).get("task-1") as { brief: string };
    assert.equal(row.brief, "first brief");
    ledger.close();
  });

  it("T8: ensureProject upserts — a repaired root_path overwrites the stored one", () => {
    const ledger = Ledger.open(":memory:");
    ledger.ensureProject({ id: "proj-1", rootPath: "/old/path", createdUtc: OFF_PEAK.toISOString() });
    ledger.ensureProject({ id: "proj-1", rootPath: "/new/path", createdUtc: OFF_PEAK.toISOString() });
    const row = ledger.db.prepare(`SELECT root_path FROM projects WHERE id = ?`).get("proj-1") as {
      root_path: string;
    };
    assert.equal(row.root_path, "/new/path");
    const count = ledger.db.prepare(`SELECT COUNT(*) AS n FROM projects`).get() as { n: number };
    assert.equal(count.n, 1);
    ledger.close();
  });
});

describe("Ledger: T16.2 real prefix fingerprint", () => {
  it("stores NULL fingerprint fields when prefixFingerprint is omitted — never a guess", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    db.recordCall({ sessionId, ...OFF_PEAK_CALL });
    const row = db.db
      .prepare(`SELECT prefix_fingerprint, prefix_fingerprint_source, prefix_fingerprint_changed FROM calls`)
      .get() as {
      prefix_fingerprint: string | null;
      prefix_fingerprint_source: string | null;
      prefix_fingerprint_changed: number | null;
    };
    assert.equal(row.prefix_fingerprint, null);
    assert.equal(row.prefix_fingerprint_source, null);
    assert.equal(row.prefix_fingerprint_changed, null);
    db.close();
  });

  it("records the fingerprint and defaults its source to the worker's own host-state read", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    db.recordCall({ sessionId, ...OFF_PEAK_CALL, prefixFingerprint: "abc123" });
    const row = db.db
      .prepare(`SELECT prefix_fingerprint, prefix_fingerprint_source, prefix_fingerprint_changed FROM calls`)
      .get() as {
      prefix_fingerprint: string;
      prefix_fingerprint_source: string;
      prefix_fingerprint_changed: number;
    };
    assert.equal(row.prefix_fingerprint, "abc123");
    assert.equal(row.prefix_fingerprint_source, "pi_delegate_mcp_worker_host_state");
    assert.equal(row.prefix_fingerprint_changed, 0);
    db.close();
  });

  it("sets prefix_fingerprint_changed=1 only when the fingerprint itself shifts — independent of the T4.1 tool hash", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    // Same tool set on every call (T4.1's prefix_changed stays 0 throughout),
    // but the real observed head still drifts on the third call — the exact
    // case a catalog reconstruction of the tools alone cannot see.
    const four = [...PI_DEFAULT_TOOLS];
    db.recordCall({
      sessionId, ...OFF_PEAK_CALL, toolNames: four, prefixFingerprint: "head-a",
      ts: new Date("2026-08-29T12:00:00Z"),
    });
    db.recordCall({
      sessionId, ...OFF_PEAK_CALL, toolNames: four, prefixFingerprint: "head-a",
      ts: new Date("2026-08-29T12:00:01Z"),
    });
    db.recordCall({
      sessionId, ...OFF_PEAK_CALL, toolNames: four, prefixFingerprint: "head-b",
      ts: new Date("2026-08-29T12:00:02Z"),
    });
    const rows = db.db
      .prepare(
        `SELECT prefix_changed, prefix_fingerprint_changed FROM calls WHERE session_id = ? ORDER BY ts_utc`,
      )
      .all(sessionId) as Array<{ prefix_changed: number; prefix_fingerprint_changed: number }>;
    assert.deepEqual(rows.map((r) => r.prefix_changed), [0, 0, 0]);
    assert.deepEqual(rows.map((r) => r.prefix_fingerprint_changed), [0, 0, 1]);
    const drift = db.db.prepare(`SELECT COUNT(*) AS n FROM v_head_drift`).get() as { n: number };
    assert.equal(drift.n, 1);
    db.close();
  });

  it("migrates an existing pre-T16.2 calls table without losing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-migrate-t16-"));
    const path = join(dir, "ledger.db");
    const schemaPath = join(dirname(fileURLToPath(import.meta.url)), "schema.sql");
    const full = readFileSync(schemaPath, "utf8");
    const viewsAt = full.indexOf("-- Views");
    assert.ok(viewsAt > 0);
    const oldSql = full
      .slice(0, viewsAt)
      .replace(/\n  -- T16\.2[\s\S]*?prefix_fingerprint_changed\s+INTEGER[^\n]*/, "")
      .replace(/(prefix_changed\s+INTEGER),(\s+-- T4\.2: 1 if hash differs from previous call in session)/, "$1$2");
    assert.equal(oldSql.includes("prefix_fingerprint"), false);
    const raw = new Database(path);
    raw.exec(oldSql);
    raw.close();

    const ledger = Ledger.open(path);
    const cols = new Set(
      (ledger.db.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string }>).map((c) => c.name),
    );
    for (const col of ["prefix_fingerprint", "prefix_fingerprint_source", "prefix_fingerprint_changed"]) {
      assert.ok(cols.has(col), `missing migrated column ${col}`);
    }
    const views = new Set(
      (ledger.db.prepare(`SELECT name FROM sqlite_master WHERE type='view'`).all() as Array<{ name: string }>).map(
        (v) => v.name,
      ),
    );
    assert.ok(views.has("v_head_drift"));

    const sessionId = ledger.startSession({ harnessCommit: "migrated" });
    ledger.recordCall({ sessionId, ...OFF_PEAK_CALL, prefixFingerprint: "post-migration-head" });
    const row = ledger.db.prepare(`SELECT prefix_fingerprint FROM calls`).get() as { prefix_fingerprint: string };
    assert.equal(row.prefix_fingerprint, "post-migration-head");
    ledger.close();
  });

  it("P10.2: migrates wire_tool_name column on calls and records dual identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-migrate-wire-tool-"));
    const path = join(dir, "ledger.db");
    const raw = new Database(path);
    const oldSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8").replace(/wire_tool_name\s+TEXT,/, "");
    raw.exec(oldSql);
    const before = new Set((raw.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string }>).map((c) => c.name));
    assert.equal(before.has("wire_tool_name"), false);
    raw.close();

    const ledger = Ledger.open(path);
    const cols = new Set((ledger.db.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string }>).map((c) => c.name));
    assert.ok(cols.has("wire_tool_name"), "missing migrated column wire_tool_name");

    const sessionId = ledger.startSession({ harnessCommit: "dual-identity" });
    ledger.recordCall({ sessionId, ...OFF_PEAK_CALL, toolName: "todo", wireToolName: "tool_call" });
    const r = ledger.db.prepare(`SELECT tool_name, wire_tool_name FROM calls WHERE session_id = ?`).get(sessionId) as { tool_name: string; wire_tool_name: string };
    assert.equal(r.tool_name, "todo");
    assert.equal(r.wire_tool_name, "tool_call");
    ledger.close();
  });

  it("P14.6: adds calls.credential_label to a pre-ticket ledger and never backfills existing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-migrate-credential-label-"));
    const path = join(dir, "ledger.db");
    // A pre-ticket ledger holding one call: written with today's schema, then
    // the column removed, so the row is a real recordCall() row.
    const seed = Ledger.open(path);
    const oldSession = seed.startSession({ harnessCommit: "pre-ticket" });
    seed.recordCall({ sessionId: oldSession, ...OFF_PEAK_CALL });
    seed.close();
    const raw = new Database(path);
    raw.exec(`ALTER TABLE calls DROP COLUMN credential_label`);
    const before = new Set((raw.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string }>).map((c) => c.name));
    assert.equal(before.has("credential_label"), false);
    raw.close();

    const ledger = Ledger.open(path);
    const cols = new Set((ledger.db.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string }>).map((c) => c.name));
    assert.ok(cols.has("credential_label"), "missing migrated column credential_label");
    const old = ledger.db.prepare(`SELECT credential_label FROM calls WHERE session_id = ?`).get(oldSession) as {
      credential_label: string | null;
    };
    assert.equal(old.credential_label, null, "a pre-ticket row is never backfilled");

    const sessionId = ledger.startSession({ harnessCommit: "post-ticket" });
    ledger.recordCall({ sessionId, ...OFF_PEAK_CALL, credentialLabel: "one@example.com" });
    const fresh = ledger.db.prepare(`SELECT credential_label FROM calls WHERE session_id = ?`).get(sessionId) as {
      credential_label: string | null;
    };
    assert.equal(fresh.credential_label, "one@example.com");
    ledger.close();
    const reopened = Ledger.open(path);
    const still = reopened.db.prepare(`SELECT credential_label FROM calls WHERE session_id = ?`).get(oldSession) as {
      credential_label: string | null;
    };
    assert.equal(still.credential_label, null, "a second open does not backfill either");
    reopened.close();
  });
});

describe("Ledger: T17 cache-stable head flag", () => {
  it("stores flag_cache_stable_head=1 only when cacheStableHead is set", () => {
    const db = Ledger.open(":memory:");
    const on = db.startSession({ harnessCommit: "x", flags: { cacheStableHead: true, delegation: true } });
    const off = db.startSession({ harnessCommit: "x", flags: { delegation: true } });
    const onRow = db.db
      .prepare(`SELECT flag_cache_stable_head FROM sessions WHERE id = ?`)
      .get(on) as { flag_cache_stable_head: number };
    const offRow = db.db
      .prepare(`SELECT flag_cache_stable_head FROM sessions WHERE id = ?`)
      .get(off) as { flag_cache_stable_head: number };
    assert.equal(onRow.flag_cache_stable_head, 1);
    assert.equal(offRow.flag_cache_stable_head, 0);
    db.close();
  });
});

describe("Ledger: T20 trimmed tool surface flag", () => {
  it("stores flag_trimmed_tool_surface=1 only when trimmedToolSurface is set", () => {
    const db = Ledger.open(":memory:");
    const on = db.startSession({ harnessCommit: "x", flags: { trimmedToolSurface: true } });
    const off = db.startSession({ harnessCommit: "x" });
    const onRow = db.db
      .prepare(`SELECT flag_trimmed_tool_surface FROM sessions WHERE id = ?`)
      .get(on) as { flag_trimmed_tool_surface: number };
    const offRow = db.db
      .prepare(`SELECT flag_trimmed_tool_surface FROM sessions WHERE id = ?`)
      .get(off) as { flag_trimmed_tool_surface: number };
    assert.equal(onRow.flag_trimmed_tool_surface, 1);
    assert.equal(offRow.flag_trimmed_tool_surface, 0);
    db.close();
  });
});

describe("Ledger: T21 prompt diet flag", () => {
  it("stores flag_prompt_diet=1 only when promptDiet is set", () => {
    const db = Ledger.open(":memory:");
    const on = db.startSession({ harnessCommit: "x", flags: { promptDiet: true } });
    const off = db.startSession({ harnessCommit: "x" });
    const onRow = db.db
      .prepare(`SELECT flag_prompt_diet FROM sessions WHERE id = ?`)
      .get(on) as { flag_prompt_diet: number };
    const offRow = db.db
      .prepare(`SELECT flag_prompt_diet FROM sessions WHERE id = ?`)
      .get(off) as { flag_prompt_diet: number };
    assert.equal(onRow.flag_prompt_diet, 1);
    assert.equal(offRow.flag_prompt_diet, 0);
    db.close();
  });

  it("stores explore_tool_calls and context_files from endSession / startSession", () => {
    const db = Ledger.open(":memory:");
    const id = db.startSession({
      harnessCommit: "x",
      flags: { promptDiet: true },
      contextFiles: JSON.stringify([{ name: "AGENTS.md", kind: "AGENTS.md", bytes: 12 }]),
    });
    db.endSession({ id, outcome: "success", outcomeSource: "verification_command", toolCalls: 5, exploreToolCalls: 3 });
    const row = db.db
      .prepare(`SELECT explore_tool_calls, context_files, flag_prompt_diet FROM sessions WHERE id = ?`)
      .get(id) as { explore_tool_calls: number; context_files: string; flag_prompt_diet: number };
    assert.equal(row.explore_tool_calls, 3);
    assert.match(row.context_files, /AGENTS\.md/);
    assert.equal(row.flag_prompt_diet, 1);
    db.close();
  });
});

describe("Ledger: T23 output diet flag and specialist", () => {
  it("stores flag_output_diet=1 only when outputDiet is set", () => {
    const db = Ledger.open(":memory:");
    const on = db.startSession({ harnessCommit: "x", flags: { outputDiet: true } });
    const off = db.startSession({ harnessCommit: "x" });
    const onRow = db.db
      .prepare(`SELECT flag_output_diet FROM sessions WHERE id = ?`)
      .get(on) as { flag_output_diet: number };
    const offRow = db.db
      .prepare(`SELECT flag_output_diet FROM sessions WHERE id = ?`)
      .get(off) as { flag_output_diet: number };
    assert.equal(onRow.flag_output_diet, 1);
    assert.equal(offRow.flag_output_diet, 0);
    db.close();
  });

  it("records the specialist alongside the flag, and NULL when omitted", () => {
    const db = Ledger.open(":memory:");
    const withSpecialist = db.startSession({ harnessCommit: "x", flags: { outputDiet: true }, specialist: "budget" });
    const withoutSpecialist = db.startSession({ harnessCommit: "x" });
    const row = db.db.prepare(`SELECT specialist FROM sessions WHERE id = ?`).get(withSpecialist) as { specialist: string };
    const nullRow = db.db.prepare(`SELECT specialist FROM sessions WHERE id = ?`).get(withoutSpecialist) as {
      specialist: string | null;
    };
    assert.equal(row.specialist, "budget");
    assert.equal(nullRow.specialist, null);
    db.close();
  });
});

describe("Ledger: T29 extension set and schema-tax columns", () => {
  it("records extensions, extension_set, and the schema-tax pair when given", () => {
    const db = Ledger.open(":memory:");
    const withExt = db.startSession({
      harnessCommit: "x",
      extensions: JSON.stringify([{ name: "pi-hashline-edit", version: "0.8.3" }]),
      extensionSet: "abc123def456",
      extensionSchemaTokens: 120,
      extensionSchemaShare: 0.14,
    });
    const row = db.db
      .prepare(
        `SELECT extensions, extension_set, extension_schema_tokens, extension_schema_share
         FROM sessions WHERE id = ?`,
      )
      .get(withExt) as {
      extensions: string;
      extension_set: string;
      extension_schema_tokens: number;
      extension_schema_share: number;
    };
    assert.match(row.extensions, /pi-hashline-edit/);
    assert.equal(row.extension_set, "abc123def456");
    assert.equal(row.extension_schema_tokens, 120);
    assert.equal(row.extension_schema_share, 0.14);
    db.close();
  });

  it("leaves extensions NULL and the schema-tax pair NULL when omitted — never a guessed 0", () => {
    const db = Ledger.open(":memory:");
    const bare = db.startSession({ harnessCommit: "x" });
    const row = db.db
      .prepare(
        `SELECT extensions, extension_set, extension_schema_tokens, extension_schema_share
         FROM sessions WHERE id = ?`,
      )
      .get(bare) as {
      extensions: string | null;
      extension_set: string | null;
      extension_schema_tokens: number | null;
      extension_schema_share: number | null;
    };
    assert.equal(row.extensions, null);
    assert.equal(row.extension_set, null);
    assert.equal(row.extension_schema_tokens, null);
    assert.equal(row.extension_schema_share, null);
    db.close();
  });
});

describe("Ledger: T19 compaction threshold and snip/prune columns", () => {
  it("stores compaction_threshold on the session and snip/prune reductions on the call", () => {
    const db = Ledger.open(":memory:");
    const id = db.startSession({
      harnessCommit: "x",
      flags: { proactiveCompaction: true },
      compactionThreshold: 0.8,
    });
    const row = db.db
      .prepare(`SELECT compaction_threshold, flag_proactive_compaction FROM sessions WHERE id = ?`)
      .get(id) as { compaction_threshold: number; flag_proactive_compaction: number };
    assert.equal(row.compaction_threshold, 0.8);
    assert.equal(row.flag_proactive_compaction, 1);

    db.recordCall({
      sessionId: id,
      ...OFF_PEAK_CALL,
      phase: "compact",
      compactionTriggered: true,
      contextBefore: 12_000,
      contextAfter: 3_000,
      snipTokensRemoved: 7_000,
      pruneTokensRemoved: 2_000,
    });
    const call = db.db
      .prepare(
        `SELECT snip_tokens_removed, prune_tokens_removed, context_before, context_after, compaction_triggered, phase
         FROM calls WHERE session_id = ?`,
      )
      .get(id) as {
        snip_tokens_removed: number;
        prune_tokens_removed: number;
        context_before: number;
        context_after: number;
        compaction_triggered: number;
        phase: string;
      };
    assert.equal(call.snip_tokens_removed, 7_000);
    assert.equal(call.prune_tokens_removed, 2_000);
    assert.equal(call.context_before, 12_000);
    assert.equal(call.context_after, 3_000);
    assert.equal(call.compaction_triggered, 1);
    assert.equal(call.phase, "compact");
    assert.ok(call.snip_tokens_removed + call.prune_tokens_removed === call.context_before - call.context_after);
    db.close();
  });
});

describe("Ledger: T25 auth_mode and price_basis", () => {
  it("defaults auth_mode to api_key and price_basis to api_list", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    db.recordCall({ sessionId, ...OFF_PEAK_CALL });
    const row = db.db.prepare(`SELECT auth_mode, price_basis, cost_usd FROM calls`).get() as {
      auth_mode: string;
      price_basis: string;
      cost_usd: number;
    };
    assert.equal(row.auth_mode, "api_key");
    assert.equal(row.price_basis, "api_list");
    assert.ok(row.cost_usd > 0);
    db.close();
  });

  it("records a caller-supplied auth_mode", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    db.recordCall({ sessionId, ...OFF_PEAK_CALL, authMode: "oauth_subscription", priceBasis: "plan_credit" });
    const row = db.db.prepare(`SELECT auth_mode, price_basis, cost_usd FROM calls`).get() as {
      auth_mode: string;
      price_basis: string;
      cost_usd: number;
    };
    assert.equal(row.auth_mode, "oauth_subscription");
    assert.equal(row.price_basis, "plan_credit");
    // plan_credit is still denominated at API rates (docs/13-model-access.md §5.2) — computed as today.
    assert.ok(row.cost_usd > 0);
    db.close();
  });

  it("an 'unpriced' call skips priceCall() entirely: tokens recorded, cost_usd/price_version/rate_window NULL", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    db.recordCall({
      sessionId,
      agent: "worker",
      provider: "some-unverified-gateway",
      model: "whatever-model",
      tokens: { input: 500, output: 20, cacheRead: 0, cacheWrite: 0 },
      authMode: "gateway",
      priceBasis: "unpriced",
    });
    const row = db.db
      .prepare(`SELECT auth_mode, price_basis, cost_usd, price_version, rate_window, avoided_usd, input_tokens, output_tokens FROM calls`)
      .get() as {
      auth_mode: string;
      price_basis: string;
      cost_usd: number | null;
      price_version: string | null;
      rate_window: string | null;
      avoided_usd: number | null;
      input_tokens: number;
      output_tokens: number;
    };
    assert.equal(row.auth_mode, "gateway");
    assert.equal(row.price_basis, "unpriced");
    assert.equal(row.cost_usd, null);
    assert.equal(row.price_version, null);
    assert.equal(row.rate_window, null);
    assert.equal(row.avoided_usd, null);
    // Tokens are still recorded in full — only the dollar figure is withheld.
    assert.equal(row.input_tokens, 500);
    assert.equal(row.output_tokens, 20);
    db.close();
  });

  it("an unpriced row does not contribute a dollar to session or ledger totals", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    db.recordCall({ sessionId, ...OFF_PEAK_CALL }); // priced, api_key/api_list
    db.recordCall({
      sessionId,
      agent: "worker",
      provider: "some-unverified-gateway",
      model: "whatever-model",
      tokens: { input: 999_999, output: 999_999, cacheRead: 0, cacheWrite: 0 },
      priceBasis: "unpriced",
    });
    const totals = db.callTotals(sessionId);
    const pricedOnly = priceCall({
      provider: OFF_PEAK_CALL.provider,
      model: OFF_PEAK_CALL.model,
      tokens: OFF_PEAK_CALL.tokens,
      ts: OFF_PEAK_CALL.ts,
    });
    assert.equal(Math.round((totals.costUsd ?? 0) * 1e8), Math.round(pricedOnly.costUsd * 1e8));
    db.close();
  });

  it("migrates a pre-T25 calls table (cost_usd/price_version NOT NULL) without losing rows, and future calls can be unpriced", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-migrate-t25-"));
    const path = join(dir, "ledger.db");
    const raw = new Database(path);
    raw.exec(PRE_T8_SCHEMA);
    raw
      .prepare(
        `INSERT INTO sessions (id, started_utc, harness_commit, brief) VALUES (?, ?, ?, ?)`,
      )
      .run("pre-existing-session", "2026-08-01T00:00:00.000Z", "deadbeef", "work that predates T25");
    raw
      .prepare(
        `INSERT INTO calls (id, session_id, hop, ts_utc, agent, provider, model, price_version, cost_usd)
         VALUES ('pre-existing-call', 'pre-existing-session', 0, '2026-08-01T00:00:00.000Z', 'worker', 'deepseek', 'deepseek-v4-flash', 'v1', 0.001)`,
      )
      .run();
    // A real pre-T25 ledger has already been opened with the current code
    // many times before, so it already carries schema.sql's own views in
    // sqlite_master -- every one of them `SELECT ... FROM calls`. This one
    // stands in for all of them: it is what caught the real bug (SQLite's
    // ALTER TABLE RENAME auto-updates views to follow the renamed table,
    // which left every real view pointing at a table this migration then
    // dropped) that a fixture with no pre-existing views cannot exercise.
    raw.exec(`CREATE VIEW v_pre_existing_test AS SELECT id, session_id FROM calls`);
    raw.close();

    const ledger = Ledger.open(path);
    const cols = new Set(
      (ledger.db.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string; notnull: number }>).map(
        (c) => c.name,
      ),
    );
    assert.ok(cols.has("auth_mode"));
    assert.ok(cols.has("price_basis"));

    const info = ledger.db.prepare(`PRAGMA table_info(calls)`).all() as Array<{ name: string; notnull: number }>;
    const costCol = info.find((c) => c.name === "cost_usd");
    const priceCol = info.find((c) => c.name === "price_version");
    assert.equal(costCol?.notnull, 0);
    assert.equal(priceCol?.notnull, 0);

    // Data loss check: the pre-existing row survived the table rebuild.
    const preExisting = ledger.db.prepare(`SELECT cost_usd, price_version FROM calls WHERE id = ?`).get(
      "pre-existing-call",
    ) as { cost_usd: number; price_version: string };
    assert.equal(preExisting.cost_usd, 0.001);
    assert.equal(preExisting.price_version, "v1");

    // T25.4: backfilled, not left NULL.
    const backfilled = ledger.db.prepare(`SELECT auth_mode, price_basis FROM calls WHERE id = ?`).get(
      "pre-existing-call",
    ) as { auth_mode: string; price_basis: string };
    assert.equal(backfilled.auth_mode, "api_key");
    assert.equal(backfilled.price_basis, "api_list");

    // The pre-existing view must still resolve against the real `calls`
    // table after the rebuild, not a dangling reference to the renamed one.
    const viaView = ledger.db.prepare(`SELECT id FROM v_pre_existing_test WHERE id = ?`).get(
      "pre-existing-call",
    ) as { id: string } | undefined;
    assert.equal(viaView?.id, "pre-existing-call");
    // And schema.sql's own real views must have resolved cleanly too, not
    // silently left un-recreated by CREATE VIEW IF NOT EXISTS because a
    // (broken) view of that name already existed under the old rename.
    const cacheHealth = ledger.db
      .prepare(`SELECT cache_read FROM v_cache_health WHERE session_id = ?`)
      .get("pre-existing-session") as { cache_read: number } | undefined;
    assert.equal(cacheHealth?.cache_read, 0);

    // A NEW call on the migrated ledger can now be genuinely unpriced.
    const sessionId = ledger.startSession({ harnessCommit: "migrated" });
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "some-unverified-gateway",
      model: "whatever-model",
      tokens: { input: 10, output: 1 },
      priceBasis: "unpriced",
    });
    const newRow = ledger.db.prepare(`SELECT cost_usd, price_basis FROM calls WHERE session_id = ?`).get(
      sessionId,
    ) as { cost_usd: number | null; price_basis: string };
    assert.equal(newRow.cost_usd, null);
    assert.equal(newRow.price_basis, "unpriced");
    ledger.close();
  });
});

describe("Ledger: T31 execution_shape and runtime", () => {
  it("a caller-supplied execution_shape and runtime are recorded as given", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x", executionShape: "standalone", runtime: "host" });
    const row = db.db.prepare(`SELECT execution_shape, runtime FROM sessions WHERE id = ?`).get(sessionId) as {
      execution_shape: string;
      runtime: string;
    };
    assert.equal(row.execution_shape, "standalone");
    assert.equal(row.runtime, "host");
    db.close();
  });

  it("both columns are NULL, not guessed, when a caller omits them", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x" });
    const row = db.db.prepare(`SELECT execution_shape, runtime FROM sessions WHERE id = ?`).get(sessionId) as {
      execution_shape: string | null;
      runtime: string | null;
    };
    assert.equal(row.execution_shape, null);
    assert.equal(row.runtime, null);
    db.close();
  });

  it("backfills a genuinely pre-T31 ledger: subagent by parent_session_id, mcp_worker by the four lykos_ briefs, everything else cli_delegate, runtime always container", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-migrate-t31-"));
    const path = join(dir, "ledger.db");

    // Build a real pre-T31 ledger: the CURRENT schema.sql, minus the two
    // lines that declare execution_shape/runtime, so PRAGMA table_info sees
    // those columns as genuinely absent (not merely NULLed) -- the same
    // condition migrateSessionsTable's `!cols.has(...)` gate checks, and the
    // only condition under which its one-time backfill is allowed to run
    // (see the comment beside backfillExecutionShape/backfillRuntime in
    // ledger.ts). Every other column, including parent_session_id, is
    // exactly what a real ledger already had before this task, so a
    // pre-migration child row can be inserted directly.
    // Tables only. The Views section is dropped from the fixture because a
    // view may legitimately SELECT a post-T31 column (T63's v_exploration
    // does), and creating it here would both defeat the "genuinely absent"
    // assertion below and reference a column this fixture table lacks. The
    // real views are created by applySchema() when the Ledger opens the file,
    // which is after the migration has added the columns back.
    const fullSchemaSql = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "schema.sql"), "utf8");
    const viewsIdx = fullSchemaSql.indexOf("-- Views");
    assert.ok(viewsIdx > 0, "schema.sql is missing the Views heading applySchema splits on");
    const schemaSql = fullSchemaSql.slice(0, viewsIdx);
    const startMarker = "execution_shape       TEXT CHECK (execution_shape IN";
    const endMarker = "runtime               TEXT CHECK (runtime IN ('container','host')),\n";
    const startIdx = schemaSql.indexOf(startMarker);
    const endIdx = schemaSql.indexOf(endMarker);
    assert.ok(startIdx >= 0 && endIdx > startIdx, "the execution_shape/runtime block was not found to strip");
    const preT31Schema = schemaSql.slice(0, startIdx) + schemaSql.slice(endIdx + endMarker.length);
    assert.ok(!preT31Schema.includes("execution_shape"), "execution_shape leaked into the fixture schema");
    assert.ok(!preT31Schema.includes(endMarker), "runtime leaked into the fixture schema");
    const raw = new Database(path);
    raw.exec(preT31Schema);
    raw
      .prepare(
        `INSERT INTO sessions (id, started_utc, harness_commit, brief, parent_session_id)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run("pre-t31-parent", "2026-08-01T00:00:00.000Z", "deadbeef", "lykos_implement");
    raw
      .prepare(
        `INSERT INTO sessions (id, started_utc, harness_commit, brief, parent_session_id)
         VALUES (?, ?, ?, ?, NULL)`,
      )
      .run("pre-t31-cli", "2026-08-01T00:00:00.000Z", "deadbeef", "some ad-hoc CLI brief");
    raw
      .prepare(
        `INSERT INTO sessions (id, started_utc, harness_commit, brief, parent_session_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("pre-t31-child", "2026-08-01T00:00:00.000Z", "deadbeef", "child — subagent", "pre-t31-parent");
    raw.close();

    const cols = new Set(
      (new Database(path).prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    assert.ok(!cols.has("execution_shape"), "test fixture is not actually pre-T31");

    const ledger = Ledger.open(path);
    const rows = ledger.db
      .prepare(`SELECT id, execution_shape, runtime FROM sessions ORDER BY started_utc`)
      .all() as Array<{ id: string; execution_shape: string; runtime: string }>;
    const byId = new Map(rows.map((r) => [r.id, r]));

    assert.equal(byId.get("pre-t31-parent")?.execution_shape, "mcp_worker");
    assert.equal(byId.get("pre-t31-cli")?.execution_shape, "cli_delegate");
    assert.equal(byId.get("pre-t31-child")?.execution_shape, "subagent");
    for (const r of rows) assert.equal(r.runtime, "container");
    ledger.close();
  });

  it("does NOT overwrite a NEW row's deliberately-omitted execution_shape on a later reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-migrate-t31-noclobber-"));
    const path = join(dir, "ledger.db");

    // Simulate a caller written after T31 that legitimately leaves the
    // shape unset (recordBudgetTrip's blocked-session row is the real
    // example). The backfill must not treat this ledger's next open() as a
    // fresh migration and guess a value for it.
    const first = Ledger.open(path);
    const id = first.startSession({ harnessCommit: "x", brief: "blocked: budget cap" });
    first.close();

    const second = Ledger.open(path);
    const row = second.db.prepare(`SELECT execution_shape, runtime FROM sessions WHERE id = ?`).get(id) as {
      execution_shape: string | null;
      runtime: string | null;
    };
    assert.equal(row.execution_shape, null);
    assert.equal(row.runtime, null);
    second.close();
  });
});

describe("Ledger: T35.3 sessions.model_source", () => {
  it("records a caller-supplied model_source", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({
      harnessCommit: "x",
      model: "deepseek-v4-pro",
      modelSource: "caller_override",
    });
    const row = db.db.prepare(`SELECT model, model_source FROM sessions WHERE id = ?`).get(sessionId) as {
      model: string;
      model_source: string;
    };
    assert.equal(row.model, "deepseek-v4-pro");
    assert.equal(row.model_source, "caller_override");
    db.close();
  });

  it("leaves model_source NULL when omitted — never guesses config_default", () => {
    const db = Ledger.open(":memory:");
    const sessionId = db.startSession({ harnessCommit: "x", model: "deepseek-v4-flash" });
    const row = db.db.prepare(`SELECT model_source FROM sessions WHERE id = ?`).get(sessionId) as {
      model_source: string | null;
    };
    assert.equal(row.model_source, null);
    db.close();
  });
});

describe("Ledger: closing, reopening and naming a session (2026-09-07 UI feedback)", () => {
  it("closeSession marks a session done, and fills in an end time only when it is missing", () => {
    const db = Ledger.open(":memory:");
    // A session that crashed: it never ended, so closing it is the first
    // honest end time it can be given.
    const crashed = db.startSession({ harnessCommit: "x" });
    db.closeSession(crashed, "2026-09-07T10:00:00.000Z");
    const a = db.db.prepare(`SELECT ended_utc, closed_utc FROM sessions WHERE id = ?`).get(crashed) as {
      ended_utc: string | null;
      closed_utc: string | null;
    };
    assert.equal(a.ended_utc, "2026-09-07T10:00:00.000Z");
    assert.equal(a.closed_utc, "2026-09-07T10:00:00.000Z");

    // A session that ended normally keeps the time it actually ended at.
    const ended = db.startSession({ harnessCommit: "x" });
    db.endSession({ id: ended, endedUtc: "2026-09-07T09:00:00.000Z" });
    db.closeSession(ended, "2026-09-07T10:00:00.000Z");
    const b = db.db.prepare(`SELECT ended_utc, closed_utc FROM sessions WHERE id = ?`).get(ended) as {
      ended_utc: string | null;
      closed_utc: string | null;
    };
    assert.equal(b.ended_utc, "2026-09-07T09:00:00.000Z");
    assert.equal(b.closed_utc, "2026-09-07T10:00:00.000Z");

    assert.throws(() => db.closeSession("nope"), /unknown session/);
    db.close();
  });

  it("reopenSession lets a continued session be ended again, and keeps its cost", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-reopen-"));
    const db = Ledger.open(join(dir, "ledger.db"));
    const id = db.startSession({ harnessCommit: "x", model: "deepseek/deepseek-v4-flash" });
    db.recordCall({
      sessionId: id,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 1000, output: 100 },
      ts: OFF_PEAK,
    });
    db.endSession({ id });
    const first = db.db.prepare(`SELECT total_cost_usd FROM sessions WHERE id = ?`).get(id) as { total_cost_usd: number | null };

    // Without the reopen, `endSession` refuses — the append-only rule. That
    // refusal is exactly what made a continued session un-ingestable.
    assert.throws(() => db.endSession({ id }), /already ended/);
    db.reopenSession(id);
    db.recordCall({
      sessionId: id,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 1000, output: 100 },
      ts: OFF_PEAK,
    });
    db.endSession({ id });
    const second = db.db.prepare(`SELECT total_cost_usd FROM sessions WHERE id = ?`).get(id) as { total_cost_usd: number | null };

    // The session's cost is still the sum of its calls, so continuing one
    // recomputes the same total over a strictly larger set — the headline
    // metric cannot be improved by resuming.
    assert.ok((second.total_cost_usd ?? 0) > (first.total_cost_usd ?? 0));
    db.close();
  });

  it("accumulates per-run counters across a continuation instead of replacing them", () => {
    const db = Ledger.open(":memory:");
    const id = db.startSession({ harnessCommit: "x" });
    db.endSession({ id, turns: 5, toolCalls: 12, humanInterventions: 2 });
    db.reopenSession(id);
    db.endSession({ id, turns: 2, toolCalls: 3, humanInterventions: 1 });
    const row = db.db
      .prepare(`SELECT turns, tool_calls, human_interventions FROM sessions WHERE id = ?`)
      .get(id) as { turns: number; tool_calls: number; human_interventions: number };
    // A session resumed after five turns and continued for two took seven.
    // Reporting two would be a number that was never true of anything.
    assert.equal(row.turns, 7);
    assert.equal(row.tool_calls, 15);
    assert.equal(row.human_interventions, 3);
    db.close();
  });

  it("renameSession writes the name a human chose, and refuses an empty one", () => {
    const db = Ledger.open(":memory:");
    const id = db.startSession({ harnessCommit: "x", brief: "(delegate)" });
    assert.equal(db.renameSession(id, "  the parser rename  "), true);
    const row = db.db.prepare(`SELECT brief FROM sessions WHERE id = ?`).get(id) as { brief: string };
    assert.equal(row.brief, "the parser rename");
    assert.equal(db.renameSession("nope", "x"), false);
    assert.throws(() => db.renameSession(id, "   "), /cannot be empty/);
    db.close();
  });

  it("specialist restriction recorded in DenialLog reaches sessions.human_interventions (D7)", () => {
    const denials = new DenialLog();
    denials.record("specialist_restricted", "bash", "reviewer");
    assert.equal(denials.specialistRestricted, 1);
    assert.equal(denials.total, 1);

    const db = Ledger.open(":memory:");
    const id = db.startSession({ harnessCommit: "x" });
    db.endSession({ id, humanInterventions: denials.total });
    const row = db.db.prepare(`SELECT human_interventions FROM sessions WHERE id = ?`).get(id) as { human_interventions: number };
    assert.equal(row.human_interventions, 1);
    db.close();
  });

  it("links child session to parent via parent_session_id and records specialist and model attributes", () => {
    const db = Ledger.open(":memory:");
    const parentId = db.startSession({
      harnessCommit: "test",
      specialist: "deliberate",
      model: "deepseek-v4-flash",
      modelSource: "config_default",
    });
    db.recordCall({
      sessionId: parentId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 20 },
      toolNames: ["read", "write", "edit", "bash", "agent"],
      prefixFingerprint: "parent-fingerprint-123",
    });

    const childId = db.startSession({
      harnessCommit: "test",
      parentSessionId: parentId,
      specialist: "overrider",
      model: "deepseek-v4-pro",
      modelSource: "specialist",
    });
    db.recordCall({
      sessionId: childId,
      hop: 1,
      agent: "subagent",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      tokens: { input: 50, output: 10 },
      toolNames: ["read"],
      prefixFingerprint: "child-fingerprint-456",
    });

    const childRow = db.db.prepare("SELECT * FROM sessions WHERE parent_session_id = ?").get(parentId) as any;
    assert.ok(childRow);
    assert.equal(childRow.id, childId);
    assert.equal(childRow.parent_session_id, parentId);
    assert.equal(childRow.specialist, "overrider");
    assert.equal(childRow.model, "deepseek-v4-pro");
    assert.equal(childRow.model_source, "specialist");

    const parentCalls = db.db.prepare("SELECT tool_count, tool_names, prefix_fingerprint FROM calls WHERE session_id = ?").all(parentId) as any[];
    const childCalls = db.db.prepare("SELECT tool_count, tool_names, prefix_fingerprint FROM calls WHERE session_id = ?").all(childId) as any[];

    assert.equal(parentCalls.length, 1);
    assert.equal(childCalls.length, 1);
    assert.equal(parentCalls[0].tool_count, 5);
    assert.equal(childCalls[0].tool_count, 1);
    assert.notEqual(childCalls[0].prefix_fingerprint, parentCalls[0].prefix_fingerprint);

    const parentTotals = db.callTotals(parentId);
    const childTotals = db.callTotals(childId);
    assert.equal(parentTotals.n, 1);
    assert.equal(childTotals.n, 1);

    db.close();
  });

  it("T203: widens tasks.state to include disputed and migrates existing databases", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-tasks-migration-"));
    const path = join(dir, "ledger.db");
    const raw = new Database(path);
    // Create an old tasks table with check constraint ('open','done','abandoned')
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, first_commit_sha TEXT NOT NULL);
      INSERT INTO projects VALUES ('p1', 'proj', '/work', 'sha1');
      CREATE TABLE tasks (
        id                    TEXT PRIMARY KEY,
        project_id            TEXT NOT NULL REFERENCES projects(id),
        brief                 TEXT NOT NULL,
        created_utc           TEXT NOT NULL,
        state                 TEXT CHECK (state IN ('open','done','abandoned')),
        difficulty_estimate   INTEGER
      );
      INSERT INTO tasks VALUES ('t1', 'p1', 'old task', '2026-10-01T00:00:00Z', 'open', 1);
    `);
    // Attempting to insert 'disputed' fails with CHECK constraint
    assert.throws(() => {
      raw.exec("INSERT INTO tasks VALUES ('t2', 'p1', 'disputed task', '2026-10-01T00:00:00Z', 'disputed', 1)");
    });
    raw.close();

    // Now open via Ledger, which applies migrateTasksTable
    const ledger = Ledger.open(path);
    const row = ledger.db.prepare("SELECT * FROM tasks WHERE id = 't1'").get() as any;
    assert.equal(row.id, "t1");
    assert.equal(row.state, "open");

    // Setting state to 'disputed' now succeeds
    ledger.setTaskState("t1", "disputed");
    const updated = ledger.db.prepare("SELECT state FROM tasks WHERE id = 't1'").get() as any;
    assert.equal(updated.state, "disputed");
    ledger.close();
  });
});
