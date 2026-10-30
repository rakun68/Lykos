// The resume preflight.
//
// The task's acceptance is "every row above has a test that constructs the
// condition and asserts the verdict", plus the cost estimate asserted against
// `priceCall()` for one Anthropic model and one DeepSeek model in both of its
// price windows — because getting the cache-write asymmetry backwards is the
// single most likely error in this task.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { priceCall } from "../ledger/prices.js";
import { preflightResume, priceReplay, type ResumeCheck, type ResumeVerdict } from "./resume-preflight.js";
import { TranscriptWriter, writeSessionMeta, type SessionMeta } from "./transcript.js";

const OFF_PEAK = new Date("2026-08-29T12:00:00Z"); // Saturday-adjacent midday: outside every peak window
const PEAK = new Date("2026-08-31T02:00:00Z"); // Monday 02:00 UTC: inside 01:00-04:00

function realLedger(): { ledger: Ledger; ledgerPath: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t56-"));
  const ledgerPath = join(dir, "ledger.db");
  return { ledger: Ledger.open(ledgerPath), ledgerPath, dir };
}

/** A stream-captured, hash-verified, resumable session — the case every check should pass on. */
function seedHealthy(
  ledger: Ledger,
  ledgerPath: string,
  id = "s1",
  opts?: { model?: string; captureMode?: "stream" | "snapshot"; extraEvents?: () => void; meta?: Partial<SessionMeta> },
): void {
  const writer = new TranscriptWriter(ledgerPath, id);
  writer.append({ kind: "user_message", text: "make the parser handle empty input" });
  writer.append({ kind: "assistant_message", text: "done — added a guard", final: false });
  const fin = writer.finalize();
  ledger.startSession({
    id,
    brief: id,
    model: opts?.model ?? "deepseek/deepseek-v4-flash",
    captureMode: opts?.captureMode ?? "stream",
    startedUtc: "2026-09-01T00:00:00.000Z",
  });
  ledger.endSession({
    id,
    endedUtc: "2026-09-01T01:00:00.000Z",
    transcriptPath: fin.path,
    transcriptSha256: fin.sha256,
    transcriptBytes: fin.bytes,
  });
  writeSessionMeta(ledgerPath, {
    schemaVersion: 2,
    sessionId: id,
    taskId: null,
    projectId: null,
    parentSessionId: null,
    resumedFrom: null,
    agentRole: "worker",
    model: opts?.model ?? "deepseek/deepseek-v4-flash",
    cwd: "/work",
    startedUtc: "2026-09-01T00:00:00.000Z",
    captureMode: opts?.captureMode ?? "stream",
    ...opts?.meta,
  });
}

function check(checks: readonly ResumeCheck[], id: ResumeCheck["id"]): ResumeCheck {
  const found = checks.find((c) => c.id === id);
  assert.ok(found, `no ${id} check was produced`);
  return found;
}

function verdictOf(checks: readonly ResumeCheck[], id: ResumeCheck["id"]): ResumeVerdict {
  return check(checks, id).verdict;
}

