// T238: the session is on disk first. The boot row exists before anything runs, a tool call's start is on
// disk before the tool runs, a resume reports a call that never finished as outcome unknown, and a resumed
// run killed before its ingest leaves the recorded hash checkable.

import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ingestDelegateSnapshot, writeBootRow, type DelegateSnapshot, type IngestOpts } from "../ledger/ingest.js";
import { liveSnapshotPath, readLiveSnapshot } from "../ledger/live.js";
import { Ledger } from "../ledger/ledger.js";
import { LiveTranscriptRecorder, markCutOff, type EventSource } from "./live-capture.js";
import { buildReplay, INTERRUPTED_OUTCOME, interruptedToolCalls, type TranscriptRecord } from "./replay.js";
import { preflightResume } from "./resume-preflight.js";
import { readTranscript, transcriptDir, transcriptFilePath, TranscriptWriter } from "./transcript.js";

/** A stand-in for the agent's event stream: the test emits the events Pi would. */
function eventSource(): EventSource & { emit(event: unknown): void } {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    subscribe(listener) {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    emit(event) {
      for (const l of listeners) l(event);
    },
  };
}

function fixture(): { dir: string; ledgerPath: string; ledger: Ledger } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t238-"));
  const ledgerPath = join(dir, ".lykos", "ledger.db");
  return { dir, ledgerPath, ledger: Ledger.open(ledgerPath) };
}

function bootSnapshot(sessionId: string): DelegateSnapshot {
  return { sessionId, model: "deepseek/deepseek-v4-flash", specialist: "worker", modelPath: "deepseek/deepseek-v4-flash" };
}

function records(ledgerPath: string, sessionId: string): TranscriptRecord[] {
  return readTranscript(transcriptFilePath(ledgerPath, sessionId)).events as TranscriptRecord[];
}

describe("T238: tool calls are on disk before they run", () => {
  it("a session killed mid-tool shows the call as started, and resume shows it as outcome unknown", () => {
    const { dir, ledgerPath, ledger } = fixture();
    const id = "t238-killed-mid-tool";
    const recorder = new LiveTranscriptRecorder(ledgerPath, id);
    const source = eventSource();
    recorder.attach(source);
    writeBootRow(ledger, bootSnapshot(id), { workspace: dir, executionShape: "standalone", runtime: "host", liveTranscript: recorder, registryPath: join(dir, "projects.json") });
    recorder.userMessage("run the tests");
    source.emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "npm test" } });
    // Killed here: no tool_execution_end, no finalize, no ingest.

    const onDisk = records(ledgerPath, id);
    const start = onDisk.find((r) => r.kind === "tool_call");
    assert.equal(start?.kind === "tool_call" ? start.tool_call_id : undefined, "call_1", "the start is on disk with its id");

    const pre = preflightResume({ ledger, sessionId: id, workspace: dir });
    assert.notEqual(pre.overall, "refuse", JSON.stringify(pre.checks));
    assert.match(pre.replay?.text ?? "", new RegExp(`\\[tool result\\] bash \\(call_1\\): ${INTERRUPTED_OUTCOME}`));
    assert.deepEqual(pre.recovery?.interrupted, ["call_1"]);
    assert.match(pre.replay?.text ?? "", /\[recovery\] the earlier session never finished tool call\(s\) call_1/);
    ledger.close();
  });

  it("two parallel tool calls cut off together are both reported with their own ids", () => {
    const { ledgerPath } = fixture();
    const id = "t238-parallel";
    const recorder = new LiveTranscriptRecorder(ledgerPath, id);
    const source = eventSource();
    recorder.attach(source);
    // Identical name and arguments: before T238 the second was buffered into the first as a repeat.
    source.emit({ type: "tool_execution_start", toolCallId: "call_a", toolName: "read", args: { path: "a.ts" } });
    source.emit({ type: "tool_execution_start", toolCallId: "call_b", toolName: "read", args: { path: "a.ts" } });

    const recs = records(ledgerPath, id);
    assert.deepEqual(interruptedToolCalls(recs), [
      { id: "call_a", name: "read" },
      { id: "call_b", name: "read" },
    ]);
    const text = buildReplay(id, recs).text;
    assert.match(text, /read \(call_a\): interrupted: outcome unknown/);
    assert.match(text, /read \(call_b\): interrupted: outcome unknown/);
  });

  it("a call that finished is not reported as interrupted", () => {
    const { ledgerPath } = fixture();
    const id = "t238-finished";
    const recorder = new LiveTranscriptRecorder(ledgerPath, id);
    const source = eventSource();
    recorder.attach(source);
    source.emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "ls" } });
    source.emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: "a.ts", isError: false });
    assert.deepEqual(interruptedToolCalls(records(ledgerPath, id)), []);
  });

  it("a call the parent-gone abort cuts off keeps no result: its abort error is not its outcome", () => {
    const { ledgerPath } = fixture();
    const id = "t238-cut-off";
    const recorder = new LiveTranscriptRecorder(ledgerPath, id);
    const session = {};
    recorder.watchCutOff(session);
    const source = eventSource();
    recorder.attach(source);
    source.emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "bash", args: { command: "npm run slow-check" } });
    markCutOff(session);
    source.emit({ type: "tool_execution_end", toolCallId: "call_1", toolName: "bash", result: "Command aborted", isError: true });
    const recs = records(ledgerPath, id);
    assert.deepEqual(interruptedToolCalls(recs), [{ id: "call_1", name: "bash" }]);
    assert.match(buildReplay(id, recs).text, /bash \(call_1\): interrupted: outcome unknown/);
    assert.doesNotMatch(buildReplay(id, recs).text, /Command aborted/);
  });
});

