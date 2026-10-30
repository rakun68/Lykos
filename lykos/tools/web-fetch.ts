// Read one web page and hand back the markdown.
//
// **THE ADDRESS POLICY IS THE POINT OF THIS FILE (D4), AND IT IS A SECURITY
// PROPERTY RATHER THAN A FEATURE.** A tool that fetches a URL a model chose is
// a request forger sitting inside the developer's own network: `http://
// 169.254.169.254/latest/meta-data/` is a cloud credential, `http://
// 127.0.0.1:9200/` is whatever the developer happens to be running, and both
// are one sentence away in any page the model was told to read. So every
// address is refused BEFORE the request and on the RESOLVED address —
// `resolveTarget()` rejects a non-http/https scheme, rejects any userinfo,
// upgrades `http` to `https`, then resolves the host and refuses loopback,
// private, link-local, unique-local and unspecified ranges in both IPv4 and
// IPv6, whether the URL carried a literal address or a name that resolves to
// one.
//
// **AND IT RUNS AGAIN ON EVERY REDIRECT HOP.** A check that runs only on the
// first URL stops nothing: the attack is a public host answering `302
// Location: http://10.0.0.5/`, and the rebinding version of it is the SAME
// host resolving to a public address the first time and a private one the
// second. `web-fetch.test.ts` drives exactly that second case — same hostname,
// second resolution private — because it is the one a cross-host rule cannot
// catch, and it is therefore the test that fails the moment the per-hop check
// is removed.
//
// **REDIRECTS: SAME HOST FOLLOWS, CROSS HOST REPORTS (D5).** A cross-host
// redirect comes back as text naming both URLs and the tool stops, so the
// model decides whether to follow rather than the page deciding for it.
// "Same host" here is the hostname compared case-insensitively, so `http` to
// `https` and a port change on one host are both follows. D5 words this as the
// *registrable* host; a correct registrable-host comparison needs a public
// suffix list, which would be a fourth dependency (D1 says three), and the
// naive last-two-labels version of it is not conservative — it would call
// `evil.co.uk` and `bank.co.uk` the same host. Hostname equality is strictly
// tighter than what D5 asks for and never wrong in the unsafe direction; the
// cost is that a `www.` redirect is reported rather than followed, which costs
// the model one more call.
//
// **NO HEADLESS BROWSER, AND A PAGE THAT NEEDS ONE IS TOLD SO (D8).** When
// Readability finds nothing usable the tool says the page could not be
// extracted, names the likely reason, and returns the title and the URL. It
// never returns an empty string as a success: a model handed "" concludes the
// page is empty and writes that down.
//
// **PAGINATION IS ON THE PRODUCED MARKDOWN, THE BYTE CAP IS ON THE DOWNLOAD
// (D6).** Two different limits with two different jobs. The cap is applied
// while the body streams, so a hostile ten-gigabyte response costs this
// process `WEB_FETCH_MAX_BYTES` and not a minute of memory pressure; the page
// size is characters of markdown, because that is what the model pays for.
//
// **THE CACHE DIES WITH THE SESSION (D7).** A plain `Map`, bounded, with a
// short time to live, created per `buildWebFetchTool()` — which is once per
// session, in `loadTools()`. It is not persisted and it is not the ledger.
//
// **NO TEST REACHES THE NETWORK (D9).** Both seams are injected: `fetcher` is
// fetch-shaped and `resolve` is the DNS lookup. The tests start `node:http`
// servers of their own and hand in a fetcher that rewrites the origin onto
// them, so redirects, streaming and the byte cap are exercised for real
// against a server the test owns.
//
// **THE SCHEMA TAX, RECORDED AT THE MOMENT THE TOOL IS ADDED (AGENTS.md rule
// 3): this tool is RESIDENT (D10), so it rides every request of every
// session.** Priced alone, and as the move it makes in the resident surface,
// in `web-fetch.test.ts` — so a description that doubles the bill fails a test
// rather than passing silently.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Type } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ApprovalDeniedError, authorizeNetworkRead, type ApprovalGate, type DenialLog } from "../gate/approval.js";

export const WEB_FETCH_TOOL_NAME = "web_fetch";

/** The hard cap on the raw download, applied while the body streams (D6). */
export const WEB_FETCH_MAX_BYTES = 2_000_000;

/** One page of produced markdown (D6). Characters, not bytes: this is what the model pays for. */
export const WEB_FETCH_PAGE_CHARS = 20_000;

