// T263: rewind a live interactive session, code and conversation, through the
// scripted-model seam. A real interactive session in a real repository; what
// is checked is what a person could observe: the files on disk, what the model
// was sent next, the prompt put back in the input box, `lykos rewind`'s list,
// `lykos show`, and the ledger's calls.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AutoApproveGate } from "../gate/approval.js";
import { openLedgerSync } from "../ledger/use.js";
import { runInteractiveStandaloneSession, type LineSource } from "../session/interactive.js";
import { runRewindCli } from "./rewind.js";
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

const FILES = { "a.txt": "a0\n", "b.txt": "b0\n", "c.txt": "c0\n" };

/** Three prompts, each changing one file; the second through the shell. */
const THREE_TURNS: ScriptStep[] = [
  reply(call("write", { path: "a.txt", content: "a1\n" })),
  reply(say("wrote a")),
  reply(call("bash", { command: "echo b2 > b.txt" })),
  reply(say("wrote b")),
  reply(call("write", { path: "c.txt", content: "c3\n" })),
  reply(say("wrote c")),
];

function userTexts(context: ModelContext): string[] {
  return context.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
}

async function run(typed: string[], tail: ScriptStep[]) {
  const world = await scriptedWorld({ files: FILES, script: [...THREE_TURNS, ...tail] });
  const lines = new Lines(["first: change a", "second: change b", "third: change c", ...typed, "/exit"]);
  let out = "";
  const original = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  // Teed, never swallowed: the test runner reports through this process's stdout.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out += String(chunk);
    return (original as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    out += String(chunk);
    return (originalErr as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  let result;
  try {
    result = await runInteractiveStandaloneSession({
      workspace: world.workspace,
      ledgerPath: world.ledgerPath,
      model: SCRIPTED_MODEL,
      nativeProviders: [world.provider],
      lineSource: lines,
      approvalGate: new AutoApproveGate(),
      askOutcome: false,
    });
  } finally {
    process.stdout.write = original;
    process.stderr.write = originalErr;
  }
  world.check();
  assert.equal(result.status, "ok", `${JSON.stringify(result)}\n${out}`);
  const sessionId = result.status === "ok" ? result.sessionId : "";
  const file = (rel: string) => {
    const abs = join(world.workspace, rel);
    return existsSync(abs) ? readFileSync(abs, "utf8").replace(/\r\n/g, "\n") : undefined;
  };
  return {
    out,
    lines,
    file,
    sent: world.sent,
    unusedSteps: world.unusedSteps(),
    modelCalls: world.modelCalls(),
    show: () => captureStdout("lykos show", () => runShow(world.ledgerPath, sessionId, {})),
    rewindList: () => captureStdout("lykos rewind", () => runRewindCli(world.workspace, {})),
    calls: () => {
      const ledger = openLedgerSync(world.ledgerPath);
      try {
        return (ledger.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE session_id = ?").get(sessionId) as { n: number }).n;
      } finally {
        ledger.close();
      }
    },
  };
}

describe("rewind a live session (T263)", () => {
  it("code and conversation to turn two: files and conversation back, the third prompt in the input box, the next prompt answered from there", async () => {
    let next: ModelContext | undefined;
    const r = await run(["/rewind", "3", "1", "fourth: something else"], [
      (ctx) => {
        next = ctx;
        return reply(say("fresh"));
      },
    ]);
    assert.equal(r.unusedSteps, 0, r.out);
    assert.deepEqual([r.file("a.txt"), r.file("b.txt"), r.file("c.txt")], ["a1\n", "b2\n", "c0\n"]);
    assert.deepEqual(r.lines.prefilled, ["third: change c"]);
    const said = userTexts(next!);
    assert.ok(said.some((t) => t.includes("first: change a")), JSON.stringify(said));
    assert.ok(said.some((t) => t.includes("second: change b")), JSON.stringify(said));
    assert.ok(!said.some((t) => t.includes("third: change c")), "the undone turn is not in the request");
    assert.ok(!JSON.stringify(next!.messages).includes("c3"), "nor is its tool call");

    const safety = /the tree you had is checkpoint ([0-9a-f]{8})/.exec(r.out)?.[1];
    assert.ok(safety !== undefined, r.out);
    assert.match(r.rewindList(), new RegExp(`\\b${safety}\\b`), "the safety checkpoint is listed by lykos rewind");

    const show = r.show();
    assert.match(show, /undone branch/i);
    assert.match(show, /third: change c/, "the undone prompt is still in the transcript");
    assert.equal(r.calls(), 7, "the undone turn's calls still count");
  });

  it("conversation only leaves the files as they are", async () => {
    let next: ModelContext | undefined;
    const r = await run(["/rewind", "3", "2", "fourth"], [
      (ctx) => {
        next = ctx;
        return reply(say("ok"));
      },
    ]);
    assert.deepEqual([r.file("a.txt"), r.file("b.txt"), r.file("c.txt")], ["a1\n", "b2\n", "c3\n"]);
    assert.deepEqual(r.lines.prefilled, ["third: change c"]);
    assert.ok(!userTexts(next!).some((t) => t.includes("third: change c")));
  });

  it("code only leaves the conversation", async () => {
    let next: ModelContext | undefined;
    const r = await run(["/rewind", "2", "3", "fourth"], [
      (ctx) => {
        next = ctx;
        return reply(say("ok"));
      },
    ]);
    assert.deepEqual([r.file("a.txt"), r.file("b.txt"), r.file("c.txt")], ["a1\n", "b0\n", "c0\n"]);
    assert.deepEqual(r.lines.prefilled, []);
    assert.ok(userTexts(next!).some((t) => t.includes("third: change c")), "the conversation keeps every turn");
    assert.doesNotMatch(r.show(), /undone branch/i);
  });

  it("cancel changes nothing", async () => {
    const r = await run(["/rewind", "3", ""], []);
    assert.deepEqual([r.file("a.txt"), r.file("b.txt"), r.file("c.txt")], ["a1\n", "b2\n", "c3\n"]);
    assert.deepEqual(r.lines.prefilled, []);
    assert.equal(r.unusedSteps, 0);
  });
});
