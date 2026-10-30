// T34.1/T34.3/T34.4 — the orchestration state machine, exercised against a
// FAKE `InteractiveSession` with exact, scripted timing: no network call,
// no real terminal, and the steering race (a line arriving while a turn is
// still running) is made deterministic via `ScriptedLineSource.onWaiting()`
// — a one-shot signal that fires the moment the loop registers a new
// blocking read, rather than a real terminal's actual timing.
//
// The real SDK wiring (a `customTools` write/edit/bash shadowing a
// built-in, `createAgentSession` accepting them) is proven separately in
// `approval.test.ts` and `session.test.ts`/`session-acceptance.ts` — this
// file is only the loop built on top of it.

import { newRetryObservation } from "../loop/retry-observer.js";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { runInteractiveLoop, type InteractiveHandle, type InteractiveSession, type LineSource } from "./interactive.js";
import type { StandaloneSessionState } from "./session.js";
import type { AgentUi } from "../tui/s0.js";
import { openCredentialDb } from "../credentials/db.js";
import { listCredentials, readCredentialById } from "../credentials/pool.js";
import { createCredentialCommands } from "../tui/credential-commands.js";
import { createOutputStyleSwitcher } from "../config/output-styles.js";

/** Only the surface `runInteractiveLoop` itself calls (writeUser/writeSystem/writeHud/renderApproval/view/streamed) — attach()/snapshotJson() belong to the caller that constructs a real AgentUi, not to this loop. */
function fakeUi(): AgentUi & { userTexts: string[] } {
  return {
    view: { blocks: [], hud: null, toolsCollapsed: true, thinkingCollapsed: false },
    streamed: false,
    userTexts: [],
    writeUser(text: string) {
      this.userTexts.push(text);
    },
    writeSystem() {},
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
}

function defer<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * `FakeSession.steer()`/`prompt()` resolve their own "was I called" signal
 * SYNCHRONOUSLY inside their body, on the same tick as `runInteractiveLoop`'s
 * own continuation after `await session.steer(...)`/`await session.prompt(...)`.
 * Both continuations are scheduled around the same moment; a plain
 * `setImmediate` flush (draining the whole microtask queue first) is enough
 * to guarantee the loop's own synchronous state mutation has landed before
 * a test asserts on it.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

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

  /** Resolves once the loop is blocked waiting for a line — immediately if a waiter is already registered (covers the very first call, which races the caller), otherwise the next time `next()` registers one. One-shot for the future case; call again to arm the next wait. */
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

class FakeSession implements InteractiveSession {
  readonly sessionId = "fake-session";
  readonly systemPrompt = "fake";
  promptCalls: string[] = [];
  steerCalls: string[] = [];
  abortCalls = 0;
  disposed = false;
  private idle = true;

  get isIdle(): boolean {
    return this.idle;
  }
  private idleWaiters: Array<() => void> = [];
  private promptSignal = defer<void>();
  private steerSignal = defer<void>();

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
  const dir = mkdtempSync(join(tmpdir(), "lykos-t34-interactive-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("runInteractiveLoop (T34.1 multi-turn)", () => {
  it("starts a disk-rebuilt continuation prompt and exits when the threshold callback fires", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      let requested = false;
      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        initialPrompt: "Continue from the persisted task list.",
        continuationRequested: () => requested,
      });

      await flush();
      requested = true;
      session.resolveIdle();
      const result = await run;
      assert.equal(result.runState, "done");
      assert.deepEqual(session.promptCalls, ["Continue from the persisted task list."]);
      assert.equal(result.originalPrompt, "Continue from the persisted task list.");
      assert.equal(await lineSource.next(), null);
    });
  });

  it("reads a line, runs a turn, prints the reply, then reads the next line, and /exit ends cleanly", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
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

      await lineSource.onWaiting();
      lineSource.push("first prompt");
      await session.waitForPromptCall();
      state.lastText = "first reply";
      session.resolveIdle();

      await lineSource.onWaiting();
      lineSource.push("/exit");

      const result = await run;
      assert.equal(result.runState, "done");
      assert.deepEqual(session.promptCalls, ["first prompt"]);
      assert.equal(session.steerCalls.length, 0);
      assert.ok(replies.some((r) => r.includes("first reply")));
    });
  });

  it("runs a second turn after the first completes — the session outlives the turn", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
      });

      await lineSource.onWaiting();
      lineSource.push("one");
      await session.waitForPromptCall();
      session.resolveIdle();

      await lineSource.onWaiting();
      lineSource.push("two");
      await session.waitForPromptCall();
      session.resolveIdle();

      await lineSource.onWaiting();
      lineSource.push("/exit");

      await run;
      assert.deepEqual(session.promptCalls, ["one", "two"]);
    });
  });
});