/** How many redirect hops are followed before the tool stops and says so (D5). */
export const WEB_FETCH_MAX_REDIRECTS = 5;

/** How long one request may take before it is abandoned. */
export const WEB_FETCH_TIMEOUT_MS = 30_000;

/** Entries kept in the session cache (D7). Small on purpose: this is a convenience, not a store. */
export const WEB_FETCH_CACHE_MAX = 16;

/** How long a cached page is still considered current (D7). */
export const WEB_FETCH_CACHE_TTL_MS = 15 * 60 * 1000;

/** What the tool sends as its `User-Agent`. A server that wants to refuse a robot should be able to see one saying what it is. */
export const WEB_FETCH_USER_AGENT = "lykos-web-fetch/1.0 (Lykos coding agent)";

// ---------------------------------------------------------------------------
// D4: the address policy
// ---------------------------------------------------------------------------

/**
 * Hostname -> the addresses it resolves to. The DNS seam (D9).
 *
 * Injected rather than called directly so a test can say "this name is public
 * on the first lookup and private on the second" — which is the rebinding
 * attack, and the only way to exercise the per-hop check with a hostname that
 * never changes.
 */
export type HostResolver = (hostname: string) => Promise<string[]>;

/** The real one. The only thing in this module that talks to a resolver. */
export const SYSTEM_HOST_RESOLVER: HostResolver = async (hostname) => {
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((a) => a.address);
};

function v4Octets(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((p) => Number.parseInt(p, 10));
  return octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? octets : undefined;
}

/**
 * Why this IPv4 address may not be fetched, or undefined when it may.
 *
 * Wider than D4's five names, deliberately. Carrier-grade NAT, the IETF
 * protocol block, the benchmarking block and multicast are all addresses that
 * cannot host a document a coding agent wants and CAN host something on the
 * local network; refusing them costs nothing real and the alternative is
 * enumerating them again the first time one is used against us.
 */
export function blockedV4Reason(address: string): string | undefined {
  const o = v4Octets(address);
  if (o === undefined) return `${address} is not an IPv4 address`;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return `${address} is in the unspecified range 0.0.0.0/8`;
  if (a === 10) return `${address} is a private address (10.0.0.0/8)`;
  if (a === 127) return `${address} is a loopback address (127.0.0.0/8)`;
  if (a === 169 && b === 254) return `${address} is a link-local address (169.254.0.0/16)`;
  if (a === 172 && b >= 16 && b <= 31) return `${address} is a private address (172.16.0.0/12)`;
  if (a === 192 && b === 168) return `${address} is a private address (192.168.0.0/16)`;
  if (a === 100 && b >= 64 && b <= 127) return `${address} is a carrier-grade NAT address (100.64.0.0/10)`;
  if (a === 192 && b === 0 && o[2] === 0) return `${address} is in the IETF protocol block (192.0.0.0/24)`;
  if (a === 198 && (b === 18 || b === 19)) return `${address} is in the benchmarking block (198.18.0.0/15)`;
  if (a >= 224) return `${address} is a multicast or reserved address (224.0.0.0/4 and above)`;
  return undefined;
}

/** The first 16-bit group of an IPv6 address, with `::…` reading as zero. */
function v6FirstWord(address: string): number | undefined {
  const head = address.split("%")[0]!.split(":")[0]!;
  if (head === "") return 0;
  const n = Number.parseInt(head, 16);
  return Number.isNaN(n) ? undefined : n;
}

/** Why this IPv6 address may not be fetched, or undefined when it may. */
export function blockedV6Reason(raw: string): string | undefined {
  const address = raw.split("%")[0]!.toLowerCase();
  if (address === "::") return `${raw} is the unspecified address (::)`;
  if (address === "::1") return `${raw} is the IPv6 loopback address (::1)`;
  // An IPv4-mapped or IPv4-compatible address is an IPv4 address wearing a
  // hat: `::ffff:127.0.0.1` reaches the same loopback interface, so it is
  // answered by the IPv4 rules rather than by the first-word rules below.
  const mapped = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) {
    const inner = blockedV4Reason(mapped[1]!);
    return inner === undefined ? undefined : `${raw} maps to an address that is refused: ${inner}`;
  }
  const word = v6FirstWord(address);
  if (word === undefined) return `${raw} is not an IPv6 address`;
  if ((word & 0xfe00) === 0xfc00) return `${raw} is a unique-local address (fc00::/7)`;
  if ((word & 0xffc0) === 0xfe80) return `${raw} is a link-local address (fe80::/10)`;
  if ((word & 0xff00) === 0xff00) return `${raw} is a multicast address (ff00::/8)`;
  if (word === 0) return `${raw} is in the unspecified range (::/8)`;
  return undefined;
}

