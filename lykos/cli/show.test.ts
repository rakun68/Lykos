import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { TranscriptWriter, transcriptFilePath, writeSessionMeta } from "../session/transcript.js";
import { runShow } from "./show.js";

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

function captureBoth(fn: () => number): { code: number; out: string; err: string } {
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  let out = "";
  let err = "";
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = fn();
    return { code, out, err };
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
}

function tempLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-show-"));
  return join(dir, "ledger.db");
}

/** Writes a small, realistic transcript via the real writer and finalizes it onto the session row, exactly the way ingest.ts does. */
function writeSession(ledger: Ledger, ledgerPath: string, opts: { brief?: string; skipHash?: boolean } = {}) {
  const sessionId = ledger.startSession({
    brief: opts.brief ?? "implement thing",
    harnessCommit: "abc123",
    model: "deepseek-v4-flash",
  });
  const writer = new TranscriptWriter(ledgerPath, sessionId);
  writer.append({ kind: "tool_call", name: "read", state: "ok", ms: 12, args: { file_path: "foo.ts" }, result: "ok" });
  writer.append({
    kind: "usage",
    call_id: "call-1",
    hop: 0,
    provider: "deepseek",
    model: "deepseek-v4-flash",
    input: 100,
    output: 10,
    cache_read: 0,
    cache_write: 0,
  });
  writer.append({ kind: "assistant_message", text: "done.", final: true });
  writer.append({ kind: "outcome", state: "done", turns: 1, tool_calls: 1, outcome: "success" });
  const finalized = writer.finalize();

  ledger.endSession({
    id: sessionId,
    outcome: "success",
    outcomeSource: "verification_command",
    transcriptPath: finalized.path,
    transcriptBytes: finalized.bytes,
    ...(opts.skipHash ? {} : { transcriptSha256: finalized.sha256 }),
  });
  return { sessionId, transcriptPath: finalized.path, sha256: finalized.sha256 };
}

