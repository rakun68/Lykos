// `web_fetch`: D4's address policy, D5's redirect rule, D6's two limits, D7's
// cache, D8's sentence and D10's tax.
//
// **NO TEST HERE REACHES THE NETWORK, AND NONE CAN (D9).** Every test builds
// the tool with an injected fetcher and an injected resolver.
// `SYSTEM_WEB_FETCHER` and `SYSTEM_HOST_RESOLVER` — the only things in
// `web-fetch.ts` that talk to a socket or a resolver — are never constructed
// here. The fetcher is not a stub that pretends: it is a rewrite onto a
// `node:http` server this file starts on 127.0.0.1, so redirects, streaming
// and the byte cap run for real against a server the test owns, while the
// address policy sees the public names the test invented.
//
// **THE TEST THIS FILE EXISTS FOR** is "a redirect whose destination resolves
// into a private network is refused, on the same host". A same-host redirect
// is exactly the case the cross-host rule cannot catch, so that test fails the
// moment the per-hop `resolveTarget` call in the redirect loop is removed —
// which is the property D4 is about.

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  DenialLog,
  type ApprovalDecision,
  type ApprovalGate,
  type ApprovalRequest,
} from "../gate/approval.js";
import { TOOL_CATALOG } from "../ledger/tool-catalog.js";
import { measureToolset } from "../ledger/tool-schema.js";
import { riskForTool, tierForTool } from "./tool-risk.js";
import { DEFAULT_RESIDENT_TOOLS, MOUNTED_TOOLS } from "./tool-surface.js";
import {
  WEB_FETCH_DESCRIPTION,
  WEB_FETCH_MAX_BYTES,
  WEB_FETCH_PAGE_CHARS,
  WEB_FETCH_PARAMETERS,
  WEB_FETCH_TOOL_NAME,
  blockedAddressReason,
  blockedV4Reason,
  blockedV6Reason,
  buildWebFetchTool,
  cacheLookup,
  cacheStore,
  extractArticle,
  extractionFailureReason,
  newFetchCache,
  paginate,
  readCapped,
  resolveTarget,
  type CachedPage,
  type HostResolver,
  type WebFetcher,
  type WebResponseLike,
} from "./web-fetch.js";

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

// ---------------------------------------------------------------------------
// The local server, and the fetcher that rewrites onto it
// ---------------------------------------------------------------------------

interface LocalServer {
  port: number;
  /** Every path this server was actually asked for, in order. The proof that a refused hop was never requested. */
  paths: string[];
  close(): Promise<void>;
}

