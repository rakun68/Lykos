// T35 / T36 (docs/15-phase3-tasks.md, docs/13-model-access.md D3.0).
//
// T35 is declaration and translation at the boundary, not a provider layer.
// `.lykos/config.yaml` declares providers and credential *sources*; this
// module generates Pi's `models.json` from that declaration at session start
// (AGENTS.md rule 7: translate at the boundary). Pi keeps
// the transport, the OAuth flows, and credential resolution. Lykos never
// relocates, rewrites, or reads out of `~/.pi/agent/auth.json`.
//
// T36 is the other half of the same idea: a provider being reachable is not
// the same as it being priced. `resolveCallAccounting()` reads the declared
// route and whether `prices.yaml` actually verifies rates AND cache
// semantics, and returns `auth_mode` / `price_basis` for `recordCall()`.
// `unknown` and `unpriced` are legitimate values — better than a confident
// wrong one.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuthMode, PriceBasis, SessionModelSource } from "../ledger/ledger.js";
import { isPriced, providerHasVerifiedPricing } from "../ledger/prices.js";
import { BUILTIN_PROVIDERS, PI_NATIVE_PROVIDERS } from "./provider-table.js";
import type { ProviderAuth, ProviderDecl, ProviderModelDecl, ProvidersConfig } from "./types.js";

export type { SessionModelSource, ProvidersConfig };

const AUTH_VALUES = new Set<string>([
  "api_key",
  "oauth_subscription",
  "oauth",
  "vendor_cli",
  "cloud_provider",
  "gateway",
]);

/**
 * `$ENV_VAR` or `${ENV_VAR}` — the whole value is one interpolation, not a
 * mix of literal key material and a variable. `!command` is the other
 * legitimate source (Pi resolves it at request time). Anything else is
 * either a pasted credential or a shape we refuse to translate.
 */
export const ENV_SOURCE = /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?$/;

// Only providers the table adds. A Pi-native provider keeps Pi's own
// credential story: github-copilot, say, is OAuth and must stay unprobeable.
const builtinsEnvVars: Record<string, readonly string[]> = {};
for (const [id, provider] of Object.entries(BUILTIN_PROVIDERS)) {
  if (PI_NATIVE_PROVIDERS.includes(id)) continue;
  if (provider.envVars && provider.envVars.length > 0) {
    builtinsEnvVars[id] = provider.envVars;
  }
}

/**
 * Env vars Pi documents for built-in API-key providers (providers.md).
 * Doctor checks PRESENCE of these, never their values. A declared
 * `source: $OTHER` is checked instead when present.
 */
export const PROVIDER_ENV_VARS: Record<string, readonly string[]> = {
  ...builtinsEnvVars,
  anthropic: ["ANTHROPIC_API_KEY"],
  openai: ["OPENAI_API_KEY"],
  google: ["GEMINI_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY"],
  xai: ["XAI_API_KEY"],
  openrouter: ["OPENROUTER_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
  groq: ["GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEY"],
  "amazon-bedrock": ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID"],
  "google-vertex": ["GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"],
};

export interface ProviderValidation {
  errors: string[];
  warnings: string[];
}

export function isCredentialSource(value: string): boolean {
  if (value.startsWith("!")) return value.length > 1;
  return ENV_SOURCE.test(value);
}

export function validateProviders(providers: ProvidersConfig): ProviderValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const [name, decl] of Object.entries(providers)) {
    if (!decl || typeof decl !== "object") {
      errors.push(`provider ${name}: declaration is not an object`);
      continue;
    }
    if (!AUTH_VALUES.has(decl.auth)) {
      errors.push(
        `provider ${name}: auth must be api_key | oauth_subscription | vendor_cli | cloud_provider | gateway, got ${JSON.stringify(decl.auth)}`,
      );
    }
    if (decl.source !== undefined) {
      if (typeof decl.source !== "string" || decl.source.length === 0) {
        errors.push(`provider ${name}: source must be a non-empty string`);
      } else if (!isCredentialSource(decl.source)) {
        errors.push(
          `provider ${name}: source must be $ENV_VAR or !command, never a literal credential (got a value that is neither)`,
        );
      }
    }
    if (decl.fallbackToApiKey !== undefined && typeof decl.fallbackToApiKey !== "boolean") {
      errors.push(`provider ${name}: fallbackToApiKey must be true or false, got ${JSON.stringify(decl.fallbackToApiKey)}`);
    }
    const isCustom = decl.baseUrl !== undefined || (decl.models !== undefined && decl.models.length > 0);
    if (isCustom && !decl.api) {
      errors.push(`provider ${name}: custom providers need api (openai-completions | anthropic-messages | ...)`);
    }
    if (isCustom && !decl.baseUrl) {
      errors.push(`provider ${name}: custom providers need baseUrl`);
    }
  }
  return { errors, warnings };
}