describe("runInteractiveLoop (T34.3 steering)", () => {
  it("a line arriving while the turn is running is a steer(), not a new prompt — and human_interventions counts it", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
      });

      await lineSource.onWaiting();
      lineSource.push("do the thing");
      await session.waitForPromptCall();

      // The turn is now running (idle=false). The loop has already entered
      // the inner race and registered a new waiter on lineSource.
      await lineSource.onWaiting();
      lineSource.push("actually do it differently");
      await session.waitForSteerCall();
      await flush();

      assert.deepEqual(session.steerCalls, ["actually do it differently"]);
      assert.equal(state.humanInterventions, 1, "steer() must increment human_interventions");
      assert.deepEqual(session.promptCalls, ["do the thing"], "steering must not start a second top-level turn");

      await lineSource.onWaiting();
      session.resolveIdle();

      await lineSource.onWaiting();
      lineSource.push("/exit");
      const result = await run;
      assert.equal(result.runState, "done");
    });
  });

  it("a steer is shown through ui.writeUser — it must not silently vanish from the transcript", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      const ui = fakeUi();

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
        ui,
      });

      await lineSource.onWaiting();
      lineSource.push("do the thing");
      await session.waitForPromptCall();

      await lineSource.onWaiting();
      lineSource.push("actually do it differently");
      await session.waitForSteerCall();
      await flush();

      assert.deepEqual(ui.userTexts, ["do the thing", "actually do it differently"], "both the opening prompt and the mid-turn steer must reach the transcript");

      await lineSource.onWaiting();
      session.resolveIdle();
      await lineSource.onWaiting();
      lineSource.push("/exit");
      await run;
    });
  });
});

describe("runInteractiveLoop (T34.3 Ctrl-C: abort then end)", () => {
  it("interrupt() during a running turn aborts the turn and the session stays open", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      let handle: InteractiveHandle | undefined;

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
        onReady: (h) => {
          handle = h;
        },
      });

      await lineSource.onWaiting();
      lineSource.push("long running thing");
      await session.waitForPromptCall();

      // First Ctrl-C: aborts the turn, session stays open.
      handle!.interrupt();
      assert.equal(session.abortCalls, 1);

      await lineSource.onWaiting();
      lineSource.push("/exit");
      const result = await run;
      assert.equal(result.runState, "done", "a turn-abort must not end the session by itself");
      assert.equal(state.humanInterventions, 0, "an abort is not counted as a steering intervention (T34.3's own text)");
    });
  });

  it("an aborted turn that produced no new text does not re-print the PREVIOUS turn's reply (found live on a real DeepSeek call)", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      let handle: InteractiveHandle | undefined;
      const replies: string[] = [];

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: (t) => replies.push(t),
        onReady: (h) => {
          handle = h;
        },
      });

      await lineSource.onWaiting();
      lineSource.push("first prompt");
      await session.waitForPromptCall();
      state.lastText = "first reply";
      session.resolveIdle();
      await lineSource.onWaiting();

      lineSource.push("second prompt, will be aborted before any text arrives");
      await session.waitForPromptCall();
      // Abort before state.lastText ever changes — it is still "first reply".
      handle!.interrupt();

      await lineSource.onWaiting();
      lineSource.push("/exit");
      await run;

      assert.equal(replies.length, 1, "the stale reply must be printed once, not once per turn that leaves it unchanged");
      assert.ok(replies[0]!.includes("first reply"));
    });
  });

  it("interrupt() while idle ends the session cleanly, recorded as abandoned", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      let handle: InteractiveHandle | undefined;

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
        onReady: (h) => {
          handle = h;
        },
      });

      // Idle, waiting at the top-level prompt. Ctrl-C has taken two
      // presses inside a three-second window since 2026-09-02 round seven,
      // item 2 ("sometimes I just press Ctrl C and it exit instantly, stop
      // it") - the first arms, the second ends the session.
      await lineSource.onWaiting();
      handle!.interrupt();
      handle!.interrupt();

      const result = await run;
      assert.equal(result.runState, "aborted");
      assert.equal(session.disposed, false, "the loop itself does not dispose — the caller does, after ingest");
    });
  });
});

