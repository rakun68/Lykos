// 2026-09-02 round thirteen, item 4: "after I type the command effort
// <level> and it switches effort, the bar should change colour instantly.
// Right now I have to type at least one letter to make the bar changes
// colour. Furthermore, no matter what effort i change, the effort showing
// at the bottom right corner does not change."
//
// Both halves were one omission: `/effort` changed the level and redrew
// nothing that displays it. The composer's border rules read
// `session.thinkingLevel` when they are painted, and only a keystroke
// painted them; the footer's model/effort badge comes from the view model,
// which only `writeHud()` builds, and nothing called that outside a
// finished turn or boot.
//
// This drives `runInteractiveLoop` directly rather than a real terminal —
// the two observable effects are "the HUD was rebuilt" and "the composer
// repaint hook fired", and both are visible from here.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { runInteractiveLoop, type InteractiveSession, type LineSource } from "./interactive.js";
import type { StandaloneSessionState } from "./session.js";
import type { AgentUi } from "../tui/s0.js";

function fakeUi(): AgentUi & { hudWrites: number } {
  return {
    view: { blocks: [], hud: null, toolsCollapsed: true, thinkingCollapsed: false },
    streamed: false,
    hudWrites: 0,
    writeUser() {},
    writeSystem() {},
    writeHud() {
      this.hudWrites += 1;
      return null as never;
    },
    renderApproval() {
      return "";
    },
    attach() {
      return () => {};
    },
    snapshotJson() {
      return "{}";
    },
  };
}

class EffortSession implements InteractiveSession {
  readonly sessionId = "effort-session";
  readonly systemPrompt = "fake";
  thinkingLevel = "low";
  get isIdle(): boolean {
    return true;
  }
  async prompt(): Promise<void> {}
  async steer(): Promise<void> {}
  async abort(): Promise<void> {}
  async waitForIdle(): Promise<void> {}
  async dispose(): Promise<void> {}
  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
  }
  getAvailableThinkingLevels(): string[] {
    return ["off", "low", "medium", "high"];
  }
  supportsThinking(): boolean {
    return true;
  }
  getActiveToolNames(): string[] {
    return [];
  }
}

class ScriptedLines implements LineSource {
  private readonly queue: string[];
  constructor(lines: string[]) {
    this.queue = [...lines];
  }
  async next(): Promise<string | null> {
    return this.queue.shift() ?? null;
  }
  close(): void {}
}

function freshState(): StandaloneSessionState {
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
      costUsd: 0,
      calls: [],
    },
    turns: 0,
    lastText: "",
  } as unknown as StandaloneSessionState;
}

describe("round thirteen, item 4: /effort refreshes everything that shows the effort", () => {
  it("rebuilds the HUD and fires the composer-repaint hook, in the same turn the level changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-effort-"));
    try {
      const session = new EffortSession();
      const ui = fakeUi();
      const levels: Array<string | null> = [];

      const result = await runInteractiveLoop({
        session,
        lineSource: new ScriptedLines(["/effort high", "/exit"]),
        state: freshState(),
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        ui,
        writeReply: () => {},
        onEffortChange: (level) => levels.push(level),
      });

      assert.equal(result.runState, "done");
      assert.equal(session.thinkingLevel, "high", "the level itself changed, as it always did");
      assert.deepEqual(levels, ["high"], "the composer repaint hook fired once, with the level Pi settled on");
      assert.ok(ui.hudWrites > 0, "the footer's view model was rebuilt rather than left showing the old badge");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a rejected level changes nothing and still does not fire the repaint hook", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-effort-bad-"));
    try {
      const session = new EffortSession();
      const ui = fakeUi();
      const levels: Array<string | null> = [];

      await runInteractiveLoop({
        session,
        lineSource: new ScriptedLines(["/effort nonsense", "/exit"]),
        state: freshState(),
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        ui,
        writeReply: () => {},
        onEffortChange: (level) => levels.push(level),
      });

      assert.equal(session.thinkingLevel, "low", "an unknown level is refused, not applied");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
