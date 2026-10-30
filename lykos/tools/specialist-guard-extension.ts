/**
 * Specialists band 2 ticket 02: the enforcement point.
 *
 * Pi fires `tool_call` before any tool executes and a handler may block it
 * (`dist/core/extensions/types.d.ts`: "Fired before a tool executes. Can block."),
 * which is the only interception that reaches EVERY tool by name — Lykos's own
 * gate shadows `write`, `edit` and `bash` and cannot refuse `read` or a custom
 * tool. Both `tools_mode` values refuse here. The modes differ in what the
 * request carries, never in what is enforced, which is what makes `append` the
 * safe default rather than the lax one.
 *
 * **This file runs in its own module graph.** Pi's loader calls jiti with
 * `moduleCache: false` (`dist/core/extensions/loader.js`), so the instance Pi
 * evaluates is NOT the instance `boot.ts` imports. Module-level state therefore
 * does not cross the boundary, and anything the host must share with the handler
 * has to travel by a channel both graphs can see: the environment for the
 * restriction itself, and one well-known key on `globalThis` for the denial log.
 * An earlier version of this file kept the denial log in a module-level variable
 * and recorded nothing in production while every test passed.
 */

import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { DenialLog } from "../gate/approval.js";
import {
  SPECIALIST_NAME_ENV,
  SPECIALIST_OFF_LIMITS_ENV,
  SPECIALIST_ALLOWED_ENV,
  REGISTRY_OFF_TOOLS_ENV,
  decodeSpecialistOffLimitsEnv,
  decodeRegistryOffToolsEnv,
  DEFAULT_REGISTRY_OFF_TOOLS,
} from "../config/extensions.js";

export { SPECIALIST_NAME_ENV, SPECIALIST_OFF_LIMITS_ENV, SPECIALIST_ALLOWED_ENV, REGISTRY_OFF_TOOLS_ENV };

/**
 * The one key both module graphs read. Namespaced and versioned so a future
 * change to what is stored here cannot be mistaken for the old shape.
 */
export const GUARD_DENIAL_LOG_KEY = "__lykos_specialist_guard_denials_v1__";

type GuardGlobal = typeof globalThis & { [GUARD_DENIAL_LOG_KEY]?: DenialLog };

export function setGuardDenialLog(log?: DenialLog): void {
  const g = globalThis as GuardGlobal;
  if (log === undefined) {
    delete g[GUARD_DENIAL_LOG_KEY];
    return;
  }
  g[GUARD_DENIAL_LOG_KEY] = log;
}

export function getGuardDenialLog(): DenialLog | undefined {
  return (globalThis as GuardGlobal)[GUARD_DENIAL_LOG_KEY];
}

export function buildSpecialistRefusal(
  specialist: string,
  disallowedTool: string,
  allowedTools: readonly string[],
): string {
  const allowed = allowedTools.length > 0 ? allowedTools.join(", ") : "(none)";
  return (
    `lykos: refused \u2014 the "${specialist}" specialist does not allow ${disallowedTool}. ` +
    `This is a configuration choice, not a failure, and retrying the same call will be refused again.\n` +
    `Allowed here: ${allowed}. Use one of those, or say what you need and stop.`
  );
}

export interface SpecialistGuardHandlerOpts {
  specialistName?: string;
  offLimitTools?: readonly string[];
  registryOffTools?: readonly string[];
  allowedTools?: readonly string[];
  residentTools?: readonly string[];
  denials?: DenialLog;
}

export function createSpecialistGuardHandler(
  opts: SpecialistGuardHandlerOpts = {},
): (event: ToolCallEvent) => ToolCallEventResult | undefined {
  return (event: ToolCallEvent): ToolCallEventResult | undefined => {
    const specialistOffLimits =
      opts.offLimitTools ?? decodeSpecialistOffLimitsEnv(process.env[SPECIALIST_OFF_LIMITS_ENV]) ?? [];
    const registryOff =
      opts.registryOffTools ??
      decodeRegistryOffToolsEnv(process.env[REGISTRY_OFF_TOOLS_ENV]) ??
      DEFAULT_REGISTRY_OFF_TOOLS;

    const allOff = new Set([...specialistOffLimits, ...registryOff]);
    if (allOff.size === 0) {
      return undefined;
    }

    const toolName = event.toolName;
    if (!allOff.has(toolName)) {
      return undefined;
    }

    const specialist = opts.specialistName ?? process.env[SPECIALIST_NAME_ENV] ?? "unnamed";
    const denials = opts.denials ?? getGuardDenialLog();
    denials?.record("specialist_restricted", toolName, specialist);

    const allowed =
      opts.allowedTools ??
      opts.residentTools ??
      decodeSpecialistOffLimitsEnv(process.env[SPECIALIST_ALLOWED_ENV]) ??
      [];

    const reason = buildSpecialistRefusal(specialist, toolName, allowed);
    return {
      block: true,
      reason,
    };
  };
}

export default function specialistGuardExtension(pi: ExtensionAPI): void {
  pi.on("tool_call", createSpecialistGuardHandler());
}
