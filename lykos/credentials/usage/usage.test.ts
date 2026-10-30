// P14.4 ticket 09, plan D5: usage endpoints, the usage-limit cooldown and
// usage ranking. No network: every request goes to a fake server on
// 127.0.0.1:0. Usage bodies are written fixtures (`./fixtures/`), not
// recordings; where a case needs an exhausted window it edits a copy of one
// and says so. The Messages bodies are WRITTEN,
// NOT RECORDED.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createLykosModelRuntime, type ProviderConfigInput } from "../../session/model-runtime.js";
import { activeCooldowns, openCredentialDb, type CredentialDb } from "../db.js";
import { anthropicError, textReply } from "../fake-anthropic-server.js";
import { LykosCredentialStore } from "../pi-store.js";
import { upsertCredential } from "../pool.js";
import { DEFAULT_COOLDOWN_MS, type RotationEvent } from "../rotate.js";
import { ANTHROPIC_STICKY_WARM_MS, hashedIndex, selectCredential } from "../select.js";
import { xxHash32 } from "../xxhash32.js";
import { readCachedReport, readFreshReport, storeReport, USAGE_REPORT_TTL_MS } from "./cache.js";
import { claudeUsageProvider, fetchClaudeUsage, parseClaudeUsage } from "./claude.js";
import { fetchCodexUsage, parseCodexUsage } from "./codex.js";
import {
  claudeFableScopedBody,
  claudeHeadersBody,
  claudeInactiveScopedBody,
  claudeLimitsOnlyBody,
  claudeNoResetBody,
} from "./fixtures/claude.js";
import { codexAccessTokenFixture, codexUsagePayload } from "./fixtures/codex.js";
import { usageProviderFor } from "./index.js";
import { usageLimitResetAt } from "./rank.js";
import type { UsageReport } from "./types.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lykos-usage-"));
  dirs.push(d);
  return d;
}
// Nothing here may read the real home.
process.env.PI_CODING_AGENT_DIR = tmp();
process.env.LYKOS_PI_HOST_DIR = tmp();
process.env.LYKOS_CREDENTIALS_DB = join(tmp(), "absent.db");

// ---------------------------------------------------------------------------
// The fake server: Anthropic Messages (by `x-api-key`), the Claude usage
// endpoint and Codex `wham/usage` (by bearer token).
// ---------------------------------------------------------------------------

interface UsageReply {
  status: number;
  body: unknown;
  /** Resolves when the test lets the reply go (D2: the replay must not wait on it). */
  gate?: Promise<void>;
}

interface SeenRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
}

let server: Server;
let baseUrl = "";
const messages = new Map<string, Array<{ status: number; body: string } | { ok: string }>>();
const usageReplies = new Map<string, UsageReply>();
const seen: SeenRequest[] = [];

before(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0]!;
      seen.push({ method: req.method ?? "", path, headers: req.headers });
      if (path === "/v1/messages") {
        const key = String(req.headers["x-api-key"] ?? "");
        const list = messages.get(key);
        const next = list === undefined ? undefined : list.length > 1 ? list.shift()! : list[0]!;
        if (next === undefined) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(anthropicError("api_error", "unscripted key"));
        } else if ("ok" in next) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(textReply(next.ok));
        } else {
          res.writeHead(next.status, { "content-type": "application/json" });
          res.end(next.body);
        }
        return;
      }
      if (path === "/api/oauth/usage" || path === "/backend-api/wham/usage") {
        const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        const reply = usageReplies.get(bearer);
        const send = (): void => {
          if (reply === undefined) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end("{}");
            return;
          }
          res.writeHead(reply.status, { "content-type": "application/json" });
          res.end(JSON.stringify(reply.body));
        };
        if (reply?.gate) void reply.gate.then(send);
        else send();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  // D27: a store's burst connection closes on the next event-loop turn, and
  // Windows refuses to delete a directory holding an open database.
  await new Promise<void>((r) => setImmediate(r));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  messages.clear();
  usageReplies.clear();
  seen.length = 0;
});

/** A fetch that sends the real vendor URL to the fake server, path unchanged, and records the URL asked for. */
function redirectingFetch(asked: string[]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asked.push(url.href);
    return globalThis.fetch(`${baseUrl}${url.pathname}${url.search}`, init);
  }) as typeof globalThis.fetch;
}

function oauthData(access: string, expires = Date.now() + HOUR): string {
  return JSON.stringify({ access, refresh: `refresh-${access}`, expires });
}

