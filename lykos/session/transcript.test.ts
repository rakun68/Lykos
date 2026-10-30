import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  TranscriptWriter,
  metaFilePath,
  readSessionMeta,
  readTranscript,
  transcriptDir,
  transcriptFilePath,
  verifyTranscriptHash,
  writeSessionMeta,
} from "./transcript.js";

function fakeLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-transcript-"));
  return join(dir, "ledger.db");
}

describe("TranscriptWriter", () => {
  it("writes one parseable JSON line per event and hashes the finished file", () => {
    const ledgerPath = fakeLedgerPath();
    const writer = new TranscriptWriter(ledgerPath, "sess-1");
    writer.append({ kind: "tool_call", name: "read", state: "ok", args: { path: "a.ts" } });
    writer.append({
      kind: "usage",
      call_id: "call-1",
      hop: 0,
      provider: "deepseek",
      model: "deepseek-v4-flash",
      input: 10,
      output: 2,
      cache_read: 0,
      cache_write: 0,
    });
    writer.append({ kind: "outcome", outcome: "success", turns: 1, tool_calls: 1 });
    const { path, sha256, bytes } = writer.finalize();

    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));

    const { events, truncated } = readTranscript(path);
    assert.equal(truncated, false);
    assert.equal(events.length, 3);
    assert.equal(events[0]!.kind, "tool_call");
    assert.equal(events[0]!.turn_index, 0);
    assert.equal(events[1]!.kind, "usage");
    assert.equal(events[1]!.turn_index, 1);
    assert.equal(events[2]!.kind, "outcome");
    assert.equal(events[2]!.turn_index, 2);
    for (const e of events) assert.ok(typeof e.ts_utc === "string" && e.ts_utc.length > 0);

    assert.equal(bytes, Buffer.byteLength(raw, "utf8"));
    assert.equal(verifyTranscriptHash(path, sha256), true);
    assert.equal(verifyTranscriptHash(path, "0".repeat(64)), false);
  });

  it("redacts a planted secret in tool_call args/result before it ever touches disk", () => {
    const ledgerPath = fakeLedgerPath();
    const writer = new TranscriptWriter(ledgerPath, "sess-secret");
    writer.append({
      kind: "tool_call",
      name: "bash",
      state: "ok",
      args: { command: "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuv' https://example.com" },
      result: "token=sk-ant-api03-abcdefghijklmnopqrstuv ok",
    });
    const { path } = writer.finalize();
    const raw = readFileSync(path, "utf8");
    assert.equal(raw.includes("sk-ant-api03-abcdefghijklmnopqrstuv"), false);
    assert.ok(raw.includes("[REDACTED]"));
  });

  it("collapses consecutive identical tool_call events into one line with a repeat_count (T9.4)", () => {
    const ledgerPath = fakeLedgerPath();
    const writer = new TranscriptWriter(ledgerPath, "sess-repeat");
    for (let i = 0; i < 50; i++) {
      writer.append({ kind: "tool_call", name: "read", state: "ok", args: { path: "same.ts" } });
    }
    writer.append({ kind: "tool_call", name: "read", state: "ok", args: { path: "different.ts" } });
    const { path } = writer.finalize();
    const { events } = readTranscript(path);
    assert.equal(events.length, 2);
    const first = events[0] as unknown as { repeat_count?: number; args: { path: string } };
    assert.equal(first.repeat_count, 50);
    assert.equal(first.args.path, "same.ts");
    const second = events[1] as unknown as { repeat_count?: number; args: { path: string } };
    assert.equal(second.repeat_count, undefined);
    assert.equal(second.args.path, "different.ts");
  });

  it("spills an oversized tool_call result to artifacts/ and records the pre-truncation size (T9.4)", () => {
    const ledgerPath = fakeLedgerPath();
    const writer = new TranscriptWriter(ledgerPath, "sess-big");
    const huge = "x".repeat(20_000);
    writer.append({ kind: "tool_call", name: "bash", state: "ok", args: { command: "cat big.txt" }, result: huge });
    const { path } = writer.finalize();
    const { events } = readTranscript(path);
    const event = events[0] as unknown as {
      args?: unknown;
      result: { truncated: boolean; bytes: number; artifact: string };
    };
    assert.equal(event.args, undefined);
    assert.equal(event.result.truncated, true);
    assert.ok(event.result.bytes > 20_000);

    const artifactPath = join(transcriptDir(ledgerPath, "sess-big"), event.result.artifact);
    assert.ok(existsSync(artifactPath));
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as { args: unknown; result: string };
    assert.equal(artifact.result, huge);
    assert.deepEqual(artifact.args, { command: "cat big.txt" });
  });

  it("writes and reads back meta.json", () => {
    const ledgerPath = fakeLedgerPath();
    writeSessionMeta(ledgerPath, {
      schemaVersion: 1,
      sessionId: "sess-meta",
      taskId: "task-1",
      projectId: "proj-1",
      parentSessionId: null,
      resumedFrom: null,
      agentRole: "worker",
      model: "deepseek-v4-flash",
      cwd: "/work",
      startedUtc: "2026-08-29T00:00:00.000Z",
    });
    const meta = JSON.parse(readFileSync(metaFilePath(ledgerPath, "sess-meta"), "utf8")) as { taskId: string };
    assert.equal(meta.taskId, "task-1");
  });
});

