// Boot is the test surface: `boot(config) → session` without a TTY, and
// without the interactive loop. Feature flags are read once here; a flag's
// effect is visible on the booted session.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ModelRuntime, SettingsManager, createAgentSession } from "@earendil-works/pi-coding-agent";
import { SHIPPED_DEFAULTS } from "./config/defaults.js";
import { AutoApproveGate } from "./gate/approval.js";
import { ASK_TOOL_NAME, EXIT_PLAN_TOOL_NAME } from "./tools.js";
import { boot, type BootConfig } from "./session.js";
import {
  resolveHostModel,
  formatAuthenticationFailure,
  isAuthenticationError,
  resolveProviderEnvVar,
  runStandaloneTask,
} from "./session/session.js";
import type { ProvidersConfig } from "./config/types.js";

const CORE_SESSION = join(dirname(fileURLToPath(import.meta.url)), "session", "session.ts");
const CORE_INTERACTIVE = join(dirname(fileURLToPath(import.meta.url)), "session", "interactive.ts");

function stubCreateSession(onThinkingLevel?: (level: string) => void): typeof createAgentSession {
  return (async (opts = {}) => {
    let tools = [...(opts.tools ?? [])];
    return {
      session: {
        sessionId: "boot-test-session",
        getActiveToolNames: () => tools,
        setActiveToolsByName: (names: string[]) => {
          tools = [...names];
        },
        setThinkingLevel: (level: string) => onThinkingLevel?.(level),
        abort: () => {},
      },
    };
  }) as typeof createAgentSession;
}

async function bootWith(
  overrides: Partial<BootConfig> = {},
): Promise<{
  booted: Awaited<ReturnType<typeof boot>>;
  tools: string[];
  custom: string[];
  thinkingLevelCalls: string[];
  agentDir: string | undefined;
  settingsManager: unknown;
  resourceLoader: unknown;
}> {
  const cwd = overrides.cwd ?? mkdtempSync(join(tmpdir(), "lykos-boot-"));
  // ADR-0027: boot asks `piHostDir()`, whose only override is LYKOS_PI_HOST_DIR;
  // PI_CODING_AGENT_DIR is set too because Pi's own defaults still read it.
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  const prevPiHost = process.env.LYKOS_PI_HOST_DIR;
  process.env.PI_CODING_AGENT_DIR = join(cwd, "pi-agent");
  process.env.LYKOS_PI_HOST_DIR = join(cwd, "pi-agent");
  const captured = {
    tools: [] as string[],
    custom: [] as string[],
    thinkingLevelCalls: [] as string[],
    agentDir: undefined as string | undefined,
    settingsManager: undefined as unknown,
    resourceLoader: undefined as unknown,
  };
  try {
    const booted = await boot(
      {
        cwd,
        config: overrides.config ?? SHIPPED_DEFAULTS,
        model: overrides.model ?? ({ provider: "test", id: "stub" } as BootConfig["model"]),
        modelRuntime: overrides.modelRuntime ?? ({} as ModelRuntime),
        gate: overrides.gate ?? new AutoApproveGate(),
        ledgerPath: overrides.ledgerPath ?? ":memory:",
        modelSpec: overrides.modelSpec ?? "test/stub",
        ...(overrides.tools !== undefined ? { tools: overrides.tools } : {}),
        ...(overrides.subagents !== undefined ? { subagents: overrides.subagents } : {}),
        ...(overrides.isChild !== undefined ? { isChild: overrides.isChild } : {}),
        ...(overrides.askHuman !== undefined ? { askHuman: overrides.askHuman } : {}),
        ...(overrides.requestPlanExit !== undefined ? { requestPlanExit: overrides.requestPlanExit } : {}),
        ...(overrides.currentMode !== undefined ? { currentMode: overrides.currentMode } : {}),
        ...(overrides.parentBrief !== undefined ? { parentBrief: overrides.parentBrief } : {}),
        ...(overrides.specialistName !== undefined ? { specialistName: overrides.specialistName } : {}),
      },
      {
        createSession: (async (opts = {}) => {
          captured.tools = [...(opts.tools ?? [])];
          captured.agentDir = opts.agentDir;
          captured.settingsManager = opts.settingsManager;
          captured.resourceLoader = opts.resourceLoader;
          captured.custom = (opts.customTools ?? []).map((t) => t.name);
          return stubCreateSession((level) => captured.thinkingLevelCalls.push(level))(opts);
        }) as typeof createAgentSession,
      },
    );
    return {
      booted,
      tools: captured.tools,
      custom: captured.custom,
      thinkingLevelCalls: captured.thinkingLevelCalls,
      agentDir: captured.agentDir,
      settingsManager: captured.settingsManager,
      resourceLoader: captured.resourceLoader,
    };
  } finally {
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevPiHost === undefined) delete process.env.LYKOS_PI_HOST_DIR;
    else process.env.LYKOS_PI_HOST_DIR = prevPiHost;
  }
}

