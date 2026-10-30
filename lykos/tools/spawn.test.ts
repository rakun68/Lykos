// Lykos spawns its own subagents. Asserts against a hand-computed figure:
// parent + child costs equal the task total and are not double-counted; a Lykos
// child is resumable while an MCP-path hop-1 child in the same ledger is not.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveStandaloneTools } from "../tools.js";
import { buildAgentTool, ensureParentSessionForSpawn, type SpawnContext } from "./spawn.js";
import { AutoApproveGate } from "../gate/approval.js";
import { PONYTAIL_RULESET_TEXT } from "../session/ponytail-head.js";
import { createSpecialistGuardHandler } from "../tools/specialist-guard-extension.js";
import type { createAgentSession } from "@earendil-works/pi-coding-agent";
import { Ledger } from "../ledger/ledger.js";
import { openLedger } from "../ledger/use.js";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { ingestDelegateSnapshot } from "../ledger/ingest.js";
import { taskExceedsRunCap } from "../ledger/budget.js";
import { loadSessionSummary, formatSessionSummary } from "../ledger/summary.js";
import { loadConfig } from "../config/load.js";

// Ticket 08: keep Pi's agent dir (piHostDir) off the real ~/.lykos/pi-host.
process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));

const OFF_PEAK = new Date("2026-08-15T12:00:00.000Z"); // Saturday UTC — DeepSeek off-peak

function snap(partial: {
  sessionId: string;
  label?: string;
  model?: string;
  input: number;
  output: number;
  cacheRead?: number;
  nested?: { input: number; output: number };
}): Parameters<typeof ingestDelegateSnapshot>[1] {
  const usage: NonNullable<Parameters<typeof ingestDelegateSnapshot>[1]["usage"]> = {
    input: partial.input,
    output: partial.output,
    cacheRead: partial.cacheRead ?? 0,
    cacheWrite: 0,
    calls: [
      {
        hop: "direct",
        source: "assistant_message",
        provider: "deepseek",
        model: "deepseek-v4-flash",
        input: partial.input,
        output: partial.output,
        cacheRead: partial.cacheRead ?? 0,
        cacheWrite: 0,
        costUsd: 0,
        ts: OFF_PEAK.getTime(),
      },
    ],
  };
  if (partial.nested) {
    usage.nestedInput = partial.nested.input;
    usage.nestedOutput = partial.nested.output;
    usage.nestedCacheRead = 0;
    usage.nestedCacheWrite = 0;
    usage.nestedBasis = "reported_usage";
    usage.calls!.push({
      hop: "nested",
      source: "assistant_message",
      provider: "deepseek",
      model: "deepseek-v4-flash",
      input: partial.nested.input,
      output: partial.nested.output,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      ts: OFF_PEAK.getTime(),
    });
  }
  return {
    sessionId: partial.sessionId,
    ...(partial.label !== undefined ? { label: partial.label } : {}),
    state: "done",
    model: partial.model ?? "deepseek/deepseek-v4-flash",
    turns: 1,
    toolCalls: [],
    startedAt: OFF_PEAK.toISOString(),
    finishedAt: new Date(OFF_PEAK.getTime() + 1000).toISOString(),
    usage,
  };
}

