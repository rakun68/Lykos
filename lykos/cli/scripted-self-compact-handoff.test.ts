// P4 T152: self-compact's handoff, proven through the scripted-model session
// (T142's seam) through a full cycle. What is checked is what a person could
// observe — what the model was sent, which tool calls were refused, the files
// on disk, the ledger's `compactions` rows — never which function ran.
//
// Thresholds come from a per-model override on the faux model: the faux
// prompt is a few thousand tokens, so the cutoff at 60 000 is crossed only by
// the ~70 000-token file the model writes on its first call.
//
// The compaction's summary is itself a model request (Pi's summariser), so it
// takes a script step: `summary()` answers it and checks it is one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NOTE_HEADER } from "../loop/self-compact.js";
import {
  call,
  fail,
  lastToolResult,
  reply,
  runScriptedSession,
  say,
  type ModelContext,
  type ScriptStep,
} from "./scripted-session.js";

const WINDOW = 400_000;
const CONFIG = `self_compact:\n  models:\n    faux/scripted-1: { notice: 1000, warning: 30k, cutoff: 60k }\n`;
const BIG = "x".repeat(280_000); // ~70 000 tokens at Pi's chars/4
const NOTE =
  "Task: add a.txt.\n  Done: wrote big.txt (70k of x).\n  Next: write a.txt containing `ok` — exactly that, no newline.\n\t$HOME and {braces} stay as written.";

/** Every text block the model was sent on one call, flattened. */
function texts(context: ModelContext): string[] {
  const out: string[] = [];
  for (const m of context.messages) {
    if (typeof m.content === "string") out.push(m.content);
    else if (Array.isArray(m.content)) {
      for (const b of m.content as Array<{ type?: string; text?: string }>) if (b.type === "text") out.push(b.text ?? "");
    }
  }
  return out;
}

/** ~25 000 tokens written before the note: Pi keeps the last 20 000 of a context uncompacted, so a smaller session has nothing to cut. */
const PAD = reply(call("write", { path: "pad.txt", content: "p".repeat(100_000) }));

const noteBlocks = (ctx: ModelContext) => texts(ctx).filter((t) => t === NOTE).length;
const headers = (ctx: ModelContext) => texts(ctx).filter((t) => t === NOTE_HEADER).length;

/** A step answering Pi's compaction summariser, asserting that is what it was asked. */
function summary(text = "SUMMARY of the work so far."): ScriptStep {
  return (ctx) => {
    assert.match(ctx.systemPrompt ?? "", /summar/i, "a summariser request");
    return reply(say(text));
  };
}
function summaryFails(message: string): ScriptStep {
  return (ctx) => {
    assert.match(ctx.systemPrompt ?? "", /summar/i, "a summariser request");
    return fail(message);
  };
}

interface CompactionRow {
  trigger: string;
  strategy: string;
  model: string | null;
  tier: string | null;
  context_window: number | null;
  tokens_before: number | null;
  tokens_after: number | null;
  result: string;
  attempt: number;
  error: string | null;
}
const COMPACTIONS = `SELECT trigger, strategy, model, tier, context_window, tokens_before, tokens_after, result, attempt, error
                       FROM compactions WHERE session_id = ? ORDER BY ts_utc, rowid`;

