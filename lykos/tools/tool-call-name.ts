// What a tool call names and changes, seen through the `tool_call` transport (ADR-0024). A leaf: it imports nothing
// from Pi, so the gate, the exploration classifier and config validation can ask it without loading the runtime,
// which costs seconds at startup. `tool-call.ts` re-exports it next to the tool itself.

import { resultSaysFilesChanged, toolChangesFiles } from "./tool-surface.js";
import { tierForTool, type RiskTier } from "./tool-risk.js";

export const TOOL_CALL_TOOL_NAME = "tool_call";

export function resolveActualToolName(wireToolName: string | undefined, args: unknown): string | undefined {
  if (wireToolName === TOOL_CALL_TOOL_NAME && args && typeof args === "object" && !Array.isArray(args)) {
    const rec = args as Record<string, unknown>;
    if (typeof rec.name === "string" && rec.name.length > 0) {
      return rec.name;
    }
  }
  return wireToolName;
}

export function resolveActualToolArgs(wireToolName: string | undefined, args: unknown): unknown {
  if (wireToolName === TOOL_CALL_TOOL_NAME && args && typeof args === "object" && !Array.isArray(args)) {
    const rec = args as Record<string, unknown>;
    if (rec.arguments !== undefined) {
      return rec.arguments;
    }
  }
  return args;
}

/**
 * P4 T143: did this call — direct, or a mounted tool reached through
 * `tool_call` — change a file? The one question the post-edit loop, the gate
 * and the edit counters ask, answered from `ToolRegistryEntry.changesFiles`.
 *
 * T156: and from two runtime sources, still behind this one function. A
 * Lykos extension tool that declared `changesFiles` is in the lookup from the
 * moment it registers; one that declared nothing is judged per call, by its
 * wrapper comparing the git working tree before and after, and the verdict
 * rides the call's `result`. A reader that has the result passes it; one
 * asking before the call ran (the checkpoint-before-edit hook) cannot know
 * about an undeclared tool, and says so by passing none.
 */
export function isFileChangingCall(wireToolName: string | undefined, args: unknown, result?: unknown): boolean {
  if (result !== undefined && resultSaysFilesChanged(result)) return true;
  return toolChangesFiles(resolveActualToolName(wireToolName, args), resolveActualToolArgs(wireToolName, args));
}

export function tierForToolCall(name: string, args: unknown): RiskTier {
  const actual = resolveActualToolName(name, args);
  return tierForTool(actual ?? name);
}
