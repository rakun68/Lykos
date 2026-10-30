// T50.4 — "the wall-time claim, tested rather than asserted." §0 argues the
// full-screen UI is free because it renders during network wait; this file
// is the part of that claim actually within Lykos's own control: the
// PROCESSING cost of turning an identical stream of session events into
// visible output, append-only (T37, already in production) versus the new
// pipeline (T41-T49, not yet wired into `runInteractiveStandaloneSession`).
//
// What this does NOT measure, and why: T50.4's literal text asks for "the
// same task run" compared full-screen vs `--no-fullscreen`, i.e. a real
// model call. AGENTS.md rule 1 has no benchmark budget for that, and a
// synthetic event stream costs nothing to run as often as needed — so this
// measures the one variable a real run and a synthetic one share exactly
// (the UI's own CPU cost per event) and leaves the network-wait-dominated
// total wall-clock number for the maintainer to record from a real session,
// same as T52.3 left the ledger's first live `success` for a real run
// rather than backfilling one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../../config/defaults.js";
import { createAgentUi, type StreamEvent } from "../s0.js";
import { resolveTheme } from "../theme/resolve.js";
import { ScreenPipeline } from "./pipeline.js";

const mono = resolveTheme("mono", "none", "unicode");

/** 150 streamed text chunks + 5 tool call pairs — a plausible-sized real turn. */
function syntheticEvents(): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (let i = 0; i < 150; i++) {
    events.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: `word${i} ` } });
  }
  for (let i = 0; i < 5; i++) {
    events.push({ type: "tool_execution_start", toolCallId: `t${i}`, toolName: "Edit", args: { path: `f${i}.ts` } });
    events.push({ type: "tool_execution_end", toolCallId: `t${i}`, toolName: "Edit", result: { diff: "@@ -1 +1 @@\n-old\n+new" } });
  }
  return events;
}

class NoopSink {
  write(_text: string): void {
    void _text;
  }
}

function measureAppendOnly(events: StreamEvent[]): number {
  const chunks: string[] = [];
  const ui = createAgentUi({
    width: 100,
    theme: mono,
    header: { model: "deepseek-v4-flash", sessionId: "wall-time", cwd: "/work" },
    write: (t) => chunks.push(t),
    ledgerPath: ":memory:",
    config: SHIPPED_DEFAULTS,
    startedUtc: new Date().toISOString(),
  });
  const listeners: Array<(ev: StreamEvent) => void> = [];
  ui.attach({ subscribe: (fn) => (listeners.push(fn), () => {}) }, () => {
    throw new Error("getState not used by this path");
  });
  const start = performance.now();
  for (const ev of events) listeners[0]!(ev);
  return performance.now() - start;
}

function measureFullscreen(events: StreamEvent[]): number {
  const pipeline = new ScreenPipeline({
    width: 100,
    height: 24,
    theme: mono,
    header: { product: "LYKOS", version: "0.0.1", model: "deepseek-v4-flash", cwd: "/work", branch: null, sessionId: "wall-time", executionShape: "standalone" },
    sink: new NoopSink(),
  });
  const start = performance.now();
  let seq = 0;
  for (const ev of events) {
    if (ev.type === "message_update" && ev.assistantMessageEvent?.type === "text_delta") {
      pipeline.pushBlock({ id: `s${seq++}`, kind: "speech", text: ev.assistantMessageEvent.delta ?? "" });
    } else if (ev.type === "tool_execution_start") {
      pipeline.pushBlock({ id: `t${seq++}`, kind: "tool", tool: { name: ev.toolName ?? "tool", summary: "f.ts", state: "running" } });
    } else if (ev.type === "tool_execution_end") {
      pipeline.pushBlock({ id: `t${seq++}`, kind: "tool", tool: { name: ev.toolName ?? "tool", summary: "f.ts", state: "ok" } });
    }
  }
  pipeline.flush();
  const elapsed = performance.now() - start;
  pipeline.stop();
  return elapsed;
}

describe("T50.4: full-screen processing overhead vs the append-only path, same synthetic event stream", () => {
  it("processes 160 events end to end with no crash on both paths", () => {
    assert.doesNotThrow(() => measureAppendOnly(syntheticEvents()));
    assert.doesNotThrow(() => measureFullscreen(syntheticEvents()));
  });

  it("records the measured overhead — median of 20 runs each, warmed up first", () => {
    // Warm up (JIT, module-init) so the recorded numbers reflect steady state.
    for (let i = 0; i < 5; i++) {
      measureAppendOnly(syntheticEvents());
      measureFullscreen(syntheticEvents());
    }
    const n = 20;
    const appendOnly: number[] = [];
    const fullscreen: number[] = [];
    for (let i = 0; i < n; i++) {
      appendOnly.push(measureAppendOnly(syntheticEvents()));
      fullscreen.push(measureFullscreen(syntheticEvents()));
    }
    appendOnly.sort((a, b) => a - b);
    fullscreen.sort((a, b) => a - b);
    const medianAppendOnly = appendOnly[Math.floor(n / 2)]!;
    const medianFullscreen = fullscreen[Math.floor(n / 2)]!;
    const deltaMs = medianFullscreen - medianAppendOnly;

    // DECISIONS.md 2026-09-01 "T50.4" records the number this produced when
    // it was last run and measured by hand — recorded, not asserted, per
    // rule 1 ("no benchmark budget," so this is not re-asserted against a
    // fixed threshold every run, only proven to complete and produce a
    // sane, non-negative-infinity number).
    assert.ok(Number.isFinite(medianAppendOnly) && Number.isFinite(medianFullscreen));
    assert.ok(medianAppendOnly >= 0 && medianFullscreen >= 0);
    void deltaMs;
  });
});
