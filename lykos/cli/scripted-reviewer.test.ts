// P4 T149: `lykos-reviewer`, the first default Lykos extension, proven
// through the scripted-model session. The faux model scripts BOTH sessions:
// the parent that edits, and then the reviewer's read-only child. What is
// checked is what a person could observe — the files on disk, what each model
// was sent, the ledger, and `lykos show`.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import {
  call,
  lastToolResult,
  reply,
  runScriptedSession,
  say,
  SCRIPTED_MODEL,
  type ModelContext,
  type ScriptStep,
} from "./scripted-session.js";

const FILES = { "src/sum.ts": "export const sum = (a: number, b: number) => a + b;\n" };
const BUGGY = "export const sum = (a: number, b: number) => a * b;\n";
const ON = "reviewer:\n  enabled: true\n";

function userText(context: ModelContext): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? (content as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n") : "";
}

/** The parent edits; then the reviewer's child tries to write, is refused, and reports. */
const EDIT_THEN_REVIEW: ScriptStep[] = [
  reply(call("write", { path: "src/sum.ts", content: BUGGY })),
  reply(say("done")),
  // --- the reviewer's child session starts here ---
  (context) => {
    const prompt = userText(context);
    assert.match(prompt, /independent, read-only reviewer/);
    assert.match(prompt, /\+export const sum = \(a: number, b: number\) => a \* b;/, "the diff reached it");
    assert.match(prompt, /src\/sum\.ts {2}\+1 -1/);
    assert.doesNotMatch(prompt, /Do the scripted task/, "the parent's transcript never reaches it");
    const tools = (context.tools ?? []).map((t) => t.name);
    assert.ok(tools.includes("read"), tools.join(","));
    for (const t of tools) assert.ok(["read", "grep", "find", "ls"].includes(t), `a read-only surface, not ${t}`);
    return reply(call("write", { path: "src/sum.ts", content: "tampered\n" }));
  },
  (context) => {
    const refused = lastToolResult(context);
    assert.equal(refused.isError, true, "the file-changing call is refused");
    return reply(call("read", { path: "src/sum.ts" }));
  },
  reply(say("FINDING: sum multiplies instead of adding\nsrc/sum.ts line 1 uses * where the name says +.")),
];