async function startServer(handler: (req: IncomingMessage, res: ServerResponse, paths: string[]) => void): Promise<LocalServer> {
  const paths: string[] = [];
  const server: Server = createServer((req, res) => {
    paths.push(req.url ?? "");
    handler(req, res, paths);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    paths,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * A fetcher that sends every request to the local server, whatever host the
 * URL names.
 *
 * This is what makes the tests real rather than mimed: the tool builds and
 * judges `https://docs.example/...` and the bytes come from a `node:http`
 * server this file started. `redirect: "manual"` passes straight through, so
 * the tool sees each hop exactly as it would on the network.
 */
function rewritingFetcher(port: number, log: string[]): WebFetcher {
  return async (url, init) => {
    log.push(url);
    const target = new URL(url);
    const local = `http://127.0.0.1:${port}${target.pathname}${target.search}`;
    const init2: Record<string, unknown> = {
      redirect: init.redirect,
      headers: { ...init.headers, "x-lykos-host": target.hostname },
    };
    if (init.signal !== undefined) init2.signal = init.signal;
    return (await fetch(local, init2 as never)) as unknown as WebResponseLike;
  };
}

/** A resolver that answers from a table. Anything not in it does not resolve, which is the safe answer for a test. */
function staticResolver(table: Record<string, string[]>): HostResolver {
  return async (hostname) => {
    const found = table[hostname.toLowerCase()];
    if (found === undefined) throw new Error(`no test address for ${hostname}`);
    return found;
  };
}

interface Harness {
  tool: ToolDefinition;
  gate: RecordingGate;
  fetched: string[];
  denials: DenialLog;
}

function harness(opts: {
  port: number;
  resolver?: HostResolver;
  gate?: RecordingGate;
  now?: () => number;
  cache?: ReturnType<typeof newFetchCache>;
}): Harness {
  const fetched: string[] = [];
  const gate = opts.gate ?? new RecordingGate();
  const denials = new DenialLog();
  const tool = buildWebFetchTool({
    cwd: process.cwd(),
    gate,
    denials,
    fetcher: rewritingFetcher(opts.port, fetched),
    resolve: opts.resolver ?? staticResolver({ "docs.example": ["93.184.216.34"] }),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    ...(opts.cache !== undefined ? { cache: opts.cache } : {}),
  });
  return { tool, gate, fetched, denials };
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

const ARTICLE_HTML =
  `<!doctype html><html><head><title>Widget guide</title></head><body>` +
  `<nav>home about contact</nav>` +
  `<article><h1>Widget guide</h1>` +
  `<p>${"Widgets are small round things that hold other things together. ".repeat(6)}</p>` +
  `<p>${"The second paragraph is about how a widget is installed and configured. ".repeat(6)}</p>` +
  `<pre><code>npm install widget</code></pre>` +
  `<ul><li>first bullet</li><li>second bullet</li></ul></article>` +
  `<footer>copyright 2026 widget corp</footer></body></html>`;

function html(res: ServerResponse, body: string, status = 200): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

// ---------------------------------------------------------------------------
// D10: the catalog prices what web_fetch sends, and it is RESIDENT
// ---------------------------------------------------------------------------

describe("P10.7 D10: the catalog prices what web_fetch sends", () => {
  it("the row equals the live definition, description and parameters both", () => {
    const row = TOOL_CATALOG.web_fetch;
    assert.ok(row);
    assert.equal(row.name, WEB_FETCH_TOOL_NAME);
    assert.equal(row.source, "lykos");
    assert.equal(row.description, WEB_FETCH_DESCRIPTION);
    assert.deepEqual(row.parameters, asJson(WEB_FETCH_PARAMETERS));
  });

  // Measured with `measureToolset` on SCHEMA_TOKENS_BASIS, 2026-09-21. Unlike
  // every tool built since P10.4 this one is RESIDENT, so this is a bill that
  // is actually paid: the resident surface moved 1423 -> 2062 tokens for the
  // pair, of which this tool is 326 priced alone. The pair together is 639
  // rather than 640 because measure(A+B) is not measure(A) + measure(B) —
  // array wrapping — which is why the surface is measured whole.
  it("costs 326 tokens alone and is part of the first resident move since P10.4", () => {
    const alone = measureToolset([WEB_FETCH_TOOL_NAME]);
    assert.equal(alone.complete, true);
    assert.equal(alone.tokens, 326);
    assert.equal(alone.bytes, 1309);
    assert.equal(measureToolset(DEFAULT_RESIDENT_TOOLS).tokens, 2255);
    assert.equal(DEFAULT_RESIDENT_TOOLS.includes(WEB_FETCH_TOOL_NAME), true);
    assert.equal(MOUNTED_TOOLS.includes(WEB_FETCH_TOOL_NAME), false);
  });

  it("is declared read-tier and open-world — it reads the internet and writes nothing", () => {
    assert.equal(tierForTool(WEB_FETCH_TOOL_NAME), "read");
    assert.deepEqual(riskForTool(WEB_FETCH_TOOL_NAME), { tier: "read", idempotent: false, openWorld: true });
  });
});

// ---------------------------------------------------------------------------
// D4: the address policy, as a function
// ---------------------------------------------------------------------------

describe("P10.7 D4: the address policy refuses before the request", () => {
  it("refuses every IPv4 range that is not the public internet", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
      "100.64.0.1",
      "192.0.0.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      assert.notEqual(blockedV4Reason(address), undefined, address);
      assert.notEqual(blockedAddressReason(address), undefined, address);
    }
  });

  it("allows a public IPv4 address", () => {
    for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "172.15.0.1", "1.1.1.1"]) {
      assert.equal(blockedV4Reason(address), undefined, address);
    }
  });

  it("refuses the IPv6 equivalents, including an IPv4-mapped loopback", () => {
    for (const address of ["::1", "::", "fe80::1", "fec0::1%eth0".replace("fec0", "fe80"), "fd00::1", "fc00::abcd", "ff02::1", "::ffff:127.0.0.1", "::127.0.0.1"]) {
      assert.notEqual(blockedV6Reason(address), undefined, address);
      assert.notEqual(blockedAddressReason(address), undefined, address);
    }
    assert.equal(blockedV6Reason("2606:2800:220:1:248:1893:25c8:1946"), undefined);
    assert.equal(blockedV6Reason("::ffff:93.184.216.34"), undefined);
  });

  it("refuses a scheme that is not http or https, and says which two are", async () => {
    const resolve = staticResolver({ "docs.example": ["93.184.216.34"] });
    for (const url of ["file:///etc/passwd", "ftp://docs.example/x", "data:text/html,<b>hi</b>"]) {
      const verdict = await resolveTarget(url, resolve);
      assert.equal(verdict.ok, false, url);
      if (!verdict.ok) assert.match(verdict.reason, /http and https/);
    }
  });

  it("refuses a URL carrying credentials and says nothing was requested", async () => {
    const verdict = await resolveTarget("https://user:secret@docs.example/page", staticResolver({ "docs.example": ["93.184.216.34"] }));
    assert.equal(verdict.ok, false);
    if (!verdict.ok) {
      assert.match(verdict.reason, /credentials/);
      assert.doesNotMatch(verdict.reason, /secret/);
    }
  });

  it("upgrades http to https before it judges the address", async () => {
    const verdict = await resolveTarget("http://docs.example/page?a=1", staticResolver({ "docs.example": ["93.184.216.34"] }));
    assert.equal(verdict.ok, true);
    if (verdict.ok) assert.equal(verdict.url.href, "https://docs.example/page?a=1");
  });

  it("refuses a hostname that resolves into a private network, exactly as it refuses the literal", async () => {
    const named = await resolveTarget("https://internal.example/secrets", staticResolver({ "internal.example": ["10.0.0.5"] }));
    assert.equal(named.ok, false);
    if (!named.ok) assert.match(named.reason, /10\.0\.0\.5/);
    const literal = await resolveTarget("https://10.0.0.5/secrets", staticResolver({}));
    assert.equal(literal.ok, false);
  });

  it("refuses when any one of several addresses is private — one bad answer is enough", async () => {
    const verdict = await resolveTarget("https://mixed.example/", staticResolver({ "mixed.example": ["93.184.216.34", "127.0.0.1"] }));
    assert.equal(verdict.ok, false);
  });
});

