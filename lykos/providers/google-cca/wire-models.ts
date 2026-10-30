// Per-model wire metadata for the Cloud Code Assist stream.
//
// For the two providers whose ids the built-in provider table (`BUILTIN_PROVIDERS`) lists. The model *ids* registered with
// Pi come only from that table; this file only says how an id is sent on the
// wire: the upstream wire id (`requestModelId`, and `thinking.effortRouting`
// per effort), whether thinking is a token budget or a Gemini 3 level, and the
// compat flags the request builder reads. A model absent here is sent under
// its own id with budget thinking.
//
// ANTIGRAVITY_MODEL_WIRE_PROFILES holds the fixed maxOutputTokens and the
// opaque `labels.model_enum` per wire id.

import type { GoogleCcaProviderId } from "./types.js";

export type Effort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface WireThinking {
  mode: "budget" | "google-level";
  efforts: readonly Effort[];
  effortBudgets?: Partial<Record<Effort, number>>;
  effortRouting?: Partial<Record<Effort | "off", string>>;
  suppressWhenOff?: boolean;
  requiresEffort?: boolean;
}

export interface WireCompat {
  supportsFunctionPartId?: boolean;
  requiresSkipThoughtSignatureOnFirstFunctionCall?: boolean;
  dropUnsignedThinking?: boolean;
  ccaLegacyParametersSchema?: boolean;
  multimodalFunctionResponse?: boolean;
  claudeThinkingBetaHeader?: boolean;
  antigravityClaudeToolMode?: boolean;
  antigravityUsageLabel?: string;
}

export interface WireModel {
  requestModelId?: string;
  /** "anthropic" selects the Claude-on-CCA paths. */
  identity: string;
  thinking?: WireThinking;
  compat: WireCompat;
}

