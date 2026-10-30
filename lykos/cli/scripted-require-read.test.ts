// T168 part B (ADR-0031, decisions 11 and 12), through the scripted-model session
// (T142): a real standalone session whose model is scripted, read back through
// the ledger, `lykos show`, the files on disk and what the model was sent.
//
// - `edit.require_read`: an edit before a read is rejected as an ordinary tool
//   error the model recovers from; a read, a partial read and the model's own
//   consecutive edits make the next edit pass; an outside change makes it stale
//   again; a new file needs no read; and a rejected call never reaches the
//   approval gate.
// - `lykos show`: the edit counts, the failures by reason and the post-edit
//   failures per successful edit, in text and in `--json`.
//
// The unit tests are `tools/read-record.test.ts` and `tools/edit-failure.test.ts`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { call, lastToolResult, reply, runScriptedSession, say } from "./scripted-session.js";

const A_TS = "one\ntwo\nthree\n";
/** Appends a line to a.ts: the outside change, made through the shell the way a person or a build step would. */
const TOUCH_CJS = `require("node:fs").appendFileSync("a.ts", "// outside\\n");`;
const REQUIRE = "edit:\n  require_read: true\n";

interface ShownEdits {
  calls: number | null;
  succeeded: number | null;
  failed: number | null;
  failures_by_reason: Record<string, number> | null;
  file_changing_calls: number | null;
  post_edit_failed_runs: number | null;
  post_edit_failures_per_edit: number | null;
  post_edit_failures_unmeasured_reason: string | null;
  unmeasured_reason: string | null;
}

describe("T168 part B: edit.require_read through a real session", () => {
  it("rejects an unread edit, accepts it after a read, rejects it after an outside change, and recovers each time", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": A_TS, "b.ts": "bee\n", "touch.cjs": TOUCH_CJS },
      config: REQUIRE,
      script: [
        // 1. Blind edit.
        reply(call("edit", { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] })),
        (context) => {
          const result = lastToolResult(context);
          assert.equal(result.isError, true);
          assert.equal(result.text, "`a.ts` has not been read in this session. Read it first (edit.require_read is on).");
          return reply(call("read", { path: "a.ts" }));
        },
        // 2. Read, then the same edit passes, and so does the next one with no read between.
        reply(call("edit", { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] })),
        (context) => {
          assert.equal(lastToolResult(context).text, "Successfully replaced 1 block(s) in a.ts.");
          return reply(call("edit", { path: "a.ts", edits: [{ oldText: "three", newText: "THREE" }] }));
        },
        // 3. The file changes behind the session's back.
        (context) => {
          assert.equal(lastToolResult(context).text, "Successfully replaced 1 block(s) in a.ts.");
          return reply(call("bash", { command: "node touch.cjs" }));
        },
        reply(call("edit", { path: "a.ts", edits: [{ oldText: "one", newText: "ONE" }] })),
        (context) => {
          const result = lastToolResult(context);
          assert.equal(result.isError, true);
          assert.equal(result.text, "`a.ts` changed since it was last read. Read it again before editing (edit.require_read is on).");
          return reply(call("read", { path: "a.ts" }));
        },
        reply(call("edit", { path: "a.ts", edits: [{ oldText: "one", newText: "ONE" }] })),
        // 4. write: a new file needs no read; an existing, unread one does; a partial read of it is enough.
        (context) => {
          assert.match(lastToolResult(context).text, /^Successfully replaced/);
          return reply(call("write", { path: "new.ts", content: "fresh\n" }));
        },
        reply(call("write", { path: "b.ts", content: "overwritten\n" })),
        (context) => {
          const result = lastToolResult(context);
          assert.equal(result.isError, true);
          assert.match(result.text, /^`b\.ts` has not been read in this session\./);
          return reply(call("read", { path: "b.ts", offset: 1, limit: 1 }));
        },
        reply(call("write", { path: "b.ts", content: "overwritten\n" })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.equal(run.file("a.ts"), "ONE\nTWO\nTHREE\n// outside\n");
    assert.equal(run.file("new.ts"), "fresh\n");
    assert.equal(run.file("b.ts"), "overwritten\n");

    // The rejections are failed edit calls to the ledger, and `lykos show` names why.
    const row = run.session();
    assert.equal(row.edit_tool_calls, 5);
    assert.equal(row.edit_error_count, 2);
    const edits = (JSON.parse(run.show({ json: true })) as { strength: { edits: ShownEdits } }).strength.edits;
    assert.equal(edits.calls, 5);
    assert.equal(edits.succeeded, 3);
    assert.equal(edits.failed, 2);
    assert.deepEqual(edits.failures_by_reason, { not_found: 0, not_unique: 0, overlap: 0, unread: 1, stale: 1, other: 0 });
    assert.match(run.show(), /edit calls 5 call\(s\), 3 succeeded, 2 failed;/);
    assert.match(run.show(), /edit fails unread 1, stale 1\n/);
  });

  it("a rejected call never reaches the approval gate: with no --yes the model sees the rule, not a refusal", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": A_TS },
      config: REQUIRE,
      autoApprove: false,
      script: [
        reply(call("edit", { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] })),
        (context) => {
          const rejected = lastToolResult(context);
          assert.equal(rejected.isError, true);
          assert.match(rejected.text, /has not been read in this session/);
          assert.doesNotMatch(rejected.text, /declined/);
          return reply(call("read", { path: "a.ts" }));
        },
        // Read, so the rule is satisfied, and now the gate IS reached: this session has no human, so the gate declines.
        reply(call("edit", { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] })),
        (context) => {
          const refused = lastToolResult(context);
          assert.equal(refused.isError, true);
          assert.doesNotMatch(refused.text, /require_read/);
          assert.match(refused.text, /the human declined this edit/);
          return reply(say("stopped"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.equal(run.file("a.ts"), A_TS);
  });

  it("is off by default: the same blind edit goes through, and the descriptions are the plain ones", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": A_TS },
      script: [
        reply(call("edit", { path: "a.ts", edits: [{ oldText: "two", newText: "TWO" }] })),
        (context) => {
          assert.equal(lastToolResult(context).text, "Successfully replaced 1 block(s) in a.ts.");
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.file("a.ts"), "one\nTWO\nthree\n");
    const tools = (run.sent[0]!.tools ?? []) as Array<{ name: string; description?: string }>;
    for (const name of ["edit", "write"]) {
      assert.doesNotMatch(tools.find((t) => t.name === name)?.description ?? "", /requires a read first/, name);
    }
  });

  it("when on, edit and write each say so in their description", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": A_TS },
      config: REQUIRE,
      script: [reply(say("hello"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const tools = (run.sent[0]!.tools ?? []) as Array<{ name: string; description?: string }>;
    for (const name of ["edit", "write"]) {
      assert.match(tools.find((t) => t.name === name)?.description ?? "", /This session requires a read first/, name);
    }
    assert.doesNotMatch(tools.find((t) => t.name === "read")?.description ?? "", /requires a read first/);
  });

  it("a non-boolean edit.require_read refuses to start, before the model is asked anything", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": A_TS },
      config: 'edit:\n  require_read: "yes"\n',
      script: [reply(say("hi"))],
    });
    assert.equal(run.result.status, "error", JSON.stringify(run.result));
    assert.match(run.result.status === "error" ? run.result.message : "", /edit\.require_read must be true or false/);
    assert.equal(run.modelCalls, 0);
  });
});

