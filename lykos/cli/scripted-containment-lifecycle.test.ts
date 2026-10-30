// Containers never leak and a killed command is never read as success.
//
// Seam 1 of the spec: a stand-in runtime behind the real container executor,
// and a scripted session behind the real boot. The live half, against a real
// Docker and a real Podman, is containment/live.test.ts.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startContainment, type Containment } from "../containment/containment.js";
import { createCommandRunner } from "../loop/post-edit.js";
import { runVerificationCommand } from "../session/verify-outcome.js";
import { lykosVersion } from "../version.js";
import { standInRuntime, type RuntimeOperation } from "./scripted-container.js";
import { standInExecutor } from "./scripted-executor.js";
import { call, reply, runScriptedSession, say } from "./scripted-session.js";

/** An empty directory: containment scans its workspace for secrets, and the system temp directory is not small. */
const workspace = (): string => mkdtempSync(join(tmpdir(), "lykos-t176-"));

const QUIET = `feedback:\n  enabled: false\ngate:\n  enabled: false\n`;
const required = `${QUIET}containment:\n  level: required\n`;

const starts = (ops: RuntimeOperation[]) => ops.filter((o): o is Extract<RuntimeOperation, { op: "start" }> => o.op === "start");
const execs = (ops: RuntimeOperation[]) => ops.filter((o): o is Extract<RuntimeOperation, { op: "exec" }> => o.op === "exec");

const begin = (runtime: ReturnType<typeof standInRuntime>, sessionId?: string) =>
  startContainment({
    config: { level: "required" },
    workspace: workspace(),
    drivers: [runtime.driver],
    ...(sessionId !== undefined ? { sessionId } : {}),
  });

/** Runs `command` through the contained executor's bash, the way the `bash` tool does. */
async function bash(
  c: Containment,
  command: string,
  opts: { timeout?: number } = {},
): Promise<{ exitCode: number | null; output: string }> {
  let output = "";
  const result = await c.executor.shellOperations("bash").exec(command, workspace(), {
    onData: (d) => (output += d.toString("utf8")),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
  });
  return { exitCode: result.exitCode, output };
}

