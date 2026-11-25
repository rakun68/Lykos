// The effort levels a declared model offers, and their translation to and from Pi's thinking ladder.
//
// Pi's ladder is `off, minimal, low, medium, high, xhigh, max`, and a model's `thinkingLevelMap` says what each level
// sends. A config `efforts:` list is Lykos's vocabulary over the same seven slots:
//
// - `auto` is Pi's `off` mapped to "auto". The request then carries no effort at all, so the endpoint decides. Pi
//   would send `effort: "auto"`, and `withoutAutoEffort` strips it at the request boundary.
// - `none` is Pi's `minimal` mapped to "none". The request asks for no reasoning.
// - `low` through `max` are Pi's own.
//
// A model declared with no `reasoning` and no `efforts` offers every one of them: Lykos cannot tell from an id what a
// gateway's model takes, and the person can narrow the list in config.

/** The levels a config `efforts:` list may name, in ladder order. */
export const MODEL_EFFORTS = ["auto", "none", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelEffort = (typeof MODEL_EFFORTS)[number];

/** What a declared model with no `reasoning` and no `efforts` offers. */
export const DEFAULT_MODEL_EFFORTS: readonly ModelEffort[] = MODEL_EFFORTS;

export type ThinkingLevelMap = Partial<Record<string, string | null>>;

/** True when `value` names a level a config `efforts:` list may hold. */
export function isModelEffort(value: unknown): value is ModelEffort {
  return typeof value === "string" && (MODEL_EFFORTS as readonly string[]).includes(value);
}

/** Pi's `thinkingLevelMap` for a model offering `efforts`: a level left out is mapped to null, which Pi does not offer. */
export function thinkingLevelMapOf(efforts: readonly ModelEffort[]): ThinkingLevelMap {
  const has = (e: ModelEffort): boolean => efforts.includes(e);
  const map: ThinkingLevelMap = {
    off: has("auto") ? "auto" : null,
    minimal: has("none") ? "none" : null,
  };
  for (const level of ["low", "medium", "high"] as const) if (!has(level)) map[level] = null;
  // Pi offers xhigh and max only when they are mapped.
  for (const level of ["xhigh", "max"] as const) if (has(level)) map[level] = level;
  return map;
}

interface Mapped {
  readonly thinkingLevelMap?: ThinkingLevelMap | undefined;
}

/** The name a person sees for Pi's `level` on `model`. */
export function effortLabel(model: Mapped | undefined, level: string): string {
  const map = model?.thinkingLevelMap;
  if (level === "off" && map?.off === "auto") return "auto";
  if (level === "minimal" && map?.minimal === "none") return "none";
  return level;
}

/** Pi's level for the name `label` a person picked on `model`. */
export function effortLevel(model: Mapped | undefined, label: string): string {
  const map = model?.thinkingLevelMap;
  if (label === "auto" && map?.off === "auto") return "off";
  if (label === "none" && map?.minimal === "none") return "minimal";
  return label;
}

/**
 * The request `payload` without an effort, when `model` is on `auto` (Pi's `off` mapped to "auto"); undefined when
 * there is nothing to take out. It covers the shapes Pi's APIs send: `reasoning: { effort }` (OpenAI Responses,
 * OpenRouter), `reasoning_effort` (Chat Completions) and Anthropic's `thinking: { type: "disabled" }`.
 */
export function withoutAutoEffort(payload: unknown, model: Mapped | undefined, level: string | undefined): unknown {
  if (model?.thinkingLevelMap?.off !== "auto" || level !== "off") return undefined;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const next: Record<string, unknown> = { ...(payload as Record<string, unknown>) };
  let changed = false;
  const reasoning = next.reasoning;
  if (typeof reasoning === "object" && reasoning !== null && (reasoning as { effort?: unknown }).effort === "auto") {
    delete next.reasoning;
    if (Array.isArray(next.include)) {
      const include = next.include.filter((i) => i !== "reasoning.encrypted_content");
      if (include.length > 0) next.include = include;
      else delete next.include;
    }
    changed = true;
  }
  if (next.reasoning_effort === "auto") {
    delete next.reasoning_effort;
    changed = true;
  }
  const thinking = next.thinking;
  if (typeof thinking === "object" && thinking !== null && (thinking as { type?: unknown }).type === "disabled") {
    delete next.thinking;
    changed = true;
  }
  return changed ? next : undefined;
}
