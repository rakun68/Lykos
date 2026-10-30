import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { detectVolatile } from "../session/head-contract.js";
import {
  DEFAULT_TOOL_RESULT_MAX_BYTES,
  DIET_HEADING,
  OUTPUT_DIET_HEADING,
  TRUNC_MARKER_PREFIX,
  ToolResultDiet,
  assembleDietHead,
  assembleOutputDietHead,
  capToolResultText,
  contextFileMeta,
  dietEnabledFromEnv,
  ingestContextFiles,
  loadContextFilesFromDir,
  outputDietEnabledFromEnv,
  resolveDietPolicy,
  toAgentsFiles,
  truncationMarker,
  unchangedMarker,
  utf8ByteLength,
  utf8Prefix,
  utf8Suffix,
} from "./prompt-diet.js";

const here = dirname(fileURLToPath(import.meta.url));

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lykos-diet-"));
}

describe("assembleDietHead (T21.1 rules stated once)", () => {
  it("is a frozen, non-volatile block that does not restate file bodies", () => {
    const a = assembleDietHead();
    const b = assembleDietHead();
    assert.equal(a, b);
    assert.equal(a.startsWith(DIET_HEADING), true);
    assert.match(a, /Do not restate them/);
    assert.match(a, /Do not resend unchanged file content/);
    assert.match(a, /\[lykos-trunc:\]/);
    assert.deepEqual(detectVolatile(a), []);
    assert.equal(/\d{4}-\d{2}-\d{2}T/.test(a), false);
    assert.equal(a.includes("git status"), false);
    assert.equal(a.includes("<project_instructions"), false);
  });
});

describe("assembleOutputDietHead (T23.1 the rule, verbatim, and nothing else)", () => {
  it("is a frozen, non-volatile, separate block from DIET_HEADING", () => {
    const a = assembleOutputDietHead();
    const b = assembleOutputDietHead();
    assert.equal(a, b);
    assert.equal(a.startsWith(OUTPUT_DIET_HEADING), true);
    assert.notEqual(OUTPUT_DIET_HEADING, DIET_HEADING);
    // Specialists ticket 03: no longer restates YAGNI/one-line content — that
    // now lives, verbatim and sourced, in the `## lykos-ponytail` block.
    assert.match(a, /ponytail block/);
    assert.equal(a.includes("Follow YAGNI principles"), false);
    assert.deepEqual(detectVolatile(a), []);
    assert.equal(/\d{4}-\d{2}-\d{2}T/.test(a), false);
  });

  it("outputDietEnabledFromEnv is on unless LYKOS_OUTPUT_DIET=0", () => {
    assert.equal(outputDietEnabledFromEnv({}), true);
    assert.equal(outputDietEnabledFromEnv({ LYKOS_OUTPUT_DIET: "0" }), false);
    assert.equal(outputDietEnabledFromEnv({ LYKOS_OUTPUT_DIET: "1" }), true);
  });
});

describe("resolveDietPolicy", () => {
  it("defaults to on, 32768 bytes — tighter than Pi's 50KB, larger than T19's 16KB snip", () => {
    assert.deepEqual(resolveDietPolicy(), { enabled: true, toolResultMaxBytes: DEFAULT_TOOL_RESULT_MAX_BYTES });
    assert.equal(DEFAULT_TOOL_RESULT_MAX_BYTES, 32_768);
    assert.equal(resolveDietPolicy({ enabled: "0" }).enabled, false);
    assert.equal(resolveDietPolicy({ enabled: false }).enabled, false);
    assert.equal(resolveDietPolicy({ toolResultMaxBytes: 12 }).toolResultMaxBytes, 12);
    assert.equal(resolveDietPolicy({ toolResultMaxBytes: 0 }).toolResultMaxBytes, DEFAULT_TOOL_RESULT_MAX_BYTES);
    assert.equal(resolveDietPolicy({ toolResultMaxBytes: -1 }).toolResultMaxBytes, DEFAULT_TOOL_RESULT_MAX_BYTES);
  });

  it("dietEnabledFromEnv is on unless LYKOS_PROMPT_DIET=0", () => {
    assert.equal(dietEnabledFromEnv({}), true);
    assert.equal(dietEnabledFromEnv({ LYKOS_PROMPT_DIET: "0" }), false);
    assert.equal(dietEnabledFromEnv({ LYKOS_PROMPT_DIET: "1" }), true);
  });
});

