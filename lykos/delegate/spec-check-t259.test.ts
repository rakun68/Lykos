// T259 ACCEPTANCE (ADR-0061, spec decision 24): the spec check is a writable delegated session's first step.
//
// Seams:
//   - `specCheckRefusal`, the rule the harness applies to a tool call before the check is recorded, on real call shapes.
//   - The real `lykos session-child` (runSessionChild + runStandaloneTask) on Pi's scripted model, in a real repository:
//     the edit, write and shell-write refusals reach the model as tool results, the check's points are asked of the
//     coordinator as question frames before the first edit, and the ledger holds the check afterwards.
//   - The MCP server over an in-memory transport with a stand-in runner, for what the result and status show.
//
// Lessons held here: `spec_vague` (Boxie's cause: a task too vague to build, found only after the code), R5 (the check's
// result comes from the tool, never from text the model wrote: a model that only says it checked is still refused),
// R7 (not applicable: no separate session, so no step budget to mis-record).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { runSessionChild } from "../cli/session-child.js";
import { call, lastToolResult, reply, say, SCRIPTED_MODEL, scriptedProvider, scriptedWorld, type ModelContext, type ScriptStep } from "../cli/scripted-session.js";
import { withLedgerSync } from "../ledger/use.js";
import { runStandaloneTask } from "../session/session.js";
import { parseTaskFile } from "./task-file.js";
import { renderRulings, rulingsOf, specCheckOf, specCheckRefusal } from "./spec-check.js";
import { encodeFrame, PROTOCOL_VERSION, type SessionRequest } from "./session-protocol.js";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "demo");

// ---------------------------------------------------------------------------
// The rule, on real call shapes

describe("T259: what is refused until the check is recorded", () => {
  it("refuses an edit, a write, an AST edit and a commit, direct or through tool_call", () => {
    for (const [tool, input] of [
      ["edit", { path: "a.txt", edits: [{ oldText: "one", newText: "two" }] }],
      ["write", { path: "a.txt", content: "two\n" }],
      ["ast_edit", { path: "a.txt", pattern: "x", replacement: "y" }],
      ["commit", { message: "m" }],
      ["tool_call", { name: "write", arguments: { path: "a.txt", content: "two\n" } }],
    ] as const) {
      const reason = specCheckRefusal(tool, input);
      assert.ok(reason !== undefined, `${tool} is refused`);
      assert.match(reason, /spec check/, `${tool}: the reason says why`);
      assert.match(reason, /spec_checked/, `${tool}: the reason says what to call`);
    }
  });

  it("refuses a shell command that is not provably a read, in bash and powershell", () => {
    for (const command of [
      "echo hi > b.txt",
      "cat a.txt >> b.txt",
      "rm a.txt",
      "sed -i s/one/two/ a.txt",
      `python -c "open('a.txt','w').write('x')"`,
      "git commit -am x",
      "npm test",
      "tee b.txt",
    ]) {
      for (const tool of ["bash", "powershell"]) {
        assert.match(specCheckRefusal(tool, { command }) ?? "", /spec check/, `${tool}: ${command}`);
      }
      assert.match(specCheckRefusal("tool_call", { name: "bash", arguments: { command } }) ?? "", /spec check/, `tool_call bash: ${command}`);
    }
  });

  it("lets the session read, search and record, and ask, before the check", () => {
    for (const [tool, input] of [
      ["read", { path: "a.txt" }],
      ["grep", { pattern: "x" }],
      ["find", { pattern: "*.ts" }],
      ["ls", { path: "." }],
      ["claim", { text: "t", check: { kind: "command", command: "node -v", exit: 0 } }],
      ["ask_coordinator", { question: "q?" }],
      ["give_up", { question: "q?" }],
      ["spec_checked", { undecided: [] }],
      ["bash", { command: "ls -la" }],
      ["bash", { command: "cat src/a.ts | head -5" }],
      ["bash", { command: "git log --oneline" }],
      ["bash", { command: "grep -rn foo src" }],
    ] as const) {
      assert.equal(specCheckRefusal(tool, input), undefined, `${tool} ${JSON.stringify(input)} is not refused`);
    }
  });
});

// ---------------------------------------------------------------------------
// The real child on the scripted model

