// T264: rewind past a `lykos resume`, through the scripted-model seam. A real
// interactive session in a real repository, resumed through `lykos resume`'s
// own preflight and plan, and rewound to a prompt from before the resume. What
// is checked is what a person could observe: the picker, the files on disk,
// what the rebuilt session's first request carried, the prompt put back in the
// input box, the ledger's rows and `lykos show`.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AutoApproveGate } from "../gate/approval.js";
import { openLedgerSync } from "../ledger/use.js";
import { runInteractiveStandaloneSession, type LineSource, type ResumePlan } from "../session/interactive.js";
import { runResume } from "./resume.js";
import { runShow } from "./show.js";
import { call, captureStdout, reply, say, SCRIPTED_MODEL, scriptedWorld, type ModelContext, type ScriptStep } from "./scripted-session.js";

/** Typed lines, and what the session put back in the input box. */
class Lines implements LineSource {
  readonly prefilled: string[] = [];
  constructor(private readonly lines: string[]) {}
  async next(): Promise<string | null> {
    return this.lines.shift() ?? null;
  }
  prefill(text: string): void {
    this.prefilled.push(text);
  }
  close(): void {
    this.lines.length = 0;
  }
}

/** Stdout and stderr are teed, never swallowed: the test runner reports through them. */
async function teed<T>(fn: () => Promise<T>): Promise<{ value: T; out: string }> {
  let out = "";
  const original = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  const tee =
    (to: typeof original) =>
    (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
      out += String(chunk);
      return (to as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    };
  process.stdout.write = tee(original) as typeof process.stdout.write;
  process.stderr.write = tee(originalErr) as typeof process.stderr.write;
  try {
    return { value: await fn(), out };
  } finally {
    process.stdout.write = original;
    process.stderr.write = originalErr;
  }
}

function userTexts(context: ModelContext): string[] {
  return context.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

const FILES = { "a.txt": "a0\n", "b.txt": "b0\n", "c.txt": "c0\n" };

/**
 * A session of `before` typed lines, ended, then `lykos resume` on it; each launch the resume makes
 * (a rewind past the resume makes a second) types the next of `launches`.
 */
async function resumed(before: string[], launches: string[][], script: ScriptStep[]) {
  const world = await scriptedWorld({ files: FILES, script });
  const inputs: Lines[] = [];
  const plans: ResumePlan[] = [];
  const session = (lines: Lines, resume?: ResumePlan) =>
    runInteractiveStandaloneSession({
      workspace: world.workspace,
      ledgerPath: world.ledgerPath,
      model: SCRIPTED_MODEL,
      nativeProviders: [world.provider],
      lineSource: lines,
      approvalGate: new AutoApproveGate(),
      askOutcome: false,
      ...(resume !== undefined ? { resume } : {}),
    });

  const first = await teed(() => session(new Lines([...before, "/exit"])));
  assert.equal(first.value.status, "ok", first.out);
  const sessionId = first.value.status === "ok" ? first.value.sessionId : "";

  const launched: string[] = [];
  const resume = await teed(() =>
    runResume(world.workspace, world.ledgerPath, sessionId, {
      yes: true,
      launch: async (input) => {
        const lines = new Lines([...(launches[inputs.length] ?? []), "/exit"]);
        inputs.push(lines);
        plans.push(input.resume);
        const result = await session(lines, input.resume);
        if (result.status !== "ok") return { status: "error", message: result.message };
        launched.push(result.sessionId);
        return { status: "ok", sessionId: result.sessionId, ...(result.rewindRebuild !== undefined ? { rewindRebuild: result.rewindRebuild } : {}) };
      },
    }),
  );
  world.check();
  assert.equal(resume.value, 0, resume.out);
  const out = first.out + resume.out;
  assert.equal(world.unusedSteps(), 0, out);
  const ledger = openLedgerSync(world.ledgerPath);
  let rows: number;
  try {
    rows = (ledger.db.prepare("SELECT COUNT(*) AS n FROM sessions").get() as { n: number }).n;
  } finally {
    ledger.close();
  }
  const file = (rel: string) => {
    const abs = join(world.workspace, rel);
    return existsSync(abs) ? readFileSync(abs, "utf8").replace(/\r\n/g, "\n") : undefined;
  };
  return {
    out,
    sessionId,
    launched,
    inputs,
    plans,
    rows,
    file,
    show: () => captureStdout("lykos show", () => runShow(world.ledgerPath, sessionId, {})),
  };
}

describe("rewind past a resume (T264)", () => {
  it("two turns, resumed, one more: the picker lists all three; code and conversation to the second rebuilds the session there, same id", async () => {
    let original: ModelContext | undefined;
    let rebuilt: ModelContext | undefined;
    const r = await resumed(
      ["first: change a", "second: change b"],
      [["third: change c", "/rewind", "2", "1"], ["fourth: something else"]],
      [
        (ctx) => {
          original = ctx;
          return reply(call("write", { path: "a.txt", content: "a1\n" }));
        },
        reply(say("wrote a")),
        reply(call("bash", { command: "echo b2 > b.txt" })),
        reply(say("wrote b")),
        reply(call("write", { path: "c.txt", content: "c3\n" })),
        reply(say("wrote c")),
        (ctx) => {
          rebuilt = ctx;
          return reply(say("fresh"));
        },
      ],
    );

    // Each prompt took two turns; the resumed process numbered its own after the earlier ones.
    assert.match(r.out, /1 {2}first: change a {2}\(turn 0\)/);
    assert.match(r.out, /2 {2}second: change b {2}\(turn 2\)/);
    assert.match(r.out, /3 {2}third: change c {2}\(turn 4\)/);

    assert.deepEqual([r.file("a.txt"), r.file("b.txt"), r.file("c.txt")], ["a1\n", "b0\n", "c0\n"], "the tree from before turn 2");
    assert.deepEqual(r.launched, [r.sessionId, r.sessionId], "rebuilt under the same id");
    assert.equal(r.rows, 1, "no new session row");
    assert.deepEqual(r.inputs[1]!.prefilled, ["second: change b"], "the prompt goes back in the input box");

    const said = userTexts(rebuilt!);
    const sent = JSON.stringify(rebuilt!.messages);
    assert.ok(said.some((t) => t.includes("first: change a")), "the turns before the prompt are replayed");
    assert.doesNotMatch(sent, /second: change b|third: change c|echo b2|c3/, "the undone turns are not");
    assert.ok(said.some((t) => t.includes("fourth: something else")));

    // The ordinary frozen head, with the replay after it, as a resume has it.
    assert.equal(rebuilt!.systemPrompt, original!.systemPrompt, "the head is the one the session first ran with");
    assert.doesNotMatch(rebuilt!.systemPrompt ?? "", /first: change a/, "the replay is not in the head");
    assert.match(said[0] ?? "", /replayed so this one can continue it[\s\S]*first: change a/);

    const show = r.show();
    assert.match(show, /undone branch: turns 2-5/);
    assert.match(show, /second: change b/);
    assert.match(show, /third: change c/);
  });

  it("conversation only to a prompt from before the resume leaves the files", async () => {
    let rebuilt: ModelContext | undefined;
    const r = await resumed(
      ["first", "second"],
      [["third", "/rewind", "1", "2"], ["again"]],
      [
        reply(say("one")),
        reply(say("two")),
        reply(call("write", { path: "c.txt", content: "c3\n" })),
        reply(say("three")),
        (ctx) => {
          rebuilt = ctx;
          return reply(say("fresh"));
        },
      ],
    );
    assert.equal(r.file("c.txt"), "c3\n");
    assert.deepEqual(r.inputs[1]!.prefilled, ["first"]);
    const said = userTexts(rebuilt!);
    assert.ok(!said.some((t) => /\bfirst\b|\bsecond\b|\bthird\b/.test(t.replace(/\[user\] again/, ""))), JSON.stringify(said));
  });

  it("a resume after a rewind replays the active branch, not the turns the rewind undid", async () => {
    let next: ModelContext | undefined;
    const r = await resumed(
      ["first: keep", "second: undo me", "/rewind", "2", "2", "second: instead"],
      [["third"]],
      [
        reply(say("one")),
        reply(say("undone")),
        reply(say("two")),
        (ctx) => {
          next = ctx;
          return reply(say("three"));
        },
      ],
    );
    const sent = JSON.stringify(next!.messages);
    assert.match(sent, /first: keep/);
    assert.match(sent, /second: instead/);
    assert.doesNotMatch(sent, /undo me/);
    assert.equal(r.plans[0]!.firstTurn, 3, "three turns ran before the resume, the undone one included");
  });
});
