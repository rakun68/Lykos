// Transport discovery half (ADR-0024): tool_search returns full schemas.
// Exact-name first; BM25 ranking only sees queries that missed the name.

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { TOOL_REGISTRY } from "./tool-surface.js";
import { renderMountedToolSchema } from "./tool-call.js";
import { rankByBm25, searchTextForTool } from "./tool-search-bm25.js";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";

export const TOOL_SEARCH_DEFAULT_LIMIT = 8;

export const TOOL_SEARCH_DESCRIPTION =
  "Search mounted tools by exact name or a natural-language query and return matching full schemas.";

export const TOOL_SEARCH_PARAMETERS = Type.Object({
  query: Type.String({
    description: "Exact mounted-tool name, or a natural-language query to rank mounted tools.",
  }),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum ranked matches. Defaults to 8. Ignored on an exact-name hit.",
    }),
  ),
});

export interface ToolSearchToolOpts {
  tools?: readonly ToolDefinition[] | (() => readonly ToolDefinition[]);
}

export type ToolSearchHit =
  | { kind: "exact"; tool: ToolDefinition }
  | { kind: "ranked"; tools: ToolDefinition[] }
  | { kind: "empty"; names: string[] }
  | { kind: "rejected"; reason: string };

function mountedFrom(toolList: readonly ToolDefinition[]): ToolDefinition[] {
  return toolList.filter((t) => {
    const entry = TOOL_REGISTRY.find((e) => e.name === t.name);
    return entry?.residency === "mounted";
  });
}

function schemaOf(tool: ToolDefinition): string {
  return renderMountedToolSchema({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  });
}

export function searchMountedTools(
  query: string,
  toolList: readonly ToolDefinition[],
  limit: number = TOOL_SEARCH_DEFAULT_LIMIT,
): ToolSearchHit {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return { kind: "rejected", reason: "lykos: tool_search requires a non-empty query." };
  }
  if (!(limit > 0)) {
    return { kind: "rejected", reason: "lykos: tool_search limit must be greater than 0." };
  }
  const searchable = mountedFrom(toolList);
  const names = searchable.map((t) => t.name);
  const exact = searchable.find((t) => t.name === trimmed);
  if (exact) return { kind: "exact", tool: exact };
  const ranked = rankByBm25(trimmed, searchable, (t) =>
    searchTextForTool({ name: t.name, description: t.description, parameters: t.parameters }),
  ).slice(0, limit);
  if (ranked.length === 0) return { kind: "empty", names };
  return { kind: "ranked", tools: ranked };
}

export function buildToolSearchTool(opts: ToolSearchToolOpts = {}): ToolDefinition {
  return defineTool({
    name: TOOL_SEARCH_TOOL_NAME,
    label: "Tool Search",
    description: TOOL_SEARCH_DESCRIPTION,
    promptSnippet: "Search mounted tools by name or query and return their full schema",
    parameters: TOOL_SEARCH_PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const text = (s: string) => [{ type: "text" as const, text: s }];
      const toolList = typeof opts.tools === "function" ? opts.tools() : (opts.tools ?? []);
      const limit = params.limit !== undefined ? params.limit : TOOL_SEARCH_DEFAULT_LIMIT;
      const hit = searchMountedTools(params.query, toolList, limit);
      if (hit.kind === "rejected") {
        return { content: text(hit.reason), details: { rejected: true } };
      }
      if (hit.kind === "exact") {
        return { content: text(schemaOf(hit.tool)), details: { name: hit.tool.name, kind: "exact" } };
      }
      if (hit.kind === "ranked") {
        return {
          content: text(hit.tools.map(schemaOf).join("\n\n")),
          details: { names: hit.tools.map((t) => t.name), kind: "ranked" },
        };
      }
      const reason = `lykos: no mounted tool named "${params.query.trim()}". What exists: ${hit.names.join(", ")}`;
      return { content: text(reason), details: { exists: hit.names, kind: "empty" } };
    },
  });
}