const QUIET = "feedback:\n  enabled: false\ngate:\n  enabled: false\n";
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();
}

type World = Awaited<ReturnType<typeof scriptedWorld>>;

interface Driven {
  frames: Array<Record<string, unknown>>;
  result: Record<string, unknown>;
  sessionId: string;
}

let counter = 0;

/** Runs one request in the real child; answers each question frame with `answer(question)`. */
async function drive(
  world: Pick<World, "workspace" | "ledgerPath" | "provider">,
  overrides: Partial<SessionRequest>,
  answer: (question: string) => string = () => "unused",
): Promise<Driven> {
  const sessionId = overrides.newSessionId ?? `t259-${process.pid}-${++counter}`;
  const request: SessionRequest = {
    version: PROTOCOL_VERSION,
    tool: "lykos_implement",
    workspace: world.workspace,
    prompt: "do it",
    label: "lykos_implement",
    containment: "off",
    model: SCRIPTED_MODEL,
    ...(overrides.sessionId === undefined ? { newSessionId: sessionId } : {}),
    ...overrides,
  };
  const input = new PassThrough();
  const frames: Array<Record<string, unknown>> = [];
  input.write(encodeFrame(request));
  await runSessionChild({
    input,
    write: (text) => {
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        frames.push(frame);
        if (frame.type === "question") input.write(`${JSON.stringify({ type: "steer", message: answer(String(frame.question)) })}\n`);
      }
    },
    env: { LYKOS_TRUST_WORKSPACE: "1", LYKOS_TRUST_SOURCE: "flag" },
    trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t259-store-")), "trust.json"),
    worktreesRoot: mkdtempSync(join(tmpdir(), "lykos-t259-wt-")),
    runTask: (task) => runStandaloneTask(task),
    sessionExtras: { nativeProviders: [world.provider], ledgerPath: world.ledgerPath },
  });
  input.end();
  const last = frames.at(-1) as { type?: string; result?: Record<string, unknown> } | undefined;
  assert.equal(last?.type, "result", JSON.stringify(frames.slice(-3)));
  return { frames, result: last!.result!, sessionId: overrides.sessionId ?? sessionId };
}

/** Does the session's branch hold this file? The worktree is gone by the time a test looks. */
function branchHas(world: Pick<World, "workspace">, sessionId: string, path: string): boolean {
  try {
    git(world.workspace, "cat-file", "-e", `lykos/${sessionId}:${path}`);
    return true;
  } catch {
    return false;
  }
}

function branchFile(world: Pick<World, "workspace">, sessionId: string, path: string): string | undefined {
  try {
    return execFileSync("git", ["show", `lykos/${sessionId}:${path}`], { cwd: world.workspace, encoding: "utf8" });
  } catch {
    return undefined;
  }
}

/** Records the last tool result at this step, then runs the next reply. */
function seeing(into: Array<{ tool: string; text: string; isError: boolean }>, next: ScriptStep): ScriptStep {
  return (context: ModelContext) => {
    into.push(lastToolResult(context));
    return typeof next === "function" ? next(context) : next;
  };
}

