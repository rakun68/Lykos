// One executor runs every project command a session starts. A scripted session
// is handed a stand-in executor that records what it is asked to run and
// answers from a script, so each assertion reads only what reached the executor
// and what the session did with the answer.
//
// The canaries make the negative half real: every routed command is spelled so
// that, if it ran on this machine instead, it would leave a file behind.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { standInExecutor, type RecordedOperation, type ScriptedProcess } from "./scripted-executor.js";
import { call, lastToolResult, mounted, reply, runScriptedSession, say } from "./scripted-session.js";

/** A command that leaves `LOCAL-<name>` behind if it is run for real. */
const canary = (name: string): string => `node -e "require('fs').writeFileSync('LOCAL-${name}','x')"`;

const FAILING_RUN = `✖ gate case (1ms)
ℹ tests 1
ℹ pass 0
ℹ fail 1
ℹ cancelled 0

✖ failing tests:

test at gate.test.mjs:1:1
✖ gate case (1ms)
  Error: boom
`;
const PASSING_RUN = `ℹ tests 1
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
`;

const GATE = canary("gate");
const RERUN = "rerun-gate {files}";
const POST_EDIT = canary("post-edit");
const HOOK = canary("hook");
const BASH = canary("bash");
const POWERSHELL = canary("powershell");
const JOB = canary("job");

describe("the session's executor (T172)", () => {
  it("every project command a session starts reaches the executor, and none runs on this machine", async () => {
    let gateRuns = 0;
    const { executor, operations } = standInExecutor((op) => {
      if (op.command === GATE) return { stdout: FAILING_RUN, exitCode: 1 } satisfies ScriptedProcess;
      if (op.command.startsWith("rerun-gate")) {
        gateRuns += 1;
        return { stdout: PASSING_RUN, exitCode: 0 };
      }
      return undefined;
    });

    const s = await runScriptedSession({
      files: { "notes.txt": "draft\n", "gate.test.mjs": "// stand-in\n" },
      config:
        `feedback:\n  command: ${JSON.stringify(POST_EDIT)}\n` +
        `gate:\n  command: ${JSON.stringify(GATE)}\n  rerun_command: ${JSON.stringify(RERUN)}\n` +
        `hooks:\n  - event: post_tool\n    tools: [write]\n    command: ${JSON.stringify(HOOK)}\n`,
      extra: { executor },
      script: [
        reply(
          call("bash", { command: BASH }),
          call("powershell", { command: POWERSHELL }),
          mounted("hub", { op: "start", command: JOB }),
          mounted("eval", { language: "js", code: "1 + 1" }),
          call("read", { path: "notes.txt" }),
          call("write", { path: "notes.txt", content: "final\n" }),
        ),
        reply(say("done")),
      ],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));

    const ran = (op: RecordedOperation): string => op.command;
    const seen = (command: string): RecordedOperation[] => operations.filter((op) => ran(op) === command);

    assert.deepEqual(seen(BASH).map((o) => [o.via, o.shell]), [["shell", "bash"]], "bash");
    assert.deepEqual(seen(POWERSHELL).map((o) => [o.via, o.shell]), [["shell", "powershell"]], "powershell");
    assert.equal(seen(JOB).length, 1, "a background job");
    assert.equal(seen(POST_EDIT).length, 1, "the post-edit check");
    assert.equal(seen(HOOK).length, 1, "a shell hook");
    assert.equal(seen(GATE).length, 1, "the gate's test command");
    assert.equal(gateRuns, 1, "the gate's rerun of the failed file");
    assert.ok(
      operations.some((o) => o.via === "spawn" && o.command === process.execPath && o.args[0] === "-e"),
      "an eval runtime",
    );

    for (const name of ["bash", "powershell", "job", "post-edit", "hook", "gate"]) {
      assert.equal(existsSync(join(s.workspace, `LOCAL-${name}`)), false, `${name} ran on this machine`);
    }

    // The rerun reached the executor and counted: the failure was a flake.
    assert.equal(s.session().outcome, "success");
  });

  it("the file tools, checkpoints, the repo map and project identity do not reach the executor", async () => {
    const { executor, operations } = standInExecutor();
    const s = await runScriptedSession({
      files: { "notes.txt": "draft\n" },
      config: `feedback:\n  enabled: false\ngate:\n  enabled: false\n`,
      extra: { executor },
      script: [
        reply(call("read", { path: "notes.txt" })),
        reply(call("write", { path: "notes.txt", content: "final\n" })),
        reply(say("done")),
      ],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    assert.equal(s.file("notes.txt"), "final\n");
    assert.match(s.rewind(), /\S/, "a checkpoint was taken, on the host");
    assert.deepEqual(operations, [], "nothing reached the executor");
  });

  it("approval is asked before the executor, so a refused command never reaches it", async () => {
    const { executor, operations } = standInExecutor();
    let refusal: ReturnType<typeof lastToolResult> | undefined;
    const s = await runScriptedSession({
      autoApprove: false,
      extra: { executor },
      script: [
        reply(call("bash", { command: BASH })),
        (context) => {
          refusal = lastToolResult(context);
          return reply(say("done"));
        },
      ],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    assert.equal(refusal?.isError, true);
    assert.deepEqual(operations, []);
  });
});