describe("runInteractiveLoop (T37 S0 commands)", () => {
  it("/help prints the command list and never reaches the session", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      const stderrChunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      (process.stderr.write as unknown) = (chunk: string) => {
        stderrChunks.push(String(chunk));
        return true;
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
        });
        await lineSource.onWaiting();
        lineSource.push("/help");
        await lineSource.onWaiting();
        lineSource.push("/exit");
        await run;
        assert.equal(session.promptCalls.length, 0);
        assert.ok(stderrChunks.some((c) => c.includes("/help") && c.includes("/compact")));
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  it("/session prints the running cost alongside id/model/turns/tokens, not just token counts", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      state.usage.calls.push({ costUsd: 0.0042 } as never);
      const stderrChunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      (process.stderr.write as unknown) = (chunk: string) => {
        stderrChunks.push(String(chunk));
        return true;
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
        });
        await lineSource.onWaiting();
        lineSource.push("/session");
        await lineSource.onWaiting();
        lineSource.push("/exit");
        await run;
        const out = stderrChunks.join("");
        assert.ok(out.includes("deepseek/deepseek-v4-flash"), "model is shown");
        assert.ok(out.includes(session.sessionId), "session id is shown");
        assert.ok(out.includes("$0.0042"), "the running cost is shown, not just token counts");
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  it("T209: /permissions bare and subcommands run locally and adjust permissions", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const stderrChunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      (process.stderr.write as unknown) = (chunk: string) => {
        stderrChunks.push(String(chunk));
        return true;
      };
      let liveMode = "manual";
      let permissionsChanged = 0;
      const permissionsPath = join(dir, "permissions.json");
      try {
        const run = runInteractiveLoop({
          session,
          lineSource,
          state: freshState(),
          ledgerPath: join(dir, ".lykos", "ledger.db"),
          config: SHIPPED_DEFAULTS,
          modelSpec: "deepseek/deepseek-v4-flash",
          writeReply: () => {},
          currentMode: () => liveMode as any,
          setMode: (m) => {
            liveMode = m;
          },
          projectId: "test-interactive-proj",
          permissionsOpts: { permissionsPath },
          onPermissionsChange: () => {
            permissionsChanged++;
          },
        });
        await lineSource.onWaiting();
        lineSource.push("/permissions");
        await lineSource.onWaiting();
        lineSource.push("/permissions mode auto");
        await lineSource.onWaiting();
        lineSource.push("/permissions revoke all");
        await lineSource.onWaiting();
        lineSource.push("/exit");
        await run;

        const out = stderrChunks.join("");
        assert.ok(out.includes("permission mode: Manual"), "bare permissions reports live mode");
        assert.equal(liveMode, "auto", "setMode was invoked with auto");
        assert.ok(permissionsChanged >= 2, "onPermissionsChange was triggered");
        assert.equal(session.promptCalls.length, 0, "no LLM turn was invoked");
        const written = JSON.parse(readFileSync(permissionsPath, "utf8"));
        assert.equal(written.projects["test-interactive-proj"]?.mode, "auto");
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });
});

describe("runInteractiveLoop — session naming (2026-09-07, UI feedback item 2)", () => {
  it("names the session from the first thing the user said, and reports it as derived", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const run = runInteractiveLoop({
        session,
        lineSource,
        state: freshState(),
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
      });
      await lineSource.onWaiting();
      lineSource.push("fix the exploration metric");
      await lineSource.onWaiting();
      lineSource.push("and then the repo map");
      await lineSource.onWaiting();
      lineSource.push("/exit");
      const result = await run;
      // The FIRST message, not the last: the name says what the session was
      // for, and a session renamed by every follow-up would be unfindable.
      assert.equal(result.sessionName, "fix the exploration metric");
      assert.equal(result.nameIsHuman, false);
    });
  });

  it("/rename outranks the derived name and is reported as a human's", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const renamed: string[] = [];
      const run = runInteractiveLoop({
        session,
        lineSource,
        state: freshState(),
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
        onRename: (name) => renamed.push(name),
      });
      await lineSource.onWaiting();
      lineSource.push("fix the exploration metric");
      await lineSource.onWaiting();
      lineSource.push("/rename the metric repair");
      await lineSource.onWaiting();
      lineSource.push("/exit");
      const result = await run;
      assert.equal(result.sessionName, "the metric repair");
      assert.equal(result.nameIsHuman, true);
      // The surface hears about it immediately, so the browser's row for
      // this session carries the name before ingest writes it.
      assert.deepEqual(renamed, ["the metric repair"]);
    });
  });

  it("a session where nothing was said gets no name at all rather than a placeholder", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const run = runInteractiveLoop({
        session,
        lineSource,
        state: freshState(),
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
      });
      await lineSource.onWaiting();
      lineSource.push("/exit");
      const result = await run;
      assert.equal(result.sessionName, undefined);
    });
  });
});

