import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LiveTranscriptRecorder } from "./live-capture.js";
import { sessionMarkdown } from "./export-markdown.js";

function tempLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lykos-export-md-")), "ledger.db");
}

/** Records one turn through the live recorder, fed the event shapes Pi's `AgentSession` emits. */
function recordTurn(ledgerPath: string, sessionId: string): void {
  const recorder = new LiveTranscriptRecorder(ledgerPath, sessionId);
  recorder.writeMeta({
    taskId: null,
    projectId: null,
    parentSessionId: null,
    resumedFrom: null,
    agentRole: null,
    model: "deepseek/deepseek-v4-flash",
    cwd: null,
    startedUtc: "2026-11-15T10:00:00.000Z",
  });
  let emit: (ev: unknown) => void = () => {};
  recorder.attach({
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  recorder.userMessage("What is in notes.md?");
  emit({ type: "turn_start" });
  emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "read", args: { path: "notes.md" } });
  emit({
    type: "tool_execution_end",
    toolCallId: "call_1",
    toolName: "read",
    isError: false,
    // Content that itself holds a fence: the export's fence must outlast it.
    result: { content: [{ type: "text", text: "# Notes\n```ts\nconst a = 1;\n```\n" }] },
  });
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end", content: "private reasoning" },
  });
  emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_end", content: "It holds one TypeScript snippet." },
  });
  recorder.writer.finalize();
}

describe("sessionMarkdown", () => {
  it("renders the prompt, the tool call and its result fenced, and the answer, in order", () => {
    const ledgerPath = tempLedgerPath();
    recordTurn(ledgerPath, "sess-md-1");

    const md = sessionMarkdown(ledgerPath, "sess-md-1");

    assert.match(md, /^# Session sess-md-1\n/);
    assert.match(md, /deepseek\/deepseek-v4-flash/);
    const prompt = md.indexOf("## Prompt\n\nWhat is in notes.md?\n");
    const call = md.indexOf("### Tool call: `read`\n\n```json\n{\n  \"path\": \"notes.md\"\n}\n```\n");
    const result = md.indexOf("#### Result: `read` (ok)\n\n````\n# Notes\n```ts\nconst a = 1;\n```\n````\n");
    const answer = md.indexOf("## Answer\n\nIt holds one TypeScript snippet.\n");
    assert.ok(prompt >= 0, md);
    assert.ok(call > prompt, md);
    assert.ok(result > call, md);
    assert.ok(answer > result, md);
    assert.doesNotMatch(md, /private reasoning/);
  });
});
