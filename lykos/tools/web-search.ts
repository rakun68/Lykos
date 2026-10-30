// One web query, against whichever provider configuration declares.
//
// **NO SDK, AND THAT IS THE WHOLE POINT OF D2.** The provider is reached with
// the runtime's own `fetch` against its documented REST endpoint, so swapping
// provider is an HTTP change — an endpoint and a key variable in
// `.lykos/config.yaml` — rather than a dependency change and a tool change. An
// SDK per provider would make "change the search engine" a `package.json`
// edit, a lockfile, an intake review and a release.
//
// **WHAT IS DECLARED AND WHAT IS CONFIGURED.** `web.search.provider` names
// which request shape to build, `web.search.endpoint` is the URL it is built
// against, and `web.search.key_env` names the environment variable holding the
// key. The shipped declaration is Brave's, with no key, so the shipped state is
// "declared, unconfigured". **Its endpoint, its authentication header, its
// `q`/`count` parameters and its `web.results[].title|url|description`
// response shape all come from Brave's own API documentation at
// api-dashboard.search.brave.com, read on 2026-09-21** — AGENTS.md rule 5's
// standard, applied to a provider fact rather than to a price.
//
// **Perplexity's endpoint, its Bearer authorization header, its
// `query`/`max_results`/`search_domain_filter` parameters and its
// `results[].title|url|snippet` response shape come from Perplexity's own
// documentation at https://docs.perplexity.ai/api-reference/search-post and
// https://docs.perplexity.ai/getting-started/quickstart, read on 2026-09-23.**
// Raw results are returned with no Sonar or answer synthesis; consumer Pro/Max
// login is not used because it reaches only synthesized answers (`perplexity_ask`).
// **THE KEYLESS CHAIN.**
// The shipped provider is `auto`: a configured Brave key, then a configured
// Perplexity key, then Exa's hosted MCP endpoint (keyless unless `EXA_API_KEY`
// is set), then DuckDuckGo's no-JS HTML results page. A backend that fails —
// transport error, timeout, non-2xx, challenge page, zero usable results, or a
// gate denial — hands the query to the next, and the result names the backend
// that answered. Two things are deliberately left out: a headless-browser
// fallback (browsers belong to P12) and Exa's per-result `summary` field,
// which is a model's paraphrase and so falls under "answer synthesis stays
// off" below.
//
// **No price, no rate limit and no term of service for any provider is recorded
// in this repository** — Exa's and DuckDuckGo's included — and none should be:
// those change without notice and a copy of one here would be a confident lie
// within a quarter.
//
// **AN UNCONFIGURED PROVIDER IS A TOOL RESULT, NOT AN EXCEPTION (D3).** With
// no key the tool returns ordinary text naming the configuration key and the
// environment variable that would configure it. A model handed a transport
// error learns nothing and retries; a model handed a sentence tells the human
// what to set. This is `eval`'s Python answer and `github`'s missing-`gh`
// answer, restated for a third case.
//
// **ANSWER SYNTHESIS STAYS OFF.** Nothing here asks a provider to summarise
// anything: the model does the reading, and a provider's paraphrase of a page
// is a second model's opinion arriving without a byline. Snippets the provider
// already produced are returned, because a second round trip per hit — which
// fetches every page — is waste.
//
// **THE DOMAIN LISTS ARE ENFORCED TWICE, DELIBERATELY.** They are sent as
// `site:` and `-site:` operators, which is how Brave documents narrowing a
// query, AND applied again to the results that come back. The first is what
// makes the provider return useful hits; the second is what makes the tool's
// promise true whatever a provider does with an operator it may not support.
//
// **NO TEST REACHES THE NETWORK (D9).** The fetch seam is injected and every
// test drives a stub; `SYSTEM_SEARCH_FETCHER` is the only thing in this file
// that opens a socket and no test constructs it.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOL IS ADDED (AGENTS.md rule
// 3): this tool is RESIDENT (D10), so it rides every request of every
// session.** Priced alone, and as the move it makes in the resident surface,
// in `web-search.test.ts`.

import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ApprovalDeniedError, authorizeNetworkRead, type ApprovalGate, type DenialLog } from "../gate/approval.js";
import { defaultCredentialDbPath, openCredentialDb } from "../credentials/db.js";
import { resolveKeySource } from "../credentials/resolve-key.js";
import type { StoredApiKey } from "../credentials/pool.js";

export const WEB_SEARCH_TOOL_NAME = "web_search";

/** How many hits are asked for when the call does not say. */
export const WEB_SEARCH_DEFAULT_COUNT = 10;

/**
 * The most this tool will ask for, whatever was requested.
 *
 * Brave's own documentation gives `count` a maximum of 20; a provider whose
 * ceiling is lower will clamp its own request, and one whose ceiling is higher
 * gains nothing from a result list a model has to read.
 */
export const WEB_SEARCH_MAX_COUNT = 20;

/** How much of one provider snippet is shown. A snippet nobody can read is not a snippet. */
export const WEB_SEARCH_SNIPPET_CHARS = 300;

/** How long one query may take before it is abandoned. */
export const WEB_SEARCH_TIMEOUT_MS = 20_000;

/** The configuration keys the unconfigured sentence names (D3). `config/types.ts` owns the fields; this owns the words. */
export const WEB_SEARCH_PROVIDER_KEY = "web.search.provider";
export const WEB_SEARCH_ENDPOINT_KEY = "web.search.endpoint";
export const WEB_SEARCH_KEY_ENV_KEY = "web.search.key_env";

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