describe("resolveStandaloneTools (T39)", () => {
  it("keeps Agent off the allowlist when subagents are opted in — the transport dispatches it", () => {
    // T98 put `todo` on the default standalone surface. Agent is mounted:
    // registered when spawn is allowed, dispatched through tool_call, not
    // named on the boot allowlist.
    assert.deepEqual(resolveStandaloneTools({ subagents: true }), [
      "read",
      "bash",
      "edit",
      "write",
      "commit",
      // P10.4 (ticket 13): the three tools that became resident. They sit
      // where the registry puts them, which is why they are here in the
      // middle rather than appended.
      "grep",
      "powershell",
      "glob",
      // P10.7 (ticket 12): the web pair, resident for the same reason and in
      // the same place — registry order, not append order.
      "web_search",
      "web_fetch",
      "todo",
      "ask",
      // T131: the exit-plan tool sits beside `ask` and follows the same rule
      // — named on the interactive surface, registered only where a human
      // channel actually exists, so an MCP worker never carries its schema.
      "exit_plan",
      "tool_search",
      "tool_call",
    ]);
  });

  it("puts the task list and the question on the default surface, never the pi-subagents trio", () => {
    assert.deepEqual(resolveStandaloneTools({}), [
      "read", "bash", "edit", "write", "commit", "grep", "powershell", "glob",
      // P10.7 (ticket 12): resident, so every standalone surface carries them.
      "web_search", "web_fetch",
      "todo", "ask", "exit_plan", "tool_search", "tool_call",
    ]);
  });

  it("never gives a child `ask` — there is no human on the other end of a subagent", () => {
    assert.deepEqual(resolveStandaloneTools({ isChild: true }), [
      // P10.7 (ticket 12): a child gets the web pair too. A subagent sent to
      // find out how a library works and unable to read its documentation is
      // a subagent that answers from memory.
      "read", "bash", "edit", "write", "commit", "grep", "powershell", "glob",
      "web_search", "web_fetch", "todo", "tool_search", "tool_call",
    ]);
  });

  it("leaves a caller's explicit surface alone — todo is a default, not a floor", () => {
    // The caller override rule (DECISIONS.md): a read-only scout asking for
    // `read` gets `read`, and is not handed a task list it cannot act on.
    assert.deepEqual(resolveStandaloneTools({ tools: ["read"] }), ["read"]);
  });

  it("strips Agent from a child even when the caller listed it", () => {
    assert.deepEqual(resolveStandaloneTools({ tools: ["read", "agent"], isChild: true }), ["read"]);
  });
});

