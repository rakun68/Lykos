import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { LiveTranscriptRecorder } from "./live-capture.js";
import { sessionMarkdown } from "./export-markdown.js";
import { TranscriptWriter } from "./transcript.js";

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

describe("sessionMarkdown after a rewind (review finding 2)", () => {
  function rewound(restore: "conversation" | "summarize"): string {
    const ledgerPath = tempLedgerPath();
    const w = new TranscriptWriter(ledgerPath, "sess-rw");
    w.append({ kind: "user_message", text: "first prompt" });
    w.append({ kind: "turn_start", turn: 0 });
    w.append({ kind: "assistant_message", text: "first answer", final: false });
    w.append({ kind: "user_message", text: "undone prompt" });
    w.append({ kind: "turn_start", turn: 1 });
    w.append({ kind: "assistant_message", text: "undone answer", final: false });
    w.append({
      kind: "rewind",
      restore,
      prompt: "undone prompt",
      to_turn: 1,
      ...(restore === "summarize" ? { summarized_turns: [1, 1] as [number, number], summary: "the summary the model has" } : { undone_turns: [1, 1] as [number, number] }),
    });
    w.append({ kind: "user_message", text: "new prompt" });
    w.finalize();
    return sessionMarkdown(ledgerPath, "sess-rw");
  }

  it("exports the active branch: a rewound turn is left out", () => {
    const md = rewound("conversation");
    assert.match(md, /first answer/);
    assert.match(md, /new prompt/);
    assert.doesNotMatch(md, /undone/);
  });

  it("a summarized stretch exports as its summary", () => {
    const md = rewound("summarize");
    assert.doesNotMatch(md, /undone/);
    assert.match(md, /## Summary\n\nthe summary the model has\n/);
  });
});

describe("sessionMarkdown fences (review finding 5)", () => {
  it("a stream result (uncapped) with more backtick runs than a spread takes still exports, fenced past its longest run", () => {
    const ledgerPath = tempLedgerPath();
    const w = new TranscriptWriter(ledgerPath, "sess-ticks");
    w.append({ kind: "user_message", text: "go" });
    w.append({ kind: "tool_result", name: "bash", state: "ok", result: "` ".repeat(200_000) + "````" });
    w.finalize();
    const md = sessionMarkdown(ledgerPath, "sess-ticks");
    assert.match(md, /\n`````\n/);
  });
});
