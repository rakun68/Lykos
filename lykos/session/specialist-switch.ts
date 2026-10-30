// Resolving a mid-session specialist switch and describing what it changed.
//
// Pure computation, deliberately kept out of `session/interactive.ts`: given
// a specialist name, the workspace, and the config the session is CURRENTLY
// running under, what does the sixth config layer resolve to, and what
// actually differs from what is running now? The live half — applying that
// diff to a real `AgentSession` (`session.setModel`, `setActiveToolsByName`,
// `setThinkingLevel`) and recording it on the ledger — is owned by
// `tui/interactive-surface.ts`, which is where the real session object
// lives; this module never touches one.
//
// **Why `loadConfig()` is called again rather than only calling
// `resolveSpecialistLayer()`.** A switch has to respect the SAME six-layer
// precedence the session booted under — project config, env, and any caller
// flag still apply, and a flag still beats the newly selected specialist (spec,
// "Where a specialist sits in configuration precedence"). Re-running the whole
// resolver is the only way to get that for free rather than re-deriving
// precedence a second time here.
//
// **Why tools are compared as the EFFECTIVE resident set, not the raw
// `tools`/`tools_add`/`tools_remove` fields.** Two specialists can set different
// deltas and land on the identical resident set, and a report that said
// "tools changed" for that case would be lying about what the interface
// actually does next turn. `effectiveToolNames()` runs the exact same
// `resolveStandaloneTools()` + `applyToolDeltas()` pipeline `session/boot.ts`
// uses to build the tool surface at boot.

import { NULL_EVENT_SINK, type LykosEventSink } from "../extensions/api.js";
import { loadConfig, type LoadConfigOptions } from "../config/load.js";
import type { ConfigFile, ResolvedConfig } from "../config/types.js";
import { discoverSpecialists, shippedSpecialistsDir, type SpecialistLocation } from "../config/specialists.js";
import { specialistModelSpec } from "../config/providers.js";
import { applyToolDeltas, resolveStandaloneTools } from "../tools.js";
import { applySpecialist, type SpecialistApplication, type SpecialistFields } from "./specialist-apply.js";
import {
  SPECIALIST_NAME_ENV,
  SPECIALIST_OFF_LIMITS_ENV,
  SPECIALIST_ALLOWED_ENV,
  encodeSpecialistOffLimitsEnv,
} from "../config/extensions.js";

export interface SpecialistChangeLine {
  field: "model" | "tools" | "instructions" | "thinkingLevel" | "mode" | "skills" | "read_only";
  from: string;
  to: string;
  /**
   * Set when the new value is resolved and recorded but does NOT reach the
   * already-running session. Pi's `AgentSession` takes its system-prompt
   * override in the constructor and exposes no setter for it
   * (`dist/core/agent-session.d.ts`), so a switch cannot re-inject
   * `instructions` into a live head — the head is frozen at boot by the
   * cache-stable head contract. Reporting the change without saying so would
   * assert an effect that never happens, which is the one thing story 7
   * ("told what actually changed... so that I can predict the effect") is
   * for. The note is rendered inline by `formatSpecialistChangeReport`.
   */
  note?: string;
}

/** Why `instructions` is reported but not applied — see `SpecialistChangeLine.note`. */
export const INSTRUCTIONS_NOT_LIVE_NOTE =
  "recorded, but NOT applied to this running session — the head is frozen at boot; it takes effect on the next session started with this specialist";

/**
 * Specialists ticket 05: why `skills` is reported but not applied. Verified by
 * reading `dist/core/agent-session.d.ts` (rule 1): `AgentSession` exposes
 * `setActiveToolsByName` (which rebuilds the prompt and re-reads skills) but
 * **no setter for the skill roster** — `resourceLoader` is readable and its
 * only mutator is `reload()`, which re-runs the entire resource pipeline
 * (extensions, packages, settings) and re-instantiates inline extension
 * factories, not a skills-scoped change. The switch therefore does not call
 * it; the new roster takes effect on the next session, exactly like
 * `instructions` (handoff 04).
 */
export const SKILLS_NOT_LIVE_NOTE =
  "recorded, but NOT applied to this running session — the loaded skills are frozen at boot and there is no skills-scoped setter on AgentSession; the new roster takes effect on the next session started with this specialist";