describe("T238: the boot row", () => {
  it("a session killed before its first ingest is resumable and shows usage unknown", () => {
    const { dir, ledgerPath, ledger } = fixture();
    const id = "t238-no-ingest";
    const recorder = new LiveTranscriptRecorder(ledgerPath, id);
    writeBootRow(ledger, bootSnapshot(id), { workspace: dir, executionShape: "standalone", runtime: "host", liveTranscript: recorder, registryPath: join(dir, "projects.json") });
    recorder.userMessage("hello");

    const row = ledger.db
      .prepare(`SELECT model, specialist, model_path, execution_shape, capture_mode, boot_row, total_cost_usd FROM sessions WHERE id = ?`)
      .get(id) as Record<string, unknown>;
    assert.deepEqual(row, {
      model: "deepseek-v4-flash",
      specialist: "worker",
      model_path: "deepseek/deepseek-v4-flash",
      execution_shape: "standalone",
      capture_mode: "stream",
      boot_row: 1,
      total_cost_usd: null,
    });
    assert.equal(ledger.callTotals(id).n, 0);
    assert.equal(readLiveSnapshot(ledgerPath, id)?.totals.costUsd, null, "live.json: usage unknown, never $0");

    const pre = preflightResume({ ledger, sessionId: id, workspace: dir });
    assert.notEqual(pre.overall, "refuse", JSON.stringify(pre.checks));
    assert.ok(pre.recovery, "the run did not end, so the resume carries a recovery note");
    ledger.close();
  });

  it("ingest finalises the boot row on the same task, and clears it", () => {
    const { dir, ledgerPath, ledger } = fixture();
    const id = "t238-finalised";
    const recorder = new LiveTranscriptRecorder(ledgerPath, id);
    const opts: IngestOpts = {
      workspace: dir,
      executionShape: "standalone",
      runtime: "host",
      liveTranscript: recorder,
      registryPath: join(dir, "projects.json"),
    };
    writeBootRow(ledger, bootSnapshot(id), opts);
    const boot = ledger.db.prepare(`SELECT task_id FROM sessions WHERE id = ?`).get(id) as { task_id: string | null };
    const tasksBefore = (ledger.db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;

    ingestDelegateSnapshot(
      ledger,
      {
        ...bootSnapshot(id),
        label: "named at the end",
        state: "done",
        finishedAt: new Date().toISOString(),
        usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, nestedBasis: "none" },
      },
      opts,
    );
    const row = ledger.db.prepare(`SELECT task_id, brief, boot_row FROM sessions WHERE id = ?`).get(id) as Record<string, unknown>;
    assert.deepEqual(row, { task_id: boot.task_id, brief: "named at the end", boot_row: null });
    assert.equal((ledger.db.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n, tasksBefore, "no second task");
    assert.equal(ledger.callTotals(id).n, 1);
    ledger.close();
  });

  it("a row that already exists is never overwritten by a boot row", () => {
    const { ledger } = fixture();
    const id = ledger.startSession({ brief: "the original" });
    writeBootRow(ledger, { ...bootSnapshot(id), label: "a boot row" });
    const row = ledger.db.prepare(`SELECT brief, boot_row FROM sessions WHERE id = ?`).get(id) as Record<string, unknown>;
    assert.deepEqual(row, { brief: "the original", boot_row: null });
    ledger.close();
  });
});

describe("T238: reopening a transcript", () => {
  it("drops a partial trailing record and continues the turn index and the artifact numbering", () => {
    const { ledgerPath } = fixture();
    const id = "t238-reopen";
    const big = "x".repeat(20_000);
    const first = new TranscriptWriter(ledgerPath, id);
    first.append({ kind: "tool_call", name: "read", state: "ok", tool_call_id: "c1", result: big });
    appendFileSync(transcriptFilePath(ledgerPath, id), '{"ts_utc":"2026-11-06T00:00:00Z","kind":"assis');

    const second = new TranscriptWriter(ledgerPath, id);
    second.append({ kind: "tool_call", name: "read", state: "ok", tool_call_id: "c2", result: big });
    const read = readTranscript(transcriptFilePath(ledgerPath, id));
    assert.equal(read.truncated, false, "the partial record is gone");
    assert.deepEqual(read.events.map((e) => e.turn_index), [0, 1]);
    const artifacts = readdirSync(join(transcriptDir(ledgerPath, id), "artifacts")).sort();
    assert.deepEqual(artifacts, ["0001-read.json", "0002-read.json"], "the second spill did not overwrite the first");
  });
});

describe("T238: kill, resume, kill, resume", () => {
  it("keeps resume's hash check valid, and still refuses a transcript changed inside its hashed part", () => {
    const { dir, ledgerPath, ledger } = fixture();
    const id = "t238-chain";
    const path = transcriptFilePath(ledgerPath, id);

    // Run 1 ends normally: the row records the transcript's hash and size.
    const run1 = new TranscriptWriter(ledgerPath, id);
    writeBootRow(ledger, bootSnapshot(id), { workspace: dir, executionShape: "standalone", runtime: "host", liveTranscript: new LiveTranscriptRecorder(ledgerPath, id), registryPath: join(dir, "projects.json") });
    run1.append({ kind: "user_message", text: "first" });
    const fin = run1.finalize();
    ledger.db
      .prepare(`UPDATE sessions SET transcript_sha256 = ?, transcript_bytes = ?, ended_utc = ?, boot_row = NULL WHERE id = ?`)
      .run(fin.sha256, fin.bytes, new Date().toISOString(), id);
    assert.equal(preflightResume({ ledger, sessionId: id, workspace: dir }).checks.find((c) => c.id === "transcript_integrity")?.verdict, "proceed");

    for (const n of [2, 3]) {
      // Resume: the same transcript is reopened, and the run is killed mid-write before its ingest.
      ledger.reopenSession(id);
      const resumed = new TranscriptWriter(ledgerPath, id);
      resumed.append({ kind: "user_message", text: `resume ${n}` });
      appendFileSync(path, '{"kind":"tool_c');
      const pre = preflightResume({ ledger, sessionId: id, workspace: dir });
      const integrity = pre.checks.find((c) => c.id === "transcript_integrity");
      assert.equal(integrity?.verdict, "warn", `resume ${n}: ${integrity?.message}`);
      assert.match(integrity?.message ?? "", new RegExp(`first ${fin.bytes} bytes match`));
      assert.notEqual(pre.overall, "refuse");
    }

    // A change inside the hashed part is still refused.
    const bytes = readFileSync(path);
    bytes[2] = bytes[2] === 0x61 ? 0x62 : 0x61;
    writeFileSync(path, bytes);
    const tampered = preflightResume({ ledger, sessionId: id, workspace: dir });
    assert.equal(tampered.checks.find((c) => c.id === "transcript_integrity")?.verdict, "refuse");
    ledger.close();
  });
});

describe("T238: live.json carries the turn count", () => {
  it("is written at each turn end and kept across a ledger refresh", () => {
    const { dir, ledgerPath, ledger } = fixture();
    const id = "t238-turns";
    const recorder = new LiveTranscriptRecorder(ledgerPath, id);
    const source = eventSource();
    recorder.attach(source);
    writeBootRow(ledger, bootSnapshot(id), { workspace: dir, executionShape: "standalone", runtime: "host", liveTranscript: recorder, registryPath: join(dir, "projects.json") });
    assert.ok(existsSync(liveSnapshotPath(ledgerPath, id)));
    source.emit({ type: "turn_end" });
    source.emit({ type: "turn_end" });
    assert.equal(readLiveSnapshot(ledgerPath, id)?.turns, 2);

    ingestDelegateSnapshot(
      ledger,
      { ...bootSnapshot(id), state: "done", finishedAt: new Date().toISOString(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, nestedBasis: "none" } },
      { workspace: dir, executionShape: "standalone", runtime: "host", liveTranscript: recorder, registryPath: join(dir, "projects.json") },
    );
    const live = readLiveSnapshot(ledgerPath, id);
    assert.equal(live?.turns, 2, "the refresh after ingest kept it");
    assert.equal(typeof live?.totals.costUsd, "number", "usage is known once a call is recorded");
    ledger.close();
  });
});