describe("T259 ACCEPTANCE: an edit before spec_checked is refused with the reason", () => {
  it("an edit, a write and a shell write are refused in a real session, and run after the check", { timeout: 120_000 }, async () => {
    const seen: Array<{ tool: string; text: string; isError: boolean }> = [];
    const world = await scriptedWorld({
      config: QUIET,
      files: { "a.txt": "one\n" },
      script: [
        reply(call("write", { path: "b.txt", content: "early\n" })),
        seeing(seen, reply(call("edit", { path: "a.txt", edits: [{ oldText: "one", newText: "two" }] }))),
        seeing(seen, reply(call("bash", { command: "echo early > c.txt" }))),
        seeing(seen, reply(call("bash", { command: `python -c "open('d.txt','w').write('x')"` }))),
        seeing(seen, reply(call("spec_checked", { undecided: [] }))),
        seeing(seen, reply(call("write", { path: "b.txt", content: "late\n" }))),
        seeing(seen, reply(call("bash", { command: "echo late > c.txt" }))),
        seeing(seen, reply(say("done"))),
      ],
    });
    const run = await drive(world, {});
    world.check();
    assert.equal(world.unusedSteps(), 0);

    // write, edit, bash, python -c: each refused, with the reason, and nothing happened.
    const refused = seen.slice(0, 4);
    assert.deepEqual(refused.map((r) => r.tool), ["write", "edit", "bash", "bash"]);
    for (const r of refused) {
      assert.equal(r.isError, true, JSON.stringify(r));
      assert.match(r.text, /spec check/i, r.text);
      assert.match(r.text, /spec_checked/, r.text);
    }

    // After the check, the same kinds of call run.
    assert.equal(seen[4]!.tool, "spec_checked");
    assert.equal(seen[4]!.isError, false, JSON.stringify(seen[4]));
    assert.match(seen[4]!.text, /nothing undecided/i);
    assert.equal(seen[5]!.isError, false, JSON.stringify(seen[5]));
    // The shell write is no longer refused for want of the check (auto mode's own approval gate may still decide).
    assert.doesNotMatch(seen[6]!.text, /spec check/i, seen[6]!.text);

    assert.equal(branchFile(world, run.sessionId, "b.txt"), "late\n", "the early write never happened; the late one did");
    assert.equal(branchFile(world, run.sessionId, "a.txt"), "one\n", "the refused edit left the file alone");
    assert.equal(branchHas(world, run.sessionId, "c.txt"), false, "the refused shell write never ran");
    assert.equal(branchHas(world, run.sessionId, "d.txt"), false, "the refused python write never ran");

    // The ledger holds the check, with no points.
    const record = withLedgerSync(world.ledgerPath, (ledger) => specCheckOf(ledger, run.sessionId));
    assert.deepEqual(record?.points, []);
  });

  it("reading and searching are not refused before the check", { timeout: 120_000 }, async () => {
    const seen: Array<{ tool: string; text: string; isError: boolean }> = [];
    const world = await scriptedWorld({
      config: QUIET,
      files: { "a.txt": "one\n" },
      script: [
        reply(call("read", { path: "a.txt" })),
        seeing(seen, reply(call("bash", { command: "git log --oneline" }))),
        seeing(seen, reply(say("done"))),
      ],
    });
    await drive(world, {});
    world.check();
    assert.equal(seen[0]!.isError, false, JSON.stringify(seen[0]));
    assert.match(seen[0]!.text, /one/);
    assert.equal(seen[1]!.isError, false, JSON.stringify(seen[1]));
  });

  it("a model that says it checked, without the tool, is still refused (R5)", { timeout: 120_000 }, async () => {
    const seen: Array<{ tool: string; text: string; isError: boolean }> = [];
    const world = await scriptedWorld({
      config: QUIET,
      files: { "a.txt": "one\n" },
      script: [
        reply(say("Spec check: nothing is unclear. spec_checked recorded."), call("write", { path: "b.txt", content: "x\n" })),
        seeing(seen, reply(say("done"))),
      ],
    });
    const run = await drive(world, {});
    assert.equal(seen[0]!.isError, true, JSON.stringify(seen[0]));
    assert.equal(branchHas(world, run.sessionId, "b.txt"), false);
    assert.equal(withLedgerSync(world.ledgerPath, (ledger) => specCheckOf(ledger, run.sessionId)), undefined, "nothing was recorded from text");
  });

  it("delegation.spec_check: false turns the gate off, and the session has no spec_checked tool", { timeout: 120_000 }, async () => {
    const seen: Array<{ tool: string; text: string; isError: boolean }> = [];
    const world = await scriptedWorld({
      config: `${QUIET}delegation:\n  spec_check: false\n`,
      files: { "a.txt": "one\n" },
      script: [reply(call("write", { path: "b.txt", content: "now\n" })), seeing(seen, reply(say("done")))],
    });
    const run = await drive(world, {});
    world.check();
    assert.equal(seen[0]!.isError, false, JSON.stringify(seen[0]));
    assert.equal(branchFile(world, run.sessionId, "b.txt"), "now\n");
    const wire = (world.sent[0]?.tools ?? []).map((t) => t.name);
    assert.ok(!wire.includes("spec_checked"), `no spec_checked on the wire: ${wire.join(", ")}`);
    assert.equal(run.result.spec_check, undefined);
  });

  it("a read-only session has no spec_checked tool and is not gated", { timeout: 120_000 }, async () => {
    const world = await scriptedWorld({ config: QUIET, files: { "a.txt": "one\n" }, script: [reply(say("looked"))] });
    await drive(world, { tool: "lykos_review", label: "lykos_review", specialist: "review" });
    const wire = (world.sent[0]?.tools ?? []).map((t) => t.name);
    assert.ok(wire.length > 0);
    assert.ok(!wire.includes("spec_checked"), wire.join(", "));
    assert.ok(wire.includes("claim"), "reviewers still claim");
  });

  it("a session that recorded its check is not gated again when it continues", { timeout: 180_000 }, async () => {
    const world = await scriptedWorld({
      config: QUIET,
      files: { "a.txt": "one\n" },
      script: [reply(call("spec_checked", { undecided: [] })), reply(call("write", { path: "b.txt", content: "first\n" })), reply(say("done"))],
    });
    const first = await drive(world, {});
    world.check();
    assert.equal(first.result.outcome === "error", false, JSON.stringify(first.result));

    const seen: Array<{ tool: string; text: string; isError: boolean }> = [];
    const second = await scriptedProvider([reply(call("write", { path: "c.txt", content: "second\n" })), seeing(seen, reply(say("done again")))]);
    await drive({ workspace: world.workspace, ledgerPath: world.ledgerPath, provider: second.provider }, { sessionId: first.sessionId, prompt: "carry on" });
    second.check();
    assert.equal(seen[0]!.isError, false, `the continuation writes at once: ${JSON.stringify(seen[0])}`);
    assert.equal(branchFile(world, first.sessionId, "c.txt"), "second\n");
  });
});