describe("runInteractiveLoop (specialists ticket 04: mid-session switching)", () => {
  it("/specialist with no listSpecialists/switchSpecialist wired says so, and never reaches the session", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      const chunks: string[] = [];
      const originalWrite = process.stderr.write.bind(process.stderr);
      (process.stderr.write as unknown) = (chunk: string) => {
        chunks.push(String(chunk));
        return true;
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
        });

        await lineSource.onWaiting();
        lineSource.push("/specialist");
        await lineSource.onWaiting();
        lineSource.push("/specialist budget");

        await lineSource.onWaiting();
        lineSource.push("/exit");

        const result = await run;
        assert.equal(result.runState, "done");
        assert.equal(session.promptCalls.length, 0, "a /specialist command must never reach session.prompt()");
        assert.ok(chunks.some((c) => c.includes("not available on this session")));
      } finally {
        process.stderr.write = originalWrite;
      }
    });
  });

  it("/specialist bare lists through listSpecialists(), and /specialist <name> switches through switchSpecialist()", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      const reports: string[] = [];
      let switchedTo: string | undefined;

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
        listSpecialists: () => "lykos: available specialists (* = active)\n* minimal — do the smallest thing",
        switchSpecialist: async (name) => {
          switchedTo = name;
          return { ok: true, report: `lykos: specialist is now "${name}" — changed: model: a -> b` };
        },
        ui: {
          ...fakeUi(),
          writeSystem: (text: string) => {
            reports.push(text);
          },
        },
      });

      await lineSource.onWaiting();
      lineSource.push("/specialist");
      await lineSource.onWaiting();
      lineSource.push("/specialist deliberate");

      await lineSource.onWaiting();
      lineSource.push("/exit");

      const result = await run;
      assert.equal(result.runState, "done");
      assert.equal(session.promptCalls.length, 0, "/specialist must never itself reach session.prompt()");
      assert.equal(switchedTo, "deliberate");
      assert.ok(reports.some((r) => r.includes("available specialists")));
      assert.ok(reports.some((r) => r.includes('specialist is now "deliberate"')));
    });
  });

  it("switching to a specialist that does not exist leaves the session unchanged and says so", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      const reports: string[] = [];

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
        switchSpecialist: async () => ({ ok: false, message: 'lykos: no specialist named "typo" — available specialists: minimal' }),
        ui: {
          ...fakeUi(),
          writeSystem: (text: string) => {
            reports.push(text);
          },
        },
      });

      await lineSource.onWaiting();
      lineSource.push("/specialist typo");
      await lineSource.onWaiting();
      lineSource.push("/exit");

      const result = await run;
      assert.equal(result.runState, "done");
      assert.equal(session.promptCalls.length, 0);
      assert.equal(state.specialistSwitches ?? 0, 0, "a failed switch must not be recorded");
      assert.ok(reports.some((r) => r.includes("refused") && r.includes("typo")));
    });
  });
});