function isKeyedSearchProvider(name: string): name is (typeof KEYED_SEARCH_PROVIDERS)[number] {
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

// ---------------------------------------------------------------------------
// D9: the fetch seam
// ---------------------------------------------------------------------------

export interface SearchResponseLike {
  status: number;
  text(): Promise<string>;
}

export interface SearchRequestInit {
  method?: string | undefined;
  headers: Record<string, string>;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
}

export type SearchFetcher = (url: string, init: SearchRequestInit) => Promise<SearchResponseLike>;

/** The real one, and the only thing in this module that opens a socket. */
export const SYSTEM_SEARCH_FETCHER: SearchFetcher = (url, init) =>
  fetch(url, init as RequestInit) as unknown as Promise<SearchResponseLike>;

// ---------------------------------------------------------------------------
// The query, the request, and the results
// ---------------------------------------------------------------------------

export interface SearchQuery {
  query: string;
  include: string[];
  exclude: string[];
  count: number;
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** A domain as the model gave it, reduced to the host it means: no scheme, no path, no leading dot, lower case. */
export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^\.+/, "")
    .replace(/\/.*$/, "");
}

/** Whether this result URL is on this domain, or on a subdomain of it. */
export function hostMatchesDomain(url: string, domain: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The query string as the provider receives it: what the model asked, plus the
 * `site:` and `-site:` operators for the two domain lists.
 *
 * Brave documents `site:` and the minus operator as supported query syntax.
 * The `OR` grouping used for two or more includes is the ordinary search-engine
 * spelling rather than something Brave's documentation states, which is
 * precisely why `filterHits` below applies the same lists to the results: if a
 * provider ignores the operator, the tool's promise is still kept.
 */
export function providerQueryString(q: SearchQuery): string {
  const parts = [q.query.trim()];
  if (q.include.length === 1) parts.push(`site:${q.include[0]}`);
  else if (q.include.length > 1) parts.push(`(${q.include.map((d) => `site:${d}`).join(" OR ")})`);
  for (const domain of q.exclude) parts.push(`-site:${domain}`);
  return parts.filter((p) => p !== "").join(" ");
}

/** The include list is a whitelist when it is non-empty; the exclude list always wins. */
export function filterHits(hits: readonly SearchHit[], q: SearchQuery): SearchHit[] {
  return hits.filter((hit) => {
    if (q.exclude.some((domain) => hostMatchesDomain(hit.url, domain))) return false;
    if (q.include.length > 0 && !q.include.some((domain) => hostMatchesDomain(hit.url, domain))) return false;
    return true;
  });
}

export interface ProviderRequest {
  url: string;
  method?: string | undefined;
  headers: Record<string, string>;
  body?: string | undefined;
}

/**
 * Brave's documented request: a GET to the configured endpoint with `q` and
 * `count`, the key in `X-Subscription-Token`, and nothing asking for a summary
 * — the answer-synthesis parameter is deliberately not sent.
 */
export function braveRequest(endpoint: string, apiKey: string, q: SearchQuery): ProviderRequest {
  const url = new URL(endpoint);
  url.searchParams.set("q", providerQueryString(q));
  url.searchParams.set("count", String(q.count));
  return {
    url: url.href,
    headers: {
      accept: "application/json",
      "accept-encoding": "gzip",
      [BRAVE_SEARCH_KEY_HEADER]: apiKey,
    },
  };
}

/**
 * Perplexity's documented request (Plan 17 D1): a POST to the configured endpoint with
 * `query`, `max_results`, and optional `search_domain_filter`, which the page documents only as
 * "Limit search results to specific domains (max 20)". It documents no exclusion syntax, so only
 * `include` domains are sent; `exclude` is enforced by this tool's own post-filter.
 * Read 2026-09-23 from https://docs.perplexity.ai/api-reference/search-post.
 * No Sonar, no chat, no answer or summary parameter is requested or sent.
 */
/** `search_domain_filter`'s documented maximum. */
export const PERPLEXITY_MAX_DOMAIN_FILTERS = 20;

export function perplexityRequest(endpoint: string, apiKey: string, q: SearchQuery): ProviderRequest {
  const domainFilters = q.include.slice(0, PERPLEXITY_MAX_DOMAIN_FILTERS);
  const payload: Record<string, unknown> = {
    query: q.query,
    max_results: q.count,
  };
  if (domainFilters.length > 0) {
    payload.search_domain_filter = domainFilters;
  }
  return {
    url: endpoint,
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  };
}

/**
 * Brave's documented response: `web.results[]`, each with `title`, `url` and
 * `description`.
 *
 * Deliberately forgiving about everything else. A provider that adds a field
 * must not break this, and a hit missing a description is still a hit worth
 * showing — the alternative is a tool that returns nothing because one result
 * was shaped unexpectedly.
 */
export function parseBraveResults(payload: unknown): SearchHit[] {
  const results = (payload as { web?: { results?: unknown } } | null)?.web?.results;
  if (!Array.isArray(results)) return [];
  const hits: SearchHit[] = [];
  for (const entry of results) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as { title?: unknown; url?: unknown; description?: unknown };
    const url = typeof row.url === "string" ? row.url : "";
    if (url === "") continue;
    const description = typeof row.description === "string" ? row.description : "";
    hits.push({
      title: typeof row.title === "string" && row.title !== "" ? stripTags(row.title) : url,
      url,
      snippet: stripTags(description),
    });
  }
  return hits;
}

/**
 * Perplexity's documented response (Plan 17 D1): `results[]`, each with `title`, `url`
 * and `snippet`.
 * Read 2026-09-23 from https://docs.perplexity.ai/api-reference/search-post.
 * Deliberately forgiving about unexpected shapes: missing url is dropped, missing snippet
 * becomes empty string, missing title falls back to url.
 */
