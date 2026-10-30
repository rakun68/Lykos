// Usage provider registry.

import { claudeUsageProvider } from "./claude.js";
import { codexUsageProvider } from "./codex.js";
import type { UsageProvider } from "./types.js";

const providers = new Map<string, UsageProvider>([
  ["anthropic", claudeUsageProvider],
  ["openai-codex", codexUsageProvider],
]);

/** The usage provider for `anthropic` and `openai-codex`; undefined for every other provider. */
export function usageProviderFor(providerId: string): UsageProvider | undefined {
  return providers.get(providerId);
}

export type { UsageFetchInput, UsageProvider, UsageReport, UsageWindow } from "./types.js";