/** Why this address may not be fetched, whichever family it is in, or undefined when it may. */
export function blockedAddressReason(address: string): string | undefined {
  const family = isIP(address.split("%")[0] ?? address);
  if (family === 4) return blockedV4Reason(address);
  if (family === 6) return blockedV6Reason(address);
  return `${address} is not an IP address`;
}

/** `[::1]` as `URL.hostname` spells it, without the brackets. */
function bareHostname(url: URL): string {
  const host = url.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export type TargetVerdict = { ok: true; url: URL; addresses: string[] } | { ok: false; reason: string };

/**
 * D4, whole: scheme, userinfo, upgrade, resolve, refuse.
 *
 * Called on the URL the model gave AND on every redirect destination, with
 * nothing remembered in between — a host that answered from a public address
 * a moment ago gets resolved and judged again, because that is what a DNS
 * rebinding attack counts on nobody doing.
 */
export async function resolveTarget(raw: string, resolve: HostResolver): Promise<TargetVerdict> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: `${JSON.stringify(raw)} is not a URL. Pass an absolute http or https URL.` };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return {
      ok: false,
      reason:
        `refused: ${url.protocol}// is not a scheme this tool fetches. Only http and https are, and http is ` +
        `upgraded to https. A file on this machine is what \`read\` is for.`,
    };
  }

  if (url.username !== "" || url.password !== "") {
    return {
      ok: false,
      reason:
        `refused: this URL carries credentials in it (the part before the "@"). Lykos never sends a credential ` +
        `it found in a URL, so nothing was requested. Fetch the page without the credentials, or ask a human to ` +
        `configure the access properly.`,
    };
  }

  // The upgrade, before the address check, so what is judged is what would be
  // requested. A URL with an explicit non-default port keeps it.
  if (url.protocol === "http:") url.protocol = "https:";

  const host = bareHostname(url);
  if (host === "") return { ok: false, reason: `refused: ${JSON.stringify(raw)} names no host.` };

  if (isIP(host) !== 0) {
    const blocked = blockedAddressReason(host);
    if (blocked !== undefined) {
      return { ok: false, reason: `refused: ${blocked}. Addresses inside a private network are never fetched.` };
    }
    return { ok: true, url, addresses: [host] };
  }

  let addresses: string[];
  try {
    addresses = await resolve(host);
  } catch (err) {
    return { ok: false, reason: `refused: ${host} did not resolve (${(err as Error).message}). Nothing was requested.` };
  }
  if (addresses.length === 0) {
    return { ok: false, reason: `refused: ${host} resolved to no addresses. Nothing was requested.` };
  }
  for (const address of addresses) {
    const blocked = blockedAddressReason(address);
    if (blocked !== undefined) {
      return {
        ok: false,
        reason:
          `refused: ${host} resolves to ${address}, and ${blocked}. A name that points inside a private network ` +
          `is refused exactly as a literal one is, so nothing was requested.`,
      };
    }
  }
  return { ok: true, url, addresses };
}

// ---------------------------------------------------------------------------
// D9: the fetch seam
// ---------------------------------------------------------------------------

/** The bytes of one response, read the way a stream is read so the cap can stop it. */
export interface WebBodyReader {
  read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>;
  cancel(): Promise<unknown>;
}

export interface WebResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  body: { getReader(): WebBodyReader } | null;
}

export interface WebRequestInit {
  redirect: "manual";
  headers: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * The seam every test replaces (D9).
 *
 * `redirect: "manual"` is not a preference — the whole of D4's per-hop check
 * and D5's cross-host rule depend on this tool seeing each hop itself, and a
 * fetcher that followed redirects internally would hand back a body from an
 * address nothing ever judged.
 */
export type WebFetcher = (url: string, init: WebRequestInit) => Promise<WebResponseLike>;

/** The real one, and the only thing in this module that opens a socket. */
export const SYSTEM_WEB_FETCHER: WebFetcher = (url, init) =>
  fetch(url, init) as unknown as Promise<WebResponseLike>;

export interface CappedBody {
  bytes: Buffer;
  truncated: boolean;
}

/** Read a body, stopping at `cap`. The stream is cancelled at the cap rather than drained (D6). */
export async function readCapped(body: { getReader(): WebBodyReader } | null, cap: number): Promise<CappedBody> {
  if (body === null) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined || value.byteLength === 0) continue;
    const room = cap - total;
    if (value.byteLength >= room) {
      chunks.push(Buffer.from(value.subarray(0, room)));
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks), truncated: true };
    }
    chunks.push(Buffer.from(value));
    total += value.byteLength;
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}