export function parsePerplexityResults(payload: unknown): SearchHit[] {
  const results = (payload as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return [];
  const hits: SearchHit[] = [];
  for (const entry of results) {
    if (entry === null || typeof entry !== "object") continue;
    const row = entry as { title?: unknown; url?: unknown; snippet?: unknown };
    const url = typeof row.url === "string" ? row.url : "";
    if (url === "") continue;
    const snippet = typeof row.snippet === "string" ? row.snippet : "";
    hits.push({
      title: typeof row.title === "string" && row.title !== "" ? stripTags(row.title) : url,
      url,
      snippet: stripTags(snippet),
    });
  }
  return hits;
}

/** Providers mark matched terms with `<strong>`; the model wants the words, not the markup. */
export function stripTags(text: string): string {
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Ticket 24: why a backend failed, in one line
// ---------------------------------------------------------------------------

/**
 * Quota and auth signals in a provider's HTTP failure. Returns
 * `undefined` when the response matches none, leaving the caller its own
 * message.
 */
const CREDIT_BODY_PATTERN = /credits?\s*(?:exhausted|exceeded)|quota|insufficient/i;

export function classifyProviderHttpError(provider: string, status: number, body: string): string | undefined {
  if (CREDIT_BODY_PATTERN.test(body)) return `${provider}: credits exhausted`;
  if (status === 402) return `${provider}: 402 credits exhausted`;
  if (status === 401) return `${provider}: 401 unauthorized`;
  if (status === 403) return `${provider}: 403 forbidden`;
  return undefined;
}

/** A provider's error body, cut to something that fits on the one line D4 gives each backend. */
function oneLine(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ---------------------------------------------------------------------------
// Ticket 24 D2: Exa's hosted MCP endpoint
// ---------------------------------------------------------------------------

/**
 * The Exa arguments: the query with one `site:` per include and one `-site:`
 * per exclude (no `OR` grouping), and `numResults`. There are no
 * `after:`/`before:` terms because this tool has no date parameters. Nothing asks for a summary: the keyless MCP tool takes neither
 * `contents` nor `summary`, and none is sent.
 */
export function exaMcpArgs(q: SearchQuery): Record<string, unknown> {
  const queryParts = [q.query.trim()];
  for (const domain of q.include) queryParts.push(`site:${domain}`);
  for (const domain of q.exclude) queryParts.push(`-site:${domain}`);
  return { query: queryParts.join(" "), numResults: q.count };
}

/**
 * The Exa request:
 * `POST <endpoint>?[exaApiKey=…&]tools=web_search_exa`, a JSON-RPC 2.0
 * `tools/call` of `web_search_exa`, and its three headers — with
 * `x-exa-source` naming Lykos. `exaApiKey` is on the URL only when a key
 * resolved; without one the request carries no credential at all.
 */
export function exaMcpRequest(endpoint: string, apiKey: string, q: SearchQuery): ProviderRequest {
  const url = new URL(endpoint);
  if (apiKey !== "") url.searchParams.set("exaApiKey", apiKey);
  url.searchParams.set("tools", EXA_MCP_TOOL);
  return {
    url: url.href,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "x-exa-source": EXA_MCP_SOURCE,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Math.random().toString(36).slice(2),
      method: "tools/call",
      params: { name: EXA_MCP_TOOL, arguments: exaMcpArgs(q) },
    }),
  };
}

/**
 * The first `data: ` line that parses as JSON, else the whole body as
 * JSON, else `null`. The endpoint answers either way depending on the `Accept`
 * it is sent, which is why both are read.
 */
export function parseSSE(text: string): unknown {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) {
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const result = JSON.parse(data) as unknown;
        if (result) return result;
      } catch {
        // Non-JSON data line (keep-alive/comment) — skip and keep scanning.
      }
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface ExaResultRow {
  title?: string | null;
  url?: string | null;
  text?: string | null;
  highlights?: string[] | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

/** Whether a payload is an Exa search response. */
function isExaSearchResponse(data: unknown): data is { results?: ExaResultRow[] } {
  return (
    typeof data === "object" &&
    data !== null &&
    ("results" in data || "statuses" in data || "costDollars" in data || "searchTime" in data)
  );
}

/** The shapes Exa's deployments return, normalized. */
function normalizeExaMcpPayload(payload: unknown): unknown {
  const candidates: unknown[] = [];
  const root = asRecord(payload);
  if (root) {
    if (root.structuredContent !== undefined) candidates.push(root.structuredContent);
    if (root.data !== undefined) candidates.push(root.data);
    if (root.result !== undefined) candidates.push(root.result);
    candidates.push(root);
    const content = root.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        const part = asRecord(item);
        if (!part) continue;
        const text = part.text;
        if (typeof text !== "string" || text.trim().length === 0) continue;
        try {
          const parsed = JSON.parse(text) as unknown;
          if (parsed !== null) candidates.push(parsed);
        } catch {
          // Not JSON; the plain-text parser below gets it.
        }
      }
    }
  } else {
    candidates.push(payload);
  }
  for (const candidate of candidates) {
    if (isExaSearchResponse(candidate)) return candidate;
  }
  return payload;
}

/** One `Label: value` field of a plain-text Exa block. */
function parseExaOptionalField(section: string, label: string): string | undefined {
  const match = section.match(new RegExp(`(?:^|\\n)${label}:\\s*([^\\n]*)`));
  if (!match) return undefined;
  const value = (match[1] ?? "").trim();
  return value.length > 0 ? value : undefined;
}

function parseExaTextField(section: string): string | undefined {
  const match = section.match(/(?:^|\n)Text:\s*([\s\S]*)$/);
  if (!match) return undefined;
  const value = (match[1] ?? "").trim();
  return value.length > 0 ? value : undefined;
}

/**
 * The `Title: … / URL: … / Text: …` blocks the MCP tool returns as plain text.
 * `Author` and `Published Date` are read past, not kept: this tool returns
 * titles, URLs and snippets only.
 */