// ---------------------------------------------------------------------------
// D4 through the tool: nothing is requested when the address is refused
// ---------------------------------------------------------------------------

describe("P10.7 D4: the tool sends nothing to a refused address", () => {
  it("refuses a literal private address without fetching anything", async () => {
    const server = await startServer((_req, res) => html(res, ARTICLE_HTML));
    try {
      const h = harness({ port: server.port });
      for (const url of ["http://127.0.0.1:1234/", "https://10.0.0.5/", "http://169.254.169.254/latest/meta-data/", "https://[::1]/"]) {
        const res = await call(h.tool, { url });
        assert.equal(res.isError, true, url);
        assert.equal(res.details.refused, true, url);
      }
      assert.deepEqual(h.fetched, []);
      assert.deepEqual(server.paths, []);
      assert.equal(h.gate.seen.length, 0, "a refused address never reaches the human either");
    } finally {
      await server.close();
    }
  });

  it("refuses a URL carrying credentials without fetching anything", async () => {
    const server = await startServer((_req, res) => html(res, ARTICLE_HTML));
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://user:hunter2@docs.example/page" });
      assert.equal(res.isError, true);
      assert.match(res.text, /credentials/);
      assert.doesNotMatch(res.text, /hunter2/);
      assert.deepEqual(h.fetched, []);
    } finally {
      await server.close();
    }
  });

  it("upgrades an insecure URL: what is fetched is the https one", async () => {
    const server = await startServer((_req, res) => html(res, ARTICLE_HTML));
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "http://docs.example/guide" });
      assert.equal(res.isError, false);
      assert.deepEqual(h.fetched, ["https://docs.example/guide"]);
      assert.equal(res.details.finalUrl, "https://docs.example/guide");
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The happy path: HTML becomes markdown, and the article is extracted
// ---------------------------------------------------------------------------

describe("P10.7: HTML becomes readable markdown", () => {
  it("extracts the article and drops the navigation and the footer", async () => {
    const server = await startServer((_req, res) => html(res, ARTICLE_HTML));
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://docs.example/guide" });
      assert.equal(res.isError, false);
      assert.match(res.text, /# Widget guide/);
      assert.match(res.text, /Widgets are small round things/);
      assert.match(res.text, /npm install widget/);
      // Turndown pads a list marker out to its indent width, so the bullet is
      // `-` followed by spaces rather than exactly one.
      assert.match(res.text, /-\s+first bullet/);
      assert.doesNotMatch(res.text, /copyright 2026 widget corp/);
      assert.doesNotMatch(res.text, /home about contact/);
      assert.equal(res.details.title, "Widget guide");
      assert.equal(res.details.cached, false);
    } finally {
      await server.close();
    }
  });

  it("passes plain text through without pretending to extract an article", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("CHANGELOG\n\n1.2.0 — fixed the thing\n");
    });
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://docs.example/CHANGELOG" });
      assert.equal(res.isError, false);
      assert.match(res.text, /1\.2\.0 — fixed the thing/);
    } finally {
      await server.close();
    }
  });

  it("says so when the body is not text at all rather than returning mojibake", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    });
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://docs.example/logo.png" });
      assert.match(res.text, /image\/png/);
      assert.equal(res.details.extracted, false);
    } finally {
      await server.close();
    }
  });

  it("reports an HTTP failure as an error naming the status, not as page content", async () => {
    const server = await startServer((_req, res) => html(res, "<html><body>nope</body></html>", 404));
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://docs.example/missing" });
      assert.equal(res.isError, true);
      assert.match(res.text, /HTTP 404/);
      assert.equal(res.details.status, 404);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// D5 and D4 on every hop: redirects
// ---------------------------------------------------------------------------

describe("P10.7 D5: same host follows, cross host reports", () => {
  it("follows a same-host redirect and reports where it landed", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/old") {
        res.writeHead(302, { location: "https://docs.example/new" });
        res.end();
        return;
      }
      html(res, ARTICLE_HTML);
    });
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://docs.example/old" });
      assert.equal(res.isError, false);
      assert.equal(res.details.finalUrl, "https://docs.example/new");
      assert.deepEqual(h.fetched, ["https://docs.example/old", "https://docs.example/new"]);
    } finally {
      await server.close();
    }
  });

  it("follows http to https on the same host — the comparison is the host, not the origin", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/insecure") {
        // A server that redirects to its own http URL: the tool upgrades it
        // and the host has not changed, so this is a follow rather than a
        // report.
        res.writeHead(301, { location: "http://docs.example/secure" });
        res.end();
        return;
      }
      html(res, ARTICLE_HTML);
    });
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://docs.example/insecure" });
      assert.equal(res.isError, false);
      assert.equal(res.details.finalUrl, "https://docs.example/secure");
    } finally {
      await server.close();
    }
  });

  it("reports a cross-host redirect naming both URLs, and does not follow it", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/away") {
        res.writeHead(302, { location: "https://other.example/landing" });
        res.end();
        return;
      }
      html(res, ARTICLE_HTML);
    });
    try {
      const h = harness({
        port: server.port,
        resolver: staticResolver({ "docs.example": ["93.184.216.34"], "other.example": ["93.184.216.35"] }),
      });
      const res = await call(h.tool, { url: "https://docs.example/away" });
      assert.equal(res.isError, false, "a redirect the model can act on is not a failed turn");
      assert.match(res.text, /https:\/\/docs\.example\/away/);
      assert.match(res.text, /https:\/\/other\.example\/landing/);
      assert.equal(res.details.followed, false);
      assert.equal(res.details.redirectedTo, "https://other.example/landing");
      // The destination was never requested: one fetch, one server hit.
      assert.deepEqual(h.fetched, ["https://docs.example/away"]);
      assert.deepEqual(server.paths, ["/away"]);
    } finally {
      await server.close();
    }
  });

  it("stops after the redirect cap rather than looping", async () => {
    const server = await startServer((req, res) => {
      const n = Number((req.url ?? "/0").slice(1));
      res.writeHead(302, { location: `https://docs.example/${n + 1}` });
      res.end();
    });
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://docs.example/0" });
      assert.equal(res.isError, true);
      assert.match(res.text, /redirected more than/);
    } finally {
      await server.close();
    }
  });
});

