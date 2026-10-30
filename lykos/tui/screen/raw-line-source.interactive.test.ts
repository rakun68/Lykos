// T46.4's acceptance: "`interactive.test.ts` passes unchanged against the
// new line source." That file's own suite is left untouched — this is a
// SEPARATE proof, replaying the same scenarios it covers (a full turn,
// steering mid-turn, Ctrl-C abort-then-end) against `runInteractiveLoop`
// with `RawLineSource` standing in for the scripted fake `LineSource`,
// driven by raw bytes through the real key decoder instead of by pushed
// strings. If the loop's `pendingRead` discipline broke for a real
// `LineSource` implementation, it would show up here as a hang.

import { newRetryObservation } from "../../loop/retry-observer.js";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../../config/defaults.js";
import { runInteractiveLoop, type InteractiveSession } from "../../session/interactive.js";
import type { StandaloneSessionState } from "../../session/session.js";
import { RawLineSource } from "./raw-line-source.js";

function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Waits until the loop has registered a blocking read on `src`, spinning a few event-loop ticks — RawLineSource has no one-shot "waiting" signal the way the scripted fake in interactive.test.ts does. */
async function waitForPendingRead(src: RawLineSource): Promise<void> {
  for (let i = 0; i < 50 && !src.hasPendingRead; i++) await flush();
  assert.ok(src.hasPendingRead, "loop never registered a pending read");
}

class FakeSession implements InteractiveSession {
  readonly sessionId = "fake-session";
  readonly systemPrompt = "fake";
  promptCalls: string[] = [];
  steerCalls: string[] = [];
  abortCalls = 0;
  disposed = false;
  private idle = true;
  private idleWaiters: Array<() => void> = [];
  private promptSignal = defer<void>();
  private steerSignal = defer<void>();

  get isIdle(): boolean {
    return this.idle;
  }

  async prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
    this.idle = false;
    this.promptSignal.resolve();
    this.promptSignal = defer();
  }

  async steer(text: string): Promise<void> {
    this.steerCalls.push(text);
    this.steerSignal.resolve();
    this.steerSignal = defer();
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.resolveIdle();
  }

  async waitForIdle(): Promise<void> {
    if (this.idle) return;
    await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
  }

  resolveIdle(): void {
    this.idle = true;
    for (const w of this.idleWaiters.splice(0)) w();
  }

  waitForPromptCall(): Promise<void> {
    return this.promptSignal.promise;
  }

  waitForSteerCall(): Promise<void> {
    return this.steerSignal.promise;
  }

  getActiveToolNames(): string[] {
    return ["read", "bash", "edit", "write"];
  }

  dispose(): void {
    this.disposed = true;
  }
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
      calls: [],
    },
    toolCalls: [],
    turns: 0,
    lastText: "",
    humanInterventions: 0,
  retry: newRetryObservation(),
  };
}

async function withTempWorkspace<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "lykos-raw-linesource-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("T46.4: runInteractiveLoop against RawLineSource — a real turn, typed as raw bytes", () => {
  it("types a prompt, submits it, and /exit ends the session cleanly", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new RawLineSource();
      const state = freshState();
      const replies: string[] = [];

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: (t) => replies.push(t),
      });

      await flush();
      lineSource.feedBytes("first prompt\r");
      lineSource.flushPending(); // the idle gap a real session's router always provides
      await session.waitForPromptCall();
      state.lastText = "first reply";
      session.resolveIdle();

      await flush();
      lineSource.feedBytes("/exit\r");
      lineSource.flushPending(); // the idle gap a real session's router always provides

      const result = await run;
      assert.equal(result.runState, "done");
      assert.deepEqual(session.promptCalls, ["first prompt"]);
      assert.ok(replies.some((r) => r.includes("first reply")));
    });
  });

  it("a line typed while a turn is running is a steer(), not a new prompt", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new RawLineSource();
      const state = freshState();

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
      });

      await flush();
      lineSource.feedBytes("go\r");
      lineSource.flushPending(); // the idle gap a real session's router always provides
      await session.waitForPromptCall();
      await waitForPendingRead(lineSource); // let the loop register its inner steering read

      lineSource.feedBytes("steer this\r");
      lineSource.flushPending(); // the idle gap a real session's router always provides
      await session.waitForSteerCall();
      await flush();
      assert.deepEqual(session.steerCalls, ["steer this"]);
      assert.equal(state.humanInterventions, 1);

      session.resolveIdle();
      await flush();
      lineSource.feedBytes("/exit\r");
      lineSource.flushPending(); // the idle gap a real session's router always provides
      const result = await run;
      assert.equal(result.runState, "done");
    });
  });

  it("Ctrl-C during a running turn aborts the turn and keeps the session open, wired through onInterrupt", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new RawLineSource({
        onInterrupt: () => handle.interrupt(),
      });
      const state = freshState();
      let handle!: import("../../session/interactive.js").InteractiveHandle;

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        onReady: (h) => (handle = h),
      });

      await flush();
      lineSource.feedBytes("go\r");
      lineSource.flushPending(); // the idle gap a real session's router always provides
      await session.waitForPromptCall();
      await flush();

      lineSource.feedBytes("\x03"); // Ctrl-C
      await flush();
      assert.equal(session.abortCalls, 1);

      session.resolveIdle();
      await flush();
      lineSource.feedBytes("/exit\r");
      lineSource.flushPending(); // the idle gap a real session's router always provides
      const result = await run;
      assert.equal(result.runState, "done");
    });
  });
});