describe("self-compact: the handoff (T152)", () => {
  it("full cycle: refusal past the cutoff, the note returned word for word after compaction, a ledger row", async () => {
    const run = await runScriptedSession({
      config: CONFIG,
      contextWindow: WINDOW,
      script: [
        (ctx) => {
          assert.ok(ctx.tools?.some((t) => t.name === "self_compact"), "the tool rides the request");
          return reply(call("write", { path: "big.txt", content: BIG }));
        },
        (ctx) => {
          assert.ok(texts(ctx).some((t) => t.startsWith("[self-compact cutoff]")), "told once that only self_compact runs");
          // ~25 000 tokens of its own, so the big write falls before the part Pi keeps.
          return reply(call("write", { path: "a.txt", content: "y".repeat(100_000) }));
        },
        (ctx) => {
          const refused = lastToolResult(ctx);
          assert.equal(refused.isError, true, "past the cutoff the write is refused");
          assert.match(refused.text, /write refused .* only self_compact runs now/);
          return reply(call("self_compact", { note: NOTE }));
        },
        // No model call on the full context after the note: the turn ends,
        // the session compacts (the summariser's request)...
        summary(),
        // ...and the note starts the next turn, word for word.
        (ctx) => {
          assert.equal(noteBlocks(ctx), 1, "the note is its own text block, byte for byte");
          assert.equal(headers(ctx), 1);
          assert.ok(texts(ctx).some((t) => t.includes("SUMMARY of the work so far.")), "the compaction's summary is there");
          assert.ok(!JSON.stringify(ctx.messages).includes(BIG.slice(0, 1000)), "the big write was compacted away");
          return reply(call("write", { path: "a.txt", content: "ok" }));
        },
        (ctx) => {
          assert.equal(lastToolResult(ctx).isError, false, "below the cutoff again, tools run");
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.equal(run.file("a.txt"), "ok", "the refused write never reached the disk; the later one did");
    const rows = run.query<CompactionRow>(COMPACTIONS, run.sessionId);
    assert.equal(rows.length, 1);
    const [row] = rows as [CompactionRow];
    assert.equal(row.result, "ok");
    assert.equal(row.trigger, "agent");
    assert.equal(row.strategy, "self-compact");
    assert.equal(row.model, "faux/scripted-1");
    assert.equal(row.tier, "400k");
    assert.equal(row.context_window, WINDOW);
    assert.ok((row.tokens_before ?? 0) >= 60_000, `tokens_before ${row.tokens_before}`);
    assert.ok(row.tokens_after !== null && row.tokens_after < row.tokens_before!, `tokens_after ${row.tokens_after}`);
    assert.equal(row.attempt, 1);
    assert.match(run.show(), /tool_result {2}self_compact {2}state=ok/);
  });

  it("a failed compaction keeps the note and is retried", async () => {
    const run = await runScriptedSession({
      config: CONFIG,
      contextWindow: WINDOW,
      script: [
        PAD,
        reply(call("self_compact", { note: NOTE })),
        summaryFails("scripted summariser outage"),
        summary(),
        (ctx) => {
          assert.equal(noteBlocks(ctx), 1, "the note survived the failure");
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    const rows = run.query<CompactionRow>(COMPACTIONS, run.sessionId);
    assert.deepEqual(
      rows.map((r) => [r.attempt, r.result]),
      [
        [1, "failed"],
        [2, "ok"],
      ],
    );
    assert.match(rows[0]!.error ?? "", /scripted summariser outage/);
  });

  it("resuming a session left mid-handoff returns the note once, and a second resume does not repeat it", async () => {
    const run = await runScriptedSession({
      config: CONFIG,
      contextWindow: WINDOW,
      script: [
        PAD,
        reply(call("self_compact", { note: NOTE })),
        summaryFails("outage 1"),
        summaryFails("outage 2"),
        summaryFails("outage 3"),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.deepEqual(
      run.query<CompactionRow>(COMPACTIONS, run.sessionId).map((r) => r.result),
      ["failed", "failed", "failed"],
      "every attempt failed; the note is still pending when the session ends",
    );

    const resumed = await run.resume({
      prompt: "carry on",
      script: [
        (ctx) => {
          assert.equal(noteBlocks(ctx), 1, "the note comes back, whole, with the first message");
          assert.equal(headers(ctx), 1);
          return reply(say("resumed"));
        },
      ],
    });
    assert.equal(resumed.result.status, "ok", JSON.stringify(resumed.result));
    assert.equal(resumed.sessionId, run.sessionId, "a resume continues the same session");
    assert.equal(resumed.unusedSteps, 0);
    assert.equal(
      run.query<CompactionRow>(COMPACTIONS, run.sessionId).length,
      3,
      "the resume ran no compaction and recorded none",
    );

    const again = await resumed.resume({
      prompt: "and again",
      script: [
        (ctx) => {
          assert.equal(headers(ctx), 0, "the handoff finished: the note is not handed back a second time");
          return reply(say("still fine"));
        },
      ],
    });
    assert.equal(again.result.status, "ok", JSON.stringify(again.result));
    assert.equal(again.unusedSteps, 0);
  });

  it("/self-compact asks the agent to compact now, and the row says the person asked", async () => {
    const run = await runScriptedSession({
      config: CONFIG,
      contextWindow: WINDOW,
      prompt: "/self-compact keep the open questions",
      script: [
        PAD,
        (ctx) => {
          assert.ok(
            texts(ctx).some((t) => t.includes("The person asked you to compact now") && t.includes("keep the open questions")),
          );
          return reply(call("self_compact", { note: NOTE }));
        },
        summary(),
        (ctx) => {
          assert.equal(noteBlocks(ctx), 1);
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    const rows = run.query<CompactionRow>(COMPACTIONS, run.sessionId);
    assert.deepEqual(
      rows.map((r) => [r.trigger, r.result]),
      [["command", "ok"]],
    );
  });
});