export interface SpecialistSwitchOk {
  ok: true;
  name: string;
  /** The fully resolved config the session would run under after the switch. */
  config: ResolvedConfig;
  /** The effective resident tool set after the switch (deltas already applied). */
  toolNames: string[];
  /** Empty when the new specialist resolves to the identical model/tools/instructions/thinkingLevel/mode already in force. */
  changed: SpecialistChangeLine[];
  notices: string[];
  offLimitToolNames: string[];
  allowedToolNames: string[];
  app: SpecialistApplication;
}

export interface SpecialistSwitchFailed {
  ok: false;
  /** `SpecialistNotFoundError`/`SpecialistValidationError`'s own message — already names what exists or what was wrong. */
  message: string;
}

export type SpecialistSwitchResult = SpecialistSwitchOk | SpecialistSwitchFailed;

export interface ResolveSpecialistSwitchOpts {
  name: string;
  cwd: string;
  globalDir: string;
  env?: NodeJS.ProcessEnv;
  /** The same caller/flag layer the session originally booted with — "a flag beats a specialist" applies to a switch exactly as it does at boot. */
  flags?: ConfigFile;
  /** The config the running session is currently under — the "before" half of the diff. */
  currentConfig: ResolvedConfig;
  /** A `--tools` caller override, if the session booted with one. `undefined` means the specialist's own `tools` (or the runtime default) decides, same precedence `boot()` applies. */
  toolsOverride?: readonly string[];
  isChild?: boolean;
  /**
   * The tool names the running session's request actually carries. A switch
   * appends, so this is the boot-time set and it does not change; it is what a
   * restriction has to be measured against. Omitted, the previous config's
   * effective set is used, which is only correct for the first switch.
   */
  sessionToolNames?: readonly string[];
  runningModel?: string;
  /**
   * P10.9 (ticket 21, D2): where `specialist_switch` fires from.
   *
   * This module is where the diff is computed, and the diff is the payload. It
   * is NOT where the switch is applied — `tui/interactive-surface.ts` owns the
   * live half — and that is a real limitation worth naming rather than hiding:
   * a resolution this function returns `ok` for is applied by its one
   * production caller, so the event is a resolution that was about to be
   * applied, not a confirmed application. A failed resolution fires nothing,
   * because the session it describes did not change.
   */
  events?: LykosEventSink;
}

function effectiveToolNames(
  config: ResolvedConfig,
  toolsOverride: readonly string[] | undefined,
  isChild: boolean,
): string[] {
  const baseTools = toolsOverride ?? config.tools;
  const resolved = resolveStandaloneTools({
    ...(baseTools !== undefined ? { tools: baseTools } : {}),
    isChild,
  });
  return applyToolDeltas(resolved, config.tools_add, config.tools_remove);
}

/**
 * Resolve the named specialist against the SAME layer stack the session
 * booted under, and describe what changed relative to `opts.currentConfig`.
 * Never throws — `SpecialistNotFoundError`/`SpecialistValidationError` (and any
 * other config-load failure) come back as `{ ok: false, message }`, which is
 * what ticket 04's "switching to a specialist that does not exist leaves the
 * session unchanged and says so" checkbox reads.
 */