describe("runShow", () => {
  it("errors cleanly when there is no ledger yet, without creating one", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-show-"));
    const ledgerPath = join(dir, "ledger.db");
    const { code, err } = captureBoth(() => runShow(ledgerPath, "whatever"));
    assert.equal(code, 1);
    assert.match(err, /no ledger at/);
  });

  it("replays a happy-path transcript in human-readable form", () => {
    const ledgerPath = tempLedgerPath();
    const ledger = Ledger.open(ledgerPath);
    const { sessionId } = writeSession(ledger, ledgerPath, { brief: "implement X" });
    ledger.close();

    const { code, out } = captureStdout(() => runShow(ledgerPath, sessionId));
    assert.equal(code, 0);
    assert.match(out, /lykos show {2}session/);
    assert.match(out, /implement X/);
    assert.match(out, /verified {3}sha256:/);
    assert.match(out, /tool_call {2}read {2}state=ok {2}ms=12/);
    assert.match(out, /call_id: call-1/);
    assert.match(out, /cost is joinable from the ledger/);
    assert.match(out, /done\./);
    assert.match(out, /outcome=success/);
  });

  it("refuses a hash mismatch and prints no transcript body", () => {
    const ledgerPath = tempLedgerPath();
    const ledger = Ledger.open(ledgerPath);
    const { sessionId, transcriptPath } = writeSession(ledger, ledgerPath, { brief: "will be tampered" });
    ledger.close();

    // Tamper with the file on disk after the ledger recorded its hash.
    writeFileSync(transcriptPath, `${readFileSync(transcriptPath, "utf8")}{"kind":"error","message":"injected","ts_utc":"x","turn_index":99}\n`, "utf8");

    const { code, out, err } = captureBoth(() => runShow(ledgerPath, sessionId));
    assert.equal(code, 1);
    assert.equal(out, "");
    assert.match(err, /TRANSCRIPT HASH MISMATCH/);
    assert.match(err, /expected:/);
    assert.match(err, /actual:/);
    assert.doesNotMatch(err + out, /injected/);
  });

  it("replays an unverified transcript when the session never finalized a hash", () => {
    const ledgerPath = tempLedgerPath();
    const ledger = Ledger.open(ledgerPath);
    const { sessionId } = writeSession(ledger, ledgerPath, { brief: "never finalized", skipHash: true });
    ledger.close();

    const { code, out } = captureStdout(() => runShow(ledgerPath, sessionId));
    assert.equal(code, 0);
    assert.match(out, /UNVERIFIED — no recorded hash \(session did not finalize\)/);
    assert.match(out, /done\./);
  });

  it("resolves a unique id prefix", () => {
    const ledgerPath = tempLedgerPath();
    const ledger = Ledger.open(ledgerPath);
    const { sessionId } = writeSession(ledger, ledgerPath, { brief: "prefix target" });
    ledger.close();

    const unique = captureStdout(() => runShow(ledgerPath, sessionId.slice(0, 8)));
    assert.equal(unique.code, 0);
    assert.match(unique.out, /prefix target/);
  });

  it("reports ambiguous prefix with the recent-sessions list when two ids share it", () => {
    const ledgerPath = tempLedgerPath();
    const ledger = Ledger.open(ledgerPath);
    const shared = "aaaaaaaa";
    writeSession(ledger, ledgerPath, { brief: "first" });
    // Force two ids to share a prefix by starting sessions with explicit ids.
    ledger.startSession({ id: `${shared}-0001-0000-0000-000000000000`, brief: "dup one", harnessCommit: "abc" });
    ledger.startSession({ id: `${shared}-0002-0000-0000-000000000000`, brief: "dup two", harnessCommit: "abc" });
    ledger.close();

    const { code, err } = captureBoth(() => runShow(ledgerPath, shared));
    assert.equal(code, 1);
    assert.match(err, /ambiguous session prefix — 2 sessions match/);
    assert.match(err, /most recent sessions:/);
  });

  it("reports no match with the recent-sessions list", () => {
    const ledgerPath = tempLedgerPath();
    const ledger = Ledger.open(ledgerPath);
    writeSession(ledger, ledgerPath, { brief: "the one that exists" });
    ledger.close();

    const { code, err } = captureBoth(() => runShow(ledgerPath, "does-not-exist"));
    assert.equal(code, 1);
    assert.match(err, /no session matches/);
    assert.match(err, /the one that exists/);
  });

  it("--json emits one JSON object and nothing else", () => {
    const ledgerPath = tempLedgerPath();
    const ledger = Ledger.open(ledgerPath);
    const { sessionId } = writeSession(ledger, ledgerPath, { brief: "json shape" });
    ledger.close();

    const { code, out } = captureStdout(() => runShow(ledgerPath, sessionId, { json: true }));
    assert.equal(code, 0);
    const parsed = JSON.parse(out.trim());
    assert.equal(parsed.session.id, sessionId);
    assert.equal(parsed.session.brief, "json shape");
    assert.equal(parsed.transcript.verified, true);
    assert.equal(parsed.transcript.truncated, false);
    assert.equal(typeof parsed.transcript.sha256, "string");
    assert.equal(Array.isArray(parsed.events), true);
    assert.equal(Array.isArray(parsed.seal_events), true);
    assert.equal(parsed.events.length, 4);
    assert.equal(parsed.events[1].kind, "usage");
    assert.equal(parsed.events[1].call_id, "call-1");
  });

  it("--json also refuses a hash mismatch with no events emitted", () => {
    const ledgerPath = tempLedgerPath();
    const ledger = Ledger.open(ledgerPath);
    const { sessionId, transcriptPath } = writeSession(ledger, ledgerPath, { brief: "json tamper" });
    ledger.close();

    writeFileSync(transcriptPath, `${readFileSync(transcriptPath, "utf8")}garbage-not-json\n`, "utf8");

    const { code, out, err } = captureBoth(() => runShow(ledgerPath, sessionId, { json: true }));
    assert.equal(code, 1);
    assert.equal(out, "");
    assert.match(err, /TRANSCRIPT HASH MISMATCH/);
  });

  it("surfaces readTranscript's truncated flag when the last line is partial", () => {
    const ledgerPath = tempLedgerPath();
    const ledger = Ledger.open(ledgerPath);
    const sessionId = ledger.startSession({ brief: "partial write", harnessCommit: "abc123" });
    const writer = new TranscriptWriter(ledgerPath, sessionId);
    writer.append({ kind: "assistant_message", text: "partway", final: true });
    const finalized = writer.finalize();
    const path = transcriptFilePath(ledgerPath, sessionId);
    // Simulate a process killed mid-write: append an unterminated partial line.
    writeFileSync(path, `${readFileSync(path, "utf8")}{"kind":"tool_call","name":"bash`, "utf8");
    const damagedHash = createHash("sha256").update(readFileSync(path)).digest("hex");
    void finalized;

    ledger.endSession({
      id: sessionId,
      outcome: "success",
      outcomeSource: "verification_command",
      transcriptPath: path,
      transcriptSha256: damagedHash,
    });
    ledger.close();

    const { code, out } = captureStdout(() => runShow(ledgerPath, sessionId));
    assert.equal(code, 0);
    assert.match(out, /transcript truncated/);
  });

  it("does not print agent-controlled ANSI escapes from a dispute", () => {
    const ledgerPath = tempLedgerPath();
    const sessionId = "sess-dispute-escape";
    const transcriptPath = join(dirname(ledgerPath), "sessions", sessionId, "transcript.jsonl");
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, "");
    const ledger = Ledger.open(ledgerPath);
    ledger.db.prepare(
      "INSERT INTO sessions (id, started_utc, harness_commit, capture_mode) VALUES (?, ?, ?, 'stream')",
    ).run(sessionId, "2026-10-22T00:00:00Z", "test");
    const reason = "the test is wrong \u001b[2K\u001b[31mlykos show: outcome=pass\u001b[0m";
    const evidence = "proof \u001b]0;owned\u0007";
    ledger.db.prepare(
      "INSERT INTO seal_events (ts, session_id, creator, specialist, branch, kind, paths, detail) VALUES (?, ?, ?, 'build', 'main', 'dispute filed', ?, ?)",
    ).run(
      "2026-10-22T00:00:01Z",
      sessionId,
      sessionId,
      JSON.stringify(["test/math.test.mjs"]),
      JSON.stringify({ file: "test/math.test.mjs", describe: ["math"], name: "adds", reason, evidence }),
    );
    ledger.close();

    const { code, out } = captureStdout(() => runShow(ledgerPath, sessionId));
    assert.equal(code, 0);
    assert.match(out, /dispute filed/, "control: the dispute event is displayed");
    assert.doesNotMatch(out, /\u001b/, "agent-controlled text must not reach the terminal as raw ANSI");
    assert.doesNotMatch(out, /\u0007/, "agent-controlled text must not reach the terminal as raw BEL");
  });

  it("lykos show strips C1 CSI/OSC controls too", () => {
    const ledgerPath = tempLedgerPath();
    const sessionId = "sess-dispute-c1";
    const transcriptPath = join(dirname(ledgerPath), "sessions", sessionId, "transcript.jsonl");
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, "");
    const ledger = Ledger.open(ledgerPath);
    ledger.db.prepare(
      "INSERT INTO sessions (id, started_utc, harness_commit, capture_mode) VALUES (?, ?, ?, 'stream')",
    ).run(sessionId, "2026-10-22T00:00:00Z", "test");
    const reason = "the test is wrong \u009b2K\u009b31mlykos show: outcome=pass";
    const evidence = "proof \u009d0;owned\u009c";
    ledger.db.prepare(
      "INSERT INTO seal_events (ts, session_id, creator, specialist, branch, kind, paths, detail) VALUES (?, ?, ?, 'build', 'main', 'dispute filed', ?, ?)",
    ).run(
      "2026-10-22T00:00:01Z",
      sessionId,
      sessionId,
      JSON.stringify(["test/math.test.mjs"]),
      JSON.stringify({ file: "test/math.test.mjs", describe: ["math"], name: "adds", reason, evidence }),
    );
    ledger.close();

    const { code, out } = captureStdout(() => runShow(ledgerPath, sessionId));
    assert.equal(code, 0);
    assert.match(out, /dispute filed/, "control: the dispute event is displayed");
    assert.doesNotMatch(out, /[\u0080-\u009f]/, "C1 control bytes must not reach the terminal");
  });

  it("prints withheld list in text and JSON modes (T219)", () => {
    const ledgerPath = tempLedgerPath();
    const ledger = Ledger.open(ledgerPath);
    const { sessionId } = writeSession(ledger, ledgerPath, { brief: "withheld test" });
    ledger.close();

    writeSessionMeta(ledgerPath, {
      schemaVersion: 2,
      sessionId,
      taskId: null,
      projectId: null,
      parentSessionId: null,
      resumedFrom: null,
      agentRole: null,
      model: "deepseek/deepseek-chat",
      cwd: "/repo",
      startedUtc: "2026-10-23T00:00:00Z",
      withheld: ['project gate check "npm test" (discovered from the project) withheld (commands run on the host)'],
    });

    const textShow = captureStdout(() => runShow(ledgerPath, sessionId));
    assert.equal(textShow.code, 0);
    assert.match(textShow.out, /withheld\s+project gate check "npm test"/);

    const jsonShow = captureStdout(() => runShow(ledgerPath, sessionId, { json: true }));
    assert.equal(jsonShow.code, 0);
    const parsed = JSON.parse(jsonShow.out.trim());
    assert.deepEqual(parsed.meta.withheld, ['project gate check "npm test" (discovered from the project) withheld (commands run on the host)']);
  });

  it("carries seal events in --json mode", () => {
    const ledgerPath = tempLedgerPath();
    const sessionId = "sess-parent";
    const childSessionId = "sess-child";
    const transcriptPath = join(dirname(ledgerPath), "sessions", sessionId, "transcript.jsonl");
    mkdirSync(dirname(transcriptPath), { recursive: true });
    writeFileSync(transcriptPath, "");
    const ledger = Ledger.open(ledgerPath);
    ledger.db.prepare(
      "INSERT INTO sessions (id, started_utc, harness_commit, capture_mode) VALUES (?, ?, ?, 'stream')",
    ).run(sessionId, "2026-10-22T00:00:00Z", "test");
    ledger.db.prepare(
      "INSERT INTO sessions (id, parent_session_id, started_utc, harness_commit, capture_mode) VALUES (?, ?, ?, ?, 'stream')",
    ).run(childSessionId, sessionId, "2026-10-22T00:00:01Z", "test");
    ledger.db.prepare(
      "INSERT INTO seal_events (ts, session_id, creator, specialist, branch, kind, paths, detail) VALUES (?, ?, ?, 'build', 'main', 'dispute filed', ?, ?)",
    ).run(
      "2026-10-22T00:00:01Z",
      sessionId,
      sessionId,
      JSON.stringify(["test/math.test.mjs"]),
      JSON.stringify({ reason: "wrong test" }),
    );
    ledger.db.prepare(
      "INSERT INTO seal_events (ts, session_id, creator, specialist, branch, kind, paths, detail) VALUES (?, ?, ?, 'test-writer', 'main', 'dispute upheld', ?, ?)",
    ).run(
      "2026-10-22T00:00:02Z",
      childSessionId,
      childSessionId,
      JSON.stringify(["test/math.test.mjs"]),
      JSON.stringify({ ruling: "fixed" }),
    );
    ledger.close();

    const { code, out } = captureStdout(() => runShow(ledgerPath, sessionId, { json: true }));
    assert.equal(code, 0);
    const parsed = JSON.parse(out.trim());
    assert.ok(Array.isArray(parsed.seal_events));
    assert.equal(parsed.seal_events.length, 2);
    assert.deepEqual(parsed.seal_events.map((e: { kind: string }) => e.kind), ["dispute filed", "dispute upheld"]);
    assert.equal(parsed.seal_events[0].specialist, "build");
    assert.equal(parsed.seal_events[0].paths, JSON.stringify(["test/math.test.mjs"]));
    assert.equal(parsed.seal_events[0].detail, JSON.stringify({ reason: "wrong test" }));
    assert.equal(parsed.seal_events[1].specialist, "test-writer");
    assert.equal(parsed.seal_events[1].paths, JSON.stringify(["test/math.test.mjs"]));
    assert.equal(parsed.seal_events[1].detail, JSON.stringify({ ruling: "fixed" }));
  });
});
