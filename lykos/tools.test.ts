import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AutoApproveGate, DenialLog } from "./gate/approval.js";
import { SHIPPED_DEFAULTS } from "./config/defaults.js";
import {
  ASK_TOOL_NAME,
  EXIT_PLAN_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  DEFAULT_RESIDENT_TOOLS,
  applyToolDeltas,
  loadTools,
  newAskState,
  newPlanState,
  newTaskListState,
  resolveSessionTools,
  resolveStandaloneTools,
  riskForTool,
  sessionWantsAgent,
} from "./tools.js";
import { measureToolset } from "./ledger/tool-schema.js";

describe("tools/ interface: what names a session carries", () => {
  it("defaults the worker/delegate path to the worker four", () => {
    assert.deepEqual(resolveSessionTools(), [...DEFAULT_RESIDENT_TOOLS]);
  });

  it("adds the host trio on the worker path when subagents are opted in", () => {
    // P10.4 (ticket 13, D4): `grep`, `powershell` and `glob` joined the
    // resident set. The order is the registry's order, not this list's — the
    // registry is the one place keyed by tool name and this assertion reads
    // out of it rather than declaring a second opinion about it.
    assert.deepEqual(resolveSessionTools({ subagents: true }), [
      "read",
      "bash",
      "edit",
      "write",
      "commit",
      "grep",
      "powershell",
      "glob",
      // P10.7 (ticket 12): the web pair, resident. Registry order again.
      "web_search",
      "web_fetch",
      "agent",
      "get_subagent_result",
      "steer_subagent",
    ]);
  });

  it("puts todo, ask and exit_plan on the standalone default, never the pi-subagents trio", () => {
    assert.deepEqual(resolveSessionTools({ standalone: true }), [
      "read",
      "bash",
      "edit",
      "write",
      "commit",
      "grep",
      "powershell",
      "glob",
      "web_search",
      "web_fetch",
      "todo",
      "ask",
      "exit_plan",
      "tool_search",
      "tool_call",
    ]);
    assert.deepEqual(resolveStandaloneTools({}), [
      "read",
      "bash",
      "edit",
      "write",
      "commit",
      "grep",
      "powershell",
      "glob",
      "web_search",
      "web_fetch",
      "todo",
      "ask",
      "exit_plan",
      "tool_search",
      "tool_call",
    ]);
  });

  it("keeps Agent off the standalone allowlist when subagents are opted in", () => {
    assert.deepEqual(resolveStandaloneTools({ subagents: true }), [
      "read",
      "bash",
      "edit",
      "write",
      "commit",
      "grep",
      "powershell",
      "glob",
      "web_search",
      "web_fetch",
      "todo",
      "ask",
      "exit_plan",
      "tool_search",
      "tool_call",
    ]);
  });

  it("never gives a child ask, exit_plan, or Agent", () => {
    // A child gets the resident set too: P10.4's three are ordinary work
    // tools, and a subagent that can run a command but not search for the
    // file it is about to change is a subagent that shells out to grep.
    // P10.7 (ticket 12): and the web pair, resident on the same terms — a
    // child that cannot read a page answers from memory.
    const childSurface = [
      "read", "bash", "edit", "write", "commit", "grep", "powershell", "glob", "web_search", "web_fetch",
      "todo", "tool_search", "tool_call",
    ];
    assert.deepEqual(resolveStandaloneTools({ isChild: true }), childSurface);
    assert.deepEqual(resolveStandaloneTools({ subagents: true, isChild: true }), childSurface);
  });

  it("leaves a caller override alone — extras are a default, not a floor", () => {
    assert.deepEqual(resolveSessionTools({ tools: ["read"] }), ["read"]);
    assert.deepEqual(resolveStandaloneTools({ tools: ["read"] }), ["read"]);
    assert.deepEqual(resolveStandaloneTools({ tools: ["read", "agent"], isChild: true }), ["read"]);
  });
});

describe("tools/ interface: risk and why", () => {
  it("declares a risk tier for every name a real session can be given", () => {
    const surfaces = [
      resolveStandaloneTools({}),
      resolveStandaloneTools({ subagents: true }),
      resolveStandaloneTools({ isChild: true }),
      resolveSessionTools(),
      resolveSessionTools({ subagents: true }),
    ];
    const undeclared = [...new Set(surfaces.flat())].filter((name) => riskForTool(name) === undefined);
    assert.deepEqual(undeclared, []);
  });
});

