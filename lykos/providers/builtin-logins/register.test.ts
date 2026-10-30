// The builtin-login seam.
//
// D1: after `createLykosModelRuntime`, `runtime.getProvider(id)` for anthropic, openai-codex
// and github-copilot is a wrapper whose prototype is Pi's own provider: everything but
// `auth.oauth.login` / `auth.oauth.refresh` is the builtin's, `toAuth` included.
// D2 / D5.2: rows shaped exactly as Pi 0.84.3's flows write them (field names read from
// pi-ai dist/auth/oauth/{anthropic,openai-codex,github-copilot}.js) resolve through the
// runtime's `getAuth` with Pi's `toAuth`, and refresh through Lykos's refresh against a
// fake server, updating the same pool row. D5.4: Anthropic streaming still runs Pi's own
// provider and reaches the fake Anthropic-wire server with the pooled OAuth token.
// No test reaches the network.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { openCredentialDb } from "../../credentials/db.js";
import { startFakeAnthropicServer } from "../../credentials/fake-anthropic-server.js";
import { type Credential, listEnabledWithData, upsertCredential } from "../../credentials/pool.js";
import { createLykosModelRuntime } from "../../session/model-runtime.js";
import { jwt, startFakeAuthServer } from "./fake-auth.js";
import { BUILTIN_LOGIN_PROVIDERS } from "./register.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-builtin-logins-")), "absent.db");

/** D27: the credential store's burst connection closes on the next turn; Windows cannot delete an open db. */
const afterBurst = (): Promise<void> => new Promise((r) => setImmediate(r));

function tmpDb(credentials: Record<string, Credential>): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-builtin-logins-db-"));
  const dbPath = join(dir, "credentials.db");
  const db = openCredentialDb(dbPath, { create: true })!;
  try {
    for (const [provider, credential] of Object.entries(credentials)) upsertCredential(db, provider, credential);
  } finally {
    db.close();
  }
  return { dir, dbPath };
}

function rows(dbPath: string, provider: string): ReturnType<typeof listEnabledWithData> {
  const db = openCredentialDb(dbPath, { create: false })!;
  try {
    return listEnabledWithData(db, provider);
  } finally {
    db.close();
  }
}

describe("the builtin-login wrapper delegates to Pi's provider (ticket 15, D1)", () => {
  it("replaces only auth.oauth.login and auth.oauth.refresh", async () => {
    const runtime = await createLykosModelRuntime();
    for (const id of BUILTIN_LOGIN_PROVIDERS) {
      const wrapper = runtime.getProvider(id)!;
      assert.ok(wrapper, id);
      assert.equal(runtime.getRegisteredNativeProvider(id), wrapper, `${id} is registered as a native provider`);
      const builtin = Object.getPrototypeOf(wrapper) as typeof wrapper;
      assert.equal(builtin.id, id);
      assert.deepEqual(Object.keys(wrapper), ["auth"], `${id}: the wrapper's only own member is auth`);
      for (const member of ["getModels", "stream", "streamSimple", "refreshModels", "filterModels"] as const) {
        assert.equal(wrapper[member], builtin[member], `${id}.${member} is the builtin's`);
      }
      assert.equal(wrapper.baseUrl, builtin.baseUrl);
      assert.equal(wrapper.auth.apiKey, builtin.auth.apiKey, `${id}.auth.apiKey is the builtin's`);
      assert.equal(wrapper.auth.oauth!.toAuth, builtin.auth.oauth!.toAuth, `${id}.auth.oauth.toAuth is Pi's`);
      assert.equal(wrapper.auth.oauth!.name, builtin.auth.oauth!.name);
      assert.equal(wrapper.auth.oauth!.isSubscription, builtin.auth.oauth!.isSubscription);
      assert.notEqual(wrapper.auth.oauth!.login, builtin.auth.oauth!.login, `${id}.login is Lykos's`);
      assert.notEqual(wrapper.auth.oauth!.refresh, builtin.auth.oauth!.refresh, `${id}.refresh is Lykos's`);
      assert.deepEqual(
        runtime.getModels(id).map((m) => m.id),
        builtin.getModels().map((m) => m.id),
        `${id}'s models are the builtin's`,
      );
    }
  });

  it("only radius still uses Pi's own login function among Pi builtins with OAuth (ticket 16, D5.4)", async () => {
    const raw = await ModelRuntime.create();
    const rawBuiltinsWithOAuth = raw.getProviders().filter((p) => p.auth?.oauth !== undefined).map((p) => p.id).sort();
    assert.deepEqual(rawBuiltinsWithOAuth, [
      "anthropic",
      "github-copilot",
      "kimi-coding",
      "openai-codex",
      "openrouter",
      "radius",
      "xai",
    ]);

    const runtime = await createLykosModelRuntime();
    for (const id of rawBuiltinsWithOAuth) {
      const provider = runtime.getProvider(id)!;
      assert.ok(provider, `expected provider ${id}`);
      if (id === "radius") {
        assert.equal(Object.getPrototypeOf(provider), Object.prototype, "radius is not wrapped");
        assert.equal(runtime.getRegisteredNativeProvider("radius"), undefined, "radius was not replaced");
      } else {
        const builtin = Object.getPrototypeOf(provider) as typeof provider;
        assert.equal(builtin.id, id);
        assert.notEqual(provider.auth.oauth!.login, builtin.auth.oauth!.login, `${id} login replaces the builtin's`);
        assert.notEqual(provider.auth.oauth!.refresh, builtin.auth.oauth!.refresh, `${id} refresh replaces the builtin's`);
      }
    }
  });
});

