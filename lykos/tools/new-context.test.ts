import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { createAgentSession } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/load.js";
import { AutoApproveGate } from "../gate/approval.js";
import {
  NEW_CONTEXT_DEFAULT_SPECIALIST,
  NEW_CONTEXT_DESCRIPTION,
  NEW_CONTEXT_PARAMETERS,
  NEW_CONTEXT_TOOL_NAME,
  NO_SUB_CONTEXT_NOTICE,
  buildNewContextTool,
} from "./new-context.js";
import { runChildSession, type ChildRunOutcome, type ChildRunRequest, type SpawnContext } from "./spawn.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS, RUNTIME_AVAILABLE_TOOLS, TOOL_REGISTRY } from "./tool-surface.js";

// Ticket 08: keep Pi's agent dir (piHostDir) off the real ~/.lykos/pi-host.
process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));

async function call(
  tool: { execute: (...args: never[]) => unknown },
  args: Record<string, unknown>,
): Promise<{ text: string; details: Record<string, unknown>; isError: boolean }> {
  const result = (await (tool.execute as unknown as (
    id: string,
    params: unknown,
  ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean }>)(
    "call-1",
    args,
  )) as { content: Array<{ text: string }>; details: Record<string, unknown>; isError?: boolean };
  return {
    text: result.content.map((c) => c.text).join("\n"),
    details: result.details,
    isError: result.isError === true,
  };
}

function makeStub(): typeof createAgentSession {
  return (async (opts: any = {}) => {
    let active = [...(opts.tools ?? [])];
    return {
      session: {
        sessionId: `c-${Date.now()}`,
        model: opts.model ?? { provider: "deepseek", id: "deepseek-v4-flash" },
        systemPrompt: "stub",
        getActiveToolNames: () => active,
        setActiveToolsByName: (n: string[]) => {
          active = [...n];
        },
        abort: () => {},
        subscribe: () => () => {},
        prompt: async () => {},
        waitForIdle: async () => {},
        dispose: () => {},
      },
    };
  }) as unknown as typeof createAgentSession;
}

function makeCtx(dir: string, createSession?: typeof createAgentSession): SpawnContext {
  const { resolved: config } = loadConfig({ cwd: dir });
  return {
    parentSessionId: "p-test",
    workspace: dir,
    ledgerPath: join(dir, "ledger.db"),
    config,
    modelSpec: "deepseek/deepseek-v4-flash",
    gate: new AutoApproveGate(),
    autoApprove: true,
    parentBrief: "brief",
    executionShape: "standalone",
    allowSpawn: true,
    // The model is stubbed, so no key is ever sent; the child's credential
    // check still needs one to exist, and must not depend on the machine's.
    env: { ...process.env, DEEPSEEK_API_KEY: "sk-test-stub-not-a-real-key" },
    ...(createSession !== undefined ? { bootDeps: { createSession } } : {}),
  };
}

