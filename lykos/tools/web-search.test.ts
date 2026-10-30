// `web_search`: D2's declaration, D3's unconfigured sentence, the request
// shape, the result shape and D10's tax.
//
// **NO TEST HERE REACHES A SEARCH PROVIDER, AND NONE CAN (D9).** Every test
// builds the tool with an injected fetcher that records the URL and the
// headers it was given and answers from a canned payload.
// `SYSTEM_SEARCH_FETCHER` — the only thing in `web-search.ts` that opens a
// socket — is never constructed here. The unconfigured tests go further and
// assert the fetcher was never called at all: "declared but not configured"
// has to mean nothing was sent anywhere, and the only proof of that is a
// transport that recorded nothing.
//
// **Ticket 24's chain tests use the real `fetch`, and only against
// 127.0.0.1.** Each keyless backend (and Brave, where the chain is tested) is
// a fake HTTP server on `127.0.0.1:0`, and the tool is handed those URLs via
// `endpoints` — so the request actually goes over a socket, is parsed by a
// server, and the reply comes back through the same code a real one would,
// without any test reaching a vendor. No fixture was recorded from a vendor.

import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DenialLog,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
} from "../gate/approval.js";
import { SHIPPED_DEFAULTS } from "../config/defaults.js";
import { openCredentialDb } from "../credentials/db.js";
import { upsertCredential } from "../credentials/pool.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS } from "./tool-surface.js";
import {
  BRAVE_SEARCH_ENDPOINT,
  BRAVE_SEARCH_KEY_ENV,
  BRAVE_SEARCH_KEY_HEADER,
  KNOWN_SEARCH_PROVIDERS,
  PERPLEXITY_SEARCH_ENDPOINT,
  PERPLEXITY_SEARCH_KEY_ENV,
  WEB_SEARCH_DEFAULT_COUNT,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_KEY_ENV_KEY,
  WEB_SEARCH_MAX_COUNT,
  WEB_SEARCH_PARAMETERS,
  WEB_SEARCH_PROVIDER_KEY,
  WEB_SEARCH_TOOL_NAME,
  braveRequest,
  buildWebSearchTool,
  defaultSearchEndpoint,
  defaultSearchKeyEnv,
  filterHits,
  hostMatchesDomain,
  normalizeDomain,
  parseBraveResults,
  parsePerplexityResults,
  perplexityRequest,
  providerQueryString,
  resolveSearchApiKey,
  resolveSearchCount,
  searchKeyFromEnv,
  stripTags,
  unconfiguredNotice,
  AUTO_SEARCH_PROVIDER,
  DUCKDUCKGO_CHALLENGE_MESSAGE,
  DUCKDUCKGO_HTML_ENDPOINT,
  EXA_MCP_ENDPOINT,
  EXA_MCP_SOURCE,
  EXA_RATE_LIMIT_MESSAGE,
  EXA_SEARCH_KEY_ENV,
  WEB_SEARCH_SNIPPET_CHARS,
  autoSearchChain,
  duckDuckGoRequest,
  exaMcpRequest,
  parseDuckDuckGoHtml,
  parseExaMcpResponse,
  parseSSE,
  resolveAutoSearchKeys,
  unwrapDuckDuckGoUrl,
  type SearchBackend,
  type SearchBackendKeys,
  type SearchFetcher,
  type SearchRequestInit,
  type SearchResponseLike,
} from "./web-search.js";

function asJson(schema: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
}

class RecordingGate implements ApprovalGate {
  readonly seen: ApprovalRequest[] = [];
  constructor(private readonly answer: ApprovalDecision = "allow") {}
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    this.seen.push(req);
    return this.answer;
  }
}

interface Sent {
  url: string;
  method?: string | undefined;
  headers: Record<string, string>;
  body?: string | undefined;
}

interface Harness {
  tool: ToolDefinition;
  sent: Sent[];
  gate: RecordingGate;
  denials: DenialLog;
}

const BRAVE_PAYLOAD = {
  query: { original: "widget library" },
  web: {
    results: [
      {
        title: "Widget <strong>library</strong> docs",
        url: "https://docs.example/widget",
        description: "The <strong>widget</strong> library, version 4. Installation &amp; usage.",
      },
      {
        title: "Widget library on a forum",
        url: "https://forum.example/thread/1",
        description: "Someone asking about widgets in 2019.",
      },
      { title: "No URL here", description: "dropped, because a result with no URL is not a result" },
    ],
  },
};

const PERPLEXITY_PAYLOAD = {
  id: "search-123",
  results: [
    {
      title: "Widget <strong>library</strong> docs",
      url: "https://docs.example/widget",
      snippet: "The <strong>widget</strong> library, version 4. Installation &amp; usage.",
    },
    {
      title: "Widget library on a forum",
      url: "https://forum.example/thread/1",
      snippet: "Someone asking about widgets in 2019.",
    },
    { title: "No URL here", snippet: "dropped, because a result with no URL is not a result" },
  ],
};

function harness(opts: {
  apiKey?: string;
  provider?: string;
  endpoint?: string;
  keyEnv?: string;
  gate?: RecordingGate;
  env?: NodeJS.ProcessEnv;
  dbPath?: string;
  answer?: (url: string, init?: SearchRequestInit) => SearchResponseLike | Promise<SearchResponseLike>;
}): Harness {
  const sent: Sent[] = [];
  const gate = opts.gate ?? new RecordingGate();
  const denials = new DenialLog();
  const fetcher: SearchFetcher = async (url, init) => {
    sent.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (opts.answer !== undefined) return opts.answer(url, init);
    const payload = opts.provider === "perplexity" ? PERPLEXITY_PAYLOAD : BRAVE_PAYLOAD;
    return { status: 200, text: async () => JSON.stringify(payload) };
  };
  const tool = buildWebSearchTool({
    cwd: process.cwd(),
    gate,
    denials,
    fetcher,
    // Ticket 24: the tool's own default is now `auto`. These P10.7 / Plan 17
    // tests are about an EXPLICIT keyed provider, so they name Brave unless
    // they name another — which is also the proof that an explicit Brave
    // behaves exactly as it did before the chain existed.
    provider: opts.provider ?? "brave",
    ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
    ...(opts.keyEnv !== undefined ? { keyEnv: opts.keyEnv } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.dbPath !== undefined ? { dbPath: opts.dbPath } : {}),
  });
  return { tool, sent, gate, denials };
}

async function call(tool: ToolDefinition, args: Record<string, unknown>): Promise<{ text: string; isError: boolean; details: any }> {
  const result = (await tool.execute("call-1", args as never, undefined as never, undefined as never, undefined as never)) as {
    content?: Array<{ text?: string }>;
    isError?: boolean;
    details?: unknown;
  };
  return {
    text: result.content?.map((c) => c.text ?? "").join("\n") ?? "",
    isError: result.isError === true,
    details: result.details as any,
  };
}

// ---------------------------------------------------------------------------
// D10: the catalog prices what web_search sends, and it is RESIDENT
// ---------------------------------------------------------------------------