describe("runInteractiveLoop (T217: mid-session /output-style switching)", () => {
  it("/output-style bare lists styles and /output-style <name> queues notice on next turn", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      const reports: string[] = [];
      const switcher = createOutputStyleSwitcher({
        cwd: dir,
        globalDir: dir,
        initialOutputStyleName: "default",
      });

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
        listOutputStyles: switcher.listOutputStyles,
        switchOutputStyle: switcher.switchOutputStyle,
        takeOutputStyleNotice: switcher.takeOutputStyleNotice,
        ui: {
          ...fakeUi(),
          writeSystem: (text: string) => {
            reports.push(text);
          },
        },
      });

      await lineSource.onWaiting();
      lineSource.push("/output-style");
      await lineSource.onWaiting();
      lineSource.push("/output-style minimal");
      await lineSource.onWaiting();
      lineSource.push("hello world");
      await session.waitForPromptCall();
      session.resolveIdle();
      await lineSource.onWaiting();
      lineSource.push("/exit");

      const result = await run;
      assert.equal(result.runState, "done");
      assert.equal(switcher.currentOutputStyleName(), "minimal");
      assert.ok(reports.some((r) => r.includes("available output styles")));
      assert.ok(reports.some((r) => r.includes('output style is now "minimal"')));

      // Verify the next turn received the notice and style instructions prepended
      assert.equal(session.promptCalls.length, 1);
      const firstPrompt = session.promptCalls[0]!;
      assert.match(firstPrompt, /Output style is now "minimal"\./);
      assert.match(firstPrompt, /Write replies following these shape and brevity rules:/);
      assert.match(firstPrompt, /hello world/);
    });
  });

  it("/output-style leaves the frozen head byte-identical; the change rides the next prompt", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const head = ["HEAD-BASE", "## lykos-output-style", "boot style text"].join("\n\n");
      (session as { systemPrompt: string }).systemPrompt = head;
      const before = session.systemPrompt;
      const lineSource = new ScriptedLineSource();
      const switcher = createOutputStyleSwitcher({
        cwd: dir,
        globalDir: dir,
        initialOutputStyleName: "default",
      });

      const run = runInteractiveLoop({
        session,
        lineSource,
        state: freshState(),
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
        listOutputStyles: switcher.listOutputStyles,
        switchOutputStyle: switcher.switchOutputStyle,
        takeOutputStyleNotice: switcher.takeOutputStyleNotice,
        ui: fakeUi(),
      });

      await lineSource.onWaiting();
      lineSource.push("/output-style minimal");
      await lineSource.onWaiting();
      lineSource.push("next turn");
      await session.waitForPromptCall();
      session.resolveIdle();
      await lineSource.onWaiting();
      lineSource.push("/exit");
      await run;

      assert.equal(session.systemPrompt, before, "the head must be byte-identical after the switch");
      assert.equal(switcher.currentOutputStyleName(), "minimal");
      assert.equal(session.promptCalls.length, 1);
      assert.match(session.promptCalls[0]!, /Output style is now "minimal"\./);
      assert.match(session.promptCalls[0]!, /Write replies following these shape and brevity rules:/);
      assert.match(session.promptCalls[0]!, /next turn/);
    });
  });

  it("subsequent /output-style switch replaces unconsumed notice", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      let pendingNotice: string | undefined;

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
        switchOutputStyle: async (name) => {
          pendingNotice = `Output style is now "${name}".\n\n${name === "terse" ? "Terse text." : "Minimal text."}`;
          return {
            ok: true,
            report: `lykos: output style is now "${name}"`,
          };
        },
        takeOutputStyleNotice: () => {
          const n = pendingNotice;
          pendingNotice = undefined;
          return n;
        },
      });

      await lineSource.onWaiting();
      lineSource.push("/output-style minimal");
      await lineSource.onWaiting();
      lineSource.push("/output-style terse");
      await lineSource.onWaiting();
      lineSource.push("hello world");
      await session.waitForPromptCall();
      session.resolveIdle();
      await lineSource.onWaiting();
      lineSource.push("/exit");

      const result = await run;
      assert.equal(result.runState, "done");
      assert.equal(session.promptCalls.length, 1);
      const firstPrompt = session.promptCalls[0]!;
      assert.doesNotMatch(firstPrompt, /Output style is now "minimal"\./);
      assert.match(firstPrompt, /Output style is now "terse"\./);
      assert.match(firstPrompt, /Terse text\./);
    });
  });

  it("switching to an unknown output style reports refusal and queues nothing", async () => {
    await withTempWorkspace(async (dir) => {
      const session = new FakeSession();
      const lineSource = new ScriptedLineSource();
      const state = freshState();
      const reports: string[] = [];

      const run = runInteractiveLoop({
        session,
        lineSource,
        state,
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "deepseek/deepseek-v4-flash",
        writeReply: () => {},
        switchOutputStyle: async () => ({ ok: false, message: 'lykos: no output style named "bad"' }),
        ui: {
          ...fakeUi(),
          writeSystem: (text: string) => {
            reports.push(text);
          },
        },
      });

      await lineSource.onWaiting();
      lineSource.push("/output-style bad");
      await lineSource.onWaiting();
      lineSource.push("plain prompt");
      await session.waitForPromptCall();
      session.resolveIdle();
      await lineSource.onWaiting();
      lineSource.push("/exit");

      const result = await run;
      assert.equal(result.runState, "done");
      assert.ok(reports.some((r) => r.includes("output style switch refused — lykos: no output style named \"bad\"")));
      assert.equal(session.promptCalls.length, 1);
      assert.equal(session.promptCalls[0], "plain prompt");
    });
  });
});