describe("P10.7 D4: the address check runs again on every redirect hop", () => {
  // **THIS IS THE TEST THE MODULE COMMENT IS ABOUT.**
  //
  // The redirect stays on `docs.example` — so the cross-host rule cannot
  // refuse it — and the host's SECOND resolution is a private address, which
  // is DNS rebinding. Only a per-hop `resolveTarget` catches this. Delete that
  // call from the redirect loop in `web-fetch.ts` and this test fails twice
  // over: the refusal text is gone, and `/internal` shows up in the server's
  // own request log.
  it("refuses a SAME-HOST redirect whose host now resolves privately (DNS rebinding)", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "https://rebind.example/internal" });
        res.end();
        return;
      }
      html(res, "<html><body><article><p>private things</p></article></body></html>");
    });
    try {
      let lookups = 0;
      const rebinding: HostResolver = async (hostname) => {
        assert.equal(hostname, "rebind.example");
        lookups += 1;
        return lookups === 1 ? ["93.184.216.34"] : ["10.0.0.5"];
      };
      const h = harness({ port: server.port, resolver: rebinding });
      const res = await call(h.tool, { url: "https://rebind.example/start" });

      assert.equal(res.isError, true);
      assert.equal(res.details.refused, true);
      assert.match(res.text, /10\.0\.0\.5/);
      assert.equal(lookups, 2, "the hop was resolved again rather than trusted");
      // The thing that actually matters: the private page was never requested.
      assert.deepEqual(server.paths, ["/start"]);
      assert.deepEqual(h.fetched, ["https://rebind.example/start"]);
    } finally {
      await server.close();
    }
  });

  it("refuses a redirect to a literal private address before it is even called cross-host", async () => {
    const server = await startServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        res.end();
        return;
      }
      html(res, ARTICLE_HTML);
    });
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://docs.example/start" });
      assert.equal(res.isError, true);
      assert.equal(res.details.refused, true);
      assert.match(res.text, /169\.254\.169\.254/);
      assert.match(res.text, /link-local/);
      assert.deepEqual(server.paths, ["/start"]);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// D6: the byte cap and the pagination
