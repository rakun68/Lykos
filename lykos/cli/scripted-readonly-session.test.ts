// T181: a top-level read-only session (what an MCP `lykos_review` call is) is
// a session like any other to the ledger, and a long one must not deadlock on
// self-compact. Seam: the scripted-model session with `readOnly: true`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { call, lastToolResult, reply, runScriptedSession, say, type ModelContext } from "./scripted-session.js";

const WINDOW = 400_000;
// Low lines: the faux model's own prompt is a few thousand tokens, so the first response crosses all three.
const LOW = "self_compact:\n  models:\n    faux/scripted-1: { notice: 500, warning: 1500, cutoff: 3000 }\n";
const FILES = { "notes.txt": Array.from({ length: 1500 }, (_, i) => `line ${i} of the notes under review`).join("\n") + "\n" };

const texts = (context: ModelContext): string[] =>
  context.messages.flatMap((m) =>
    typeof m.content === "string" ? [m.content] : Array.isArray(m.content) ? (m.content as Array<{ text?: string }>).map((b) => b.text ?? "") : [],
  );

describe("a top-level read-only session (T181)", () => {
  it("control: an ordinary session under the same lines is told to compact, so the lines are crossed", async () => {
    let told = false;
    const run = await runScriptedSession({
      config: LOW,
      files: FILES,
      contextWindow: WINDOW,
      script: [
        reply(call("read", { path: "notes.txt" })),
        (ctx) => {
          told = texts(ctx).some((t) => /\[self-compact (notice|warning|cutoff)]/.test(t));
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.ok(told, "self-compact spoke");
  });

  it("is not told to compact with a tool it does not have, and past the cutoff can still read and finish", async () => {
    const run = await runScriptedSession({
      config: LOW,
      files: FILES,
      contextWindow: WINDOW,
      extra: { readOnly: true },
      script: [
        (ctx) => {
          const names = (ctx.tools ?? []).map((t) => t.name);
          assert.ok(names.includes("read") && names.every((n) => ["read", "grep", "find", "ls"].includes(n)), names.join(","));
          return reply(call("read", { path: "notes.txt" }));
        },
        (ctx) => {
          assert.ok(!texts(ctx).some((t) => /\[self-compact (notice|warning|cutoff)]/.test(t)), "no instruction to call a tool that is not there");
          return reply(call("read", { path: "notes.txt" }));
        },
        // Well past the cutoff by now: with self-compact armed, the extension would refuse this read.
        (ctx) => {
          const last = lastToolResult(ctx);
          assert.equal(last.isError, false, `a read past the cutoff still works: ${last.text.slice(0, 200)}`);
          return reply(say("reviewed"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
  });

  it("leaves the ledger row of an ordinary session that edited nothing", async () => {
    const run = await runScriptedSession({
      files: FILES,
      extra: { readOnly: true },
      script: [reply(call("read", { path: "notes.txt" })), reply(say("reviewed"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const row = run.session();
    assert.equal(row.execution_shape, "standalone");
    assert.equal(row.edited_file_count, 0);
    assert.equal(row.tool_calls, 1);
    assert.equal(row.checkpoints_written, 0, "a read-only session writes no checkpoint");
    const shown = run.show();
    assert.match(shown, /outcome\s+state=done/);
    assert.doesNotMatch(shown, /tool_result\s+(write|edit|bash)\b/);
    assert.match(shown, /gate\s+did not run/, "the gate skip is recorded");
  });

  // T181b: a review does not continue into a successor. A successor would be a second session id the MCP
  // result does not report, and a review has no task list or edits to carry over.
  it("under context_strategy continue runs past the continuation threshold in the one session, with no successor", async () => {
    const original = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderr += String(chunk);
      return (original as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    let run;
    try {
      run = await runScriptedSession({
        config: "context_strategy: continue\ncompaction:\n  threshold: 0.001\n",
        files: FILES,
        extra: { readOnly: true },
        script: [reply(call("read", { path: "notes.txt" })), reply(say("reviewed"))],
      });
    } finally {
      process.stderr.write = original;
    }
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    // The real assertion: with continuation armed the first turn's crossing would abort the session and leave a step unused.
    assert.equal(run.unusedSteps, 0, "the review ran on past the threshold");
    assert.match(stderr, /context_strategy continue is off for a read-only session/, "the active strategy is recorded as pi, with a note");
    assert.doesNotMatch(stderr, /context boundary reached/);
    // Corroboration only: a read-only session could not satisfy the successor's preconditions, so this alone proves nothing.
    const rows = run.query(`SELECT id, resumed_from FROM sessions`);
    assert.equal(rows.length, 1, "no successor session");
    assert.equal(rows[0]!.resumed_from, null);
  });
});
