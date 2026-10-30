import { newRetryObservation } from "../loop/retry-observer.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import type { StandaloneSessionState } from "../session/session.js";
import { resolveTheme } from "./theme/resolve.js";
import { createAgentUi, parseInteractiveInput, piContextFraction, runFromSessionState, type StreamEvent } from "./s0.js";
import { contextSegment } from "./renderers/line.js";

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
    lastText: "hello",
    humanInterventions: 0,
  retry: newRetryObservation(),
  };
}

describe("parseInteractiveInput", () => {
  it("maps Pi-shaped commands to owned actions and leaves unknown /foo as a prompt", () => {
    assert.equal(parseInteractiveInput("").kind, "empty");
    assert.equal(parseInteractiveInput("/exit").kind, "exit");
    assert.equal(parseInteractiveInput("/quit").kind, "exit");
    assert.equal(parseInteractiveInput("/help").kind, "help");
    assert.equal(parseInteractiveInput("/hotkeys").kind, "help");
    // Ticket 04: /specialist is no longer refused — bare lists, a name switches.
    assert.equal(parseInteractiveInput("/specialist").kind, "specialist-list");
    assert.equal(parseInteractiveInput("/specialist budget").kind, "specialist-switch");
    assert.equal(parseInteractiveInput("/model").kind, "refuse-model");
    assert.equal(parseInteractiveInput("hello").kind, "prompt");
    const skill = parseInteractiveInput("/skill:review");
    assert.equal(skill.kind, "prompt");
    const bang = parseInteractiveInput("!ls");
    assert.equal(bang.kind, "bash");
    if (bang.kind === "bash") assert.equal(bang.sendToModel, true);
    const quiet = parseInteractiveInput("!!date");
    assert.equal(quiet.kind, "bash");
    if (quiet.kind === "bash") assert.equal(quiet.sendToModel, false);
    const cont = parseInteractiveInput("hello\\");
    assert.equal(cont.kind, "continue");
  });

  // 2026-09-07 (UI feedback item 2).
  it("parses /rename and its /name alias, and treats a bare one as a question", () => {
    const named = parseInteractiveInput("/rename the parser rename");
    assert.equal(named.kind, "rename");
    if (named.kind === "rename") assert.equal(named.name, "the parser rename");
    const aliased = parseInteractiveInput("/name something else");
    assert.equal(aliased.kind, "rename");
    // No argument is a REPORT, not a clear: a command whose only visible
    // effect is a changed word in a list should be askable before it is
    // used, and "erase the name" is not a thing anyone typed.
    const bare = parseInteractiveInput("/rename");
    assert.equal(bare.kind, "rename");
    if (bare.kind === "rename") assert.equal(bare.name, "");
  });
});

describe("createAgentUi — streaming and HUD", () => {
  it("streams text_delta, records tool start/end with a diff, and --json matches the HUD ViewModel", () => {
    const chunks: string[] = [];
    const ui = createAgentUi({
      width: 80,
      theme: resolveTheme("mono", "none", "unicode"),
      header: { model: "deepseek-v4-flash", sessionId: "sess1", cwd: "/work" },
      write: (t) => chunks.push(t),
      ledgerPath: ":memory:",
      config: SHIPPED_DEFAULTS,
      startedUtc: "2026-08-31T00:00:00Z",
    });
    const listeners: Array<(ev: StreamEvent) => void> = [];
    const unsub = ui.attach(
      {
        subscribe(fn) {
          listeners.push(fn);
          return () => {};
        },
      },
      () => freshState(),
    );
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

    const out = chunks.join("");
    assert.match(out, /lykos/);
    assert.match(out, /Hi there/);
    assert.match(out, /edit/);
    assert.match(out, /a\.ts/);
    assert.equal(ui.streamed, true);

    const hud = ui.writeHud(freshState(), "sess1");
    assert.equal(hud.tokens.counters.cacheRead, 9000);
    assert.equal(hud.tokens.counters.cacheWrite, 500);
    assert.equal(ui.snapshotJson(), JSON.stringify(hud));
    assert.doesNotMatch(out, /~\$/);
  });

  it("runFromSessionState keeps cache read and write separate", () => {
    const run = runFromSessionState({ sessionId: "s", startedUtc: "2026-08-31T00:00:00Z", state: freshState() });
    assert.equal(run.totals.cacheRead, 9000);
    assert.equal(run.totals.cacheWrite, 500);
    assert.notEqual(run.totals.cacheRead, run.totals.input);
  });
});

describe("piContextFraction — Pi reports context percent on a 0-100 scale (D28)", () => {
  it("turns 11.1k of a 1M window into 1%, not 111%", () => {
    // Pi: percent = (tokens / contextWindow) * 100 (agent-session getContextUsage).
    const usage = { tokens: 11_100, contextWindow: 1_000_000, percent: (11_100 / 1_000_000) * 100 };
    const pct = piContextFraction(usage.percent);
    assert.equal(pct, 0.0111);
    assert.match(contextSegment({ usedTokens: usage.tokens, totalTokens: usage.contextWindow, pct }, "full", true), / 1%$/);
  });
  it("keeps an unknown percent unknown", () => {
    assert.equal(piContextFraction(null), null);
  });
});

describe("append-only approval prompt (T212 review)", () => {
  function approvalText(req: Parameters<ReturnType<typeof createAgentUi>["renderApproval"]>[0]): string {
    const ui = createAgentUi({
      width: 100,
      theme: resolveTheme("mono", "none", "unicode"),
      header: { model: "test/model", sessionId: "s", cwd: "/work/proj" },
      write: () => {},
      ledgerPath: "/tmp/ledger",
      config: SHIPPED_DEFAULTS,
      startedUtc: new Date().toISOString(),
    });
    return ui.renderApproval(req);
  }

  it("a bash path ask offers allow once and deny only", () => {
    const out = approvalText({ kind: "bash", summary: "run command", detail: "cat /etc/hosts", pathAsk: { rule: "outside the project directory" } });
    assert.match(out, /\[y\] allow once/);
    assert.doesNotMatch(out, /always/);
  });

  it("a protected write offers only allow for this session", () => {
    const out = approvalText({ kind: "write", summary: "write", detail: ".git/config", pathAsk: { rule: ".git/**", protected: true } });
    assert.match(out, /\[y\] allow for this session/);
    assert.doesNotMatch(out, /always/);
  });

  it("an ordinary approval still offers always", () => {
    const out = approvalText({ kind: "bash", summary: "run command", detail: "npm test" });
    assert.match(out, /\[a\] always this tool/);
  });
});