// ---------------------------------------------------------------------------
// D5.1: parsers, endpoints and headers
// ---------------------------------------------------------------------------

describe("Claude usage (D1, D5.1)", () => {
  it("parses the Fable scoped fixture into the 5h, 7d and tiered weekly windows", () => {
    const now = Date.now();
    const report = parseClaudeUsage(claudeFableScopedBody(now), now)!;
    assert.deepEqual(
      report.windows.map((w) => [w.id, w.tier, w.usedFraction, w.exhausted]),
      [
        ["5h", undefined, 0.16, false],
        ["7d", undefined, 0.18, false],
        ["7d:fable", "fable", 0.28, false],
      ],
    );
    assert.equal(report.windows[0]!.resetAtMs, Date.parse(new Date(now + 5 * HOUR).toISOString()));
    assert.equal(report.windows[1]!.resetAtMs, Date.parse(new Date(now + 3 * DAY).toISOString()));
    assert.equal(report.windows[2]!.resetAtMs, Date.parse(new Date(now + 4 * DAY).toISOString()));
    assert.equal(report.windows[0]!.durationMs, 5 * HOUR);
    assert.equal(report.windows[2]!.durationMs, 7 * DAY);
  });

  it("falls back to limits[] session and weekly_all entries", () => {
    const now = Date.now();
    const report = parseClaudeUsage(claudeLimitsOnlyBody(now), now)!;
    assert.deepEqual(
      report.windows.map((w) => [w.id, w.usedFraction]),
      [
        ["5h", 0.16],
        ["7d", 0.18],
      ],
    );
  });

  it("keeps inactive named scoped limits, skips unnamed ones, and invents no reset", () => {
    const now = Date.now();
    const scoped = parseClaudeUsage(claudeInactiveScopedBody(now), now)!;
    assert.deepEqual(
      scoped.windows.map((w) => [w.id, w.usedFraction]),
      [
        ["5h", 0.16],
        ["7d:fable", 0.05],
      ],
    );
    const bare = parseClaudeUsage(claudeNoResetBody(), now)!;
    assert.equal(bare.windows[0]!.resetAtMs, undefined);
  });

  it("GETs <base>/api/oauth/usage with the usage headers and the bearer token", async () => {
    const now = Date.now();
    usageReplies.set("oat-test-access-token", { status: 200, body: claudeHeadersBody(now) });
    const report = await fetchClaudeUsage({
      credentialData: oauthData("oat-test-access-token"),
      fetch: globalThis.fetch,
      baseUrl: `${baseUrl}/v1`,
      now,
    });
    assert.equal(report?.windows[0]?.usedFraction, 0.42);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.method, "GET");
    assert.equal(seen[0]!.path, "/api/oauth/usage");
    assert.equal(seen[0]!.headers.authorization, "Bearer oat-test-access-token");
    assert.equal(seen[0]!.headers["user-agent"], "claude-cli/2.1.257 (external, cli)");
    const beta = String(seen[0]!.headers["anthropic-beta"]).split(",");
    for (const token of ["claude-code-20250219", "oauth-2025-04-20", "extended-cache-ttl-2025-04-11"]) {
      assert.ok(beta.includes(token), token);
    }
  });

  it("defaults to https://api.anthropic.com/api/oauth/usage", async () => {
    usageReplies.set("oat-test-access-token", { status: 200, body: claudeNoResetBody() });
    const asked: string[] = [];
    await fetchClaudeUsage({ credentialData: oauthData("oat-test-access-token"), fetch: redirectingFetch(asked) });
    assert.deepEqual(asked, ["https://api.anthropic.com/api/oauth/usage"]);
  });

  it("returns undefined on a failed request", async () => {
    usageReplies.set("oat-x", { status: 500, body: {} });
    const report = await fetchClaudeUsage({ credentialData: oauthData("oat-x"), fetch: globalThis.fetch, baseUrl });
    assert.equal(report, undefined);
  });
});

