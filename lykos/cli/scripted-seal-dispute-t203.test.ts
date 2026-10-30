// T203 (#58) ACCEPTANCE: an implementer that thinks a sealed test is wrong
// files a dispute instead of editing it.
//
// Seam 1, the scripted session. The seal is made by the real `lykos seal`
// commands before the session starts, as in T201. Two sealed tests are red:
// `math > adds` and `math > subtracts`. The gate's own command passes, so what
// decides each ending is the lykos-seal green run and the disputes filed.
// The resolver is `orchestrator` throughout: the test-writer resolver is T204.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { call, mounted, reply, runScriptedSession, say, toolResults, SCRIPTED_MODEL, type ScriptedSession } from "./scripted-session.js";

const cliPath = join(import.meta.dirname, "..", "cli.ts").replace(/\\/g, "/");
const tsxImport = import.meta.resolve("tsx");

const STUB = "export function add(a, b) { return 0; }\nexport function sub(a, b) { return 0; }\n";
const SUB_ONLY = "export function add(a, b) { return 0; }\nexport function sub(a, b) { return a - b; }\n";
const RED_TEST =
  'import { describe, it } from "node:test";\n' +
  'import assert from "node:assert/strict";\n' +
  'import { add, sub } from "../src/math.mjs";\n' +
  'describe("math", () => {\n' +
  '  it("adds", () => { assert.equal(add(1, 2), 4); });\n' +
  '  it("subtracts", () => { assert.equal(sub(3, 1), 2); });\n' +
  "});\n";

const REASON = "1 + 2 is 3, the test expects 4";
const EVIDENCE = "node -e 'console.log(1 + 2)' prints 3";
const DISPUTE_ADDS = call("dispute_test", { file: "test/math.test.mjs", describe: ["math"], name: "adds", reason: REASON, evidence: EVIDENCE });

function config(extensions?: string): string {
  return [
    "seal:",
    "  base: main",
    '  test_command: "node --test {files}"',
    "  enforce_for: [build]",
    "  resolver: orchestrator",
    "containment:",
    "  level: off",
    "feedback:",
    "  enabled: false",
    "gate:",
    '  command: "node -e 0"',
    ...(extensions !== undefined ? [extensions] : []),
    "",
  ].join("\n");
}

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LYKOS_TRUST_WORKSPACE: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    NODE_TEST_CONTEXT: undefined,
  };
}

function sh(cwd: string, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", env: env() }).trim();
}

function lykos(cwd: string, ...args: string[]): void {
  const res = spawnSync(process.execPath, ["--import", tsxImport, cliPath, ...args], { cwd, env: env(), encoding: "utf8", timeout: 120_000 });
  assert.equal(res.status, 0, `lykos ${args.join(" ")}:\n${res.stdout}\n${res.stderr}`);
}

function put(ws: string, rel: string, text: string): void {
  mkdirSync(dirname(join(ws, rel)), { recursive: true });
  writeFileSync(join(ws, rel), text);
}

/** main: tracked config and a trusted key; branch feat: two red tests and their stub, sealed. */
function sealedWorkspace(ws: string): void {
  writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
  sh(ws, "git", "add", "-A");
  sh(ws, "git", "commit", "-q", "-m", "track config");
  lykos(ws, "seal", "key", "init");
  sh(ws, "git", "checkout", "-q", "-b", "feat");
  put(ws, "src/math.mjs", STUB);
  put(ws, "test/math.test.mjs", RED_TEST);
  sh(ws, "git", "add", "-A");
  sh(ws, "git", "commit", "-q", "-m", "red: math");
  lykos(ws, "seal", "create");
}

const NO_TEST_CONTEXT = { NODE_TEST_CONTEXT: undefined };
const IMPLEMENT_SUB = call("write", { path: "src/math.mjs", content: SUB_ONLY });
const COMMIT = (message: string) => call("commit", { message });

function session(script: ReturnType<typeof reply>[], extensions?: string): Promise<ScriptedSession> {
  return runScriptedSession({
    env: NO_TEST_CONTEXT,
    config: config(extensions),
    setup: sealedWorkspace,
    extra: { specialist: "build" },
    script: [...script, reply(say("done"))],
  });
}

