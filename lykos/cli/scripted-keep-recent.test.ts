// T157: `self_compact.keep_recent_tokens` sets how much recent context a
// compaction keeps. The same self-compact cycle runs twice — Pi's default of
// 20000, and 1000 — and what the model is sent right after the compaction is
// compared. Nothing is written under `.pi/`.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { validateSelfCompactConfig, SelfCompactConfigError } from "../loop/self-compact.js";
import { scriptedPiHost } from "./scripted-session.js";
import { call, reply, runScriptedSession, say, type ModelContext } from "./scripted-session.js";

const WINDOW = 400_000;
const BIG = "x".repeat(280_000); // ~70 000 tokens: crosses the 60k cutoff
// Pi cuts only at message boundaries, walking back from the end until it has
// kept at least keep_recent_tokens. LAST (~3 000 tokens) alone satisfies 1000;
// 20000 needs RECENT (~25 000) too, and stops there, before BIG.
const RECENT = "y".repeat(100_000);
const LAST = "z".repeat(12_000);
const NOTE = "Task: finish. Next: say done.";

const config = (keep?: string) =>
  `self_compact:\n${keep !== undefined ? `  keep_recent_tokens: ${keep}\n` : ""}  models:\n    faux/scripted-1: { notice: 1000, warning: 30k, cutoff: 60k }\n`;

/** One full cycle; returns what the model was sent on the first request after the compaction. */
async function cycle(keep?: string): Promise<{ after: ModelContext; workspace: string }> {
  let after: ModelContext | undefined;
  const run = await runScriptedSession({
    config: config(keep),
    contextWindow: WINDOW,
    script: [
      reply(call("write", { path: "big.txt", content: BIG })),
      // Past the cutoff this write is refused, but its arguments are the recent context.
      reply(call("write", { path: "recent.txt", content: RECENT })),
      reply(call("write", { path: "last.txt", content: LAST })),
      reply(call("self_compact", { note: NOTE })),
      (ctx) => {
        assert.match(ctx.systemPrompt ?? "", /summar/i, "the compaction's summariser request");
        return reply(say("SUMMARY."));
      },
      (ctx) => {
        after = ctx;
        return reply(say("done"));
      },
    ],
  });
  assert.equal(run.result.status, "ok", JSON.stringify(run.result));
  assert.equal(run.unusedSteps, 0);
  assert.ok(after !== undefined);
  return { after, workspace: run.workspace };
}

describe("self_compact.keep_recent_tokens (T157)", () => {
  it("a small value keeps less recent context after a compaction than the default does", async () => {
    const byDefault = await cycle();
    const small = await cycle("1000");
    const sent = (c: ModelContext) => JSON.stringify(c.messages);
    assert.ok(sent(byDefault.after).includes(RECENT.slice(0, 2000)), "the default (20000) keeps the ~25k-token recent call");
    assert.ok(!sent(byDefault.after).includes(BIG.slice(0, 2000)), "and compacts the big write before it");
    assert.ok(sent(small.after).includes(LAST.slice(0, 2000)), "1000 keeps the last call");
    assert.ok(!sent(small.after).includes(RECENT.slice(0, 2000)), "but not the recent one before it");
    assert.ok(sent(small.after).length < sent(byDefault.after).length);
    for (const w of [byDefault.workspace, small.workspace]) assert.equal(existsSync(join(w, ".pi")), false, "nothing under .pi/");
    assert.equal(existsSync(join(scriptedPiHost(), "..", "..", ".pi")), false);
  });

  it("is validated as a positive token count, with a default of 20000", () => {
    assert.equal(validateSelfCompactConfig(undefined).keepRecentTokens, 20_000);
    assert.equal(validateSelfCompactConfig({}).keepRecentTokens, 20_000);
    assert.equal(validateSelfCompactConfig({ keep_recent_tokens: 8000 }).keepRecentTokens, 8000);
    assert.equal(validateSelfCompactConfig({ keep_recent_tokens: "12k" }).keepRecentTokens, 12_000);
    for (const bad of [0, -5, 1.5, "lots"]) {
      assert.throws(() => validateSelfCompactConfig({ keep_recent_tokens: bad }), (err: unknown) => {
        assert.ok(err instanceof SelfCompactConfigError);
        assert.match(String(err), /self_compact\.keep_recent_tokens is .*expected a positive token count/);
        return true;
      });
    }
  });
});
