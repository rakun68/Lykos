// T215 (ADR-0044) against the real input: a driven session, a real switcher, a real boot().
// After a switch from a read-only specialist to a writing one, the next request carries the
// revoking line and the new instructions, and the session's head and tool list are untouched.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ModelRuntime, createAgentSession } from "@earendil-works/pi-coding-agent";
import { boot, type BootConfig } from "./boot.js";
import { runInteractiveLoop, type InteractiveSession, type LineSource } from "./interactive.js";
import { loadConfig } from "../config/load.js";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { AutoApproveGate } from "../gate/approval.js";
import { newRetryObservation } from "../loop/retry-observer.js";
import { createSpecialistSwitcher } from "../tui/interactive-surface.js";
import type { StandaloneSessionState } from "./session.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));

function project(): string {
  const cwd = mkdtempSync(join(tmpdir(), "lykos-t215-sw-"));
  const dir = join(cwd, ".lykos", "specialists");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "planner.yaml"), "description: p\nread_only: true\ninstructions: PLANNER-TEXT-1A\n");
  writeFileSync(join(dir, "writer.yaml"), "description: w\ninstructions: WRITER-TEXT-2B\n");
  return cwd;
}

function state(): StandaloneSessionState {
  return {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, nestedInput: 0, nestedOutput: 0, nestedCacheRead: 0, nestedCacheWrite: 0, calls: [] },
    toolCalls: [], turns: 0, lastText: "", humanInterventions: 0, retry: newRetryObservation(),
    initialModel: "test/stub", currentModel: "test/stub",
  };
}

describe("T215: a switch in a driven session", () => {
  it("sends the revoking line and the new instructions with the next turn, and leaves the head alone", async () => {
    const cwd = project();
    const { resolved: config } = loadConfig({ cwd, globalDir: join(cwd, ".g"), specialistName: "planner" });
    let toolsSet = 0;
    const stub = (async () => ({
      session: { sessionId: "s", getActiveToolNames: () => ["read", "edit"], setActiveToolsByName: () => { toolsSet++; }, abort: () => {} },
    })) as unknown as typeof createAgentSession;
    const booted = await boot(
      {
        cwd, config, model: { provider: "test", id: "stub" } as BootConfig["model"], modelRuntime: {} as ModelRuntime,
        gate: new AutoApproveGate(), ledgerPath: ":memory:", modelSpec: "test/stub", specialistName: "planner", neutralHead: true,
      },
      { createSession: stub },
    );
    assert.match(booted.specialistMessage ?? "", /PLANNER-TEXT-1A/);

    const fake = { sessionId: "f", systemPrompt: "head", prompts: [] as string[], idle: true } as any;
    const session: InteractiveSession = {
      sessionId: "f", systemPrompt: "head",
      get isIdle() { return true; },
      async prompt(t: string) { fake.prompts.push(t); },
      async steer() {}, async abort() {}, async waitForIdle() {},
      getActiveToolNames: () => ["read", "edit"],
      dispose() {},
    } as unknown as InteractiveSession;

    const switcher = createSpecialistSwitcher({
      cwd, session: session as any, modelRuntime: {} as any, initialConfig: config,
      initialSpecialistName: "planner", toolsOverride: undefined, state: state(),
      initialSpecialistMessage: booted.specialistMessage, currentMode: () => "manual",
    });

    const lines = ["first", "/specialist writer", "second", "/exit"];
    const lineSource: LineSource = { async next() { return lines.shift() ?? null; } } as LineSource;
    const ui = {
      view: { blocks: [], hud: null, toolsCollapsed: true, thinkingCollapsed: false }, streamed: false,
      writeUser() {}, writeSystem() {}, writeHud() { return null as never; }, renderApproval() { return ""; },
      attach() { return () => {}; }, snapshotJson() { return "{}"; },
    } as any;
    await runInteractiveLoop({
      session, lineSource, state: state(), ledgerPath: join(cwd, ".lykos", "ledger.db"), config: SHIPPED_DEFAULTS,
      modelSpec: "test/stub", writeReply: () => {}, ui,
      takeSpecialistNotice: switcher.takeSpecialistNotice,
      listSpecialists: switcher.listSpecialists, switchSpecialist: switcher.switchSpecialist,
    });

    assert.equal(fake.prompts.length, 2);
    assert.match(fake.prompts[0], /PLANNER-TEXT-1A/);
    assert.doesNotMatch(fake.prompts[0], /no longer apply/i);
    assert.match(fake.prompts[1], /specialist `planner` no longer apply/);
    assert.match(fake.prompts[1], /WRITER-TEXT-2B/);
    assert.doesNotMatch(fake.prompts[1], /PLANNER-TEXT-1A/);
    assert.equal(session.systemPrompt, "head");
    assert.equal(toolsSet, 0, "a switch never rewrites the request's tool list");
  });
});