/** Every tool result of the whole session, parent and children, in order. */
function results(s: ScriptedSession): Array<{ tool: string; text: string; isError: boolean }> {
  const seen = new Set<string>();
  const all: Array<{ tool: string; text: string; isError: boolean }> = [];
  for (const ctx of s.sent) {
    for (const r of toolResults(ctx)) {
      const key = `${r.tool}\u0000${r.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        all.push(r);
      }
    }
  }
  return all;
}

const sealKinds = (s: ScriptedSession, sessionId = s.sessionId) =>
  s.query<{ kind: string }>("SELECT kind FROM seal_events WHERE session_id = ?", sessionId).map((r) => r.kind);

const taskState = (s: ScriptedSession) =>
  s.query<{ state: string }>("SELECT t.state FROM tasks t JOIN sessions s ON s.task_id = t.id WHERE s.id = ?", s.sessionId)[0]?.state;

describe("T203 ACCEPTANCE: dispute_test", () => {
  it("a scripted implementer files a dispute and the session continues", async () => {
    const s = await session([reply(DISPUTE_ADDS), reply(IMPLEMENT_SUB), reply(COMMIT("implement sub"))]);
    assert.equal(s.unusedSteps, 0, "the session went on after the dispute");
    const dispute = results(s).find((r) => r.tool === "dispute_test");
    assert.ok(dispute, "dispute_test returned a result");
    assert.equal(dispute.isError, false, dispute.text);
    assert.equal(s.file("test/math.test.mjs"), RED_TEST, "the disputed test is untouched");
    assert.equal(s.file("src/math.mjs"), SUB_ONLY, "work continued on the other test");
    assert.ok(sealKinds(s).some((k) => /disput/.test(k)), `seal_events: ${sealKinds(s)}`);
  });

  it("a session failing only on disputed tests ends disputed: ledger outcome fail, task state disputed", async () => {
    const s = await session([reply(DISPUTE_ADDS), reply(IMPLEMENT_SUB), reply(COMMIT("implement sub"))]);
    assert.equal(s.session().outcome, "fail", "the ledger outcome stays fail");
    assert.equal(taskState(s), "disputed", s.show());
    assert.match(s.show(), /disputed/);
  });

  it("a session with another failing sealed test ends failed, not disputed", async () => {
    const s = await session([reply(DISPUTE_ADDS)]);
    assert.equal(s.session().outcome, "fail");
    assert.notEqual(taskState(s), "disputed", s.show());
  });

  it("lykos show lists the dispute with its test, reason and evidence", async () => {
    const s = await session([reply(DISPUTE_ADDS), reply(IMPLEMENT_SUB), reply(COMMIT("implement sub"))]);
    const shown = s.show();
    assert.match(shown, /test\/math\.test\.mjs/);
    assert.match(shown, /adds/);
    assert.ok(shown.includes(REASON), shown);
    assert.ok(shown.includes(EVIDENCE), shown);
  });

  it("a disputed test still fails the gate: implementing nothing else and disputing does not end success", async () => {
    const s = await session([reply(DISPUTE_ADDS), reply(IMPLEMENT_SUB), reply(COMMIT("implement sub"))]);
    assert.notEqual(s.session().outcome, "success");
  });

  it("with lykos-seal removed, dispute_test does not exist", async () => {
    const s = await session([reply(DISPUTE_ADDS)], "lykos_extensions: []");
    const tools = s.sent.flatMap((ctx) => (ctx.tools ?? []).map((t) => t.name));
    assert.ok(tools.length > 0, "the model was sent a tool list");
    assert.equal(tools.includes("dispute_test"), false, "dispute_test is not offered");
    const dispute = results(s).find((r) => r.tool === "dispute_test");
    assert.ok(dispute === undefined || dispute.isError, "calling it fails");
  });
});

describe("T203 ACCEPTANCE: the orchestrator resolver", () => {
  it("a spawned implementer's dispute reaches the parent session, and the child ends disputed", async () => {
    const s = await runScriptedSession({
      env: NO_TEST_CONTEXT,
      config: config(),
      setup: sealedWorkspace,
      extra: { specialist: "build", subagents: true },
      script: [
        reply(mounted("agent", { prompt: "make the sealed tests pass", description: "implement", subagent_type: "build", model: SCRIPTED_MODEL })),
        reply(DISPUTE_ADDS),
        reply(IMPLEMENT_SUB),
        reply(COMMIT("implement sub")),
        reply(say("child done")),
        reply(say("done")),
      ],
    });
    assert.equal(s.unusedSteps, 0, "the child ran its whole script");
    const agent = results(s).find((r) => r.tool === "agent");
    assert.ok(agent, "the parent got the child's result");
    assert.ok(agent.text.includes(REASON), `the dispute's reason reaches the parent:\n${agent.text}`);
    assert.match(agent.text, /adds/);
    assert.match(agent.text, /disputed/);
  });
});
