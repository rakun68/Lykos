// T4.1: measure the tool-schema tax — the JSON that rides in every request
// for the whole session (docs/06-extension-policy.md §1 rule 2,
// problems/14-extension-sprawl.md).
//
// This is a *local* measurement of the wire payload, not a billed token
// count. The basis is named on every result the same way avoided_basis is
// named on every counterfactual: `pi_estimateTokens_chars/4` is Pi 0.84.3's
// own estimator (`Math.ceil(chars / 4)`, packages/coding-agent compaction),
// applied to the canonical OpenAI-function JSON DeepSeek actually receives.
// It will disagree with the provider tokenizer; it is comparable across
// toolsets, which is the number the intake bar needs. It is never used as
// cost_usd.
//
// Unknown tools make the whole measurement NULL, never a silent undercount.
// An empty known set is 0. Those are different answers.

import { createHash } from "node:crypto";
import { CATALOG_META, TOOL_CATALOG, type CatalogTool } from "./tool-catalog.js";

export const SCHEMA_TOKENS_BASIS = "pi_estimateTokens_chars/4" as const;
export type SchemaTokensBasis = typeof SCHEMA_TOKENS_BASIS;

/** Pi 0.84.3 default built-ins (createAgentSession with no `tools` allowlist). */
export const PI_DEFAULT_TOOLS = ["read", "bash", "edit", "write"] as const;

/**
 * Default built-ins plus the four tools pi-subagents 0.19.0 registers when
 * workflows are on (the Lykos sandbox default). Order matches typical
 * registration: builtins first, then Agent, result, steer, workflow.
 */
export const PI_DEFAULT_PLUS_SUBAGENTS = [
  ...PI_DEFAULT_TOOLS,
  "agent",
  "get_subagent_result",
  "steer_subagent",
  "subagent_workflow",
] as const;

export interface ToolSchemaMeasurement {
  complete: boolean;
  unknown: string[];
  names: string[];
  count: number;
  /** UTF-8 byte length of the canonical wire JSON. Null when incomplete. */
  bytes: number | null;
  /** ceil(canonical.length / 4). Null when incomplete — never a guessed 0. */
  tokens: number | null;
  /** SHA-256 of the canonical wire JSON. Null when incomplete. */
  hash: string | null;
  basis: SchemaTokensBasis;
}

export interface SchemaTaxShare {
  schemaTokens: number;
  promptTokens: number;
  /** schema / (input + cache_read); null when the denominator is 0. */
  share: number | null;
}

/** Pi 0.84.3 estimateTokens for text: ceil(chars / 4). Conservative (overestimates). */
export function estimateTokensChars4(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * OpenAI-compatible function-calling payload (DeepSeek's path through pi-ai).
 * Field order is fixed so the hash is stable across process runs.
 */
export function toolToWireFunction(tool: CatalogTool): {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
} {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

export function canonicalizeToolset(tools: CatalogTool[]): string {
  return JSON.stringify(tools.map(toolToWireFunction));
}

export function lookupCatalogTool(name: string): CatalogTool | undefined {
  return TOOL_CATALOG[name];
}

export function catalogMeta(): typeof CATALOG_META {
  return CATALOG_META;
}

/**
 * Measure a named toolset against a catalog. `names` is the order the API
 * would send (hash-sensitive). Unknown names make `complete: false` and
 * tokens/bytes/hash NULL — a partial sum would look like a complete tax.
 *
 * `catalog` defaults to Pi's own `TOOL_CATALOG`. A caller measuring a
 * *swap* — a third-party extension that overrides a built-in tool under the
 * same name — passes a merged catalog
 * (`{ ...TOOL_CATALOG, read: swappedRead, edit: swappedEdit }`) so the
 * measurement reflects what the wire payload actually becomes, not what Pi
 * ships by default.
 */
export function measureToolset(
  names: readonly string[],
  catalog: Record<string, CatalogTool> = TOOL_CATALOG,
): ToolSchemaMeasurement {
  const unknown: string[] = [];
  const tools: CatalogTool[] = [];
  for (const name of names) {
    const tool = catalog[name];
    if (!tool) unknown.push(name);
    else tools.push(tool);
  }
  const basis = SCHEMA_TOKENS_BASIS;
  if (unknown.length > 0) {
    return {
      complete: false,
      unknown,
      names: [...names],
      count: names.length,
      bytes: null,
      tokens: null,
      hash: null,
      basis,
    };
  }
  // No tools is a measured 0 tax, not a 1-token estimate of the "[]" wrapper.
  // bytes/hash still describe the wire payload so prefix comparison stays defined.
  if (names.length === 0) {
    const canonical = "[]";
    return {
      complete: true,
      unknown: [],
      names: [],
      count: 0,
      bytes: Buffer.byteLength(canonical, "utf8"),
      tokens: 0,
      hash: createHash("sha256").update(canonical).digest("hex"),
      basis,
    };
  }
  const canonical = canonicalizeToolset(tools);
  const bytes = Buffer.byteLength(canonical, "utf8");
  return {
    complete: true,
    unknown: [],
    names: [...names],
    count: names.length,
    bytes,
    tokens: estimateTokensChars4(canonical),
    hash: createHash("sha256").update(canonical).digest("hex"),
    basis,
  };
}

export function measureSpecialist(
  names: readonly string[],
  catalog: Record<string, CatalogTool> = TOOL_CATALOG,
): ToolSchemaMeasurement & { complete: true; tokens: number; bytes: number; hash: string } {
  const m = measureToolset(names, catalog);
  if (!m.complete || m.tokens === null || m.bytes === null || m.hash === null) {
    throw new Error(
      `lykos tool-schema: catalog specialist incomplete (unknown: ${m.unknown.join(", ") || "?"})`,
    );
  }
  return { ...m, complete: true, tokens: m.tokens, bytes: m.bytes, hash: m.hash };
}

export function piDefaultBaseline(): ReturnType<typeof measureSpecialist> {
  return measureSpecialist(PI_DEFAULT_TOOLS);
}

export function piDefaultPlusSubagentsBaseline(): ReturnType<typeof measureSpecialist> {
  return measureSpecialist(PI_DEFAULT_PLUS_SUBAGENTS);
}

/** schema_tokens / billed input-side tokens (fresh + cache-read). */
export function schemaShareOfPrompt(
  schemaTokens: number | null,
  inputTokens: number,
  cacheReadTokens: number,
): SchemaTaxShare | null {
  if (schemaTokens === null) return null;
  const promptTokens = inputTokens + cacheReadTokens;
  return {
    schemaTokens,
    promptTokens,
    share: promptTokens > 0 ? schemaTokens / promptTokens : null,
  };
}

export function formatShare(share: number | null): string {
  if (share === null) return "?%";
  return `${(share * 100).toFixed(1)}%`;
}