describe("Codex usage (D1, D5.1)", () => {
  it("parses the fixture into chat and Spark windows with plan and resets", () => {
    const now = Date.now();
    const report = parseCodexUsage(codexUsagePayload(), now)!;
    assert.equal(report.plan, "pro");
    assert.deepEqual(
      report.windows.map((w) => [w.id, w.role, w.tier, w.usedFraction, w.resetAtMs, w.exhausted]),
      [
        ["5h", "primary", undefined, 0.04, 2_000_000_000_000, false],
        ["7d", "secondary", undefined, 0.01, 2_000_500_000_000, false],
        ["spark:5h", "primary", "spark", 0.17, 2_000_001_000_000, false],
        ["spark:7d", "secondary", "spark", 0.61, 2_000_600_000_000, false],
      ],
    );
  });

  it("keeps an explicitly allowed window at 100% usable and marks a limit_reached one exhausted", () => {
    // A Team window explicitly allowed at 100%.
    const allowed = codexUsagePayload();
    allowed.plan_type = "team";
    allowed.rate_limit.secondary_window.used_percent = 100;
    const a = parseCodexUsage(allowed, Date.now())!;
    assert.equal(a.windows[1]!.usedFraction, 1);
    assert.equal(a.windows[1]!.exhausted, false);
    // Lykos's edit of the same payload: the meter now says the limit is reached.
    const reached = codexUsagePayload();
    reached.rate_limit.allowed = false;
    reached.rate_limit.limit_reached = true;
    reached.rate_limit.secondary_window.used_percent = 100;
    assert.equal(parseCodexUsage(reached, Date.now())!.windows[1]!.exhausted, true);
  });

  it("GETs https://chatgpt.com/backend-api/wham/usage with the bearer and account id, ignoring a proxy base URL", async () => {
    const token = codexAccessTokenFixture();
    usageReplies.set(token, { status: 200, body: codexUsagePayload() });
    const asked: string[] = [];
    const report = await fetchCodexUsage({
      credentialData: oauthData(token),
      fetch: redirectingFetch(asked),
      baseUrl: "http://127.0.0.1:8787/v1",
    });
    assert.deepEqual(asked, ["https://chatgpt.com/backend-api/wham/usage"]);
    assert.equal(report?.windows.length, 4);
    assert.equal(seen[0]!.headers.authorization, `Bearer ${token}`);
    assert.equal(seen[0]!.headers["chatgpt-account-id"], "acct-fixture");
  });

  it("never sends an expired token", async () => {
    const asked: string[] = [];
    const report = await fetchCodexUsage({
      credentialData: oauthData(codexAccessTokenFixture(), Date.now() - 1),
      fetch: redirectingFetch(asked),
    });
    assert.equal(report, undefined);
    assert.deepEqual(asked, []);
  });

  it("the registry serves anthropic and openai-codex only", () => {
    assert.equal(usageProviderFor("anthropic")?.providerId, "anthropic");
    assert.equal(usageProviderFor("openai-codex")?.providerId, "openai-codex");
    assert.equal(usageProviderFor("google-antigravity"), undefined);
  });
});

