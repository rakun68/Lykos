import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { contextBreakdown, headTokens } from "./context-breakdown.js";

describe("contextBreakdown", () => {
  const tool = { name: "read", description: "read a file", parameters: { type: "object" } } as const;
  const base = {
    model: "p/m",
    systemPrompt: "x".repeat(4000),
    tools: [tool],
    contextFiles: [{ name: "AGENTS.md", bytes: 400 }],
    skillTokens: 100,
    skillCount: 2,
    messages: [{ role: "user", content: "y".repeat(40) }],
  };

  it("takes the memory files and skills out of the system prompt, and sizes messages from their text before Pi has a total", () => {
    const b = contextBreakdown({ ...base, usage: { tokens: null, contextWindow: 200000 } });
    const by = Object.fromEntries(b.parts.map((p) => [p.name, p.tokens]));
    assert.deepEqual([by["System prompt"], by["Memory files"], by.Skills, by.Messages], [800, 100, 100, 10]);
    assert.equal(by["System prompt"]! + by["Memory files"]! + by.Skills!, 1000, "the prompt is counted once");
    assert.equal(b.measured, null);
    assert.equal(b.window, 200000);
    assert.equal(by.Tools, headTokens("", [tool]));
  });

  it("with Pi's total, the messages are what the total leaves after the head", () => {
    const b = contextBreakdown({ ...base, usage: { tokens: 5000, contextWindow: 200000 } });
    const messages = b.parts.find((p) => p.name === "Messages")!.tokens;
    assert.equal(messages, 5000 - 1000 - headTokens("", [tool]));
    assert.equal(b.measured, 5000);
  });
});