// ---------------------------------------------------------------------------

describe("P10.7 D6: the byte cap truncates and pagination returns a next offset", () => {
  it("cuts the download at the cap and says the page is a prefix", async () => {
    const paragraph = `<p>${"A sentence about widgets that goes on and on. ".repeat(20)}</p>`;
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.write("<!doctype html><html><head><title>Huge</title></head><body><article>");
      // Comfortably past the cap, written in chunks so the cap is applied to a
      // stream rather than to a buffer that was already whole.
      const chunk = paragraph.repeat(20);
      let written = 0;
      while (written < WEB_FETCH_MAX_BYTES + 200_000) {
        res.write(chunk);
        written += chunk.length;
      }
      res.end("</article></body></html>");
    });
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://docs.example/huge" });
      assert.equal(res.details.truncated, true);
      assert.ok(res.details.bytes <= WEB_FETCH_MAX_BYTES, `read ${res.details.bytes} bytes`);
      assert.match(res.text, /passed the 2000000-byte cap/);
    } finally {
      await server.close();
    }
  });

  it("paginates the markdown and names the offset of the next page", async () => {
    const long = `<p>${"Widgets deserve a long explanation. ".repeat(2000)}</p>`;
    const server = await startServer((_req, res) =>
      html(res, `<!doctype html><html><head><title>Long</title></head><body><article>${long}</article></body></html>`),
    );
    try {
      const h = harness({ port: server.port });
      const first = await call(h.tool, { url: "https://docs.example/long" });
      assert.equal(first.details.offset, 0);
      assert.equal(typeof first.details.nextOffset, "number");
      assert.equal(first.details.nextOffset, WEB_FETCH_PAGE_CHARS);
      assert.match(first.text, new RegExp(`offset: ${WEB_FETCH_PAGE_CHARS}`));

      const second = await call(h.tool, { url: "https://docs.example/long", offset: first.details.nextOffset });
      assert.equal(second.details.offset, WEB_FETCH_PAGE_CHARS);
      assert.notEqual(second.text, first.text);
      // The second read came from the cache, so the whole document was fetched
      // once however many pages the model reads.
      assert.equal(second.details.cached, true);
      assert.deepEqual(h.fetched, ["https://docs.example/long"]);
    } finally {
      await server.close();
    }
  });

  it("paginate() is a pure function over characters, not bytes of the source", () => {
    const markdown = "x".repeat(WEB_FETCH_PAGE_CHARS + 10);
    const first = paginate(markdown, 0);
    assert.equal(first.page.length, WEB_FETCH_PAGE_CHARS);
    assert.equal(first.nextOffset, WEB_FETCH_PAGE_CHARS);
    const second = paginate(markdown, WEB_FETCH_PAGE_CHARS);
    assert.equal(second.page.length, 10);
    assert.equal(second.nextOffset, undefined);
    assert.equal(paginate("short", 500).page, "");
  });

  it("readCapped stops at the cap and cancels the stream", async () => {
    let cancelled = false;
    let reads = 0;
    const body = {
      getReader: () => ({
        read: async () => {
          reads += 1;
          return { done: false, value: new Uint8Array(100) };
        },
        cancel: async () => {
          cancelled = true;
        },
      }),
    };
    const out = await readCapped(body, 250);
    assert.equal(out.truncated, true);
    assert.equal(out.bytes.length, 250);
    assert.equal(cancelled, true);
    assert.equal(reads, 3);
    assert.deepEqual(await readCapped(null, 100), { bytes: Buffer.alloc(0), truncated: false });
  });
});