describe("tools/ interface: loadTools", () => {
  it("shadows write, edit and bash so the gated trio is what a session registers", () => {
    const loaded = loadTools([...DEFAULT_RESIDENT_TOOLS], {
      cwd: process.cwd(),
      gate: new AutoApproveGate(),
      denials: new DenialLog(),
      modelProvider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    // P10.3: `read` joined the shadowed set. T168 (ADR-0031): Pi's read is wrapped
    // so it numbers every line, and `edit` is Lykos's own text replacement.
    //
    // P10.4 (ticket 13): `powershell` joined the gated shells, and the four
    // search tools joined as registered definitions. `find` and `ls` appear
    // here while staying off `activeToolNames` below — that split IS the
    // transport: a mounted tool is registered and unlisted, reachable through
    // `tool_call` without riding the request's tool array.
    //
    // P10.4 (ticket 14) narrowed this from a whole-list assertion to the
    // property the test is named after. `ast_grep` and `ast_edit` register
    // unconditionally too, and so will every mounted tool after them; a list
    // that has to be re-typed whenever anything is added is a change
    // detector, not a test of the shadowing this test exists to pin.
    const names = loaded.customTools.map((t) => t.name);
    assert.deepEqual(names.slice(0, 5), ["write", "edit", "bash", "powershell", "read"]);
    assert.equal(new Set(names).size, names.length, "one definition per name");
    // A mounted tool is registered and unlisted. That split IS the transport.
    for (const mounted of ["find", "ls", "ast_grep", "ast_edit"]) {
      assert.ok(names.includes(mounted), `${mounted} must be registered`);
      assert.equal(loaded.activeToolNames.includes(mounted), false, `${mounted} must stay off the wire`);
    }
    assert.deepEqual(loaded.activeToolNames, [...DEFAULT_RESIDENT_TOOLS]);
  });

  it("registers todo, ask and exit_plan only when they are named and their deps are present", () => {
    const without = loadTools(
      ["read", "bash", "edit", "write", TASK_LIST_TOOL_NAME, ASK_TOOL_NAME, EXIT_PLAN_TOOL_NAME],
      {
        cwd: process.cwd(),
        gate: new AutoApproveGate(),
        modelProvider: "",
        modelId: "",
      },
    );
    // Narrowed to the three names this test is about (P10.4 ticket 14): the
    // rest of the registration list grows with every mounted tool, and
    // re-typing it here would make this a change detector rather than a test
    // of when `todo`, `ask` and `exit_plan` appear.
    for (const conditional of [TASK_LIST_TOOL_NAME, ASK_TOOL_NAME, EXIT_PLAN_TOOL_NAME]) {
      assert.equal(
        without.customTools.some((t) => t.name === conditional),
        false,
        `${conditional} must not register without its dependency`,
      );
    }

    const withDeps = loadTools(
      ["read", "bash", "edit", "write", TASK_LIST_TOOL_NAME, ASK_TOOL_NAME, EXIT_PLAN_TOOL_NAME],
      {
        cwd: process.cwd(),
        gate: new AutoApproveGate(),
        modelProvider: "",
        modelId: "",
        taskList: {
          state: newTaskListState(),
          onChange: () => undefined,
          verifier: async () => ({ ok: true, exitCode: 0, output: "" }),
        },
        ask: { state: newAskState(), askHuman: async () => "yes" },
        exitPlan: {
          state: newPlanState(),
          currentMode: () => "manual",
          requestExit: async () => "auto",
        },
      },
    );
    const withDepsNames = withDeps.customTools.map((t) => t.name);
    assert.deepEqual(withDepsNames.slice(-3), [TASK_LIST_TOOL_NAME, ASK_TOOL_NAME, EXIT_PLAN_TOOL_NAME]);
    assert.equal(new Set(withDepsNames).size, withDepsNames.length, "one definition per name");
  });

  it("a named Agent is still wanted, and loadTools registers it mounted not resident", () => {
    assert.equal(sessionWantsAgent(["read", "agent"]), true);
    assert.equal(sessionWantsAgent(["read"]), false);
    const loaded = loadTools(["read", "bash", "edit", "write", "agent", "tool_search", "tool_call"], {
      cwd: process.cwd(),
      gate: new AutoApproveGate(),
      modelProvider: "deepseek",
      modelId: "deepseek-v4-flash",
      spawnContext: {
        parentSessionId: "parent",
        workspace: process.cwd(),
        ledgerPath: ":memory:",
        config: SHIPPED_DEFAULTS,
        modelSpec: "test/stub",
        gate: new AutoApproveGate(),
        autoApprove: true,
        parentBrief: "test",
        executionShape: "standalone",
        allowSpawn: true,
      },
    });
    assert.equal(loaded.customTools.some((t) => t.name === "agent"), true);
    assert.equal(loaded.activeToolNames.includes("agent"), false);
  });
});

describe("applyToolDeltas (specialists ticket 02: tools_add / tools_remove)", () => {
  it("adds a name not already present", () => {
    assert.deepEqual(applyToolDeltas(["read", "grep"], ["bash"]), ["read", "grep", "bash"]);
  });

  it("does not duplicate a name already resident", () => {
    assert.deepEqual(applyToolDeltas(["read", "grep"], ["read"]), ["read", "grep"]);
  });

  it("removes a name that is present", () => {
    assert.deepEqual(applyToolDeltas(["read", "grep", "bash"], undefined, ["bash"]), ["read", "grep"]);
  });

  it("removing a name not present is a no-op, not an error", () => {
    assert.deepEqual(applyToolDeltas(["read"], undefined, ["bash"]), ["read"]);
  });

  it("applies add before remove, so a tool can be added and then removed in one call", () => {
    assert.deepEqual(applyToolDeltas(["read"], ["bash"], ["bash"]), ["read"]);
  });

  it("with neither delta, returns an equivalent but independent array", () => {
    const base = ["read", "grep"];
    const result = applyToolDeltas(base);
    assert.deepEqual(result, base);
    assert.notEqual(result, base);
  });
});

describe("loadTools with SpecialistApplication (D9)", () => {
  it("accepts requestToolNames from application and uses it", () => {
    const app = { requestToolNames: ["read", "grep"] };
    const loaded = loadTools(app.requestToolNames, {
      cwd: "/test",
      gate: new AutoApproveGate(),
      denials: new DenialLog(),
      modelProvider: "test",
      modelId: "test",
    });
    assert.deepEqual(loaded.activeToolNames, ["read", "grep"]);
  });
});

describe("P10.2 resident tax after deleting load_tools", () => {
  it("the standalone resident set is complete and does not name load_tools", () => {
    const names = resolveStandaloneTools({});
    assert.equal(names.includes("load_tools"), false);
    const measured = measureToolset(names);
    assert.equal(measured.complete, true);
    assert.ok((measured.tokens ?? 0) > 0);
  });
});
