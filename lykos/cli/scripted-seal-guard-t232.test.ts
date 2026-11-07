// T232 (#18) ACCEPTANCE: the seal guard, in a real session.
//
// Seam 1, the scripted session: the session, its tools, the seal extension and the gate are the real ones; only the
// model is scripted. The seal is made by the real `lykos seal` commands in the scripted workspace before the session
// starts. The shell writes are real: `python -c` when python is on the machine, `node -e` always.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { call, mounted, reply, runScriptedSession, say, toolResults, type ModelContext } from "./scripted-session.js";

const cliPath = join(import.meta.dirname, "..", "cli.ts");
const tsxImport = import.meta.resolve("tsx");

const STUB = "export function add(a, b) { return 0; }\n";
const REAL = "export function add(a, b) { return a + b; }\n";
const RED_TEST =
  'import { describe, it } from "node:test";\n' +
  'import assert from "node:assert/strict";\n' +
  'import { add } from "../src/add.mjs";\n' +
  'describe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n';
const SEALED = "test/add.test.mjs";

function config(enforceFor: string[] = []): string {
  return [
    "seal:",
    "  base: main",
    '  test_command: "node --test {files}"',
    ...(enforceFor.length > 0 ? [`  enforce_for: [${enforceFor.join(", ")}]`] : []),
    "containment:",
    "  level: off",
    "feedback:",
    "  enabled: false",
    "gate:",
    '  command: "node -e 0"',
    "",
  ].join("\n");
}

