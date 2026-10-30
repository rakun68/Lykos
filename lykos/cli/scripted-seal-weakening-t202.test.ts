// T202 (#57) ACCEPTANCE: the weakening scan.
//
// Seam 1, the scripted session, in a workspace sealed by the real `lykos seal`
// commands. The implementation is honest in every case (the sealed test turns
// green), so what fails each session is the scan over the lines added outside
// the seal since the seal commit.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { call, reply, runScriptedSession, say, type ScriptedSession } from "./scripted-session.js";

const cliPath = join(import.meta.dirname, "..", "cli.ts");
const tsxImport = import.meta.resolve("tsx");

const STUB = "export function add(a, b) { return 0; }\n";
const REAL = "export function add(a, b) { return a + b; }\n";
const RED_TEST =
  'import { describe, it } from "node:test";\n' +
  'import assert from "node:assert/strict";\n' +
  'import { add } from "../src/add.mjs";\n' +
  'describe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n';

function config(extra: string[] = []): string {
  return [
    "seal:",
    "  base: main",
    '  test_command: "node --test {files}"',
    "  enforce_for: [build]",
    ...extra,
    "containment:",
    "  level: off",
    "feedback:",
    "  enabled: false",
    "gate:",
    '  command: "node -e 0"',
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

function sealedWorkspace(ws: string): void {
  writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
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

const COMMIT = call("commit", { message: "implement add" });

/** An honest implementation plus `files`, committed, in an enforced session. */
function session(files: Record<string, string>, extraConfig: string[] = []): Promise<ScriptedSession> {
  const writes = Object.entries({ "src/add.mjs": REAL, ...files }).map(([path, content]) => reply(call("write", { path, content })));
  return runScriptedSession({
    env: { NODE_TEST_CONTEXT: undefined },
    config: config(extraConfig),
    setup: sealedWorkspace,
    extra: { specialist: "build" },
    script: [...writes, reply(COMMIT), reply(say("done"))],
  });
}

const outcome = (s: ScriptedSession) => s.session().outcome;

const OWN_TEST = (body: string) => `import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\n${body}\n`;

describe("T202 ACCEPTANCE: each default pattern added outside the seal fails the gate, named", () => {
  const cases: Array<[label: string, file: string, content: string, pattern: RegExp]> = [
    ["an added .skip", "test/extra.test.mjs", OWN_TEST('describe("extra", () => { it.skip("later", () => { assert.ok(false); }); });'), /\.skip/],
    ["an added .only", "test/extra.test.mjs", OWN_TEST('describe.only("extra", () => { it("one", () => { assert.ok(true); }); });'), /\.only/],
    ["an added xit", "test/extra.test.mjs", 'const xit = () => {};\nxit("never", () => {});\n', /xit/],
    ["process.env.VITEST in source", "src/mode.mjs", "export const testing = Boolean(process.env.VITEST);\n", /VITEST/],
    ["process.env.NODE_TEST_CONTEXT in source", "src/mode.mjs", "export const testing = Boolean(process.env.NODE_TEST_CONTEXT);\n", /NODE_TEST_CONTEXT/],
    ["a NODE_ENV test check in source", "src/mode.mjs", 'export const testing = process.env.NODE_ENV === "test";\n', /NODE_ENV/],
  ];
  for (const [label, file, content, pattern] of cases) {
    it(label, async () => {
      const s = await session({ [file]: content });
      assert.equal(outcome(s), "fail", s.show());
      const shown = s.show();
      assert.ok(shown.includes(file), `the failure names ${file}:\n${shown}`);
      assert.match(shown, pattern, "the failure names the pattern");
    });
  }
});

describe("T202 ACCEPTANCE: configuration and the clean case", () => {
  it("a project-added pattern is caught", async () => {
    const s = await session({ "src/flag.mjs": "export const FORCE_PASS = true;\n" }, ["  weakening_patterns: [\"FORCE_PASS\"]"]);
    assert.equal(outcome(s), "fail", s.show());
    assert.match(s.show(), /src\/flag\.mjs/);
    assert.match(s.show(), /FORCE_PASS/);
  });

  it("a session with no match is unaffected", async () => {
    const s = await session({ "test/extra.test.mjs": OWN_TEST('describe("extra", () => { it("adds zero", async () => { const { add } = await import("../src/add.mjs"); assert.equal(add(0, 0), 0); }); });') });
    assert.equal(outcome(s), "success", s.show());
  });

  it("a pattern already present at the seal commit is not counted: only added lines are scanned", async () => {
    const s = await runScriptedSession({
      env: { NODE_TEST_CONTEXT: undefined },
      config: config(),
      setup: (ws) => {
        sealedWorkspace(ws);
        put(ws, "src/legacy.mjs", 'export const legacy = process.env.NODE_ENV === "test";\n');
        sh(ws, "git", "add", "-A");
        sh(ws, "git", "commit", "-q", "-m", "legacy, before the implementer");
        // Reseal so the legacy line predates the seal commit.
        lykos(ws, "seal", "create");
      },
      extra: { specialist: "build" },
      script: [reply(call("write", { path: "src/add.mjs", content: REAL })), reply(COMMIT), reply(say("done"))],
    });
    assert.equal(outcome(s), "success", s.show());
  });
});