describe("T56 resume preflight", () => {
  it("refuses an unknown session rather than reporting a clean bill of health", () => {
    const { ledger, dir } = realLedger();
    const pre = preflightResume({ ledger, sessionId: "nope", workspace: dir });
    assert.equal(pre.overall, "refuse");
    assert.equal(pre.checks[0]!.id, "session");
    ledger.close();
  });

  it("refuses a snapshot-captured session as a conversation, and says what to do instead", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedHealthy(ledger, ledgerPath, "snap", { captureMode: "snapshot" });
    const pre = preflightResume({ ledger, sessionId: "snap", workspace: dir });
    assert.equal(verdictOf(pre.checks, "capture_mode"), "refuse");
    assert.match(check(pre.checks, "capture_mode").message, /brief for a new session/);
    assert.equal(pre.overall, "refuse");
    ledger.close();
  });

  it("refuses a session that predates capture_mode — a NULL is not an optimistic yes", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedHealthy(ledger, ledgerPath, "old");
    ledger.db.prepare(`UPDATE sessions SET capture_mode = NULL WHERE id = 'old'`).run();
    const pre = preflightResume({ ledger, sessionId: "old", workspace: dir });
    assert.equal(verdictOf(pre.checks, "capture_mode"), "refuse");
    ledger.close();
  });

  it("refuses resumable = 0 and prints not_resumable_reason verbatim", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedHealthy(ledger, ledgerPath, "hop1");
    ledger.db
      .prepare(`UPDATE sessions SET resumable = 0, not_resumable_reason = 'MCP hop-1 aggregate' WHERE id = 'hop1'`)
      .run();
    const pre = preflightResume({ ledger, sessionId: "hop1", workspace: dir });
    assert.equal(verdictOf(pre.checks, "resumable"), "refuse");
    assert.equal(check(pre.checks, "resumable").message, "MCP hop-1 aggregate");
    ledger.close();
  });

  it("refuses a hash mismatch, and only WARNS on the honest NULL a crash leaves", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedHealthy(ledger, ledgerPath, "damaged");
    const path = (ledger.db.prepare(`SELECT transcript_path AS p FROM sessions WHERE id = 'damaged'`).get() as {
      p: string;
    }).p;
    writeFileSync(path, '{"kind":"user_message","text":"tampered"}\n', "utf8");
    const damaged = preflightResume({ ledger, sessionId: "damaged", workspace: dir });
    assert.equal(verdictOf(damaged.checks, "transcript_integrity"), "refuse");

    seedHealthy(ledger, ledgerPath, "crashed");
    ledger.db.prepare(`UPDATE sessions SET transcript_sha256 = NULL WHERE id = 'crashed'`).run();
    const crashed = preflightResume({ ledger, sessionId: "crashed", workspace: dir });
    // A crash is not damage. It is unverified, it is said out loud, and it
    // does not stop the resume.
    assert.equal(verdictOf(crashed.checks, "transcript_integrity"), "warn");
    ledger.close();
  });

  it("warns on a truncated last line rather than refusing — the earlier turns are still real", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    const writer = new TranscriptWriter(ledgerPath, "trunc");
    writer.append({ kind: "user_message", text: "hello" });
    const fin = writer.finalize();
    writeFileSync(fin.path, `${"{\"kind\":\"user_message\",\"ts_utc\":\"x\",\"turn_index\":0,\"text\":\"hello\"}\n"}{"kind":"assist`, "utf8");
    ledger.startSession({ id: "trunc", captureMode: "stream", model: "deepseek/deepseek-v4-flash" });
    ledger.endSession({ id: "trunc", transcriptPath: fin.path });
    writeSessionMeta(ledgerPath, {
      schemaVersion: 2,
      sessionId: "trunc",
      taskId: null,
      projectId: null,
      parentSessionId: null,
      resumedFrom: null,
      agentRole: "worker",
      model: "deepseek/deepseek-v4-flash",
      cwd: "/work",
      startedUtc: "2026-09-01T00:00:00.000Z",
      captureMode: "stream",
    });
    const pre = preflightResume({ ledger, sessionId: "trunc", workspace: dir });
    assert.equal(verdictOf(pre.checks, "transcript_integrity"), "warn");
    ledger.close();
  });

  it("asks for confirmation when the working tree has moved, and proceeds when it has not", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one"], {
      cwd: dir,
    });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    seedHealthy(ledger, ledgerPath, "same");
    ledger.db.prepare(`UPDATE sessions SET git_commit = ? WHERE id = 'same'`).run(head);
    assert.equal(verdictOf(preflightResume({ ledger, sessionId: "same", workspace: dir }).checks, "working_tree"), "proceed");

    seedHealthy(ledger, ledgerPath, "moved");
    // A fixed, obviously-different sha rather than a mutation of HEAD's
    // first character: HEAD starts with "a" one time in sixteen, and a test
    // that passes fifteen runs out of sixteen is worse than no test.
    ledger.db
      .prepare(`UPDATE sessions SET git_commit = '0000000000000000000000000000000000000000' WHERE id = 'moved'`)
      .run();
    assert.equal(verdictOf(preflightResume({ ledger, sessionId: "moved", workspace: dir }).checks, "working_tree"), "confirm");
    ledger.close();
  });

  it("refuses when a file the session edited is gone, unless explicitly overridden", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    const writer = new TranscriptWriter(ledgerPath, "gone");
    writer.append({ kind: "user_message", text: "edit it" });
    writer.append({ kind: "tool_call", name: "edit", state: "running", args: { path: "src/vanished.ts" } });
    const fin = writer.finalize();
    ledger.startSession({ id: "gone", captureMode: "stream", model: "deepseek/deepseek-v4-flash" });
    ledger.endSession({
      id: "gone",
      transcriptPath: fin.path,
      transcriptSha256: fin.sha256,
      transcriptBytes: fin.bytes,
    });
    assert.ok(!existsSync(join(dir, "src", "vanished.ts")));

    const refused = preflightResume({ ledger, sessionId: "gone", workspace: dir });
    const wt = refused.checks.filter((c) => c.id === "working_tree");
    assert.ok(wt.some((c) => c.verdict === "refuse"));
    assert.equal(refused.overall, "refuse");

    const forced = preflightResume({ ledger, sessionId: "gone", workspace: dir, allowMissingFiles: true });
    assert.ok(!forced.checks.some((c) => c.id === "working_tree" && c.verdict === "refuse"));
    ledger.close();
  });

  it("maps a container /work path onto the host workspace before calling the file missing (D8)", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "kept.ts"), "export const kept = 1;\n", "utf8");
    const writer = new TranscriptWriter(ledgerPath, "box");
    writer.append({ kind: "user_message", text: "edit it" });
    writer.append({ kind: "tool_call", name: "edit", state: "running", args: { path: "/work/src/kept.ts" } });
    writer.append({ kind: "tool_call", name: "edit", state: "running", args: { path: "/work/src/gone.ts" } });
    const fin = writer.finalize();
    ledger.startSession({ id: "box", captureMode: "stream", model: "deepseek/deepseek-v4-flash", runtime: "container" });
    ledger.endSession({
      id: "box",
      transcriptPath: fin.path,
      transcriptSha256: fin.sha256,
      transcriptBytes: fin.bytes,
    });

    const pre = preflightResume({ ledger, sessionId: "box", workspace: dir });
    const refused = pre.checks.find((c) => c.id === "working_tree" && c.verdict === "refuse");
    assert.ok(refused);
    assert.match(refused.message, /\/work\/src\/gone\.ts/);
    assert.doesNotMatch(refused.message, /kept\.ts/);
    ledger.close();
  });

  it("refuses a model that is gone, and never substitutes one silently", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedHealthy(ledger, ledgerPath, "m");
    const gone = preflightResume({ ledger, sessionId: "m", workspace: dir, modelAvailable: () => false });
    assert.equal(verdictOf(gone.checks, "model_availability"), "refuse");
    assert.match(check(gone.checks, "model_availability").message, /--model/);

    const there = preflightResume({ ledger, sessionId: "m", workspace: dir, modelAvailable: () => true });
    assert.equal(verdictOf(there.checks, "model_availability"), "proceed");

    // Not injected means NOT CHECKED, which is a warning, never "available".
    const unchecked = preflightResume({ ledger, sessionId: "m", workspace: dir });
    assert.equal(verdictOf(unchecked.checks, "model_availability"), "warn");
    ledger.close();
  });

  it("warns when prices moved, and says the original's rows keep their own version", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedHealthy(ledger, ledgerPath, "drift", { meta: { priceVersion: "1999-01-01" } });
    const pre = preflightResume({ ledger, sessionId: "drift", workspace: dir, now: OFF_PEAK });
    assert.equal(verdictOf(pre.checks, "price_drift"), "warn");
    assert.match(check(pre.checks, "price_drift").message, /nothing is recosted/);
    ledger.close();
  });

  it("runs no sandbox-image check, and a recorded image does not block the resume (#47)", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedHealthy(ledger, ledgerPath, "img", { meta: { sandboxImage: "lykos/delegate:0.1.0" } });
    const pre = preflightResume({ ledger, sessionId: "img", workspace: dir });
    assert.ok(!pre.checks.some((c) => (c.id as string) === "sandbox_image"));
    assert.equal(pre.meta?.sandboxImage, "lykos/delegate:0.1.0", "the recorded value is still read, never rewritten");
    ledger.close();
  });

  it("shows the rebuild cost as a confirm, never as a fait accompli", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedHealthy(ledger, ledgerPath, "cost");
    const pre = preflightResume({ ledger, sessionId: "cost", workspace: dir, now: OFF_PEAK });
    assert.equal(verdictOf(pre.checks, "rebuild_cost"), "confirm");
    assert.ok(pre.cost);
    assert.ok(pre.cost!.tokens > 0);
    assert.match(check(pre.checks, "rebuild_cost").message, /tokens/);
    ledger.close();
  });

  it("leaves the cost NULL rather than inventing one for a model that is not in the price table", () => {
    const { ledger, ledgerPath, dir } = realLedger();
    seedHealthy(ledger, ledgerPath, "unpriced", { model: "someprovider/somemodel" });
    const pre = preflightResume({ ledger, sessionId: "unpriced", workspace: dir, now: OFF_PEAK });
    assert.equal(pre.cost?.usd, null);
    assert.ok(pre.cost!.tokens > 0);
    ledger.close();
  });
});