describe("boot(config) without a TTY", () => {
  it("P14 ticket 08 D2: passes Pi the pi-host as agentDir, with one explicit SettingsManager shared by loader and session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lykos-boot-pihost-"));
    const { agentDir, settingsManager, resourceLoader } = await bootWith({ cwd });
    assert.equal(agentDir, join(cwd, "pi-agent"), "LYKOS_PI_HOST_DIR, as bootWith sets it");
    assert.ok(settingsManager instanceof SettingsManager, "an explicit SettingsManager reaches createAgentSession");
    assert.equal(
      (resourceLoader as { settingsManager?: unknown }).settingsManager,
      settingsManager,
      "the resource loader reads the same settings the session does",
    );
    assert.equal((resourceLoader as { agentDir?: string }).agentDir, join(cwd, "pi-agent"));
  });

  it("subagents registers Agent as mounted, not on the boot allowlist", async () => {
    const { tools, custom } = await bootWith({ subagents: true });
    assert.equal(tools.includes("agent"), false);
    assert.equal(custom.includes("agent"), true);
  });

  it("default standalone does not register Agent", async () => {
    const { tools, custom } = await bootWith({});
    assert.equal(tools.includes("agent"), false);
    assert.equal(custom.includes("agent"), false);
  });

  it("reads memory at boot: disabled means no memory in the frozen head", async () => {
    const { booted } = await bootWith({
      config: { ...SHIPPED_DEFAULTS, memory: { ...SHIPPED_DEFAULTS.memory, enabled: false } },
    });
    assert.equal(booted.memoryHead.enabled, false);
    assert.equal(booted.memoryHead.text, "");
  });

  it("specialists ticket 01: records the selected specialist's name on the booted session, build when none was selected (T216)", async () => {
    const without = await bootWith({});
    assert.equal(without.booted.specialistName, "build");

    const withSpecialist = await bootWith({
      config: { ...SHIPPED_DEFAULTS, instructions: "Weigh alternatives before committing." },
      specialistName: "plan",
    });
    assert.equal(withSpecialist.booted.specialistName, "plan");
  });

  it("specialists band 2: under tools_mode append a removed tool stays in the request", async () => {
    // Band 2 ticket 02 changed what `tools_remove` means, and this test is the
    // one that pins the difference. Under `append` — the default, and what this
    // test asserted before the band — the name is still in the request and is
    // refused at dispatch instead. Asserting only the `override` case below
    // would leave the default mode's delta handling untested.
    const { tools } = await bootWith({
      config: { ...SHIPPED_DEFAULTS, tools_add: ["grep"], tools_remove: ["write"] },
    });
    assert.equal(tools.includes("grep"), true);
    assert.equal(tools.includes("write"), true, "append keeps the name in the request; the guard refuses the call");
  });

  it("specialists band 2: the head block states the tools the model actually has", async () => {
    // The boot head lists the session's tool names, and T17 fingerprints them.
    // Band 2 split "the set the seam was asked about" from "the set the request
    // carries", and for a while the head kept stating the first: it told the
    // model it held tools that were not in its request, and hashed a tool set no
    // session ever ran with.
    const { booted, tools } = await bootWith({
      config: { ...SHIPPED_DEFAULTS, tools_mode: "override", tools_remove: ["write"] },
    });
    assert.equal(tools.includes("write"), false, "override removes it from the request");
    assert.deepEqual(
      [...booted.bootArtifacts.toolNames].sort(),
      [...tools].sort(),
      "the head must state the request's tool set, not the pre-specialist one",
    );
  });

  it("specialists ticket 02: config.tools_add/tools_remove apply on top of the default resident set", async () => {
    const { tools } = await bootWith({
      config: { ...SHIPPED_DEFAULTS, tools_mode: "override", tools_add: ["grep"], tools_remove: ["write"] },
    });
    assert.equal(tools.includes("grep"), true);
    assert.equal(tools.includes("write"), false);
    // Untouched members of the default set are still there.
    assert.equal(tools.includes("read"), true);
  });

  it("specialists ticket 02: config.tools replaces the resident set, same as a caller override, and deltas still apply", async () => {
    const { tools } = await bootWith({
      config: { ...SHIPPED_DEFAULTS, tools_mode: "override", tools: ["read", "grep"], tools_add: ["bash"] },
    });
    assert.deepEqual([...tools].sort(), ["bash", "grep", "read"]);
  });

  it("specialists ticket 02: a caller-supplied tools override beats config.tools, same as a flag beats a specialist", async () => {
    const { tools } = await bootWith({
      tools: ["read"],
      config: { ...SHIPPED_DEFAULTS, tools: ["read", "grep", "bash"] },
    });
    assert.deepEqual(tools, ["read"]);
  });

  it("specialists ticket 02: config.thinkingLevel is applied to the session right after creation", async () => {
    const { thinkingLevelCalls } = await bootWith({
      config: { ...SHIPPED_DEFAULTS, thinkingLevel: "high" },
    });
    assert.deepEqual(thinkingLevelCalls, ["high"]);
  });

  it("specialists ticket 02: no thinkingLevel set means setThinkingLevel is never called", async () => {
    const { thinkingLevelCalls } = await bootWith({});
    assert.deepEqual(thinkingLevelCalls, []);
  });

  it("registers ask only when a human channel is provided, and exit_plan only with both plan callbacks", async () => {
    const without = await bootWith({});
    assert.equal(without.custom.includes(ASK_TOOL_NAME), false);
    assert.equal(without.custom.includes(EXIT_PLAN_TOOL_NAME), false);

    const withAsk = await bootWith({ askHuman: async () => "ok" });
    assert.equal(withAsk.custom.includes(ASK_TOOL_NAME), true);
    assert.equal(withAsk.custom.includes(EXIT_PLAN_TOOL_NAME), false);

    const withPlan = await bootWith({
      askHuman: async () => "ok",
      currentMode: () => "manual",
      requestPlanExit: async () => "auto",
    });
    assert.equal(withPlan.custom.includes(ASK_TOOL_NAME), true);
    assert.equal(withPlan.custom.includes(EXIT_PLAN_TOOL_NAME), true);
  });
});