describe("usage cache (D1)", () => {
  it("reuses a report for five minutes and never lets an older one replace a newer one", () => {
    const db = openCredentialDb(join(tmp(), "c.db"), { create: true })!;
    try {
      const now = Date.now();
      const report = parseClaudeUsage(claudeNoResetBody(), now)!;
      storeReport(db, 1, report);
      assert.ok(readFreshReport(db, 1, now + USAGE_REPORT_TTL_MS - 1));
      assert.equal(readFreshReport(db, 1, now + USAGE_REPORT_TTL_MS), undefined);
      storeReport(db, 1, { ...report, fetchedAt: now - 1_000, windows: [] });
      assert.equal(readCachedReport(db, 1)!.fetchedAt, now);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// D5.2: the cooldown follows the exhausted window's reset
// ---------------------------------------------------------------------------

const OAUTH_PROVIDER = "fakeoauth";

function fakeOAuthProvider(): ProviderConfigInput {
  return {
    baseUrl,
    api: "anthropic-messages",
    oauth: {
      name: "Fake OAuth",
      login: async () => {
        throw new Error("not used");
      },
      refreshToken: (async (c: unknown) => c) as never,
      getApiKey: (c) => String((c as Record<string, unknown>).access),
    },
    models: [
      {
        id: "m1",
        name: "m1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100_000,
        maxTokens: 1_000,
      },
    ],
  };
}

interface OAuthPool {
  dbPath: string;
  store: LykosCredentialStore;
  runtime: ModelRuntime;
  a: number;
  b: number;
}

async function oauthPool(rotations: RotationEvent[]): Promise<OAuthPool> {
  const dir = tmp();
  const dbPath = join(dir, "credentials.db");
  const modelsPath = join(dir, "models.json");
  writeFileSync(modelsPath, JSON.stringify({ providers: {} }));
  const db = openCredentialDb(dbPath, { create: true })!;
  let a: number;
  let b: number;
  try {
    const add = (access: string, email: string): number =>
      upsertCredential(db, OAUTH_PROVIDER, {
        type: "oauth",
        access,
        refresh: `refresh-${access}`,
        expires: Date.now() + HOUR,
        email,
      } as never).row.id;
    a = add("tok-a", "a@example.com");
    b = add("tok-b", "b@example.com");
  } finally {
    db.close();
  }
  // The fake provider speaks Claude's usage wire on the model's base URL.
  const store = new LykosCredentialStore({
    dbPath,
    usage: { providerFor: (p) => (p === OAUTH_PROVIDER ? claudeUsageProvider : undefined) },
  });
  const runtime = await createLykosModelRuntime({
    modelsPath,
    credentials: store,
    providers: { [OAUTH_PROVIDER]: fakeOAuthProvider() },
    onRotation: (e) => rotations.push(e),
  });
  return { dbPath, store, runtime, a, b };
}

async function ask(runtime: ModelRuntime, sessionId: string): Promise<{ text: string; errorMessage?: string }> {
  const model = runtime.getModel(OAUTH_PROVIDER, "m1");
  assert.ok(model);
  const stream = runtime.streamSimple(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as never,
    { sessionId, maxRetries: 0 } as never,
  );
  let text = "";
  for await (const event of stream) if (event.type === "text_delta") text += event.delta;
  const result = await stream.result();
  return { text, ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}) };
}

function sessionStartingAt(index: number, n: number, tag: string): string {
  for (let i = 0; ; i++) {
    const id = `${tag}-${i}`;
    if (xxHash32(id) % n === index) return id;
  }
}

function cooldownUntil(dbPath: string, id: number): number | undefined {
  const db = openCredentialDb(dbPath, { create: false })!;
  try {
    return activeCooldowns(db, 0).find((c) => c.credentialId === id)?.untilMs;
  } finally {
    db.close();
  }
}

/**
 * The Fable scoped fixture with its five-hour window (both the `five_hour`
 * bucket and the `session` entry) edited to 100% and a reset `resetMs` from now.
 */
function exhaustedFiveHour(now: number, resetMs: number): Record<string, unknown> {
  const body = claudeFableScopedBody(now) as {
    five_hour: { utilization: number; resets_at: string };
    limits: Array<{ kind: string; percent: number; resets_at: string }>;
  };
  const reset = new Date(now + resetMs).toISOString();
  body.five_hour = { utilization: 100, resets_at: reset };
  const session = body.limits.find((l) => l.kind === "session")!;
  session.percent = 100;
  session.resets_at = reset;
  return body;
}

const USAGE_LIMIT = { status: 429, body: anthropicError("rate_limit_error", "usage limit reached") };

describe("usage-limit cooldown follows the usage report (D2, D5.2)", () => {
  it("cools A until its five-hour reset three hours out, and the turn completes on B without waiting", async () => {
    const rotations: RotationEvent[] = [];
    const pool = await oauthPool(rotations);
    const now = Date.now();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    messages.set("tok-a", [USAGE_LIMIT]);
    messages.set("tok-b", [{ ok: "from b" }]);
    usageReplies.set("tok-a", { status: 200, body: exhaustedFiveHour(now, 3 * HOUR), gate });

    const got = await ask(pool.runtime, sessionStartingAt(0, 2, "d2"));
    assert.equal(got.text, "from b");
    assert.equal(rotations.length, 1);
    // The replay finished while the usage reply was still held back.
    const before = cooldownUntil(pool.dbPath, pool.a)!;
    assert.ok(before <= Date.now() + DEFAULT_COOLDOWN_MS, "only the 60 s fallback is recorded so far");
    assert.ok(seen.some((r) => r.path === "/api/oauth/usage"), "the usage fetch was started");

    release();
    await pool.store.settleUsageFetches();
    const expected = Date.parse(new Date(now + 3 * HOUR).toISOString());
    assert.equal(cooldownUntil(pool.dbPath, pool.a), expected);
    // The report is cached for ranking and `lykos usage`.
    const db = openCredentialDb(pool.dbPath, { create: false })!;
    try {
      assert.equal(readCachedReport(db, pool.a)!.report.windows[0]!.usedFraction, 1);
    } finally {
      db.close();
    }
  });

  it("a failing usage endpoint (500) leaves the 60 s cooldown and stores nothing", async () => {
    const pool = await oauthPool([]);
    messages.set("tok-a", [USAGE_LIMIT]);
    messages.set("tok-b", [{ ok: "from b" }]);
    usageReplies.set("tok-a", { status: 500, body: { error: "boom" } });
    const started = Date.now();
    const got = await ask(pool.runtime, sessionStartingAt(0, 2, "d2fail"));
    assert.equal(got.text, "from b");
    await pool.store.settleUsageFetches();
    const until = cooldownUntil(pool.dbPath, pool.a)!;
    assert.ok(until >= started + DEFAULT_COOLDOWN_MS && until <= Date.now() + DEFAULT_COOLDOWN_MS);
    const db = openCredentialDb(pool.dbPath, { create: false })!;
    try {
      assert.equal(readCachedReport(db, pool.a), undefined);
    } finally {
      db.close();
    }
  });

  it("a report with nothing exhausted leaves the 60 s cooldown", async () => {
    const pool = await oauthPool([]);
    messages.set("tok-a", [USAGE_LIMIT]);
    messages.set("tok-b", [{ ok: "from b" }]);
    usageReplies.set("tok-a", { status: 200, body: claudeFableScopedBody(Date.now()) });
    await ask(pool.runtime, sessionStartingAt(0, 2, "d2none"));
    await pool.store.settleUsageFetches();
    assert.ok(cooldownUntil(pool.dbPath, pool.a)! <= Date.now() + DEFAULT_COOLDOWN_MS);
  });

  it("extends to the latest reset among exhausted windows the request uses", () => {
    const now = Date.now();
    const report: UsageReport = {
      fetchedAt: now,
      windows: [
        { id: "5h", role: "primary", usedFraction: 1, exhausted: true, resetAtMs: now + HOUR },
        { id: "7d", role: "secondary", usedFraction: 1, exhausted: true, resetAtMs: now + DAY },
        { id: "7d:opus", role: "secondary", tier: "opus", usedFraction: 1, exhausted: true, resetAtMs: now + 5 * DAY },
      ],
    };
    assert.equal(usageLimitResetAt("anthropic", report, now), now + DAY);
    assert.equal(usageLimitResetAt("anthropic", report, now, "claude-opus-4"), now + 5 * DAY);
  });
});

// ---------------------------------------------------------------------------
// D5.3 and D5.5: ranking over cached reports
// ---------------------------------------------------------------------------

function rankingDb(provider: string, n: number): { db: CredentialDb; ids: number[] } {
  const db = openCredentialDb(join(tmp(), "rank.db"), { create: true })!;
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      upsertCredential(db, provider, {
        type: "oauth",
        access: `tok-${i}`,
        refresh: `r-${i}`,
        expires: Date.now() + HOUR,
        email: `u${i}@example.com`,
      } as never).row.id,
    );
  }
  return { db, ids };
}

/** The Fable scoped fixture with its 5h / 7d percents and 7d reset edited. */
function claudeReport(now: number, fiveHourPct: number, sevenDayPct: number, sevenDayResetMs = 3 * DAY): UsageReport {
  const body = claudeFableScopedBody(now) as Record<string, { utilization: number; resets_at: string }>;
  body.five_hour!.utilization = fiveHourPct;
  body.seven_day = { utilization: sevenDayPct, resets_at: new Date(now + sevenDayResetMs).toISOString() };
  return parseClaudeUsage(body, now)!;
}

describe("usage ranking (D3, D5.3)", () => {
  it("a row at 90% primary usage ranks behind a row at 20%", () => {
    const { db, ids } = rankingDb("anthropic", 2);
    try {
      const now = Date.now();
      storeReport(db, ids[0]!, claudeReport(now, 90, 18));
      storeReport(db, ids[1]!, claudeReport(now, 20, 18));
      const sid = sessionStartingAt(0, 2, "hot");
      assert.equal(selectCredential(db, { provider: "anthropic", sessionId: sid, now, peek: true })!.id, ids[1]);
    } finally {
      db.close();
    }
  });

  it("plan priority beats usage for a Codex model with a plan requirement", () => {
    const { db, ids } = rankingDb("openai-codex", 2);
    try {
      const now = Date.now();
      // Edits of the payload: plans and Spark primary percents.
      const pro = codexUsagePayload();
      pro.additional_rate_limits[0]!.rate_limit.primary_window.used_percent = 80;
      const plus = codexUsagePayload();
      plus.plan_type = "plus";
      plus.additional_rate_limits[0]!.rate_limit.primary_window.used_percent = 10;
      storeReport(db, ids[0]!, parseCodexUsage(pro, now)!);
      storeReport(db, ids[1]!, parseCodexUsage(plus, now)!);
      const sid = sessionStartingAt(0, 2, "plan");
      const spark = "gpt-5.3-codex-spark";
      assert.equal(
        selectCredential(db, { provider: "openai-codex", sessionId: sid, now, peek: true, modelId: spark })!.id,
        ids[0],
        "Spark needs Pro: the Pro row wins despite heavier use",
      );
      // A Spark request with no plan requirement would rank on usage alone.
      pro.plan_type = "plus";
      storeReport(db, ids[0]!, parseCodexUsage(pro, now + 1)!);
      assert.equal(
        selectCredential(db, { provider: "openai-codex", sessionId: sid, now, peek: true, modelId: spark })!.id,
        ids[1],
      );
    } finally {
      db.close();
    }
  });

  it("among equal usage, the row whose quota resets soonest ranks first", () => {
    const { db, ids } = rankingDb("anthropic", 2);
    try {
      const now = Date.now();
      storeReport(db, ids[0]!, claudeReport(now, 30, 30, 6 * DAY));
      storeReport(db, ids[1]!, claudeReport(now, 30, 30, 1 * DAY));
      const sid = sessionStartingAt(0, 2, "drain");
      assert.equal(selectCredential(db, { provider: "anthropic", sessionId: sid, now, peek: true })!.id, ids[1]);
    } finally {
      db.close();
    }
  });

  it("with no reports the choice is exactly xxHash32(sessionId) % n", () => {
    const { db, ids } = rankingDb("anthropic", 3);
    try {
      for (let i = 0; i < 12; i++) {
        const sid = `none-${i}`;
        assert.equal(selectCredential(db, { provider: "anthropic", sessionId: sid, peek: true })!.id, ids[hashedIndex(sid, 3)]);
      }
    } finally {
      db.close();
    }
  });

  it("a sticky Anthropic row idle over an hour is re-ranked; under an hour it is kept", () => {
    const { db, ids } = rankingDb("anthropic", 2);
    try {
      const now = Date.now();
      storeReport(db, ids[0]!, claudeReport(now, 20, 18));
      storeReport(db, ids[1]!, claudeReport(now, 90, 18));
      const sid = sessionStartingAt(1, 2, "sticky");
      const stick = (updatedAt: number): void => {
        db.prepare(
          `INSERT INTO sticky (session_id, provider, credential_id, updated_at) VALUES (?, 'anthropic', ?, ?)
           ON CONFLICT(session_id, provider) DO UPDATE SET credential_id = excluded.credential_id, updated_at = excluded.updated_at`,
        ).run(sid, ids[1], updatedAt);
      };
      stick(now - ANTHROPIC_STICKY_WARM_MS + 60_000);
      assert.equal(selectCredential(db, { provider: "anthropic", sessionId: sid, now })!.id, ids[1], "warm: kept");
      stick(now - ANTHROPIC_STICKY_WARM_MS - 60_000);
      assert.equal(selectCredential(db, { provider: "anthropic", sessionId: sid, now })!.id, ids[0], "idle: re-ranked");
    } finally {
      db.close();
    }
  });

  it("an idle sticky row still wins a genuine tie", () => {
    const { db, ids } = rankingDb("anthropic", 2);
    try {
      const now = Date.now();
      storeReport(db, ids[0]!, claudeReport(now, 20, 18));
      storeReport(db, ids[1]!, claudeReport(now, 20, 18));
      const sid = sessionStartingAt(0, 2, "tie");
      db.prepare("INSERT INTO sticky (session_id, provider, credential_id, updated_at) VALUES (?, 'anthropic', ?, ?)").run(
        sid,
        ids[1],
        now - 2 * HOUR,
      );
      assert.equal(selectCredential(db, { provider: "anthropic", sessionId: sid, now })!.id, ids[1]);
    } finally {
      db.close();
    }
  });

  it("selection makes no network call (D5.5)", () => {
    const { db, ids } = rankingDb("anthropic", 3);
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      throw new Error("selection must not fetch");
    }) as typeof globalThis.fetch;
    try {
      const now = Date.now();
      storeReport(db, ids[0]!, claudeReport(now, 95, 50));
      storeReport(db, ids[1]!, claudeReport(now - 2 * USAGE_REPORT_TTL_MS, 10, 10));
      for (let i = 0; i < 5; i++) selectCredential(db, { provider: "anthropic", sessionId: `nf-${i}`, now });
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = realFetch;
      db.close();
    }
  });
});
