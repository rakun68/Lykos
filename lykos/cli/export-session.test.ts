import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { Ledger } from "../ledger/ledger.js";
import { LiveTranscriptRecorder } from "../session/live-capture.js";
import { sessionMarkdown } from "../session/export-markdown.js";
import { runExportSession } from "./export-session.js";

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

/** A session that ran one turn and ended: its row is closed and its transcript finalized onto it, as ingest does. */
function endedSession(): { ledgerPath: string; sessionId: string } {
  const ledgerPath = join(mkdtempSync(join(tmpdir(), "lykos-export-session-")), "ledger.db");
  const ledger = Ledger.open(ledgerPath);
  const sessionId = ledger.startSession({ brief: "fix the parser", harnessCommit: "abc123", model: "deepseek-v4-flash" });
  const recorder = new LiveTranscriptRecorder(ledgerPath, sessionId);
  let emit: (ev: unknown) => void = () => {};
  recorder.attach({
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  recorder.userMessage("fix the parser");
  emit({ type: "tool_execution_start", toolCallId: "c1", toolName: "edit", args: { path: "parse.ts", oldText: "a", newText: "b" } });
  emit({ type: "tool_execution_end", toolCallId: "c1", toolName: "edit", isError: false, result: { content: [{ type: "text", text: "edited parse.ts" }] } });
  emit({ type: "message_update", assistantMessageEvent: { type: "text_end", content: "Fixed." } });
  const finalized = recorder.writer.finalize();
  ledger.endSession({
    id: sessionId,
    outcome: "success",
    outcomeSource: "verification_command",
    transcriptPath: finalized.path,
    transcriptBytes: finalized.bytes,
    transcriptSha256: finalized.sha256,
  });
  ledger.close();
  return { ledgerPath, sessionId };
}

describe("lykos export <session>", () => {
  it("prints an ended session's Markdown to stdout, found by an id prefix", () => {
    const { ledgerPath, sessionId } = endedSession();

    const { code, out } = captureBoth(() => runExportSession(dirname(ledgerPath), ledgerPath, sessionId.slice(0, 12)));

    assert.equal(code, 0);
    assert.equal(out, sessionMarkdown(ledgerPath, sessionId));
    assert.match(out, /## Prompt\n\nfix the parser/);
    assert.match(out, /### Tool call: `edit`/);
    assert.match(out, /## Answer\n\nFixed\./);
  });

  it("writes the Markdown to a file relative to the working directory, and prints nothing", () => {
    const { ledgerPath, sessionId } = endedSession();
    const cwd = dirname(ledgerPath);

    const { code, out, err } = captureBoth(() => runExportSession(cwd, ledgerPath, sessionId, "session.md"));

    assert.equal(code, 0);
    assert.equal(out, "");
    assert.match(err, /session\.md/);
    assert.equal(readFileSync(join(cwd, "session.md"), "utf8"), sessionMarkdown(ledgerPath, sessionId));
  });

  it("refuses an id no session has", () => {
    const { ledgerPath } = endedSession();

    const { code, out, err } = captureBoth(() => runExportSession(dirname(ledgerPath), ledgerPath, "zzzz"));

    assert.equal(code, 1);
    assert.equal(out, "");
    assert.match(err, /lykos export: no session matches "zzzz"/);
  });
});