describe("feature flags are read once, at boot", () => {
  it("the god modules no longer read tool_loader, memory, skills, or hooks off config", () => {
    const sessionSrc = readFileSync(CORE_SESSION, "utf8");
    const interactiveSrc = readFileSync(CORE_INTERACTIVE, "utf8");
    for (const [name, src] of [
      ["session.ts", sessionSrc],
      ["interactive.ts", interactiveSrc],
    ] as const) {
      assert.equal(/config\.tool_loader/.test(src), false, `${name} still reads config.tool_loader`);
      assert.equal(/resolveMemoryPolicy\(config\.memory\)/.test(src), false, `${name} still resolves memory`);
      assert.equal(/config\.skills/.test(src), false, `${name} still reads config.skills`);
      assert.equal(/config\.hooks/.test(src), false, `${name} still reads config.hooks`);
    }
  });
});

describe("resolveHostModel error separation (D3)", () => {
  function makeStubRuntime(providers: string[], modelsByProvider: Record<string, string[]>): ModelRuntime {
    return {
      getProviders: () => providers.map((id) => ({ id } as any)),
      getProvider: (id: string) => (providers.includes(id) ? ({ id } as any) : undefined),
      getModels: (providerId?: string) =>
        (providerId && modelsByProvider[providerId]
          ? modelsByProvider[providerId].map((id) => ({ id, provider: providerId } as any))
          : []),
      getModel: (providerId: string, modelId: string) => {
        if (modelsByProvider[providerId]?.includes(modelId)) {
          return { id: modelId, provider: providerId } as any;
        }
        return undefined;
      },
    } as unknown as ModelRuntime;
  }

  it("unknown provider lists available providers", async () => {
    const rt = makeStubRuntime(["anthropic", "deepseek"], { anthropic: ["claude-3"], deepseek: ["deepseek-chat"] });
    await assert.rejects(
      () => resolveHostModel("unknown-prov/some-model", rt),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /unknown provider "unknown-prov"/);
        assert.match(err.message, /anthropic/);
        assert.match(err.message, /deepseek/);
        return true;
      },
    );
  });

  it("known provider with unknown model lists offered models", async () => {
    const rt = makeStubRuntime(["anthropic"], { anthropic: ["claude-sonnet-4", "claude-haiku-3"] });
    await assert.rejects(
      () => resolveHostModel("anthropic/nonexistent-model", rt),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /unknown model "nonexistent-model" for provider "anthropic"/);
        assert.match(err.message, /claude-sonnet-4/);
        assert.match(err.message, /claude-haiku-3/);
        return true;
      },
    );
  });

  it("authentication failure names provider, env var, and refuses credentials without specialist or not found", () => {
    const msg = formatAuthenticationFailure("anthropic", "ANTHROPIC_API_KEY");
    assert.match(msg, /authentication failure for provider "anthropic"/);
    assert.match(msg, /ANTHROPIC_API_KEY/);
    assert.match(msg, /was present and refused/);
    assert.equal(/specialist/i.test(msg), false, "must never contain 'specialist'");
    assert.equal(/not found/i.test(msg), false, "must never contain 'not found'");
  });

  it("isAuthenticationError recognizes 401, unauthorized, and rejected credentials", () => {
    assert.equal(isAuthenticationError(new Error("401 Unauthorized")), true);
    assert.equal(isAuthenticationError(new Error("Invalid API key provided")), true);
    assert.equal(isAuthenticationError({ status: 401 }), true);
    assert.equal(isAuthenticationError(new Error("SyntaxError in file")), false);
  });

  it("resolveProviderEnvVar names a custom provider's own variable, not a placeholder", () => {
    // The production authentication path — the catch around `session.prompt` in
    // runStandaloneTask — passes `config.providers`, so a provider that declares
    // `source: $MY_SECRET_VAR` must be reported by that variable's name. The
    // registry lookups in resolveHostModel deliberately do not produce this
    // message at all: they read an in-memory list and never reach a provider.
    const providers = { myprov: { auth: "api_key", source: "$MY_SECRET_VAR" } } as unknown as ProvidersConfig;
    const envVar = resolveProviderEnvVar("myprov", providers);
    assert.equal(envVar, "MY_SECRET_VAR");
    const msg = formatAuthenticationFailure("myprov", envVar);
    assert.match(msg, /authentication failure for provider "myprov"/);
    assert.match(msg, /MY_SECRET_VAR/);
    assert.equal(/credential env var/.test(msg), false, "must not fall back to the placeholder");
  });

  it("a missing credential is never re-labelled as one that was present and refused", () => {
    // The distinction ticket 06 exists to draw. A runtime that says it has no way
    // to authenticate is reporting an ABSENT credential; only a rejection by the
    // provider is an authentication failure.
    assert.equal(isAuthenticationError(new Error("no authentication method configured")), false);
    assert.equal(isAuthenticationError(new Error("no credentials configured for provider")), false);
    assert.equal(isAuthenticationError(new Error("401 Unauthorized")), true);
  });

  it("resolveHostModel lets a registry error through unchanged", async () => {
    // getProvider/getModel read an in-memory registry, so whatever they throw is a
    // runtime fault and not a credential verdict. Wrapping it in authentication
    // wording would invent a rejection path the runtime does not take.
    const boom = new Error("401 Unauthorized");
    const rt = {
      getProviders: () => [{ id: "anthropic" } as any],
      getProvider: () => {
        throw boom;
      },
    } as unknown as ModelRuntime;
    await assert.rejects(
      () => resolveHostModel("anthropic/claude-3", rt),
      (err: unknown) => {
        assert.equal(err, boom);
        return true;
      },
    );
  });

  it("resolveHostModel with model id containing 401 is not mislabeled as auth failure", async () => {
    const rt = makeStubRuntime(["anthropic"], { anthropic: ["claude-3"] });
    await assert.rejects(
      () => resolveHostModel("anthropic/gpt-401", rt),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /unknown model "gpt-401" for provider "anthropic"/);
        assert.equal(err.message.includes("was present and refused"), false);
        return true;
      },
    );
  });

  it("isAuthenticationError excludes 403, forbidden, and missing credential errors", () => {
    assert.equal(isAuthenticationError(new Error("403 Forbidden")), false);
    assert.equal(isAuthenticationError({ status: 403 }), false);
    assert.equal(isAuthenticationError(new Error("no authentication method configured")), false);
    assert.equal(isAuthenticationError(new Error("no API key set")), false);
  });

  it("session-start empty pool: non-specialist session with empty pool and no env fails with D4 message before model call (D4 / D7.5)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "lykos-empty-pool-"));
    const emptyDbPath = join(cwd, "empty.db");
    const result = await runStandaloneTask({
      workspace: cwd,
      prompt: "hello",
      model: "anthropic/claude-3-5-sonnet",
      env: { LYKOS_CREDENTIALS_DB: emptyDbPath, ANTHROPIC_API_KEY: "" },
    });
    assert.equal(result.status, "error");
    assert.match(
      result.message,
      /^lykos: provider "anthropic" has no usable credential \(ANTHROPIC_API_KEY not set\) — run `lykos login anthropic`$/,
    );
  });
});
