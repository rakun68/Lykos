import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { TOOL_CATALOG } from "./tool-catalog.js";
import {
  PI_DEFAULT_PLUS_SUBAGENTS,
  PI_DEFAULT_TOOLS,
  SCHEMA_TOKENS_BASIS,
  canonicalizeToolset,
  estimateTokensChars4,
  formatShare,
  lookupCatalogTool,
  measureSpecialist,
  measureToolset,
  piDefaultBaseline,
  piDefaultPlusSubagentsBaseline,
  schemaShareOfPrompt,
  toolToWireFunction,
} from "./tool-schema.js";

describe("estimateTokensChars4", () => {
  it("matches Pi 0.84.3: ceil(chars / 4)", () => {
    assert.equal(estimateTokensChars4(""), 0);
    assert.equal(estimateTokensChars4("abcd"), 1);
    assert.equal(estimateTokensChars4("abcde"), 2);
    assert.equal(estimateTokensChars4("a".repeat(4800)), 1200);
  });
});

describe("measureToolset", () => {
  it("returns 0 tokens for a known-empty set, not NULL", () => {
    const m = measureToolset([]);
    assert.equal(m.complete, true);
    assert.equal(m.tokens, 0);
    assert.equal(m.bytes, 2); // "[]"
    assert.equal(m.count, 0);
    assert.equal(m.hash, createHash("sha256").update("[]").digest("hex"));
    assert.equal(m.basis, SCHEMA_TOKENS_BASIS);
  });

  it("returns NULL tokens when any name is unknown — never a silent undercount", () => {
    const m = measureToolset(["read", "not-a-real-tool"]);
    assert.equal(m.complete, false);
    assert.equal(m.tokens, null);
    assert.equal(m.bytes, null);
    assert.equal(m.hash, null);
    assert.deepEqual(m.unknown, ["not-a-real-tool"]);
    assert.equal(m.count, 2);
  });

  it("looks up a Pi builtin by name", () => {
    const read = lookupCatalogTool("read");
    assert.ok(read);
    assert.equal(read.source, "lykos");
    assert.match(read.description, /truncated to 2000 lines or 50KB/);
  });

  it("canonical JSON is stable across calls (hash-sensitive field order)", () => {
    const a = canonicalizeToolset([lookupCatalogTool("read")!]);
    const b = canonicalizeToolset([lookupCatalogTool("read")!]);
    assert.equal(a, b);
    assert.equal(measureToolset(["read"]).hash, measureToolset(["read"]).hash);
  });

  it("hash changes when tool order changes", () => {
    const ab = measureToolset(["read", "bash"]);
    const ba = measureToolset(["bash", "read"]);
    assert.equal(ab.tokens, ba.tokens); // same payload length, different order
    assert.notEqual(ab.hash, ba.hash);
  });

  it("hash changes when a tool is added", () => {
    const four = measureToolset([...PI_DEFAULT_TOOLS]);
    const five = measureToolset([...PI_DEFAULT_TOOLS, "grep"]);
    assert.ok(four.complete && five.complete);
    assert.notEqual(four.hash, five.hash);
    assert.ok((five.tokens as number) > (four.tokens as number));
  });

  it("wire shape is OpenAI function-calling, not Anthropic input_schema", () => {
    const wire = toolToWireFunction(lookupCatalogTool("write")!);
    assert.equal(wire.type, "function");
    assert.equal(wire.function.name, "write");
    assert.equal("input_schema" in wire.function, false);
    assert.ok(wire.function.parameters);
  });
});

describe("T4.1 baselines: with vs without pi-subagents", () => {
  it("pi-default is the four built-ins and is complete", () => {
    assert.deepEqual([...PI_DEFAULT_TOOLS], ["read", "bash", "edit", "write"]);
    const m = piDefaultBaseline();
    assert.equal(m.count, 4);
    assert.ok(m.tokens > 0);
    assert.equal(m.basis, SCHEMA_TOKENS_BASIS);
  });

  it("pi-default+subagents is complete and strictly larger", () => {
    const without = piDefaultBaseline();
    const withExt = piDefaultPlusSubagentsBaseline();
    assert.deepEqual([...PI_DEFAULT_PLUS_SUBAGENTS].slice(0, 4), [...PI_DEFAULT_TOOLS]);
    assert.equal(withExt.count, 8);
    assert.ok(withExt.tokens > without.tokens);
    assert.notEqual(withExt.hash, without.hash);
  });

  it("the delta is the four pi-subagents tools, not a rounding error", () => {
    const without = piDefaultBaseline();
    const withExt = piDefaultPlusSubagentsBaseline();
    const delta = withExt.tokens - without.tokens;
    // SubagentWorkflow's description alone is tens of thousands of chars.
    assert.ok(delta > 2000, `expected a real tax, got delta=${delta}`);
    const subagentsOnly = measureSpecialist([
      "agent",
      "get_subagent_result",
      "steer_subagent",
      "subagent_workflow",
    ]);
    // Array wrapping means measure(A+B) !== measure(A)+measure(B); the
    // session tax is measure(A+B) - measure(A), which is what we report.
    assert.ok(Math.abs(delta - subagentsOnly.tokens) < subagentsOnly.tokens);
  });

  it("SubagentWorkflow is the largest single tool in the catalog", () => {
    let largest = { name: "", tokens: 0 };
    for (const tool of Object.values(TOOL_CATALOG)) {
      const n = estimateTokensChars4(JSON.stringify(toolToWireFunction(tool)));
      if (n > largest.tokens) largest = { name: tool.name, tokens: n };
    }
    assert.equal(largest.name, "subagent_workflow");
  });

  it("every catalog tool has a name, description, parameters object, and source", () => {
    for (const [key, tool] of Object.entries(TOOL_CATALOG)) {
      assert.equal(tool.name, key);
      assert.ok(tool.description.length > 0, `${key} missing description`);
      assert.equal(typeof tool.parameters, "object");
      // Every source the CatalogTool union declares. T24 added
      // "pi-hashline-edit" and T98 added "lykos" for the Lykos-owned `todo`
      // customTool; the assertion is that a tool names a source at all, not
      // that Pi is the only thing allowed to register one.
      assert.ok(
        ["pi-builtin", "pi-subagents", "pi-hashline-edit", "lykos"].includes(tool.source),
        `${key} has an unknown source ${tool.source}`,
      );
    }
  });
});

describe("schemaShareOfPrompt", () => {
  it("uses fresh + cache-read as the prompt denominator", () => {
    const s = schemaShareOfPrompt(100, 400, 600);
    assert.ok(s);
    assert.equal(s.promptTokens, 1000);
    assert.equal(s.share, 0.1);
    assert.equal(formatShare(s.share), "10.0%");
  });

  it("returns null for an unmeasured schema, not 0%", () => {
    assert.equal(schemaShareOfPrompt(null, 1000, 0), null);
  });

  it("returns a null share when the prompt is empty, not Infinity", () => {
    const s = schemaShareOfPrompt(100, 0, 0);
    assert.ok(s);
    assert.equal(s.share, null);
    assert.equal(formatShare(null), "?%");
  });
});
