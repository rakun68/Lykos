// T159: `edited_files` lists the files an `ast_edit` or an `lsp` rename
// actually changed — read from each tool's result, not its arguments. A
// rewrite over a glob used to record the glob, and a rename recorded only the
// file it was called on. Every assertion reads the ledger.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { HIT_QUALITY_VERSION } from "../session/hit-quality.js";
import { call, mounted, reply, runScriptedSession, say } from "./scripted-session.js";

function lspConfig(): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("typescript-language-server/package.json");
  const cli = join(dirname(pkg), "lib", "cli.mjs");
  const server = { command: process.execPath, args: [cli, "--stdio"], extensions: [".ts"] };
  return `lsp:\n  servers:\n    typescript: ${JSON.stringify(server)}\n`;
}

function editedPaths(run: { session(): Record<string, unknown> }): string[] {
  const row = run.session();
  return (JSON.parse(String(row.edited_files ?? "[]")) as Array<{ path: string }>).map((f) => f.path);
}

const HI = (n: string) => `export const ${n} = () => "hi " + "${n}";\n`;

describe("T159: edited_files names the files a multi-file edit changed", () => {
  it("an ast_edit over a glob that changes two files records those two files, not the glob", async () => {
    const run = await runScriptedSession({
      files: { "src/a.ts": HI("a"), "src/b.ts": HI("b"), "src/c.ts": "export const c = 1;\n" },
      script: [
        reply(mounted("ast_edit", { rules: [{ pattern: '"hi " + $N', replacement: '"salute " + $N' }], paths: ["src/*.ts"] })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.deepEqual(editedPaths(run), ["src/a.ts", "src/b.ts"]);
    assert.equal(run.session().edited_file_count, 2);
    assert.equal(run.session().hit_quality_version, HIT_QUALITY_VERSION);
  });

  it("an lsp rename that touches three files records all three", async () => {
    const run = await runScriptedSession({
      files: {
        "a.ts": 'export function greet(name: string): string {\n  return "hi " + name;\n}\n',
        "b.ts": 'import { greet } from "./a.js";\n\nexport const line = greet("world");\n',
        "c.ts": 'import { greet } from "./a.js";\n\nexport const other = greet("there");\n',
        "tsconfig.json": JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true } }),
        "package.json": JSON.stringify({ name: "lykos-t159-fixture", type: "module" }),
      },
      config: lspConfig(),
      script: [
        reply(mounted("lsp", { action: "rename", file: "a.ts", line: 1, symbol: "greet", new_name: "welcome" })),
        reply(say("renamed")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.match(run.file("c.ts") ?? "", /welcome\("there"\)/, "the rename reached the third file");
    assert.deepEqual(editedPaths(run), ["a.ts", "b.ts", "c.ts"]);
  });

  it("a call that changes nothing records nothing, and other tools' edited files are unchanged", async () => {
    const run = await runScriptedSession({
      files: { "src/a.ts": "export const a = 1;\n", "notes.txt": "one\n" },
      script: [
        reply(mounted("ast_edit", { rules: [{ pattern: '"hi " + $N', replacement: '"salute " + $N' }], paths: ["src"] })),
        reply(call("write", { path: "notes.txt", content: "two\n" })),
        reply(say("done")),
      ],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    assert.equal(run.unusedSteps, 0);
    assert.deepEqual(editedPaths(run), ["notes.txt"]);
  });
});
