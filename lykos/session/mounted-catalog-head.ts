// P10.2 — the mounted-catalog head block (ADR-0022).
//
// One frozen string, assembled at boot from the registry. `named` tools get
// one line; `full` tools get description and schema inlined; `hidden` tools
// appear nowhere here and are discoverable only through tool_search.
//
// Empty catalog, empty string: a heading with no entries spends tokens to
// say nothing (same rule as the memory block).

import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { renderToolParameters } from "../tools/tool-call.js";
import { TOOL_REGISTRY, type ToolRegistryEntry } from "../tools/tool-surface.js";

export const MOUNTED_CATALOG_HEADING = "## lykos-mounted-catalog";

export const FULL_PRESENCE_SAVES_NOTHING =
  "The full presence level saves no tokens: it moves the description and schema out of the tool list and into this block.";

function shortDescription(entry: ToolRegistryEntry): string {
  const catalog = TOOL_CATALOG[entry.name];
  if (catalog && catalog.description.length > 0) {
    const first = catalog.description.split(/(?<=\.)\s/)[0] ?? catalog.description;
    return first.trim();
  }
  return entry.rationale;
}

function renderNamed(entry: ToolRegistryEntry): string {
  return `- ${entry.name}: ${shortDescription(entry)}`;
}

function renderFull(entry: ToolRegistryEntry): string {
  const catalog = TOOL_CATALOG[entry.name];
  const description = catalog?.description ?? entry.rationale;
  const parameters = catalog?.parameters;
  const schema =
    parameters !== undefined ? renderToolParameters(parameters) : "(schema not in the catalog)";
  return `### ${entry.name}\n${description}\nparameters:\n${schema}`;
}

export function assembleMountedCatalogHead(
  entries: readonly ToolRegistryEntry[] = TOOL_REGISTRY,
): string {
  const named = entries.filter((e) => e.residency === "mounted" && e.promptPresence === "named");
  const full = entries.filter((e) => e.residency === "mounted" && e.promptPresence === "full");
  if (named.length === 0 && full.length === 0) return "";

  const parts: string[] = [
    MOUNTED_CATALOG_HEADING,
    "These tools are mounted. They are not in the request tool list. Discover a schema with tool_search and execute with tool_call.",
  ];
  if (full.length > 0) parts.push(FULL_PRESENCE_SAVES_NOTHING);
  for (const entry of named) parts.push(renderNamed(entry));
  for (const entry of full) parts.push(renderFull(entry));
  return parts.join("\n");
}
