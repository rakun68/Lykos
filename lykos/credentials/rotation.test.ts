// P14.3 ticket 05, plan D6: rotation against a fake model server (test seam 1).
//
// A `node:http` server on 127.0.0.1:0 speaks the Anthropic Messages SSE wire
// format and is scripted per API key (the `x-api-key` header). Every body below
// is WRITTEN, NOT RECORDED. Runtimes come from `createLykosModelRuntime` over a
// throwaway credential db, so the path under test is Pi's own:
// store -> getAuth -> streamSimple, wrapped by rotation. Each case asserts what
// a user or the store can observe: the text, the error, the requests the
// server saw, cooldown rows, disabled rows, rotation notices.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ProvidersConfig } from "../config/types.js";
import { createLykosModelRuntime, type ProviderConfigInput } from "../session/model-runtime.js";
import { classifyFailure, extractHttpStatus } from "./classify.js";
import { activeCooldowns, openCredentialDb, upsertCooldown } from "./db.js";
import { LykosCredentialStore } from "./pi-store.js";
import { listCredentials, readCredentialById, upsertCredential } from "./pool.js";
import { lastServedCredential, type RotationEvent } from "./rotate.js";
import { ANTHROPIC_STICKY_WARM_MS, pinCredential, selectCredential } from "./select.js";
import { xxHash32 } from "./xxhash32.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "lykos-rotation-"));
  dirs.push(d);
  return d;
}
// Nothing here may read the real home: Pi's agent dir and the default db path point at tmp.
process.env.PI_CODING_AGENT_DIR = tmp();
process.env.LYKOS_CREDENTIALS_DB = join(tmp(), "absent.db");

// ---------------------------------------------------------------------------
// The fake Anthropic Messages server
// ---------------------------------------------------------------------------

type Behaviour =
  | { kind: "ok"; text?: string }
  | { kind: "status"; status: number; body: string }
  /** 200, one text delta, then an SSE `error` event: a failure after content. */
  | { kind: "partial_then_error"; text: string; error: string };

let server: Server;
let baseUrl = "";
/** Behaviour per API key; a list is consumed one entry per request, the last entry repeating. */
const script = new Map<string, Behaviour[]>();
/** The `x-api-key` of every request, in order. */
const seen: string[] = [];
/** Behaviours for the next requests whatever their key, consumed before `script`. */
const upcoming: Behaviour[] = [];

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(): string {
  return sseEvent("message_start", {
    type: "message_start",
    message: {
      id: "msg_fake",
      type: "message",
      role: "assistant",
      model: "m1",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 7, output_tokens: 0 },
    },
  });
}

function textReply(text: string): string {
  return (
    messageStart() +
    sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    }) +
    sseEvent("message_stop", { type: "message_stop" })
  );
}

before(async () => {
  server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const key = String(req.headers["x-api-key"] ?? "");
      seen.push(key);
      const list = script.get(key);
      const behaviour =
        upcoming.shift() ?? (list === undefined ? undefined : list.length > 1 ? list.shift()! : list[0]!);
      if (behaviour === undefined) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `unscripted key ${key}` } }));
        return;
      }
      if (behaviour.kind === "status") {
        res.writeHead(behaviour.status, { "content-type": "application/json" });
        res.end(behaviour.body);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (behaviour.kind === "ok") {
        res.end(textReply(behaviour.text ?? `hello from ${key}`));
        return;
      }
      res.end(
        messageStart() +
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          }) +
          sseEvent("content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: behaviour.text },
          }) +
          `event: error\ndata: ${behaviour.error}\n\n`,
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  script.clear();
  seen.length = 0;
  upcoming.length = 0;
});

