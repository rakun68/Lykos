// The third 2026-09-02 UI feedback round, `runInteractiveLoop`'s half —
// `/usage`, `/context`, and `/effort`'s coloured message, plus the
// boot-time HUD paint. Structured the same way as
// `tui/screen/feedback-2026-09-02c.test.ts`, one describe per numbered item.
//
// `FakeSession` here is a fresh, minimal fixture rather than a shared
// import from `interactive.test.ts` — that file's own `FakeSession` and
// `ScriptedLineSource` are private to it, and duplicating the small amount
// this file needs is cheaper than exporting test-only surface off a
// production module.

import { newRetryObservation } from "../loop/retry-observer.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { runInteractiveLoop, type InteractiveHandle, type InteractiveSession, type LineSource } from "./interactive.js";
import type { StandaloneSessionState } from "./session.js";
import type { AgentUi, SystemPart } from "../tui/s0.js";

class ScriptedLineSource implements LineSource {
  private queue: string[] = [];
  private waiters: Array<(v: string | null) => void> = [];
  private waitingNotify: (() => void) | null = null;
  private closed = false;

  push(line: string): void {
    const w = this.waiters.shift();
    if (w) w(line);
    else this.queue.push(line);
  }

  next(): Promise<string | null> {
    return new Promise((resolve) => {
      if (this.queue.length > 0) {
        resolve(this.queue.shift()!);
        return;
      }
      if (this.closed) {
        resolve(null);
        return;
      }
      this.waiters.push(resolve);
      if (this.waitingNotify) {
        const n = this.waitingNotify;
        this.waitingNotify = null;
        n();
      }
    });
  }

  onWaiting(): Promise<void> {
    if (this.waiters.length > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.waitingNotify = resolve;
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w(null);
  }
}

/** Adds the reasoning-effort and context-usage surface `FakeSession` in `interactive.test.ts` never needed. */
class FakeEffortSession implements InteractiveSession {
  readonly sessionId = "fake-session";
  readonly systemPrompt = "a".repeat(400); // 400 chars -> ~100 tokens at the 4-bytes-per-token estimate
  private idle = true;
  thinkingLevel: string = "medium";
  private readonly available = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  private context: { tokens: number | null; contextWindow: number; percent: number | null } = { tokens: 12000, contextWindow: 64000, percent: 18.75 /* Pi's 0-100 scale (D28) */ };

  get isIdle(): boolean {
    return this.idle;
  }

  async prompt(_text: string): Promise<void> {
    this.idle = false;
  }
  async steer(): Promise<void> {}
  async abort(): Promise<void> {
    this.idle = true;
  }
  async waitForIdle(): Promise<void> {}
  getActiveToolNames(): string[] {
    return ["read", "bash", "edit", "write"];
  }
  dispose(): void {}

  setThinkingLevel(level: string): void {
    this.thinkingLevel = level;
  }
  getAvailableThinkingLevels(): string[] {
    return this.available;
  }
  supportsThinking(): boolean {
    return true;
  }
  getContextUsage() {
    return this.context;
  }
}

function freshState(overrides: Partial<StandaloneSessionState["usage"]> = {}): StandaloneSessionState {
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
      ...overrides,
    },
    toolCalls: [],
    turns: 0,
    lastText: "",
    humanInterventions: 0,
  retry: newRetryObservation(),
  };
}

async function withTempWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t34-interactive-c-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs one owned command against a fresh loop, returning everything `chrome()` wrote — to stderr, or to a fake `AgentUi.writeSystem`, whichever the test needs. */
async function runOneCommand(
  dir: string,
  session: InteractiveSession,
  command: string,
  opts: { state?: StandaloneSessionState; contextInfo?: () => { systemPromptChars: number; contextFiles: Array<{ name: string; bytes: number }>; skills: string[]; toolNames: string[] } } = {},
): Promise<{ stderr: string; systemMessages: Array<{ text: string; parts?: readonly SystemPart[] }> }> {
  const lineSource = new ScriptedLineSource();
  const state = opts.state ?? freshState();
  const stderrChunks: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  (process.stderr.write as unknown) = (chunk: string) => {
    stderrChunks.push(String(chunk));
    return true;
  };
  const systemMessages: Array<{ text: string; parts?: readonly SystemPart[] }> = [];
  const ui: AgentUi = {
    view: { blocks: [], hud: null, toolsCollapsed: true, thinkingCollapsed: false },
    streamed: false,
    writeUser() {},
    writeSystem(text, parts) {
      systemMessages.push({ text, ...(parts ? { parts } : {}) });
    },
    writeHud() {
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
  try {
    const run = runInteractiveLoop({
      session,
      lineSource,
      state,
      ledgerPath: join(dir, ".lykos", "ledger.db"),
      config: SHIPPED_DEFAULTS,
      modelSpec: "deepseek/deepseek-v4-flash",
      writeReply: () => {},
      ui,
      ...(opts.contextInfo ? { contextInfo: opts.contextInfo } : {}),
    });
    await lineSource.onWaiting();
    lineSource.push(command);
    await lineSource.onWaiting();
    lineSource.push("/exit");
    await run;
  } finally {
    process.stderr.write = originalWrite;
  }
  return { stderr: stderrChunks.join(""), systemMessages };
}

describe("item 6: the footer is painted at boot, before the first prompt", () => {
  it("writeHud is called once with the session's own zeroed usage before any turn runs", async () => {
    await withTempWorkspace(async (dir) => {
      // This is exercised end to end in session/interactive.ts's fullscreen
      // wiring (the `ui.writeHud(state, session.sessionId)` call added
      // right after `ui.attach()` — see that file). What's testable at the
      // `runInteractiveLoop` layer alone is that the loop itself never
      // requires a turn to have run before it is willing to call `/session`
      // or `/usage` — i.e. nothing in the owned-command path assumes
      // `state.usage.calls` is non-empty.
      const session = new FakeEffortSession();
      const { stderr } = await runOneCommand(dir, session, "/usage");
      assert.ok(stderr.length === 0, "chrome went through the ui, not stderr, once a ui is supplied");
    });
  });
});

describe("item 7: /effort's message is informative and coloured, and is not refused like /model", () => {
  it("bare /effort reports the current level and the full ladder", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeEffortSession();
      const { systemMessages } = await runOneCommand(dir, session, "/effort");
      const msg = systemMessages.find((m) => m.text.includes("current effort"))!;
      assert.ok(msg, "expected a 'current effort is ...' message");
      assert.match(msg.text, /current effort is medium/);
      assert.match(msg.text, /off.*minimal.*low.*medium.*high.*xhigh.*max/);
      assert.ok(msg.parts && msg.parts.length > 0, "the report carries per-level colour parts");
    });
  });

  it("/effort max sets it and confirms in the requested phrasing, coloured by level", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeEffortSession();
      const { systemMessages } = await runOneCommand(dir, session, "/effort max");
      const msg = systemMessages.find((m) => m.text.startsWith("effort is set to"))!;
      assert.ok(msg, "expected 'effort is set to max' phrasing, not the old 'effort max' echo");
      assert.equal(msg.text, "effort is set to max");
      assert.equal(session.thinkingLevel, "max");
      const levelPart = msg.parts?.find((p) => p.text === "max");
      assert.equal(levelPart?.token, "effortMax");
    });
  });

  it("an unknown level reports the ladder rather than silently doing nothing", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeEffortSession();
      const { systemMessages } = await runOneCommand(dir, session, "/effort superduper");
      const msg = systemMessages.find((m) => m.text.includes("unknown effort"))!;
      assert.ok(msg);
      assert.equal(session.thinkingLevel, "medium", "an unknown level must not change anything");
    });
  });

  it("/effort is never refused the way /specialist and /model are", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeEffortSession();
      const { systemMessages } = await runOneCommand(dir, session, "/effort high");
      assert.ok(!systemMessages.some((m) => /frozen at boot/.test(m.text)), "/effort must not hit the specialist-freeze refusal path");
      assert.equal(session.thinkingLevel, "high");
    });
  });
});