describe("T56 priceReplay — the cache-write asymmetry, on the correct side", () => {
  const TOKENS = 94_200;

  it("prices an Anthropic replay at the cache-WRITE rate, because Anthropic charges a premium for it", () => {
    const got = priceReplay("anthropic", "claude-sonnet-5", TOKENS, OFF_PEAK);
    assert.equal(got.writeIsPremium, true);
    const expected = priceCall({
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: { input: 0, output: 0, cacheWrite: TOKENS },
      ts: OFF_PEAK,
    });
    assert.equal(got.usd, expected.costUsd);
    // And it is strictly MORE than plain input would be — that is what
    // "premium" means, and pricing it as input would understate the resume.
    const asInput = priceCall({
      provider: "anthropic",
      model: "claude-sonnet-5",
      tokens: { input: TOKENS, output: 0 },
      ts: OFF_PEAK,
    });
    assert.ok(got.usd! > asInput.costUsd);
  });

  it("prices a DeepSeek replay at the INPUT rate, because DeepSeek charges no write premium at all", () => {
    const got = priceReplay("deepseek", "deepseek-v4-flash", TOKENS, OFF_PEAK);
    assert.equal(got.writeIsPremium, false);
    const expected = priceCall({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      tokens: { input: TOKENS, output: 0 },
      ts: OFF_PEAK,
    });
    assert.equal(got.usd, expected.costUsd);
    // Pricing it at DeepSeek's cache_write rate (0.0) would have reported a
    // free resume, which is the exact error this asymmetry invites.
    assert.ok(got.usd! > 0);
  });

  it("records DeepSeek's peak window, and peak really is double off-peak", () => {
    const peak = priceReplay("deepseek", "deepseek-v4-flash", TOKENS, PEAK);
    const offPeak = priceReplay("deepseek", "deepseek-v4-flash", TOKENS, OFF_PEAK);
    assert.equal(peak.rateWindow, "peak");
    assert.equal(offPeak.rateWindow, "off_peak");
    assert.ok(Math.abs(peak.usd! - offPeak.usd! * 2) < 1e-9);
  });

  it("returns tokens with a NULL cost for an unknown provider — never an invented number", () => {
    const got = priceReplay("nosuch", "nosuch", TOKENS, OFF_PEAK);
    assert.equal(got.usd, null);
    assert.equal(got.tokens, TOKENS);
    assert.equal(got.priceVersion, null);
  });
});
