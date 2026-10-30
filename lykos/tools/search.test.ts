// The search-and-navigation four.
//
// Two kinds of test here, and the split is deliberate. The parity tests
// compare each catalog row against the LIVE Pi definition rather than
// against a transcription of it, because the whole value of the row is that
// it prices what actually goes on the wire — a row nobody checks against the
// runtime is a number that drifts silently, and this test found exactly that
// drift in `ls` the first time it ran. The grep test runs the real
// ripgrep-backed tool over real files on disk.

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import {
  GLOB_DESCRIPTION,
  buildGlobTool,
  buildFindTool,
  buildLsTool,
  buildGrepTool,
} from "./search.js";

const CWD = process.cwd();

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Pi's definitions return `parameters` as a typebox object; the catalog stores plain JSON. */
function asJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

interface TextResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

async function run(tool: unknown, params: unknown): Promise<TextResult> {
  const def = tool as { execute: (...args: unknown[]) => Promise<TextResult> };
  return await def.execute("call-1", params, undefined, undefined, undefined);
}

function textOf(result: TextResult): string {
  return result.content?.[0]?.text ?? "";
}

describe("P10.4 D5: the catalog prices what Pi actually sends", () => {
  it("grep, find and ls rows equal the live Pi definitions", () => {
    const live = {
      grep: createGrepToolDefinition(CWD),
      find: createFindToolDefinition(CWD),
      ls: createLsToolDefinition(CWD),
    };
    for (const [name, def] of Object.entries(live)) {
      const row = TOOL_CATALOG[name];
      assert.ok(row, `catalog missing ${name}`);
      assert.equal(row.description, (def as { description: string }).description, `${name} description`);
      assert.deepEqual(row.parameters, asJson((def as { parameters: unknown }).parameters), `${name} parameters`);
      assert.equal(row.source, "pi-builtin");
    }
  });

  it("the powershell row equals Pi's live shell definition", () => {
    const def = createPowerShellToolDefinition(CWD) as unknown as { description: string; parameters: unknown };
    const row = TOOL_CATALOG.powershell;
    assert.ok(row);
    assert.equal(row.description, def.description);
    assert.deepEqual(row.parameters, asJson(def.parameters));
    // Same schema as `bash`: Pi builds both from one `createShellToolDefinition`.
    assert.deepEqual(row.parameters, TOOL_CATALOG.bash!.parameters);
  });

  it("the glob row is Lykos's description over Pi's find parameters (D1)", () => {
    const row = TOOL_CATALOG.glob;
    assert.ok(row);
    assert.equal(row.description, GLOB_DESCRIPTION);
    assert.equal(row.source, "lykos");
    // The parameters are `find`'s, because the implementation is `find`'s.
    const find = createFindToolDefinition(CWD) as unknown as { parameters: unknown };
    assert.deepEqual(row.parameters, asJson(find.parameters));
    assert.deepEqual(row.parameters, TOOL_CATALOG.find!.parameters);
    // ...and the description is not, because the name is not.
    assert.notEqual(row.description, TOOL_CATALOG.find!.description);
  });

  it("all five are measurable together — an unpriced tool would make the whole toolset NULL", () => {
    const m = measureToolset(["grep", "glob", "powershell", "find", "ls"]);
    assert.equal(m.complete, true);
    assert.deepEqual(m.unknown, []);
    assert.ok((m.tokens ?? 0) > 0);
  });
});

describe("P10.4 D1: glob is find under a second name", () => {
  it("renames the tool and rewrites the description, and changes nothing else", () => {
    const find = createFindToolDefinition(CWD) as unknown as { parameters: unknown };
    const glob = buildGlobTool(CWD) as unknown as { name: string; description: string; parameters: unknown };
    assert.equal(glob.name, "glob");
    assert.equal(glob.description, GLOB_DESCRIPTION);
    assert.deepEqual(asJson(glob.parameters), asJson(find.parameters));
  });

  it("finds the same files Pi's find finds, because it is Pi's find", async () => {
    const dir = tmp("lykos-p104-glob-");
    try {
      mkdirSync(join(dir, "src"));
      writeFileSync(join(dir, "src", "one.ts"), "x\n", "utf8");
      writeFileSync(join(dir, "src", "two.js"), "x\n", "utf8");
      const glob = buildGlobTool(dir);
      const find = buildFindTool(dir);
      const viaGlob = textOf(await run(glob, { pattern: "**/*.ts" }));
      const viaFind = textOf(await run(find, { pattern: "**/*.ts" }));
      assert.equal(viaGlob, viaFind);
      assert.match(viaGlob, /one\.ts/);
      assert.doesNotMatch(viaGlob, /two\.js/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ls lists a directory", async () => {
    const dir = tmp("lykos-p104-ls-");
    try {
      writeFileSync(join(dir, "kept.txt"), "x\n", "utf8");
      const out = textOf(await run(buildLsTool(dir), {}));
      assert.match(out, /kept\.txt/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("T168: grep is Pi's grep, with no tag header", () => {
  it("is the same definition as Pi's, schema object included", () => {
    const ours = buildGrepTool(CWD) as unknown as { name: string; parameters: unknown };
    const pi = createGrepToolDefinition(CWD) as unknown as { name: string; parameters: unknown };
    assert.equal(ours.name, pi.name);
    assert.equal(ours.parameters, pi.parameters);
  });

  it("prints a file's matches under no [path#TAG] line, for the anchored editor that is gone", async () => {
    const dir = tmp("lykos-t168-grep-");
    try {
      writeFileSync(join(dir, "target.ts"), "const alpha = 1;\nconst beta = 2;\n", "utf8");
      const out = textOf(await run(buildGrepTool(dir), { pattern: "alpha" }));
      assert.match(out, /target\.ts:1: const alpha = 1;/);
      assert.doesNotMatch(out, /#[0-9A-F]{4}\]/);
      assert.doesNotMatch(out, /\[target\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