// ---------------------------------------------------------------------------
// D8: extraction, and the sentence when it fails
// ---------------------------------------------------------------------------

export interface Extraction {
  title: string;
  markdown: string;
  /** Set when nothing usable came out; the caller turns it into D8's sentence. */
  failure?: string;
}

function documentTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const raw = m?.[1]?.replace(/\s+/g, " ").trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * The likely reason Readability found nothing, in words a model can act on.
 *
 * A heuristic and labelled as one: a page whose body carries scripts and
 * almost no text is the shape of an application that draws itself, and the
 * honest thing to say is that this tool runs no JavaScript.
 */
export function extractionFailureReason(html: string): string {
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length < 200 && scripts > 0) {
    return "the page looks client-rendered — its text arrives from JavaScript, and this tool runs none";
  }
  if (text.length < 200) {
    return "the page carries almost no text";
  }
  return "the page is not an article — Readability found no main content block in it";
}

/** HTML in, markdown out, with `failure` set when there is nothing worth returning (D8). */
export function extractArticle(html: string, url: string): Extraction {
  const fallbackTitle = documentTitle(html) ?? url;
  // The document type is Readability's own, taken from its constructor rather
  // than from a global `Document` — this project's `lib` is ES2022 with no DOM,
  // deliberately, and linkedom's document is not the browser's anyway.
  type ReadabilityDocument = ConstructorParameters<typeof Readability>[0];
  let article: { title?: string | null | undefined; content?: string | null | undefined } | null = null;
  try {
    const { document } = parseHTML(html);
    article = new Readability(document as unknown as ReadabilityDocument).parse();
  } catch {
    // A parser that threw is a page that could not be extracted, which is the
    // same answer as a page Readability declined — and the same sentence.
    article = null;
  }
  const content = article?.content ?? "";
  if (content.trim() === "") {
    return { title: fallbackTitle, markdown: "", failure: extractionFailureReason(html) };
  }
  let markdown: string;
  try {
    // ATX headings, fenced code and `-` bullets: the markdown a coding agent
    // already reads everywhere else in this project, rather than turndown's
    // setext-and-asterisk defaults.
    markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" })
      .turndown(content)
      .trim();
  } catch {
    return { title: article?.title ?? fallbackTitle, markdown: "", failure: "the extracted article could not be converted to markdown" };
  }
  if (markdown === "") {
    return { title: article?.title ?? fallbackTitle, markdown: "", failure: extractionFailureReason(html) };
  }
  return { title: article?.title?.trim() || fallbackTitle, markdown };
}

// ---------------------------------------------------------------------------
// D7: the session cache
// ---------------------------------------------------------------------------

export interface CachedPage {
  finalUrl: string;
  title: string;
  markdown: string;
  contentType: string;
  /** The raw download hit `WEB_FETCH_MAX_BYTES`. */
  truncated: boolean;
  bytes: number;
  storedAt: number;
}

export interface FetchCache {
  entries: Map<string, CachedPage>;
}

export function newFetchCache(): FetchCache {
  return { entries: new Map() };
}

export function cacheLookup(cache: FetchCache, key: string, now: number): CachedPage | undefined {
  const hit = cache.entries.get(key);
  if (hit === undefined) return undefined;
  if (now - hit.storedAt > WEB_FETCH_CACHE_TTL_MS) {
    cache.entries.delete(key);
    return undefined;
  }
  return hit;
}

/**
 * Stored under both the requested URL and the final one.
 *
 * D7 says the cache is keyed by the final URL, and it is — but a lookup has to
 * happen BEFORE the request that discovers what the final URL is, so the
 * requested URL is a second key onto the same entry rather than a second
 * entry.
 */
