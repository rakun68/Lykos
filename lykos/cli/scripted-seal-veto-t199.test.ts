// T199 (#54) ACCEPTANCE: an implementer cannot edit a sealed test.
//
// Seam 1, the scripted session: the session is the real one; only the model is
// scripted. The seal itself is made by the real `lykos seal key init` and
// `lykos seal create` in the scripted workspace before the session starts, so
// the veto is tested against a real seal found through history.

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

function config(opts: { enforceFor?: string[]; extensions?: string } = {}): string {
  return [
    "seal:",
    "  base: main",
    '  test_command: "node --test {files}"',
    `  enforce_for: [${(opts.enforceFor ?? ["build"]).join(", ")}]`,
    "containment:",
    "  level: off",
    "gate:",
    "  enabled: false",
    ...(opts.extensions !== undefined ? [opts.extensions] : []),
    "",
  ].join("\n");
}

function sh(cwd: string, cmd: string, ...args: string[]): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
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

function lykos(cwd: string, ...args: string[]): void {
  const res = spawnSync(process.execPath, ["--import", tsxImport, cliPath, ...args], {
    cwd,
    env: gitEnv(),
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(res.status, 0, `lykos ${args.join(" ")}:\n${res.stdout}\n${res.stderr}`);
}

function put(ws: string, rel: string, text: string): void {
  mkdirSync(dirname(join(ws, rel)), { recursive: true });
  writeFileSync(join(ws, rel), text);
}

/** main: config tracked and a trusted key; branch feat: a red test and its stub, sealed unless `seal` is false. */
function sealedWorkspace(opts: { seal?: boolean; after?: (ws: string) => void } = {}) {
  return (ws: string): void => {
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    sh(ws, "git", "add", "-A");
    sh(ws, "git", "commit", "-q", "-m", "track config");
    lykos(ws, "seal", "key", "init");
    sh(ws, "git", "checkout", "-q", "-b", "feat");
    put(ws, "src/add.mjs", STUB);
    put(ws, "test/add.test.mjs", RED_TEST);
    sh(ws, "git", "add", "-A");
    sh(ws, "git", "commit", "-q", "-m", "red: add");
    if (opts.seal !== false) lykos(ws, "seal", "create");
    opts.after?.(ws);
  };
}

/** The bash tool inherits the environment; a node:test parent would make the child skip its files. */
const NO_TEST_CONTEXT = { NODE_TEST_CONTEXT: undefined };

const EDIT_TEST = call("edit", { path: "test/add.test.mjs", edits: [{ oldText: "add(1, 2), 3", newText: "add(1, 2), 0" }] });

function resultsOf(sent: ModelContext[]) {
  return toolResults(sent[sent.length - 1]!);
}

describe("T199 ACCEPTANCE: the veto", () => {
  it("refuses edit, write and a mounted ast_edit on a sealed path, pointing at dispute_test; bash runs with a warning; stubs stay editable", async () => {
    const s = await runScriptedSession({
      env: NO_TEST_CONTEXT,
      config: config(),
      setup: sealedWorkspace(),
      extra: { specialist: "build" },
      script: [
        reply(EDIT_TEST),
        reply(call("write", { path: "test/add.test.mjs", content: "// emptied\n" })),
        reply(mounted("ast_edit", { rules: [{ pattern: "add(1, 2)", replacement: "add(0, 0)" }], paths: ["test/add.test.mjs"] })),
        reply(call("bash", { command: "cat test/add.test.mjs" })),
        reply(call("write", { path: "src/add.mjs", content: REAL })),
        reply(say("done")),
      ],
    });
    const results = resultsOf(s.sent);
    const [edit, write, astEdit, bash, stub] = results;
    for (const [name, r] of [["edit", edit], ["write", write], ["ast_edit", astEdit]] as const) {
      assert.ok(r, `${name} produced no result`);
      assert.equal(r.isError, true, `${name} was not refused: ${r.text}`);
      assert.match(r.text, /seal/i, `${name}: ${r.text}`);
      assert.match(r.text, /dispute_test/, `${name}: ${r.text}`);
    }
    assert.ok(bash);
    assert.match(bash.text, /assert\.equal\(add\(1, 2\), 3\)/, "bash ran and printed the sealed file");
    assert.match(bash.text, /seal/i, "bash's result carries the sealed-path warning");
    assert.ok(stub);
    assert.equal(stub.isError, false, stub.text);

    assert.equal(s.file("test/add.test.mjs"), RED_TEST, "the sealed test is untouched");
    assert.equal(s.file("src/add.mjs"), REAL, "the stub was editable");

    const kinds = s.query<{ kind: string }>("SELECT kind FROM seal_events WHERE session_id = ?", s.sessionId).map((r) => r.kind);
    assert.equal(kinds.filter((k) => k === "vetoed").length, 3, `seal_events: ${kinds}`);
    assert.ok(kinds.includes("bash-warned"), `seal_events: ${kinds}`);
    assert.match(s.show(), /veto/i, "lykos show renders the vetoes");
  });

  it("still vetoes on a renamed branch and on a new branch made from the sealed one", async () => {
    const s = await runScriptedSession({
      env: NO_TEST_CONTEXT,
      config: config(),
      setup: sealedWorkspace({
        after: (ws) => {
          sh(ws, "git", "branch", "-m", "feat", "renamed");
          sh(ws, "git", "checkout", "-q", "-b", "offshoot");
        },
      }),
      extra: { specialist: "build" },
      script: [reply(EDIT_TEST), reply(say("done"))],
    });
    const [edit] = resultsOf(s.sent);
    assert.equal(edit!.isError, true, edit!.text);
    assert.match(edit!.text, /dispute_test/);
    assert.equal(s.file("test/add.test.mjs"), RED_TEST);
  });
});

describe("T199 ACCEPTANCE: no change where the seal does not apply", () => {
  it("a specialist not in enforce_for edits the sealed test freely", async () => {
    const s = await runScriptedSession({
      env: NO_TEST_CONTEXT,
      config: config({ enforceFor: ["implementer"] }),
      setup: sealedWorkspace(),
      extra: { specialist: "build" },
      script: [reply(EDIT_TEST), reply(say("done"))],
    });
    const [edit] = resultsOf(s.sent);
    assert.equal(edit!.isError, false, edit!.text);
    assert.match(s.file("test/add.test.mjs")!, /add\(1, 2\), 0/);
  });

  it("a branch without a seal sees no change", async () => {
    const s = await runScriptedSession({
      env: NO_TEST_CONTEXT,
      config: config(),
      setup: sealedWorkspace({ seal: false }),
      extra: { specialist: "build" },
      script: [reply(EDIT_TEST), reply(say("done"))],
    });
    const [edit] = resultsOf(s.sent);
    assert.equal(edit!.isError, false, edit!.text);
  });

  it("with lykos-seal removed from the extension list, nothing is vetoed", async () => {
    const s = await runScriptedSession({
      env: NO_TEST_CONTEXT,
      config: config({ extensions: "lykos_extensions: []" }),
      setup: sealedWorkspace(),
      extra: { specialist: "build" },
      script: [reply(EDIT_TEST), reply(say("done"))],
    });
    const [edit] = resultsOf(s.sent);
    assert.equal(edit!.isError, false, edit!.text);
    assert.match(s.file("test/add.test.mjs")!, /add\(1, 2\), 0/);
  });
});

describe("T199 ACCEPTANCE: the recorded test command is allowed without asking", () => {
  const TEST_CMD = "node --test test/add.test.mjs";
  // No --yes: a delegated session has nobody to ask, so every ask is a deny (ADR-0041).
  const DELEGATED = { delegated: true, trustSource: "stored", interactionMode: "auto" } as const;
  const deniedDetails = (s: { result: unknown }) =>
    ((s.result as { denied?: Array<{ detail?: string }> }).denied ?? []).map((d) => d.detail ?? "");

  it("in a delegated auto-mode session the recorded template over a sealed test file runs; other commands are decided as before", async () => {
    const s = await runScriptedSession({
      autoApprove: false,
      env: NO_TEST_CONTEXT,
      config: config(),
      setup: sealedWorkspace(),
      extra: { specialist: "build", ...DELEGATED },
      script: [
        reply(call("bash", { command: TEST_CMD })),
        reply(call("bash", { command: "node --test src/add.mjs" })),
        reply(call("bash", { command: "curl -s http://example.invalid" })),
        reply(say("done")),
      ],
    });
    const [run, nonTest, other] = resultsOf(s.sent);
    assert.doesNotMatch(run!.text, /is denied/, run!.text);
    assert.match(run!.text, /adds/, `the test command ran: ${run!.text}`);
    assert.match(nonTest!.text, /is denied/, "{files} is limited to test files");
    assert.match(other!.text, /is denied/, "a different command is still decided by the normal rules");
    assert.deepEqual(deniedDetails(s), ["node --test src/add.mjs", "curl -s http://example.invalid"]);
  });

  it("without a seal, or with lykos-seal removed, the same command is denied as today", async () => {
    for (const [label, cfg, setup] of [
      ["no seal", config(), sealedWorkspace({ seal: false })],
      ["extension removed", config({ extensions: "lykos_extensions: []" }), sealedWorkspace()],
    ] as const) {
      const s = await runScriptedSession({
        autoApprove: false,
        env: NO_TEST_CONTEXT,
        config: cfg,
        setup,
        extra: { specialist: "build", ...DELEGATED },
        script: [reply(call("bash", { command: TEST_CMD })), reply(say("done"))],
      });
      const [run] = resultsOf(s.sent);
      assert.match(run!.text, /is denied/, `${label}: ${run!.text}`);
    }
  });

  it("a specialist in neither writers nor enforce_for gets no allowance", async () => {
    const s = await runScriptedSession({
      autoApprove: false,
      env: NO_TEST_CONTEXT,
      config: config({ enforceFor: ["implementer"] }),
      setup: sealedWorkspace(),
      extra: { specialist: "build", ...DELEGATED },
      script: [reply(call("bash", { command: TEST_CMD })), reply(say("done"))],
    });
    const [run] = resultsOf(s.sent);
    assert.match(run!.text, /is denied/, run!.text);
  });
});
