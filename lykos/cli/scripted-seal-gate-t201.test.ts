// T201 (#56) ACCEPTANCE: the verification gate fails a session that changed a
// sealed test, however it changed.
//
// Seam 1, the scripted session. The seal is made by the real `lykos seal`
// commands in the workspace before the session starts. The gate's own command
// passes in every case (`node -e 0`), so what decides each outcome is the
// lykos-seal check: verify, then the green run of the sealed tests in a clean
// checkout of HEAD.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { call, reply, runScriptedSession, say, type ScriptedSession } from "./scripted-session.js";

const cliPath = join(import.meta.dirname, "..", "cli.ts").replace(/\\/g, "/");
const tsxImport = import.meta.resolve("tsx");
const LYKOS_IN_BASH = `node --import ${JSON.stringify(tsxImport)} ${JSON.stringify(cliPath)}`;

const STUB = "export function add(a, b) { return 0; }\n";
const REAL = "export function add(a, b) { return a + b; }\n";
const RED_TEST =
  'import { describe, it } from "node:test";\n' +
  'import assert from "node:assert/strict";\n' +
  'import { add } from "../src/add.mjs";\n' +
  'describe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n';

function config(gateCommand = "node -e 0"): string {
  return [
    "seal:",
    "  base: main",
    '  test_command: "node --test {files}"',
    "  enforce_for: [build]",
    "containment:",
    "  level: off",
    "feedback:",
    "  enabled: false",
    "gate:",
    `  command: ${JSON.stringify(gateCommand)}`,
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

/** main: tracked config and a trusted key; branch feat: a red test and its stub, sealed. */
function sealedWorkspace(ws: string): void {
  writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n*.local.mjs\n");
  sh(ws, "git", "add", "-A");
  sh(ws, "git", "commit", "-q", "-m", "track config");
  lykos(ws, "seal", "key", "init");
  sh(ws, "git", "checkout", "-q", "-b", "feat");
  put(ws, "src/add.mjs", STUB);
  put(ws, "test/add.test.mjs", RED_TEST);
  sh(ws, "git", "add", "-A");
  sh(ws, "git", "commit", "-q", "-m", "red: add");
  lykos(ws, "seal", "create");
}

const NO_TEST_CONTEXT = { NODE_TEST_CONTEXT: undefined };
const COMMIT = (message: string) => call("commit", { message });
const IMPLEMENT = call("write", { path: "src/add.mjs", content: REAL });

function session(script: ReturnType<typeof reply>[], gateCommand?: string): Promise<ScriptedSession> {
  return runScriptedSession({
    env: NO_TEST_CONTEXT,
    config: config(gateCommand),
    setup: sealedWorkspace,
    extra: { specialist: "build" },
    script: [...script, reply(say("done"))],
  });
}

const outcome = (s: ScriptedSession) => s.session().outcome;

describe("T201 ACCEPTANCE: the gate passes an honest implementation", () => {
  it("a committed implementation that turns the sealed test green ends success", async () => {
    const s = await session([reply(IMPLEMENT), reply(COMMIT("implement add"))]);
    assert.equal(outcome(s), "success", s.show());
  });
});

describe("T201 ACCEPTANCE: the gate fails a changed sealed test, however it changed", () => {
  it("through bash, uncommitted: the session ends failed and the failure names the file", async () => {
    const s = await session([
      reply(IMPLEMENT),
      reply(COMMIT("implement add")),
      reply(call("bash", { command: "node -e \"require('fs').writeFileSync('test/add.test.mjs', '// gone\\n')\"" })),
    ]);
    assert.equal(outcome(s), "fail");
    assert.match(s.show(), /test\/add\.test\.mjs/);
  });

  it("through bash and a commit made with git", async () => {
    const s = await session([
      reply(call("bash", { command: "node -e \"require('fs').writeFileSync('test/add.test.mjs', '// gone\\n')\"" })),
      reply(call("bash", { command: "git commit -qam weaken" })),
    ]);
    assert.equal(outcome(s), "fail");
    assert.match(s.show(), /test\/add\.test\.mjs/);
  });

  it("a sealed test the runner stopped collecting fails the gate", async () => {
    // The stub's module ends the test process before any test is collected.
    const s = await session([
      reply(call("write", { path: "src/add.mjs", content: "process.exit(0);\nexport function add() {}\n" })),
      reply(COMMIT("stop the runner")),
    ]);
    assert.equal(outcome(s), "fail", s.show());
  });

  it("an untracked file the runner would load cannot make a sealed test pass", async () => {
    // The committed stub re-exports from a gitignored file only this working tree has.
    const s = await session([
      reply(call("write", { path: "src/add.mjs", content: 'export { add } from "./impl.local.mjs";\n' })),
      reply(call("write", { path: "src/impl.local.mjs", content: REAL })),
      reply(COMMIT("implement through an ignored file")),
    ]);
    assert.equal(outcome(s), "fail", s.show());
  });

  it("an uncommitted implementation does not count: the green run is a clean checkout of HEAD", async () => {
    const s = await session([reply(IMPLEMENT)]);
    assert.equal(outcome(s), "fail", s.show());
  });

  it("a seal made inside the implementer's session is rejected, including one made through bash running lykos seal create", async () => {
    const s = await session([
      // A genuine new red test, so `seal create` succeeds inside the session.
      reply(call("bash", { command: "node -e \"require('fs').writeFileSync('test/twice.test.mjs', 'import { it } from \\\"node:test\\\"; import assert from \\\"node:assert/strict\\\"; import { add } from \\\"../src/add.mjs\\\"; it(\\\"twice\\\", () => { assert.equal(add(2, 2), 4); });\\n')\"" })),
      reply(call("bash", { command: "git add -A && git commit -qm 'red: twice'" })),
      reply(call("bash", { command: `${LYKOS_IN_BASH} seal create` })),
      reply(IMPLEMENT),
      reply(COMMIT("implement add")),
    ]);
    assert.equal(outcome(s), "fail", s.show());
    const kinds = s.query<{ kind: string }>("SELECT kind FROM seal_events WHERE session_id = ?", s.sessionId).map((r) => r.kind);
    assert.ok(kinds.includes("rejected"), `the in-session seal is rejected: ${kinds}`);
  });
});

describe("T201 ACCEPTANCE: what the gate reports", () => {
  it("no gate check can turn a failure into success", async () => {
    const s = await session([reply(IMPLEMENT), reply(COMMIT("implement add"))], 'node -e "process.exit(1)"');
    assert.equal(outcome(s), "fail");
  });

  it("an uncontained session's lykos show states the weaker guarantee", async () => {
    const s = await session([reply(IMPLEMENT), reply(COMMIT("implement add"))]);
    assert.match(s.show(), /weaker|not contained|uncontained/i);
  });

  it("the seal verdict is in the ledger", async () => {
    const s = await session([
      reply(call("bash", { command: "node -e \"require('fs').writeFileSync('test/add.test.mjs', '// gone\\n')\"" })),
    ]);
    const kinds = s.query<{ kind: string }>("SELECT kind FROM seal_events WHERE session_id = ?", s.sessionId).map((r) => r.kind);
    assert.ok(kinds.includes("tampered"), `seal_events: ${kinds}`);
  });
});
