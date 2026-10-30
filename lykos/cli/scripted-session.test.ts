// P4 T142: the scripted-model session's first scenario. A fake model lists
// the repository through the `tool_call` transport, reads a file, rewrites
// it, and ends the turn; the test reads only what a person could — the file
// on disk, the ledger, and `lykos show`.
//
// Later P4 tickets add scenarios here (or in a sibling test file) with
// `runScriptedSession`; the seam's setup is not copied.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { call, lastToolResult, mounted, reply, runScriptedSession, say } from "./scripted-session.js";

describe("scripted-model session (T142)", () => {
  it("a scripted model edits a file through a real standalone session and the ledger and `lykos show` record it", async () => {
    const run = await runScriptedSession({
      files: { "notes.txt": "draft\n" },
      prompt: "Replace the draft in notes.txt with the final text.",
      script: [
        // A mounted tool, reached the only way a model can reach one.
        reply(mounted("ls", { path: "." })),
        (context) => {
          const listing = lastToolResult(context);
          assert.equal(listing.isError, false, listing.text);
          assert.match(listing.text, /notes\.txt/);
          return reply(call("read", { path: "notes.txt" }));
        },
        reply(call("write", { path: "notes.txt", content: "final\n" })),
        reply(say("notes.txt now holds the final text.")),
      ],
    });

    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0, "the whole script ran");
    assert.equal(run.modelCalls, 4);

    // On disk.
    assert.equal(run.file("notes.txt"), "final\n");

    // The ledger.
    const row = run.session();
    assert.equal(row.model, "scripted-1");
    assert.equal(row.edited_file_count, 1);
    assert.match(String(row.edited_files), /notes\.txt/);
    assert.equal(row.execution_shape, "standalone");
    assert.equal(row.tool_calls, 3);

    // `lykos show`, as a person reads it.
    const shown = run.show();
    assert.match(shown, new RegExp(`session ${run.sessionId}`));
    const results = [...shown.matchAll(/tool_result\s+(\S+)\s+state=(\S+)/g)].map((m) => `${m[1]}=${m[2]}`);
    assert.deepEqual(results, ["tool_call=ok", "read=ok", "write=ok"], "every call succeeded, in the model's order");
    assert.match(shown, /"name":"ls","arguments":\{"path":"\."\}/);
    assert.match(shown, /outcome\s+state=done\s+turns=4\s+tool_calls=3/);
    assert.match(shown, /notes\.txt now holds the final text\./);
  });
});

describe("the seam itself (T142)", () => {
  it("a script step that throws fails the scenario with its own error, not a quiet provider error", async () => {
    await assert.rejects(
      runScriptedSession({
        script: [
          reply(call("read", { path: "absent.txt" })),
          (context) => {
            assert.equal(lastToolResult(context).isError, false, "scenario expected the read to succeed");
            return reply(say("unreachable"));
          },
        ],
      }),
      /script step 1 threw: scenario expected the read to succeed/,
    );
  });
});