describe("P10.6 D3: new_context returns a conclusion, not a transcript", () => {
  // The contract, asserted against a child that produced a real answer AND a
  // real transcript. The transcript cannot reach the parent because the outcome
  // shape the runner returns has nowhere to put one — that is the enforcement,
  // and this proves the rendering does not add one back.
  it("returns the child's answer and nothing it did on the way to it", async () => {
    const seen: ChildRunRequest[] = [];
    const run = async (_ctx: SpawnContext, req: ChildRunRequest): Promise<ChildRunOutcome> => {
      seen.push(req);
      return {
        status: "finished",
        sessionId: "child-1",
        role: req.role,
        text: "The behaviour is defined in lykos/gate/modes.ts, line 171.",
      };
    };
    const tool = buildNewContextTool({ spawn: makeCtx(process.cwd()), run });

    const result = await call(tool, { task: "Which file defines the tier mapping?", label: "tier hunt" });
    assert.equal(result.isError, false);
    assert.ok(result.text.startsWith("The behaviour is defined in lykos/gate/modes.ts, line 171."));
    assert.equal(result.details.transcriptIncluded, false);
    assert.equal(result.details.sessionId, "child-1");

    // What came back is the conclusion plus one line saying where the rest is
    // — asserted whole, because "the transcript is not in it" is a claim about
    // everything in the string rather than about a few sample words.
    assert.equal(
      result.text,
      "The behaviour is defined in lykos/gate/modes.ts, line 171.\n\n" +
        "— the conclusion of sub-context child-1 (explore). Its transcript is its own session and is not in this " +
        "conversation; it is archived and resumable if a human wants to read it.",
    );
    assert.deepEqual(seen, [
      { prompt: "Which file defines the tier mapping?", description: "tier hunt", role: NEW_CONTEXT_DEFAULT_SPECIALIST },
    ]);
  });

  it("explores as explore by default and honours a named specialist and label", async () => {
    const seen: ChildRunRequest[] = [];
    const run = async (_ctx: SpawnContext, req: ChildRunRequest): Promise<ChildRunOutcome> => {
      seen.push(req);
      return { status: "finished", sessionId: "c", role: req.role, text: "done" };
    };
    const tool = buildNewContextTool({ spawn: makeCtx(process.cwd()), run });
    await call(tool, { task: "a" });
    await call(tool, { task: "b", specialist: "watcher", label: "run the suite" });
    assert.deepEqual(seen.map((r) => [r.role, r.description]), [
      [NEW_CONTEXT_DEFAULT_SPECIALIST, "sub-context"],
      ["watcher", "run the suite"],
    ]);
  });

  it("says a finished-with-nothing child finished with nothing rather than inventing an answer", async () => {
    const run = async (): Promise<ChildRunOutcome> => ({ status: "finished", sessionId: "c", role: "scout", text: undefined });
    const tool = buildNewContextTool({ spawn: makeCtx(process.cwd()), run });
    const result = await call(tool, { task: "a" });
    assert.ok(result.text.includes("finished without an answer"));
    assert.equal(result.details.started, true);
  });

  it("passes a refusal, a block and an error through unchanged", async () => {
    for (const outcome of [
      { status: "refused", message: "lykos: no such specialist", details: { error: "x" } },
      { status: "blocked", message: "lykos: blocked — over the cap", details: { blocked: true, capKind: "run" } },
      { status: "error", message: "lykos: subagent error — boom", details: { error: "boom" } },
    ] as ChildRunOutcome[]) {
      const tool = buildNewContextTool({ spawn: makeCtx(process.cwd()), run: async () => outcome });
      const result = await call(tool, { task: "a" });
      assert.equal(result.isError, true, outcome.status);
      assert.equal(result.text, (outcome as { message: string }).message);
      assert.equal(result.details.started, false);
    }
  });

  it("refuses an empty task and a session that cannot spawn, starting nothing either time", async () => {
    let started = 0;
    const run = async (): Promise<ChildRunOutcome> => {
      started += 1;
      return { status: "finished", sessionId: "c", role: "scout", text: "x" };
    };
    const withSpawn = buildNewContextTool({ spawn: makeCtx(process.cwd()), run });
    const empty = await call(withSpawn, { task: "   " });
    assert.equal(empty.isError, true);
    assert.equal(empty.details.reason, "empty_task");

    const withoutSpawn = buildNewContextTool({ run });
    const nowhere = await call(withoutSpawn, { task: "a real task" });
    assert.equal(nowhere.isError, true);
    assert.equal(nowhere.text, NO_SUB_CONTEXT_NOTICE);
    assert.equal(nowhere.details.reason, "no_spawn");
    assert.equal(started, 0);
  });
});

