import { newRetryObservation } from "../../loop/retry-observer.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../../config/defaults.js";
import type { StandaloneSessionState } from "../../session/session.js";
import type { StreamEvent } from "../s0.js";
import { resolveTheme } from "../theme/resolve.js";
import { createFullscreenAgentUi } from "./fullscreen-ui.js";
import { ScreenPipeline } from "./pipeline.js";

const mono = resolveTheme("mono", "none", "unicode");

function freshState(): StandaloneSessionState {
  return {
    usage: {
      input: 1000,
      output: 200,
      cacheRead: 9000,
      cacheWrite: 500,
      cacheWrite1h: 0,
      reasoning: 0,
      nestedInput: 0,
      nestedOutput: 0,
      nestedCacheRead: 0,
      nestedCacheWrite: 0,
      calls: [
        {
          hop: "direct",
          source: "assistant_message",
          provider: "deepseek",
          model: "deepseek-v4-flash",
          input: 1000,
          output: 200,
          cacheRead: 9000,
          cacheWrite: 500,
          costUsd: 0.01,
          ts: Date.now(),
        },
      ],
    },
    toolCalls: [],
    turns: 1,
    lastText: "",
    humanInterventions: 0,
  retry: newRetryObservation(),
  } as StandaloneSessionState;
}

class CapturingSink {
  writes: string[] = [];
  write(text: string): void {
    this.writes.push(text);
  }
  get all(): string {
    return this.writes.join("");
  }
}

function header() {
  return {
    product: "LYKOS",
    version: "0.0.1",
    model: "deepseek-v4-flash",
    cwd: "/work",
    branch: null,
    sessionId: "sess1",
    executionShape: "standalone",
  };
}

describe("createFullscreenAgentUi — the same AgentUi contract as createAgentUi(), backed by ScreenPipeline", () => {
  it("streams text_delta as one flowing block, records tool start/end with a diff, and --json matches the HUD ViewModel", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    const ui = createFullscreenAgentUi({ pipeline, header: header(), ledgerPath: ":memory:", config: SHIPPED_DEFAULTS, startedUtc: "2026-08-31T00:00:00Z", theme: mono });

    const listeners: Array<(ev: StreamEvent) => void> = [];
    const unsub = ui.attach({ subscribe: (fn) => (listeners.push(fn), () => {}) }, () => freshState());

    ui.writeUser("fix the header");
    listeners[0]!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hi" } });
    listeners[0]!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " there" } });
    listeners[0]!({ type: "message_update", assistantMessageEvent: { type: "text_end" } });
    listeners[0]!({
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "edit",
      args: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] },
    });
    listeners[0]!({
      type: "tool_execution_end",
      toolCallId: "t1",
      toolName: "edit",
      args: { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] },
      isError: false,
      result: { ok: true },
    });
    unsub();

    // Force a full redraw so the last write is the whole current frame.
    pipeline.resize(100, 24);
    pipeline.flush();
    const frame = sink.writes.at(-2)!; // frame write, then the trailing cursor escape

    assert.match(frame, /fix the header/);
    assert.match(frame, /Hi there/);
    // "Hi there" appears exactly once — accumulated in place, not once as
    // "Hi" and again as "Hi there" on a second line.
    assert.equal((frame.match(/Hi there/g) ?? []).length, 1);
    assert.doesNotMatch(frame, /(?<!Hi )there.*Hi there|Hi there.*\nHi/);
    assert.match(frame, /edit/);
    assert.match(frame, /a\.ts/);
    assert.equal(ui.streamed, true);

    const hud = ui.writeHud(freshState(), "sess1");
    assert.equal(hud.tokens.counters.cacheRead, 9000);
    assert.equal(hud.tokens.counters.cacheWrite, 500);
    assert.equal(ui.snapshotJson(), JSON.stringify(hud));

    pipeline.stop();
  });

  it("a bash tool call renders as a bash block with its output and exit code, not a generic tool line", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    const ui = createFullscreenAgentUi({ pipeline, header: header(), ledgerPath: ":memory:", config: SHIPPED_DEFAULTS, startedUtc: "2026-08-31T00:00:00Z", theme: mono });
    const listeners: Array<(ev: StreamEvent) => void> = [];
    ui.attach({ subscribe: (fn) => (listeners.push(fn), () => {}) }, () => freshState());

    listeners[0]!({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "npm test" } });
    listeners[0]!({
      type: "tool_execution_end",
      toolCallId: "b1",
      toolName: "bash",
      args: { command: "npm test" },
      isError: false,
      result: { output: "863 passing", exitCode: 0 },
    });

    pipeline.resize(100, 24);
    pipeline.flush();
    const frame = sink.writes.at(-2)!;
    assert.match(frame, /npm test/);
    assert.match(frame, /863 passing/);
    assert.match(frame, /exit 0/);
    pipeline.stop();
  });

  it("a fresh user turn starts a new streaming block — two turns don't merge into one paragraph", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    const ui = createFullscreenAgentUi({ pipeline, header: header(), ledgerPath: ":memory:", config: SHIPPED_DEFAULTS, startedUtc: "2026-08-31T00:00:00Z", theme: mono });
    const listeners: Array<(ev: StreamEvent) => void> = [];
    ui.attach({ subscribe: (fn) => (listeners.push(fn), () => {}) }, () => freshState());

    ui.writeUser("first");
    listeners[0]!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "reply one" } });
    listeners[0]!({ type: "message_update", assistantMessageEvent: { type: "text_end" } });
    ui.writeUser("second");
    listeners[0]!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "reply two" } });
    listeners[0]!({ type: "message_update", assistantMessageEvent: { type: "text_end" } });

    pipeline.resize(100, 24);
    pipeline.flush();
    const frame = sink.writes.at(-2)!;
    assert.match(frame, /reply one/);
    assert.match(frame, /reply two/);
    assert.doesNotMatch(frame, /reply onereply two|reply one reply two/);
    pipeline.stop();
  });

  it("/thinking off (thinkingCollapsed=true) suppresses new thinking blocks", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    const ui = createFullscreenAgentUi({ pipeline, header: header(), ledgerPath: ":memory:", config: SHIPPED_DEFAULTS, startedUtc: "2026-08-31T00:00:00Z", theme: mono });
    ui.view.thinkingCollapsed = true;
    const listeners: Array<(ev: StreamEvent) => void> = [];
    ui.attach({ subscribe: (fn) => (listeners.push(fn), () => {}) }, () => freshState());

    listeners[0]!({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hidden reasoning" } });
    pipeline.resize(100, 24);
    pipeline.flush();
    assert.doesNotMatch(sink.writes.at(-2)!, /hidden reasoning/);
    pipeline.stop();
  });

  it("renderApproval echoes the decision into scrollback for the historical record", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    const ui = createFullscreenAgentUi({ pipeline, header: header(), ledgerPath: ":memory:", config: SHIPPED_DEFAULTS, startedUtc: "2026-08-31T00:00:00Z", theme: mono });
    const label = ui.renderApproval({ kind: "write", summary: "write demo.ts", detail: "/work/demo.ts" });
    assert.match(label, /write/);
    pipeline.resize(100, 24);
    pipeline.flush();
    assert.match(sink.writes.at(-2)!, /write demo\.ts/);
    pipeline.stop();
  });
});

