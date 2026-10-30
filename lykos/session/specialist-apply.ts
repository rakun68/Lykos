/**
 * Specialist application seam.
 *
 * One module decides what a specialist means in a given context (session-start,
 * switch, or subagent). Session start is its first caller and carries no rules of its own.
 * Later tickets convert the other two call sites.
 *
 * Three copies of these rules can disagree three ways, and the way they would disagree
 * is a restriction failing open in one context while holding in the other two.
 *
 * Both tools_mode append and override refuse. The difference is token cost and
 * clarity, never safety, which is what makes append the safe default rather than
 * the lax one.
 */

import { SUBAGENT_WORKFLOW_TOOL, canonicalToolName } from "../tools/tool-surface.js";

export type SpecialistContext = 'session-start' | 'switch' | 'subagent';
export type PromptMode = 'append' | 'override';
export type ToolsMode = 'append' | 'override';
export type ToolDisposition = 'resident' | 'mounted' | 'off';

/**
 * The specialist's own fields, as the seam needs to see them. Callers forward this
 * object whole rather than picking the fields they happen to use, so that a caller
 * added later cannot starve the seam of an input it now depends on.
 */
export interface SpecialistFields {
  instructions?: string;
  prompt_mode?: PromptMode;
  tools_mode?: ToolsMode;
  provider?: string;
  model?: string;
  tools?: readonly string[];
  tools_add?: readonly string[];
  tools_remove?: readonly string[];
}

export interface ApplySpecialistInput {
  name?: string;
  specialist?: SpecialistFields;
  context: SpecialistContext;
  parentModel?: string;
  callerModel?: string;
  delegateModel?: string;
  defaultToolNames: string[];
  specialistToolNames?: string[];
}

export interface SpecialistApplication {
  promptMode: PromptMode;
  toolsMode: ToolsMode;
  replacesDefaultHead: boolean;
  tools: { name: string; disposition: ToolDisposition; inRequest: boolean }[];
  requestToolNames: string[];
  offLimitToolNames: string[];
  offLimitsPromptPart?: string;
  promptPart?: string;
  model?: string;
  modelSource?: "config_default" | "caller_override" | "specialist";
  notices: string[];
}

export const OFF_LIMITS_HEADING = "## lykos-off-limits";

export function assembleOffLimitsHead(offLimitToolNames: readonly string[], specialistName?: string): string {
  if (offLimitToolNames.length === 0) return "";
  const namePart = specialistName ? ` for specialist "${specialistName}"` : "";
  return [
    OFF_LIMITS_HEADING,
    `The following tools are off limits${namePart} and must not be called: ${offLimitToolNames.join(", ")}. Calls to them will be refused.`,
  ].join("\n");
}

function applyDeltas(
  base: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): string[] {
  const result: string[] = [];
  const removeSet = new Set(remove.map(canonicalToolName));
  for (const raw of base) {
    const name = canonicalToolName(raw);
    if (!removeSet.has(name) && !result.includes(name)) {
      result.push(name);
    }
  }
  for (const raw of add) {
    const name = canonicalToolName(raw);
    if (name === SUBAGENT_WORKFLOW_TOOL) continue;
    if (!removeSet.has(name) && !result.includes(name)) {
      result.push(name);
    }
  }
  return result;
}

