import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { PI_DEFAULT_TOOLS, measureToolset } from "../ledger/tool-schema.js";
import { runCost } from "./cost.js";

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

describe("runCost", () => {
  it("reports no ledger yet without creating one", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const { code, out } = captureStdout(() => runCost(ledgerPath));
    assert.equal(code, 0);
    assert.match(out, /no ledger at/);
    assert.match(out, /without pi-subagents/);
    assert.match(out, /with pi-subagents/);
    assert.match(out, /T20 hop-0 worker/);
    assert.match(out, /T20 before \(omit\)/);
    assert.match(out, /T20 \+ subagent host/);
    assert.match(out, /pi_estimateTokens_chars\/4/);
  });

  it("summarizes a session that recorded calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "implement X", harnessCommit: "abc123" });
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
    });
    ledger.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath));
    assert.equal(code, 0);
    assert.match(out, /sessions\s+1/);
    assert.match(out, /1 success/);
    assert.match(out, /implement X/);
    assert.match(out, /unmeasured left NULL|unmeasured \(activeTools/);
  });

  it("prints the measured average and share when toolNames were recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "schema-measured", harnessCommit: "abc123" });
    const names = [...PI_DEFAULT_TOOLS];
    const expected = measureToolset(names);
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 400, output: 10, cacheRead: 600, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
      toolNames: names,
    });
    ledger.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath));
    assert.equal(code, 0);
    assert.match(out, new RegExp(`avg ${expected.tokens} tokens/call across 1 measured`));
    assert.match(out, /share of prompt/);
    assert.doesNotMatch(out, /prefix hash changed/);
  });

  it("warns when a session's tool-schema hash changed mid-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "prefix-break", harnessCommit: "abc123" });
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
      toolNames: [...PI_DEFAULT_TOOLS],
    });
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:01Z"),
      toolNames: [...PI_DEFAULT_TOOLS, "grep"],
    });
    ledger.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath));
    assert.equal(code, 0);
    assert.match(out, /prefix hash changed on 1 call/);
  });

  it("shows the current-session summary (T5.1/T5.2) ahead of the all-sessions overview", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "current session brief", harnessCommit: "abc123" });
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
    });
    ledger.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath));
    assert.equal(code, 0);
    assert.match(out, /lykos {2}session [0-9a-f]{8}\s+│\s+current session brief/);
    // T6.1: no cache activity in this fixture, so the real, exactly-computed
    // avoided figure is zero -- a measured zero, not "not yet computed."
    assert.match(out, /avoided\s+~\$0\.0000/);
    // the pre-existing all-sessions overview still follows it
    assert.match(out, /lykos cost — all sessions/);
  });

  it("--since <Nd> reports a windowed rollup, and rejects a malformed window", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "recent work", harnessCommit: "abc123" });
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0 },
      ts: new Date(),
    });
    ledger.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });
    ledger.close();

    const good = captureStdout(() => runCost(ledgerPath, { since: "7d" }));
    assert.equal(good.code, 0);
    assert.match(good.out, /7 days\s+│\s+1 sessions\s+│\s+1 success/);
    assert.match(good.out, /cost per successful task/);
    assert.match(good.out, /tokens per task/);
    assert.match(good.out, /tool-calls per task/);
    assert.match(good.out, /explore-calls per task/);
    assert.match(good.out, /suggestive, not conclusive/);
    // T6.1: real cache activity (cacheRead: 900) in this fixture now produces
    // a real avoided figure -- exact cents depend on whether "now" falls in
    // DeepSeek's peak or off-peak window, so assert the line's shape and
    // that zero cost inversions were found, not a specific dollar amount.
    assert.match(good.out, /total avoided \(modelled\)\s+~\$\d/);
    assert.match(good.out, /cost inversions\s+0/);
    assert.match(good.out, /cache hit ratio/);

    const bad = captureStdout(() => runCost(ledgerPath, { since: "banana" }));
    assert.equal(bad.code, 1);
    assert.match(bad.out, /expected "<N>d"/);
  });

  it("--compare <flag> splits sessions by the mechanism flag, labelled observational", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const withDelegation = ledger.startSession({
      brief: "delegated task",
      harnessCommit: "abc123",
      flags: { delegation: true },
    });
    ledger.endSession({ id: withDelegation, outcome: "success", outcomeSource: "verification_command" });
    const withoutDelegation = ledger.startSession({ brief: "direct task", harnessCommit: "abc123" });
    ledger.endSession({ id: withoutDelegation, outcome: "fail", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath, { compare: "delegation" }));
    assert.equal(code, 0);
    assert.match(out, /observational — not a controlled experiment/);
    assert.match(out, /delegation ON\s+1 sessions\s+1 success/);
    assert.match(out, /delegation OFF\s+1 sessions\s+0 success\s+cost\/success n\/a/);

    const unknown = captureStdout(() => runCost(ledgerPath, { compare: "not-a-flag" }));
    assert.equal(unknown.code, 1);
    assert.match(unknown.out, /unknown flag/);
  });

  it("--compare cache_stable_head splits on the T17 contract flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const on = ledger.startSession({
      brief: "stable head",
      harnessCommit: "abc123",
      flags: { cacheStableHead: true },
    });
    ledger.endSession({ id: on, outcome: "success", outcomeSource: "verification_command" });
    const off = ledger.startSession({ brief: "volatile head", harnessCommit: "abc123" });
    ledger.endSession({ id: off, outcome: "fail", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath, { compare: "cache_stable_head" }));
    assert.equal(code, 0);
    assert.match(out, /cache_stable_head ON\s+1 sessions\s+1 success/);
    assert.match(out, /cache_stable_head OFF\s+1 sessions\s+0 success/);
  });

  it("--compare trimmed_tool_surface splits on the T20 surface flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const on = ledger.startSession({
      brief: "trimmed surface",
      harnessCommit: "abc123",
      flags: { trimmedToolSurface: true },
    });
    ledger.endSession({ id: on, outcome: "success", outcomeSource: "verification_command" });
    const off = ledger.startSession({ brief: "omit-tools default", harnessCommit: "abc123" });
    ledger.endSession({ id: off, outcome: "fail", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath, { compare: "trimmed_tool_surface" }));
    assert.equal(code, 0);
    assert.match(out, /trimmed_tool_surface ON\s+1 sessions\s+1 success/);
    assert.match(out, /trimmed_tool_surface OFF\s+1 sessions\s+0 success/);
  });

  it("--compare prompt_diet splits on the T21 diet flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const on = ledger.startSession({
      brief: "diet on",
      harnessCommit: "abc123",
      flags: { promptDiet: true },
    });
    ledger.endSession({ id: on, outcome: "success", outcomeSource: "verification_command" });
    const off = ledger.startSession({ brief: "diet off", harnessCommit: "abc123" });
    ledger.endSession({ id: off, outcome: "fail", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath, { compare: "prompt_diet" }));
    assert.equal(code, 0);
    assert.match(out, /observational — not a controlled experiment/);
    assert.match(out, /prompt_diet ON\s+1 sessions\s+1 success/);
    assert.match(out, /prompt_diet OFF\s+1 sessions\s+0 success/);
  });

  it("--compare output_diet splits on the T23 flag", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const on = ledger.startSession({
      brief: "output diet on",
      harnessCommit: "abc123",
      flags: { outputDiet: true },
      specialist: "budget",
    });
    ledger.endSession({ id: on, outcome: "success", outcomeSource: "verification_command" });
    const off = ledger.startSession({ brief: "output diet off", harnessCommit: "abc123" });
    ledger.endSession({ id: off, outcome: "fail", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath, { compare: "output_diet" }));
    assert.equal(code, 0);
    assert.match(out, /output_diet ON\s+1 sessions\s+1 success/);
    assert.match(out, /output_diet OFF\s+1 sessions\s+0 success/);
  });

  it("--compare extensions groups by the set, not a boolean, and keeps 'none' as its own row", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const withExt = ledger.startSession({
      brief: "hashline session",
      harnessCommit: "abc123",
      extensions: JSON.stringify([{ name: "pi-hashline-edit", version: "0.8.3" }]),
      extensionSet: "abc123def456",
    });
    ledger.endSession({ id: withExt, outcome: "success", outcomeSource: "verification_command" });
    const none = ledger.startSession({ brief: "no extensions", harnessCommit: "abc123", extensionSet: "none" });
    ledger.endSession({ id: none, outcome: "fail", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath, { compare: "extensions" }));
    assert.equal(code, 0);
    assert.match(out, /observational — not a controlled experiment/);
    assert.match(out, /abc123def456\s+1 sessions\s+1 success.*pi-hashline-edit@0\.8\.3/);
    assert.match(out, /none\s+1 sessions\s+0 success/);
    // Same flag, aliased spelling — both must resolve to the same report.
    const aliased = captureStdout(() => runCost(ledgerPath, { compare: "extension_set" }));
    assert.equal(aliased.out, out);
  });

  it("--compare extensions keeps a pre-T29 NULL set as its own row, distinct from 'none'", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    // A session that never recorded extension_set at all (as every session
    // predating T29 will read once migrated) must not be silently folded
    // into "none" -- the two are different facts.
    const unrecorded = ledger.startSession({ brief: "pre-T29 session", harnessCommit: "abc123" });
    ledger.endSession({ id: unrecorded, outcome: "success", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath, { compare: "extensions" }));
    assert.equal(code, 0);
    assert.match(out, /\(unrecorded, pre-T29\)\s+1 sessions\s+1 success/);
    assert.doesNotMatch(out, /^ none\s/m);
  });

  it("--compare shape groups by execution_shape, and keeps a pre-T31 NULL as its own row", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const mcp = ledger.startSession({
      brief: "mcp session",
      harnessCommit: "abc123",
      executionShape: "mcp_worker",
      runtime: "container",
    });
    ledger.endSession({ id: mcp, outcome: "success", outcomeSource: "verification_command" });
    const standalone = ledger.startSession({
      brief: "standalone session",
      harnessCommit: "abc123",
      executionShape: "standalone",
      runtime: "host",
    });
    ledger.endSession({ id: standalone, outcome: "success", outcomeSource: "verification_command" });
    const unrecorded = ledger.startSession({ brief: "pre-T31 session", harnessCommit: "abc123" });
    ledger.endSession({ id: unrecorded, outcome: "fail", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath, { compare: "shape" }));
    assert.equal(code, 0);
    assert.match(out, /observational — not a controlled experiment/);
    assert.match(out, /mcp_worker\s+1 sessions\s+1 success/);
    assert.match(out, /standalone\s+1 sessions\s+1 success/);
    assert.match(out, /\(unrecorded, pre-T31\)\s+1 sessions\s+0 success/);
    // Same flag, aliased spelling — both must resolve to the same report.
    const aliased = captureStdout(() => runCost(ledgerPath, { compare: "execution_shape" }));
    assert.equal(aliased.out, out);
  });

  it("lists extensions and shape as valid --compare flags in the unknown-flag message", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    Ledger.open(ledgerPath).close();
    const { code, out } = captureStdout(() => runCost(ledgerPath, { compare: "not-a-flag" }));
    assert.equal(code, 1);
    assert.match(out, /extensions, shape\.\n$/);
  });

  it("surfaces the current session's extension set and measured schema tax", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({
      brief: "hashline current",
      harnessCommit: "abc123",
      extensions: JSON.stringify([{ name: "pi-hashline-edit", version: "0.8.3" }]),
      extensionSet: "abc123def456",
      extensionSchemaTokens: 120,
      extensionSchemaShare: 0.15,
    });
    ledger.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath));
    assert.equal(code, 0);
    assert.match(out, /extensions \(T29\)/);
    assert.match(out, /set abc123def456\s+pi-hashline-edit@0\.8\.3/);
    assert.match(out, /schema tax\s+15\.0% of billed input\s+\(120 tokens beyond Pi's own built-ins\)/);
  });

  it("reports 'unmeasured' with the unknown tool names when the schema-tax pair is NULL", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    // extensionSet is set (as every real T29-era ingest always sets it, even
    // to "none") so this exercises "declared but couldn't measure", not the
    // separate "predates T29" case writeExtensionSchemaTax also reports.
    const sessionId = ledger.startSession({
      brief: "unmeasured extension",
      harnessCommit: "abc123",
      extensionSet: "none",
    });
    ledger.endSession({
      id: sessionId,
      outcome: "success",
      outcomeSource: "verification_command",
      notes: "extension schema tax unmeasured — catalog does not know: some-new-tool — add them to tool-catalog.ts to measure this set",
    });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath));
    assert.equal(code, 0);
    assert.match(out, /schema tax\s+unmeasured \(catalog does not know: some-new-tool\)/);
  });

  it("reports a pre-T29 session (extension_set never recorded) distinctly from an unmeasured one", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "predates T29", harnessCommit: "abc123" });
    ledger.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath));
    assert.equal(code, 0);
    assert.match(out, /schema tax\s+not recorded — this session ran before T29 added the columns/);
  });

  it("T25.3: breaks cost down by price_basis and reports an excluded-row count for unpriced calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "mixed basis", harnessCommit: "abc123" });
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      ts: new Date("2026-08-29T12:00:00Z"),
    });
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "some-unverified-gateway",
      model: "whatever-model",
      tokens: { input: 5000, output: 500, cacheRead: 0, cacheWrite: 0 },
      priceBasis: "unpriced",
      ts: new Date("2026-08-29T12:05:00Z"),
    });
    ledger.endSession({ id: sessionId, outcome: "success", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath));
    assert.equal(code, 0);
    assert.match(out, /price basis \(T25/);
    assert.match(out, /api_list\s+1 calls/);
    assert.match(out, /unpriced\s+1 calls.*no dollar figure — never invented/);
    assert.match(out, /excluded from cost claims: 1 unpriced call\(s\)/);
  });

  it("T26.4/T26.5: --since reports wall-clock per successful task and p50/p95 latency beside TTFT", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const started = new Date();
    const sessionId = ledger.startSession({
      brief: "timed task",
      harnessCommit: "abc123",
      startedUtc: started.toISOString(),
    });
    for (const [latencyMs, ttftMs] of [
      [800, 150],
      [1200, 300],
      [2000, 500],
    ] as const) {
      ledger.recordCall({
        sessionId,
        agent: "worker",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        tokens: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0 },
        ts: new Date(),
        latencyMs,
        ttftMs,
      });
    }
    const ended = new Date(started.getTime() + 5000);
    ledger.endSession({
      id: sessionId,
      outcome: "success",
      outcomeSource: "verification_command",
      endedUtc: ended.toISOString(),
    });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath, { since: "7d" }));
    assert.equal(code, 0);
    assert.match(out, /wall-clock per successful task\s+5\.00s/);
    assert.match(out, /cache hit ratio.*TTFT p50.*p95/);
    assert.match(out, /call latency\s+p50 .* p95 .*\(3 call\(s\) measured\)/);
  });

  it("T26.4: reports 'not yet measured' for latency and 'n/a' for wall-clock when nothing recorded either", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cost-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "unmeasured", harnessCommit: "abc123" });
    ledger.recordCall({
      sessionId,
      agent: "worker",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 },
      ts: new Date(),
    });
    ledger.endSession({ id: sessionId, outcome: "fail", outcomeSource: "verification_command" });
    ledger.close();

    const { code, out } = captureStdout(() => runCost(ledgerPath, { since: "7d" }));
    assert.equal(code, 0);
    assert.match(out, /wall-clock per successful task\s+n\/a \(no successes in window\)/);
    assert.match(out, /call latency\s+not yet measured/);
  });
});
