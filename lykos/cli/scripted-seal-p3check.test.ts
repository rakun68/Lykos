// P3 diff check (p3check2): two gaps found after the phase was built, set up as in T204.
//
// 1. dispute_test resealed without the active seal's branch, so on a detached HEAD (a delegated
//    worktree) sealCreate refused and an upheld dispute left the test parked.
// 2. `lykos show --json` left out the seal events that the text view lists.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { call, reply, runScriptedSession, say, toolResults, type ModelContext, type ScriptedSession, type ScriptStep } from "./scripted-session.js";

const cliPath = join(import.meta.dirname, "..", "cli.ts").replace(/\\/g, "/");
const tsxImport = import.meta.resolve("tsx");

const STUB = "export function add(a, b) { return 0; }\nexport function sub(a, b) { return 0; }\n";
const SUB_ONLY = "export function add(a, b) { return 0; }\nexport function sub(a, b) { return a - b; }\n";
const BOTH = "export function add(a, b) { return a + b; }\nexport function sub(a, b) { return a - b; }\n";
const testFile = (expected: number) =>
  'import { describe, it } from "node:test";\n' +
  'import assert from "node:assert/strict";\n' +
  'import { add, sub } from "../src/math.mjs";\n' +
  'describe("math", () => {\n' +
  `  it("adds", () => { assert.equal(add(1, 2), ${expected}); });\n` +
  '  it("subtracts", () => { assert.equal(sub(3, 1), 2); });\n' +
  "});\n";
const RED_TEST = testFile(4);
const FIXED_TEST = testFile(3);

const REASON = "1 + 2 is 3, the test expects 4";
const EVIDENCE = "node -e 'console.log(1 + 2)' prints 3";
const RULING = "the spec says add saturates at 4; implement the saturation";
const DISPUTE_ADDS = call("dispute_test", { file: "test/math.test.mjs", describe: ["math"], name: "adds", reason: REASON, evidence: EVIDENCE });
const IMPLEMENT = (content: string) => call("write", { path: "src/math.mjs", content });
const COMMIT = (message: string) => call("commit", { message });

function config(): string {
  return [
    "seal:",
    "  base: main",
    '  test_command: "node --test {files}"',
    "  enforce_for: [build]",
    "  writers: [test-writer]",
    "  resolver: test-writer",
    "  escalate_after: 1",
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

function lykos(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const res = spawnSync(process.execPath, ["--import", tsxImport, cliPath, ...args], { cwd, env: env(), encoding: "utf8", timeout: 120_000 });
  return { status: res.status, out: `${res.stdout}\n${res.stderr}` };
}

function put(ws: string, rel: string, text: string): void {
  mkdirSync(dirname(join(ws, rel)), { recursive: true });
  writeFileSync(join(ws, rel), text);
}

function sealedWorkspace(ws: string, detach = false): void {
  writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
  sh(ws, "git", "add", "-A");
  sh(ws, "git", "commit", "-q", "-m", "track config");
  assert.equal(lykos(ws, "seal", "key", "init").status, 0);
  sh(ws, "git", "checkout", "-q", "-b", "feat");
  put(ws, "src/math.mjs", STUB);
  put(ws, "test/math.test.mjs", RED_TEST);
  sh(ws, "git", "add", "-A");
  sh(ws, "git", "commit", "-q", "-m", "red: math");
  const made = lykos(ws, "seal", "create");
  assert.equal(made.status, 0, made.out);
  if (detach) sh(ws, "git", "checkout", "-q", "--detach");
}

function userText(context: ModelContext): string {
  const first = context.messages.find((m) => m.role === "user");
  const content = first?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? (content as Array<{ text?: string }>).map((b) => b.text ?? "").join("\n") : "";
}

/** The first step of the test writer's child: it is given the dispute, and it can write. */
function testWriterStarts(next: ReturnType<typeof reply>): ScriptStep {
  return (context) => {
    const prompt = userText(context);
    assert.ok(prompt.includes(REASON), `the reason reaches the test writer:\n${prompt}`);
    assert.ok(prompt.includes(EVIDENCE), "the evidence reaches the test writer");
    assert.match(prompt, /test\/math\.test\.mjs/);
    assert.match(prompt, /adds/);
    const tools = (context.tools ?? []).map((t) => t.name);
    assert.ok(tools.includes("write"), `the test writer's child can write: ${tools.join(",")}`);
    return next;
  };
}

function session(script: ScriptStep[], detach = false): Promise<ScriptedSession> {
  return runScriptedSession({
    env: { NODE_TEST_CONTEXT: undefined },
    config: config(),
    setup: (ws) => sealedWorkspace(ws, detach),
    extra: { specialist: "build" },
    script: [...script, reply(say("done"))],
  });
}

function disputeResults(s: ScriptedSession): Array<{ text: string; isError: boolean }> {
  const seen = new Set<string>();
  const out: Array<{ text: string; isError: boolean }> = [];
  for (const ctx of s.sent) {
    for (const r of toolResults(ctx)) {
      if (r.tool !== "dispute_test" || seen.has(r.text)) continue;
      seen.add(r.text);
      out.push(r);
    }
  }
  return out;
}

const sealKinds = (s: ScriptedSession) =>
  s.query<{ kind: string }>("SELECT kind FROM seal_events WHERE session_id = ? ORDER BY rowid", s.sessionId).map((r) => r.kind);

const taskState = (s: ScriptedSession) =>
  s.query<{ state: string }>("SELECT t.state FROM tasks t JOIN sessions s ON s.task_id = t.id WHERE s.id = ?", s.sessionId)[0]?.state;

const UPHOLD: ScriptStep[] = [
  reply(DISPUTE_ADDS),
  // --- the test writer's child session ---
  testWriterStarts(reply(call("write", { path: "test/math.test.mjs", content: FIXED_TEST }))),
  reply(COMMIT("fix the adds expectation")),
  reply(say("UPHELD: the expectation was wrong, add(1, 2) is 3")),
  // --- back to the implementer ---
  reply(IMPLEMENT(BOTH)),
  reply(COMMIT("implement add and sub")),
];

describe("P3 diff check: dispute reseal and show --json", () => {
  it("an upheld dispute reseals on a detached HEAD, under the active seal's branch", async () => {
    const s = await session(UPHOLD, true);
    const [answer] = disputeResults(s);
    assert.ok(answer, "dispute_test returned");
    assert.doesNotMatch(answer.text, /Failed to reseal/, answer.text);
    assert.match(answer.text, /upheld/i);
    assert.ok(sealKinds(s).includes("dispute upheld"), `seal_events: ${sealKinds(s)}`);
    const verified = lykos(s.workspace, "seal", "verify");
    assert.equal(verified.status, 0, `the resealed seal verifies:
${verified.out}`);
  });

  it("lykos show --json carries the session's seal events", async () => {
    const s = await session(UPHOLD);
    const out = JSON.parse(s.show({ json: true })) as { seal_events?: Array<{ kind: string; paths: unknown }> };
    assert.ok(Array.isArray(out.seal_events), `seal_events in --json: ${Object.keys(out).join(",")}`);
    const kinds = out.seal_events.map((e) => e.kind);
    assert.deepEqual(kinds, sealKinds(s), "the same events as the ledger, in order");
    assert.ok(kinds.includes("dispute upheld"), `kinds: ${kinds}`);
  });
});
