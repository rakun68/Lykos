import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { activeBranch } from "./active-branch.js";
import { earlierPrompts } from "./rewind.js";
import { LiveTranscriptRecorder } from "./live-capture.js";
import type { ResumePlan } from "./interactive.js";
import { buildReplay, type TranscriptRecord } from "./replay.js";
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

/** A resume's plan with nothing to replay, for a recorder to continue. */
function plan(sessionId: string): ResumePlan {
  return { fromSessionId: sessionId, replayText: "", replayEvents: 0, replayUserTurns: 0, estimateTokens: 0, estimateUsd: null, priceVersion: null };
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

  it("carries a summarize's summary in place of the turns it summarized, as the live session has it", () => {
    const ledgerPath = tempLedgerPath();
    const p = liveProcess(ledgerPath, "s5");
    p.prompt("first", "one");
    p.prompt("second", "two");
    p.prompt("third", "three");
    p.recorder.rewind({ restore: "summarize", prompt: "second", to_turn: 1, summarized_turns: [1, 2], summary: "SUMMARY of two and three" });
    p.prompt("fourth", "four");

    const branch = activeBranch(records(ledgerPath, "s5"));
    assert.deepEqual(said(branch), ["first", "one", "fourth", "four"]);
    const replay = buildReplay("s5", branch).text;
    assert.match(replay, /SUMMARY of two and three/);
    assert.ok(replay.indexOf("[user] first") < replay.indexOf("SUMMARY") && replay.indexOf("SUMMARY") < replay.indexOf("[user] fourth"));
    assert.doesNotMatch(replay, /second|third/);
  });

  it("cuts at a turn from before a resume: turns are numbered across the session's processes", () => {
    const ledgerPath = tempLedgerPath();
    const first = liveProcess(ledgerPath, "s6");
    first.prompt("one", "a");
    first.prompt("two", "b");
    const resumed = liveProcess(ledgerPath, "s6");
    resumed.recorder.continues({ ...plan("s6"), firstTurn: 2 });
    resumed.prompt("three", "c");
    resumed.recorder.rewind({ restore: "both", prompt: "two", to_turn: 1, undone_turns: [1, 2], checkpoint: "c", safety_checkpoint: "d" });

    const branch = records(ledgerPath, "s6");
    assert.deepEqual(
      branch.flatMap((r) => (r.kind === "turn_start" ? [r.turn] : [])),
      [0, 1, 2],
      "the resumed process numbers its turns after the earlier ones",
    );
    assert.deepEqual(said(activeBranch(branch)), ["one", "a"]);
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

describe("earlierPrompts", () => {
  it("offers each prompt of the branch with the turn it started and that turn's checkpoint", () => {
    const ledgerPath = tempLedgerPath();
    const p = liveProcess(ledgerPath, "e1");
    p.recorder.checkpointOf = (turn) => `checkpoint-${turn}`;
    p.recorder.userMessage("Notice.\n\none", "one");
    p.prompt("two", "b");

    const offered = earlierPrompts(activeBranch(records(ledgerPath, "e1")));
    assert.deepEqual(offered, [{ text: "two", turn: 0, checkpoint: "checkpoint-0" }], "a prompt that started no turn is not offered");
  });

  it("leaves out a turn whose number a later process of a transcript from before T264 used again", () => {
    const ledgerPath = tempLedgerPath();
    const first = liveProcess(ledgerPath, "e2");
    first.prompt("one", "a");
    first.prompt("two", "b");
    const legacy = liveProcess(ledgerPath, "e2");
    legacy.recorder.resumeMarker({ from: "e2", events: 4, user_turns: 2, estimate_tokens: 10, estimate_usd: null, price_version: null });
    legacy.prompt("three", "c");

    assert.deepEqual(
      earlierPrompts(activeBranch(records(ledgerPath, "e2"))).map((p) => [p.text, p.turn]),
      [
        ["two", 1],
        ["three", 0],
      ],
    );
  });
});

describe("undo and redo on the active branch (P5 #42)", () => {
  it("a redo puts back the turns the undos since the last prompt took", async () => {
    const { pendingUndos } = await import("./active-branch.js");
    const ledgerPath = tempLedgerPath();
    const p = liveProcess(ledgerPath, "u1");
    p.prompt("first", "one");
    p.prompt("second", "two");
    p.prompt("third", "three");
    p.recorder.rewind({ restore: "both", prompt: "third", to_turn: 2, undone_turns: [2, 2], checkpoint: "c3", safety_checkpoint: "s1", undo: true });
    p.recorder.rewind({ restore: "both", prompt: "second", to_turn: 1, undone_turns: [1, 1], checkpoint: "c2", safety_checkpoint: "s2", undo: true });
    assert.deepEqual(said(activeBranch(records(ledgerPath, "u1"))), ["first", "one"]);
    assert.deepEqual(pendingUndos(records(ledgerPath, "u1")), { count: 2, safety: "s1" });
    p.recorder.redo({ undos: 2, checkpoint: "s1" });
    assert.deepEqual(said(activeBranch(records(ledgerPath, "u1"))), ["first", "one", "second", "two", "third", "three"]);
    assert.equal(pendingUndos(records(ledgerPath, "u1")), undefined);
  });

  it("a prompt ends the chain", async () => {
    const { pendingUndos } = await import("./active-branch.js");
    const ledgerPath = tempLedgerPath();
    const p = liveProcess(ledgerPath, "u2");
    p.prompt("first", "one");
    p.recorder.rewind({ restore: "conversation", prompt: "first", to_turn: 0, undone_turns: [0, 0], undo: true });
    p.prompt("again", "two");
    assert.equal(pendingUndos(records(ledgerPath, "u2")), undefined);
  });
});
