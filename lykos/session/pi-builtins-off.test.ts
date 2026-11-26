// P23 (#62): Pi 1.6.1 ships built-in extensions (codemode, tool-search, mcp, llama.cpp) and idle
// cache warming. Lykos keeps its own versions until a measurement decides the overlap (ADR-0065,
// decision 9), so a booted session must load none of them and must veto every warm request.
//
// The session here is Pi's real `createAgentSession`, given the resource loader and settings
// manager `boot` built: the guard is tested against what boot actually hands Pi.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModelRuntime, createAgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionOptions, CreateAgentSessionResult } from "@earendil-works/pi-coding-agent";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { AutoApproveGate } from "../gate/approval.js";
import type { BootConfig } from "./boot.js";
import { boot } from "./boot.js";

const PI_BUILTIN_EXTENSIONS = ["codemode", "tool-search", "mcp", "llama.cpp"];

async function bootReal(): Promise<{ session: AgentSession; options: CreateAgentSessionOptions; cleanup: () => void }> {
  const cwd = mkdtempSync(join(tmpdir(), "lykos-pi-builtins-"));
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPiHost = process.env.LYKOS_PI_HOST_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "pi-agent");
  process.env.LYKOS_PI_HOST_DIR = join(cwd, "pi-agent");
  const restore = (): void => {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPiHost === undefined) delete process.env.LYKOS_PI_HOST_DIR;
    else process.env.LYKOS_PI_HOST_DIR = prevPiHost;
  };
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null });
    let captured: { session: AgentSession; options: CreateAgentSessionOptions } | undefined;
    const createSession = (async (options: CreateAgentSessionOptions): Promise<CreateAgentSessionResult> => {
      const result = await createAgentSession(options);
      captured = { session: result.session, options };
      return result;
    }) as typeof createAgentSession;
    await boot(
      {
        cwd,
        config: SHIPPED_DEFAULTS,
        model: { provider: "test", id: "stub" } as BootConfig["model"],
        modelRuntime,
        gate: new AutoApproveGate(),
        ledgerPath: ":memory:",
        modelSpec: "test/stub",
      },
      { createSession },
    );
    assert.ok(captured, "boot must create its session through createSession");
    const { session, options } = captured;
    return {
      session,
      options,
      cleanup: () => {
        session.dispose();
        restore();
        rmSync(cwd, { recursive: true, force: true });
      },
    };
  } catch (error) {
    restore();
    rmSync(cwd, { recursive: true, force: true });
    throw error;
  }
}

describe("Pi 1.6.1 built-ins stay off in a Lykos session (#62)", () => {
  it("loads none of Pi's built-in extensions and registers none of their tools", async () => {
    const { session, options, cleanup } = await bootReal();
    try {
      const loaded = options.resourceLoader?.getExtensions().extensions.map((e) => e.path) ?? [];
      for (const name of PI_BUILTIN_EXTENSIONS) {
        assert.equal(loaded.includes(`builtin:${name}`), false, `builtin:${name} must not load`);
      }
      // Lykos has its own `tool_search`, so a tool is told apart by the extension it came from, not its name.
      // With Pi's discovery on, these tools carry `builtin:codemode` and `builtin:tool-search`.
      const builtinPaths = new Set(PI_BUILTIN_EXTENSIONS.map((name) => `builtin:${name}`));
      const fromBuiltin = session.getAllTools().filter((t) => builtinPaths.has(t.sourceInfo.path));
      assert.deepEqual(fromBuiltin.map((t) => `${t.name} (${t.sourceInfo.path})`), []);
    } finally {
      cleanup();
    }
  });

  it("gives the model exactly the tools Lykos names, every one Lykos's own", async () => {
    const { session, options, cleanup } = await bootReal();
    try {
      assert.deepEqual(session.getActiveToolNames(), options.tools);
      // Lykos registers its tools through the SDK; a tool from anywhere else is Pi adding one.
      const notLykos = session.getAllTools().filter((t) => !t.sourceInfo.path.startsWith("<sdk:"));
      assert.deepEqual(notLykos.map((t) => `${t.name} (${t.sourceInfo.path})`), []);
    } finally {
      cleanup();
    }
  });

  it("vetoes every cache-warming request Pi would send", async () => {
    const { options, cleanup } = await bootReal();
    try {
      const runner = options.resourceLoader?.getExtensions().runtime;
      assert.ok(runner, "the loader exposes its extension runtime");
      const handlers = options.resourceLoader!
        .getExtensions()
        .extensions.flatMap((e) => e.handlers.get("cache_warming_decision") ?? []);
      assert.ok(handlers.length > 0, "a Lykos extension must handle cache_warming_decision");
      for (const handler of handlers) {
        const result = (await handler(
          { type: "cache_warming_decision", action: "warm", warmCost: 0, missCost: 1, continuationProbability: 1 },
          {} as never,
        )) as { action?: string } | undefined;
        assert.equal(result?.action, "stop");
      }
    } finally {
      cleanup();
    }
  });
});
