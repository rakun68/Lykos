// T163: every slash command a session registered is offered by Tab, whatever
// registered it — built-ins, skills, Lykos extension commands and Pi
// extension commands — each labelled with its source. A real terminal-UI
// session boots with one of each (plus `lykos-self-compact`, whose
// `/self-compact` is registered through Pi's `registerCommand`), and Tab's own
// candidate source is read afterwards.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultExtensionVersion } from "../extensions/defaults/index.js";
import { AutoApproveGate } from "../gate/approval.js";
import { runInteractiveStandaloneSession, type LineSource } from "../session/interactive.js";
import { completeCommand, renderCompletionPopup } from "../tui/screen/completion.js";
import { resolveTheme } from "../tui/theme/resolve.js";
import { reply, say, SCRIPTED_MODEL, scriptedPiHost, scriptedWorld } from "./scripted-session.js";

class Lines implements LineSource {
  constructor(private readonly lines: string[]) {}
  async next(): Promise<string | null> {
    return this.lines.shift() ?? null;
  }
  close(): void {
    this.lines.length = 0;
  }
}

function installPackage(name: string, files: Record<string, string>): void {
  const dir = join(scriptedPiHost(), "npm", "node_modules", name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
}

const V = defaultExtensionVersion();

describe("every slash command is in Tab completion (T163)", () => {
  it("offers built-ins, skills, Lykos extension commands and Pi extension commands, each with its source", async () => {
    // A Pi extension, written against Pi's own API. Its `/help` collides with
    // the built-in and can never run, so it is reported rather than offered.
    installPackage("demo-pi-cmd", {
      "index.js": [
        "export default function (pi) {",
        '  pi.registerCommand("pi-hello", { description: "Say hello from Pi", handler: async () => {} });',
        '  pi.registerCommand("help", { description: "shadowed by the built-in", handler: async () => {} });',
        "}",
        "",
      ].join("\n"),
    });
    installPackage("demo-lykos-cmd", {
      "index.js": [
        "export default {",
        "  register(api) {",
        '    api.registerCommand({ name: "lykos-hello", description: "Say hello from a Lykos extension", run: () => "hello" });',
        "  },",
        "};",
        "",
      ].join("\n"),
    });
    const world = await scriptedWorld({
      files: {
        ".lykos/skills/handy.md": "---\nname: handy\ndescription: A skill that is handy\n---\n\nBe handy.\n",
      },
      config: [
        "context_strategy: self-compact",
        "self_compact:",
        "  models:",
        "    faux/scripted-1: { notice: 100k, warning: 200k, cutoff: 300k }",
        "extensions:",
        `  - { name: lykos-self-compact, version: ${V} }`,
        "  - { name: demo-pi-cmd, version: 1.0.0 }",
        "lykos_extensions:",
        "  - { name: demo-lykos-cmd, version: 1.0.0 }",
        "",
      ].join("\n"),
      contextWindow: 400_000,
      script: [reply(say("hello"))],
    });

    const original = process.stderr.write.bind(process.stderr);
    let stderr = "";
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      stderr += String(chunk);
      return (original as (c: string | Uint8Array, ...r: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof process.stderr.write;
    let result;
    try {
      result = await runInteractiveStandaloneSession({
        workspace: world.workspace,
        ledgerPath: world.ledgerPath,
        model: SCRIPTED_MODEL,
        nativeProviders: [world.provider],
        lineSource: new Lines(["hi", "/exit"]),
        approvalGate: new AutoApproveGate(),
      });
    } finally {
      process.stderr.write = original;
    }
    world.check();
    assert.equal(result.status, "ok", JSON.stringify(result));

    // What Tab offers after `/`, read from the session's own rosters.
    const offered = new Map(completeCommand("/").map((c) => [c.label, c]));
    const expect = (name: string, source: string, extension?: string) => {
      const c = offered.get(name);
      assert.ok(c !== undefined, `${name} is offered by Tab; got ${[...offered.keys()].join(" ")}`);
      assert.equal(c.source, source, name);
      if (extension !== undefined) assert.equal(c.extension, extension, name);
    };
    expect("/self-compact", "pi-extension", "lykos-self-compact");
    expect("/pi-hello", "pi-extension", "demo-pi-cmd");
    expect("/lykos-hello", "extension", "demo-lykos-cmd");
    expect("/handy", "skill");
    expect("/help", "builtin");
    assert.deepEqual(completeCommand("/self").map((c) => c.label), ["/self-compact"], "prefix completion finds it");

    // Each row shows where it came from.
    const popup = renderCompletionPopup(completeCommand("/self"), { width: 120, theme: resolveTheme("mono", "none", "unicode") }).join("\n");
    assert.match(popup, /\/self-compact.*\[pi ext lykos-self-compact\]/);
    const lykosRow = renderCompletionPopup(completeCommand("/lykos-h"), { width: 120, theme: resolveTheme("mono", "none", "unicode") }).join("\n");
    assert.match(lykosRow, /\/lykos-hello.*\[lykos ext demo-lykos-cmd\]/);

    // The colliding Pi `/help` is not silently dropped: the session said so.
    assert.equal([...offered.values()].filter((c) => c.label === "/help").length, 1);
    assert.match(stderr, /lykos: \/help from the Pi extension demo-pi-cmd is shadowed by the built-in \/help; typing it runs the built-in/);
  });
});