describe("labels (T176)", () => {
  it("a container carries its session id, Lykos's version and its owner", async () => {
    const runtime = standInRuntime();
    const c = await begin(runtime, "session-abc");
    const labels = starts(runtime.operations)[0]?.spec.labels;
    assert.equal(labels?.["lykos.session"], "session-abc");
    assert.equal(labels?.["lykos.version"], lykosVersion());
    assert.equal(labels?.["lykos.owner"], String(process.pid));
    await c.dispose();
  });

  it("a real session's container is labelled with the id the ledger gives that session", async () => {
    const runtime = standInRuntime();
    const s = await runScriptedSession({
      config: required,
      extra: { containmentDrivers: [runtime.driver] },
      script: [reply(call("bash", { command: "true" })), reply(say("done"))],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    const id = s.session().id;
    assert.equal(typeof id, "string");
    assert.equal(starts(runtime.operations)[0]?.spec.labels["lykos.session"], id);
  });
});

describe("a crashed container (T176)", () => {
  it("is replaced on the next command, which runs in the replacement and carries one note", async () => {
    const runtime = standInRuntime({ respond: (command) => (command.join(" ").includes("echo again") ? { stdout: "again\n" } : undefined) });
    const c = await begin(runtime, "s1");
    const first = starts(runtime.operations)[0]!;

    assert.equal((await bash(c, "echo again")).output, "again\n", "no note while the container is alive");

    runtime.crash(first.id);
    const after = await bash(c, "echo again");
    assert.equal(after.exitCode, 0);
    assert.match(after.output, /^again\n\nlykos: the container .*had stopped.*fresh one/s, after.output);

    const second = starts(runtime.operations)[1];
    assert.ok(second, "a second container was started");
    assert.deepEqual(second.spec.labels, first.spec.labels, "the replacement is labelled like the original");
    assert.equal(execs(runtime.operations).at(-1)?.id, second.id, "the command ran in the replacement");
    assert.deepEqual(runtime.running(), [second.id], "the dead container is not left behind");

    assert.equal((await bash(c, "echo again")).output, "again\n", "the note is told once");
    await c.dispose();
    assert.deepEqual(runtime.running(), [], "dispose removes the replacement");
  });

  it("keeps the note for a command the model reads: a hook or a gate run first neither carries nor swallows it", async () => {
    const runtime = standInRuntime({ respond: () => ({ stdout: "out\n" }) });
    const c = await begin(runtime);
    runtime.crash(starts(runtime.operations)[0]!.id);

    // A project command (the gate, the post-edit check, a hook) is not shown to the model as a tool result.
    const child = c.executor.spawn("npm test", [], { shell: true });
    let seen = "";
    child.stdout?.on("data", (d: Buffer) => (seen += d.toString("utf8")));
    await new Promise<void>((done) => child.once("close", () => done()));
    assert.equal(seen, "out\n", "the project command's output is its own");
    assert.equal(starts(runtime.operations).length, 2, "it was run in a replacement");

    const shown = await bash(c, "ls");
    assert.match(shown.output, /^out\n\nlykos: the container .*had stopped.*fresh one/s, "the next bash carries the note");
    assert.equal((await bash(c, "ls")).output, "out\n", "and only once");
    await c.dispose();
  });

  it("is replaced once when two commands start together", async () => {
    const runtime = standInRuntime();
    const c = await begin(runtime);
    runtime.crash(starts(runtime.operations)[0]!.id);
    const [a, b] = await Promise.all([bash(c, "true"), bash(c, "true")]);
    assert.equal(starts(runtime.operations).length, 2, "one replacement");
    assert.equal([a.output, b.output].filter((o) => o.includes("fresh one")).length, 1, "one note");
    await c.dispose();
  });

  it("whose replacement cannot start fails that command, leaves nothing running, and is tried again by the next", async () => {
    const runtime = standInRuntime();
    const c = await begin(runtime);
    runtime.crash(starts(runtime.operations)[0]!.id);
    const realStart = runtime.driver.startContainer;
    runtime.driver.startContainer = async () => {
      throw new Error("no space left");
    };
    await assert.rejects(bash(c, "true"), /no space left/);
    assert.deepEqual(runtime.running(), []);
    runtime.driver.startContainer = realStart;
    assert.equal((await bash(c, "true")).exitCode, 0);
    await c.dispose();
    assert.deepEqual(runtime.running(), []);
  });
});

describe("a killed command (T176)", () => {
  it("reports failure and says it was killed, never exit 0, when the runtime closes it with a signal", async () => {
    const runtime = standInRuntime({ respond: () => ({ exitCode: null, signal: "SIGKILL", stdout: "partial\n" }) });
    const c = await begin(runtime);
    const r = await bash(c, "npm test");
    assert.equal(r.exitCode, 137, "128 + SIGKILL, as a shell reports it");
    assert.match(r.output, /partial\n/);
    assert.match(r.output, /killed by SIGKILL/);
    await c.dispose();
  });

  it("the bash tool hands the model an error for it", async () => {
    const runtime = standInRuntime({ respond: () => ({ exitCode: null, signal: "SIGKILL" }) });
    let seen = "";
    const s = await runScriptedSession({
      config: required,
      extra: { containmentDrivers: [runtime.driver] },
      script: [
        reply(call("bash", { command: "npm test" })),
        (context) => {
          seen = JSON.stringify(context.messages.at(-1));
          return reply(say("done"));
        },
      ],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    assert.match(seen, /"isError":true/);
    assert.match(seen, /killed by SIGKILL/);
  });

  it("the replacement note survives a first command whose output is longer than the bash tool keeps", async () => {
    let crashed = false;
    const runtime = standInRuntime({
      respond: (command) => {
        const line = command.join(" ");
        if (line.includes("prep") && !crashed) {
          crashed = true;
          const id = starts(runtime.operations)[0]!.id;
          // Between this command and the next the container dies.
          setImmediate(() => runtime.crash(id));
          return {};
        }
        // Past Pi's 2000-line and 50KB limits, so only the tail reaches the model.
        return line.includes("big") ? { stdout: Array.from({ length: 6000 }, (_, i) => `line ${i}\n`).join("") } : undefined;
      },
    });
    let seen = "";
    const s = await runScriptedSession({
      config: required,
      extra: { containmentDrivers: [runtime.driver] },
      script: [
        reply(call("bash", { command: "prep" })),
        reply(call("bash", { command: "big" })),
        (context) => {
          seen = JSON.stringify(context.messages.at(-1));
          return reply(say("done"));
        },
      ],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    assert.match(seen, /line 5999/, "positive control: the tail of the output is kept");
    assert.doesNotMatch(seen, /line 0\n/, "positive control: the head was truncated");
    assert.match(seen, /had stopped.*fresh one/s, "the note is in what the model was shown");
  });

  it("a gate run stopped by the gate's own timeout is a fail that says it timed out, in the ledger and in lykos show", async () => {
    const s = await runScriptedSession({
      files: { "notes.txt": "draft\n" },
      config: `feedback:\n  enabled: false\ngate:\n  command: ${JSON.stringify(`node -e "setTimeout(() => {}, 60000)"`)}\n  timeout_seconds: 1\n`,
      script: [reply(call("write", { path: "notes.txt", content: "final\n" })), reply(say("done"))],
    });
    assert.equal(s.result.status, "ok", JSON.stringify(s.result));
    const row = s.session();
    assert.equal(row.outcome, "fail");
    assert.equal(row.verification_exit_code, 143);
    assert.match(String(row.verification_output), /\[timed out after 1s \(SIGTERM\)\]$/);
    assert.match(s.show(), /exit code  143/);
    assert.match(s.show(), /stopped    timed out after 1s \(SIGTERM\)/);
  });

  it("a timeout kills the command inside the container and rejects", async () => {
    const runtime = standInRuntime({ respond: (command) => (command.join(" ").includes("sleep") ? { hang: true } : undefined) });
    const c = await begin(runtime);
    await assert.rejects(bash(c, "sleep 300", { timeout: 0.05 }), /timeout:0.05/);
    assert.ok(
      execs(runtime.operations).some((o) => o.command.join(" ").includes("kill -s KILL")),
      "a kill reached the container",
    );
    await c.dispose();
  });

  it("a timeout of the post-edit check stops the command inside the container, not just the client", async () => {
    const runtime = standInRuntime({ respond: (command) => (command.join(" ").includes("slow-check") ? { hang: true } : undefined) });
    const c = await begin(runtime);
    const run = await createCommandRunner(c.executor)("slow-check", workspace(), 50);
    assert.match(run.problem ?? "", /timed out/);
    assert.ok(
      execs(runtime.operations).some((o) => o.command.join(" ").includes("kill -s ")),
      "a kill reached the container",
    );
    await c.dispose();
  });
});

describe("the gate and a killed test run (T176)", () => {
  it("a verification command that a signal killed is a failure naming the signal, not a skipped run", async () => {
    const { executor } = standInExecutor(() => ({ exitCode: null, signal: "SIGKILL", stdout: "1..40\nok 1\n" }));
    const run = await runVerificationCommand("npm test", workspace(), 60_000, executor);
    assert.equal(run.exitCode, 137);
    assert.equal(run.signal, "SIGKILL");
    assert.equal(run.spawnError, undefined, "it ran; it was not a command that could not start");
  });
});