describe("T259 ACCEPTANCE: the fixture's undecided point is asked before the first edit", () => {
  function fixtureFiles(): Record<string, string> {
    const files: Record<string, string> = {};
    const walk = (dir: string, rel: string): void => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const next = rel === "" ? name.name : `${rel}/${name.name}`;
        if (name.isDirectory()) walk(join(dir, name.name), next);
        else if (!next.startsWith("tasks/")) files[next] = readFileSync(join(dir, name.name), "utf8");
      }
    };
    walk(FIXTURE, "");
    return files;
  }

  it("spec_checked asks each point as a question frame, and the edit runs only after the ruling", { timeout: 120_000 }, async () => {
    const task = parseTaskFile(readFileSync(join(FIXTURE, "tasks", "05-undecided.md"), "utf8"));
    assert.ok(task.body.includes("splitBill"), "the real task file");
    const point = "When the bill does not divide evenly, which people get the extra cent?";
    const ruling = "The first people in the list get the extra cent, one each.";
    const seen: Array<{ tool: string; text: string; isError: boolean }> = [];
    const order: string[] = [];
    const world = await scriptedWorld({
      config: QUIET,
      files: fixtureFiles(),
      script: [
        reply(call("read", { path: "src/pricing.js" })),
        seeing(seen, reply(call("spec_checked", { undecided: [point] }))),
        seeing(seen, (context) => {
          order.push("model-sees-ruling");
          assert.match(lastToolResult(context).text, /first people in the list/);
          return reply(call("write", { path: "src/split.js", content: "export const split = () => [];\n" }));
        }),
        seeing(seen, reply(say("done"))),
      ],
    });
    const run = await drive(world, { prompt: task.body }, (q) => {
      order.push(`asked:${q}`);
      return ruling;
    });
    world.check();

    const questions = run.frames.filter((f) => f.type === "question").map((f) => f.question);
    assert.deepEqual(questions, [`Spec check: ${point}`], "the point went to the coordinator as a question");
    assert.deepEqual(order, [`asked:Spec check: ${point}`, "model-sees-ruling"], "asked before the model could edit");
    assert.equal(seen[1]!.tool, "spec_checked");
    assert.equal(seen[1]!.isError, false);
    assert.match(seen[1]!.text, new RegExp(ruling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(seen[2]!.isError, false, "the write after the ruling ran");

    const record = withLedgerSync(world.ledgerPath, (ledger) => specCheckOf(ledger, run.sessionId));
    assert.deepEqual(record?.points, [{ point, ruling }]);
  });

  it("an unanswered point is recorded without a ruling, and the session is told to decide alone", { timeout: 120_000 }, async () => {
    const seen: Array<{ tool: string; text: string; isError: boolean }> = [];
    const world = await scriptedWorld({
      config: QUIET,
      files: { "a.txt": "one\n" },
      script: [reply(call("spec_checked", { undecided: ["Which port?"] })), seeing(seen, reply(say("done")))],
    });
    const run = await drive(world, {}, () => "lykos: coordinator ask timed out; decide alone: proceed with what you have or give_up");
    assert.match(seen[0]!.text, /decide it alone/i);
    const record = withLedgerSync(world.ledgerPath, (ledger) => specCheckOf(ledger, run.sessionId));
    assert.deepEqual(record?.points, [{ point: "Which port?" }], "a timeout notice is not a ruling");
  });

  it("refuses a malformed check and records nothing", { timeout: 120_000 }, async () => {
    const seen: Array<{ tool: string; text: string; isError: boolean }> = [];
    const world = await scriptedWorld({
      config: QUIET,
      files: { "a.txt": "one\n" },
      script: [
        reply(call("spec_checked", { undecided: ["fine", ""] })),
        seeing(seen, reply(call("spec_checked", { undecided: Array.from({ length: 9 }, (_, i) => `point ${i}`) }))),
        seeing(seen, reply(call("write", { path: "b.txt", content: "x\n" }))),
        seeing(seen, reply(say("done"))),
      ],
    });
    const run = await drive(world, {});
    assert.match(seen[0]!.text, /non-empty/);
    assert.match(seen[0]!.text, /Nothing was recorded/);
    assert.match(seen[1]!.text, /at most 8/);
    assert.match(seen[1]!.text, /Nothing was recorded/);
    assert.equal(seen[2]!.isError, true, "still refused: nothing was recorded");
    assert.equal(withLedgerSync(world.ledgerPath, (ledger) => specCheckOf(ledger, run.sessionId)), undefined);
  });
});

