// T155: every tool a declared Pi extension registers reaches the model.
// A test Pi extension, written against Pi's own API and installed in the
// scripted Pi host, registers one tool at load and tries to register another
// after the session has started. Read from what the model was sent and from
// the tool result it got back.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultExtensionVersion } from "../extensions/defaults/index.js";
import { call, lastToolResult, reply, runScriptedSession, say, scriptedPiHost, type ModelContext } from "./scripted-session.js";

const EXTENSION = `
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool({
    name: "demo_shout",
    label: "Shout",
    description: "Say the text back in capitals.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: "SHOUT:" + String(params.text).toUpperCase() }], details: {} };
    },
  });
  // Registered after boot froze the tool list: it must never reach the wire.
  pi.on("turn_end", () => {
    pi.registerTool({
      name: "demo_late",
      label: "Late",
      description: "Registered mid-session.",
      parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text", text: "late" }], details: {} }; },
    });
  });
}
`;

function install(): void {
  const dir = join(scriptedPiHost(), "npm", "node_modules", "demo-pi-tools");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo-pi-tools", version: "1.0.0", type: "module" }));
  writeFileSync(join(dir, "index.js"), EXTENSION);
}

const wire = (c: ModelContext) => (c.tools ?? []).map((t) => t.name);
const head = (c: ModelContext) => (/^tools: (.*)$/m.exec(c.systemPrompt ?? "")?.[1] ?? "").split(",");
const V = defaultExtensionVersion();

describe("a declared Pi extension's tools reach the model (T155)", () => {
  it("its tool is on the wire and in the head, the model can call it, and the list never changes mid-session", async () => {
    install();
    const lists: string[][] = [];
    const run = await runScriptedSession({
      config: ["extensions:", `  - { name: lykos-self-compact, version: ${V} }`, "  - { name: demo-pi-tools, version: 1.0.0 }", ""].join("\n"),
      script: [
        (context) => {
          assert.ok(wire(context).includes("demo_shout"), wire(context).join(","));
          assert.ok(head(context).includes("demo_shout"), "the frozen head lists the admitted tool");
          lists.push(wire(context));
          return reply(call("demo_shout", { text: "hello" }));
        },
        (context) => {
          assert.equal(lastToolResult(context).text, "SHOUT:HELLO");
          assert.ok(!wire(context).includes("demo_late"), "a tool registered after boot never reaches the wire");
          lists.push(wire(context));
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.deepEqual(lists[1], lists[0], "the tool list never changes mid-session");
  });

  it("the self-compact tools arrive through the same general path when that strategy is active", async () => {
    const run = await runScriptedSession({
      config: `context_strategy: self-compact\nself_compact:\n  models:\n    faux/scripted-1: { notice: 100k, warning: 200k, cutoff: 300k }\n`,
      contextWindow: 400_000,
      script: [
        (context) => {
          assert.ok(wire(context).includes("context_usage") && wire(context).includes("self_compact"), wire(context).join(","));
          assert.ok(head(context).includes("self_compact"));
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
  });

  it("an extension switched off in config contributes no tools, even when installed", async () => {
    install();
    const run = await runScriptedSession({
      config: ["extensions:", `  - { name: lykos-self-compact, version: ${V} }`, ""].join("\n"),
      script: [
        (context) => {
          assert.ok(!wire(context).includes("demo_shout"), wire(context).join(","));
          return reply(say("done"));
        },
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
  });
});
