import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { AutoApproveGate, DenialLog } from "../gate/approval.js";
import { fingerprintHead } from "../session/head-contract.js";
import { buildTaskListTool, newTaskListState } from "./task-list.js";
import { loadTools } from "./session-tools.js";
import { TOOL_REGISTRY } from "./tool-surface.js";
import {
  TOOL_SEARCH_DESCRIPTION,
  TOOL_SEARCH_TOOL_NAME,
  buildToolSearchTool,
  searchMountedTools,
} from "./tool-search.js";
import { renderMountedToolSchema } from "./tool-call.js";

interface ExecResult {
  content: Array<{ type?: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

function textOf(res: ExecResult): string {
  return res.content[0]?.text ?? "";
}

const call = async (tool: ReturnType<typeof buildToolSearchTool>, params: unknown) =>
  (await (tool as unknown as {
    execute: (id: string, p: unknown, s?: unknown, u?: unknown, c?: unknown) => Promise<ExecResult>;
  }).execute("search-1", params)) as ExecResult;

function stubTool(name: string, description: string) {
  return defineTool({
    name,
    label: name,
    description,
    parameters: Type.Object({ pattern: Type.String({ description: "Search pattern." }) }),
    async execute() {
      return { content: [{ type: "text" as const, text: "unused" }], details: {} };
    },
  });
}

describe("P10.2 tool_search transport", () => {
  it("an exact-name query returns that mounted tool's full schema in one result", async () => {
    const findTool = stubTool("find", "File discovery by pattern");
    const search = buildToolSearchTool({ tools: [findTool] });

    const res = await call(search, { query: "find" });
    assert.equal(res.isError ?? false, false);
    const text = textOf(res);
    const expected = renderMountedToolSchema({
      name: findTool.name,
      description: findTool.description,
      parameters: findTool.parameters,
    });
    assert.equal(text, expected);
    assert.ok(text.includes("name: find"));
    assert.ok(text.includes("File discovery by pattern"));
    assert.ok(text.includes(JSON.stringify(findTool.parameters, null, 2)));
  });

  it("a query matching nothing names the mounted tools that exist, never resident or off tools", async () => {
    const findTool = stubTool("find", "File discovery by pattern");
    const todoTool = buildTaskListTool({ state: newTaskListState() });
    const offTool = stubTool("web_search", "Search the web");
    const search = buildToolSearchTool({ tools: [findTool, todoTool, offTool] });

    const res = await call(search, { query: "nope" });
    assert.equal(res.isError ?? false, false);
    const text = textOf(res);
    assert.ok(text.includes('lykos: no mounted tool named "nope". What exists:'));
    assert.ok(text.includes("find"));
    assert.equal(text.includes("todo"), false);
    assert.equal(text.includes("web_search"), false);
  });

  it("snapshots the active tool list and prefix fingerprint across a search", async () => {
    const loaded = loadTools(["read", "bash", "edit", "write", TOOL_SEARCH_TOOL_NAME], {
      cwd: process.cwd(),
      gate: new AutoApproveGate(),
      denials: new DenialLog(),
      modelProvider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    const search = loaded.customTools.find((t) => t.name === TOOL_SEARCH_TOOL_NAME);
    assert.ok(search, "loadTools must register tool_search when named");

    const beforeNames = [...loaded.activeToolNames];
    const beforeFp = fingerprintHead("frozen-head", beforeNames);

    await call(search, { query: "find" });

    assert.deepEqual([...loaded.activeToolNames], beforeNames);
    assert.equal(fingerprintHead("frozen-head", loaded.activeToolNames), beforeFp);
  });
});

describe("the schema tax, recorded at the moment the tool is added (rule 3)", () => {
  it("prices tool_search rather than making the toolset NULL", () => {
    const withSearch = measureToolset(["read", "bash", "edit", "write", "tool_search"]);
    assert.equal(withSearch.complete, true, "an unpriced tool makes the whole measurement NULL");
    const without = measureToolset(["read", "bash", "edit", "write"]);
    const delta = (withSearch.tokens ?? 0) - (without.tokens ?? 0);
    assert.ok(delta > 0, "the tool has to cost something; a zero delta means it was not measured");
    assert.ok(delta < (without.tokens ?? 0), "one transport tool must not cost more than the whole worker four");
  });

  it("keeps the catalog wire description identical to the tool own", () => {
    assert.equal(TOOL_CATALOG.tool_search!.description, TOOL_SEARCH_DESCRIPTION);
  });
});

describe("session registration", () => {
  it("loadTools registers tool_search when it is named", () => {
    const loaded = loadTools(["read", "bash", "edit", "write", TOOL_SEARCH_TOOL_NAME], {
      cwd: process.cwd(),
      gate: new AutoApproveGate(),
      denials: new DenialLog(),
      modelProvider: "deepseek",
      modelId: "deepseek-v4-flash",
    });
    assert.ok(loaded.customTools.some((t) => t.name === TOOL_SEARCH_TOOL_NAME));
    assert.ok(loaded.activeToolNames.includes(TOOL_SEARCH_TOOL_NAME));
  });
});

describe("P10.2 tool_search BM25 ranking", () => {
  function fromCatalog(name: string) {
    const cat = TOOL_CATALOG[name];
    assert.ok(cat, `catalog missing ${name}`);
    return defineTool({
      name,
      label: name,
      description: cat.description,
      parameters: Type.Unsafe(cat.parameters) as TSchema,
      async execute() {
        return { content: [{ type: "text" as const, text: "unused" }], details: {} };
      },
    });
  }

  const mounted = TOOL_REGISTRY.filter((e) => e.residency === "mounted").map((e) => fromCatalog(e.name));
  const findTool = mounted.find((t) => t.name === "find")!;
  const lsTool = mounted.find((t) => t.name === "ls")!;

  it("ranks the intent-matching mounted tool first on a fuzzy query over the real mounted set", async () => {
    const search = buildToolSearchTool({ tools: mounted });
    const res = await call(search, { query: "search for files by glob pattern" });
    assert.equal(res.details?.kind, "ranked");
    assert.equal((res.details?.names as string[])[0], "find");
    const text = textOf(res);
    assert.ok(text.includes("name: find"));
    assert.ok(text.includes(JSON.stringify(findTool.parameters, null, 2)));
  });

  it("an exact-name query never ranks — it returns that one schema", () => {
    const hit = searchMountedTools("ls", mounted);
    assert.equal(hit.kind, "exact");
    if (hit.kind === "exact") assert.equal(hit.tool.name, "ls");
  });

  it("ranked results carry full schemas in rank order", async () => {
    const search = buildToolSearchTool({ tools: mounted });
    const res = await call(search, { query: "list directory contents alphabetically" });
    assert.equal(res.details?.kind, "ranked");
    assert.equal((res.details?.names as string[])[0], "ls");
    const expected = renderMountedToolSchema({
      name: lsTool.name,
      description: lsTool.description,
      parameters: lsTool.parameters,
    });
    assert.ok(textOf(res).includes(expected));
  });

  it("a query matching nothing still names what exists", async () => {
    const search = buildToolSearchTool({ tools: mounted });
    const res = await call(search, { query: "xyzzynotatoolnameqqq" });
    assert.equal(res.details?.kind, "empty");
    const text = textOf(res);
    assert.ok(text.includes("What exists:"));
    assert.ok(text.includes("find"));
    assert.ok(text.includes("ls"));
    assert.ok(text.includes("agent"));
  });

  it("honours limit and rejects empty queries and a zero limit", async () => {
    const search = buildToolSearchTool({ tools: mounted });
    const limited = await call(search, { query: "file directory agent", limit: 1 });
    assert.equal(resLen(limited), 1);

    const empty = await call(search, { query: "   " });
    assert.ok(textOf(empty).includes("non-empty query"));

    const zero = await call(search, { query: "find", limit: 0 });
    assert.ok(textOf(zero).includes("limit must be greater than 0"));
  });
});

function resLen(res: ExecResult): number {
  const names = res.details?.names;
  return Array.isArray(names) ? names.length : 0;
}