describe("T259 ACCEPTANCE: an answered point reaches a later reviewer as a ruling", () => {
  it("a reviewer started with rulingsFrom is handed the implementer's rulings after its brief", { timeout: 180_000 }, async () => {
    const point = "Should the limit be inclusive?";
    const ruling = "Inclusive: a value equal to the limit passes.";
    const world = await scriptedWorld({
      config: QUIET,
      files: { "a.txt": "one\n" },
      script: [reply(call("spec_checked", { undecided: [point] })), reply(call("write", { path: "b.txt", content: "x\n" })), reply(say("done"))],
    });
    const implemented = await drive(world, {}, () => ruling);
    world.check();

    // The ledger side of the seam.
    const rulings = withLedgerSync(world.ledgerPath, (ledger) => rulingsOf(ledger, [implemented.sessionId]));
    assert.deepEqual(rulings, [{ session: implemented.sessionId, point, ruling }]);
    assert.match(renderRulings(rulings), /Ruling: Inclusive/);

    // The child side: a read-only reviewer, a new session, handed the rulings in its first message.
    const reviewer = await scriptedProvider([reply(say("reviewed"))]);
    await drive(
      { workspace: world.workspace, ledgerPath: world.ledgerPath, provider: reviewer.provider },
      { tool: "lykos_review", label: "lykos_review", specialist: "review", prompt: "review the change", rulingsFrom: [implemented.sessionId] },
    );
    reviewer.check();
    const firstMessage = JSON.stringify(reviewer.sent[0]?.messages ?? []);
    assert.match(firstMessage, /review the change/);
    assert.match(firstMessage, /# Rulings/);
    assert.match(firstMessage, new RegExp(point.replace(/[?]/g, "\\?")));
    assert.match(firstMessage, /Inclusive: a value equal to the limit passes\./);
    assert.ok(firstMessage.indexOf("review the change") < firstMessage.indexOf("# Rulings"), "the rulings follow the brief");
  });

  it("a session with no rulings adds nothing to the brief", { timeout: 120_000 }, async () => {
    const world = await scriptedWorld({ config: QUIET, files: { "a.txt": "one\n" }, script: [reply(say("looked"))] });
    await drive(world, { tool: "lykos_review", label: "lykos_review", specialist: "review", rulingsFrom: ["no-such-session"] });
    assert.doesNotMatch(JSON.stringify(world.sent[0]?.messages ?? []), /# Rulings/);
  });
});