function gitEnv(): NodeJS.ProcessEnv {
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
  return execFileSync(cmd, args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
}

function lykos(cwd: string, ...args: string[]): void {
  const res = spawnSync(process.execPath, ["--import", tsxImport, cliPath, ...args], { cwd, env: gitEnv(), encoding: "utf8", timeout: 120_000 });
  assert.equal(res.status, 0, `lykos ${args.join(" ")}:\n${res.stdout}\n${res.stderr}`);
}

function put(ws: string, rel: string, text: string): void {
  mkdirSync(dirname(join(ws, rel)), { recursive: true });
  writeFileSync(join(ws, rel), text);
}

/** main: config tracked and a trusted key; branch feat: a red test and its stub, sealed. `custom` adds a project specialist. */
function sealedWorkspace(opts: { custom?: string } = {}) {
  return (ws: string): void => {
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    sh(ws, "git", "add", "-A");
    sh(ws, "git", "commit", "-q", "-m", "track config");
    lykos(ws, "seal", "key", "init");
    sh(ws, "git", "checkout", "-q", "-b", "feat");
    put(ws, "src/add.mjs", STUB);
    put(ws, SEALED, RED_TEST);
    sh(ws, "git", "add", "-A");
    sh(ws, "git", "commit", "-q", "-m", "red: add");
    lykos(ws, "seal", "create");
    if (opts.custom !== undefined) {
      put(ws, `.lykos/specialists/${opts.custom}.yaml`, "description: A custom writable specialist.\nrole: all\nread_only: false\ninstructions: |\n  Implement what the tests ask.\n");
    }
  };
}

const NO_TEST_CONTEXT = { NODE_TEST_CONTEXT: undefined };

function resultsOf(sent: ModelContext[]) {
  return toolResults(sent[sent.length - 1]!);
}

function pythonName(): string | undefined {
  for (const name of ["python", "python3"]) {
    const r = spawnSync(name, ["-c", "print(40 + 2)"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "42") return name;
  }
  return undefined;
}

const PYTHON = pythonName();
const WRITES: Array<{ name: string; command: string }> = [
  { name: "node -e", command: `node -e "require('fs').writeFileSync('${SEALED}', '// gone\\n')"` },
  ...(PYTHON === undefined ? [] : [{ name: `${PYTHON} -c`, command: `${PYTHON} -c "open('${SEALED}', 'w').write('# gone')"` }]),
];

describe("T232 ACCEPTANCE: a sealed test changed through an interpreter is restored", () => {
  for (const write of WRITES) {
    it(`${write.name}: restored, the tool result says so, SEALED-EDIT is on record, and the session continues`, async () => {
      const s = await runScriptedSession({
        env: NO_TEST_CONTEXT,
        config: config(),
        setup: sealedWorkspace(),
        extra: { specialist: "build" },
        script: [
          reply(call("bash", { command: write.command })),
          reply(call("write", { path: "src/add.mjs", content: REAL })),
          reply(call("commit", { message: "implement add" })),
          reply(say("done")),
        ],
      });
      assert.equal(s.result.status, "ok", JSON.stringify(s.result));
      const [bash, write2, commit] = resultsOf(s.sent);
      assert.match(bash!.text, /SEALED-EDIT/, bash!.text);
      assert.match(bash!.text, /restored/, bash!.text);
      assert.match(bash!.text, /dispute_test/, bash!.text);
      assert.equal(s.file(SEALED)?.replace(/\r\n/g, "\n"), RED_TEST, "the sealed test is back");

      // The session continued: its next calls ran, said nothing about the seal, and the honest work was verified.
      for (const later of [write2, commit]) {
        assert.ok(later);
        assert.equal(later.isError, false, later.text);
        assert.doesNotMatch(later.text, /SEALED-EDIT/);
      }
      assert.equal(s.unusedSteps, 0);
      assert.equal(s.session().outcome, "success", s.show());

      const rows = s.query<{ kind: string; detail: string }>("SELECT kind, detail FROM seal_events WHERE session_id = ? AND kind = 'restored'", s.sessionId);
      assert.equal(rows.length, 1);
      assert.equal((JSON.parse(rows[0]!.detail) as { flag: string }).flag, "SEALED-EDIT");
    });
  }
});

describe("T232 ACCEPTANCE: who is enforced", () => {
  it("a custom writable specialist is enforced: the write is vetoed and the interpreter write restored, with seal.enforce_for empty", async () => {
    const s = await runScriptedSession({
      env: NO_TEST_CONTEXT,
      config: config(),
      setup: sealedWorkspace({ custom: "my-implementer" }),
      extra: { specialist: "my-implementer" },
      script: [
        reply(call("write", { path: SEALED, content: "// emptied\n" })),
        reply(call("bash", { command: WRITES[0]!.command })),
        reply(say("done")),
      ],
    });
    const [write, bash] = resultsOf(s.sent);
    assert.equal(write!.isError, true, write!.text);
    assert.match(write!.text, /dispute_test/);
    assert.match(bash!.text, /SEALED-EDIT/, bash!.text);
    assert.equal(s.file(SEALED)?.replace(/\r\n/g, "\n"), RED_TEST);
  });

  it("a shell write the parser sees is vetoed before it runs", async () => {
    const s = await runScriptedSession({
      env: NO_TEST_CONTEXT,
      config: config(),
      setup: sealedWorkspace(),
      extra: { specialist: "build" },
      script: [reply(call("bash", { command: `echo '// gone' > ${SEALED}` })), reply(say("done"))],
    });
    const [bash] = resultsOf(s.sent);
    assert.equal(bash!.isError, true, bash!.text);
    assert.match(bash!.text, /dispute_test/);
    assert.equal(s.file(SEALED)?.replace(/\r\n/g, "\n"), RED_TEST);
    const kinds = s.query<{ kind: string }>("SELECT kind FROM seal_events WHERE session_id = ?", s.sessionId).map((r) => r.kind);
    assert.equal(kinds.filter((k) => k === "vetoed").length, 1, `seal_events: ${kinds}`);
    assert.ok(!kinds.includes("restored"), "vetoed before it ran, so there was nothing to restore");
  });

  it("a seal.writers specialist writes the sealed test freely", async () => {
    const s = await runScriptedSession({
      env: NO_TEST_CONTEXT,
      config: config(),
      setup: sealedWorkspace(),
      extra: { specialist: "test-writer" },
      script: [reply(call("bash", { command: WRITES[0]!.command })), reply(say("done"))],
    });
    const [bash] = resultsOf(s.sent);
    assert.doesNotMatch(bash!.text, /SEALED-EDIT/, bash!.text);
    assert.equal(s.file(SEALED)?.replace(/\r\n/g, "\n"), "// gone\n");
  });
});

describe("T232 ACCEPTANCE: a staged sealed edit and a job's edit are caught", () => {
  it("a staged edit written back in the tree is restored in the index", async () => {
    const script = [
      "const fs = require('fs'); const cp = require('child_process');",
      `const o = fs.readFileSync('${SEALED}', 'utf8');`,
      `fs.writeFileSync('${SEALED}', '// staged\\n');`,
      `cp.execFileSync('git', ['add', '${SEALED}']);`,
      `fs.writeFileSync('${SEALED}', o);`,
    ].join(" ");
    const s = await runScriptedSession({
      env: NO_TEST_CONTEXT,
      config: config(),
      setup: sealedWorkspace(),
      extra: { specialist: "build" },
      script: [reply(call("bash", { command: `node -e "${script}"` })), reply(say("done"))],
    });
    const [bash] = resultsOf(s.sent);
    assert.match(bash!.text, /SEALED-EDIT/, bash!.text);
    assert.equal(sh(s.workspace, "git", "diff", "--cached", "--name-only"), "", "the index is clean");
  });

  it("a background job that edits the sealed test: the edit is gone by the model's next tool result", async () => {
    const s = await runScriptedSession({
      env: NO_TEST_CONTEXT,
      config: config(),
      setup: sealedWorkspace(),
      extra: { specialist: "build" },
      script: [
        // The job writes 1.5 s in, after the start call's own tool result has been checked and while the next call waits.
        reply(mounted("hub", { op: "start", command: `node -e "setTimeout(() => require('fs').writeFileSync('${SEALED}', '// by a job'), 1500)"` })),
        // The job ends while this call waits.
        reply(call("bash", { command: 'node -e "setTimeout(() => {}, 4500)"' })),
        reply(say("done")),
      ],
    });
    const [, wait] = resultsOf(s.sent);
    assert.match(wait!.text, /SEALED-EDIT/, wait!.text);
    assert.equal(s.file(SEALED)?.replace(/\r\n/g, "\n"), RED_TEST);
    const rows = s.query<{ detail: string }>("SELECT detail FROM seal_events WHERE session_id = ? AND kind = 'restored'", s.sessionId);
    assert.ok(rows.length >= 1);
    const sources = rows.map((r) => (JSON.parse(r.detail) as { source: string }).source);
    assert.ok(sources.includes("job_end"), `the job's end was where it was caught: ${sources}`);
  });
});
