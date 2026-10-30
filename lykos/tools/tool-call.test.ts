import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { DenialLog, AutoApproveGate } from "../gate/approval.js";
import { buildTaskListTool, newTaskListState } from "./task-list.js";
import { loadTools } from "./session-tools.js";
import { buildToolSearchTool } from "./tool-search.js";
import {
  TOOL_CALL_DESCRIPTION,
  TOOL_CALL_PARAMETERS,
  TOOL_CALL_TOOL_NAME,
  buildToolCallTool,
  renderMountedToolSchema,
  resolveActualToolArgs,
  resolveActualToolName,
  tierForToolCall,
  validateMountedToolArguments,
} from "./tool-call.js";

interface ExecResult {
  content: Array<{ type?: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

function textOf(res: ExecResult): string {
  return res.content[0]?.text ?? "";
}

const call = async (tool: ReturnType<typeof buildToolCallTool>, params: unknown) =>
  (await (tool as unknown as {
    execute: (id: string, p: unknown, s?: unknown, u?: unknown, c?: unknown) => Promise<ExecResult>;
  }).execute("call-1", params)) as ExecResult;

describe("P10.2 tool_call transport", () => {
  it("valid call to a mounted tool executes and returns the tool's own result", async () => {
    const state = newTaskListState();
    const todoTool = buildTaskListTool({ state });
    const toolCall = buildToolCallTool({ tools: [todoTool] });

    const res1 = await call(toolCall, {
      name: "todo",
      arguments: { add: [{ text: "first task" }] },
    });
    assert.equal(res1.isError ?? false, false);
    const text1 = textOf(res1);
    assert.ok(text1.includes("first task"), "expected task text in result");
    assert.ok(text1.includes("1 [ ] first task"));

    const res2 = await call(toolCall, {
      name: "todo",
      arguments: { start: 1 },
    });
    assert.equal(res2.isError ?? false, false);
    const text2 = textOf(res2);
    assert.ok(text2.includes("1 [>] first task"));
  });

  it("malformed call returns actual tool's full schema inside the error", async () => {
    const state = newTaskListState();
    const todoTool = buildTaskListTool({ state });
    const toolCall = buildToolCallTool({ tools: [todoTool] });

    const res = await call(toolCall, {
      name: "todo",
      arguments: { start: "not-a-number" as unknown as number },
    });
    assert.equal(res.isError, true);
    const errText = textOf(res);
    assert.ok(errText.includes('Validation failed for tool "todo"'), "expected validation failure message");
    assert.ok(errText.includes("Tool schema:"), "expected tool schema in error text");
    assert.ok(errText.includes("properties"), "expected schema structure in error text");
    assert.deepEqual(res.details?.schema, todoTool.parameters);
  });

  it("validateMountedToolArguments throws with full schema on mismatch", () => {
    const state = newTaskListState();
    const todoTool = buildTaskListTool({ state });

    assert.throws(
      () => validateMountedToolArguments(todoTool.parameters, "todo", { start: "bad" }),
      (err: Error) => {
        assert.ok(err.message.includes('Validation failed for tool "todo"'));
        assert.ok(err.message.includes("Tool schema:"));
        return true;
      },
    );
  });

  it("unknown tool name answers with what exists rather than a guess", async () => {
    const state = newTaskListState();
    const todoTool = buildTaskListTool({ state });
    const toolCall = buildToolCallTool({ tools: [todoTool] });

    const res = await call(toolCall, {
      name: "nonexistent_custom_tool",
      arguments: {},
    });
    assert.equal(res.isError, true);
    const text = textOf(res);
    assert.ok(text.includes('lykos: unknown tool "nonexistent_custom_tool"'));
    assert.ok(text.includes("What exists:"));
    assert.ok(text.includes("todo"));
  });

  it("tool marked off in registry is refused through tool_call and recorded in DenialLog", async () => {
    const denials = new DenialLog();
    const toolCall = buildToolCallTool({ denials, specialistName: "default" });

    const res = await call(toolCall, {
      name: "subagent_workflow",
      arguments: {},
    });
    assert.equal(res.isError, true);
    const text = textOf(res);
    assert.ok(text.includes("refused"));
    assert.ok(text.includes("subagent_workflow"));
    assert.equal(denials.specialistRestricted, 1);
    assert.equal(denials.last, "subagent_workflow default (specialist_restricted)");
  });

  it("specialist-restricted tool is refused even if tool definition is provided", async () => {
    const denials = new DenialLog();
    const state = newTaskListState();
    const todoTool = buildTaskListTool({ state });
    const toolCall = buildToolCallTool({
      tools: [todoTool],
      offLimitTools: ["todo"],
      specialistName: "reviewer",
      denials,
    });

    const res = await call(toolCall, {
      name: "todo",
      arguments: {},
    });
    assert.equal(res.isError, true);
    const text = textOf(res);
    assert.ok(text.includes('the "reviewer" specialist does not allow todo'));
    assert.equal(denials.specialistRestricted, 1);
  });

  it("resolveActualToolName unpacks wire identity", () => {
    assert.equal(resolveActualToolName("tool_call", { name: "todo", arguments: {} }), "todo");
    assert.equal(resolveActualToolName("tool_call", { name: "edit", arguments: {} }), "edit");
    assert.equal(resolveActualToolName("tool_call", {}), "tool_call");
    assert.equal(resolveActualToolName("tool_call", null), "tool_call");
    assert.equal(resolveActualToolName("read", { path: "a.ts" }), "read");
    assert.equal(resolveActualToolName(undefined, {}), undefined);
  });

  it("resolveActualToolArgs extracts inner arguments", () => {
    const inner = { add: [{ text: "hi" }] };
    assert.deepEqual(resolveActualToolArgs("tool_call", { name: "todo", arguments: inner }), inner);
    assert.deepEqual(resolveActualToolArgs("read", { path: "a.ts" }), { path: "a.ts" });
  });

  it("tierForToolCall resolves actual tool risk tier", () => {
    assert.equal(tierForToolCall("tool_call", { name: "todo" }), "soft-write");
    assert.equal(tierForToolCall("tool_call", { name: "read" }), "read");
    assert.equal(tierForToolCall("tool_call", { name: "bash" }), "hard-write");
    assert.equal(tierForToolCall("read", {}), "read");
  });
});

describe("the schema tax, recorded at the moment the tool is added (rule 3)", () => {
  it("prices tool_call rather than making the toolset NULL", () => {
    const withToolCall = measureToolset(["read", "bash", "edit", "write", "tool_call"]);
    assert.equal(withToolCall.complete, true, "an unpriced tool makes the whole measurement NULL");
    const without = measureToolset(["read", "bash", "edit", "write"]);
    const delta = (withToolCall.tokens ?? 0) - (without.tokens ?? 0);
    assert.ok(delta > 0, "the tool has to cost something; a zero delta means it was not measured");
    assert.ok(delta < (without.tokens ?? 0), "one transport tool must not cost more than the whole worker four");
  });

  it("keeps the catalog wire description identical to the tool own", () => {
    assert.equal(TOOL_CATALOG.tool_call!.description, TOOL_CALL_DESCRIPTION);
  });
});

describe("session registration", () => {
  it("loadTools registers tool_call when it is named, with gated write/edit/bash as execute targets", () => {
    const loaded = loadTools(["read", "bash", "edit", "write", TOOL_CALL_TOOL_NAME], {
      cwd: process.cwd(),
      gate: new AutoApproveGate(),
      denials: new DenialLog(),
      modelProvider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    assert.ok(loaded.customTools.some((t) => t.name === TOOL_CALL_TOOL_NAME));
    assert.ok(loaded.activeToolNames.includes(TOOL_CALL_TOOL_NAME));
    // P10.3 added the wrapped `read` to the shadowed set and P10.4 added the
    // shell and the four search tools. All of them are registered whether or
    // not the caller named them, which is what `buildGatedTools` has always
    // done: `customTools` is the set of definitions that EXIST for this
    // session, and `activeToolNames` is the separate question of which ones
    // ride the request. That split is the whole transport — a mounted tool is
    // registered and unlisted, so `tool_call` can dispatch it.
    //
    // P10.4 (ticket 14) narrowed this from a whole-list assertion to the
    // property it is named after. `ast_grep` and `ast_edit` register
    // unconditionally too, and so will every mounted tool built after them;
    // a list re-typed on every addition tests nothing about registration.
    const registered = loaded.customTools.filter((t) => t.name !== TOOL_CALL_TOOL_NAME).map((t) => t.name);
    for (const unnamed of ["powershell", "grep", "glob", "find", "ls", "ast_grep", "ast_edit"]) {
      assert.ok(registered.includes(unnamed), `${unnamed} must be registered even though nobody named it`);
    }
    // ...and the mounted half of that set stays off the wire, which is the
    // half of the split that makes the transport worth having.
    for (const mounted of ["find", "ls", "ast_grep", "ast_edit"]) {
      assert.equal(loaded.activeToolNames.includes(mounted), false, mounted);
    }
  });
});

describe("P10.2 Agent trio is mounted and dispatched by tool_call", () => {
  function tracer(name: string) {
    const calls: unknown[] = [];
    const tool = defineTool({
      name,
      label: name,
      description: TOOL_CATALOG[name]?.description ?? name,
      parameters: Type.Object({}),
      async execute(_id, params) {
        calls.push(params);
        return { content: [{ type: "text" as const, text: `${name}-ok` }], details: { name } };
      },
    });
    return { tool, calls };
  }

  it("executes Agent, get_subagent_result, and steer_subagent through tool_call", async () => {
    const agent = tracer("agent");
    const get = tracer("get_subagent_result");
    const steer = tracer("steer_subagent");
    const toolCall = buildToolCallTool({ tools: [agent.tool, get.tool, steer.tool] });

    const a = await call(toolCall, { name: "agent", arguments: {} });
    const g = await call(toolCall, { name: "get_subagent_result", arguments: {} });
    const s = await call(toolCall, { name: "steer_subagent", arguments: {} });
    assert.equal(textOf(a), "agent-ok");
    assert.equal(textOf(g), "get_subagent_result-ok");
    assert.equal(textOf(s), "steer_subagent-ok");
    assert.equal(agent.calls.length, 1);
    assert.equal(get.calls.length, 1);
    assert.equal(steer.calls.length, 1);
  });

  it("a session finds Agent through tool_search and calls it through tool_call", async () => {
    const agent = tracer("agent");
    const search = buildToolSearchTool({ tools: [agent.tool] });
    const toolCall = buildToolCallTool({ tools: [agent.tool] });

    const found = await call(search, { query: "agent" });
    assert.equal(found.details?.kind, "exact");
    const expected = renderMountedToolSchema({
      name: agent.tool.name,
      description: agent.tool.description,
      parameters: agent.tool.parameters,
    });
    assert.equal(textOf(found), expected);

    const dispatched = await call(toolCall, { name: "agent", arguments: {} });
    assert.equal(textOf(dispatched), "agent-ok");
    assert.equal(agent.calls.length, 1);
  });
});