describe("T39 ledger: Lykos child vs MCP hop-1", () => {
  it("records a Lykos-spawned child as resumable=1 with parent link; MCP hop-1 stays not resumable", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t39-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    try {
      // Parent (standalone), ensured early the way Agent does.
      const parentId = "parent-lykos-t39";
      const { resolved: config } = loadConfig({ cwd: dir });
      const ctx: SpawnContext = {
        parentSessionId: parentId,
        workspace: dir,
        ledgerPath,
        config,
        modelSpec: "deepseek/deepseek-v4-flash",
        gate: new AutoApproveGate(),
        autoApprove: true,
        parentBrief: "parent brief",
        executionShape: "standalone",
        allowSpawn: true,
      };
      const { taskId, projectId } = ensureParentSessionForSpawn(ledger, ctx);

      // Parent's own calls via ingest (session row already exists).
      ingestDelegateSnapshot(
        ledger,
        snap({ sessionId: parentId, label: "parent brief", input: 100, output: 10 }),
        {
          workspace: dir,
          executionShape: "standalone",
          runtime: "host",
          taskId,
          projectId,
        },
      );

      // Lykos-spawned child — own session, resumable.
      const childId = "child-lykos-t39";
      ingestDelegateSnapshot(
        ledger,
        snap({ sessionId: childId, label: "scout task — scout", input: 50, output: 5 }),
        {
          workspace: dir,
          executionShape: "subagent",
          runtime: "host",
          parentSessionId: parentId,
          taskId,
          projectId,
          resumable: true,
          agentRole: "scout",
        },
      );

      // MCP-path hop-1 in the same ledger (nested aggregates → synthetic child).
      const mcpParentId = "mcp-parent-t39";
      ingestDelegateSnapshot(
        ledger,
        snap({
          sessionId: mcpParentId,
          label: "lykos_implement",
          input: 20,
          output: 2,
          nested: { input: 30, output: 3 },
        }),
        { workspace: dir, executionShape: "mcp_worker", runtime: "container" },
      );

      const lykosChild = ledger.db
        .prepare(
          `SELECT parent_session_id, resumable, not_resumable_reason, execution_shape, task_id
           FROM sessions WHERE id = ?`,
        )
        .get(childId) as {
        parent_session_id: string;
        resumable: number;
        not_resumable_reason: string | null;
        execution_shape: string;
        task_id: string;
      };
      assert.equal(lykosChild.parent_session_id, parentId);
      assert.equal(lykosChild.resumable, 1);
      assert.equal(lykosChild.not_resumable_reason, null);
      assert.equal(lykosChild.execution_shape, "subagent");
      assert.equal(lykosChild.task_id, taskId);

      const mcpChild = ledger.db
        .prepare(
          `SELECT id, resumable, not_resumable_reason FROM sessions
           WHERE parent_session_id = ?`,
        )
        .get(mcpParentId) as { id: string; resumable: number; not_resumable_reason: string | null };
      assert.equal(mcpChild.resumable, 0);
      assert.ok(mcpChild.not_resumable_reason && /pi-subagents|hop-1/i.test(mcpChild.not_resumable_reason));

      // T39.2: no double-count — parent calls + child calls = task total.
      const parentCost = ledger.callTotals(parentId).costUsd!;
      const childCost = ledger.callTotals(childId).costUsd!;
      const treeCost = ledger.taskCallTotals(parentId).costUsd!;
      assert.ok(parentCost > 0 && childCost > 0, `expected both costs > 0, got parent=${parentCost} child=${childCost}`);
      assert.equal(treeCost, parentCost + childCost);

      // Parent must not also hold the child's tokens as nested rows.
      const parentCallCount = ledger.callTotals(parentId).n;
      const childCallCount = ledger.callTotals(childId).n;
      assert.equal(parentCallCount + childCallCount, ledger.taskCallTotals(parentId).n);

      const summary = loadSessionSummary(ledger, parentId);
      assert.ok(summary);
      assert.ok(
        Math.abs(summary!.totalCostUsd - (parentCost + childCost)) < 1e-6,
        `summary ${summary!.totalCostUsd} vs hand ${parentCost + childCost}`,
      );
      assert.equal(summary!.children.length, 1);
      assert.equal(summary!.children[0]!.resumable, true);
      const formatted = formatSessionSummary(summary!);
      assert.match(formatted, /resumable/);
      assert.match(formatted, /parent=/);
    } finally {
      ledger.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may briefly hold the closed db file; the assertions already ran.
      }
    }
  });

  it("T39.4: taskExceedsRunCap trips when children push the tree over the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t39-budget-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    try {
      const { resolved: config } = loadConfig({ cwd: dir });
      const parentId = "budget-parent";
      const ctx: SpawnContext = {
        parentSessionId: parentId,
        workspace: dir,
        ledgerPath,
        config,
        modelSpec: "deepseek/deepseek-v4-flash",
        gate: new AutoApproveGate(),
        autoApprove: true,
        parentBrief: "budget parent",
        executionShape: "standalone",
        allowSpawn: true,
      };
      const { taskId, projectId } = ensureParentSessionForSpawn(ledger, ctx);

      ingestDelegateSnapshot(
        ledger,
        snap({ sessionId: parentId, label: "budget parent", input: 10_000, output: 100 }),
        { workspace: dir, executionShape: "standalone", runtime: "host", taskId, projectId },
      );
      ingestDelegateSnapshot(
        ledger,
        snap({ sessionId: "budget-child-1", label: "c1", input: 10_000, output: 100 }),
        {
          workspace: dir,
          executionShape: "subagent",
          runtime: "host",
          parentSessionId: parentId,
          taskId,
          projectId,
          resumable: true,
        },
      );
      ingestDelegateSnapshot(
        ledger,
        snap({ sessionId: "budget-child-2", label: "c2", input: 10_000, output: 100 }),
        {
          workspace: dir,
          executionShape: "subagent",
          runtime: "host",
          parentSessionId: parentId,
          taskId,
          projectId,
          resumable: true,
        },
      );

      const tree = ledger.taskCallTotals(parentId).costUsd!;
      assert.ok(tree > 0);
      // Cap just under the tree total — must trip.
      assert.equal(taskExceedsRunCap(ledger, parentId, tree - 1e-9), true);
      // Cap above the tree — must not.
      assert.equal(taskExceedsRunCap(ledger, parentId, tree + 1), false);
      // A single-node check would miss children: parent alone is under a
      // mid-tree cap that the whole tree already exceeds.
      const parentOnly = ledger.callTotals(parentId).costUsd!;
      if (parentOnly < tree) {
        const mid = (parentOnly + tree) / 2;
        assert.equal(ledger.callTotals(parentId).costUsd! > mid, false);
        assert.equal(taskExceedsRunCap(ledger, parentId, mid), true);
      }
    } finally {
      ledger.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore Windows file lock on cleanup
      }
    }
  });
});

function makeStub(onSession?: (opts: any) => void): typeof createAgentSession {
  return (async (opts: any = {}) => {
    onSession?.(opts);
    let active = [...(opts.tools ?? [])];
    return {
      session: {
        sessionId: `c-${Date.now()}`,
        // Echo back whatever model the boot path resolved. Hardcoding one made
        // every ledger assertion agree with the stub instead of with the code:
        // a child really booting on the specialist's model still recorded
        // deepseek, and the test could not tell the two apart.
        model: opts.model ?? { provider: "deepseek", id: "deepseek-v4-flash" },
        systemPrompt: "stub",
        getActiveToolNames: () => active,
        setActiveToolsByName: (n: string[]) => { active = [...n]; },
        abort: () => {},
        subscribe: () => () => {},
        prompt: async () => {},
        waitForIdle: async () => {},
        dispose: () => {},
      },
    };
  }) as unknown as typeof createAgentSession;
}