describe("lykos-reviewer (T149)", () => {
  it("on: runs after the gate on an edited session, read-only, and its findings are in the ledger and `lykos show`", async () => {
    const run = await runScriptedSession({
      files: FILES,
      config: `${ON}gate:\n  command: ${JSON.stringify(`node -e "process.exit(0)"`)}\n`,
      script: EDIT_THEN_REVIEW,
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.equal(run.modelCalls, 5);
    assert.equal(run.file("src/sum.ts"), BUGGY, "the reviewer could not change the code it reviewed");

    const counters = run.query<{ name: string; value: number }>(
      `SELECT name, value FROM extension_counters WHERE session_id = ? AND extension = 'lykos-reviewer' ORDER BY name`,
      run.sessionId,
    );
    assert.deepEqual(counters, [
      { name: "findings", value: 1 },
      { name: "invocations", value: 1 },
    ]);
    const child = run.query<{ id: string; model: string; parent_session_id: string }>(
      `SELECT id, model, parent_session_id FROM sessions WHERE agent_role = 'extension:lykos-reviewer'`,
    );
    assert.equal(child.length, 1);
    assert.equal(child[0]!.parent_session_id, run.sessionId);
    // The ledger records a session's model by id, as it does for every session.
    assert.equal(child[0]!.model, "scripted-1", "no setting: the reviewed session's own model");

    const show = run.show();
    assert.match(show, /reviewer {3}ran 1 time\(s\) on scripted-1 — 1 finding\(s\), advisory/);
    assert.match(show, /\| FINDING: sum multiplies instead of adding/);
    assert.match(show, /extension {2}lykos-reviewer {2}invocations=1 {2}findings=1/);
    const json = JSON.parse(run.show({ json: true })) as { strength: { reviewer: { counters: Record<string, number> } } };
    assert.equal(json.strength.reviewer.counters.findings, 1);

    // T162: the count and the top findings are printed right after the gate's verdict.
    const verdict = run.stderr.indexOf("lykos gate:");
    const report = run.stderr.indexOf("lykos-reviewer: 1 finding(s) on faux/scripted-1, advisory:");
    assert.ok(verdict >= 0, `the gate printed its verdict: ${run.stderr}`);
    assert.ok(report > verdict, `the reviewer's report follows the verdict: ${run.stderr}`);
    assert.match(run.stderr.slice(report), /^ {2}1\. sum multiplies instead of adding$/m);
    assert.match(run.stderr.slice(report), new RegExp(`full text: \`lykos show ${run.sessionId}\``));
  });

  it("its model is a setting", async () => {
    const run = await runScriptedSession({
      files: FILES,
      config: `reviewer:\n  enabled: true\n  model: ${SCRIPTED_MODEL}\n`,
      script: [
        reply(call("write", { path: "src/sum.ts", content: BUGGY })),
        reply(say("done")),
        reply(say("NO_FINDINGS")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.match(run.show(), /reviewer {3}ran 1 time\(s\) on scripted-1 — 0 finding\(s\)/);
    // T162: a review with no findings says so.
    assert.match(run.stderr, /^lykos-reviewer: found nothing \(on faux\/scripted-1\)$/m);
  });

  it("off by its setting: the edited session ends with no review, and show says so", async () => {
    const run = await runScriptedSession({
      files: FILES,
      config: "reviewer:\n  enabled: false\n",
      script: [reply(call("write", { path: "src/sum.ts", content: BUGGY })), reply(say("done"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.modelCalls, 2, "no child session was run");
    assert.match(run.show(), /reviewer {3}did not run — no record from lykos-reviewer/);
    // T162: one line says why the edit was not reviewed.
    assert.match(run.stderr, /^lykos-reviewer: did not run — it is off \(`reviewer\.enabled: false`\)$/m);
  });

  it("off by the ordinary extension syntax: a lykos_extensions list without it, with its setting on", async () => {
    const run = await runScriptedSession({
      files: FILES,
      config: `${ON}lykos_extensions: []\n`,
      script: [reply(call("write", { path: "src/sum.ts", content: BUGGY })), reply(say("done"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.modelCalls, 2);
    assert.equal(run.query(`SELECT 1 FROM extension_counters`).length, 0);
    assert.match(run.show(), /reviewer {3}did not run — no record/);
  });

  it("a session that edited nothing is not reviewed, and show says why", async () => {
    const run = await runScriptedSession({
      files: FILES,
      config: ON,
      script: [reply(call("read", { path: "src/sum.ts" })), reply(say("nothing to change"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.modelCalls, 2);
    assert.match(run.show(), /reviewer {3}did not run — the session edited no files/);
    assert.match(run.show(), /extension {2}lykos-reviewer {2}skipped_no_edits=1/);
    assert.match(run.stderr, /^lykos-reviewer: did not run — the session edited no files$/m);
  });

  // T161: the first scenario above proves only the tool-list layer — its
  // `write` is refused because `write` is not on the list. These open that
  // layer (a test-only option no configuration or extension can set) and
  // switch off one of the other two, so each is proven alone against a real
  // write in a real child session.
  for (const [bypass, layer, reason] of [
    ["harness", "the read-only gate", /refused by the read-only gate — this is a read-only child session/],
    ["gate", "the harness", /write is refused — this is a read-only child session, and it cannot change files/],
  ] as const) {
    it(`T161: with write on the child's list and the ${bypass} bypassed, ${layer} refuses it and the file is unchanged`, async () => {
      const run = await runScriptedSession({
        files: FILES,
        config: ON,
        extra: { bootDeps: { readOnlyChildTest: { extraTools: ["write"], bypass } } },
        script: [
          reply(call("write", { path: "src/sum.ts", content: BUGGY })),
          reply(say("done")),
          (context) => {
            const tools = (context.tools ?? []).map((t) => t.name);
            assert.ok(tools.includes("write"), `the test option put write on the list: ${tools.join(",")}`);
            return reply(call("write", { path: "src/sum.ts", content: "tampered\n" }));
          },
          (context) => {
            const refused = lastToolResult(context);
            assert.equal(refused.isError, true, "the write is refused");
            assert.match(refused.text, reason);
            return reply(say("NO_FINDINGS"));
          },
        ],
      });
      assert.equal(run.result.status, "ok", JSON.stringify(run.result));
      assert.equal(run.unusedSteps, 0);
      assert.equal(run.file("src/sum.ts"), BUGGY, "the reviewed file is unchanged");
      // Nothing but the parent's own edit changed in the working tree.
      const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: run.workspace,
        encoding: "utf8",
      });
      assert.deepEqual(status.split("\n").filter((l) => l.length > 0 && !l.includes(".lykos/")), [" M src/sum.ts"]);
    });
  }
});
