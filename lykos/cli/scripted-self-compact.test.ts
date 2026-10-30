// P4 T151: self-compact's gauge, proven through the scripted-model session
// (T142's seam). What is checked is what a person could observe — what the
// model was sent on each call, what the session printed, what `lykos show`
// reads back — never which function ran.
//
// T152 made `self-compact` the working default strategy, so no switch is
// needed; the handoff's cycle is `scripted-self-compact-handoff.test.ts`.
//
// The thresholds come from a per-model override on the faux model, because
// the faux model's prompt is a few thousand tokens and the shipped table's
// lines are tens of thousands: notice at 1 000 is crossed by the first
// response, and warning at 60 000 only by the ~70 000-token file the model
// writes on its second call.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  call,
  lastToolResult,
  reply,
  runScriptedSession,
  say,
  type ModelContext,
  type ScriptedSession,
  type ScriptedSessionOptions,
} from "./scripted-session.js";

const WINDOW = 400_000;
const OVERRIDE = `self_compact:\n  models:\n    faux/scripted-1: { notice: 1000, warning: 60k, cutoff: 300k }\n`;
const BIG = "x".repeat(280_000); // ~70 000 tokens at Pi's chars/4

/** Every text the model was sent on one call, flattened. */
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

const has = (context: ModelContext, marker: string) => texts(context).some((t) => t.includes(marker));
const NOTICE = "[self-compact notice]";
const WARNING = "[self-compact warning]";

async function withStderr(opts: ScriptedSessionOptions): Promise<{ run: ScriptedSession; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr += String(chunk);
    return (original as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  try {
    return { run: await runScriptedSession(opts), stderr };
  } finally {
    process.stderr.write = original;
  }
}

describe("self-compact: the gauge (T151)", () => {
  it("notice and warning each reach exactly one model call, are never persisted, and context_usage reports the figures", async () => {
    const { run, stderr } = await withStderr({
      config: OVERRIDE,
      contextWindow: WINDOW,
      script: [
        (ctx) => {
          assert.ok(ctx.tools?.some((t) => t.name === "context_usage"), "the tool rides the request");
          assert.ok(!has(ctx, NOTICE) && !has(ctx, WARNING), "nothing before any usage is known");
          return reply(call("context_usage", {}));
        },
        (ctx) => {
          const last = ctx.messages[ctx.messages.length - 1]!;
          assert.equal(last.role, "user", "the guidance is the last message of the call");
          assert.ok(has(ctx, NOTICE), "the first response crossed the notice line");
          assert.ok(!has(ctx, WARNING));
          const usage = JSON.parse(lastToolResult(ctx).text) as Record<string, unknown>;
          assert.equal(usage.window, WINDOW);
          assert.equal(usage.tier, "400k");
          assert.deepEqual(usage.thresholds, { notice: 1000, warning: 60_000, cutoff: 300_000, source: "model" });
          return reply(call("write", { path: "big.txt", content: BIG }));
        },
        (ctx) => {
          assert.ok(has(ctx, WARNING), "the big write crossed the warning line");
          assert.ok(!has(ctx, NOTICE), "the notice was dropped after its one call");
          return reply(call("context_usage", {}));
        },
        (ctx) => {
          assert.ok(!has(ctx, NOTICE) && !has(ctx, WARNING), "the warning was dropped after its one call");
          assert.equal(JSON.parse(lastToolResult(ctx).text).level, "warning");
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.doesNotMatch(stderr, /context_strategy|self-compact is off/, "self-compact is the active strategy");
    assert.equal(run.sent.filter((c) => has(c, NOTICE)).length, 1);
    assert.equal(run.sent.filter((c) => has(c, WARNING)).length, 1);
    assert.doesNotMatch(run.show(), /self-compact (notice|warning)/, "nothing of it is in the session's record");
  });

  it("a window below the smallest tier turns it off: no tool, no guidance, and the session says so", async () => {
    const { run, stderr } = await withStderr({
      config: OVERRIDE,
      contextWindow: 32_000,
      script: [
        (ctx) => {
          assert.ok(!ctx.tools?.some((t) => t.name === "context_usage"));
          return reply(call("write", { path: "a.txt", content: "a\n" }));
        },
        (ctx) => {
          assert.ok(!has(ctx, NOTICE) && !has(ctx, WARNING));
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.match(stderr, /self-compact is off for this model's 32000-token window, below the smallest tier \(64k\)/);
  });

  it("under another strategy the extension is inert: no tool, no guidance", async () => {
    const { run } = await withStderr({
      config: `context_strategy: pi\n${OVERRIDE}`,
      contextWindow: WINDOW,
      script: [
        (ctx) => {
          assert.ok(!ctx.tools?.some((t) => t.name === "context_usage"));
          return reply(call("write", { path: "a.txt", content: "a\n" }));
        },
        (ctx) => {
          assert.ok(!has(ctx, NOTICE) && !has(ctx, WARNING));
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
  });

  it("an invalid table is refused at startup, naming the value", async () => {
    let calls = 0;
    await assert.rejects(
      runScriptedSession({
        config: [
          "self_compact:",
          "  tiers:",
          "    - { window: 64k, notice: 24k, warning: 32k, cutoff: 44k }",
          "    - { window: 128k, notice: 20k, warning: 60k, cutoff: 90k }",
          "",
        ].join("\n"),
        contextWindow: WINDOW,
        script: [
          () => {
            calls += 1;
            return reply(say("never reached"));
          },
        ],
      }),
      /invalid self_compact configuration: self_compact\.tiers\[1\]\.notice is 20000, below the smaller tier's 24000/,
    );
    assert.equal(calls, 0, "no model call was made");
  });
});