export function resolveSpecialistSwitch(opts: ResolveSpecialistSwitchOpts): SpecialistSwitchResult {
  const loadOpts: LoadConfigOptions = {
    cwd: opts.cwd,
    globalDir: opts.globalDir,
    specialistName: opts.name,
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.flags !== undefined ? { flags: opts.flags } : {}),
  };
  let loaded;
  try {
    loaded = loadConfig(loadOpts);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  const config = loaded.resolved;
  const specialistVal = loaded.layers.find((l) => l.name === "specialist")?.value;
  const before = opts.currentConfig;
  const isChild = opts.isChild === true;
  const beforeTools = effectiveToolNames(before, opts.toolsOverride, isChild);
  const afterTools = effectiveToolNames(config, opts.toolsOverride, isChild);

  // The set to measure a restriction against is the one the REQUEST carries, not
  // the one the previous specialist notionally allowed. A switch appends, so the
  // request still holds every tool it booted with; computing off-limits from the
  // previous specialist's narrower set makes the second switch in a session fail
  // open — switch to a read-only reviewer, then to a writer, and `bash` is in
  // neither off-limits list while still sitting in the request.
  const requestToolNames = opts.sessionToolNames !== undefined ? [...opts.sessionToolNames] : beforeTools;

  const runningModel = opts.runningModel ?? specialistModelSpec(before);
  const specialistFields: SpecialistFields | undefined =
    specialistVal?.prompt_mode !== undefined ||
    specialistVal?.tools_mode !== undefined ||
    specialistVal?.provider !== undefined ||
    specialistVal?.model !== undefined ||
    specialistVal?.instructions !== undefined
      ? {
          // Every field comes from the SPECIALIST LAYER, never from the merged
          // config. A project's own `model:` or a --model flag would otherwise be
          // reported as the specialist's preferred model and refused adoption it
          // never asked for, and a flag overriding a specialist that does declare
          // one would suppress the notice entirely.
          ...(specialistVal?.instructions !== undefined ? { instructions: specialistVal.instructions } : {}),
          ...(specialistVal?.prompt_mode !== undefined ? { prompt_mode: specialistVal.prompt_mode } : {}),
          ...(specialistVal?.tools_mode !== undefined ? { tools_mode: specialistVal.tools_mode } : {}),
          ...(specialistVal?.provider !== undefined ? { provider: specialistVal.provider } : {}),
          ...(specialistVal?.model !== undefined ? { model: specialistVal.model } : {}),
        }
      : undefined;

  const app = applySpecialist({
    name: opts.name,
    context: "switch",
    ...(specialistFields !== undefined ? { specialist: specialistFields } : {}),
    ...(runningModel !== undefined ? { parentModel: runningModel } : {}),
    defaultToolNames: requestToolNames,
    specialistToolNames: afterTools,
  });

  const changed: SpecialistChangeLine[] = [];

  const beforeModel = specialistModelSpec(before) ?? "(unset)";
  const afterModel = specialistModelSpec(config) ?? "(unset)";
  if (beforeModel !== afterModel) changed.push({ field: "model", from: beforeModel, to: afterModel });

  if (beforeTools.join(",") !== afterTools.join(",")) {
    changed.push({
      field: "tools",
      from: beforeTools.length > 0 ? beforeTools.join(", ") : "(none)",
      to: afterTools.length > 0 ? afterTools.join(", ") : "(none)",
    });
  }

  const beforeInstr = before.instructions ?? "";
  const afterInstr = config.instructions ?? "";
  if (beforeInstr !== afterInstr) {
    changed.push({
      field: "instructions",
      from: beforeInstr.length > 0 ? `set (${beforeInstr.length} chars)` : "(none)",
      to: afterInstr.length > 0 ? `set (${afterInstr.length} chars)` : "(none)",
      note: INSTRUCTIONS_NOT_LIVE_NOTE,
    });
  }

  if (before.thinkingLevel !== config.thinkingLevel) {
    changed.push({
      field: "thinkingLevel",
      from: before.thinkingLevel ?? "(unset)",
      to: config.thinkingLevel ?? "(unset)",
    });
  }

  const beforeReadOnly = Boolean(before.readOnly);
  const afterReadOnly = Boolean(config.readOnly);
  if (beforeReadOnly !== afterReadOnly) {
    changed.push({
      field: "read_only",
      from: String(beforeReadOnly),
      to: String(afterReadOnly),
    });
  }

  // Specialists ticket 05: the skill roster. A roster is an unordered list of
  // names, so it is compared as a sorted set — two specialists naming the same
  // skills in a different order resolve to the identical loaded set and must
  // NOT be reported as changed.
  const beforeSkills = before.skills.roster;
  const afterSkills = config.skills.roster;
  const beforeSkillsKey = beforeSkills === undefined ? "(unset)" : [...beforeSkills].sort().join(",");
  const afterSkillsKey = afterSkills === undefined ? "(unset)" : [...afterSkills].sort().join(",");
  if (beforeSkillsKey !== afterSkillsKey) {
    changed.push({
      field: "skills",
      from: beforeSkillsKey,
      to: afterSkillsKey,
      note: SKILLS_NOT_LIVE_NOTE,
    });
  }

  const notices: string[] = [...app.notices];

  if (app.offLimitToolNames.length > 0) {
    notices.push(`tools now off limits: ${app.offLimitToolNames.join(", ")}`);
  }

  if (app.model !== undefined && app.model !== runningModel) {
    notices.push(
      `preferred model "${app.model}" was not adopted — this session keeps the model it is running` +
        (runningModel !== undefined ? ` ("${runningModel}")` : "") +
        `. A switch never changes what you pay per token; /clear adopts the specialist wholly.`,
    );
  }

  const allowedToolNames = app.tools.filter((t) => t.disposition === "resident").map((t) => t.name);

  (opts.events ?? NULL_EVENT_SINK).emit("specialist_switch", {
    name: opts.name,
    changed: changed.map((c) => ({ field: c.field, from: c.from, to: c.to })),
    toolNames: afterTools,
    notices,
  });

  return {
    ok: true,
    name: opts.name,
    config,
    toolNames: afterTools,
    changed,
    notices,
    offLimitToolNames: app.offLimitToolNames,
    allowedToolNames,
    app,
  };
}