describe("item 8: /usage and /context are local and free — they read in-memory state and call nothing", () => {
  it("/usage reports fresh/cache-read/cache-write/output separately, never combined", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeEffortSession();
      const state = freshState();
      state.turns = 2;
      state.usage.input = 500;
      state.usage.cacheRead = 4000;
      state.usage.cacheWrite = 300;
      state.usage.output = 120;
      state.usage.calls.push({ costUsd: 0.01, provider: "deepseek", model: "deepseek-v4-flash" } as never);
      state.usage.calls.push({ costUsd: 0.02, provider: "deepseek", model: "deepseek-v4-flash" } as never);
      const { systemMessages } = await runOneCommand(dir, session, "/usage", { state });
      const report = systemMessages.find((m) => m.text.startsWith("usage —"))!.text;
      assert.match(report, /fresh input {3}500/);
      assert.match(report, /cache read {4}4000/);
      assert.match(report, /cache write {3}300/);
      assert.match(report, /output {8}120/);
      assert.match(report, /\$0\.03/);
      assert.match(report, /deepseek\/deepseek-v4-flash {2}2 calls/);
    });
  });

  it("/usage with zero calls says so plainly rather than printing an empty table", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeEffortSession();
      const { systemMessages } = await runOneCommand(dir, session, "/usage");
      const report = systemMessages.find((m) => m.text.startsWith("usage —"))!.text;
      assert.match(report, /no calls yet/);
    });
  });

  it("/context reports Pi's measured figure and marks every estimate with a tilde", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeEffortSession();
      const { systemMessages } = await runOneCommand(dir, session, "/context", {
        contextInfo: () => ({
          systemPromptChars: 400,
          contextFiles: [{ name: "CLAUDE.md", bytes: 2000 }],
          skills: ["no-ai-slop"],
          toolNames: ["read", "bash", "edit", "write"],
        }),
      });
      const report = systemMessages.find((m) => m.text.startsWith("context"))!.text;
      assert.match(report, /context 12000 \/ 64000 \(19%\) {2}— measured by Pi/);
      assert.match(report, /~100 tokens/, "the system prompt estimate is marked with a tilde");
      assert.match(report, /CLAUDE\.md {6}~500 tokens/);
      assert.match(report, /no-ai-slop/);
      assert.match(report, /4 registered/);
    });
  });

  it("/context degrades honestly when the session exposes no usage figure", async () => {
    await withTempWorkspace(async (dir) => {
      const session: InteractiveSession = {
        sessionId: "s",
        systemPrompt: "x",
        isIdle: true,
        prompt: async () => {},
        steer: async () => {},
        abort: async () => {},
        waitForIdle: async () => {},
        getActiveToolNames: () => [],
        dispose: () => {},
      };
      const { systemMessages } = await runOneCommand(dir, session, "/context");
      const report = systemMessages.find((m) => m.text.startsWith("context"))!.text;
      assert.match(report, /this session exposes no usage figure/);
    });
  });

  it("neither /usage nor /context calls session.prompt — they are free", async () => {
    await withTempWorkspace(async (dir) => {
      let promptCalls = 0;
      const session = new FakeEffortSession();
      const originalPrompt = session.prompt.bind(session);
      session.prompt = async (text: string) => {
        promptCalls += 1;
        return originalPrompt(text);
      };
      await runOneCommand(dir, session, "/usage");
      await runOneCommand(dir, session, "/context");
      assert.equal(promptCalls, 0);
    });
  });
});