describe("P10.7 D10: the catalog prices what web_search sends", () => {
  it("the row equals the live definition, description and parameters both", () => {
    const row = TOOL_CATALOG.web_search;
    assert.ok(row);
    assert.equal(row.name, WEB_SEARCH_TOOL_NAME);
    assert.equal(row.source, "lykos");
    assert.equal(row.description, WEB_SEARCH_DESCRIPTION);
    assert.deepEqual(row.parameters, asJson(WEB_SEARCH_PARAMETERS));
  });

  // Measured with `measureToolset` on SCHEMA_TOKENS_BASIS, 2026-09-21. This is
  // a bill that is actually paid: the pair is RESIDENT, and the resident
  // surface moved 1423 -> 2062 tokens (5691 -> 8253 bytes) for the two of
  // them, the first move in that number since P10.4's grep/powershell/glob.
  // Ticket 24 (2026-09-24) reworded web_search's no-key sentence, re-measured:
  // 314 -> 309 tokens alone (1255 -> 1237 bytes), 2062 -> 2057 (8253 -> 8235) resident.
  // T168 (ADR-0031) re-measured the surface on 2026-10-05: 1423 -> 1458 before the pair and 2057 -> 2092 (8235 -> 8376 bytes) after it,
  // because `edit` gained `replaceAll` and `read` a sentence about its numbering. The pair's own cost did not move.
  it("costs 309 tokens alone, and the resident surface moved 1458 -> 2092 for the pair", () => {
    const alone = measureToolset([WEB_SEARCH_TOOL_NAME]);
    assert.equal(alone.complete, true);
    assert.equal(alone.tokens, 309);
    assert.equal(alone.bytes, 1237);
    const resident = measureToolset(DEFAULT_RESIDENT_TOOLS);
    assert.equal(resident.tokens, 2255);
    assert.equal(resident.bytes, 9027);
    // What the surface cost before this ticket, measured the same way, so the
    // move is a subtraction anyone can repeat rather than a recollection.
    assert.equal(measureToolset(["read", "bash", "edit", "write", "grep", "powershell", "glob"]).tokens, 1458);
    assert.equal(DEFAULT_RESIDENT_TOOLS.includes(WEB_SEARCH_TOOL_NAME), true);
    assert.equal(MOUNTED_TOOLS.includes(WEB_SEARCH_TOOL_NAME), false);
    // The mounted set did not move at all: nothing about this ticket touches
    // the twenty-five tools reached through `tool_call`.
    assert.equal(measureToolset(MOUNTED_TOOLS).tokens, 9023);
  });

  it("is declared read-tier and open-world", () => {
    assert.equal(tierForTool(WEB_SEARCH_TOOL_NAME), "read");
    assert.deepEqual(riskForTool(WEB_SEARCH_TOOL_NAME), { tier: "read", idempotent: false, openWorld: true });
  });
});

// ---------------------------------------------------------------------------
// D2: the declaration
// ---------------------------------------------------------------------------

describe("P10.7 D2: the provider is a configuration declaration, not a dependency", () => {
  it("ships the keyless `auto` chain, and Brave's declaration is what `provider: brave` still means", () => {
    const search = SHIPPED_DEFAULTS.web.search;
    // Ticket 24 D1: the shipped provider is the chain, with no endpoint or key variable of its own.
    assert.equal(search.provider, "auto");
    assert.equal(search.endpoint, "");
    assert.equal(search.key_env, "");
    assert.equal(defaultSearchEndpoint("brave"), BRAVE_SEARCH_ENDPOINT);
    assert.equal(defaultSearchKeyEnv("brave"), BRAVE_SEARCH_KEY_ENV);
    // The endpoint and the variable are Brave's own documented ones, read from
    // api-dashboard.search.brave.com on 2026-09-21. No price, quota or term
    // for any provider appears anywhere in this repository, and none should.
    assert.equal(BRAVE_SEARCH_ENDPOINT, "https://api.search.brave.com/res/v1/web/search");
    assert.equal(BRAVE_SEARCH_KEY_ENV, "BRAVE_SEARCH_API_KEY");
    assert.equal(BRAVE_SEARCH_KEY_HEADER, "X-Subscription-Token");
    assert.deepEqual([...KNOWN_SEARCH_PROVIDERS], ["auto", "brave", "perplexity", "exa", "duckduckgo"]);
  });

  it("builds the request against the CONFIGURED endpoint, so swapping is an HTTP change", async () => {
    const h = harness({ apiKey: "k", endpoint: "https://search.internal.invalid/v1/search" });
    await call(h.tool, { query: "widget library" });
    assert.equal(h.sent.length, 1);
    assert.ok(h.sent[0]!.url.startsWith("https://search.internal.invalid/v1/search?"), h.sent[0]!.url);
  });

  it("puts the key in the documented header and nowhere else", async () => {
    const h = harness({ apiKey: "secret-key" });
    await call(h.tool, { query: "widget library" });
    assert.equal(h.sent[0]!.headers[BRAVE_SEARCH_KEY_HEADER], "secret-key");
    assert.doesNotMatch(h.sent[0]!.url, /secret-key/);
  });

  it("reads the key from an injected environment, never from process.env inside the tool", () => {
    assert.equal(searchKeyFromEnv("BRAVE_SEARCH_API_KEY", { BRAVE_SEARCH_API_KEY: " abc " }), "abc");
    assert.equal(searchKeyFromEnv("BRAVE_SEARCH_API_KEY", {}), "");
    assert.equal(searchKeyFromEnv("", { BRAVE_SEARCH_API_KEY: "abc" }), "");
  });
});

// ---------------------------------------------------------------------------
// D3: unconfigured is a sentence
// ---------------------------------------------------------------------------

describe("P10.7 D3: with no key the tool says it is unconfigured and sends nothing", () => {
  it("names the setting and the environment variable, and is not an error", async () => {
    const h = harness({});
    const res = await call(h.tool, { query: "widget library" });
    assert.equal(res.isError, false, "an unconfigured tool is an answer, not a failed turn");
    assert.equal(res.text, unconfiguredNotice("brave", BRAVE_SEARCH_KEY_ENV));
    assert.match(res.text, new RegExp(WEB_SEARCH_KEY_ENV_KEY.replace(".", "\\.")));
    assert.match(res.text, /BRAVE_SEARCH_API_KEY/);
    assert.equal(res.details.configured, false);
    assert.equal(res.details.success, false);
    // Nothing was sent anywhere, and nobody was asked to approve anything.
    assert.deepEqual(h.sent, []);
    assert.equal(h.gate.seen.length, 0);
  });

  it("says so for a provider it does not know how to talk to, naming the ones it does", async () => {
    const h = harness({ apiKey: "k", provider: "altavista" });
    const res = await call(h.tool, { query: "widget library" });
    assert.equal(res.isError, false);
    assert.match(res.text, /altavista/);
    assert.match(res.text, /brave/);
    assert.match(res.text, new RegExp(WEB_SEARCH_PROVIDER_KEY.replace(/\./g, "\\.")));
    assert.deepEqual(h.sent, []);
  });

  it("refuses an empty query as a mis-call rather than searching for nothing", async () => {
    const h = harness({ apiKey: "k" });
    const res = await call(h.tool, { query: "  " });
    assert.equal(res.isError, true);
    assert.deepEqual(h.sent, []);
  });
});

