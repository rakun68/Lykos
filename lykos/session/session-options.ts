/**
 * P5 #41: what a client's pickers list for one live session. The models with a credential, the effort levels this
 * model takes, the primary specialists, and each provider's reach, read when asked so a credential added or a
 * specialist file written since boot shows up. Choosing one is the slash command the session already runs
 * (`/model`, `/effort`, `/specialist`, `/login`), so it takes effect on the next request as typing it does.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProvidersConfig } from "../config/types.js";
import { DEFAULT_SPECIALIST, discoverSpecialists, primarySpecialists } from "../config/specialists.js";
import { providerMatrix, type ProviderReach } from "../config/providers.js";
import { defaultCredentialDbPath } from "../credentials/db.js";
import { poolSummary, summaryPoolSizes } from "../credentials/presence.js";
import { EFFORT_LEVELS } from "../tui/effort.js";

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  contextWindow: number | null;
  reasoning: boolean;
}

export interface SpecialistOption {
  name: string;
  description: string;
}

export interface ProviderOption {
  name: string;
  /** "oauth_subscription", "api_key" and so on: how `/login` signs in to it. */
  auth: string;
  reach: ProviderReach;
  /** How reach was decided; never a credential. */
  reason: string;
}

export interface SessionOptions {
  /** `provider/id`. */
  model: string;
  models: ModelOption[];
  /** null: this model has no effort control. */
  effort: string | null;
  efforts: string[];
  specialist: string;
  specialists: SpecialistOption[];
  providers: ProviderOption[];
}

/** The parts of the live session the options read. */
export interface OptionsSession {
  readonly model?: { provider: string; id: string } | undefined;
  readonly thinkingLevel?: string;
  getAvailableThinkingLevels?(): string[];
  supportsThinking?(): boolean;
}

export function sessionOptions(input: {
  cwd: string;
  globalDir: string;
  session: OptionsSession;
  modelSpec: string;
  modelRuntime: Pick<ModelRuntime, "getAvailableSnapshot">;
  specialist: string | undefined;
  providers: ProvidersConfig;
  env?: NodeJS.ProcessEnv;
}): SessionOptions {
  const { session } = input;
  const env = input.env ?? process.env;
  const model = session.model ? `${session.model.provider}/${session.model.id}` : input.modelSpec;
  const thinks = session.supportsThinking?.() !== false;
  const described = new Map(discoverSpecialists(input.cwd, input.globalDir).map((s) => [s.name, s.description ?? ""]));
  const poolSizes = summaryPoolSizes(poolSummary(defaultCredentialDbPath(env)));
  return {
    model,
    models: input.modelRuntime.getAvailableSnapshot().map((m) => ({
      provider: m.provider,
      id: m.id,
      name: m.name,
      contextWindow: typeof m.contextWindow === "number" && m.contextWindow > 0 ? m.contextWindow : null,
      reasoning: m.reasoning === true,
    })),
    effort: thinks ? (session.thinkingLevel ?? null) : null,
    efforts: thinks ? (session.getAvailableThinkingLevels?.() ?? [...EFFORT_LEVELS]) : [],
    specialist: input.specialist ?? DEFAULT_SPECIALIST,
    specialists: primarySpecialists(input.cwd, input.globalDir).map((name) => ({ name, description: described.get(name) ?? "" })),
    providers: providerMatrix(input.providers, { env, poolSizes }).map((r) => ({ name: r.name, auth: r.auth, reach: r.reach, reason: r.reachReason })),
  };
}
