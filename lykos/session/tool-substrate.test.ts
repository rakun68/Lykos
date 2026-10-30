import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { targetKey, targetOf } from "../loop/stagnation.js";
import { emptyToolSubstrate, serializeCounts, summarizeToolSubstrate } from "./tool-substrate.js";

const here = dirname(fileURLToPath(import.meta.url));

describe("T111.3 per-tool counts and errors", () => {
  it("counts calls and errors per tool, and stores no rate", () => {
    const substrate = summarizeToolSubstrate([
      { name: "read", args: { path: "a.ts" } },
      { name: "edit", args: { path: "a.ts" }, state: "error" },
      { name: "edit", args: { path: "a.ts" } },
      { name: "bash", args: { command: "npm test" }, state: "error" },
    ]);
    assert.deepEqual(substrate.callCounts, { read: 1, edit: 2, bash: 1 });
    assert.deepEqual(substrate.errorCounts, { edit: 1, bash: 1 });
  });

  it("omits a tool that never errored rather than writing a zero for it", () => {
    const substrate = summarizeToolSubstrate([{ name: "read", args: { path: "a.ts" } }]);
    assert.deepEqual(substrate.errorCounts, {});
    assert.equal("read" in substrate.errorCounts, false);
  });

  it("counts a transport dispatch under the tool it resolved to, apart from the wire name (D26)", () => {
    const substrate = summarizeToolSubstrate([
      { name: "tool_call", args: { name: "lsp", arguments: { action: "rename" } } },
      { name: "tool_call", args: { name: "lsp", arguments: { action: "references" } } },
      { name: "read", args: { path: "a.ts" } },
    ]);
    assert.deepEqual(substrate.callCounts, { tool_call: 2, read: 1 });
    assert.deepEqual(substrate.actualCallCounts, { lsp: 2, read: 1 });
  });

  it("returns an empty summary for a session that ran no tools", () => {
    assert.deepEqual(summarizeToolSubstrate([]), emptyToolSubstrate());
    assert.deepEqual(summarizeToolSubstrate(undefined), emptyToolSubstrate());
  });
});

describe("T111.3 tool changed, target did not", () => {
  it("counts an adjacent pair whose tool differs on one target", () => {
    const substrate = summarizeToolSubstrate([
      { name: "edit", args: { path: "a.ts" }, state: "error" },
      { name: "write", args: { path: "a.ts" } },
    ]);
    assert.equal(substrate.adjacentPairs, 1);
    assert.equal(substrate.switchSameTarget, 1);
  });

  it("does not count the same tool twice on one target — that is the brake's question, not this one", () => {
    const substrate = summarizeToolSubstrate([
      { name: "edit", args: { path: "a.ts" }, state: "error" },
      { name: "edit", args: { path: "a.ts" } },
    ]);
    assert.equal(substrate.adjacentPairs, 1);
    assert.equal(substrate.switchSameTarget, 0);
  });

  it("does not count a different tool on a different target", () => {
    const substrate = summarizeToolSubstrate([
      { name: "read", args: { path: "a.ts" } },
      { name: "edit", args: { path: "b.ts" } },
    ]);
    assert.equal(substrate.adjacentPairs, 1);
    assert.equal(substrate.switchSameTarget, 0);
  });

  it("skips a pair where either target is unreadable, denominator included", () => {
    const substrate = summarizeToolSubstrate([
      { name: "read", args: { path: "a.ts" } },
      { name: "todo", args: {} },
      { name: "edit", args: { path: "a.ts" } },
    ]);
    // Neither pair has two resolvable targets, so nothing is counted at all
    // — a call whose target could not be read is not evidence.
    assert.equal(substrate.adjacentPairs, 0);
    assert.equal(substrate.switchSameTarget, 0);
  });

  it("counts the benign read-then-edit shape, which is why this is evidence and not a defect count", () => {
    const substrate = summarizeToolSubstrate([
      { name: "read", args: { path: "a.ts" } },
      { name: "edit", args: { path: "a.ts" } },
    ]);
    assert.equal(substrate.switchSameTarget, 1);
  });
});

describe("T111.3 one definition of a call's target", () => {
  it("targetKey is targetOf with the tool name in front, so the brake and the substrate cannot disagree", () => {
    const call = { toolName: "edit", input: { path: "a.ts" } };
    assert.equal(targetOf(call), "a.ts");
    assert.equal(targetKey(call), "edit:a.ts");
    const bash = { toolName: "bash", input: { command: "  npm test  " } };
    assert.equal(targetOf(bash), "npm test");
    assert.equal(targetKey(bash), "bash:npm test");
  });

  it("has no target for a call carrying none", () => {
    assert.equal(targetOf({ toolName: "todo", input: {} }), undefined);
    assert.equal(targetKey({ toolName: "todo", input: {} }), undefined);
  });
});

describe("T111.3 the metric this project refuses to compute", () => {
  it("names no accuracy anywhere in the module, the schema, or the ledger", () => {
    // The ticket's rule is that the refusal is enforced rather than
    // requested. `accuracy` must not appear as a column, a view, or a field.
    // Both files may (and both do) explain at length WHY the metric is
    // refused, so comments are stripped before matching: what must not
    // exist is a COLUMN or FIELD named for it. Asserting over the stripped
    // source is the difference between a rule and a request.
    const substrate = readFileSync(join(here, "tool-substrate.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    const schema = readFileSync(join(here, "..", "ledger", "schema.sql"), "utf8").replace(/--.*$/gm, "");
    assert.doesNotMatch(schema, /accuracy/i, "schema.sql must not declare an accuracy column");
    assert.doesNotMatch(substrate, /accuracy/i, "tool-substrate.ts must not declare an accuracy field");
  });

  it("stores counts, never rates — a rate is derived and belongs to the reader", () => {
    const substrate = summarizeToolSubstrate([
      { name: "edit", args: { path: "a.ts" }, state: "error" },
      { name: "edit", args: { path: "a.ts" } },
    ]);
    for (const value of Object.values(substrate.callCounts)) assert.equal(Number.isInteger(value), true);
    for (const value of Object.values(substrate.errorCounts)) assert.equal(Number.isInteger(value), true);
    assert.equal(Number.isInteger(substrate.adjacentPairs), true);
    assert.equal(Number.isInteger(substrate.switchSameTarget), true);
  });

  it("serializes counts as JSON an empty session still answers", () => {
    assert.equal(serializeCounts({}), "{}");
    assert.equal(serializeCounts({ read: 2 }), '{"read":2}');
  });
});