// ---------------------------------------------------------------------------
// The request: domain lists and the result count
// ---------------------------------------------------------------------------

describe("P10.7: the domain lists reach the request", () => {
  it("sends site: for includes and -site: for excludes", async () => {
    const h = harness({ apiKey: "k" });
    await call(h.tool, {
      query: "widget library",
      include_domains: ["docs.example"],
      exclude_domains: ["forum.example", "https://spam.example/x"],
    });
    const q = new URL(h.sent[0]!.url).searchParams.get("q") ?? "";
    assert.match(q, /widget library/);
    assert.match(q, /site:docs\.example/);
    assert.match(q, /-site:forum\.example/);
    // A domain written as a URL is reduced to the host it means.
    assert.match(q, /-site:spam\.example/);
  });

  it("groups two or more includes rather than AND-ing them into nothing", () => {
    assert.equal(
      providerQueryString({ query: "widgets", include: ["a.example", "b.example"], exclude: [], count: 10 }),
      "widgets (site:a.example OR site:b.example)",
    );
    assert.equal(
      providerQueryString({ query: "widgets", include: [], exclude: ["c.example"], count: 10 }),
      "widgets -site:c.example",
    );
  });

  it("asks for the default count, and clamps what a model asks for to the documented ceiling", async () => {
    const h = harness({ apiKey: "k" });
    await call(h.tool, { query: "widgets" });
    assert.equal(new URL(h.sent[0]!.url).searchParams.get("count"), String(WEB_SEARCH_DEFAULT_COUNT));
    await call(h.tool, { query: "widgets", count: 500 });
    assert.equal(new URL(h.sent[1]!.url).searchParams.get("count"), String(WEB_SEARCH_MAX_COUNT));
    assert.equal(resolveSearchCount(undefined), WEB_SEARCH_DEFAULT_COUNT);
    assert.equal(resolveSearchCount(0), WEB_SEARCH_DEFAULT_COUNT);
    assert.equal(resolveSearchCount(3), 3);
    assert.equal(resolveSearchCount(9999), WEB_SEARCH_MAX_COUNT);
  });

  it("asks the provider for nothing it was not asked for — no summary parameter", () => {
    const request = braveRequest(BRAVE_SEARCH_ENDPOINT, "k", { query: "widgets", include: [], exclude: [], count: 5 });
    const params = new URL(request.url).searchParams;
    assert.deepEqual([...params.keys()].sort(), ["count", "q"]);
  });
});

// ---------------------------------------------------------------------------
// The results
// ---------------------------------------------------------------------------

describe("P10.7: the result shape is titles, URLs and the provider's snippets", () => {
  it("renders each hit with its title, URL and snippet, markup stripped", async () => {
    const h = harness({ apiKey: "k" });
    const res = await call(h.tool, { query: "widget library" });
    assert.equal(res.isError, false);
    assert.equal(res.details.results, 2, "the result with no URL is dropped");
    assert.match(res.text, /1\. Widget library docs/);
    assert.match(res.text, /https:\/\/docs\.example\/widget/);
    assert.match(res.text, /The widget library, version 4\. Installation & usage\./);
    assert.doesNotMatch(res.text, /<strong>/);
    assert.match(res.text, /web_fetch/);
    assert.deepEqual(res.details.urls, ["https://docs.example/widget", "https://forum.example/thread/1"]);
  });

  it("applies the domain lists to the results too, whatever the provider did with the operators", async () => {
    const h = harness({ apiKey: "k" });
    const excluded = await call(h.tool, { query: "widget library", exclude_domains: ["forum.example"] });
    assert.deepEqual(excluded.details.urls, ["https://docs.example/widget"]);

    const included = await call(h.tool, { query: "widget library", include_domains: ["docs.example"] });
    assert.deepEqual(included.details.urls, ["https://docs.example/widget"]);
  });

  it("an empty result list is an answer, not an error", async () => {
    const h = harness({ apiKey: "k", answer: () => ({ status: 200, text: async () => JSON.stringify({ web: { results: [] } }) }) });
    const res = await call(h.tool, { query: "no such thing anywhere" });
    assert.equal(res.isError, false);
    assert.equal(res.details.results, 0);
    assert.match(res.text, /No results/);
  });

  it("parses Brave's documented shape and survives a field it has never seen", () => {
    const hits = parseBraveResults({
      web: { results: [{ title: "T", url: "https://a.example/", description: "D", age: "2 days ago", extra: { nested: true } }] },
    });
    assert.deepEqual(hits, [{ title: "T", url: "https://a.example/", snippet: "D" }]);
    assert.deepEqual(parseBraveResults({}), []);
    assert.deepEqual(parseBraveResults(null), []);
    assert.deepEqual(parseBraveResults({ web: { results: "not a list" } }), []);
  });

  it("domain matching is by host and subdomain, never by substring", () => {
    assert.equal(hostMatchesDomain("https://docs.example/x", "docs.example"), true);
    assert.equal(hostMatchesDomain("https://a.docs.example/x", "docs.example"), true);
    assert.equal(hostMatchesDomain("https://notdocs.example/x", "docs.example"), false);
    assert.equal(hostMatchesDomain("https://docs.example.evil.test/x", "docs.example"), false);
    assert.equal(hostMatchesDomain("not a url", "docs.example"), false);
    assert.equal(normalizeDomain("HTTPS://Docs.Example/path"), "docs.example");
    assert.equal(normalizeDomain(".docs.example"), "docs.example");
    assert.equal(stripTags("a <b>bold</b> &amp; brash"), "a bold & brash");
    assert.deepEqual(
      filterHits([{ title: "t", url: "https://a.example/", snippet: "" }], {
        query: "q",
        include: ["b.example"],
        exclude: [],
        count: 10,
      }),
      [],
    );
  });
});

// ---------------------------------------------------------------------------
// D9: a provider error is a tool error, never content
// ---------------------------------------------------------------------------

