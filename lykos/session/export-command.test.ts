import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { newRetryObservation } from "../loop/retry-observer.js";
import { LiveTranscriptRecorder } from "./live-capture.js";
import { sessionMarkdown } from "./export-markdown.js";
import { runInteractiveLoop, type InteractiveSession, type LineSource } from "./interactive.js";
import type { StandaloneSessionState } from "./session.js";

function state(): StandaloneSessionState {
  return {
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      nestedInput: 0,
      nestedOutput: 0,
      nestedCacheRead: 0,
      nestedCacheWrite: 0,
      calls: [],
    },
    toolCalls: [],
    turns: 0,
    lastText: "",
    humanInterventions: 0,
    retry: newRetryObservation(),
  };
}

function session(sessionId: string): InteractiveSession {
  return {
    sessionId,
    systemPrompt: "test",
    isIdle: true,
    async prompt() {},
    async steer() {},
    async abort() {},
    async waitForIdle() {},
    getActiveToolNames: () => [],
    dispose() {},
  };
}

function lines(...typed: string[]): LineSource {
  let i = 0;
  return { next: async () => typed[i++] ?? "/exit", close() {} };
}

/** One turn recorded the way a live session records it: a prompt, a tool call and its result, an answer. */
function recordedSession(): { ledgerPath: string; sessionId: string } {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "lykos-export-cmd-")), "ledger.db");
  const sessionId = "sess-export-1";
  const recorder = new LiveTranscriptRecorder(ledgerPath, sessionId);
  let emit: (ev: unknown) => void = () => {};
  recorder.attach({
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  recorder.userMessage("list the files");
  emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
  emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "a.ts\n" }] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "One file: a.ts." } });
  return { ledgerPath, sessionId };
}

describe("/export", () => {
  it("with no file, puts the session's Markdown on the clipboard", async () => {
    const { ledgerPath, sessionId } = recordedSession();
    const copied: Array<{ text: string; label: string }> = [];

    await runInteractiveLoop({
      session: session(sessionId),
      lineSource: lines("/export"),
      state: state(),
      ledgerPath,
      config: SHIPPED_DEFAULTS,
      modelSpec: "test/model",
      onCopyText: (text, label) => {
        copied.push({ text, label });
        return true;
      },
    });

    assert.equal(copied.length, 1);
    assert.equal(copied[0]!.text, sessionMarkdown(ledgerPath, sessionId));
    assert.match(copied[0]!.text, /## Prompt\n\nlist the files/);
  });

  it("with a file, writes the same Markdown there and copies nothing", async () => {
    const { ledgerPath, sessionId } = recordedSession();
    const out = join(dirname(ledgerPath), "export.md");
    const copied: string[] = [];

    await runInteractiveLoop({
      session: session(sessionId),
      lineSource: lines(`/export ${out}`),
      state: state(),
      ledgerPath,
      config: SHIPPED_DEFAULTS,
      modelSpec: "test/model",
      onCopyText: (text) => {
        copied.push(text);
        return true;
      },
    });

    assert.deepEqual(copied, []);
    assert.equal(readFileSync(out, "utf8"), sessionMarkdown(ledgerPath, sessionId));
  });
});
