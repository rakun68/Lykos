// `lykos show` prints each post-edit run with the text the model saw on
// failure, and the task list as the session left it.
//
// Proven through the scripted-model session (T142): the test reads only the
// ledger, `lykos show`, and what the model was sent.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { call, lastToolResult, reply, runScriptedSession, say, toolResults } from "./scripted-session.js";

/** Fails, with compiler-shaped output, while `a.txt` holds the word BROKEN. */
const CHECK = `node -e "if(require('fs').readFileSync('a.txt','utf8').includes('BROKEN')){console.log('a.txt(1,1): error TS2304: Cannot find name BROKEN.');process.exit(2)}"`;

describe("post-edit runs and the task list in `lykos show` (T145)", () => {
  it("a failing check is caught, shown with the text the model saw, and the task list survives", async () => {
    const run = await runScriptedSession({
      files: { "a.txt": "fine\n" },
      config: `feedback:\n  command: ${JSON.stringify(CHECK)}\n`,
      script: [
        reply(call("todo", { add: [{ text: "Change a.txt" }, { text: "Tidy up afterwards" }] })),
        reply(call("todo", { start: 1 })),
        reply(call("write", { path: "a.txt", content: "BROKEN\n" })),
        (ctx) => {
          assert.match(lastToolResult(ctx).text, /did not survive the post-edit check/);
          return reply(call("write", { path: "a.txt", content: "mended\n" }));
        },
        reply(call("todo", { done: [1] })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);

    const row = run.session();
    assert.equal(row.post_edit_runs, 2);
    assert.equal(row.post_edit_failures, 1);

    // The recorded text is exactly what was appended to the model's tool result.
    const strength = (JSON.parse(run.show({ json: true })) as {
      strength: { post_edit: { runs: Array<{ verdict: string; exit_code: number | null; shown: string | null }> } };
    }).strength;
    const [failed, mended] = strength.post_edit.runs;
    assert.equal(failed?.verdict, "fail");
    assert.equal(failed?.exit_code, 2);
    assert.ok(failed?.shown !== null && failed?.shown !== undefined);
    const seen = run.sent.flatMap((c) => toolResults(c)).map((r) => r.text);
    assert.ok(
      seen.some((text) => text.includes(failed.shown!)),
      "the recorded failure text is the text the model was sent",
    );
    assert.equal(mended?.verdict, "pass");

    const shown = run.show();
    assert.match(shown, /post-edit\s+2 run\(s\): 1 failed, 1 passed/);
    assert.match(shown, /run 1\s+FAIL\s+`node -e .*`\s+exit 2/);
    assert.match(shown, /the model saw:\n\s+\| lykos: your edit did not survive the post-edit check/);
    assert.match(shown, /\| a\.txt\(1,1\): error TS2304: Cannot find name BROKEN\./);
    assert.match(shown, /run 2\s+pass/);

    assert.match(shown, /task list\s+2 item\(s\) at the end, 1 open/);
    assert.match(shown, /1 \[x\] done\s+Change a\.txt/);
    assert.match(shown, /2 \[ \] pending\s+Tidy up afterwards/);
  });

  it("a session where neither mechanism ran says so", async () => {
    // No package.json and no configured command: nothing to run after an edit.
    const run = await runScriptedSession({
      files: { "a.txt": "fine\n" },
      script: [reply(call("write", { path: "a.txt", content: "changed\n" })), reply(say("done"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));

    const shown = run.show();
    assert.match(shown, /post-edit\s+did not run — no post-edit command was configured or discovered/);
    assert.match(shown, /task list\s+did not run/);
    assert.doesNotMatch(shown, /run 1\s/);
  });
});