export function applySpecialist(input: ApplySpecialistInput): SpecialistApplication {
  const declaredPromptMode = input.specialist?.prompt_mode ?? "append";
  const declaredToolsMode = input.specialist?.tools_mode ?? "append";
  const notices: string[] = [];

  let promptMode: PromptMode;
  let replacesDefaultHead: boolean;

  if (input.context === "switch") {
    promptMode = "append";
    replacesDefaultHead = false;
    if (input.specialist?.prompt_mode === "override") {
      const name = input.name ?? "";
      notices.push(
        `specialist "${name}" declares prompt_mode: override \u2014 the override is NOT active in this session; the head is frozen at boot. Use \x2fclear to adopt it wholly.`
      );
    }
  } else {
    promptMode = declaredPromptMode;
    replacesDefaultHead = promptMode === "override";
  }

  const toolsMode: ToolsMode = declaredToolsMode;

  const toolsAdd = input.specialist?.tools_add ?? [];
  const toolsRemove = input.specialist?.tools_remove ?? [];
  const hasDeltas = toolsAdd.length > 0 || toolsRemove.length > 0;

  if (toolsRemove.length > 0) {
    const removeNotice = `tools_remove (${toolsRemove.join(", ")}) genuinely removes capability this session — P10's mounted-tool transport has not landed, so a removed tool is not reachable any other way`;
    if (!notices.includes(removeNotice)) notices.push(removeNotice);
  }

  const baseTools =
    input.specialist?.tools !== undefined
      ? input.specialist.tools
      : input.defaultToolNames;

  const residentToolNames =
    input.specialistToolNames !== undefined
      ? input.specialistToolNames
      : applyDeltas(baseTools, toolsAdd, toolsRemove);
  const offLimitToolNames = input.defaultToolNames.filter(
    (name) => !residentToolNames.includes(name)
  );

  const addedToolNames = residentToolNames.filter(
    (name) => !input.defaultToolNames.includes(name)
  );
  const baseResidentTools = input.defaultToolNames.map((name) => {
    const isOff = offLimitToolNames.includes(name);
    const isMounted = toolsRemove.includes(name);
    const disposition: ToolDisposition = !isOff
      ? "resident"
      : isMounted
        ? "mounted"
        : "off";
    return {
      name,
      disposition,
      inRequest: toolsMode === "override" ? !isOff : true,
    };
  });

  const addedResidentTools = addedToolNames.map((name) => ({
    name,
    disposition: "resident" as const,
    inRequest: true,
  }));

  const extraMountedTools = toolsRemove
    .filter((name) => !input.defaultToolNames.includes(name))
    .map((name) => ({
      name,
      disposition: "mounted" as const,
      inRequest: false,
    }));

  const tools = [...baseResidentTools, ...addedResidentTools, ...extraMountedTools];

  const requestToolNames =
    toolsMode === "override"
      ? residentToolNames
      : [...input.defaultToolNames, ...addedToolNames];

  let offLimitsPromptPart: string | undefined;
  if (toolsMode === "append" && offLimitToolNames.length > 0) {
    offLimitsPromptPart = assembleOffLimitsHead(offLimitToolNames, input.name);
  }

  let model: string | undefined;
  let modelSource: "config_default" | "caller_override" | "specialist" | undefined;

  const declaredSpecialistModel =
    input.specialist?.provider && input.specialist?.model
      ? `${input.specialist.provider}/${input.specialist.model}`
      : undefined;

  if (input.context === "subagent") {
    if (input.callerModel !== undefined && input.callerModel.trim().length > 0) {
      model = input.callerModel;
      modelSource = "caller_override";
    } else {
      const setting = input.delegateModel ?? "specialist";
      if (setting === "specialist") {
        if (declaredSpecialistModel !== undefined) {
          model = declaredSpecialistModel;
          modelSource = "specialist";
        } else {
          model = input.parentModel;
          modelSource = "config_default";
        }
      } else if (setting === "parent") {
        model = input.parentModel;
        modelSource = "config_default";
      } else {
        model = setting;
        modelSource = "config_default";
      }
    }
  } else {
    model = declaredSpecialistModel;
    if (model !== undefined) {
      modelSource = "specialist";
    }
  }

  return {
    promptMode,
    toolsMode,
    replacesDefaultHead,
    tools,
    requestToolNames,
    offLimitToolNames,
    ...(offLimitsPromptPart !== undefined ? { offLimitsPromptPart } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(modelSource !== undefined ? { modelSource } : {}),
    notices,
  };
}

