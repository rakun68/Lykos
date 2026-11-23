// Which web search providers there are, and the endpoint and key variable each implies. A leaf: config validation
// reads it without loading Pi through `web-search.ts`, which re-exports it.

/**
 * The request and response shapes this tool knows how to build and read.
 *
 * A NAME, not a client: everything provider-specific is the two functions
 * below, and the endpoint and the key variable come from configuration, so a
 * second provider is a second small adapter here plus three lines of YAML —
 * never a dependency.
 */
export const KNOWN_SEARCH_PROVIDERS = ["auto", "brave", "perplexity", "exa", "duckduckgo"] as const;
export type KnownSearchProvider = (typeof KNOWN_SEARCH_PROVIDERS)[number];

/** Ticket 24 D1: the shipped value of `web.search.provider` — the fallback chain. */
export const AUTO_SEARCH_PROVIDER = "auto";

/** The backends a chain is made of: every known provider except `auto` itself. */
export type SearchBackend = Exclude<KnownSearchProvider, "auto">;

/** The two providers that cannot run without a key, and answer D3's sentence when named explicitly without one. */
export const KEYED_SEARCH_PROVIDERS = ["brave", "perplexity"] as const;

export function isKnownSearchProvider(name: string): name is KnownSearchProvider {
  return (KNOWN_SEARCH_PROVIDERS as readonly string[]).includes(name);
}

export function isKeyedSearchProvider(name: string): name is (typeof KEYED_SEARCH_PROVIDERS)[number] {
  return (KEYED_SEARCH_PROVIDERS as readonly string[]).includes(name);
}

/**
 * Brave's documented endpoint and key variable, as the shipped declaration
 * (D2). Read from Brave's own API documentation on 2026-09-21; nothing else
 * about Brave — no price, no quota, no term — is recorded anywhere in this
 * repository.
 */
export const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_SEARCH_KEY_ENV = "BRAVE_SEARCH_API_KEY";
/** Brave's documented authentication header. */
export const BRAVE_SEARCH_KEY_HEADER = "X-Subscription-Token";

/**
 * Perplexity's documented endpoint and key variable (Plan 17 D1).
 * Read from Perplexity's API documentation (https://docs.perplexity.ai/api-reference/search-post
 * and https://docs.perplexity.ai/getting-started/quickstart) on 2026-09-23.
 * No price, quota or terms are recorded anywhere in this repository.
 */
export const PERPLEXITY_SEARCH_ENDPOINT = "https://api.perplexity.ai/search";
export const PERPLEXITY_SEARCH_KEY_ENV = "PERPLEXITY_API_KEY";

/**
 * Ticket 24 D2: Exa's hosted MCP endpoint. It answers without a key; `exaApiKey` is added only when `EXA_API_KEY` resolves.
 */
export const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp";
/** The environment variable holding an optional Exa key. */
export const EXA_SEARCH_KEY_ENV = "EXA_API_KEY";
/** The MCP tool called, and the `tools=` value put on the URL. */
export const EXA_MCP_TOOL = "web_search_exa";
/** The `x-exa-source` value: Lykos names itself (plan D2). */
export const EXA_MCP_SOURCE = "lykos";

/**
 * Ticket 24 D3: DuckDuckGo's no-JS HTML frontend, and the referer sent with it.
 */
export const DUCKDUCKGO_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
export const DUCKDUCKGO_REFERER = "https://html.duckduckgo.com/";

export const DEFAULT_SEARCH_ENDPOINTS: Record<SearchBackend, string> = {
  brave: BRAVE_SEARCH_ENDPOINT,
  perplexity: PERPLEXITY_SEARCH_ENDPOINT,
  exa: EXA_MCP_ENDPOINT,
  duckduckgo: DUCKDUCKGO_HTML_ENDPOINT,
};

export const DEFAULT_SEARCH_KEY_ENVS: Record<SearchBackend, string> = {
  brave: BRAVE_SEARCH_KEY_ENV,
  perplexity: PERPLEXITY_SEARCH_KEY_ENV,
  exa: EXA_SEARCH_KEY_ENV,
  duckduckgo: "",
};

/**
 * The endpoint a provider name implies. `auto` has none of its own — each
 * backend in the chain uses its own documented endpoint — so it is empty.
 */
export function defaultSearchEndpoint(provider: string): string {
  if (provider === AUTO_SEARCH_PROVIDER) return "";
  if (provider === "perplexity" || provider === "exa" || provider === "duckduckgo") {
    return DEFAULT_SEARCH_ENDPOINTS[provider];
  }
  return BRAVE_SEARCH_ENDPOINT;
}

/** The key variable a provider name implies. `auto` and `duckduckgo` read none, so they are empty. */
export function defaultSearchKeyEnv(provider: string): string {
  if (provider === AUTO_SEARCH_PROVIDER) return "";
  if (provider === "perplexity" || provider === "exa" || provider === "duckduckgo") {
    return DEFAULT_SEARCH_KEY_ENVS[provider];
  }
  return BRAVE_SEARCH_KEY_ENV;
}