function anthropicError(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

// ---------------------------------------------------------------------------
// Pools and runtimes
// ---------------------------------------------------------------------------

const PROVIDER = "fakeprov";
const OAUTH_PROVIDER = "fakeoauth";

interface Pool {
  dir: string;
  dbPath: string;
  modelsPath: string;
}

function newPool(): Pool {
  const dir = tmp();
  const modelsPath = join(dir, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({ providers: { [PROVIDER]: { baseUrl, api: "anthropic-messages", models: [{ id: "m1" }] } } }),
  );
  return { dir, dbPath: join(dir, "credentials.db"), modelsPath };
}

function addKey(pool: Pool, provider: string, key: string): number {
  const db = openCredentialDb(pool.dbPath, { create: true })!;
  try {
    return upsertCredential(db, provider, { type: "api_key", key }).row.id;
  } finally {
    db.close();
  }
}

function addOAuth(pool: Pool, provider: string, access: string, email: string, expires = Date.now() + 3_600_000): number {
  const db = openCredentialDb(pool.dbPath, { create: true })!;
  try {
    return upsertCredential(db, provider, { type: "oauth", access, refresh: `refresh-${access}`, expires, email } as never)
      .row.id;
  } finally {
    db.close();
  }
}

function withDb<T>(pool: Pool, fn: (db: NonNullable<ReturnType<typeof openCredentialDb>>) => T): T {
  const db = openCredentialDb(pool.dbPath, { create: true })!;
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function labelOf(pool: Pool, id: number): string {
  return withDb(pool, (db) => readCredentialById(db, id)!.label);
}

/** A fake OAuth provider on the same wire format; the access token travels as the API key. */
function oauthProvider(refreshToken: (c: Record<string, unknown>) => Promise<Record<string, unknown>>): ProviderConfigInput {
  return {
    baseUrl,
    api: "anthropic-messages",
    // A configured (never-set) key source gives the provider an API-key method too (case 9).
    apiKey: "$LYKOS_ROTATION_TEST_UNSET",
    oauth: {
      name: "Fake OAuth",
      login: async () => {
        throw new Error("not used");
      },
      refreshToken: refreshToken as never,
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

async function runtimeFor(
  pool: Pool,
  opts: {
    providers?: Record<string, ProviderConfigInput>;
    providerConfig?: ProvidersConfig;
    rotations?: RotationEvent[];
  } = {},
): Promise<ModelRuntime> {
  return createLykosModelRuntime({
    modelsPath: pool.modelsPath,
    credentialDbPath: pool.dbPath,
    providers: opts.providers ?? {},
    ...(opts.providerConfig !== undefined ? { providerConfig: opts.providerConfig } : {}),
    ...(opts.rotations !== undefined ? { onRotation: (e: RotationEvent) => opts.rotations!.push(e) } : {}),
  });
}

interface Collected {
  text: string;
  types: string[];
  errorMessage: string | undefined;
  stopReason: string;
}

async function ask(runtime: ModelRuntime, provider: string, sessionId: string | undefined): Promise<Collected> {
  const model = runtime.getModel(provider, "m1");
  assert.ok(model, `model ${provider}/m1 is registered`);
  const stream = runtime.streamSimple(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as never,
    { ...(sessionId !== undefined ? { sessionId } : {}), maxRetries: 0 } as never,
  );
  const types: string[] = [];
  let text = "";
  for await (const event of stream) {
    types.push(event.type);
    if (event.type === "text_delta") text += event.delta;
  }
  const result = await stream.result();
  return { text, types, errorMessage: result.errorMessage, stopReason: result.stopReason };
}

/** A session id whose xxHash32 lands on `index` among `n` rows. */
function sessionStartingAt(index: number, n: number, tag: string): string {
  for (let i = 0; ; i++) {
    const id = `${tag}-${i}`;
    if (xxHash32(id) % n === index) return id;
  }
}

function cooldownOf(pool: Pool, id: number): { untilMs: number; reason: string | null } | undefined {
  return withDb(pool, (db) => activeCooldowns(db, 0).find((c) => c.credentialId === id));
}

function isoInFuture(ms: number): { iso: string; at: number } {
  const at = Math.floor((Date.now() + ms) / 1000) * 1000;
  return { iso: new Date(at).toISOString().replace(".000Z", "Z"), at };
}

// ---------------------------------------------------------------------------
// D1, D3: pure functions
// ---------------------------------------------------------------------------

describe("xxHash32 (D1)", () => {
  it("matches the reference vectors", () => {
    assert.equal(xxHash32(""), 0x02cc5d05);
    assert.equal(xxHash32("a"), 0x550d7456);
    assert.equal(xxHash32("abc"), 0x32d153ff);
    assert.equal(xxHash32("Nobody inspects the spammish repetition"), 0xe2293b2f);
  });
});

describe("classifyFailure (D3)", () => {
  it("reads the status from Pi's SDK form and from the Cloud Code Assist form", () => {
    assert.equal(extractHttpStatus('429 {"type":"error"}'), 429);
    assert.equal(extractHttpStatus("Cloud Code Assist API error: 403 denied"), 403);
    assert.equal(extractHttpStatus("fetch failed"), undefined);
  });

  it("a Cloud Code Assist 429 RESOURCE_EXHAUSTED quota body is a usage limit with its stated reset", () => {
    const now = 1_800_000_000_000;
    const body = JSON.stringify({
      error: {
        code: 429,
        message: "You have exhausted your capacity on this model. Your quota will reset after 1h2m3s.",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }],
      },
    });
    const verdict = classifyFailure({ message: `Cloud Code Assist API error: 429 ${body}`, now });
    assert.equal(verdict.kind, "usage_limit");
    assert.equal(verdict.status, 429);
    assert.equal(verdict.resetAtMs, now + (3600 + 120 + 3) * 1000);
  });

  it("a plain or capacity 429 and a concurrency-cap 403 are left to Pi", () => {
    assert.equal(classifyFailure({ message: `429 ${anthropicError("rate_limit_error", "Too many requests")}` }).kind, "none");
    const perMinute = JSON.stringify({
      error: {
        code: 429,
        message: "Rate limit exceeded",
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RATE_LIMIT_EXCEEDED" }],
      },
    });
    assert.equal(classifyFailure({ message: `Cloud Code Assist API error: 429 ${perMinute}` }).kind, "none");
    assert.equal(classifyFailure({ message: `429 ${anthropicError("overloaded_error", "Overloaded")}` }).kind, "none");
    assert.equal(
      classifyFailure({ message: `403 ${anthropicError("permission_error", "Too many concurrent requests")}` }).kind,
      "none",
    );
  });

  it("an opaque 429 or 402 body rotates, as isUsageLimitOutcome does", () => {
    assert.equal(classifyFailure({ status: 429, message: "429 status code (no body)" }).kind, "usage_limit");
    assert.equal(classifyFailure({ status: 402 }).kind, "usage_limit");
  });

  it("names 401, 403, policy, invalidated and refresh failures", () => {
    assert.equal(classifyFailure({ message: `401 ${anthropicError("authentication_error", "invalid x-api-key")}` }).kind, "auth_401");
    assert.equal(classifyFailure({ message: `403 ${anthropicError("permission_error", "not allowed")}` }).kind, "forbidden");
    assert.equal(classifyFailure({ message: "400 request flagged by cyber_policy" }).kind, "policy");
    assert.equal(classifyFailure({ message: "401 Invalidated OAuth token" }).kind, "invalidated");
    assert.equal(classifyFailure({ message: "OAuth refresh failed for fakeoauth: invalid_grant" }).kind, "refresh_failed");
    assert.equal(classifyFailure({ refreshFailed: true }).kind, "refresh_failed");
    assert.equal(classifyFailure({ message: "Provider is not configured: x" }).kind, "none");
  });

  it("a stated reset time becomes an absolute resetAtMs; none stated leaves it unset", () => {
    const now = 1_800_000_000_000;
    const iso = new Date(now + 7_200_000).toISOString();
    assert.equal(
      classifyFailure({ message: `429 usage limit reached. Your limit will reset at ${iso}`, now }).resetAtMs,
      now + 7_200_000,
    );
    assert.equal(classifyFailure({ message: "429 usage limit reached, try again in 5 min", now }).resetAtMs, now + 300_000);
    assert.equal(classifyFailure({ status: 429, message: "usage limit", headers: { "retry-after": "30" }, now }).resetAtMs, now + 30_000);
    assert.equal(classifyFailure({ message: "429 usage limit reached", now }).resetAtMs, undefined);
  });
});

describe("selectCredential (D2)", () => {
  it("OAuth first; API keys only with no OAuth row or with fallbackToApiKey", () => {
    const pool = newPool();
    const key = addKey(pool, PROVIDER, "k1");
    const oauth = addOAuth(pool, PROVIDER, "tok", "a@example.com");
    withDb(pool, (db) => {
      assert.equal(selectCredential(db, { provider: PROVIDER, peek: true })!.id, oauth);
      upsertCooldown(db, oauth, Date.now() + 60_000);
      assert.equal(selectCredential(db, { provider: PROVIDER, peek: true }), undefined);
      assert.equal(selectCredential(db, { provider: PROVIDER, peek: true, fallbackToApiKey: true })!.id, key);
    });
  });

  it("a pin overrides selection while enabled, even when cooling, and is never overwritten by selection", () => {
    const pool = newPool();
    const a = addKey(pool, PROVIDER, "k1");
    const b = addKey(pool, PROVIDER, "k2");
    const sid = sessionStartingAt(0, 2, "pin");
    withDb(pool, (db) => {
      assert.equal(selectCredential(db, { provider: PROVIDER, sessionId: sid })!.id, a);
      pinCredential(db, sid, PROVIDER, b);
      upsertCooldown(db, b, Date.now() + 60_000);
      assert.equal(selectCredential(db, { provider: PROVIDER, sessionId: sid })!.id, b);
      assert.equal(selectCredential(db, { provider: PROVIDER, sessionId: sid, exclude: new Set([b]) }), undefined);
      assert.equal(selectCredential(db, { provider: PROVIDER, sessionId: sid })!.id, b);
    });
  });

  it("for anthropic, a sticky row idle over an hour no longer holds the session", () => {
    const pool = newPool();
    const a = addKey(pool, "anthropic", "k1");
    const b = addKey(pool, "anthropic", "k2");
    const sid = sessionStartingAt(0, 2, "warm");
    withDb(pool, (db) => {
      // Stick the session to b, then let it idle.
      db.prepare("INSERT INTO sticky (session_id, provider, credential_id, updated_at) VALUES (?, ?, ?, ?)").run(
        sid,
        "anthropic",
        b,
        Date.now() - ANTHROPIC_STICKY_WARM_MS - 1_000,
      );
      assert.equal(selectCredential(db, { provider: "anthropic", sessionId: sid })!.id, a, "idle: re-selected by hash");
      db.prepare("UPDATE sticky SET credential_id = ?, updated_at = ? WHERE session_id = ?").run(b, Date.now(), sid);
      assert.equal(selectCredential(db, { provider: "anthropic", sessionId: sid })!.id, b, "warm: sticky holds");
    });
  });

  it("a version-1 database gains the pinned column", () => {
    const path = join(tmp(), "v1.db");
    const db = openCredentialDb(path, { create: true })!;
    db.exec("DROP TABLE sticky; CREATE TABLE sticky (session_id TEXT NOT NULL, provider TEXT NOT NULL, credential_id INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(session_id, provider)); UPDATE schema_version SET version = 1;");
    db.close();
    const reopened = openCredentialDb(path, { create: false })!;
    try {
      const cols = (reopened.prepare("PRAGMA table_info(sticky)").all() as Array<{ name: string }>).map((c) => c.name);
      assert.ok(cols.includes("pinned"));
      assert.equal((reopened.prepare("SELECT version FROM schema_version").get() as { version: number }).version, 2);
    } finally {
      reopened.close();
    }
  });
});

// ---------------------------------------------------------------------------
// D6: rotation through a real runtime
// ---------------------------------------------------------------------------

describe("rotation against the fake server (D6)", () => {
  it("1. the starting credential is xxHash32(sessionId) % n and sticks for the session", async () => {
    const pool = newPool();
    const keys = ["key-a", "key-b", "key-c"];
    for (const k of keys) {
      addKey(pool, PROVIDER, k);
      script.set(k, [{ kind: "ok" }]);
    }
    const sid = "session-fixed-0001";
    const expected = keys[xxHash32(sid) % 3]!;
    const runtime = await runtimeFor(pool);
    const first = await ask(runtime, PROVIDER, sid);
    const second = await ask(runtime, PROVIDER, sid);
    assert.equal(first.text, `hello from ${expected}`);
    assert.equal(second.text, `hello from ${expected}`);
    assert.deepEqual(seen, [expected, expected]);
    const served = lastServedCredential(sid, PROVIDER);
    assert.equal(served?.type, "api_key");
    assert.equal(served?.label, `key#${keys.indexOf(expected) + 1}`);
  });

  it("2. a usage limit before output completes the turn on the next credential and cools the first until its stated reset", async () => {
    const pool = newPool();
    const a = addKey(pool, PROVIDER, "key-a");
    const b = addKey(pool, PROVIDER, "key-b");
    const reset = isoInFuture(2 * 3_600_000);
    script.set("key-a", [
      {
        kind: "status",
        status: 429,
        body: anthropicError("rate_limit_error", `You have reached your usage limit. Your limit will reset at ${reset.iso}`),
      },
    ]);
    script.set("key-b", [{ kind: "ok" }]);
    const rotations: RotationEvent[] = [];
    const runtime = await runtimeFor(pool, { rotations });
    const got = await ask(runtime, PROVIDER, sessionStartingAt(0, 2, "usage"));
    assert.equal(got.stopReason, "stop");
    assert.equal(got.text, "hello from key-b");
    assert.deepEqual(seen, ["key-a", "key-b"]);
    assert.equal(cooldownOf(pool, a)?.untilMs, reset.at);
    assert.equal(cooldownOf(pool, a)?.reason, "usage_limit");
    assert.equal(cooldownOf(pool, b), undefined);
    assert.deepEqual(rotations, [
      { provider: PROVIDER, fromLabel: labelOf(pool, a), toLabel: labelOf(pool, b), reason: "usage_limit" },
    ]);
    assert.ok(!JSON.stringify(rotations).includes("key-a"), "a rotation notice never carries a secret");
  });

  it("3. a failure after content passes through: one request, no replay, nothing duplicated", async () => {
    const pool = newPool();
    const a = addKey(pool, PROVIDER, "key-a");
    addKey(pool, PROVIDER, "key-b");
    script.set("key-a", [
      { kind: "partial_then_error", text: "partial answer", error: anthropicError("rate_limit_error", "usage limit reached") },
    ]);
    script.set("key-b", [{ kind: "ok" }]);
    const rotations: RotationEvent[] = [];
    const runtime = await runtimeFor(pool, { rotations });
    const got = await ask(runtime, PROVIDER, sessionStartingAt(0, 2, "after"));
    assert.deepEqual(seen, ["key-a"], "the server saw exactly one request");
    assert.equal(got.text, "partial answer", "the text arrived once");
    assert.equal(got.types.filter((t) => t === "start").length, 1);
    assert.equal(got.types.at(-1), "error");
    assert.match(got.errorMessage ?? "", /usage limit reached/);
    assert.deepEqual(rotations, []);
    assert.equal(cooldownOf(pool, a), undefined);
  });

  it("4. a plain 429 is Pi's to retry: no rotation, no cooldown", async () => {
    const pool = newPool();
    const a = addKey(pool, PROVIDER, "key-a");
    addKey(pool, PROVIDER, "key-b");
    script.set("key-a", [{ kind: "status", status: 429, body: anthropicError("rate_limit_error", "Too many requests") }]);
    script.set("key-b", [{ kind: "ok" }]);
    const rotations: RotationEvent[] = [];
    const runtime = await runtimeFor(pool, { rotations });
    const got = await ask(runtime, PROVIDER, sessionStartingAt(0, 2, "plain429"));
    assert.deepEqual(seen, ["key-a"]);
    assert.equal(got.stopReason, "error");
    assert.match(got.errorMessage ?? "", /^429 .*Too many requests/);
    assert.deepEqual(rotations, []);
    assert.equal(cooldownOf(pool, a), undefined);
  });

  it("4b. with no pool, a setup failure ends the stream with its error instead of hanging", { timeout: 10_000 }, async () => {
    const pool = newPool();
    const runtime = await runtimeFor(pool);
    const got = await ask(runtime, PROVIDER, "nopool");
    assert.equal(got.stopReason, "error");
    assert.match(got.errorMessage ?? "", /not configured/i);
    assert.deepEqual(seen, []);
  });

  it("5. a concurrency-cap 403 does not rotate", async () => {
    const pool = newPool();
    addKey(pool, PROVIDER, "key-a");
    addKey(pool, PROVIDER, "key-b");
    script.set("key-a", [
      { kind: "status", status: 403, body: anthropicError("permission_error", "Too many concurrent requests for this account") },
    ]);
    script.set("key-b", [{ kind: "ok" }]);
    const runtime = await runtimeFor(pool);
    const got = await ask(runtime, PROVIDER, sessionStartingAt(0, 2, "conc"));
    assert.deepEqual(seen, ["key-a"]);
    assert.equal(got.stopReason, "error");
  });

  it("6. when every credential fails, exactly n requests hit the server and the first error is reported", async () => {
    const pool = newPool();
    const ids = ["key-a", "key-b", "key-c"].map((k) => {
      script.set(k, [{ kind: "status", status: 429, body: anthropicError("rate_limit_error", `usage limit reached (${k})`) }]);
      return addKey(pool, PROVIDER, k);
    });
    const rotations: RotationEvent[] = [];
    const runtime = await runtimeFor(pool, { rotations });
    const got = await ask(runtime, PROVIDER, sessionStartingAt(0, 3, "allfail"));
    assert.equal(seen.length, 3, `requests: ${seen.join(",")}`);
    assert.deepEqual([...seen].sort(), ["key-a", "key-b", "key-c"]);
    assert.equal(got.stopReason, "error");
    assert.match(got.errorMessage ?? "", /usage limit reached \(key-a\)/, "the first failure, unchanged");
    assert.equal(rotations.length, 2);
    for (const id of ids) assert.equal(cooldownOf(pool, id)?.reason, "usage_limit");

    // The pool is now all cooling: a new call fails without a request, naming the provider.
    seen.length = 0;
    const again = await ask(runtime, PROVIDER, "another-session");
    assert.deepEqual(seen, []);
    assert.match(again.errorMessage ?? "", /No usable credential for fakeprov/);
  });

  it("7. the default cooldown is 60 s when no reset is stated, and 5 min after a failed refresh", async () => {
    const pool = newPool();
    const a = addKey(pool, PROVIDER, "key-a");
    addKey(pool, PROVIDER, "key-b");
    script.set("key-a", [{ kind: "status", status: 429, body: anthropicError("rate_limit_error", "usage limit reached") }]);
    script.set("key-b", [{ kind: "ok" }]);
    const t0 = Date.now();
    const runtime = await runtimeFor(pool);
    const got = await ask(runtime, PROVIDER, sessionStartingAt(0, 2, "default"));
    const t1 = Date.now();
    assert.equal(got.text, "hello from key-b");
    const until = cooldownOf(pool, a)!.untilMs;
    assert.ok(until >= t0 + 60_000 && until <= t1 + 60_000, `60 s cooldown, got ${until - t0} ms`);

    // A refresh that fails: the OAuth row's token is expired, and refreshToken throws.
    const oauthPool = newPool();
    const expired = addOAuth(oauthPool, OAUTH_PROVIDER, "tok-expired", "x@example.com", 0);
    addOAuth(oauthPool, OAUTH_PROVIDER, "tok-good", "y@example.com");
    script.set("tok-good", [{ kind: "ok" }]);
    let refreshes = 0;
    const provider = oauthProvider(async () => {
      refreshes += 1;
      throw new Error("invalid_grant");
    });
    const oauthRuntime = await runtimeFor(oauthPool, { providers: { [OAUTH_PROVIDER]: provider } });
    const r0 = Date.now();
    const got2 = await ask(oauthRuntime, OAUTH_PROVIDER, sessionStartingAt(0, 2, "refreshfail"));
    const r1 = Date.now();
    assert.equal(got2.text, "hello from tok-good");
    assert.equal(refreshes, 1);
    assert.deepEqual(seen.slice(-1), ["tok-good"], "the expired token never reached the server");
    const cooled = cooldownOf(oauthPool, expired)!;
    assert.equal(cooled.reason, "refresh_failed");
    assert.ok(cooled.untilMs >= r0 + 300_000 && cooled.untilMs <= r1 + 300_000, `5 min cooldown, got ${cooled.untilMs - r0} ms`);
  });

  it("8. a second store instance on the same db skips the cooling row", async () => {
    const pool = newPool();
    const a = addKey(pool, PROVIDER, "key-a");
    const b = addKey(pool, PROVIDER, "key-b");
    script.set("key-a", [{ kind: "status", status: 429, body: anthropicError("rate_limit_error", "usage limit reached") }]);
    script.set("key-b", [{ kind: "ok" }]);
    await ask(await runtimeFor(pool), PROVIDER, sessionStartingAt(0, 2, "procA"));
    assert.ok(cooldownOf(pool, a));

    seen.length = 0;
    const other = new LykosCredentialStore({ dbPath: pool.dbPath });
    const sid = sessionStartingAt(0, 2, "procB");
    assert.equal((await other.read(PROVIDER)) !== undefined, true);
    assert.equal(other.selectForRequest(PROVIDER, sid, new Set())?.id, b);
    const got = await ask(await runtimeFor(pool), PROVIDER, sid);
    assert.equal(got.text, "hello from key-b");
    assert.deepEqual(seen, ["key-b"], "the cooling row was never tried");
  });

  it("9. a cooling OAuth pool never reaches an API key unless fallbackToApiKey is set", async () => {
    const pool = newPool();
    const oauthId = addOAuth(pool, OAUTH_PROVIDER, "tok-o", "o@example.com");
    addKey(pool, OAUTH_PROVIDER, "metered-key");
    withDb(pool, (db) => upsertCooldown(db, oauthId, Date.now() + 3_600_000, { reason: "usage_limit" }));
    script.set("metered-key", [{ kind: "ok" }]);
    const provider = oauthProvider(async (c) => c);

    const strict = await runtimeFor(pool, { providers: { [OAUTH_PROVIDER]: provider } });
    const refused = await ask(strict, OAUTH_PROVIDER, "s9");
    assert.equal(refused.stopReason, "error");
    assert.match(refused.errorMessage ?? "", /fallbackToApiKey/);
    assert.deepEqual(seen, [], "the API key never reached the server");

    const optedIn = await runtimeFor(pool, {
      providers: { [OAUTH_PROVIDER]: provider },
      providerConfig: { [OAUTH_PROVIDER]: { auth: "oauth_subscription", fallbackToApiKey: true } },
    });
    const served = await ask(optedIn, OAUTH_PROVIDER, "s9");
    assert.equal(served.text, "hello from metered-key");
    assert.deepEqual(seen, ["metered-key"]);
    assert.equal(lastServedCredential("s9", OAUTH_PROVIDER)?.type, "api_key");
  });

  it("10. a 401 on an OAuth row refreshes that row once, then a second 401 rotates", async () => {
    const pool = newPool();
    const o1 = addOAuth(pool, OAUTH_PROVIDER, "tok-1", "one@example.com");
    const o2 = addOAuth(pool, OAUTH_PROVIDER, "tok-2", "two@example.com");
    const unauthorized: Behaviour = {
      kind: "status",
      status: 401,
      body: anthropicError("authentication_error", "invalid x-api-key"),
    };
    script.set("tok-1", [unauthorized]);
    script.set("tok-1-refreshed", [unauthorized]);
    script.set("tok-2", [{ kind: "ok" }]);
    const refreshed: string[] = [];
    const provider = oauthProvider(async (c) => {
      refreshed.push(String(c.access));
      return { ...c, access: `${String(c.access)}-refreshed`, expires: Date.now() + 3_600_000 };
    });
    const rotations: RotationEvent[] = [];
    const runtime = await runtimeFor(pool, { providers: { [OAUTH_PROVIDER]: provider }, rotations });
    const got = await ask(runtime, OAUTH_PROVIDER, sessionStartingAt(0, 2, "s401"));
    assert.equal(got.text, "hello from tok-2");
    assert.deepEqual(refreshed, ["tok-1"], "exactly one refresh, of the same row");
    assert.deepEqual(seen, ["tok-1", "tok-1-refreshed", "tok-2"]);
    assert.equal(cooldownOf(pool, o1)?.reason, "auth_401");
    assert.deepEqual(rotations, [
      { provider: OAUTH_PROVIDER, fromLabel: "one@example.com", toLabel: "two@example.com", reason: "auth_401" },
    ]);
    assert.equal(
      JSON.parse(withDb(pool, (db) => readCredentialById(db, o1)!.data)).access,
      "tok-1-refreshed",
      "the refresh landed on the same row",
    );
    assert.equal(lastServedCredential(sessionStartingAt(0, 2, "s401"), OAUTH_PROVIDER)?.id, o2);
  });

  it("11. an invalidated OAuth token soft-disables the row, which stays in the store", async () => {
    const pool = newPool();
    const o1 = addOAuth(pool, OAUTH_PROVIDER, "tok-1", "one@example.com");
    addOAuth(pool, OAUTH_PROVIDER, "tok-2", "two@example.com");
    script.set("tok-1", [
      { kind: "status", status: 401, body: anthropicError("authentication_error", "Invalidated OAuth token") },
    ]);
    script.set("tok-2", [{ kind: "ok" }]);
    let refreshes = 0;
    const provider = oauthProvider(async (c) => {
      refreshes += 1;
      return c;
    });
    const runtime = await runtimeFor(pool, { providers: { [OAUTH_PROVIDER]: provider } });
    const got = await ask(runtime, OAUTH_PROVIDER, sessionStartingAt(0, 2, "inval"));
    assert.equal(got.text, "hello from tok-2");
    assert.equal(refreshes, 0);
    const rows = withDb(pool, (db) => listCredentials(db, OAUTH_PROVIDER));
    assert.equal(rows.length, 2, "nothing was deleted");
    assert.equal(rows.find((r) => r.id === o1)?.disabledCause, "invalidated_token");
  });
});

// ---------------------------------------------------------------------------
// D6 case 12: a real Lykos session
// ---------------------------------------------------------------------------

describe("a real Lykos session rotates (D6.12)", () => {
  it("12. runStandaloneTask completes its turn on the second credential", async () => {
    const root = tmp();
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(join(home, ".lykos"), { recursive: true });
    mkdirSync(join(workspace, ".lykos"), { recursive: true });
    writeFileSync(
      join(workspace, ".lykos", "config.yaml"),
      [
        "providers:",
        `  ${PROVIDER}:`,
        "    auth: api_key",
        `    baseUrl: ${baseUrl}`,
        "    api: anthropic-messages",
        "    models:",
        "      - id: m1",
        "",
      ].join("\n"),
    );
    const pool: Pool = { dir: root, dbPath: join(root, "credentials.db"), modelsPath: "" };
    const ids = new Map([
      ["key-a", addKey(pool, PROVIDER, "key-a")],
      ["key-b", addKey(pool, PROVIDER, "key-b")],
    ]);
    // The session id is minted inside the run, so whichever row it starts on
    // gets the usage limit; every later request succeeds.
    upcoming.push({ kind: "status", status: 429, body: anthropicError("rate_limit_error", "usage limit reached") });
    script.set("key-a", [{ kind: "ok", text: "pong" }]);
    script.set("key-b", [{ kind: "ok", text: "pong" }]);

    const outFile = join(root, "result.json");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      LYKOS_CREDENTIALS_DB: pool.dbPath,
    };
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(here, "rotation-session-child.ts"), workspace, `${PROVIDER}/m1`, outFile],
      { cwd: repoRoot, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
    );
    let stderr = "";
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString()));
    const code = await new Promise<number | null>((res, rej) => {
      child.on("error", rej);
      child.on("exit", res);
    });
    assert.equal(code, 0, `child failed: ${stderr}`);
    const result = JSON.parse(readFileSync(outFile, "utf8")) as { status: string; text?: string; message?: string };
    assert.equal(result.status, "ok", JSON.stringify(result));
    assert.match(result.text ?? "", /pong/);
    const [first, ...rest] = seen;
    const second = first === "key-a" ? "key-b" : "key-a";
    assert.ok(rest.length >= 1 && rest.every((k) => k === second), `after rotation only ${second} is used: ${seen.join(",")}`);
    assert.equal(cooldownOf(pool, ids.get(first!)!)?.reason, "usage_limit");
    assert.equal(cooldownOf(pool, ids.get(second)!), undefined);
  });
});
