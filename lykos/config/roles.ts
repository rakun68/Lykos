// Roles and their models (T239, spec decision 7). A P18 role is a specialist of the same name whose model is
// `models.roles.<role>`; `models.roles.<role>-alt` is its alternate. A reviewer never reviews its own model
// family's code: when the reviewer's model is the implementer's family and the alternate's is not, the
// alternate reviews (Boxie's lib/family.mjs, research/workflow.md §3 in the maintainer's notes).

import type { ConfigLayer } from "./types.js";

/** The P18 roles: each a specialist, each with an alternate. `implement-hard`, `review-spec` and `review-std` are P21. */
export const P18_ROLES = ["implement", "quick", "review-both"] as const;

export function altRole(role: string): string {
  return `${role}-alt`;
}

/** The vendor a model id names, not the router or subscription it comes through. */
export function modelFamily(model: string): string {
  const id = model.toLowerCase().trim().split(/\s+/)[0] ?? "";
  if (/deepseek/.test(id)) return "deepseek";
  if (/gemini/.test(id)) return "google";
  if (/claude|opus|sonnet|haiku/.test(id)) return "anthropic";
  if (/kimi/.test(id)) return "moonshot";
  if (/glm/.test(id)) return "zhipu";
  if (/gpt|codex|(^|\/)cx\//.test(id)) return "openai";
  if (/grok/.test(id)) return "xai";
  if (/composer/.test(id)) return "cursor";
  return id;
}

/** The model a role runs on, or undefined when the role names none. */
export function roleModel(roles: Readonly<Record<string, string>>, role: string): string | undefined {
  const model = roles[role];
  return model !== undefined && model !== "" ? model : undefined;
}

/**
 * The model a session's role gives it, below the caller's and the specialist file's own: the role named
 * after its specialist, else `worker`.
 */
export function sessionRoleModel(roles: Readonly<Record<string, string>>, specialist: string | undefined): string | undefined {
  return (specialist !== undefined ? roleModel(roles, specialist) : undefined) ?? roleModel(roles, "worker");
}

export interface RoleChoice {
  /** The role that runs: the role asked for, or its alternate. */
  role: string;
  model: string | undefined;
  /** Why the alternate was chosen, when it was. */
  reason?: string;
}

/**
 * The role that reviews `implementerModel`'s work: `role` unless its model is the implementer's family and
 * the alternate's is not, then the alternate.
 */
export function reviewerRole(roles: Readonly<Record<string, string>>, role: string, implementerModel: string | undefined): RoleChoice {
  const main = roleModel(roles, role);
  const alt = roleModel(roles, altRole(role));
  if (implementerModel === undefined || main === undefined || alt === undefined) return { role, model: main };
  const implementerFamily = modelFamily(implementerModel);
  if (modelFamily(main) === implementerFamily && modelFamily(alt) !== implementerFamily) {
    return { role: altRole(role), model: alt, reason: `${role} runs on ${main}, the implementer's family (${implementerFamily})` };
  }
  return { role, model: main };
}

export interface RoleMapping {
  role: string;
  model: string;
  /** The layer that set it: `defaults`, `global`, `project`, `env` or `flags`, with its file when it has one. */
  source: string;
}

/** Every role in the resolved config with its model and the last layer that set it. */
export function roleMappings(roles: Readonly<Record<string, string>>, layers: readonly ConfigLayer[]): RoleMapping[] {
  return Object.entries(roles)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([role, model]) => {
      let source = "defaults";
      for (const layer of layers) {
        if (!layer.present || layer.name === "specialist") continue;
        const set = layer.value.models?.roles?.[role];
        if (set !== undefined) source = layer.path !== undefined ? `${layer.name} (${layer.path})` : layer.name;
      }
      return { role, model, source };
    });
}
