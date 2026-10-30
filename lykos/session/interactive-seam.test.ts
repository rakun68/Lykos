import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { newRetryObservation } from "../loop/retry-observer.js";
import type { StandaloneSessionState } from "./session.js";
import { runInteractiveLoop, type InteractiveSession, type LineSource } from "./interactive.js";
import type { AgentUi } from "../tui/s0.js";

function state(): StandaloneSessionState {
  return {
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cacheWrite1h: 0,
      reasoning: 0,
      nestedInput: 0,
      nestedOutput: 0,
      nestedCacheRead: 0,
      nestedCacheWrite: 0,
      calls: [],
    },
    toolCalls: [],
    turns: 0,
    lastText: "",
    humanInterventions: 0,
    retry: newRetryObservation(),
  };
}

describe("AgentUi seam", () => {
  it("drives the interactive loop without a terminal", async () => {
    const lines: LineSource = {
      next: async () => (linesRead++ === 0 ? "hello from a test surface" : "/exit"),
      close() {},
    };
    let linesRead = 0;
    const prompts: string[] = [];
    const ui: AgentUi = {
      view: { blocks: [], hud: null, toolsCollapsed: true, thinkingCollapsed: false },
      streamed: false,
      writeUser: (text) => prompts.push(text),
      writeSystem() {},
      writeHud: () => null as never,
      renderApproval: () => "",
      attach: () => () => {},
      snapshotJson: () => "{}",
    };
    const session: InteractiveSession = {
      sessionId: "test-session",
      systemPrompt: "test",
      isIdle: true,
      async prompt(text) {
        prompts.push(`prompt:${text}`);
      },
      async steer() {},
      async abort() {},
      async waitForIdle() {},
      getActiveToolNames: () => [],
      dispose() {},
    };

    const result = await runInteractiveLoop({
      session,
      lineSource: lines,
      state: state(),
      ledgerPath: "unused",
      config: SHIPPED_DEFAULTS,
      modelSpec: "test/model",
      ui,
    });

    assert.equal(result.runState, "done");
    assert.deepEqual(prompts, ["hello from a test surface", "prompt:hello from a test surface"]);
  });
});