describe("2026-09-02: the animated 'Working...' status line, modeled on Pi's own Loader component", () => {
  it("shows immediately on writeUser, before any delta arrives, and clears on the first delta", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    const ui = createFullscreenAgentUi({ pipeline, header: header(), ledgerPath: ":memory:", config: SHIPPED_DEFAULTS, startedUtc: "2026-08-31T00:00:00Z", theme: mono });
    const listeners: Array<(ev: StreamEvent) => void> = [];
    const unsub = ui.attach({ subscribe: (fn) => (listeners.push(fn), () => {}) }, () => freshState());

    ui.writeUser("hi");
    pipeline.flush();
    assert.match(sink.writes.at(-2)!, /Working\.\.\./, "no status line appeared the instant a turn started");

    listeners[0]!({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hello" } });
    pipeline.flush();
    assert.doesNotMatch(sink.writes.at(-2)!, /Working\.\.\./, "status line should clear once real content starts streaming");

    unsub();
    pipeline.stop();
  });

  it("a tool call clears it too, not just a text/thinking delta", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    const ui = createFullscreenAgentUi({ pipeline, header: header(), ledgerPath: ":memory:", config: SHIPPED_DEFAULTS, startedUtc: "2026-08-31T00:00:00Z", theme: mono });
    const listeners: Array<(ev: StreamEvent) => void> = [];
    const unsub = ui.attach({ subscribe: (fn) => (listeners.push(fn), () => {}) }, () => freshState());

    ui.writeUser("hi");
    listeners[0]!({ type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path: "a.ts" } });
    pipeline.flush();
    assert.doesNotMatch(sink.writes.at(-2)!, /Working\.\.\./);

    unsub();
    pipeline.stop();
  });

  it("endTurn() stops it even when a turn produced no visible content at all (an immediate abort)", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    const ui = createFullscreenAgentUi({ pipeline, header: header(), ledgerPath: ":memory:", config: SHIPPED_DEFAULTS, startedUtc: "2026-08-31T00:00:00Z", theme: mono });
    ui.writeUser("hi");
    ui.endTurn?.();
    pipeline.flush();
    assert.doesNotMatch(sink.writes.at(-2)!, /Working\.\.\./);
    pipeline.stop();
  });

  it("attach()'s returned unsubscribe also stops the timer — no leaked interval after teardown", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    const ui = createFullscreenAgentUi({ pipeline, header: header(), ledgerPath: ":memory:", config: SHIPPED_DEFAULTS, startedUtc: "2026-08-31T00:00:00Z", theme: mono });
    const unsub = ui.attach({ subscribe: (fn) => (void fn, () => {}) }, () => freshState());
    ui.writeUser("hi");
    unsub(); // must clear the interval, not just the (no-op) session subscription
    pipeline.flush();
    assert.doesNotMatch(sink.writes.at(-2)!, /Working\.\.\./);
    pipeline.stop();
  });
});
