// T154: the frozen head's tool list, and the head contract's drift baseline,
// are the tools the model actually receives. Read from what the scripted
// model was sent on every request: the `tools:` line of the `## lykos-head`
// block against the tool definitions on the wire.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultExtensionVersion } from "../extensions/defaults/index.js";
import { AutoApproveGate } from "../gate/approval.js";
import { runInteractiveStandaloneSession, type LineSource } from "../session/interactive.js";
import {
  call,
  reply,
  runScriptedSession,
  say,
  SCRIPTED_MODEL,
  scriptedPiHost,
  scriptedWorld,
  type ModelContext,
  type ScriptStep,
} from "./scripted-session.js";

/** The `tools:` line of the head block, as a list. */
function headTools(context: ModelContext): string[] {
  const line = /^tools: (.*)$/m.exec(context.systemPrompt ?? "")?.[1];
  assert.ok(line !== undefined, "the head block states a tool list");
  return line.split(",");
}

function wireTools(context: ModelContext): string[] {
  return (context.tools ?? []).map((t) => t.name);
}

/** A step that checks the head names exactly the wire's tools, then replies. */
function checked(next: ReturnType<typeof reply>, heads: string[]): ScriptStep {
  return (context) => {
    assert.deepEqual(headTools(context), wireTools(context), "the head names exactly the tools on the wire");
    heads.push(context.systemPrompt ?? "");
    return next;
  };
}

class Lines implements LineSource {
  constructor(private readonly lines: string[]) {}
  async next(): Promise<string | null> {
    return this.lines.shift() ?? null;
  }
  close(): void {
    this.lines.length = 0;
  }
}

describe("the frozen head lists the tools the model actually has (T154)", () => {
  it("a scripted session: head equals wire on every request, the head is byte-identical, and no drift is reported", async () => {
    const heads: string[] = [];
    const run = await runScriptedSession({
      files: { "a.txt": "one\n" },
      script: [
        checked(reply(call("read", { path: "a.txt" })), heads),
        checked(reply(call("write", { path: "a.txt", content: "two\n" })), heads),
        checked(reply(say("done")), heads),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.equal(heads.length, 3);
    assert.ok(heads.every((h) => h === heads[0]), "the system prompt never moved");
    // No human channel here: the model is never told it can ask or leave plan mode.
    assert.ok(!headTools({ messages: [], systemPrompt: heads[0]! }).includes("ask"));
    assert.ok(!headTools({ messages: [], systemPrompt: heads[0]! }).includes("exit_plan"));
    assert.doesNotMatch(run.stderr, /head-drift/);
  });

  it("a session with a human channel: the head names ask, because the wire carries it", async () => {
    const heads: string[] = [];
    const world = await scriptedWorld({ script: [checked(reply(say("hello")), heads)] });
    let stderr = "";
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderr += String(chunk);
      return (original as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    try {
      const result = await runInteractiveStandaloneSession({
        workspace: world.workspace,
        ledgerPath: world.ledgerPath,
        model: SCRIPTED_MODEL,
        nativeProviders: [world.provider],
        lineSource: new Lines(["hi", "/exit"]),
        approvalGate: new AutoApproveGate(),
      });
      assert.equal(result.status, "ok", JSON.stringify(result));
    } finally {
      process.stderr.write = original;
    }
    world.check();
    assert.equal(heads.length, 1);
    assert.ok(headTools({ messages: [], systemPrompt: heads[0]! }).includes("ask"), heads[0]);
    assert.doesNotMatch(stderr, /head-drift/);
  });

  it("a tool list that really changes mid-session still triggers the drift warning", async () => {
    // A Pi extension that drops `grep` from the active tools after the first turn.
    const dir = join(scriptedPiHost(), "npm", "node_modules", "demo-tool-dropper");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "index.js"),
      'export default function (pi) {\n  pi.on("turn_end", () => pi.setActiveTools(pi.getActiveTools().filter((n) => n !== "grep")));\n}\n',
    );
    const V = defaultExtensionVersion();
    const run = await runScriptedSession({
      files: { "a.txt": "one\n" },
      config: [
        "extensions:",
        `  - { name: lykos-self-compact, version: ${V} }`,
        "  - { name: demo-tool-dropper, version: 1.0.0 }",
        "",
      ].join("\n"),
      script: [
        (context) => {
          assert.ok(wireTools(context).includes("grep"));
          return reply(call("read", { path: "a.txt" }));
        },
        (context) => {
          assert.ok(!wireTools(context).includes("grep"), "the extension really changed the wire");
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.match(run.stderr, /head-drift \(standalone\): changed field\(s\): toolNames/);
  });
});
