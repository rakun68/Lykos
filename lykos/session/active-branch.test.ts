import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { activeBranch } from "./active-branch.js";
import { LiveTranscriptRecorder } from "./live-capture.js";
import type { TranscriptRecord } from "./replay.js";
import { readTranscript, transcriptFilePath } from "./transcript.js";

/** One process's recorder on a session's transcript, fed the event shapes Pi's `AgentSession` emits. */
function liveProcess(ledgerPath: string, sessionId: string) {
  const recorder = new LiveTranscriptRecorder(ledgerPath, sessionId);
  let emit: (ev: unknown) => void = () => {};
  recorder.attach({
    subscribe(listener) {
      emit = listener;
      return () => {};
    },
  });
  return {
    recorder,
    /** A prompt answered in one turn. */
    prompt(text: string, answer: string): void {
      recorder.userMessage(text);
      emit({ type: "turn_start" });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_end", content: answer } });
      emit({ type: "turn_end" });
    },
  };
}

function records(ledgerPath: string, sessionId: string): TranscriptRecord[] {
  return readTranscript(transcriptFilePath(ledgerPath, sessionId)).events as TranscriptRecord[];
}

function said(branch: readonly TranscriptRecord[]): string[] {
  return branch.flatMap((r) => (r.kind === "user_message" || r.kind === "assistant_message" ? [r.text] : []));
}

function tempLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), "lykos-active-branch-")), "ledger.db");
}

describe("activeBranch", () => {
  it("leaves out the turns a conversation rewind undid, and keeps what came after it", () => {
    const ledgerPath = tempLedgerPath();
    const p = liveProcess(ledgerPath, "s1");
    p.prompt("first", "one");
    p.prompt("second", "two");
    p.prompt("third", "three");
    p.recorder.rewind({ restore: "both", prompt: "second", to_turn: 1, undone_turns: [1, 2], checkpoint: "c", safety_checkpoint: "d" });
    p.prompt("fourth", "four");

    assert.deepEqual(said(activeBranch(records(ledgerPath, "s1"))), ["first", "one", "fourth", "four"]);
  });

  it("keeps every turn after a rewind of the code alone", () => {
    const ledgerPath = tempLedgerPath();
    const p = liveProcess(ledgerPath, "s2");
    p.prompt("first", "one");
    p.prompt("second", "two");
    p.recorder.rewind({ restore: "code", prompt: "second", to_turn: 1, checkpoint: "c", safety_checkpoint: "d" });

    assert.deepEqual(said(activeBranch(records(ledgerPath, "s2"))), ["first", "one", "second", "two"]);
  });

  it("reaches back no further than the resume a rewind followed, whose turns are numbered afresh", () => {
    const ledgerPath = tempLedgerPath();
    liveProcess(ledgerPath, "s3").prompt("before the resume", "zero");
    const resumed = liveProcess(ledgerPath, "s3");
    resumed.recorder.resumeMarker({ from: "s3", events: 2, user_turns: 1, estimate_tokens: 10, estimate_usd: null, price_version: null });
    resumed.prompt("after the resume", "a");
    resumed.prompt("and again", "b");
    resumed.recorder.rewind({ restore: "conversation", prompt: "after the resume", to_turn: 0, undone_turns: [0, 1] });

    assert.deepEqual(said(activeBranch(records(ledgerPath, "s3"))), ["before the resume", "zero"]);
  });

  it("rewinds twice: the second rewind counts on the branch the first left", () => {
    const ledgerPath = tempLedgerPath();
    const p = liveProcess(ledgerPath, "s4");
    p.prompt("first", "one");
    p.prompt("second", "two");
    p.recorder.rewind({ restore: "conversation", prompt: "second", to_turn: 1, undone_turns: [1, 1] });
    p.prompt("third", "three");
    p.prompt("fourth", "four");
    p.recorder.rewind({ restore: "conversation", prompt: "fourth", to_turn: 3, undone_turns: [3, 3] });

    assert.deepEqual(said(activeBranch(records(ledgerPath, "s4"))), ["first", "one", "third", "three"]);
  });
});
