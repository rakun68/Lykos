// T168 (ADR-0031): the numbered `read` and the text-replacement `edit`, proven
// through the scripted-model session (T142) — a real standalone session whose
// model is scripted, read back through the ledger, `lykos show`, stderr, the
// files on disk and what the model was sent. The point is that replacing the
// editor did not unplug anything that keys on an `edit` call: the post-edit
// loop, the checkpoint taken before the turn, `edited_files`, the session
// gate and the edit counters.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { call, lastToolResult, reply, runScriptedSession, say } from "./scripted-session.js";

/** Exits 0 when a.ts says `salute`, 1 otherwise. The post-edit check and the gate both run it. */
const CHECK_JS = `
const text = require("node:fs").readFileSync("a.ts", "utf8");
if (!text.includes("salute")) { console.log("check: a.ts still says greet"); process.exit(1); }
console.log("check: ok");
`;

const A_TS = 'export function greet(name: string): string {\n  return "hi " + name;\n}\n';
const CHECKED = "feedback:\n  command: node check.cjs\ngate:\n  command: node check.cjs\n";

describe("T168: read numbers, edit replaces, and everything that watches an edit still fires", () => {
  it("a read, then an edit on text copied from it, triggers the post-edit loop, a checkpoint, edited_files and the gate", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": A_TS, "check.cjs": CHECK_JS },
      config: CHECKED,
      prompt: "Make the greeting a salute.",
      script: [
        reply(call("read", { path: "a.ts" })),
        (context) => {
          // What the model was sent: the file with every line numbered.
          const read = lastToolResult(context);
          assert.equal(read.tool, "read");
          assert.equal(
            read.text,
            '     1\texport function greet(name: string): string {\n     2\t  return "hi " + name;\n     3\t}\n',
          );
          return reply(call("edit", { path: "a.ts", edits: [{ oldText: '"hi " + name', newText: '"salute " + name' }] }));
        },
        (context) => {
          // The post-edit loop appends its verdict to the result Pi's one-liner opens.
          assert.match(
            lastToolResult(context).text,
            /^Successfully replaced 1 block\(s\) in a\.ts\.\n\nlykos: `node check\.cjs` runs after every edit and currently passes\./,
          );
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.equal(run.file("a.ts"), A_TS.replace("hi", "salute"));

    const row = run.session();
    // The post-edit loop ran after the edit, and the check passed.
    assert.equal(row.post_edit_runs, 1);
    assert.equal(row.post_edit_passes, 1);
    // `edited_files` names the file, and the counters saw one `edit` call that did not fail.
    assert.match(String(row.edited_files), /"path":"a\.ts"/);
    assert.equal(row.edited_file_count, 1);
    assert.equal(row.edit_tool_calls, 1);
    assert.equal(row.edit_error_count, 0);
    // The gate graded the session from its command.
    assert.equal(row.verification_cmd, "node check.cjs");
    assert.equal(row.outcome, "success");
    // A checkpoint was taken before the turn that changed the file, and `lykos show` lists it.
    assert.match(run.show(), /turn 1 {2}a\.ts {2}checkpoint [0-9a-f]{8}/);
  });

  it("a failing edit is counted as a failed edit, and the model is told why in Pi's words", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": A_TS },
      script: [
        reply(call("edit", { path: "a.ts", edits: [{ oldText: "this text is not in the file", newText: "x" }] })),
        (context) => {
          const failed = lastToolResult(context);
          assert.equal(failed.isError, true);
          assert.match(failed.text, /Could not find the exact text in a\.ts\. The old text must match exactly/);
          return reply(
            call("edit", { path: "a.ts", edits: [{ oldText: '"hi " + name', newText: '"salute " + name' }] }),
          );
        },
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const row = run.session();
    assert.equal(row.edit_tool_calls, 2);
    assert.equal(row.edit_error_count, 1);
    assert.equal(row.edit_retry_count, 1, "the second edit is on a path whose previous edit failed");
    assert.equal(row.edited_file_count, 1, "only the edit that landed is an edited file");
  });

  it("replaceAll replaces every occurrence and the model is told how many", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": "const value = 1;\nconst y = value + value;\nexport { value, y };\n" },
      script: [
        reply(call("edit", { path: "a.ts", edits: [{ oldText: "value", newText: "total", replaceAll: true }] })),
        (context) => {
          assert.equal(lastToolResult(context).text, "Successfully replaced 4 occurrences in a.ts.");
          return reply(say("renamed"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.equal(run.file("a.ts"), "const total = 1;\nconst y = total + total;\nexport { total, y };\n");
    assert.equal(run.session().edited_file_count, 1);
  });

  it("the old_string / new_string / replace_all shape works through a real session", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": "one two one\n", "b.ts": "alpha\n" },
      script: [
        reply(call("edit", { path: "a.ts", old_string: "one", new_string: "1", replace_all: true })),
        reply(call("edit", { file_path: "b.ts", old_string: "alpha", new_string: "beta" })),
        (context) => {
          assert.equal(lastToolResult(context).text, "Successfully replaced 1 block(s) in b.ts.");
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.file("a.ts"), "1 two 1\n");
    assert.equal(run.file("b.ts"), "beta\n");
    assert.equal(run.session().edited_file_count, 2);
    assert.equal(run.session().edit_error_count, 0);
  });

  it("a call that mixes the two shapes is refused, and the file is untouched", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": "one\n" },
      script: [
        reply(
          call("edit", {
            path: "a.ts",
            edits: [{ oldText: "one", newText: "1" }],
            old_string: "one",
            new_string: "1",
          }),
        ),
        (context) => {
          assert.equal(lastToolResult(context).isError, true);
          assert.match(lastToolResult(context).text, /both the old_string shape/);
          return reply(say("gave up"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.file("a.ts"), "one\n");
    assert.equal(run.session().edit_error_count, 1);
  });

  it("a read at an offset is numbered from that offset, and the more-lines notice stays unnumbered", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `row ${i + 1}`).join("\n");
    const run = await runScriptedSession({
      files: { "big.txt": `${lines}\n` },
      script: [
        reply(call("read", { path: "big.txt", offset: 10, limit: 3 })),
        (context) => {
          assert.equal(
            lastToolResult(context).text,
            "    10\trow 10\n    11\trow 11\n    12\trow 12\n\n[19 more lines in file. Use offset=13 to continue.]",
          );
          return reply(say("read it"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
  });

  it("the model is shown Pi's edit schema plus replaceAll, and a read that says the prefix is not content", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": "x\n" },
      script: [reply(say("hello"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const tools = (run.sent[0]!.tools ?? []) as Array<{ name: string; description?: string; parameters?: unknown }>;
    const edit = tools.find((t) => t.name === "edit");
    const read = tools.find((t) => t.name === "read");
    assert.ok(edit && read, "both tools are on the wire");
    assert.match(JSON.stringify(edit.parameters), /"replaceAll"/);
    assert.doesNotMatch(JSON.stringify(edit.parameters), /"tag"|"hunks"/);
    assert.match(read.description ?? "", /not part of the file; never copy them into edit/);
  });
});

describe("T168: the removed editor is refused loudly", () => {
  it("a config that still sets edit.mode fails to load, naming the key and the decision", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": "x\n" },
      config: "edit:\n  mode: anchored\n",
      script: [reply(say("hi"))],
    });
    assert.equal(run.result.status, "error", JSON.stringify(run.result));
    assert.match(run.result.status === "error" ? run.result.message : "", /edit\.mode was removed \(ADR-0031\)/);
    assert.equal(run.modelCalls, 0, "refused before the model was asked anything");
  });

  it("a config that still declares pi-hashline-edit boots, drops it, and says so on stderr", async () => {
    const run = await runScriptedSession({
      files: { "a.ts": "x\n" },
      config: "extensions:\n  - { name: pi-hashline-edit, version: 0.8.3 }\n",
      script: [reply(say("hi"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.match(run.stderr, /lykos: pi-hashline-edit was not loaded: .*\(ADR-0031\)/);
    // Not loaded, so not recorded as loaded.
    assert.doesNotMatch(String(run.session().extensions ?? ""), /pi-hashline-edit/);
  });
});
