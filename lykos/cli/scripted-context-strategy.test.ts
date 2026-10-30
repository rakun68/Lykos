// P4 T150: the context strategy and `lykos-continuation`, proven through the
// scripted-model session (T142's seam). What is checked is what a person could
// observe — the ledger's session rows, what the model was sent, what the session
// printed — never which function ran.
//
// Every scenario sets `compaction.threshold` far below what the first request
// already uses, so continuation's threshold is crossed on the first turn. The
// only thing that differs between them is `context_strategy`, which is the
// point: exactly one strategy runs, and only `continue` acts on the crossing.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { call, reply, runScriptedSession, say, type ScriptedSession, type ScriptedSessionOptions } from "./scripted-session.js";

/** One turn that opens a two-item list and changes a file — continuation's preconditions — then a finish. */
const TURN_ONE = reply(
  call("todo", { add: [{ text: "write a.txt" }, { text: "write b.txt" }] }),
  call("write", { path: "a.txt", content: "a\n" }),
);

function config(strategy: string | undefined, extra = ""): string {
  return `${strategy !== undefined ? `context_strategy: ${strategy}\n` : ""}compaction:\n  threshold: 0.001\n${extra}`;
}

/** Runs a scripted session, returning what it wrote to stderr alongside it. */
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

function sessions(run: ScriptedSession): Array<{ id: string; resumed_from: string | null; continuations_used: number | null }> {
  return run.query(`SELECT id, resumed_from, continuations_used FROM sessions ORDER BY started_utc, rowid`);
}

function firstUserText(context: { messages: Array<{ role: string; content: unknown }> }): string {
  const user = context.messages.find((m) => m.role === "user");
  if (user === undefined) return "";
  if (typeof user.content === "string") return user.content;
  return (user.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? "").join("");
}

describe("context strategy (T150)", () => {
  it("continue: lykos-continuation stops the session at the boundary and a successor starts from disk", async () => {
    const { run, stderr } = await withStderr({
      files: { "package.json": "{}\n" },
      config: config("continue"),
      // Turn one crosses the threshold; the successor finishes the list.
      script: [TURN_ONE, reply(call("write", { path: "b.txt", content: "b\n" }), call("todo", { done: [1, 2] })), reply(say("done"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.doesNotMatch(stderr, /context_strategy/, "an active strategy prints no fallback note");
    assert.match(stderr, /context boundary reached; starting continuation 1\/1/);

    const rows = sessions(run);
    assert.equal(rows.length, 2, "the boundary was crossed into exactly one successor");
    const [first, second] = rows as [(typeof rows)[0], (typeof rows)[0]];
    assert.equal(second.resumed_from, first.id);
    assert.equal(second.continuations_used, 1);
    // The predecessor stopped after one model call: the abort landed before a second request.
    assert.equal(run.sent.length, 3);
    assert.match(firstUserText(run.sent[1]!), /Continue the unfinished task after context boundary 1/);
    assert.match(firstUserText(run.sent[1]!), /write b\.txt/, "the successor reads the open item from the persisted list");
    assert.equal(run.file("a.txt"), "a\n");
    assert.equal(run.file("b.txt"), "b\n");
  });

  it("pi: the same crossing leaves Pi in charge — no stop, no successor", async () => {
    const { run, stderr } = await withStderr({
      files: { "package.json": "{}\n" },
      config: config("pi"),
      script: [TURN_ONE, reply(say("done"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0, "the session ran on past the threshold");
    assert.equal(run.sent.length, 2);
    assert.equal(sessions(run).length, 1);
    assert.equal(sessions(run)[0]!.resumed_from, null);
    assert.doesNotMatch(stderr, /context_strategy|context boundary/);
  });

  it("the default is self-compact (T152: built), active and silent, with continuation not running beside it", async () => {
    const { run, stderr } = await withStderr({
      files: { "package.json": "{}\n" },
      config: config(undefined),
      script: [TURN_ONE, reply(say("done"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.doesNotMatch(stderr, /context_strategy|context boundary/, "the active strategy prints no fallback note");
    assert.equal(run.unusedSteps, 0);
    assert.equal(sessions(run).length, 1, "continuation did not run alongside it");
  });

  it("continue without its extension declared falls back to pi and says so", async () => {
    const { run, stderr } = await withStderr({
      files: { "package.json": "{}\n" },
      config: config("continue", "extensions: []\n"),
      script: [TURN_ONE, reply(say("done"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.match(stderr, /needs the lykos-continuation extension, which is not declared/);
    assert.equal(run.unusedSteps, 0);
    assert.equal(sessions(run).length, 1);
  });
});
