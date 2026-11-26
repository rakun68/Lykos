// A side question (P5 #38): the session's context goes to the model with no tools, the answer comes back, the
// conversation is untouched, and the call is counted in the session's usage as source "aside".
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askAside, type AsideSession, type AssistantMessage } from "./aside.js";
import type { StandaloneSessionState } from "./session.js";

function state(): StandaloneSessionState {
  return {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, nestedInput: 0, nestedOutput: 0, nestedCacheRead: 0, nestedCacheWrite: 0, calls: [] },
    toolCalls: [],
    turns: 0,
    lastText: "",
    humanInterventions: 0,
    retry: { retries: 0, waitedMs: 0, lastError: undefined } as unknown as StandaloneSessionState["retry"],
  };
}

function reply(over: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "It is " }, { type: "text", text: "42." }],
    api: "faux",
    provider: "faux",
    model: "scripted",
    usage: { input: 120, output: 8, cacheRead: 100, cacheWrite: 0, totalTokens: 228, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...over,
  } as AssistantMessage;
}

function fake(answer: AssistantMessage): { session: AsideSession; seen: unknown[] } {
  const seen: unknown[] = [];
  const messages = [{ role: "user", content: "what is six times seven?", timestamp: 1 }];
  const session = {
    model: { provider: "faux", id: "scripted" },
    messages,
    systemPrompt: "you are a coder",
    sessionId: "s-1",
    modelRuntime: {
      completeSimple: async (_model: unknown, context: unknown, options: unknown) => {
        seen.push(context, options);
        return answer;
      },
    },
  } as unknown as AsideSession;
  return { session, seen };
}

describe("askAside", () => {
  it("answers from the context with no tools, leaves the conversation alone, and counts the call", async () => {
    const { session, seen } = fake(reply({}));
    const s = state();
    const before = JSON.stringify(session.messages);
    const got = await askAside(session, s, "and times two?");
    assert.deepEqual(got, { answer: "It is 42.", model: "faux/scripted" });
    const context = seen[0] as { systemPrompt: string; messages: { role: string; content: unknown }[]; tools?: unknown };
    assert.equal(context.systemPrompt, "you are a coder");
    assert.equal(context.tools, undefined, "no tools");
    assert.equal(context.messages.length, 2);
    assert.match(String(context.messages[1]!.content), /and times two\?$/);
    assert.deepEqual(seen[1], { sessionId: "s-1" });
    assert.equal(JSON.stringify(session.messages), before, "the conversation is unchanged");
    assert.equal(s.usage.calls.length, 1);
    assert.equal(s.usage.calls[0]!.source, "aside");
    assert.equal(s.usage.calls[0]!.input, 120);
    assert.equal(s.usage.calls[0]!.costUsd, 0.0001);
    assert.equal(s.usage.input, 120);
  });

  it("throws the model's error, and still counts a call that was billed", async () => {
    const { session } = fake(reply({ stopReason: "error", errorMessage: "overloaded", content: [] }));
    const s = state();
    await assert.rejects(askAside(session, s, "q"), /overloaded/);
    assert.equal(s.usage.calls.length, 1);
  });
});