// ---------------------------------------------------------------------------
// D7: the cache
// ---------------------------------------------------------------------------

describe("P10.7 D7: the session cache serves a repeat", () => {
  it("serves the second read of one page from memory, and refresh forces a fetch", async () => {
    const server = await startServer((_req, res) => html(res, ARTICLE_HTML));
    try {
      const h = harness({ port: server.port });
      const first = await call(h.tool, { url: "https://docs.example/guide" });
      const second = await call(h.tool, { url: "https://docs.example/guide" });
      assert.equal(first.details.cached, false);
      assert.equal(second.details.cached, true);
      assert.match(second.text, /from this session's cache/);
      assert.equal(h.fetched.length, 1);
      assert.deepEqual(server.paths, ["/guide"]);

      const third = await call(h.tool, { url: "https://docs.example/guide", refresh: true });
      assert.equal(third.details.cached, false);
      assert.equal(h.fetched.length, 2);
    } finally {
      await server.close();
    }
  });

  it("two tools built separately do not share a cache — it is per session by construction", async () => {
    const server = await startServer((_req, res) => html(res, ARTICLE_HTML));
    try {
      const a = harness({ port: server.port });
      const b = harness({ port: server.port });
      await call(a.tool, { url: "https://docs.example/guide" });
      const fromB = await call(b.tool, { url: "https://docs.example/guide" });
      assert.equal(fromB.details.cached, false);
      assert.equal(b.fetched.length, 1);
    } finally {
      await server.close();
    }
  });

  it("an entry past its time to live is dropped rather than served", () => {
    const cache = newFetchCache();
    const page: CachedPage = {
      finalUrl: "https://docs.example/x",
      title: "x",
      markdown: "x",
      contentType: "text/html",
      truncated: false,
      bytes: 1,
      storedAt: 1_000,
    };
    cacheStore(cache, ["https://docs.example/x"], page);
    assert.equal(cacheLookup(cache, "https://docs.example/x", 1_000)?.title, "x");
    assert.equal(cacheLookup(cache, "https://docs.example/x", 1_000 + 16 * 60 * 1000), undefined);
    assert.equal(cache.entries.size, 0, "the expired entry is removed, not merely skipped");
  });

  it("is bounded: the oldest entry falls out rather than the map growing", () => {
    const cache = newFetchCache();
    for (let i = 0; i < 40; i++) {
      cacheStore(cache, [`https://docs.example/${i}`], {
        finalUrl: `https://docs.example/${i}`,
        title: String(i),
        markdown: "x",
        contentType: "text/html",
        truncated: false,
        bytes: 1,
        storedAt: 0,
      });
    }
    assert.ok(cache.entries.size <= 16, `cache grew to ${cache.entries.size}`);
    assert.equal(cacheLookup(cache, "https://docs.example/0", 0), undefined);
    assert.equal(cacheLookup(cache, "https://docs.example/39", 0)?.title, "39");
  });
});

// ---------------------------------------------------------------------------
// D8: an unparseable page reports why
// ---------------------------------------------------------------------------

describe("P10.7 D8: a page that cannot be extracted says why", () => {
  it("names the client-rendered case and returns the title and the URL, never an empty success", async () => {
    const server = await startServer((_req, res) =>
      html(
        res,
        `<!doctype html><html><head><title>Dashboard</title></head><body><div id="root"></div>` +
          `<script src="/app.js"></script><script>window.boot()</script></body></html>`,
      ),
    );
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://docs.example/app" });
      assert.notEqual(res.text.trim(), "");
      assert.match(res.text, /could not be extracted/);
      assert.match(res.text, /client-rendered/);
      assert.match(res.text, /Dashboard/);
      assert.match(res.text, /https:\/\/docs\.example\/app/);
      assert.equal(res.details.extracted, false);
      assert.equal(res.details.title, "Dashboard");
    } finally {
      await server.close();
    }
  });

  it("extractArticle never returns an empty markdown without a failure beside it", () => {
    const empty = extractArticle("<html><head><title>T</title></head><body></body></html>", "https://docs.example/t");
    assert.equal(empty.markdown, "");
    assert.notEqual(empty.failure, undefined);
    assert.equal(empty.title, "T");

    const good = extractArticle(ARTICLE_HTML, "https://docs.example/guide");
    assert.equal(good.failure, undefined);
    assert.match(good.markdown, /Widgets are small round things/);
  });

  it("says so for an empty text body too, rather than reporting an empty page as a success", async () => {
    const server = await startServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("   \n");
    });
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "https://docs.example/empty.txt" });
      assert.match(res.text, /empty text\/plain/);
      assert.equal(res.details.extracted, false);
    } finally {
      await server.close();
    }
  });

  it("distinguishes the client-rendered guess from the not-an-article one", () => {
    assert.match(extractionFailureReason("<html><body><script>x</script></body></html>"), /client-rendered/);
    assert.match(extractionFailureReason(`<html><body>${"word ".repeat(200)}</body></html>`), /not an article/);
  });
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("P10.7: web_fetch reaches the same gate as everything else", () => {
  it("asks at the read tier, naming the URL, and fetches nothing when the human declines", async () => {
    const server = await startServer((_req, res) => html(res, ARTICLE_HTML));
    try {
      const allow = harness({ port: server.port });
      await call(allow.tool, { url: "https://docs.example/guide" });
      assert.equal(allow.gate.seen.length, 1);
      assert.equal(allow.gate.seen[0]!.kind, "read");
      assert.equal(allow.gate.seen[0]!.detail, "https://docs.example/guide");

      const deny = harness({ port: server.port, gate: new RecordingGate("deny") });
      const res = await call(deny.tool, { url: "https://docs.example/guide" });
      assert.equal(res.isError, true);
      assert.deepEqual(deny.fetched, []);
      assert.equal(deny.denials.userRejected, 1);
    } finally {
      await server.close();
    }
  });

  it("refuses an empty url as a mis-call rather than fetching anything", async () => {
    const server = await startServer((_req, res) => html(res, ARTICLE_HTML));
    try {
      const h = harness({ port: server.port });
      const res = await call(h.tool, { url: "   " });
      assert.equal(res.isError, true);
      assert.deepEqual(h.fetched, []);
    } finally {
      await server.close();
    }
  });
});