export function cacheStore(cache: FetchCache, keys: readonly string[], page: CachedPage): void {
  for (const key of keys) {
    cache.entries.delete(key);
    cache.entries.set(key, page);
  }
  while (cache.entries.size > WEB_FETCH_CACHE_MAX) {
    const oldest = cache.entries.keys().next();
    if (oldest.done === true) break;
    cache.entries.delete(oldest.value);
  }
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export const WEB_FETCH_DESCRIPTION =
  "Read one web page and get it back as markdown. Use it for documentation, a release note, an RFC, a blog " +
  "post — anything whose current text matters more than what you remember about it. The article is extracted " +
  "and the navigation, adverts and footer are dropped. `http://` is upgraded to `https://`, a URL carrying " +
  "credentials is refused, and so is any address inside a private network, on every redirect as well as on the " +
  "URL you passed. A redirect to a different host is reported rather than followed: you get both URLs and " +
  "decide. There is no browser here, so a page that draws itself with JavaScript says so instead of coming " +
  "back empty. Long pages are paginated — the result names the next `offset` — and a page read twice in one " +
  "session is served from memory. For a file in a GitHub repository use github, not this.";

export const WEB_FETCH_PARAMETERS = Type.Object({
  url: Type.String({ description: "The absolute http or https URL of the page to read." }),
  offset: Type.Optional(
    Type.Number({
      description: `Character offset into the page's markdown, for reading on past the first page (default 0, page size ${WEB_FETCH_PAGE_CHARS}).`,
    }),
  ),
  refresh: Type.Optional(
    Type.Boolean({ description: "Ignore this session's cached copy and fetch the page again." }),
  ),
});

export interface WebFetchToolOpts {
  cwd: string;
  gate: ApprovalGate;
  denials?: DenialLog;
  /** D9: the fetch seam. Omitted, the runtime's own `fetch`; every test passes a stub. */
  fetcher?: WebFetcher;
  /** D9/D4: the DNS seam. Omitted, the system resolver. */
  resolve?: HostResolver;
  /** D7: the session's cache. Omitted, one is created here — which is per-session, because `loadTools()` runs once per session. */
  cache?: FetchCache;
  /** Injected so a cache-expiry test does not have to wait fifteen minutes. */
  now?: () => number;
}

function text(s: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text" as const, text: s }];
}

interface WebFetchResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  details: Record<string, unknown>;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Throw a response body away without reading it, for a hop whose content is not the answer. */
function discardBody(response: WebResponseLike): void {
  try {
    void response.body?.getReader().cancel().catch(() => undefined);
  } catch {
    // A body that cannot be cancelled is a body the runtime will collect.
  }
}

/** What the model is told when a redirect leaves the host it asked for (D5). Exported so the test asserts the shape rather than a substring of a sentence that may be reworded. */
export function crossHostNotice(from: string, to: string): string {
  return (
    `${from} redirects to ${to}, which is a different host, so nothing further was fetched. This tool follows a ` +
    `redirect only while it stays on the same host — a redirect across hosts is a decision, and it is yours. ` +
    `Call web_fetch again with ${to} if that is where you want to go.`
  );
}

/** The page's markdown, cut to one page, plus the note that says how to get the next one (D6). */
export function paginate(markdown: string, offset: number): { page: string; nextOffset: number | undefined; total: number } {
  const total = markdown.length;
  const start = Number.isFinite(offset) && offset > 0 ? Math.min(Math.floor(offset), total) : 0;
  const page = markdown.slice(start, start + WEB_FETCH_PAGE_CHARS);
  const end = start + page.length;
  return { page, nextOffset: end < total ? end : undefined, total };
}

function contentTypeOf(response: WebResponseLike): string {
  return (response.headers.get("content-type") ?? "").toLowerCase();
}

function isHtml(contentType: string): boolean {
  return contentType.includes("text/html") || contentType.includes("application/xhtml");
}

function isPlainText(contentType: string): boolean {
  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("x-yaml")
  );
}