describe("P10.7: a provider error surfaces as a tool error rather than as content", () => {
  it("reports an HTTP status as an error, and points at the key when it was rejected", async () => {
    const h = harness({ apiKey: "k", answer: () => ({ status: 401, text: async () => '{"error":"invalid key"}' }) });
    const res = await call(h.tool, { query: "widgets" });
    assert.equal(res.isError, true);
    assert.match(res.text, /HTTP 401/);
    assert.match(res.text, /BRAVE_SEARCH_API_KEY/);
    assert.equal(res.details.success, false);
    assert.equal(res.details.status, 401);
  });

  it("reports a transport failure as an error", async () => {
    const h = harness({
      apiKey: "k",
      answer: () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    const res = await call(h.tool, { query: "widgets" });
    assert.equal(res.isError, true);
    assert.match(res.text, /could not be reached/);
    assert.equal(res.details.success, false);
  });

  it("reports a non-JSON body as an error rather than as a result", async () => {
    const h = harness({ apiKey: "k", answer: () => ({ status: 200, text: async () => "<html>rate limited</html>" }) });
    const res = await call(h.tool, { query: "widgets" });
    assert.equal(res.isError, true);
    assert.match(res.text, /not JSON/);
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("P10.7: web_search reaches the same gate as everything else", () => {
  it("asks at the read tier and sends nothing when the human declines", async () => {
    const allow = harness({ apiKey: "k" });
    await call(allow.tool, { query: "widgets" });
    assert.equal(allow.gate.seen.length, 1);
    assert.equal(allow.gate.seen[0]!.kind, "read");
    assert.match(allow.gate.seen[0]!.summary, /widgets/);

    const deny = harness({ apiKey: "k", gate: new RecordingGate("deny") });
    const res = await call(deny.tool, { query: "widgets" });
    assert.equal(res.isError, true);
    assert.deepEqual(deny.sent, []);
    assert.equal(deny.denials.userRejected, 1);
  });
});

// ---------------------------------------------------------------------------
// Plan 17 D1: Perplexity request shape
// ---------------------------------------------------------------------------

describe("Plan 17 D1: Perplexity request shape", () => {
  it("builds a POST request to default endpoint with Bearer authorization and JSON body", () => {
    const q = { query: "widget library", include: [], exclude: [], count: 10 };
    const req = perplexityRequest(PERPLEXITY_SEARCH_ENDPOINT, "test-api-key", q);
    assert.equal(req.url, "https://api.perplexity.ai/search");
    assert.equal(req.method, "POST");
    assert.equal(req.headers["authorization"], "Bearer test-api-key");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.headers["accept"], "application/json");
    assert.doesNotMatch(req.url, /test-api-key/);

    const body = JSON.parse(req.body ?? "{}");
    assert.equal(body.query, "widget library");
    assert.equal(body.max_results, 10);
    // No summary, no answer synthesis, no Sonar fields are requested.
    assert.equal(body.mode, undefined);
    assert.equal(body.summary, undefined);
    assert.equal(body.answer, undefined);
    assert.equal(body.sonar, undefined);
  });

  it("sends only include domains in search_domain_filter; excludes are the tool's post-filter", () => {
    const q = {
      query: "widgets",
      include: ["docs.example", "api.example"],
      exclude: ["forum.example", "spam.example"],
      count: 5,
    };
    const req = perplexityRequest(PERPLEXITY_SEARCH_ENDPOINT, "k", q);
    const body = JSON.parse(req.body ?? "{}");
    // The docs define the filter only as "Limit search results to specific domains (max 20)".
    assert.deepEqual(body.search_domain_filter, ["docs.example", "api.example"]);

    const onlyExcludes = perplexityRequest(PERPLEXITY_SEARCH_ENDPOINT, "k", { ...q, include: [] });
    assert.equal(JSON.parse(onlyExcludes.body ?? "{}").search_domain_filter, undefined);

    const many = Array.from({ length: 25 }, (_, i) => `d${i}.example`);
    const capped = perplexityRequest(PERPLEXITY_SEARCH_ENDPOINT, "k", { ...q, include: many });
    assert.equal(JSON.parse(capped.body ?? "{}").search_domain_filter.length, 20);
  });

  it("builds the request against a CONFIGURED endpoint", async () => {
    const h = harness({
      provider: "perplexity",
      apiKey: "k",
      endpoint: "https://search.internal.invalid/v1/perp",
    });
    await call(h.tool, { query: "widget library" });
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.url, "https://search.internal.invalid/v1/perp");
    assert.equal(h.sent[0]!.method, "POST");
    assert.equal(h.sent[0]!.headers["authorization"], "Bearer k");
    const body = JSON.parse(h.sent[0]!.body ?? "{}");
    assert.equal(body.query, "widget library");
  });
});

// ---------------------------------------------------------------------------
// Plan 17 D1: Perplexity response parsing and result rendering
// ---------------------------------------------------------------------------

describe("Plan 17 D1: Perplexity results", () => {
  it("parses Perplexity documented response into titles, URLs, and snippets", () => {
    const hits = parsePerplexityResults({
      id: "search-123",
      results: [
        {
          title: "Widget <strong>library</strong>",
          url: "https://docs.example/widget",
          snippet: "A <strong>widget</strong> helper &amp; tool.",
        },
        { title: "No URL", snippet: "dropped" },
      ],
    });
    assert.deepEqual(hits, [
      {
        title: "Widget library",
        url: "https://docs.example/widget",
        snippet: "A widget helper & tool.",
      },
    ]);
    assert.deepEqual(parsePerplexityResults({}), []);
    assert.deepEqual(parsePerplexityResults(null), []);
    assert.deepEqual(parsePerplexityResults({ results: "not an array" }), []);
  });

  it("renders Perplexity hits with title, URL, snippet and applies domain filters", async () => {
    const h = harness({ provider: "perplexity", apiKey: "k" });
    const res = await call(h.tool, { query: "widget library" });
    assert.equal(res.isError, false);
    assert.equal(res.details.provider, "perplexity");
    assert.equal(res.details.results, 2);
    assert.match(res.text, /1\. Widget library docs/);
    assert.match(res.text, /https:\/\/docs\.example\/widget/);
    assert.match(res.text, /The widget library, version 4\. Installation & usage\./);
    assert.doesNotMatch(res.text, /<strong>/);
    assert.deepEqual(res.details.urls, ["https://docs.example/widget", "https://forum.example/thread/1"]);

    // Exclude filter
    const excluded = await call(h.tool, { query: "widget library", exclude_domains: ["forum.example"] });
    assert.deepEqual(excluded.details.urls, ["https://docs.example/widget"]);
  });

  it("empty result list reports no results for perplexity", async () => {
    const h = harness({
      provider: "perplexity",
      apiKey: "k",
      answer: () => ({ status: 200, text: async () => JSON.stringify({ id: "empty", results: [] }) }),
    });
    const res = await call(h.tool, { query: "unheard of query" });
    assert.equal(res.isError, false);
    assert.equal(res.details.results, 0);
    assert.match(res.text, /No results for "unheard of query"/);
    assert.match(res.text, /\(perplexity\)/);
  });

  it("HTTP 401 error points at PERPLEXITY_API_KEY", async () => {
    const h = harness({
      provider: "perplexity",
      apiKey: "bad-key",
      answer: () => ({ status: 401, text: async () => '{"error":"unauthorized"}' }),
    });
    const res = await call(h.tool, { query: "widgets" });
    assert.equal(res.isError, true);
    assert.match(res.text, /HTTP 401/);
    assert.match(res.text, /PERPLEXITY_API_KEY/);
  });
});

// ---------------------------------------------------------------------------
// Plan 17 D2: Key resolution (pool first, then env, else unconfigured)
// ---------------------------------------------------------------------------

describe("Plan 17 D2: Key resolution for Perplexity", () => {
  it("a pooled api_key row wins over the env variable", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-perp-pool-"));
    const dbPath = join(dir, "credentials.db");
    try {
      const db = openCredentialDb(dbPath, { create: true })!;
      upsertCredential(db, "perplexity", { type: "api_key", key: "pooled-perplexity-key" });
      db.close();

      const key = resolveSearchApiKey("perplexity", "PERPLEXITY_API_KEY", { PERPLEXITY_API_KEY: "env-key" }, dbPath);
      assert.equal(key, "pooled-perplexity-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to env when pool has no row for perplexity", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-perp-empty-"));
    const dbPath = join(dir, "credentials.db");
    try {
      const db = openCredentialDb(dbPath, { create: true })!;
      db.close();

      const key = resolveSearchApiKey("perplexity", "PERPLEXITY_API_KEY", { PERPLEXITY_API_KEY: "env-key" }, dbPath);
      assert.equal(key, "env-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("with neither pool row nor env, resolves to empty and tool outputs unconfigured notice naming PERPLEXITY_API_KEY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-perp-none-"));
    const dbPath = join(dir, "credentials.db");
    try {
      const db = openCredentialDb(dbPath, { create: true })!;
      db.close();

      const key = resolveSearchApiKey("perplexity", "PERPLEXITY_API_KEY", {}, dbPath);
      assert.equal(key, "");

      const h = harness({ provider: "perplexity", dbPath, env: {} });
      const res = await call(h.tool, { query: "widget library" });
      assert.equal(res.isError, false);
      assert.equal(res.details.configured, false);
      assert.match(res.text, /PERPLEXITY_API_KEY/);
      assert.match(res.text, /perplexity/);
      assert.deepEqual(h.sent, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Brave's resolution is unchanged and does not read perplexity pool", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-perp-brave-"));
    const dbPath = join(dir, "credentials.db");
    try {
      const db = openCredentialDb(dbPath, { create: true })!;
      upsertCredential(db, "perplexity", { type: "api_key", key: "pooled-perp-key" });
      db.close();

      const key = resolveSearchApiKey("brave", "BRAVE_SEARCH_API_KEY", { BRAVE_SEARCH_API_KEY: "brave-key" }, dbPath);
      assert.equal(key, "brave-key");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Ticket 24: fake servers on 127.0.0.1:0, and fixtures
// ---------------------------------------------------------------------------

interface FakeRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface FakeReply {
  status: number;
  body: string;
  contentType?: string;
}

interface FakeServer {
  url: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

/** A local HTTP server that records every request and answers from `reply`. Never anything but 127.0.0.1. */
async function fakeServer(path: string, reply: (req: FakeRequest) => FakeReply): Promise<FakeServer> {
  const requests: FakeRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const recorded: FakeRequest = {
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      const r = reply(recorded);
      res.writeHead(r.status, { "content-type": r.contentType ?? "text/plain; charset=utf-8" });
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}${path}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A URL on 127.0.0.1 that nothing is listening on: a server is opened, its port read, and it is closed. */
async function deadEndpoint(path: string): Promise<string> {
  const s = await fakeServer(path, () => ({ status: 200, body: "" }));
  await s.close();
  return s.url;
}

/** The chain, built the way boot builds it, with every backend pointed at a local fake and the real `fetch`. */
function chainTool(opts: {
  endpoints: Partial<Record<SearchBackend, string>>;
  keys?: SearchBackendKeys;
  provider?: string;
  endpoint?: string;
  apiKey?: string;
  gate?: ApprovalGate & { seen?: ApprovalRequest[] };
}): { tool: ToolDefinition; gate: ApprovalGate; denials: DenialLog } {
  const gate = opts.gate ?? new RecordingGate();
  const denials = new DenialLog();
  const tool = buildWebSearchTool({
    cwd: process.cwd(),
    gate,
    denials,
    provider: opts.provider ?? AUTO_SEARCH_PROVIDER,
    keys: opts.keys ?? {},
    endpoints: opts.endpoints,
    ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });
  return { tool, gate, denials };
}

/**
 * An Exa search payload as the `result` of a JSON-RPC reply. Its `summary`
 * fields are a model's paraphrase; this tool must not pass them on.
 */
const EXA_JSON_RESULT = {
  requestId: "req-123",
  resolvedSearchType: "auto",
  results: [
    {
      title: "Page Alpha",
      url: "https://alpha.com",
      author: "Author A",
      publishedDate: "2024-06-01",
      text: "Full text of alpha",
      highlights: ["highlight alpha"],
      summary: "Alpha is about X.",
    },
    {
      title: "Page Beta",
      url: "https://beta.com",
      author: null,
      publishedDate: null,
      text: null,
      highlights: null,
      summary: "Beta covers Y.",
    },
    {
      title: "Page Gamma",
      url: "https://gamma.com",
      author: "Author G",
      publishedDate: "2024-07-15",
      text: "Gamma text",
      highlights: ["gamma hl"],
      summary: "Gamma discusses Z.",
    },
  ],
};
const EXA_JSON_REPLY = JSON.stringify({ jsonrpc: "2.0", id: "mcp-1", result: EXA_JSON_RESULT });

/**
 * A plain-text Exa block inside `event:`/`data:` SSE framing.
 */
const EXA_PLAIN_TEXT =
  "Title: Plain Result\nURL: https://plain.example\nAuthor: Reporter\nPublished Date: 2024-06-01\nText: Plain text body";
const EXA_SSE_REPLY =
  "event: message\n" +
  `data: ${JSON.stringify({ jsonrpc: "2.0", id: "mcp-text", result: { content: [{ type: "text", text: EXA_PLAIN_TEXT }] } })}\n\n`;

/**
 * One result block in the shape DuckDuckGo's no-JS HTML page renders.
 */
function resultBlock(url: string, title: string, snippet: string): string {
  return `
		<div class="result results_links results_links_deep web-result ">
			<div class="links_main links_deep result__body">
				<h2 class="result__title">
					<a rel="nofollow" class="result__a" href="${url}">${title}</a>
				</h2>
				<div class="result__extras">
					<div class="result__extras__url">
						<span class="result__icon">
							<a rel="nofollow" href="${url}"><img class="result__icon__img" width="16" height="16" alt="" src="//external-content.duckduckgo.com/ip3/example.ico" name="i15" /></a>
						</span>
						<a class="result__url" href="${url}">${url}</a>
					</div>
				</div>
				<a class="result__snippet" href="${url}">${snippet}</a>
				<div class="clear"></div>
			</div>
		</div>`;
}

function resultsPage(blocks: string): string {
  return `<!DOCTYPE html><html><body><div id="links" class="results">${blocks}<div class="nav-link"></div></div></body></html>`;
}

/**
 * Lykos's own, written for this test: a row whose link goes through
 * DuckDuckGo's `//duckduckgo.com/l/?uddg=` redirect, with `<b>` markup
 * and entities in the title and snippet, and a duplicate of the first row.
 */
const DDG_PAGE = resultsPage(
  [
    resultBlock(
      "//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Fesm.html&amp;rut=abc123",
      "<b>ERR_REQUIRE_ESM</b> &amp; ES modules",
      "Node.js <b>cannot</b> require() an ES module &#39;x&#39;.",
    ),
    resultBlock("https://example.com/fresh", "Fresh page", "A recent article."),
    resultBlock("https://example.com/fresh", "Fresh page again", "The same URL twice."),
  ].join(""),
);

/** The two markers of DuckDuckGo's bot-challenge page. */
const DDG_CHALLENGE_PAGE =
  '<!DOCTYPE html><html><body><div class="anomaly-modal__mask"></div><script src="/dist/anomaly.js"></script></body></html>';

/** Lykos's own: a results page with no result rows. */
const DDG_EMPTY_PAGE = resultsPage("");

function exaOk(body = EXA_JSON_REPLY): () => FakeReply {
  return () => ({ status: 200, body, contentType: "application/json" });
}
function ddgOk(body = DDG_PAGE): () => FakeReply {
  return () => ({ status: 200, body, contentType: "text/html" });
}

// ---------------------------------------------------------------------------
// Ticket 24 D8.1: Exa
// ---------------------------------------------------------------------------

describe("Ticket 24 D2/D8.1: Exa's hosted MCP endpoint, keyless", () => {
  it("sends the request shape — tools=web_search_exa, JSON-RPC tools/call, the three headers — with no key", async () => {
    const exa = await fakeServer("/mcp", exaOk());
    try {
      const { tool } = chainTool({ provider: "exa", endpoint: exa.url, apiKey: "" , endpoints: {} });
      const res = await call(tool, { query: "vector databases", count: 4 });
      assert.equal(res.isError, false, res.text);
      assert.equal(exa.requests.length, 1);
      const req = exa.requests[0]!;
      assert.equal(req.method, "POST");
      const url = new URL(req.url, "http://127.0.0.1");
      assert.equal(url.pathname, "/mcp");
      assert.equal(url.searchParams.get("tools"), "web_search_exa");
      assert.equal(url.searchParams.has("exaApiKey"), false, "no key, no exaApiKey");
      assert.equal(req.headers["content-type"], "application/json");
      assert.equal(req.headers["accept"], "application/json, text/event-stream");
      assert.equal(req.headers["x-exa-source"], "lykos");
      const body = JSON.parse(req.body) as Record<string, any>;
      assert.equal(body.jsonrpc, "2.0");
      assert.equal(typeof body.id, "string");
      assert.equal(body.method, "tools/call");
      assert.deepEqual(body.params, { name: "web_search_exa", arguments: { query: "vector databases", numResults: 4 } });
    } finally {
      await exa.close();
    }
  });

  it("a plain JSON reply parses to titles, URLs and the page text — never Exa's summaries", async () => {
    const exa = await fakeServer("/mcp", exaOk());
    try {
      const { tool } = chainTool({ endpoints: { exa: exa.url } });
      const res = await call(tool, { query: "alpha" });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.details.backend, "exa");
      assert.deepEqual(res.details.urls, ["https://alpha.com", "https://beta.com", "https://gamma.com"]);
      assert.match(res.text, /\(via exa\)/);
      assert.match(res.text, /1\. Page Alpha/);
      assert.match(res.text, /Full text of alpha/);
      // D2 and the ticket's "no answer synthesis": Exa's per-row summaries are a model's paraphrase.
      assert.doesNotMatch(res.text, /Alpha is about X|Beta covers Y|Gamma discusses Z/);
    } finally {
      await exa.close();
    }
  });

  it("an SSE reply parses the same way, through the plain-text payload parser", async () => {
    const exa = await fakeServer("/mcp", () => ({ status: 200, body: EXA_SSE_REPLY, contentType: "text/event-stream" }));
    try {
      const { tool } = chainTool({ endpoints: { exa: exa.url } });
      const res = await call(tool, { query: "plain text" });
      assert.equal(res.isError, false, res.text);
      assert.deepEqual(res.details.urls, ["https://plain.example"]);
      assert.match(res.text, /Plain Result/);
      assert.match(res.text, /Plain text body/);
      assert.doesNotMatch(res.text, /Reporter/, "the author is read past, not passed on");
    } finally {
      await exa.close();
    }
  });

  it("sends exaApiKey only when a key resolves", async () => {
    const exa = await fakeServer("/mcp", exaOk());
    try {
      const { tool } = chainTool({ endpoints: { exa: exa.url }, keys: { exa: "exa-secret" } });
      await call(tool, { query: "q" });
      const url = new URL(exa.requests[0]!.url, "http://127.0.0.1");
      assert.equal(url.searchParams.get("exaApiKey"), "exa-secret");
      assert.equal(url.searchParams.get("tools"), "web_search_exa");
      assert.equal(resolveAutoSearchKeys({ [EXA_SEARCH_KEY_ENV]: " k " }, join(tmpdir(), "lykos-no-such.db")).exa, "k");
    } finally {
      await exa.close();
    }
  });

  it("cuts Exa's page text to the snippet length at parse time", () => {
    const long = "x".repeat(5000);
    const parsed = parseExaMcpResponse(
      JSON.stringify({ jsonrpc: "2.0", id: "1", result: { results: [{ title: "Long", url: "https://long.example", text: long }] } }),
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.hits[0]!.snippet.length, WEB_SEARCH_SNIPPET_CHARS);
  });

  it("reads the error shapes: JSON-RPC error, tool isError, unparseable, unexpected", () => {
    assert.deepEqual(parseExaMcpResponse(JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code: -1, message: "boom" } })), {
      ok: false,
      reason: "MCP error: boom",
    });
    assert.deepEqual(
      parseExaMcpResponse(
        JSON.stringify({ jsonrpc: "2.0", id: "1", result: { isError: true, content: [{ type: "text", text: "tool quota exceeded" }] } }),
      ),
      { ok: false, reason: "tool quota exceeded" },
    );
    assert.deepEqual(parseExaMcpResponse("not json at all"), { ok: false, reason: "Failed to parse MCP response" });
    assert.deepEqual(parseExaMcpResponse(JSON.stringify({ jsonrpc: "2.0", id: "1", result: { content: [] } })), {
      ok: false,
      reason: "Exa MCP search returned unexpected response shape.",
    });
    assert.deepEqual(parseSSE("event: ping\ndata: [DONE]\ndata: {\"a\":1}\n"), { a: 1 });
  });

  it("a 429 falls through with the rate-limit message", async () => {
    const exa = await fakeServer("/mcp", () => ({ status: 429, body: "too many requests" }));
    const ddg = await fakeServer("/html/", ddgOk());
    try {
      const { tool } = chainTool({ endpoints: { exa: exa.url, duckduckgo: ddg.url } });
      const res = await call(tool, { query: "rate limited" });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.details.backend, "duckduckgo");
      assert.deepEqual(res.details.fellThrough, [EXA_RATE_LIMIT_MESSAGE]);
      assert.equal(EXA_RATE_LIMIT_MESSAGE, "exa: MCP rate limit reached (429); configure an Exa API key for higher limits");
    } finally {
      await exa.close();
      await ddg.close();
    }
  });

  it("names the source as lykos and the endpoint as Exa's hosted MCP", () => {
    assert.equal(EXA_MCP_SOURCE, "lykos");
    assert.equal(EXA_MCP_ENDPOINT, "https://mcp.exa.ai/mcp");
    const req = exaMcpRequest(EXA_MCP_ENDPOINT, "", { query: "q", include: [], exclude: [], count: 10 });
    assert.equal(req.url, "https://mcp.exa.ai/mcp?tools=web_search_exa");
  });
});

// ---------------------------------------------------------------------------
// Ticket 24 D8.2: DuckDuckGo
// ---------------------------------------------------------------------------

describe("Ticket 24 D3/D8.2: DuckDuckGo's HTML page, plain HTTP", () => {
  it("parses titles, URLs (redirects unwrapped) and snippets, once per URL", () => {
    assert.deepEqual(parseDuckDuckGoHtml(DDG_PAGE), [
      {
        title: "ERR_REQUIRE_ESM & ES modules",
        url: "https://nodejs.org/api/esm.html",
        snippet: "Node.js cannot require() an ES module 'x'.",
      },
      { title: "Fresh page", url: "https://example.com/fresh", snippet: "A recent article." },
    ]);
    assert.equal(unwrapDuckDuckGoUrl("//example.com/x"), "https://example.com/x");
    assert.equal(unwrapDuckDuckGoUrl("/relative"), undefined);
  });

  it("sends the form and browser headers", async () => {
    const ddg = await fakeServer("/html/", ddgOk());
    try {
      const { tool } = chainTool({ provider: "duckduckgo", endpoint: ddg.url, endpoints: {} });
      const res = await call(tool, { query: "ERR_REQUIRE_ESM", include_domains: ["nodejs.org", "example.com"] });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.details.backend, "duckduckgo");
      const req = ddg.requests[0]!;
      assert.equal(req.method, "POST");
      assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
      assert.equal(req.headers["referer"], "https://html.duckduckgo.com/");
      assert.equal(req.headers["sec-fetch-site"], "same-origin");
      assert.match(String(req.headers["user-agent"]), /Chrome\/149/);
      const form = new URLSearchParams(req.body);
      assert.deepEqual([...form.keys()], ["q", "kl", "b"]);
      assert.equal(form.get("q"), "ERR_REQUIRE_ESM (site:nodejs.org OR site:example.com)");
      assert.equal(form.get("kl"), "us-en");
      assert.equal(form.get("b"), "");
    } finally {
      await ddg.close();
    }
  });

  it("sets df from the recency map when a recency is given", () => {
    const req = duckDuckGoRequest(DUCKDUCKGO_HTML_ENDPOINT, { query: "q", include: [], exclude: [], count: 10 }, "week");
    assert.equal(new URLSearchParams(req.body).get("df"), "w");
    assert.equal(req.url, "https://html.duckduckgo.com/html/");
  });

  it("a challenge page is a failure, with the challenge reason", async () => {
    const ddg = await fakeServer("/html/", () => ({ status: 202, body: DDG_CHALLENGE_PAGE, contentType: "text/html" }));
    try {
      const { tool } = chainTool({ provider: "duckduckgo", endpoint: ddg.url, endpoints: {} });
      const res = await call(tool, { query: "blocked" });
      assert.equal(res.isError, true);
      assert.equal(res.details.success, false);
      assert.deepEqual(res.details.reasons, [`duckduckgo: ${DUCKDUCKGO_CHALLENGE_MESSAGE}`]);
    } finally {
      await ddg.close();
    }
  });

  it("an empty page is a failure, not an answer", async () => {
    const ddg = await fakeServer("/html/", ddgOk(DDG_EMPTY_PAGE));
    try {
      const { tool } = chainTool({ provider: "duckduckgo", endpoint: ddg.url, endpoints: {} });
      const res = await call(tool, { query: "nothing" });
      assert.equal(res.isError, true);
      assert.deepEqual(res.details.reasons, ["duckduckgo: no results parsed from the reply"]);
    } finally {
      await ddg.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Ticket 24 D8.3: the chain
// ---------------------------------------------------------------------------

describe("Ticket 24 D1/D4/D5/D8.3: the chain", () => {
  it("orders Brave, Perplexity, Exa, DuckDuckGo, and skips a keyed backend with no key", () => {
    assert.deepEqual(
      autoSearchChain({ brave: "b", perplexity: "p", exa: "" }).map((s) => s.backend),
      ["brave", "perplexity", "exa", "duckduckgo"],
    );
    assert.deepEqual(autoSearchChain({}).map((s) => s.backend), ["exa", "duckduckgo"]);
    assert.deepEqual(autoSearchChain({ perplexity: " " }).map((s) => s.endpoint), [EXA_MCP_ENDPOINT, DUCKDUCKGO_HTML_ENDPOINT]);
  });

  it("with no keys and no config, Exa answers and DuckDuckGo is never contacted", async () => {
    const exa = await fakeServer("/mcp", exaOk());
    const ddg = await fakeServer("/html/", ddgOk());
    const dir = mkdtempSync(join(tmpdir(), "lykos-t24-nokeys-"));
    try {
      // The tool's own default provider, and keys resolved from an empty
      // environment whose credential pool is a temp path that does not exist.
      const gate = new RecordingGate();
      const tool = buildWebSearchTool({
        cwd: process.cwd(),
        gate,
        env: { LYKOS_CREDENTIALS_DB: join(dir, "credentials.db") },
        endpoints: { exa: exa.url, duckduckgo: ddg.url },
      });
      const res = await call(tool, { query: "ERR_REQUIRE_ESM" });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.details.provider, "auto");
      assert.equal(res.details.backend, "exa");
      assert.equal(exa.requests.length, 1);
      assert.equal(ddg.requests.length, 0);
    } finally {
      await exa.close();
      await ddg.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Exa failing, DuckDuckGo answers, and the result names it", async () => {
    const exa = await fakeServer("/mcp", () => ({ status: 500, body: "internal\nerror" }));
    const ddg = await fakeServer("/html/", ddgOk());
    try {
      const { tool } = chainTool({ endpoints: { exa: exa.url, duckduckgo: ddg.url } });
      const res = await call(tool, { query: "ERR_REQUIRE_ESM" });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.details.backend, "duckduckgo");
      assert.match(res.text, /\(via duckduckgo\)/);
      assert.match(res.text, /https:\/\/nodejs\.org\/api\/esm\.html/);
      assert.deepEqual(res.details.fellThrough, ["exa: Exa MCP request failed (500): internal error"]);
    } finally {
      await exa.close();
      await ddg.close();
    }
  });

  it("both failing, the error lists each backend's reason on its own line", async () => {
    const exaUrl = await deadEndpoint("/mcp");
    const ddg = await fakeServer("/html/", () => ({ status: 200, body: DDG_CHALLENGE_PAGE, contentType: "text/html" }));
    try {
      const { tool } = chainTool({ endpoints: { exa: exaUrl, duckduckgo: ddg.url } });
      const res = await call(tool, { query: "nowhere" });
      assert.equal(res.isError, true);
      assert.equal(res.details.success, false);
      const lines = res.text.split("\n");
      assert.match(lines[0]!, /no search backend answered "nowhere"/);
      assert.match(lines[1]!, /^- exa: 127\.0\.0\.1:\d+ could not be reached/);
      assert.equal(lines[2], `- duckduckgo: ${DUCKDUCKGO_CHALLENGE_MESSAGE}`);
      assert.equal(lines.length, 3);
    } finally {
      await ddg.close();
    }
  });

  it("a Brave key means Brave answers and neither keyless host is contacted", async () => {
    const brave = await fakeServer("/res/v1/web/search", () => ({
      status: 200,
      body: JSON.stringify(BRAVE_PAYLOAD),
      contentType: "application/json",
    }));
    const exa = await fakeServer("/mcp", exaOk());
    const ddg = await fakeServer("/html/", ddgOk());
    try {
      const { tool, gate } = chainTool({
        keys: { brave: "brave-key" },
        endpoints: { brave: brave.url, exa: exa.url, duckduckgo: ddg.url },
      });
      const res = await call(tool, { query: "widget library" });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.details.backend, "brave");
      assert.match(res.text, /\(via brave\)/);
      assert.equal(brave.requests[0]!.headers["x-subscription-token"], "brave-key");
      assert.equal(exa.requests.length, 0);
      assert.equal(ddg.requests.length, 0);
      assert.equal((gate as RecordingGate).seen.length, 1, "only the host contacted was put to the gate");
    } finally {
      await brave.close();
      await exa.close();
      await ddg.close();
    }
  });

  it("a Brave key that is rejected falls through to the keyless chain", async () => {
    const brave = await fakeServer("/res/v1/web/search", () => ({ status: 401, body: "{}" }));
    const exa = await fakeServer("/mcp", exaOk());
    try {
      const { tool } = chainTool({ keys: { brave: "bad" }, endpoints: { brave: brave.url, exa: exa.url } });
      const res = await call(tool, { query: "q" });
      assert.equal(res.details.backend, "exa");
      assert.deepEqual(res.details.fellThrough, ["brave: 401 unauthorized"]);
    } finally {
      await brave.close();
      await exa.close();
    }
  });

  it("every host goes through the gate before its request, and a denied host falls through", async () => {
    const exa = await fakeServer("/mcp", exaOk());
    const ddg = await fakeServer("/html/", ddgOk());
    const exaHost = new URL(exa.url).host;
    const ddgHost = new URL(ddg.url).host;
    class DenyExa implements ApprovalGate {
      readonly seen: ApprovalRequest[] = [];
      async request(req: ApprovalRequest): Promise<ApprovalDecision> {
        this.seen.push(req);
        return req.summary.includes(exaHost) ? "deny" : "allow";
      }
    }
    const gate = new DenyExa();
    try {
      const { tool, denials } = chainTool({ endpoints: { exa: exa.url, duckduckgo: ddg.url }, gate });
      const res = await call(tool, { query: "gated" });
      assert.equal(res.isError, false, res.text);
      assert.equal(res.details.backend, "duckduckgo");
      assert.equal(exa.requests.length, 0, "a denied host is sent nothing");
      assert.equal(gate.seen.length, 2);
      assert.equal(gate.seen[0]!.kind, "read");
      assert.match(gate.seen[0]!.summary, new RegExp(exaHost.replace(/\./g, "\\.")));
      assert.match(gate.seen[1]!.summary, new RegExp(ddgHost.replace(/\./g, "\\.")));
      assert.match(res.details.fellThrough[0], /^exa: the gate denied /);
      assert.equal(denials.userRejected, 1);
    } finally {
      await exa.close();
      await ddg.close();
    }
  });

  it("applies the domain lists to every backend's results, and sends them as site: operators to Exa", async () => {
    const exa = await fakeServer("/mcp", exaOk());
    try {
      const { tool } = chainTool({ endpoints: { exa: exa.url } });
      const res = await call(tool, { query: "pages", include_domains: ["beta.com"], exclude_domains: ["spam.example"] });
      assert.deepEqual(res.details.urls, ["https://beta.com"]);
      const args = (JSON.parse(exa.requests[0]!.body) as { params: { arguments: { query: string } } }).params.arguments;
      assert.equal(args.query, "pages site:beta.com -site:spam.example");
    } finally {
      await exa.close();
    }
  });

  it("results that all fall outside the domain lists are a failure, and the next backend runs", async () => {
    const exa = await fakeServer("/mcp", exaOk());
    const ddg = await fakeServer("/html/", ddgOk());
    try {
      const { tool } = chainTool({ endpoints: { exa: exa.url, duckduckgo: ddg.url } });
      const res = await call(tool, { query: "esm", include_domains: ["nodejs.org"] });
      assert.equal(res.details.backend, "duckduckgo");
      assert.deepEqual(res.details.urls, ["https://nodejs.org/api/esm.html"]);
      assert.deepEqual(res.details.fellThrough, ["exa: 3 results, none on the requested domains"]);
    } finally {
      await exa.close();
      await ddg.close();
    }
  });

  it("the Perplexity key `auto` consults comes from the pool first, as the explicit provider's does", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t24-pool-"));
    const dbPath = join(dir, "credentials.db");
    try {
      const db = openCredentialDb(dbPath, { create: true })!;
      upsertCredential(db, "perplexity", { type: "api_key", key: "pooled-perplexity-key" });
      db.close();
      const keys = resolveAutoSearchKeys({ LYKOS_CREDENTIALS_DB: dbPath, BRAVE_SEARCH_API_KEY: "b" });
      assert.deepEqual(keys, { brave: "b", perplexity: "pooled-perplexity-key", exa: "" });
      assert.deepEqual(autoSearchChain(keys).map((s) => s.backend), ["brave", "perplexity", "exa", "duckduckgo"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Ticket 24 D8.4: nothing asks for a summary or an answer
// ---------------------------------------------------------------------------

describe("Ticket 24 D8.4: no request asks for a summary or an answer", () => {
  it("Exa is sent a query and a count, and DuckDuckGo a query, a region and the empty b", () => {
    const q = { query: "widgets", include: [], exclude: [], count: 7 };
    const exaBody = JSON.parse(exaMcpRequest(EXA_MCP_ENDPOINT, "", q).body ?? "{}") as Record<string, any>;
    assert.deepEqual(Object.keys(exaBody).sort(), ["id", "jsonrpc", "method", "params"]);
    assert.deepEqual(Object.keys(exaBody.params).sort(), ["arguments", "name"]);
    assert.deepEqual(Object.keys(exaBody.params.arguments).sort(), ["numResults", "query"]);
    assert.doesNotMatch(JSON.stringify(exaBody), /summary|answer|contents/i);
    const form = new URLSearchParams(duckDuckGoRequest(DUCKDUCKGO_HTML_ENDPOINT, q).body ?? "");
    assert.deepEqual([...form.keys()].sort(), ["b", "kl", "q"]);
  });
});
