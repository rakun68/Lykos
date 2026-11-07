// T235 (ADR-0061, spec decision 13): a finding is a claim with a severity, a basis and a check, and the rule that decides
// what it does.
//
// Seams:
//   - `parseFinding` on the shapes the `finding` tool is given, and `dispose`, the rule, on verdicts shaped as the harness
//     returns them (`ClaimResult`).
//   - The `finding` tool inside the real session child on Pi's scripted model: a review session has it and records what it
//     is given, any other session has none, and a malformed finding is refused and records nothing.
//
// Lessons held here: W7 (a low finding needs a reproduction to block; a medium one without goes to triage, never silently
// dropped), `review_false_positive` (a check that ran and did not hold drops the finding with that cause).

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { runSessionChild } from "../cli/session-child.js";
import { call, lastToolResult, reply, say, SCRIPTED_MODEL, scriptedWorld, type ModelContext, type ScriptStep } from "../cli/scripted-session.js";
import { withLedgerSync } from "../ledger/use.js";
import { runStandaloneTask } from "../session/session.js";
import type { ClaimCheck, ClaimResult } from "./claims.js";
import { dispose, findingsOf, nextOfFindings, parseFinding, type Severity } from "./findings.js";
import { encodeFrame, PROTOCOL_VERSION, type SessionRequest } from "./session-protocol.js";

const REPRO: ClaimCheck = { kind: "reproduction", file: "tests/repro.test.mjs", content: "import { test } from 'node:test';\ntest('adds', () => {});\n", fails: ["adds"] };
const COMMAND: ClaimCheck = { kind: "command", command: "node -e \"process.exit(1)\"", exit: 1 };
const LINE: ClaimCheck = { kind: "line", path: "src/a.mjs", line: 1, text: "a - b" };

function verdict(v: ClaimResult["verdict"], extra: Partial<ClaimResult> = {}): ClaimResult {
  return { id: 1, text: "t", check: { kind: "line", path: "p", line: 1, text: "x" }, verdict: v, reason: v === "verified" ? "the named tests fail" : v === "failed" ? "the named tests passed" : "could not run", ...extra };
}

describe("T235: parseFinding", () => {
  it("takes a finding with a reproduction, and one with no check at all", () => {
    const withCheck = parseFinding({ text: "add subtracts", severity: "high", basis: "src/math.mjs:1", check: REPRO });
    assert.ok(withCheck.ok, JSON.stringify(withCheck));
    assert.equal(withCheck.finding.severity, "high");
    assert.equal(withCheck.finding.check?.kind, "reproduction");
    const bare = parseFinding({ text: "the name is vague", severity: "low", basis: "src/a.ts:3" });
    assert.ok(bare.ok);
    assert.equal(bare.finding.check, undefined);
  });

  it("refuses an empty text, an unknown severity, an empty basis and a malformed check, saying which", () => {
    for (const [value, pattern] of [
      [{ severity: "low", basis: "a:1" }, /text/],
      [{ text: "x", severity: "urgent", basis: "a:1" }, /`severity` must be one of low, medium, high, critical/],
      [{ text: "x", severity: "low", basis: "  " }, /basis/],
      [{ text: "x", severity: "low", basis: "a:1", check: { kind: "command" } }, /check\.command/],
      [{ text: "x", severity: "low", basis: "a:1", check: { kind: "reproduction", file: "t.mjs", content: "x", fails: [] } }, /check\.fails/],
      ["not an object", /object/],
    ] as const) {
      const parsed = parseFinding(value);
      assert.equal(parsed.ok, false, JSON.stringify(value));
      if (!parsed.ok) assert.match(parsed.message, pattern);
    }
  });
});