describe("rows written by Pi's flow keep working (ticket 15, D2, D5.2)", () => {
  it("Anthropic: a Pi-shaped row resolves through Pi's toAuth and refreshes through Lykos's refresh, in place", async () => {
    const fake = await startFakeAuthServer((req) =>
      req.path === "/v1/oauth/token"
        ? { body: { access_token: "refreshed-anthropic-access", refresh_token: "rotated-anthropic-refresh", expires_in: 28_800, account: { uuid: "acct-1", email_address: "a@example.com" } } }
        : undefined,
    );
    // Pi 0.84.3 anthropic.js `exchangeAuthorizationCode`: { type, refresh, access, expires }.
    const { dir, dbPath } = tmpDb({
      anthropic: { type: "oauth", refresh: "pi-anthropic-refresh", access: "pi-anthropic-access", expires: Date.now() - 1_000 },
    });
    try {
      const runtime = await createLykosModelRuntime({
        credentialDbPath: dbPath,
        builtinLogins: { anthropic: { urls: { tokenUrl: `${fake.base}/v1/oauth/token`, bootstrapUrl: `${fake.base}/bootstrap` } } },
      });
      const before = rows(dbPath, "anthropic");
      const auth = await runtime.getAuth("anthropic");
      assert.equal(auth?.auth.apiKey, "refreshed-anthropic-access");
      assert.equal(fake.requests.length, 1, "one refresh, no bootstrap call (identity came with the response)");
      assert.equal(JSON.parse(fake.requests[0]!.body).refresh_token, "pi-anthropic-refresh");
      const after = rows(dbPath, "anthropic");
      assert.equal(after.length, 1);
      assert.equal(after[0]!.id, before[0]!.id, "refresh updated the same row");
      const data = JSON.parse(after[0]!.data) as Record<string, unknown>;
      assert.equal(data.refresh, "rotated-anthropic-refresh");
      assert.equal(data.email, "a@example.com");

      // A fresh row resolves without any refresh.
      const again = await runtime.getAuth("anthropic");
      assert.equal(again?.auth.apiKey, "refreshed-anthropic-access");
      assert.equal(fake.requests.length, 1);
    } finally {
      await fake.close();
      await afterBurst();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Codex: a Pi-shaped row resolves and refreshes in place", async () => {
    const access = (marker: string): string => jwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-9" }, marker });
    const fake = await startFakeAuthServer((req) =>
      req.path === "/oauth/token" ? { body: { access_token: access("new"), refresh_token: "rotated-codex-refresh", expires_in: 3600 } } : undefined,
    );
    // Pi 0.84.3 openai-codex.js `credentialsFromToken`: { type, access, refresh, expires, accountId }.
    const { dir, dbPath } = tmpDb({
      "openai-codex": { type: "oauth", access: access("old"), refresh: "pi-codex-refresh", expires: Date.now() - 1_000, accountId: "acct-9" },
    });
    try {
      const runtime = await createLykosModelRuntime({
        credentialDbPath: dbPath,
        builtinLogins: { openaiCodex: { urls: { tokenUrl: `${fake.base}/oauth/token` } } },
      });
      const before = rows(dbPath, "openai-codex");
      const auth = await runtime.getAuth("openai-codex");
      assert.equal(auth?.auth.apiKey, access("new"));
      assert.equal(new URLSearchParams(fake.requests[0]!.body).get("refresh_token"), "pi-codex-refresh");
      const after = rows(dbPath, "openai-codex");
      assert.equal(after.length, 1);
      assert.equal(after[0]!.id, before[0]!.id);
      const data = JSON.parse(after[0]!.data) as Record<string, unknown>;
      assert.equal(data.accountId, "acct-9");
      assert.equal(data.refresh, "rotated-codex-refresh");
    } finally {
      await fake.close();
      await afterBurst();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Copilot: a Pi-shaped row resolves to the baseUrl Pi's toAuth computes, and refreshes by re-exchange", async () => {
    const newToken = "tid=new;exp=9;proxy-ep=proxy.business.githubcopilot.com;";
    const fake = await startFakeAuthServer((req) => {
      if (req.path === "/copilot_internal/v2/token") return { body: { token: newToken, expires_at: Math.floor(Date.now() / 1000) + 1800 } };
      if (req.path === "/models") return { body: { data: [{ id: "gpt-4.1", model_picker_enabled: true, policy: { state: "enabled" } }] } };
      return undefined;
    });
    // Pi 0.84.3 github-copilot.js: { type, refresh, access, expires, enterpriseUrl, availableModelIds }.
    const fresh = tmpDb({
      "github-copilot": {
        type: "oauth",
        refresh: "gho_pi_github_token",
        access: "tid=pi;exp=9;proxy-ep=proxy.individual.githubcopilot.com;",
        expires: Date.now() + 3_600_000,
        availableModelIds: ["gpt-4.1"],
      },
    });
    const enterprise = tmpDb({
      "github-copilot": {
        type: "oauth",
        refresh: "gho_pi_enterprise_token",
        access: "tid=pi-ent;exp=9",
        expires: Date.now() + 3_600_000,
        enterpriseUrl: "company.ghe.com",
        availableModelIds: ["gpt-4.1"],
      },
    });
    const expired = tmpDb({
      "github-copilot": {
        type: "oauth",
        refresh: "gho_pi_github_token",
        access: "tid=pi;exp=1;proxy-ep=proxy.individual.githubcopilot.com;",
        expires: Date.now() - 1_000,
        availableModelIds: ["gpt-4.1"],
      },
    });
    try {
      const deps = { urls: { copilotTokenUrl: `${fake.base}/copilot_internal/v2/token`, apiBaseUrl: fake.base } };

      const r1 = await createLykosModelRuntime({ credentialDbPath: fresh.dbPath, builtinLogins: { githubCopilot: deps } });
      const a1 = await r1.getAuth("github-copilot");
      assert.equal(a1?.auth.apiKey, "tid=pi;exp=9;proxy-ep=proxy.individual.githubcopilot.com;");
      assert.equal(a1?.auth.baseUrl, "https://api.individual.githubcopilot.com");

      const r2 = await createLykosModelRuntime({ credentialDbPath: enterprise.dbPath, builtinLogins: { githubCopilot: deps } });
      const a2 = await r2.getAuth("github-copilot");
      assert.equal(a2?.auth.baseUrl, "https://copilot-api.company.ghe.com", "Pi's toAuth reads enterpriseUrl");
      assert.equal(fake.requests.length, 0);

      const r3 = await createLykosModelRuntime({ credentialDbPath: expired.dbPath, builtinLogins: { githubCopilot: deps } });
      const before = rows(expired.dbPath, "github-copilot");
      const a3 = await r3.getAuth("github-copilot");
      assert.equal(a3?.auth.apiKey, newToken);
      assert.equal(a3?.auth.baseUrl, "https://api.business.githubcopilot.com", "the new token's proxy-ep, through Pi's toAuth");
      assert.equal(fake.requests[0]!.headers.authorization, "Bearer gho_pi_github_token");
      const after = rows(expired.dbPath, "github-copilot");
      assert.equal(after.length, 1);
      assert.equal(after[0]!.id, before[0]!.id);
      const data = JSON.parse(after[0]!.data) as Record<string, unknown>;
      assert.equal(data.refresh, "gho_pi_github_token");
      assert.deepEqual(data.availableModelIds, ["gpt-4.1"]);
    } finally {
      await fake.close();
      await afterBurst();
      for (const t of [fresh, enterprise, expired]) rmSync(t.dir, { recursive: true, force: true });
    }
  });

  it("OpenRouter: a Pi-shaped row resolves through Pi's toAuth without refresh (ticket 16, D2, D5.2)", async () => {
    // Pi 0.84.3 openrouter.js: { type, access, refresh, expires }.
    const { dir, dbPath } = tmpDb({
      openrouter: { type: "oauth", access: "pi-openrouter-key", refresh: "", expires: Number.MAX_SAFE_INTEGER },
    });
    try {
      const runtime = await createLykosModelRuntime({ credentialDbPath: dbPath });
      const auth = await runtime.getAuth("openrouter");
      assert.equal(auth?.auth.apiKey, "pi-openrouter-key");
    } finally {
      await afterBurst();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Kimi: a Pi-shaped row resolves to Authorization header and refreshes in place (ticket 16, D2, D5.2)", async () => {
    const fake = await startFakeAuthServer((req) =>
      req.path === "/api/oauth/token"
        ? { body: { access_token: "refreshed-kimi-access", refresh_token: "rotated-kimi-refresh", expires_in: 3600 } }
        : undefined,
    );
    // Pi 0.84.3 kimi-coding.js: { type, access, refresh, expires }.
    const { dir, dbPath } = tmpDb({
      "kimi-coding": { type: "oauth", access: "pi-kimi-access", refresh: "pi-kimi-refresh", expires: Date.now() - 1_000 },
    });
    try {
      const runtime = await createLykosModelRuntime({
        credentialDbPath: dbPath,
        builtinLogins: { kimiCoding: { urls: { tokenUrl: `${fake.base}/api/oauth/token` } } },
      });
      const before = rows(dbPath, "kimi-coding");
      const auth = await runtime.getAuth("kimi-coding");
      assert.equal(auth?.auth.headers?.Authorization, "Bearer refreshed-kimi-access");
      assert.equal(fake.requests.length, 1);
      const after = rows(dbPath, "kimi-coding");
      assert.equal(after.length, 1);
      assert.equal(after[0]!.id, before[0]!.id);
      const data = JSON.parse(after[0]!.data) as Record<string, unknown>;
      assert.equal(data.refresh, "rotated-kimi-refresh");
    } finally {
      await fake.close();
      await afterBurst();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("xAI: a Pi-shaped row resolves and refreshes in place with userinfo (ticket 16, D2, D5.2)", async () => {
    const fake = await startFakeAuthServer((req) => {
      if (req.path === "/oauth2/token") {
        return { body: { access_token: "refreshed-xai-access", refresh_token: "rotated-xai-refresh", expires_in: 3600 } };
      }
      if (req.path === "/oauth2/userinfo") {
        return { body: { sub: "acct-xai-1", email: "elon@x.ai" } };
      }
      return undefined;
    });
    // Pi 0.84.3 xai.js: { type, access, refresh, expires }.
    const { dir, dbPath } = tmpDb({
      xai: { type: "oauth", access: "pi-xai-access", refresh: "pi-xai-refresh", expires: Date.now() - 1_000 },
    });
    try {
      const runtime = await createLykosModelRuntime({
        credentialDbPath: dbPath,
        builtinLogins: {
          xai: {
            urls: {
              tokenUrl: `${fake.base}/oauth2/token`,
              userinfoUrl: `${fake.base}/oauth2/userinfo`,
            },
          },
        },
      });
      const before = rows(dbPath, "xai");
      const auth = await runtime.getAuth("xai");
      assert.equal(auth?.auth.apiKey, "refreshed-xai-access");
      assert.equal(fake.requests.length, 2, "one refresh + one userinfo");
      const after = rows(dbPath, "xai");
      assert.equal(after.length, 1);
      assert.equal(after[0]!.id, before[0]!.id);
      const data = JSON.parse(after[0]!.data) as Record<string, unknown>;
      assert.equal(data.refresh, "rotated-xai-refresh");
      assert.equal(data.accountId, "acct-xai-1");
      assert.equal(data.email, "elon@x.ai");
    } finally {
      await fake.close();
      await afterBurst();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("streaming still runs Pi's own provider (ticket 15, D5.4)", () => {
  it("an Anthropic model's streamSimple reaches the fake Anthropic-wire server with the pooled OAuth token", async () => {
    const server = await startFakeAnthropicServer();
    // No `sk-ant-oat` marker, so Pi's anthropic-messages client sends it as `x-api-key`,
    // the header the fake server keys on; the row is still an OAuth row resolved by Pi's toAuth.
    const pooled = "pooled-anthropic-oauth-access";
    server.script.set(pooled, [{ kind: "ok", text: "hello from the fake" }]);
    const { dir, dbPath } = tmpDb({
      anthropic: { type: "oauth", access: pooled, refresh: "pooled-refresh", expires: Date.now() + 3_600_000 },
    });
    try {
      const runtime = await createLykosModelRuntime({ credentialDbPath: dbPath });
      const model = runtime.getModels("anthropic")[0];
      assert.ok(model, "Pi ships anthropic models");
      const stream = runtime.streamSimple(
        { ...model, baseUrl: server.baseUrl },
        { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
        { sessionId: "builtin-login-stream-test" },
      );
      let text = "";
      for await (const event of stream) if (event.type === "text_delta") text += event.delta;
      const result = await stream.result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(text, "hello from the fake");
      assert.deepEqual(server.seen, [pooled]);
    } finally {
      await server.close();
      await afterBurst();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