function parseExaMcpTextPayload(payload: unknown): ExaResultRow[] | null {
  const root = asRecord(payload);
  if (!root) return null;
  const content = root.content;
  if (!Array.isArray(content)) return null;
  const textBlocks = content
    .map((item) => {
      const part = asRecord(item);
      const text = typeof part?.text === "string" ? part.text : "";
      return text.replace(/\r\n?/g, "\n").trim();
    })
    .filter((text) => text.length > 0);
  if (textBlocks.length === 0) return null;
  const sections = textBlocks
    .join("\n\n")
    .split(/\n{2,}(?=Title:\s*[^\n]*(?:\n(?:URL|Author|Published Date|Text):))/)
    .map((section) => section.trim())
    .filter((section) => section.startsWith("Title:"));
  const results: ExaResultRow[] = [];
  for (const section of sections) {
    const title = parseExaOptionalField(section, "Title");
    const url = parseExaOptionalField(section, "URL");
    const text = parseExaTextField(section);
    if (!title && !url && !text) continue;
    results.push({ title: title ?? null, url: url ?? null, text: text ?? null });
  }
  return results.length > 0 ? results : null;
}

/**
 * Exa's rows as this tool's hits. The snippet is the page text Exa returned
 * (or its highlights), whitespace-collapsed and cut to
 * `WEB_SEARCH_SNIPPET_CHARS` here, so nothing longer is ever passed on (plan
 * D2). A row's `summary` is ignored on purpose: it is
 * a model's summary of the page, and this tool returns none.
 */
function exaRowsToHits(rows: readonly ExaResultRow[]): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (url === "") continue;
    const title = typeof row.title === "string" && row.title.trim() !== "" ? row.title.trim() : url;
    const raw =
      typeof row.text === "string" && row.text.trim() !== ""
        ? row.text
        : Array.isArray(row.highlights)
          ? row.highlights.filter((h) => typeof h === "string").join(" ")
          : "";
    const flat = raw.replace(/\s+/g, " ").trim();
    hits.push({ title, url, snippet: flat.slice(0, WEB_SEARCH_SNIPPET_CHARS) });
  }
  return hits;
}

export type BackendParse = { ok: true; hits: SearchHit[] } | { ok: false; reason: string };

/**
 * The body of a 2xx Exa MCP reply: SSE or JSON, a JSON-RPC `error`, a
 * tool-level `isError`, then the structured payload, then the plain-text one.
 */
export function parseExaMcpResponse(body: string): BackendParse {
  const mcpResponse = parseSSE(body) as {
    result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    error?: { code: number; message: string };
  } | null;
  if (!mcpResponse || typeof mcpResponse !== "object") return { ok: false, reason: "Failed to parse MCP response" };
  if (mcpResponse.error) return { ok: false, reason: `MCP error: ${String(mcpResponse.error.message)}` };
  if (mcpResponse.result?.isError) {
    const message = mcpResponse.result.content
      ?.find((item) => item.type === "text" && typeof item.text === "string")
      ?.text?.trim();
    return { ok: false, reason: message || "Exa MCP returned an error" };
  }
  const payload = normalizeExaMcpPayload(mcpResponse.result);
  if (isExaSearchResponse(payload)) {
    return { ok: true, hits: exaRowsToHits(Array.isArray(payload.results) ? payload.results : []) };
  }
  const parsed = parseExaMcpTextPayload(payload);
  if (parsed) return { ok: true, hits: exaRowsToHits(parsed) };
  return { ok: false, reason: "Exa MCP search returned unexpected response shape." };
}

export const EXA_RATE_LIMIT_MESSAGE = "exa: MCP rate limit reached (429); configure an Exa API key for higher limits";

/** A non-2xx Exa MCP reply: quota/auth, then 429, then the status and body. */
export function exaHttpFailure(status: number, body: string): string {
  const classified = classifyProviderHttpError("exa", status, body);
  if (classified !== undefined) return classified;
  if (status === 429) return EXA_RATE_LIMIT_MESSAGE;
  return `Exa MCP request failed (${status}): ${oneLine(body)}`;
}

// ---------------------------------------------------------------------------
// Ticket 24 D3: DuckDuckGo's HTML results page, plain HTTP only
// ---------------------------------------------------------------------------

/**
 * A fixed desktop Chrome navigation header set.
 */
