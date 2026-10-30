import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAgentFile } from "./generate-agents.js";

const SCOUT_MD = `---
name: scout
model: deepseek-v4-flash
tools: read, grep, glob
extensions: false
allowed_subagents: none
memory: project
inherit_context: false
---

Read-only exploration. Find files, locate symbols, answer "where is X" and
"which files reference Y".
`;

describe("parseAgentFile", () => {
  it("splits frontmatter and body, parsing booleans and leaving strings as strings", () => {
    const parsed = parseAgentFile(SCOUT_MD);
    assert.ok(parsed);
    assert.equal(parsed!.frontmatter.name, "scout");
    assert.equal(parsed!.frontmatter.model, "deepseek-v4-flash");
    assert.equal(parsed!.frontmatter.tools, "read, grep, glob");
    assert.equal(parsed!.frontmatter.extensions, false);
    assert.equal(parsed!.frontmatter.inherit_context, false);
    assert.match(parsed!.body, /Read-only exploration/);
  });

  it("returns null for a file with no frontmatter block", () => {
    assert.equal(parseAgentFile("just some text, no frontmatter at all\n"), null);
  });

  it("returns null for an unterminated frontmatter block", () => {
    assert.equal(parseAgentFile("---\nname: broken\nno closing delimiter\n"), null);
  });
});