interface PiModelJson {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

interface PiProviderJson {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  authHeader?: boolean;
  headers?: Record<string, string>;
  models?: PiModelJson[];
}

function toPiProvider(decl: ProviderDecl): PiProviderJson | null {
  const out: PiProviderJson = {};
  if (decl.source !== undefined) out.apiKey = decl.source;
  if (decl.baseUrl !== undefined) out.baseUrl = decl.baseUrl;
  if (decl.api !== undefined) out.api = decl.api;
  if (decl.authHeader === true) out.authHeader = true;
  if (decl.headers !== undefined) out.headers = decl.headers;
  if (decl.models !== undefined && decl.models.length > 0) {
    out.models = decl.models.map((m) => {
      const model: PiModelJson = { id: m.id };
      if (m.name !== undefined) model.name = m.name;
      if (m.api !== undefined) model.api = m.api;
      if (m.baseUrl !== undefined) model.baseUrl = m.baseUrl;
      if (m.reasoning !== undefined) model.reasoning = m.reasoning;
      if (m.contextWindow !== undefined) model.contextWindow = m.contextWindow;
      if (m.maxTokens !== undefined) model.maxTokens = m.maxTokens;
      return model;
    });
  }
  return Object.keys(out).length === 0 ? null : out;
}

export interface GenerateProviderConfigInput {
  providers: ProvidersConfig;
  builtins?: ProvidersConfig;
  /** Absolute path of the generated models.json (Lykos-managed, never ~/.pi/agent/). */
  targetPath: string;
}

export interface GenerateProviderConfigResult {
  /** False when nothing needed translation — caller should omit modelsPath. */
  written: boolean;
  targetPath: string;
  providers: string[];
  errors: string[];
}

/**
 * Pi's streamable APIs (KnownApi in pi-ai types.d.ts line 15).
 */
export const KNOWN_STREAMABLE_APIS: ReadonlySet<string> = new Set([
  "openai-completions",
  "mistral-conversations",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-vertex",
  "pi-messages",
]);

/**
 * Turns BUILTIN_PROVIDERS into ProviderDecls for the providers Pi can use
 * and does not already ship (ticket 03 D2).
 */
export function builtinProviderDecls(): ProvidersConfig {
  const nativeSet = new Set(PI_NATIVE_PROVIDERS);
  const decls: ProvidersConfig = {};

  for (const [providerId, provider] of Object.entries(BUILTIN_PROVIDERS)) {
    if (nativeSet.has(providerId)) continue;
    if (!KNOWN_STREAMABLE_APIS.has(provider.api)) continue;

    const models: ProviderModelDecl[] = [];
    for (const m of provider.models) {
      if (m.api !== undefined && !KNOWN_STREAMABLE_APIS.has(m.api)) {
        continue;
      }
      const modelDecl: ProviderModelDecl = { id: m.id };
      if (m.name !== undefined) modelDecl.name = m.name;
      if (m.api !== undefined) modelDecl.api = m.api;
      if (m.baseUrl !== undefined) modelDecl.baseUrl = m.baseUrl;
      if (m.reasoning !== undefined) modelDecl.reasoning = m.reasoning;
      if (m.contextWindow !== undefined) modelDecl.contextWindow = m.contextWindow;
      if (m.maxTokens !== undefined) modelDecl.maxTokens = m.maxTokens;
      models.push(modelDecl);
    }

    const decl: ProviderDecl = {
      auth: "api_key",
      baseUrl: provider.baseUrl,
      api: provider.api,
      ...(provider.envVars && provider.envVars.length > 0
        ? { source: "$" + provider.envVars[0] }
        : {}),
      models,
    };

    decls[providerId] = decl;
  }

  return decls;
}

/**
 * T35.2: write Pi's `models.json` from the declared set. Only providers
 * that carry a source, a baseUrl, or models need a file; built-in
 * providers with only `auth`/`priced` are already in Pi's registry.
 *
 * Never takes an auth.json path. Never reads one. The only file it
 * touches is `targetPath`.
 */
export function generateProviderConfig(input: GenerateProviderConfigInput): GenerateProviderConfigResult {
  const effectiveProviders: ProvidersConfig = input.builtins
    ? { ...input.builtins, ...input.providers }
    : input.providers;

  const { errors } = validateProviders(effectiveProviders);
  if (errors.length > 0) {
    return { written: false, targetPath: input.targetPath, providers: [], errors };
  }

  const piProviders: Record<string, PiProviderJson> = {};
  for (const [name, decl] of Object.entries(effectiveProviders)) {
    const translated = toPiProvider(decl);
    if (translated) piProviders[name] = translated;
  }

  const names = Object.keys(piProviders);
  if (names.length === 0) {
    return { written: false, targetPath: input.targetPath, providers: [], errors: [] };
  }

  mkdirSync(dirname(input.targetPath), { recursive: true });
  writeFileSync(input.targetPath, `${JSON.stringify({ providers: piProviders }, null, 2)}\n`, "utf8");
  return { written: true, targetPath: input.targetPath, providers: names, errors: [] };
}

export function cacheModelsPath(workspace: string): string {
  return join(workspace, ".lykos", "cache", "models.json");
}

export interface ResolveBootModelInput {
  /** `--model` / MCP caller override. */
  callerModel?: string;
  /** Specialist-declared model. Nothing consumes this before Phase 8. */
  specialistModel?: string;
  defaultModel: string;
  roleModel?: string;
}

export interface ResolvedBootModel {
  spec: string;
  source: SessionModelSource;
}

/**
 * Specialists ticket 02: the Pi-compatible `provider`+`model` pair, combined
 * into the `provider/model` spec string `resolveBootModel`'s `specialistModel`
 * expects. Mirrors Pi's own preset extension, which only applies a model
 * when BOTH fields are set together (`examples/extensions/preset.ts`,
 * "Apply model if specified"); a specialist naming only one of the two is valid
 * — it simply does not produce an override here, the same way Pi's own
 * preset silently skips a half-specified model rather than erroring.
 */
export function specialistModelSpec(config: { provider?: string | undefined; model?: string | undefined }): string | undefined {
  if (config.provider && config.model) return `${config.provider}/${config.model}`;
  return undefined;
}

/**
 * T35.3: who chose the model this session boots against. Not routing —
 * reaching a provider and choosing between providers are different
 * problems, and the second is Phase 7's.
 */
export function resolveBootModel(input: ResolveBootModelInput): ResolvedBootModel {
  if (input.callerModel !== undefined && input.callerModel.length > 0) {
    return { spec: input.callerModel, source: "caller_override" };
  }
  if (input.specialistModel !== undefined && input.specialistModel.length > 0) {
    return { spec: input.specialistModel, source: "specialist" };
  }
  if (input.roleModel !== undefined && input.roleModel.length > 0) {
    return { spec: input.roleModel, source: "config_default" };
  }
  return { spec: input.defaultModel, source: "config_default" };
}

export interface CallAccounting {
  authMode: AuthMode;
  priceBasis: PriceBasis;
}

/** The type of the Lykos credential row that served a call (`credentials/pool.ts`). */
export type ServedCredentialType = "oauth" | "api_key";

/** P14.6 ticket 06 (plan D2): `oauth` -> `oauth_subscription`, `api_key` -> `api_key`. */
export function authModeForCredentialType(type: ServedCredentialType): AuthMode {
  return type === "oauth" ? "oauth_subscription" : "api_key";
}

/**
 * T36.1 / T36.2: resolve `auth_mode` and `price_basis` from the declaration
 * and from prices.yaml, never from a default that would be a guess.
 *
 * - Undeclared provider → `unknown` / `unpriced`. `api_key` was honest
 *   when DeepSeek was the only route; from T35 onward it is a guess.
 * - `priced` omitted or `priced: false`, or prices.yaml missing rates
 *   OR cache semantics → `unpriced` (tokens recorded, dollars NULL).
 *   Omitted is false: reachable is not priced (D3.0c).
 * - `oauth_subscription` records `api_list` when priced, never
 *   `plan_credit`, until a verified subscription-attributed credit pool
 *   exists. Pi's `/login` flows are honored for any provider they
 *   support; this accounting rule is measurement, not permission.
 */
export function resolveCallAccounting(
  provider: string,
  model: string,
  providers: ProvidersConfig,
  servedBy?: ServedCredentialType,
): CallAccounting {
  const decl = providers[provider];
  // P14.6 ticket 06 (plan D2): the credential that actually served the call
  // decides its route when one is known, so a cross-type fallback (ADR-0026)
  // shows as a change of auth_mode within a session. price_basis is untouched.
  const served = servedBy !== undefined ? authModeForCredentialType(servedBy) : undefined;
  if (!decl) {
    return { authMode: served ?? "unknown", priceBasis: "unpriced" };
  }
  const authMode: AuthMode = served ?? (AUTH_VALUES.has(decl.auth) ? decl.auth : "unknown");
  const verified = isPriced(provider, model);
  if (decl.priced !== true || !verified) {
    return { authMode, priceBasis: "unpriced" };
  }
  // Reserved: a verified plan-denominated credit pool would land here as
  // plan_credit. None are verified yet.
  return { authMode, priceBasis: "api_list" };
}

export type ProviderReach = "reachable" | "unreachable" | "unknown";

export interface ProviderMatrixRow {
  name: string;
  auth: ProviderAuth | "invalid";
  reach: ProviderReach;
  /** How reachability was decided — never a token fragment. */
  reachReason: string;
  priced: boolean;
  priceNote: string;
  overflowBilling?: boolean | "unset";
}

/**
 * T36.4: the doctor matrix, as a pure function. Env is checked for
 * PRESENCE only (`Boolean(env[name])`); the value is never returned.
 * `poolSizes` reflects credential presence in the Lykos store.
 */
export function providerMatrix(
  providers: ProvidersConfig,
  opts: { env?: NodeJS.ProcessEnv; poolSizes?: Map<string, number> } = {},
): ProviderMatrixRow[] {
  const env = opts.env ?? {};
  const poolSizes = opts.poolSizes;
  const rows: ProviderMatrixRow[] = [];
  for (const [name, decl] of Object.entries(providers)) {
    if (!decl || typeof decl !== "object") {
      rows.push({
        name,
        auth: "invalid",
        reach: "unknown",
        reachReason: "declaration is not an object",
        priced: false,
        priceNote: "unpriced — invalid declaration",
      });
      continue;
    }

    const auth: ProviderAuth | "invalid" = AUTH_VALUES.has(decl.auth) ? decl.auth : "invalid";
    const poolSize = poolSizes?.get(name) ?? 0;
    const { reach, reachReason } = resolveReach(name, decl, env, poolSize);
    const pricedClaim = decl.priced === true;
    // Doctor has no single model in hand; a provider is "priced" here only
    // if the claim is on AND prices.yaml has at least one verified model
    // for it. Per-call `resolveCallAccounting` still gates on the specific
    // model.
    const anyVerified = pricedClaim && providerHasVerifiedPricing(name);
    const priceNote = !pricedClaim
      ? "UNPRICED → excluded from cost claims"
      : anyVerified
        ? "priced (rates and cache semantics verified in prices.yaml)"
        : "declared priced: true but prices.yaml has no verified rates/cache semantics — will record unpriced";

    const row: ProviderMatrixRow = {
      name,
      auth,
      reach,
      reachReason,
      priced: anyVerified,
      priceNote,
    };
    if (decl.overflow_billing !== undefined) {
      row.overflowBilling = decl.overflow_billing;
    } else if (decl.auth === "oauth_subscription") {
      row.overflowBilling = "unset";
    }
    rows.push(row);
  }
  return rows;
}

export function resolveReach(
  name: string,
  decl: ProviderDecl,
  env: NodeJS.ProcessEnv,
  poolSize: number = 0,
): { reach: ProviderReach; reachReason: string } {
  if (decl.auth === "vendor_cli") {
    return { reach: "unknown", reachReason: "vendor_cli — the vendor binary authenticates itself; not probed" };
  }
  if (decl.auth === "oauth_subscription" || (decl.auth as string) === "oauth") {
    return {
      reach: poolSize > 0 ? "unknown" : "unreachable",
      reachReason: poolSize > 0
        ? `${poolSize} credential(s) in the Lykos store (contents not inspected)`
        : `no credential in the Lykos store — run \`lykos login ${name}\``,
    };
  }
  if (poolSize > 0) {
    return {
      reach: "reachable",
      reachReason: `${poolSize} credential(s) in the Lykos store`,
    };
  }
  if (decl.source?.startsWith("!")) {
    return {
      reach: "unknown",
      reachReason: "source is !command — Pi resolves at request time; Lykos does not execute it",
    };
  }
  const envNames = envNamesFor(name, decl);
  if (envNames.length > 0) {
    const present = envNames.filter((n) => Boolean(env[n]));
    if (present.length > 0) {
      return { reach: "reachable", reachReason: `${present.join(", ")} present` };
    }
    return { reach: "unreachable", reachReason: `${envNames.join(" / ")} not set` };
  }
  return {
    reach: "unknown",
    reachReason: "no source: $ENV_VAR declared and no known env var for this provider",
  };
}

export function envNamesFor(name: string, decl: ProviderDecl): string[] {
  if (decl.source && ENV_SOURCE.test(decl.source)) {
    return [decl.source.replace(/^\$\{?/, "").replace(/\}$/, "")];
  }
  return [...(PROVIDER_ENV_VARS[name] ?? [])];
}

/**
 * D5: Validate the `models.delegate` configuration setting.
 * Must be "specialist", "parent", or a valid model identifier/spec.
 */
export function validateDelegateModel(setting: unknown, providers?: ProvidersConfig): void {
  if (setting === undefined || setting === null) {
    throw new Error('lykos: models.delegate must be "specialist", "parent", or a model spec');
  }
  if (typeof setting !== "string" || setting.trim().length === 0) {
    throw new Error(`lykos: models.delegate must be "specialist", "parent", or a model spec, got ${JSON.stringify(setting)}`);
  }
  if (setting === "specialist" || setting === "parent") {
    return;
  }
  if (setting.includes("/")) {
    const slash = setting.indexOf("/");
    const provider = setting.slice(0, slash).trim();
    const model = setting.slice(slash + 1).trim();
    if (provider.length === 0 || model.length === 0) {
      throw new Error(`lykos: models.delegate "${setting}" is not a valid model spec (expected "provider/model" or model name)`);
    }
    if (providers) {
      const isConfigured = Object.prototype.hasOwnProperty.call(providers, provider);
      const isKnownBuiltin =
        Object.prototype.hasOwnProperty.call(PROVIDER_ENV_VARS, provider) || provider === "github-copilot";
      if (!isConfigured && !isKnownBuiltin) {
        const configured = Object.keys(providers).sort();
        const configuredList = configured.length > 0 ? configured.join(", ") : "(none)";
        throw new Error(
          `lykos: models.delegate provider "${provider}" is not configured — configured providers: ${configuredList}`,
        );
      }
    }
  }
}