/**
 * Ticket 04 checkbox: "after a switch, the interface states which settings
 * changed and to what." `instructions` is reported as a length, never its
 * text — the value can be arbitrarily long and the point is "it moved," not
 * a diff of prose.
 */
export function formatSpecialistChangeReport(name: string, changed: readonly SpecialistChangeLine[], notices: readonly string[] = []): string {
  if (changed.length === 0 && notices.length === 0) {
    return `lykos: specialist is now "${name}" — nothing about the running session's model, tools, instructions, thinking level, mode or skills actually differs from before`;
  }
  const lines = changed.map((c) =>
    c.note !== undefined
      ? `  ${c.field}: ${c.from} -> ${c.to}
    (${c.note})`
      : `  ${c.field}: ${c.from} -> ${c.to}`,
  );
  const header =
    changed.length > 0
      ? `lykos: specialist is now "${name}" — changed (the prompt prefix and tool list are untouched; ADR-0021):`
      : `lykos: specialist is now "${name}":`;
  const out = [header, ...lines];
  if (notices.length > 0) {
    for (const notice of notices) out.push(`  notice: ${notice}`);
  }
  return out.join("\n");
}

export function applySpecialistGuardEnv(
  name: string,
  offLimitToolNames: readonly string[],
  allowedToolNames: readonly string[],
): void {
  if (offLimitToolNames.length > 0) {
    process.env[SPECIALIST_NAME_ENV] = name;
    process.env[SPECIALIST_OFF_LIMITS_ENV] = encodeSpecialistOffLimitsEnv(offLimitToolNames);
    process.env[SPECIALIST_ALLOWED_ENV] = encodeSpecialistOffLimitsEnv(allowedToolNames);
  } else {
    delete process.env[SPECIALIST_NAME_ENV];
    delete process.env[SPECIALIST_OFF_LIMITS_ENV];
    delete process.env[SPECIALIST_ALLOWED_ENV];
  }
}

/**
 * Ticket 04 checkbox: "a command with no argument lists every available
 * specialist with its one-line description and marks the active one."
 */
export function formatSpecialistList(locations: readonly SpecialistLocation[], active: string | undefined): string {
  if (locations.length === 0) {
    return "lykos: no specialists discovered — add one at .lykos/specialists/<name>.yaml (project) or <globalDir>/specialists/<name>.yaml (global)";
  }
  const lines = locations.map((p) => {
    const marker = p.name === active ? "* " : "  ";
    const desc = p.description ? ` — ${p.description}` : "";
    return `${marker}${p.name}${desc}`;
  });
  return ["lykos: available specialists (* = active)", ...lines].join("\n");
}

/** The names Tab-completion should offer for `/specialist <name>` — reads the same discovery ticket 01 built (plus the shipped library, ticket 07), never a second directory scan. */
export function specialistNamesFor(cwd: string, globalDir: string, shippedDir: string = shippedSpecialistsDir()): string[] {
  return discoverSpecialists(cwd, globalDir, shippedDir).map((p) => p.name);
}