describe("runInteractiveStandaloneSession (specialists ticket 04: --specialist wiring)", () => {
  it("lykos run --interactive --specialist <bad name> errors before any model resolution or ledger write", async () => {
    await withTempWorkspace(async (dir) => {
      const { runInteractiveStandaloneSession } = await import("./interactive.js");
      // No specialists exist anywhere under `dir` — a name that cannot resolve
      // must fail inside loadConfig(), before ModelRuntime.create() ever
      // runs, so this needs no network and no fake session.
      const result = await runInteractiveStandaloneSession({
        workspace: dir,
        specialist: "does-not-exist",
        ledgerPath: join(dir, ".lykos", "ledger.db"),
      });
      assert.equal(result.status, "error");
      if (result.status === "error") {
        assert.match(result.message, /no specialist named "does-not-exist"/);
      }
    });
  });
});

/** A scripted source that can also read a secret, recording that it was asked to. */
class SecretScriptedLineSource extends ScriptedLineSource {
  secretReads = 0;
  nextSecret(): Promise<string | null> {
    this.secretReads += 1;
    return this.next();
  }
}

describe("P14.6 ticket 06: /login and /credential in the TUI", () => {
  it("/login openai --api-key stores a row through the shared login flow, reading the key as a secret", async () => {
    await withTempWorkspace(async (dir) => {
      const dbPath = join(dir, "credentials.db");
      const session = new FakeSession();
      const lineSource = new SecretScriptedLineSource();
      const printed: string[] = [];
      const commands = createCredentialCommands({
        session: { sessionId: session.sessionId, model: { provider: "openai" } },
        config: SHIPPED_DEFAULTS,
        dbPath,
      });
      const run = runInteractiveLoop({
        session,
        lineSource,
        state: freshState(),
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "openai/gpt-5",
        writeReply: () => {},
        ui: { ...fakeUi(), writeSystem: (text: string) => void printed.push(text) },
        login: commands.login,
        credential: commands.credential,
      });

      await lineSource.onWaiting();
      lineSource.push("/login openai --api-key");
      await lineSource.onWaiting();
      lineSource.push("sk-tui-DISTINCTIVE-SECRET");
      await lineSource.onWaiting();
      lineSource.push("/credential");
      await lineSource.onWaiting();
      lineSource.push("/exit");
      const result = await run;

      assert.equal(result.runState, "done");
      assert.equal(session.promptCalls.length, 0, "neither the command nor the key reached the model");
      assert.equal(lineSource.secretReads, 1, "the key was read through the masked path");
      const db = openCredentialDb(dbPath, { create: false })!;
      try {
        const rows = listCredentials(db, "openai");
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.type, "api_key");
        assert.equal(JSON.parse(readCredentialById(db, rows[0]!.id)!.data).key, "sk-tui-DISTINCTIVE-SECRET");
      } finally {
        db.close();
      }
      const all = printed.join("\n");
      assert.match(all, /warning — openai's sanction for third-party use is unverified/, "the sanction warning shows in the TUI too");
      assert.match(all, /openai API key, \$VAR or !command:/);
      assert.match(all, /logged in to openai as key#1 \(1 credential\(s\) in pool\)/);
      assert.match(all, /credentials for openai[\s\S]*\* key#1 {2}api_key {2}ready/, "the bare listing marks the serving row");
      assert.ok(!all.includes("sk-tui-DISTINCTIVE-SECRET"), "the key is never printed");
    });
  });

  it("/login with no provider prints usage and stores nothing", async () => {
    await withTempWorkspace(async (dir) => {
      const dbPath = join(dir, "credentials.db");
      const session = new FakeSession();
      const lineSource = new SecretScriptedLineSource();
      const printed: string[] = [];
      const commands = createCredentialCommands({ session, config: SHIPPED_DEFAULTS, dbPath });
      const run = runInteractiveLoop({
        session,
        lineSource,
        state: freshState(),
        ledgerPath: join(dir, ".lykos", "ledger.db"),
        config: SHIPPED_DEFAULTS,
        modelSpec: "openai/gpt-5",
        writeReply: () => {},
        ui: { ...fakeUi(), writeSystem: (text: string) => void printed.push(text) },
        login: commands.login,
      });
      await lineSource.onWaiting();
      lineSource.push("/login");
      await lineSource.onWaiting();
      lineSource.push("/exit");
      await run;
      assert.ok(printed.includes("usage: /login <provider> [--api-key]"));
      assert.equal(openCredentialDb(dbPath, { create: false }), undefined);
    });
  });
});