function makeCtx(dir: string, ledgerPath: string, createSession?: typeof createAgentSession): SpawnContext {
  const { resolved: config } = loadConfig({ cwd: dir });
  return {
    parentSessionId: "p-test",
    workspace: dir,
    ledgerPath,
    config,
    modelSpec: "deepseek/deepseek-v4-flash",
    gate: new AutoApproveGate(),
    autoApprove: true,
    parentBrief: "brief",
    executionShape: "standalone",
    allowSpawn: true,
    ...(createSession !== undefined ? { bootDeps: { createSession } } : {}),
    // P14 ticket 07: a child's session start checks its provider has a
    // credential. The stubbed session never calls a model, so fake keys
    // stand in; before ticket 07 these tests leaned on the machine having a
    // real ~/.pi/agent/auth.json.
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "sk-test-fake",
      OPENAI_API_KEY: "sk-test-fake",
      DEEPSEEK_API_KEY: "sk-test-fake",
    },
  };
}

async function callTool(tool: ReturnType<typeof buildAgentTool>, params: any) {
  return (tool as any).execute("call-1", params, undefined, undefined, undefined);
}

describe("spawning a subagent under a specialist (ticket 04)", () => {
  it("criterion 1: child under prompt_mode: override runs on specialist prompt with ponytail ladder absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-spawn-prompt-override-"));
    const specDir = join(dir, ".lykos", "specialists");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "custom-prompt.yaml"),
      "description: Custom prompt override\nprompt_mode: override\ninstructions: Exclusive subagent prompt.\n",
    );
    let capturedLoader: any;
    try {
      const tool = buildAgentTool(makeCtx(dir, join(dir, "ledger.db"), makeStub((opts) => {
        capturedLoader = opts.resourceLoader;
      })));
      await callTool(tool, {
        prompt: "do task",
        description: "custom prompt task",
        subagent_type: "custom-prompt",
      });

      assert.ok(capturedLoader, "child should pass resourceLoader to createSession");
      const blocks = capturedLoader.appendSystemPromptOverride(["base"]);
      assert.ok(blocks.some((b: string) => b.includes("Exclusive subagent prompt.")));
      assert.ok(!blocks.some((b: string) => b.includes(PONYTAIL_RULESET_TEXT)));
      assert.ok(!blocks.some((b: string) => b.includes("Does this need to be built at all?")));
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("criterion 2: child under tools_mode: override has disallowed tools absent from request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-spawn-tools-override-"));
    const specDir = join(dir, ".lykos", "specialists");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "override-spec.yaml"),
      ["description: Override spec", "tools_mode: override", "tools:", "  - read", ""].join("\n"),
    );
    let capturedTools: string[] = [];
    try {
      const tool = buildAgentTool(makeCtx(dir, join(dir, "ledger.db"), makeStub((opts) => {
        capturedTools = [...(opts.tools ?? [])];
      })));
      await callTool(tool, {
        prompt: "search only",
        description: "override task",
        subagent_type: "override-spec",
      });

      assert.ok(capturedTools.includes("read"), "read must be in request");
      assert.ok(!capturedTools.includes("bash"), "bash must be absent from request under override");
      assert.ok(!capturedTools.includes("edit"), "edit must be absent from request under override");
      assert.ok(!capturedTools.includes("write"), "write must be absent from request under override");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("criterion 3: disallowed tool called inside child under append is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-spawn-append-"));
    const specDir = join(dir, ".lykos", "specialists");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "append-restrict.yaml"),
      ["description: Append restrict", "tools_mode: append", "tools_remove:", "  - bash", ""].join("\n"),
    );
    let refusal: any;
    let allowed: any;
    try {
      const tool = buildAgentTool(makeCtx(dir, join(dir, "ledger.db"), makeStub((opts) => {
        assert.ok(opts.tools.includes("bash"), "bash must remain in request under append");
        const guard = createSpecialistGuardHandler();
        refusal = guard({ toolName: "bash" } as any);
        allowed = guard({ toolName: "read" } as any);
      })));
      await callTool(tool, {
        prompt: "restricted run",
        description: "append test",
        subagent_type: "append-restrict",
      });

      assert.ok(refusal, "calling disallowed tool inside child must trigger refusal");
      assert.equal(refusal.block, true);
      assert.match(refusal.reason, /append-restrict/);
      assert.match(refusal.reason, /bash/);
      assert.equal(allowed, undefined, "calling allowed tool must not be blocked");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("criterion 4: spawn naming unknown specialist fails immediately, lists available names, creates no ledger row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-spawn-unknown-"));
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    try {
      const tool = buildAgentTool(makeCtx(dir, ledgerPath));
      const res = await callTool(tool, {
        prompt: "investigate",
        description: "unknown test",
        subagent_type: "general-purpose",
      }) as { content: Array<{ type: string; text: string }>; details: { error: string } };

      assert.match(res.details.error, /lykos: no specialist named "general-purpose"/);
      assert.match(res.details.error, /available specialists:.*explore/);

      const rows = ledger.db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number };
      assert.equal(rows.cnt, 0, "no ledger row created on unknown specialist");
    } finally {
      ledger.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("criterion 5: specialist with delegate: false is refused naming the reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-spawn-nodelegate-"));
    const specDir = join(dir, ".lykos", "specialists");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "solo.yaml"),
      ["description: Solo specialist", "delegate: false", ""].join("\n"),
    );
    const ledgerPath = join(dir, "ledger.db");
    const ledger = Ledger.open(ledgerPath);
    try {
      const tool = buildAgentTool(makeCtx(dir, ledgerPath));
      const res = await callTool(tool, {
        prompt: "investigate",
        description: "solo test",
        subagent_type: "solo",
      }) as { content: Array<{ type: string; text: string }>; details: { error: string } };

      assert.match(
        res.details.error,
        /lykos: specialist "solo" declines to configure a delegated agent/,
      );

      const rows = ledger.db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number };
      assert.equal(rows.cnt, 0, "no ledger row created on delegate: false refusal");
    } finally {
      ledger.close();
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("criterion 6: spawn.ts delegates to applySpecialist seam with context: subagent rather than deciding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-spawn-seam-"));
    const specDir = join(dir, ".lykos", "specialists");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(
      join(specDir, "seam-test.yaml"),
      ["description: Seam test specialist", "prompt_mode: override", "instructions: Seam instruction.", ""].join("\n"),
    );
    try {
      let capturedOverride = false;
      const tool = buildAgentTool(makeCtx(dir, join(dir, "ledger.db"), makeStub((opts) => {
        const blocks = opts.resourceLoader.appendSystemPromptOverride(["base"]);
        capturedOverride = !blocks.some((b: string) => b.includes(PONYTAIL_RULESET_TEXT));
      })));
      const res = await callTool(tool, {
        prompt: "test seam",
        description: "seam delegation test",
        subagent_type: "seam-test",
      });
      assert.equal((res as any).details.role, "seam-test");
      assert.equal(capturedOverride, true, "seam should honor prompt_mode: override under subagent context");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("criterion 7: child specialist is recorded in the ledger sessions row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-spawn-ledger-"));
    const ledgerPath = join(dir, "ledger.db");
    const parentId = "p-ledger-test";
    try {
      const tool = buildAgentTool({
        ...makeCtx(dir, ledgerPath, makeStub()),
        parentSessionId: parentId,
      });
      const res = await callTool(tool, {
        prompt: "investigate files",
        description: "exploring",
        subagent_type: "explore",
      }) as { details: { sessionId: string; role: string; resumable: boolean } };

      const ledger = Ledger.open(ledgerPath);
      try {
        const row = ledger.db
          .prepare("SELECT id, specialist, parent_session_id, execution_shape FROM sessions WHERE parent_session_id = ?")
          .get(parentId) as { id: string; specialist: string; parent_session_id: string; execution_shape: string } | undefined;

        assert.ok(row, "child session row must exist in ledger");
        assert.equal(row.id, res.details.sessionId);
        assert.equal(row.specialist, "explore");
        assert.equal(row.parent_session_id, parentId);
        assert.equal(row.execution_shape, "subagent");
      } finally {
        ledger.close();
      }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  it("criterion 8: omitted subagent_type defaults to explore", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-spawn-default-"));
    const ledgerPath = join(dir, "ledger.db");
    const parentId = "p-default-test";
    try {
      const tool = buildAgentTool({
        ...makeCtx(dir, ledgerPath, makeStub()),
        parentSessionId: parentId,
      });
      const res = await callTool(tool, {
        prompt: "default check",
        description: "exploring",
      }) as { details: { sessionId: string; role: string; resumable: boolean } };

      assert.equal(res.details.role, "explore");
      const ledger = Ledger.open(ledgerPath);
      try {
        const row = ledger.db
          .prepare("SELECT id, specialist FROM sessions WHERE parent_session_id = ?")
          .get(parentId) as { id: string; specialist: string } | undefined;
        assert.ok(row);
        assert.equal(row.specialist, "explore");
      } finally {
        ledger.close();
      }
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("choosing the delegate's model (ticket 05)", () => {
  /** Writes a specialist and spawns under it, returning the model the child booted on. */
  async function childModel(opts: {
    specialistYaml: string;
    delegateSetting?: string;
    callerModel?: string;
  }): Promise<{ model: string | undefined; dir: string; ledgerPath: string }> {
    const dir = mkdtempSync(join(tmpdir(), "lykos-spawn-model-"));
    const specDir = join(dir, ".lykos", "specialists");
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, "delegatee.yaml"), opts.specialistYaml);
    if (opts.delegateSetting !== undefined) {
      mkdirSync(join(dir, ".lykos"), { recursive: true });
      writeFileSync(
        join(dir, ".lykos", "config.yaml"),
        `models:\n  delegate: ${opts.delegateSetting}\n`,
      );
    }
    let seen: string | undefined;
    const ledgerPath = join(dir, "ledger.db");
    const tool = buildAgentTool(
      makeCtx(dir, ledgerPath, makeStub((sessionOpts) => {
        const m = sessionOpts.model;
        seen = m === undefined ? undefined : `${m.provider}/${m.id}`;
      })),
    );
    await callTool(tool, {
      prompt: "do task",
      description: "model choice",
      subagent_type: "delegatee",
      ...(opts.callerModel !== undefined ? { model: opts.callerModel } : {}),
    });
    return { model: seen, dir, ledgerPath };
  }

  const WITH_MODEL = "description: Has its own model\nprovider: anthropic\nmodel: claude-sonnet-5\n";
  const NO_MODEL = "description: Declares no model\n";

  it("criterion 1: an explicit model argument is used, whatever the configured default says", async () => {
    const { model } = await childModel({
      specialistYaml: WITH_MODEL,
      delegateSetting: "parent",
      callerModel: "openai/gpt-5",
    });
    assert.equal(model, "openai/gpt-5");
  });

  it("criterion 2: with the setting at specialist, the child runs on the specialist's model", async () => {
    const { model } = await childModel({ specialistYaml: WITH_MODEL, delegateSetting: "specialist" });
    assert.equal(model, "anthropic/claude-sonnet-5");
  });

  it("criterion 3: with the setting at parent, the child runs on the spawning session's model", async () => {
    const { model } = await childModel({ specialistYaml: WITH_MODEL, delegateSetting: "parent" });
    assert.equal(model, "deepseek/deepseek-v4-flash");
  });

  it("criterion 4: with the setting at a named model id, the child runs on that model", async () => {
    const { model } = await childModel({
      specialistYaml: WITH_MODEL,
      delegateSetting: "deepseek/deepseek-v4-pro",
    });
    assert.equal(model, "deepseek/deepseek-v4-pro");
  });

  it("criterion 5: a specialist declaring no model inherits the parent's rather than erroring", async () => {
    const { model } = await childModel({ specialistYaml: NO_MODEL, delegateSetting: "specialist" });
    assert.equal(model, "deepseek/deepseek-v4-flash");
  });

  it("criterion 6: the shipped default for the setting is specialist", () => {
    assert.equal(SHIPPED_DEFAULTS.models.delegate, "specialist");
  });

  it("criterion 7: the child's model and its specialist both appear in its ledger row", async () => {
    const { ledgerPath } = await childModel({ specialistYaml: WITH_MODEL, delegateSetting: "specialist" });
    const ledger = await openLedger(ledgerPath);
    try {
      const row = ledger.db
        .prepare("SELECT specialist, model, model_source FROM sessions WHERE parent_session_id = ?")
        .get("p-test") as { specialist?: string; model?: string; model_source?: string } | undefined;
      assert.ok(row, "the child must have a ledger row");
      assert.equal(row.specialist, "delegatee", "which specialist chose the model");
      assert.match(row.model ?? "", /claude-sonnet-5/, "and which model it chose");
      assert.equal(row.model_source, "specialist", "recorded as the specialist's choice, not a default");
    } finally {
      ledger.close();
    }
  });
});