describe("readTranscript", () => {
  it("parses every complete line and reports a partial trailing line without throwing (kill-mid-write)", () => {
    const ledgerPath = fakeLedgerPath();
    const dir = transcriptDir(ledgerPath, "sess-killed");
    const path = transcriptFilePath(ledgerPath, "sess-killed");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ kind: "outcome", ts_utc: "2026-08-29T00:00:00.000Z", turn_index: 0, outcome: "success" })}\n` +
        `{"kind":"tool_call","ts_utc":"2026-08-29T00:00:01.000Z","turn_index":1,"name":"read","state":"run`, // deliberately cut off mid-write
      "utf8",
    );
    const { events, truncated } = readTranscript(path);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "outcome");
    assert.equal(truncated, true);
    assert.ok(readdirSync(dir).includes("transcript.jsonl"));
  });
});

describe("T54 meta.json v2: the resume contract", () => {
  it("round-trips a v2 file, and reads a v1 one without inventing the fields it lacks", () => {
    const ledgerPath = fakeLedgerPath();
    writeSessionMeta(ledgerPath, {
      schemaVersion: 2,
      sessionId: "v2",
      taskId: "task-1",
      projectId: "proj-1",
      parentSessionId: null,
      resumedFrom: null,
      agentRole: "worker",
      model: "deepseek/deepseek-v4-flash",
      cwd: "/work",
      startedUtc: "2026-09-03T00:00:00.000Z",
      captureMode: "stream",
      modelSource: "config_default",
      priceBasis: "api_list",
      priceVersion: "2026-08-28",
      effort: "medium",
      specialist: "budget",
      head: { bootFingerprint: "abc123", contextFiles: [{ name: "AGENTS.md", bytes: 42 }] },
      tools: { active: ["read", "bash"], extensions: [] },
      flags: { headContract: true, promptDiet: true, outputDiet: false },
      git: { commit: "deadbeef", dirty: false },
      runtime: "host",
      executionShape: "standalone",
      sandboxImage: null,
    });
    const v2 = readSessionMeta(ledgerPath, "v2");
    assert.equal(v2?.schemaVersion, 2);
    assert.equal(v2?.head?.bootFingerprint, "abc123");
    assert.equal(v2?.priceVersion, "2026-08-28");
    assert.deepEqual(v2?.tools?.active, ["read", "bash"]);
    // `null` is a recorded answer here — a host session runs against no
    // image — and must survive the round trip as null, not become absent.
    assert.equal(v2?.sandboxImage, null);

    writeSessionMeta(ledgerPath, {
      schemaVersion: 1,
      sessionId: "v1",
      taskId: null,
      projectId: null,
      parentSessionId: null,
      resumedFrom: null,
      agentRole: "worker",
      model: "deepseek/deepseek-v4-flash",
      cwd: "/work",
      startedUtc: "2026-08-01T00:00:00.000Z",
    });
    const v1 = readSessionMeta(ledgerPath, "v1");
    assert.equal(v1?.schemaVersion, 1);
    // Absent, not defaulted. A reader that filled these in would make an
    // un-resumable session look resumable.
    assert.equal(v1?.captureMode, undefined);
    assert.equal(v1?.head, undefined);
    assert.equal(v1?.priceVersion, undefined);
    assert.equal(v1?.sandboxImage, undefined);
  });

  it("returns null rather than throwing for a missing or damaged meta.json", () => {
    const ledgerPath = fakeLedgerPath();
    assert.equal(readSessionMeta(ledgerPath, "nope"), null);
    const path = metaFilePath(ledgerPath, "broken");
    mkdirSync(join(transcriptDir(ledgerPath, "broken")), { recursive: true });
    writeFileSync(path, "{not json", "utf8");
    assert.equal(readSessionMeta(ledgerPath, "broken"), null);
  });
});