describe("loadContextFilesFromDir (T21.3 AND, not Pi's XOR)", () => {
  it("loads AGENTS.md and CLAUDE.md together when both exist", () => {
    const dir = tmp();
    writeFileSync(join(dir, "AGENTS.md"), "agents body");
    writeFileSync(join(dir, "CLAUDE.md"), "claude body");
    const files = loadContextFilesFromDir(dir);
    assert.equal(files.length, 2);
    assert.equal(files[0]!.kind, "AGENTS.md");
    assert.equal(files[1]!.kind, "CLAUDE.md");
    assert.equal(files[0]!.content, "agents body");
    assert.equal(files[1]!.content, "claude body");
  });

  it("Pi XOR would pick only AGENTS.md; we still keep CLAUDE.md", () => {
    const dir = tmp();
    writeFileSync(join(dir, "AGENTS.md"), "agents");
    writeFileSync(join(dir, "CLAUDE.md"), "claude");
    // Pi 0.84.3 loadContextFileFromDir returns the first of
    // AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD.
    const piXor = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
    const firstPresent = piXor.find((name) => {
      try {
        readFileSync(join(dir, name));
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(firstPresent, "AGENTS.md");
    const files = loadContextFilesFromDir(dir);
    assert.ok(files.some((f) => f.kind === "CLAUDE.md"), "T21.3: CLAUDE.md must not be dropped when AGENTS.md exists");
  });

  it("AGENTS.override.md replaces AGENTS.md and CLAUDE.md in that directory", () => {
    const dir = tmp();
    writeFileSync(join(dir, "AGENTS.override.md"), "override only");
    writeFileSync(join(dir, "AGENTS.md"), "ignored agents");
    writeFileSync(join(dir, "CLAUDE.md"), "ignored claude");
    const files = loadContextFilesFromDir(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.kind, "AGENTS.override.md");
    assert.equal(files[0]!.content, "override only");
  });

  it("loads CLAUDE.md alone when AGENTS.md is absent", () => {
    const dir = tmp();
    writeFileSync(join(dir, "CLAUDE.md"), "just claude");
    const files = loadContextFilesFromDir(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0]!.kind, "CLAUDE.md");
  });

  it("returns empty when neither context file exists", () => {
    assert.deepEqual(loadContextFilesFromDir(tmp()), []);
  });

  it("strips a leading BOM", () => {
    const dir = tmp();
    writeFileSync(join(dir, "AGENTS.md"), "\uFEFFhello");
    assert.equal(loadContextFilesFromDir(dir)[0]!.content, "hello");
  });
});

describe("ingestContextFiles (walk-up, freeze-at-call, no restatement)", () => {
  it("walks from filesystem root toward cwd, global agentDir first", () => {
    const root = tmp();
    const nested = join(root, "proj", "pkg");
    mkdirSync(nested, { recursive: true });
    const agentDir = join(root, "agent-home");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "AGENTS.md"), "global");
    writeFileSync(join(root, "AGENTS.md"), "root agents");
    writeFileSync(join(nested, "CLAUDE.md"), "pkg claude");
    const files = ingestContextFiles({ cwd: nested, agentDir });
    const bodies = files.map((f) => f.content);
    assert.deepEqual(bodies, ["global", "root agents", "pkg claude"]);
  });

  it("keeps both files from cwd when both exist", () => {
    const dir = tmp();
    writeFileSync(join(dir, "AGENTS.md"), "a");
    writeFileSync(join(dir, "CLAUDE.md"), "c");
    const files = ingestContextFiles({ cwd: dir });
    assert.deepEqual(
      files.map((f) => f.kind),
      ["AGENTS.md", "CLAUDE.md"],
    );
  });

  it("does not restate identical bodies (T21.1)", () => {
    const root = tmp();
    const child = join(root, "src");
    mkdirSync(child);
    writeFileSync(join(root, "AGENTS.md"), "same rules");
    writeFileSync(join(child, "CLAUDE.md"), "same rules");
    const files = ingestContextFiles({ cwd: child });
    assert.equal(files.length, 1);
    assert.equal(files[0]!.kind, "AGENTS.md");
  });

  it("toAgentsFiles is the override shape Pi consumes", () => {
    const dir = tmp();
    writeFileSync(join(dir, "AGENTS.md"), "body");
    const files = ingestContextFiles({ cwd: dir });
    assert.deepEqual(toAgentsFiles(files), [{ path: files[0]!.path, content: "body" }]);
    const meta = contextFileMeta(files);
    assert.equal(meta[0]!.name, "AGENTS.md");
    assert.equal(meta[0]!.bytes, utf8ByteLength("body"));
  });
});