export const BROWSER_NAVIGATION_HEADERS: Readonly<Record<string, string>> = {
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "max-age=0",
  Priority: "u=0, i",
  "Sec-Ch-Ua": '"Google Chrome";v="149", "Chromium";v="149", ";Not A Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"macOS"',
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

/**
 * Recency to DuckDuckGo's `df` value. The tool's schema has no recency parameter (adding one would move the resident
 * schema tax), so `web_search` never sets `df`; the map is kept so a later
 * recency parameter is one argument.
 */
export const DUCKDUCKGO_RECENCY_DF = { day: "d", week: "w", month: "m", year: "y" } as const;
export type SearchRecency = keyof typeof DUCKDUCKGO_RECENCY_DF;

/**
 * A form POST of `q`, `kl` (`us-en` — this tool has no `lang:`), `df` when a recency is given,
 * and the empty `b`; the browser headers above, plus the referer and
 * `Sec-Fetch-Site: same-origin`. The
 * query carries the domain lists as `site:` / `-site:` operators with `OR`
 * grouping, DuckDuckGo's syntax — the same string `providerQueryString` already builds.
 */
export function duckDuckGoRequest(endpoint: string, q: SearchQuery, recency?: SearchRecency): ProviderRequest {
  const form = new URLSearchParams({ q: providerQueryString(q), kl: "us-en" });
  const df = recency !== undefined ? DUCKDUCKGO_RECENCY_DF[recency] : undefined;
  if (df) form.set("df", df);
  form.set("b", "");
  return {
    url: endpoint,
    method: "POST",
    headers: {
      ...BROWSER_NAVIGATION_HEADERS,
      Referer: DUCKDUCKGO_REFERER,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  };
}

/** Decodes the HTML entities DuckDuckGo's results use. */
function decodeDuckDuckGoText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * DuckDuckGo's `//duckduckgo.com/l/?uddg=<encoded>` redirect unwrapped to its
 * target, a protocol-relative link given `https:`, an absolute one kept.
 */
export function unwrapDuckDuckGoUrl(href: string): string | undefined {
  if (!href) return undefined;
  const decoded = href.replace(/&amp;/gi, "&");
  const wrapMatch = decoded.match(/[?&]uddg=([^&]+)/);
  if (wrapMatch) {
    try {
      return decodeURIComponent(wrapMatch[1] ?? "");
    } catch {
      return undefined;
    }
  }
  if (decoded.startsWith("//")) return `https:${decoded}`;
  if (decoded.startsWith("http://") || decoded.startsWith("https://")) return decoded;
  return undefined;
}

/**
 * The results of DuckDuckGo's HTML page, de-duplicated by URL. The published
 * date is not kept.
 */
export function parseDuckDuckGoHtml(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  const blockRe =
    /<div\b[^>]*\bclass="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)(?=<div\b[^>]*\bclass="[^"]*\bresult\b|<div\b[^>]*\bclass="[^"]*\bnav-link\b|$)/g;
  const titleRe = /<a\b[^>]*\bclass="[^"]*\bresult__a\b[^"]*"[^>]*\bhref="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
  const snippetRe = /<(?:a|div|span)\b[^>]*\bclass="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/;
  for (const match of html.matchAll(blockRe)) {
    const block = match[1] ?? "";
    const title = titleRe.exec(block);
    if (!title) continue;
    const url = unwrapDuckDuckGoUrl(title[1] ?? "");
    if (!url) continue;
    const titleText = decodeDuckDuckGoText(title[2] ?? "");
    if (!titleText) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const snippet = snippetRe.exec(block);
    hits.push({ title: titleText, url, snippet: snippet ? decodeDuckDuckGoText(snippet[1] ?? "") : "" });
  }
  return hits;
}

/** The bot-challenge page, which DuckDuckGo serves with a 200 or a 202. */
export function isDuckDuckGoChallenge(html: string): boolean {
  return html.includes("anomaly-modal") || html.includes("anomaly.js");
}

/**
 * The challenge message, naming the keyed providers Lykos has.
 */
export const DUCKDUCKGO_CHALLENGE_MESSAGE =
  "DuckDuckGo blocked the request with a bot-detection challenge. DuckDuckGo throttles automated HTML searches " +
  "from datacenter/shared-egress IPs; configure a credentialed provider such as Brave or Perplexity for reliable web search.";

/** Titles, URLs and the provider's own snippets, with no second fetch per hit. */
export function renderHits(hits: readonly SearchHit[], q: SearchQuery, provider: string): string {
  const lines = [`${hits.length} result${hits.length === 1 ? "" : "s"} for ${JSON.stringify(q.query)} (${provider})`];
  hits.forEach((hit, index) => {
    lines.push("", `${index + 1}. ${hit.title}`, `   ${hit.url}`);
    if (hit.snippet !== "") {
      const snippet =
        hit.snippet.length > WEB_SEARCH_SNIPPET_CHARS
          ? `${hit.snippet.slice(0, WEB_SEARCH_SNIPPET_CHARS - 1)}…`
          : hit.snippet;
      lines.push(`   ${snippet}`);
    }
  });
  lines.push("", "Snippets are the provider's, not a summary of the page. Use web_fetch to read one properly.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// D3: the unconfigured sentence
// ---------------------------------------------------------------------------

/** The key for a provider, read from an environment mapping the caller supplies. Never `process.env` inside a tool. */
export function searchKeyFromEnv(keyEnv: string, env: NodeJS.ProcessEnv): string {
  if (keyEnv.trim() === "") return "";
  return (env[keyEnv.trim()] ?? "").trim();
}

/**
 * Read the first enabled api_key row for perplexity from the Lykos credential db (D2).
 * Returns undefined if no DB exists, no row matches, or resolution fails.
 */
export function readPerplexityKeyFromPool(env: NodeJS.ProcessEnv = process.env, dbPath?: string): string | undefined {
  const path = dbPath ?? defaultCredentialDbPath(env);
  const db = openCredentialDb(path, { create: false });
  if (db === undefined) return undefined;
  try {
    const row = db
      .prepare(
        "SELECT data FROM credentials WHERE provider = 'perplexity' AND type = 'api_key' AND disabled_cause IS NULL ORDER BY id LIMIT 1",
      )
      .get() as { data: string } | undefined;
    if (row === undefined) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      return undefined;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const stored = parsed as Partial<StoredApiKey>;
    if (typeof stored.key !== "string") return undefined;
    return resolveKeySource(stored.key, env);
  } finally {
    db.close();
  }
}

/**
 * D2: Key from the pool first when provider is perplexity, else configured key env.
 * Brave's resolution is unchanged.
 */
export function resolveSearchApiKey(
  provider: string,
  keyEnv: string,
  env: NodeJS.ProcessEnv = process.env,
  dbPath?: string,
): string {
  if (provider === "perplexity") {
    const pooled = readPerplexityKeyFromPool(env, dbPath);
    if (pooled !== undefined && pooled.length > 0) return pooled;
  }
  return searchKeyFromEnv(keyEnv, env);
}

/** Ticket 24 D1: the keys the `auto` chain consults, each resolved the way its explicit provider resolves it. */
export interface SearchBackendKeys {
  brave?: string;
  perplexity?: string;
  exa?: string;
}

/**
 * Every key `auto` might use: Brave's from its variable, Perplexity's from the
 * credential pool then its variable (exactly `resolveSearchApiKey`), Exa's from
 * `EXA_API_KEY`. An empty string means that backend is skipped (Brave,
 * Perplexity) or runs keyless (Exa).
 */
export function resolveAutoSearchKeys(env: NodeJS.ProcessEnv = process.env, dbPath?: string): Required<SearchBackendKeys> {
  return {
    brave: resolveSearchApiKey("brave", BRAVE_SEARCH_KEY_ENV, env, dbPath),
    perplexity: resolveSearchApiKey("perplexity", PERPLEXITY_SEARCH_KEY_ENV, env, dbPath),
    exa: resolveSearchApiKey("exa", EXA_SEARCH_KEY_ENV, env, dbPath),
  };
}

/**
 * D3's sentence. Exported and asserted verbatim so it cannot decay into
 * "search unavailable" by a later edit that means well.
 *
 * It names the provider, the variable and the configuration keys, and says
 * what to do instead — because the model reading it has a task in front of it
 * and "search is off" is not an answer to that task.
 */
export function unconfiguredNotice(provider: string, keyEnv: string): string {
  return (
    `Web search is declared but not configured, so no query was sent anywhere. The declared provider is ` +
    `${JSON.stringify(provider)} and its key is read from the environment variable ` +
    `${keyEnv === "" ? "(none named)" : `\`${keyEnv}\``} — a human has to set that, this tool cannot. The keys ` +
    `are \`${WEB_SEARCH_PROVIDER_KEY}\`, \`${WEB_SEARCH_ENDPOINT_KEY}\` and \`${WEB_SEARCH_KEY_ENV_KEY}\` in ` +
    `.lykos/config.yaml. Until then, use web_fetch on a URL you already know, or ask the human for one.`
  );
}

export function unknownProviderNotice(provider: string): string {
  return (
    `\`${WEB_SEARCH_PROVIDER_KEY}\` names ${JSON.stringify(provider)}, which Lykos does not know how to talk ` +
    `to, so no query was sent anywhere. What it knows: ${KNOWN_SEARCH_PROVIDERS.join(", ")}. A human has to ` +
    `change that setting, this tool cannot.`
  );
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const WEB_SEARCH_DESCRIPTION =
  "Search the web and get back titles, URLs and the search provider's own snippets. Use it when you do not " +
  "know which page to read — a library that shipped a major version after your training data, an error message " +
  "you have not seen, what the current recommended approach is. `include_domains` narrows the search to those " +
  "domains and `exclude_domains` drops them; both are plain hosts like `nodejs.org`. Nothing is summarised for " +
  "you: the snippets come from the provider and the reading is yours, so follow a promising hit with web_fetch. " +
  "It works with no key; when every search backend fails it says why in a sentence.";

export const WEB_SEARCH_PARAMETERS = Type.Object({
  query: Type.String({ description: "What to search for, as you would type it into a search engine." }),
  include_domains: Type.Optional(
    Type.Array(Type.String(), { description: "Only return results from these hosts, e.g. [\"nodejs.org\", \"developer.mozilla.org\"]." }),
  ),
  exclude_domains: Type.Optional(
    Type.Array(Type.String(), { description: "Never return results from these hosts." }),
  ),
  count: Type.Optional(
    Type.Number({ description: `How many results to return (default ${WEB_SEARCH_DEFAULT_COUNT}, at most ${WEB_SEARCH_MAX_COUNT}).` }),
  ),
});

export interface WebSearchToolOpts {
  cwd: string;
  gate: ApprovalGate;
  denials?: DenialLog;
  /** `web.search.provider`. Omitted, the shipped declaration: `auto`. */
  provider?: string;
  /** `web.search.endpoint`, for an explicit provider. Omitted, that provider's documented endpoint. `auto` ignores it. */
  endpoint?: string;
  /** `web.search.key_env`, for the sentence D3 returns. */
  keyEnv?: string;
  /** The key itself, already resolved from the environment by the caller. Empty or absent is what makes D3's sentence the answer. */
  apiKey?: string;
  /**
   * Ticket 24 D1: the keys `auto` consults, already resolved by the caller
   * (`resolveAutoSearchKeys`). Absent, they are resolved here from `env` and
   * `dbPath`, the way `apiKey` is.
   */
  keys?: SearchBackendKeys;
  /**
   * Ticket 24 D8: where each backend of the chain is reached. Omitted, each
   * backend's documented endpoint. Tests point these at fake servers on
   * 127.0.0.1; nothing else sets them. An explicit provider uses `endpoint`.
   */
  endpoints?: Partial<Record<SearchBackend, string>>;
  /** D9: the fetch seam. Omitted, the runtime's own `fetch`; every test passes a stub. */
  fetcher?: SearchFetcher;
  /** Optional environment mapping for key resolution when apiKey is not provided. */
  env?: NodeJS.ProcessEnv;
  /** Optional credential database path override for key resolution. */
  dbPath?: string;
}

function text(s: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text" as const, text: s }];
}

interface WebSearchResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
}

function domainList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is string => typeof d === "string")
    .map(normalizeDomain)
    .filter((d) => d !== "");
}

/** Clamp to the band the schema advertises. A model that asks for a hundred gets the ceiling, and one that asks for zero gets the default rather than an empty page of results. */
export function resolveSearchCount(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return WEB_SEARCH_DEFAULT_COUNT;
  return Math.min(Math.floor(raw), WEB_SEARCH_MAX_COUNT);
}

/** One backend the chain will try: which, where, and with what key (empty for none). */
export interface ChainStep {
  backend: SearchBackend;
  endpoint: string;
  apiKey: string;
}

/**
 * Ticket 24 D1: the order `auto` tries — Brave if its key resolved, Perplexity
 * if its key resolved, then Exa (with its key if one resolved, keyless if not),
 * then DuckDuckGo. Exported so the order is asserted rather than inferred.
 */
export function autoSearchChain(
  keys: SearchBackendKeys,
  endpoints: Partial<Record<SearchBackend, string>> = {},
): ChainStep[] {
  const at = (backend: SearchBackend): string => (endpoints[backend] ?? DEFAULT_SEARCH_ENDPOINTS[backend]).trim();
  const steps: ChainStep[] = [];
  const brave = (keys.brave ?? "").trim();
  const perplexity = (keys.perplexity ?? "").trim();
  if (brave !== "") steps.push({ backend: "brave", endpoint: at("brave"), apiKey: brave });
  if (perplexity !== "") steps.push({ backend: "perplexity", endpoint: at("perplexity"), apiKey: perplexity });
  steps.push({ backend: "exa", endpoint: at("exa"), apiKey: (keys.exa ?? "").trim() });
  steps.push({ backend: "duckduckgo", endpoint: at("duckduckgo"), apiKey: "" });
  return steps;
}

function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}

/** A reason always starts with the backend's name, so the all-failed list reads one backend per line. */
function tagged(backend: SearchBackend, reason: string): string {
  return reason.startsWith(`${backend}:`) ? reason : `${backend}: ${reason}`;
}

function requestFor(step: ChainStep, q: SearchQuery): ProviderRequest {
  switch (step.backend) {
    case "brave":
      return braveRequest(step.endpoint, step.apiKey, q);
    case "perplexity":
      return perplexityRequest(step.endpoint, step.apiKey, q);
    case "exa":
      return exaMcpRequest(step.endpoint, step.apiKey, q);
    case "duckduckgo":
      return duckDuckGoRequest(step.endpoint, q);
  }
}

/** A 2xx body read by the backend that sent it. Zero hits is left to the caller, which knows about the domain lists. */
function parseFor(backend: SearchBackend, body: string): BackendParse {
  if (backend === "exa") return parseExaMcpResponse(body);
  if (backend === "duckduckgo") {
    if (isDuckDuckGoChallenge(body)) return { ok: false, reason: DUCKDUCKGO_CHALLENGE_MESSAGE };
    return { ok: true, hits: parseDuckDuckGoHtml(body) };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return { ok: false, reason: "answered with something that is not JSON" };
  }
  return { ok: true, hits: backend === "perplexity" ? parsePerplexityResults(payload) : parseBraveResults(payload) };
}

function httpFailure(backend: SearchBackend, status: number, body: string): string {
  if (backend === "exa") return exaHttpFailure(status, body);
  if (backend === "duckduckgo") {
    return classifyProviderHttpError("duckduckgo", status, body) ?? `DuckDuckGo HTML error (${status})`;
  }
  return classifyProviderHttpError(backend, status, body) ?? `answered HTTP ${status}`;
}

type StepOutcome = { ok: true; hits: SearchHit[] } | { ok: false; reason: string };

export function buildWebSearchTool(opts: WebSearchToolOpts): ToolDefinition {
  const fetcher = opts.fetcher ?? SYSTEM_SEARCH_FETCHER;
  const provider = (opts.provider ?? AUTO_SEARCH_PROVIDER).trim();
  const endpoint = (opts.endpoint ?? defaultSearchEndpoint(provider)).trim();
  const keyEnv = (opts.keyEnv ?? defaultSearchKeyEnv(provider)).trim();
  const apiKey = (
    opts.apiKey !== undefined ? opts.apiKey : resolveSearchApiKey(provider, keyEnv, opts.env, opts.dbPath)
  ).trim();
  // Resolved lazily and once: only `auto` needs every key, and a session that
  // never searches should not open the credential pool to find them.
  let autoKeys: SearchBackendKeys | undefined = opts.keys;
  const chainFor = (): ChainStep[] => {
    if (provider === AUTO_SEARCH_PROVIDER) {
      autoKeys ??= resolveAutoSearchKeys(opts.env, opts.dbPath);
      return autoSearchChain(autoKeys, opts.endpoints);
    }
    // An explicit keyless backend is a chain of one: its configured endpoint, and its key if one resolved.
    const backend = provider as SearchBackend;
    return [{ backend, endpoint: endpoint !== "" ? endpoint : DEFAULT_SEARCH_ENDPOINTS[backend], apiKey }];
  };

  /**
   * One backend, gated, timed and read. Every way it can fail comes back as a
   * reason rather than a throw, so the chain moves on (D4) — except an error
   * that is not the backend's at all, which propagates exactly as it does for
   * the explicit providers.
   */
  async function runStep(
    step: ChainStep,
    q: SearchQuery,
    signal: AbortSignal | undefined,
  ): Promise<StepOutcome> {
    const host = hostOf(step.endpoint);
    // D5: every host, before its request, through the same gate Brave's goes through.
    try {
      await authorizeNetworkRead(
        opts.cwd,
        opts.gate,
        `search the web for ${JSON.stringify(q.query)} via ${host}`,
        `${step.backend} (${host}): ${q.query}`,
        opts.denials,
      );
    } catch (err) {
      if (err instanceof ApprovalDeniedError) {
        return { ok: false, reason: tagged(step.backend, `the gate denied ${host} — ${err.message}`) };
      }
      throw err;
    }

    const request = requestFor(step, q);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, WEB_SEARCH_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      let status: number;
      let body: string;
      try {
        const response = await fetcher(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });
        status = response.status;
        body = await response.text();
      } catch (err) {
        const why = timedOut
          ? `timed out after ${WEB_SEARCH_TIMEOUT_MS / 1000}s`
          : `could not be reached (${oneLine((err as Error).message ?? String(err))})`;
        return { ok: false, reason: tagged(step.backend, `${host} ${why}`) };
      }
      if (status < 200 || status >= 300) {
        return { ok: false, reason: tagged(step.backend, httpFailure(step.backend, status, body)) };
      }
      const parsed = parseFor(step.backend, body);
      if (!parsed.ok) return { ok: false, reason: tagged(step.backend, parsed.reason) };
      if (parsed.hits.length === 0) return { ok: false, reason: tagged(step.backend, "no results parsed from the reply") };
      const hits = filterHits(parsed.hits, q).slice(0, q.count);
      if (hits.length === 0) {
        return {
          ok: false,
          reason: tagged(
            step.backend,
            `${parsed.hits.length} result${parsed.hits.length === 1 ? "" : "s"}, none on the requested domains`,
          ),
        };
      }
      return { ok: true, hits };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  return defineTool({
    name: WEB_SEARCH_TOOL_NAME,
    label: "Web search",
    description: WEB_SEARCH_DESCRIPTION,
    promptSnippet: "Search the web for pages to read",
    promptGuidelines: [
      "Search when you do not know the URL; fetch when you do.",
      "Follow a promising result with web_fetch — a snippet is not the page.",
    ],
    parameters: WEB_SEARCH_PARAMETERS,
    async execute(_toolCallId, params, signal): Promise<WebSearchResult> {
      const query = String((params as { query?: unknown }).query ?? "").trim();
      if (query === "") {
        const reason = "lykos web_search: `query` is empty. Say what to search for.";
        return { content: text(reason), isError: true, details: { error: reason } };
      }

      // D3, before anything else: an unconfigured provider is an answer, not
      // an error — `success: false` and no `isError`, exactly as `eval`
      // reports an unconfigured Python and `github` a missing `gh`.
      if (!isKnownSearchProvider(provider)) {
        return {
          content: text(unknownProviderNotice(provider)),
          details: { provider, success: false, configured: false, setting: WEB_SEARCH_PROVIDER_KEY },
        };
      }
      if (isKeyedSearchProvider(provider) && apiKey === "") {
        return {
          content: text(unconfiguredNotice(provider, keyEnv)),
          details: { provider, success: false, configured: false, setting: WEB_SEARCH_KEY_ENV_KEY, keyEnv },
        };
      }

      const q: SearchQuery = {
        query,
        include: domainList((params as { include_domains?: unknown }).include_domains),
        exclude: domainList((params as { exclude_domains?: unknown }).exclude_domains),
        count: resolveSearchCount((params as { count?: unknown }).count as number | undefined),
      };

      if (!isKeyedSearchProvider(provider)) {
        // Ticket 24: `auto`, or an explicit keyless backend — the chain.
        const reasons: string[] = [];
        for (const step of chainFor()) {
          if (signal?.aborted) {
            reasons.push(tagged(step.backend, "not tried — the call was cancelled"));
            break;
          }
          const outcome = await runStep(step, q, signal);
          if (!outcome.ok) {
            reasons.push(outcome.reason);
            continue;
          }
          return {
            content: text(renderHits(outcome.hits, q, `via ${step.backend}`)),
            details: {
              provider,
              backend: step.backend,
              success: true,
              results: outcome.hits.length,
              query,
              include: q.include,
              exclude: q.exclude,
              urls: outcome.hits.map((h) => h.url),
              ...(reasons.length > 0 ? { fellThrough: reasons } : {}),
            },
          };
        }
        // A provider error is a TOOL ERROR, never content — the same rule as
        // the explicit providers below, with every backend's reason on its own line.
        const reason =
          `lykos web_search: no search backend answered ${JSON.stringify(query)}, so there are no results.\n` +
          reasons.map((r) => `- ${r}`).join("\n");
        return { content: text(reason), isError: true, details: { provider, success: false, reasons, error: reason } };
      }

      try {
        await authorizeNetworkRead(opts.cwd, opts.gate, `search the web for ${JSON.stringify(query)}`, `${provider}: ${query}`, opts.denials);
      } catch (err) {
        if (err instanceof ApprovalDeniedError) {
          return { content: text(err.message), isError: true, details: { provider, error: err.message } };
        }
        throw err;
      }

      const request =
        provider === "perplexity"
          ? perplexityRequest(endpoint, apiKey, q)
          : braveRequest(endpoint, apiKey, q);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        let response: SearchResponseLike;
        try {
          response = await fetcher(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: controller.signal,
          });
        } catch (err) {
          // A provider error is a TOOL ERROR, never content. A model handed a
          // transport failure as ordinary text will quote it as a search
          // result.
          const reason = `lykos web_search: the ${provider} endpoint could not be reached (${(err as Error).message}). No results.`;
          return { content: text(reason), isError: true, details: { provider, success: false, error: reason } };
        }

        const body = await response.text();
        if (response.status < 200 || response.status >= 300) {
          const hint =
            response.status === 401 || response.status === 403
              ? ` The key in \`${keyEnv}\` was rejected — a human has to check it.`
              : response.status === 429
                ? " The provider refused this request as too frequent; try again later or search less."
                : "";
          const reason =
            `lykos web_search: ${provider} answered HTTP ${response.status}, so there are no results.${hint}\n` +
            body.slice(0, 500);
          return {
            content: text(reason),
            isError: true,
            details: { provider, success: false, status: response.status, error: reason },
          };
        }

        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          const reason = `lykos web_search: ${provider} answered with something that is not JSON, so there are no results.`;
          return { content: text(reason), isError: true, details: { provider, success: false, error: reason } };
        }

        const rawHits =
          provider === "perplexity"
            ? parsePerplexityResults(payload)
            : parseBraveResults(payload);
        const hits = filterHits(rawHits, q).slice(0, q.count);
        if (hits.length === 0) {
          return {
            content: text(
              `No results for ${JSON.stringify(query)}${q.include.length > 0 ? ` on ${q.include.join(", ")}` : ""} ` +
                `(${provider}). Try different words, or drop the domain filters.`,
            ),
            details: { provider, success: true, results: 0, query, include: q.include, exclude: q.exclude },
          };
        }

        return {
          content: text(renderHits(hits, q, provider)),
          details: {
            provider,
            success: true,
            results: hits.length,
            query,
            include: q.include,
            exclude: q.exclude,
            urls: hits.map((h) => h.url),
          },
        };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  }) as ToolDefinition;
}