export const WIRE_MODELS: Readonly<Record<GoogleCcaProviderId, Readonly<Record<string, WireModel>>>> = {
  "google-antigravity": {
    "claude-opus-4-5": {"requestModelId":"claude-opus-4-5-thinking","identity":"anthropic","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"],"effortRouting":{"off":"claude-opus-4-5","minimal":"claude-opus-4-5-thinking","low":"claude-opus-4-5-thinking","medium":"claude-opus-4-5-thinking","high":"claude-opus-4-5-thinking"}},"compat":{"supportsFunctionPartId":true,"dropUnsignedThinking":true,"ccaLegacyParametersSchema":true,"claudeThinkingBetaHeader":true,"antigravityClaudeToolMode":true,"antigravityUsageLabel":"true"}},
    "claude-opus-4-6": {"requestModelId":"claude-opus-4-6-thinking","identity":"anthropic","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"]},"compat":{"supportsFunctionPartId":true,"dropUnsignedThinking":true,"ccaLegacyParametersSchema":true,"claudeThinkingBetaHeader":true,"antigravityClaudeToolMode":true,"antigravityUsageLabel":"true"}},
    "claude-sonnet-4-5": {"requestModelId":"claude-sonnet-4-5","identity":"anthropic","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"],"effortRouting":{"off":"claude-sonnet-4-5","minimal":"claude-sonnet-4-5-thinking","low":"claude-sonnet-4-5-thinking","medium":"claude-sonnet-4-5-thinking","high":"claude-sonnet-4-5-thinking"}},"compat":{"supportsFunctionPartId":true,"dropUnsignedThinking":true,"ccaLegacyParametersSchema":true,"claudeThinkingBetaHeader":true,"antigravityClaudeToolMode":true,"antigravityUsageLabel":"true"}},
    "claude-sonnet-4-6": {"identity":"anthropic","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"]},"compat":{"supportsFunctionPartId":true,"dropUnsignedThinking":true,"ccaLegacyParametersSchema":true,"claudeThinkingBetaHeader":true,"antigravityClaudeToolMode":true,"antigravityUsageLabel":"true"}},
    "gemini-2.5-flash": {"identity":"gemini","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"],"effortRouting":{"off":"gemini-2.5-flash","minimal":"gemini-2.5-flash-thinking","low":"gemini-2.5-flash-thinking","medium":"gemini-2.5-flash-thinking","high":"gemini-2.5-flash-thinking"}},"compat":{}},
    "gemini-2.5-flash-lite": {"identity":"gemini","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"]},"compat":{}},
    "gemini-2.5-pro": {"identity":"gemini","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"],"requiresEffort":true},"compat":{}},
    "gemini-3-flash": {"requestModelId":"gemini-3.5-flash-extra-low","identity":"gemini","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"],"effortBudgets":{"minimal":1000,"low":1000,"medium":4000,"high":10000},"effortRouting":{"off":"gemini-3.5-flash-extra-low","minimal":"gemini-3.5-flash-extra-low","low":"gemini-3.5-flash-extra-low","medium":"gemini-3.5-flash-low","high":"gemini-3-flash-agent"},"suppressWhenOff":true,"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gemini-3-pro": {"requestModelId":"gemini-3-pro-low","identity":"gemini","thinking":{"mode":"google-level","efforts":["low","high"],"effortRouting":{"off":"gemini-3-pro-low","low":"gemini-3-pro-low","high":"gemini-3-pro-high"},"suppressWhenOff":true,"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gemini-3.1-flash-image": {"identity":"gemini","compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gemini-3.1-flash-lite": {"identity":"gemini","thinking":{"mode":"google-level","efforts":["minimal","low","medium","high"],"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gemini-3.1-pro": {"requestModelId":"gemini-3.1-pro-low","identity":"gemini","thinking":{"mode":"budget","efforts":["low","high"],"effortBudgets":{"low":1001,"high":10001},"effortRouting":{"off":"gemini-3.1-pro-low","low":"gemini-3.1-pro-low","high":"gemini-pro-agent"},"suppressWhenOff":true,"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gemini-3.5-flash": {"requestModelId":"gemini-3.5-flash-extra-low","identity":"gemini","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"],"effortBudgets":{"minimal":1000,"low":1000,"medium":4000,"high":10000},"effortRouting":{"off":"gemini-3.5-flash-extra-low","minimal":"gemini-3.5-flash-extra-low","low":"gemini-3.5-flash-extra-low","medium":"gemini-3.5-flash-low","high":"gemini-3-flash-agent"},"suppressWhenOff":true,"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gemini-3.6-flash": {"requestModelId":"gemini-3.6-flash-low","identity":"gemini","thinking":{"mode":"google-level","efforts":["minimal","low","medium","high"],"effortRouting":{"minimal":"gemini-3.6-flash-low","low":"gemini-3.6-flash-low","medium":"gemini-3.6-flash-medium","high":"gemini-3.6-flash-high"},"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gemini-3.7-flash": {"requestModelId":"gemini-3.7-flash-low","identity":"gemini","thinking":{"mode":"google-level","efforts":["minimal","low","medium","high"],"effortRouting":{"minimal":"gemini-3.7-flash-low","low":"gemini-3.7-flash-low","medium":"gemini-3.7-flash-medium","high":"gemini-3.7-flash-high"},"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gemini-3.8-flash": {"requestModelId":"gemini-3.8-flash-low","identity":"gemini","thinking":{"mode":"google-level","efforts":["minimal","low","medium","high"],"effortRouting":{"minimal":"gemini-3.8-flash-low","low":"gemini-3.8-flash-low","medium":"gemini-3.8-flash-medium","high":"gemini-3.8-flash-high"},"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gpt-oss-120b": {"requestModelId":"gpt-oss-120b-medium","identity":"gpt-oss","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"]},"compat":{}},
    "tab_flash_lite_preview": {"identity":"unknown","compat":{}},
    "tab_jump_flash_lite_preview": {"identity":"unknown","compat":{}},
  },
  "google-gemini-cli": {
    "gemini-2.0-flash": {"identity":"gemini","compat":{}},
    "gemini-2.5-flash": {"identity":"gemini","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"],"effortRouting":{"off":"gemini-2.5-flash","minimal":"gemini-2.5-flash-thinking","low":"gemini-2.5-flash-thinking","medium":"gemini-2.5-flash-thinking","high":"gemini-2.5-flash-thinking"}},"compat":{}},
    "gemini-2.5-pro": {"identity":"gemini","thinking":{"mode":"budget","efforts":["minimal","low","medium","high"],"requiresEffort":true},"compat":{}},
    "gemini-3-flash-preview": {"identity":"gemini","thinking":{"mode":"google-level","efforts":["minimal","low","medium","high"],"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gemini-3-pro-preview": {"identity":"gemini","thinking":{"mode":"google-level","efforts":["low","high"],"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gemini-3.1-flash-lite-preview": {"identity":"gemini","thinking":{"mode":"google-level","efforts":["minimal","low","medium","high"],"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
    "gemini-3.1-pro-preview": {"identity":"gemini","thinking":{"mode":"google-level","efforts":["low","high"],"requiresEffort":true},"compat":{"requiresSkipThoughtSignatureOnFirstFunctionCall":true,"multimodalFunctionResponse":true}},
  },
};

export interface AntigravityWireProfile {
  modelEnum?: string;
  maxOutputTokens: number;
}

export const ANTIGRAVITY_MODEL_WIRE_PROFILES: Readonly<Record<string, AntigravityWireProfile>> = {
  "gemini-3.5-flash-extra-low": { modelEnum: "MODEL_PLACEHOLDER_M187", maxOutputTokens: 65536 },
  "gemini-3.5-flash-low": { modelEnum: "MODEL_PLACEHOLDER_M20", maxOutputTokens: 65536 },
  "gemini-3-flash-agent": { modelEnum: "MODEL_PLACEHOLDER_M132", maxOutputTokens: 65536 },
  "gemini-3.1-pro-low": { modelEnum: "MODEL_PLACEHOLDER_M36", maxOutputTokens: 65535 },
  "gemini-pro-agent": { modelEnum: "MODEL_PLACEHOLDER_M16", maxOutputTokens: 65535 },
  "claude-sonnet-4-6": { maxOutputTokens: 64000 },
  "claude-opus-4-6-thinking": { maxOutputTokens: 64000 },
};

export function wireModel(provider: string, modelId: string): WireModel | undefined {
  const table = WIRE_MODELS[provider as GoogleCcaProviderId];
  return table === undefined ? undefined : table[modelId];
}