export function buildWebFetchTool(opts: WebFetchToolOpts): ToolDefinition {
  const fetcher = opts.fetcher ?? SYSTEM_WEB_FETCHER;
  const resolve = opts.resolve ?? SYSTEM_HOST_RESOLVER;
  // Per-session by construction: this runs once per `loadTools()` call, so one
  // session's pages cannot be served to the next session in this process.
  const cache = opts.cache ?? newFetchCache();
  const now = opts.now ?? (() => Date.now());

  return defineTool({
    name: WEB_FETCH_TOOL_NAME,
    label: "Web fetch",
    description: WEB_FETCH_DESCRIPTION,
    promptSnippet: "Read a web page as markdown",
    promptGuidelines: [
      "Read the page before answering from memory whenever a library's current behaviour is what matters.",
      "A private, loopback or link-local address is refused by design; do not try to work around it.",
    ],
    parameters: WEB_FETCH_PARAMETERS,
    async execute(_toolCallId, params, signal): Promise<WebFetchResult> {
      const requested = String((params as { url?: unknown }).url ?? "").trim();
      if (requested === "") {
        const reason = "lykos web_fetch: `url` is empty. Pass the absolute http or https URL of the page to read.";
        return { content: text(reason), isError: true, details: { error: reason } };
      }
      const offset = Number((params as { offset?: unknown }).offset ?? 0);
      const refresh = (params as { refresh?: unknown }).refresh === true;

      // D4, on the URL the model gave, before anything is requested.
      const first = await resolveTarget(requested, resolve);
      if (!first.ok) {
        return {
          content: text(`lykos web_fetch: ${first.reason}`),
          isError: true,
          details: { url: requested, refused: true, error: first.reason },
        };
      }
      const startUrl = first.url.href;

      const cached = refresh ? undefined : cacheLookup(cache, startUrl, now());
      if (cached !== undefined) {
        return renderPage(cached, requested, offset, true);
      }

      try {
        await authorizeNetworkRead(opts.cwd, opts.gate, `fetch ${startUrl}`, startUrl, opts.denials);
      } catch (err) {
        if (err instanceof ApprovalDeniedError) {
          return { content: text(err.message), isError: true, details: { url: startUrl, error: err.message } };
        }
        throw err;
      }

      let current = startUrl;
      let hops = 0;
      let response: WebResponseLike;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), WEB_FETCH_TIMEOUT_MS);
      const onAbort = (): void => controller.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        for (;;) {
          try {
            response = await fetcher(current, {
              redirect: "manual",
              headers: {
                accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
                "accept-language": "en",
                "user-agent": WEB_FETCH_USER_AGENT,
              },
              signal: controller.signal,
            });
          } catch (err) {
            const reason = `lykos web_fetch: ${current} could not be reached (${(err as Error).message}).`;
            return { content: text(reason), isError: true, details: { url: current, error: reason } };
          }

          const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get("location") : null;
          if (location === null || location === "") break;
          // A redirect's own body is never read, so it is cancelled rather
          // than left for the runtime to notice — an undrained body holds a
          // socket open, and a chain of five of them holds five.
          discardBody(response);

          hops += 1;
          if (hops > WEB_FETCH_MAX_REDIRECTS) {
            const reason =
              `lykos web_fetch: ${startUrl} redirected more than ${WEB_FETCH_MAX_REDIRECTS} times, so the tool ` +
              `stopped. The last hop was ${current}.`;
            return { content: text(reason), isError: true, details: { url: startUrl, hops, error: reason } };
          }

          let destination: string;
          try {
            destination = new URL(location, current).href;
          } catch {
            const reason = `lykos web_fetch: ${current} redirected to ${JSON.stringify(location)}, which is not a URL.`;
            return { content: text(reason), isError: true, details: { url: current, error: reason } };
          }

          // **D4 AGAIN, ON THE HOP.** This is the check the module comment is
          // about. It runs before the cross-host rule below, so a redirect
          // into a private network is refused on the strongest ground
          // available rather than merely reported as leaving the host — and
          // so that a SAME-host redirect whose second resolution is private
          // (DNS rebinding) is refused at all, which the cross-host rule
          // cannot do.
          const hop = await resolveTarget(destination, resolve);
          if (!hop.ok) {
            const reason =
              `lykos web_fetch: ${current} redirected to ${destination} and that hop was ${hop.reason} Nothing ` +
              `from it was read.`;
            return {
              content: text(reason),
              isError: true,
              details: { url: startUrl, redirectedTo: destination, refused: true, hops, error: reason },
            };
          }

          const fromHost = new URL(current).hostname.toLowerCase();
          const toHost = hop.url.hostname.toLowerCase();
          if (fromHost !== toHost) {
            const notice = crossHostNotice(current, hop.url.href);
            return {
              content: text(notice),
              details: { url: startUrl, redirectedTo: hop.url.href, followed: false, hops },
            };
          }
          current = hop.url.href;
        }

        if (response.status < 200 || response.status >= 300) {
          const reason = `lykos web_fetch: ${current} answered HTTP ${response.status}, so there is no page to read.`;
          return { content: text(reason), isError: true, details: { url: current, status: response.status, error: reason } };
        }

        const contentType = contentTypeOf(response);
        const body = await readCapped(response.body, WEB_FETCH_MAX_BYTES);
        const raw = body.bytes.toString("utf8");

        let page: CachedPage;
        if (isHtml(contentType) || (contentType === "" && /^\s*<(!doctype|html)/i.test(raw))) {
          const extracted = extractArticle(raw, current);
          if (extracted.failure !== undefined) {
            // D8: never an empty success. The title and the URL are what the
            // model has left to work with, so they are what it gets.
            const reason =
              `The page at ${current} could not be extracted: ${extracted.failure}.\n\n` +
              `title: ${extracted.title}\nurl: ${current}\n\n` +
              `Try a documentation or print URL for the same content, or search for another source. Lykos has no ` +
              `headless browser and will not grow one.`;
            return {
              content: text(reason),
              details: {
                url: startUrl,
                finalUrl: current,
                title: extracted.title,
                extracted: false,
                reason: extracted.failure,
                bytes: body.bytes.length,
              },
            };
          }
          page = {
            finalUrl: current,
            title: extracted.title,
            markdown: extracted.markdown,
            contentType: contentType === "" ? "text/html" : contentType,
            truncated: body.truncated,
            bytes: body.bytes.length,
            storedAt: now(),
          };
        } else if (isPlainText(contentType)) {
          // D8 applies here too, and this is the branch it is easy to forget:
          // a `text/plain` body of zero bytes would otherwise be a page whose
          // markdown is "" reported as a success, and a model handed that
          // writes down that the page is empty.
          if (raw.trim() === "") {
            const reason =
              `${current} answered with an empty ${contentType} body — there is no text on it to return. It may ` +
              `require a session, or the content may be somewhere else on the site.`;
            return {
              content: text(reason),
              details: { url: startUrl, finalUrl: current, contentType, bytes: body.bytes.length, extracted: false },
            };
          }
          page = {
            finalUrl: current,
            title: current,
            markdown: raw.trim(),
            contentType,
            truncated: body.truncated,
            bytes: body.bytes.length,
            storedAt: now(),
          };
        } else {
          const reason =
            `${current} is ${contentType === "" ? "a response with no content type" : contentType}, which is not ` +
            `text, so there is nothing to convert to markdown (${body.bytes.length} bytes were read and ` +
            `discarded). Download it with bash if you need the file itself.`;
          return {
            content: text(reason),
            details: { url: startUrl, finalUrl: current, contentType, bytes: body.bytes.length, extracted: false },
          };
        }

        cacheStore(cache, startUrl === current ? [startUrl] : [current, startUrl], page);
        return renderPage(page, requested, offset, false);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  }) as ToolDefinition;
}