describe("P10.6 D3: it is the spawn machinery, not a second one", () => {
  // The integration half: the real `runChildSession`, the real ledger, the real
  // boot path, with only the model stubbed. If `new_context` had forked the
  // child mechanism this would exercise the fork instead.
  it("runs a real child through runChildSession and comes back with a session id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-newctx-"));
    try {
      const tool = buildNewContextTool({ spawn: makeCtx(dir, makeStub()) });
      const result = await call(tool, { task: "Say what this project is.", label: "probe" });
      assert.equal(result.isError, false, result.text);
      assert.equal(result.details.started, true);
      assert.equal(result.details.role, NEW_CONTEXT_DEFAULT_SPECIALIST);
      assert.equal(typeof result.details.sessionId, "string");
      assert.equal(result.details.transcriptIncluded, false);
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore a Windows file lock on the ledger during cleanup
      }
    }
  });

  it("uses the exported runner by default rather than a copy of it", () => {
    assert.equal(typeof runChildSession, "function");
    const tool = buildNewContextTool({});
    assert.equal(tool.name, NEW_CONTEXT_TOOL_NAME);
  });
});

// ---------------------------------------------------------------------------
// D9: mounted, hidden, in the catalog, measured
// ---------------------------------------------------------------------------

describe("P10.6 D9: the registry, the catalog and the measured tax", () => {
  it("is mounted, hidden and runtime-available, and not resident", () => {
    const row = TOOL_REGISTRY.find((e) => e.name === NEW_CONTEXT_TOOL_NAME);
    assert.ok(row);
    assert.equal(row.residency, "mounted");
    assert.equal(row.promptPresence, "hidden");
    assert.equal(RUNTIME_AVAILABLE_TOOLS.has(NEW_CONTEXT_TOOL_NAME), true);
    assert.equal(MOUNTED_TOOLS.includes(NEW_CONTEXT_TOOL_NAME), true);
    assert.equal(DEFAULT_RESIDENT_TOOLS.includes(NEW_CONTEXT_TOOL_NAME), false);
  });

  // It IS Agent's machinery, so it declares Agent's tier: a child is an
  // unbounded amount of someone else's work on its own budget, and the
  // read-only specialist is a default rather than a ceiling.
  it("declares the tier Agent declares, because it is Agent's machinery", () => {
    assert.equal(tierForTool(NEW_CONTEXT_TOOL_NAME), "hard-write");
    assert.deepEqual(riskForTool(NEW_CONTEXT_TOOL_NAME), { tier: "hard-write", idempotent: false, openWorld: true });
    assert.equal(tierForTool("agent"), "hard-write");
  });

  it("the catalog row equals the live definition, description and parameters both", () => {
    const row = TOOL_CATALOG[NEW_CONTEXT_TOOL_NAME];
    assert.ok(row);
    assert.equal(row.source, "lykos");
    assert.equal(row.description, NEW_CONTEXT_DESCRIPTION);
    assert.deepEqual(row.parameters, JSON.parse(JSON.stringify(NEW_CONTEXT_PARAMETERS)));
  });

  // Measured with `measureToolset` on SCHEMA_TOKENS_BASIS, 2026-09-21.
  it("costs 334 tokens if it ever goes resident, and 0 today", () => {
    const alone = measureToolset([NEW_CONTEXT_TOOL_NAME]);
    assert.equal(alone.complete, true);
    assert.equal(alone.tokens, 334);
    assert.equal(alone.bytes, 1337);
    // P10.7 (ticket 12): 1423 until this line was last touched, and 2062 now.
    // The resident total MOVED for the first time since P10.4, because
    // `web_search` (314 alone) and `web_fetch` (326 alone) were made RESIDENT
    // rather than mounted — 639 together, since array wrapping means the pair
    // is not the sum of the two. Nothing about this file's tool moved; this
    // line prices the surface it is being compared against.
    assert.equal(measureToolset(DEFAULT_RESIDENT_TOOLS).tokens, 2255);
  });

  it("registers through loadTools, so tool_call can reach it", async () => {
    const { loadTools } = await import("./session-tools.js");
    const loaded = loadTools([], {
      cwd: process.cwd(),
      gate: { request: async () => "allow" } as never,
      modelProvider: "",
      modelId: "",
    });
    assert.ok(loaded.customTools.some((t) => t.name === NEW_CONTEXT_TOOL_NAME));
    assert.equal(loaded.activeToolNames.includes(NEW_CONTEXT_TOOL_NAME), false);
    loaded.lsp.shutdownAll();
    await loaded.jobs.stopAll();
    await loaded.evalRuntimes.disposeAll();
  });
});