describe("capToolResultText (T21.2 byte caps + explicit marker)", () => {
  it("leaves a body under the cap untouched, with no marker", () => {
    const r = capToolResultText("hello", 100);
    assert.equal(r.truncated, false);
    assert.equal(r.text, "hello");
    assert.equal(r.originalBytes, 5);
    assert.equal(r.text.includes(TRUNC_MARKER_PREFIX), false);
  });

  it("truncates head and names the original size", () => {
    const r = capToolResultText("abcdefghij", 4, "head");
    assert.equal(r.truncated, true);
    assert.equal(r.originalBytes, 10);
    assert.equal(r.keptBytes, 4);
    assert.equal(r.text.startsWith("abcd"), true);
    assert.equal(r.text.endsWith(truncationMarker(4, 10)), true);
    assert.match(r.text, /kept 4 of 10 bytes/);
  });

  it("truncates tail for bash-style logs, marker first", () => {
    const r = capToolResultText("abcdefghij", 4, "tail");
    assert.equal(r.truncated, true);
    assert.equal(r.text.endsWith("ghij"), true);
    assert.equal(r.text.startsWith(truncationMarker(4, 10)), true);
  });

  it("does not split a UTF-8 code point", () => {
    // euro sign is 3 bytes. Cap of 2 bytes must not emit a replacement char.
    const r = capToolResultText("€€", 2, "head");
    assert.equal(r.truncated, true);
    assert.equal(r.text.includes("\uFFFD"), false);
    assert.equal(utf8Prefix("€€", 2), "");
    assert.equal(utf8Suffix("€€", 2), "");
  });

  it("a cap equal to the body is not a truncation", () => {
    const r = capToolResultText("abcd", 4);
    assert.equal(r.truncated, false);
    assert.equal(r.text, "abcd");
  });
});

describe("ToolResultDiet (T21.1 unchanged file + T21.2 cap)", () => {
  it("caps an oversized read with an explicit marker", () => {
    const diet = new ToolResultDiet(8);
    const out = diet.apply({
      toolName: "read",
      input: { path: "big.ts" },
      content: [{ type: "text", text: "0123456789abcdef" }],
    });
    assert.equal(out.truncated, true);
    assert.equal(out.unchanged, false);
    const text = (out.content as Array<{ text: string }>)[0]!.text;
    assert.match(text, /\[lykos-trunc: kept 8 of 16 bytes\]/);
    assert.equal(diet.truncatedResults, 1);
  });

  it("stubs a second identical read of the same path (never resend unchanged)", () => {
    const diet = new ToolResultDiet(10_000);
    const event = {
      toolName: "read",
      input: { path: "src/a.ts" },
      content: [{ type: "text", text: "file body" }],
    };
    const first = diet.apply(event);
    assert.equal(first.unchanged, false);
    const second = diet.apply(event);
    assert.equal(second.unchanged, true);
    assert.equal(diet.unchangedStubs, 1);
    const text = (second.content as Array<{ text: string }>)[0]!.text;
    assert.equal(text, unchangedMarker("src/a.ts"));
    assert.equal(text.includes("file body"), false);
  });

  it("keeps a later read of the same path when the bytes changed", () => {
    const diet = new ToolResultDiet(10_000);
    diet.apply({ toolName: "read", input: { path: "a.ts" }, content: "v1" });
    const next = diet.apply({ toolName: "read", input: { path: "a.ts" }, content: "v2" });
    assert.equal(next.unchanged, false);
    assert.equal((next.content as Array<{ text: string }>)[0]!.text, "v2");
  });

  it("does not treat two different paths as unchanged even with identical bodies", () => {
    const diet = new ToolResultDiet(10_000);
    diet.apply({ toolName: "read", input: { path: "a.ts" }, content: "same" });
    const other = diet.apply({ toolName: "read", input: { path: "b.ts" }, content: "same" });
    assert.equal(other.unchanged, false);
    assert.equal((other.content as Array<{ text: string }>)[0]!.text, "same");
  });

  // T84 changed this deliberately: bash was "tail", it is now "both".
  // A tail-only cut discards which command ran and the FIRST error, which is
  // usually the real one -- every later error is its consequence. The
  // details.output patching this also covers is unchanged.
  it("keeps both ends of a bash result and patches details.output", () => {
    const diet = new ToolResultDiet(4);
    const out = diet.apply({
      toolName: "bash",
      input: { command: "cat log" },
      content: [{ type: "text", text: "abcdefghij" }],
      details: { output: "abcdefghij", exitCode: 0, truncated: false },
    });
    const text = (out.content as Array<{ text: string }>)[0]!.text;
    assert.equal(text.startsWith("ab"), true, "the head survives");
    assert.equal(text.endsWith("ij"), true, "the tail survives");
    assert.ok(text.includes(TRUNC_MARKER_PREFIX), "the elision is explicit");
    assert.equal((out.details as { output: string }).output, text);
  });
});