function renderPage(page: CachedPage, requested: string, offset: number, fromCache: boolean): WebFetchResult {
  const { page: slice, nextOffset, total } = paginate(page.markdown, offset);
  const header = [`# ${page.title}`, page.finalUrl];
  if (page.finalUrl !== requested) header.push(`(requested ${requested})`);
  if (fromCache) header.push("(from this session's cache — pass refresh: true to fetch it again)");
  if (page.truncated) {
    header.push(
      `(The download passed the ${WEB_FETCH_MAX_BYTES}-byte cap and was cut, so this page is a prefix of the ` +
        `real one, not all of it.)`,
    );
  }
  const footer =
    nextOffset === undefined
      ? total > WEB_FETCH_PAGE_CHARS
        ? `\n\n(Characters ${offset > 0 ? Math.floor(offset) : 0}–${total} of ${total}. This is the end of the page.)`
        : ""
      : `\n\n(Characters ${offset > 0 ? Math.floor(offset) : 0}–${nextOffset} of ${total}. Call web_fetch again with ` +
        `offset: ${nextOffset} for the next page.)`;
  return {
    content: text(`${header.join("\n")}\n\n${slice}${footer}`),
    details: {
      url: requested,
      finalUrl: page.finalUrl,
      title: page.title,
      contentType: page.contentType,
      bytes: page.bytes,
      truncated: page.truncated,
      cached: fromCache,
      characters: total,
      offset: offset > 0 ? Math.floor(offset) : 0,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
    },
  };
}
