// What a client lists before any session runs: which providers sign in with a browser and which take an API key, and
// every model a provider's endpoint offers. The runtime is the one a session builds from the same config
// (`delegate/ocr.ts`'s default), so a model listed here is one a session can switch to.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/load.js";
import { builtinProviderDecls, cacheModelsPath, generateProviderConfig } from "../config/providers.js";
import type { ProvidersConfig } from "../config/types.js";
import { EFFORT_LEVELS } from "../surface/effort.js";
import { createLykosModelRuntime } from "./model-runtime.js";

/** How a provider takes a credential. */
export interface LoginKinds {
  oauth: boolean;
  apiKey: boolean;
}

/** One model a provider offers. */
export interface ProviderModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number | null;
  /** The effort levels the model takes, lowest first; `["off"]` when it does not reason. */
  efforts: string[];
  /** A session can switch to it: the runtime knows it. One only the endpoint lists is added to the declaration when shown. */
  listed: boolean;
}

type PiModel = ReturnType<ModelRuntime["getModels"]>[number];

/** The runtime a session in `cwd` would build, with Lykos's credential store. */
export async function catalogRuntime(cwd: string, providers: ProvidersConfig): Promise<ModelRuntime> {
  const generated = generateProviderConfig({ providers, builtins: builtinProviderDecls(), targetPath: cacheModelsPath(cwd) });
  if (generated.errors.length > 0) throw new Error(generated.errors.join("; "));
  return createLykosModelRuntime({ ...(generated.written ? { modelsPath: generated.targetPath } : {}), providerConfig: providers });
}

/**
 * Reads the config's providers again into a running session's runtime: a provider or model added since the session
 * started (`/connect`, a model picked from an endpoint, an edited config) is then one it can switch to. The runtime
 * reads the same generated file a session in `cwd` boots from; no endpoint is asked.
 */
export async function reloadProviders(runtime: ModelRuntime, cwd: string, globalDir?: string): Promise<void> {
  const { resolved } = loadConfig({ cwd, ...(globalDir !== undefined ? { globalDir } : {}) });
  const generated = generateProviderConfig({ providers: resolved.providers, builtins: builtinProviderDecls(), targetPath: cacheModelsPath(cwd) });
  if (generated.errors.length > 0) throw new Error(generated.errors.join("; "));
  await runtime.refresh({ allowNetwork: false });
}

/** Every provider the runtime knows, by how it signs in. */
export function loginKinds(runtime: ModelRuntime): Map<string, LoginKinds> {
  return new Map(runtime.getProviders().map((p) => [p.id, { oauth: p.auth.oauth?.login !== undefined, apiKey: p.auth.apiKey !== undefined }]));
}

/** Pi's `getSupportedThinkingLevels`, which Pi's package does not export: a level mapped to null is not offered, and xhigh and max only when mapped. */
export function effortsOf(model: { reasoning?: boolean; thinkingLevelMap?: Partial<Record<string, string | null>> }): string[] {
  if (model.reasoning !== true) return ["off"];
  return EFFORT_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function fromPi(m: PiModel): ProviderModel {
  return {
    id: m.id,
    name: m.name || m.id,
    reasoning: m.reasoning === true,
    contextWindow: typeof m.contextWindow === "number" && m.contextWindow > 0 ? m.contextWindow : null,
    efforts: effortsOf(m),
    listed: true,
  };
}

/** The ids an endpoint's model list names: OpenAI's and Anthropic's `data[].id`, Google's `models[].name`. */
export function endpointModelIds(body: unknown): { id: string; name?: string }[] {
  if (typeof body !== "object" || body === null) return [];
  const b = body as { data?: unknown; models?: unknown };
  const rows = Array.isArray(b.data) ? b.data : Array.isArray(b.models) ? b.models : [];
  const out: { id: string; name?: string }[] = [];
  for (const r of rows) {
    if (typeof r !== "object" || r === null) continue;
    const row = r as { id?: unknown; name?: unknown; display_name?: unknown; displayName?: unknown };
    const id = typeof row.id === "string" ? row.id : typeof row.name === "string" ? row.name.replace(/^models\//, "") : undefined;
    if (id === undefined || id === "") continue;
    const name = typeof row.display_name === "string" ? row.display_name : typeof row.displayName === "string" ? row.displayName : undefined;
    out.push(name !== undefined ? { id, name } : { id });
  }
  return out;
}

/** The headers a provider's API kind sends its key in. */
function authHeaders(api: string | undefined, key: string): Record<string, string> {
  if (api === "anthropic-messages") return { "x-api-key": key, "anthropic-version": "2023-06-01" };
  if (api === "google-generative-ai") return { "x-goog-api-key": key };
  return { authorization: `Bearer ${key}` };
}

/**
 * Every model `provider` offers. A provider declared with a base URL is asked (`GET {baseUrl}/models`), its declared
 * models first; any other is the runtime's catalog for it. A provider with neither has no endpoint to ask.
 */
export async function providerModels(
  runtime: ModelRuntime,
  providers: ProvidersConfig,
  provider: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderModel[]> {
  const decl = providers[provider];
  const known = runtime.getModels(provider).map(fromPi);
  if (decl?.baseUrl === undefined) {
    if (runtime.getProvider(provider) === undefined) {
      throw new Error(`${provider} has no endpoint: add it as a custom provider with its base URL`);
    }
    return known;
  }
  const auth = await runtime.getAuth(provider).catch(() => undefined);
  const key = auth?.auth.apiKey;
  const url = `${decl.baseUrl.replace(/\/+$/, "")}/models`;
  let listed: { id: string; name?: string }[];
  try {
    const extra = Object.entries(auth?.auth.headers ?? {}).filter((e): e is [string, string] => typeof e[1] === "string");
    const headers = { ...Object.fromEntries(extra), ...(key !== undefined ? authHeaders(decl.api, key) : {}) };
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    listed = endpointModelIds(await res.json());
  } catch (err) {
    // The declared models still list when the endpoint cannot be asked; nothing else is known.
    if (known.length > 0) return known;
    throw new Error(`${provider}'s model list: ${err instanceof Error ? err.message : String(err)}`);
  }
  const seen = new Set(known.map((m) => m.id));
  const asked = listed
    .filter((m) => !seen.has(m.id))
    .map((m) => ({ id: m.id, name: m.name ?? m.id, reasoning: false, contextWindow: null, efforts: ["off"], listed: false }));
  return [...known, ...asked];
}