describe("T235 ACCEPTANCE: what a finding does (W7, review_false_positive)", () => {
  const rule = (severity: Severity, check: ClaimCheck | undefined, result: ClaimResult | undefined, baselineFailing?: string[]) =>
    dispose({ severity, check, result, baselineFailing });

  it("a low finding with no reproduction does not block: it is dropped, and says why", () => {
    const d = rule("low", undefined, undefined);
    assert.equal(d.disposition, "dropped");
    assert.match(d.why, /low finding needs a reproduction to block/);
    assert.equal(d.cause, undefined, "dropping for want of a reproduction is not a false positive");
  });

  it("a medium, high or critical finding with no reproduction goes to triage, never dropped", () => {
    for (const severity of ["medium", "high", "critical"] as const) {
      const d = rule(severity, undefined, undefined);
      assert.equal(d.disposition, "triage", severity);
      assert.match(d.why, /coordinator's to triage/);
    }
  });

  it("a check that could not run counts as no reproduction: low is dropped, medium goes to triage", () => {
    assert.equal(rule("low", REPRO, verdict("unchecked")).disposition, "dropped");
    const medium = rule("medium", REPRO, verdict("unchecked"));
    assert.equal(medium.disposition, "triage");
    assert.match(medium.why, /could not run/);
  });

  it("a check that only confirms the cited line does not reproduce the defect, however severe", () => {
    assert.equal(rule("low", LINE, verdict("verified")).disposition, "dropped");
    assert.equal(rule("high", LINE, verdict("verified")).disposition, "triage");
  });

  it("a check that ran and did not hold drops the finding as a false positive, at any severity", () => {
    for (const severity of ["low", "medium", "critical"] as const) {
      const shapes: ClaimCheck[] = [REPRO, COMMAND, LINE];
      for (const shape of shapes) {
        const d = rule(severity, shape, verdict("failed"));
        assert.equal(d.disposition, "dropped", `${severity} ${shape.kind}`);
        assert.equal(d.cause, "review_false_positive");
      }
    }
  });

  it("a reproduction that holds blocks, even when it is low; a command that holds blocks", () => {
    assert.equal(rule("low", REPRO, verdict("verified", { base: { verdict: "passes", reason: "pass at base" }, regression: true })).disposition, "blocks");
    assert.equal(rule("low", COMMAND, verdict("verified")).disposition, "blocks");
    assert.equal(rule("critical", REPRO, verdict("verified")).disposition, "blocks", "a base verdict that is absent does not stop it");
  });

  it("a reproduction that fails at the base too is not the change's: dropped, not a false positive", () => {
    const d = rule("high", REPRO, verdict("verified", { base: { verdict: "fails", reason: "the named tests fail at the base abc too" } }));
    assert.equal(d.disposition, "dropped");
    assert.match(d.why, /not this change's/);
    assert.equal(d.cause, undefined);
  });

  it("a reproduction naming a test the baseline already has failing is dropped when the base verdict is unknown", () => {
    const unknownBase = verdict("verified", { base: { verdict: "unknown", reason: "the lockfile differs" } });
    const known = rule("high", REPRO, unknownBase, ["tests/repro.test.mjs > adds", "other.test.mjs > x"]);
    assert.equal(known.disposition, "dropped");
    assert.match(known.why, /baseline of known failures/);
    assert.equal(rule("high", REPRO, unknownBase, ["other.test.mjs > x"]).disposition, "blocks", "a baseline without the test changes nothing");
    assert.equal(rule("high", REPRO, unknownBase, undefined).disposition, "blocks", "no measured baseline changes nothing");
  });

  it("the next step: triage first, then resume for a blocker, then the change's flags, then approve", () => {
    const d = (disposition: "blocks" | "triage" | "dropped") => ({ disposition });
    assert.equal(nextOfFindings([d("blocks"), d("triage"), d("dropped")], false), "triage");
    assert.equal(nextOfFindings([d("blocks"), d("dropped")], true), "resume");
    assert.equal(nextOfFindings([d("dropped")], true), "inspect_flags");
    assert.equal(nextOfFindings([d("dropped")], false), "approve");
    assert.equal(nextOfFindings([], false), "approve");
  });
});

// ---------------------------------------------------------------------------
// The tool in the real child

const QUIET = "feedback:\n  enabled: false\ngate:\n  enabled: false\ndelegation:\n  spec_check: false\n";

type World = Awaited<ReturnType<typeof scriptedWorld>>;
let counter = 0;

async function drive(world: Pick<World, "workspace" | "ledgerPath" | "provider">, overrides: Partial<SessionRequest>): Promise<{ result: Record<string, unknown>; sessionId: string }> {
  const sessionId = `t235f-${process.pid}-${++counter}`;
  const request: SessionRequest = {
    version: PROTOCOL_VERSION,
    tool: "lykos_start",
    workspace: world.workspace,
    prompt: "review it",
    label: "review-both",
    containment: "off",
    model: SCRIPTED_MODEL,
    newSessionId: sessionId,
    specialist: "review-both",
    ...overrides,
  };
  const input = new PassThrough();
  const frames: Array<Record<string, unknown>> = [];
  input.write(encodeFrame(request));
  await runSessionChild({
    input,
    write: (text) => {
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        try {
          frames.push(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // not a frame
        }
      }
    },
    env: { LYKOS_TRUST_WORKSPACE: "1", LYKOS_TRUST_SOURCE: "flag" },
    trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t235f-store-")), "trust.json"),
    worktreesRoot: mkdtempSync(join(tmpdir(), "lykos-t235f-wt-")),
    runTask: (task) => runStandaloneTask(task),
    sessionExtras: { nativeProviders: [world.provider], ledgerPath: world.ledgerPath },
  });
  input.end();
  const last = frames.at(-1) as { type?: string; result?: Record<string, unknown> } | undefined;
  assert.equal(last?.type, "result", JSON.stringify(frames.slice(-3)));
  return { result: last!.result!, sessionId };
}

function seeing(into: Array<{ tool: string; text: string; isError: boolean }>, next: ScriptStep): ScriptStep {
  return (context: ModelContext) => {
    into.push(lastToolResult(context));
    return typeof next === "function" ? next(context) : next;
  };
}

describe("T235 ACCEPTANCE: the finding tool in a real review session", () => {
  it("a review records findings, each with its severity, basis and check, under its own session", { timeout: 120_000 }, async () => {
    const seen: Array<{ tool: string; text: string; isError: boolean }> = [];
    const world = await scriptedWorld({
      config: QUIET,
      files: { "a.txt": "one\n" },
      script: [
        reply(call("finding", { text: "add subtracts", severity: "high", basis: "src/math.mjs:1", check: REPRO })),
        seeing(seen, reply(call("finding", { text: "the name is vague", severity: "low", basis: "src/a.ts:3" }))),
        seeing(seen, reply(call("finding", { text: "   ", severity: "low", basis: "src/a.ts:3" }))),
        seeing(seen, reply(call("finding", { text: "bad check", severity: "medium", basis: "a:1", check: { kind: "command" } }))),
        seeing(seen, reply(say("reviewed"))),
      ],
    });
    const run = await drive(world, { review: true });
    world.check();
    assert.equal(world.unusedSteps(), 0);
    assert.match(seen[0]!.text, /Recorded finding \d+ \(high\)/);
    assert.equal(seen[0]!.isError, false);
    assert.match(seen[1]!.text, /Recorded finding \d+ \(low\)/);
    assert.match(seen[2]!.text, /`text` is empty/);
    assert.match(seen[2]!.text, /Nothing was recorded/);
    assert.match(seen[3]!.text, /check\.command/);
    const stored = withLedgerSync(world.ledgerPath, (ledger) => findingsOf(ledger, run.sessionId));
    assert.deepEqual(
      stored.map((f) => [f.text, f.severity, f.basis, f.check?.kind]),
      [
        ["add subtracts", "high", "src/math.mjs:1", "reproduction"],
        ["the name is vague", "low", "src/a.ts:3", undefined],
      ],
      "the two valid findings are recorded and the two refused ones are not",
    );
  });

  it("a session that is not a review has no finding tool", { timeout: 120_000 }, async () => {
    const world = await scriptedWorld({ config: QUIET, files: { "a.txt": "one\n" }, script: [reply(say("looked"))] });
    await drive(world, { specialist: "review", tool: "lykos_review", label: "lykos_review" });
    const wire = (world.sent[0]?.tools ?? []).map((t) => t.name);
    assert.ok(wire.length > 0);
    assert.ok(!wire.includes("finding"), `no finding on the wire: ${wire.join(", ")}`);
    assert.ok(wire.includes("claim"), "a reviewer outside `lykos review` still has the claim tool");
  });

  it("a review has the finding tool on the wire, read-only, and records claims separately from findings", { timeout: 120_000 }, async () => {
    const world = await scriptedWorld({ config: QUIET, files: { "a.txt": "one\n" }, script: [reply(say("looked"))] });
    await drive(world, { review: true });
    const wire = (world.sent[0]?.tools ?? []).map((t) => t.name);
    assert.ok(wire.includes("finding"), wire.join(", "));
    assert.ok(!wire.includes("edit") && !wire.includes("write"), `a review cannot edit: ${wire.join(", ")}`);
  });
});