/** Fails while a.txt holds BROKEN, so the post-edit loop has something to say about the second edit. */
const CHECK_JS = `
const text = require("node:fs").readFileSync("a.txt", "utf8");
if (text.includes("BROKEN")) { console.log("check: BROKEN is still in a.txt"); process.exit(1); }
console.log("check: ok");
`;

describe("T168 part B: `lykos show` edit evidence", () => {
  it("counts edit calls, names the failures by reason, and gives the post-edit failures per successful edit", async () => {
    const run = await runScriptedSession({
      files: { "a.txt": "fine\nfine\n", "check.cjs": CHECK_JS },
      config: "feedback:\n  command: node check.cjs\n",
      script: [
        // not_unique
        reply(call("edit", { path: "a.txt", edits: [{ oldText: "fine", newText: "x" }] })),
        // succeeds; the post-edit check fails
        reply(call("edit", { path: "a.txt", edits: [{ oldText: "fine\nfine", newText: "BROKEN" }] })),
        // not_found
        reply(call("edit", { path: "a.txt", edits: [{ oldText: "no such text", newText: "x" }] })),
        // succeeds; the post-edit check passes
        reply(call("edit", { path: "a.txt", edits: [{ oldText: "BROKEN", newText: "mended" }] })),
        // overlap
        reply(
          call("edit", {
            path: "a.txt",
            edits: [
              { oldText: "mende", newText: "x" },
              { oldText: "ended", newText: "y" },
            ],
          }),
        ),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.equal(run.file("a.txt"), "mended\n");

    const row = run.session();
    assert.equal(row.post_edit_runs, 2);
    assert.equal(row.post_edit_failures, 1);

    const shown = run.show();
    assert.match(
      shown,
      / edit calls 5 call\(s\), 2 succeeded, 3 failed; post-edit failures per successful edit 0\.50 \(1 failed post-edit run\(s\) over 2 successful file-changing call\(s\)\)\n/,
    );
    assert.match(shown, / edit fails not_found 1, not_unique 1, overlap 1\n/);
    // Only added lines: the post-edit line and the older `edits` line are exactly as before.
    assert.match(shown, / post-edit {2}2 run\(s\): 1 failed, 1 passed\n/);
    assert.match(shown, / edits {6}2 turn\(s\) changed files; every one has a checkpoint\n/);

    const edits = (JSON.parse(run.show({ json: true })) as { strength: { edits: ShownEdits } }).strength.edits;
    assert.equal(edits.unmeasured_reason, null);
    assert.equal(edits.calls, 5);
    assert.equal(edits.succeeded, 2);
    assert.equal(edits.failed, 3);
    assert.deepEqual(edits.failures_by_reason, { not_found: 1, not_unique: 1, overlap: 1, unread: 0, stale: 0, other: 0 });
    assert.equal(edits.file_changing_calls, 2);
    assert.equal(edits.post_edit_failed_runs, 1);
    assert.equal(edits.post_edit_failures_per_edit, 0.5);
    assert.equal(edits.post_edit_failures_unmeasured_reason, null);
  });

  it("a session that edited nothing and ran no post-edit loop says zero calls and unmeasured, with no failure line", async () => {
    const run = await runScriptedSession({
      files: { "a.txt": "fine\n" },
      script: [reply(call("read", { path: "a.txt" })), reply(say("looked"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const shown = run.show();
    assert.match(
      shown,
      / edit calls 0 call\(s\), 0 succeeded, 0 failed; post-edit failures per successful edit unmeasured — the post-edit loop did not run\n/,
    );
    assert.doesNotMatch(shown, / edit fails /);
    const edits = (JSON.parse(run.show({ json: true })) as { strength: { edits: ShownEdits } }).strength.edits;
    assert.equal(edits.post_edit_failures_per_edit, null);
    assert.equal(edits.failures_by_reason?.other, 0);
  });
});
