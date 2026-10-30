// OpenAI Codex login (browser and device) and refresh against a local fake authorization
// server. Request shapes follow Pi 0.84.3's dist/auth/oauth/openai-codex.js; responses are
// written, not recorded. No test reaches the network. The callback port is injected; the
// one test that proves a busy port fails binds a random port itself and injects it, and
// never touches 1455.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCredentialDb } from "../../credentials/db.js";
import { type LoginSurface, runLoginFlow, sanctionWarning } from "../../credentials/login-flow.js";
import { listEnabledWithData } from "../../credentials/pool.js";
import { createLykosModelRuntime } from "../../session/model-runtime.js";
import {
  announcedAuthUrl,
  type FakeAuthServer,
  hitCallback,
  jwt,
  scriptedInteraction,
  startFakeAuthServer,
  waitFor,
} from "../builtin-logins/fake-auth.js";
import {
  CODEX_CLIENT_ID,
  CODEX_DEVICE_AUTH_URL,
  CODEX_DEVICE_REDIRECT_URI,
  CODEX_REDIRECT_URI,
  type CodexOAuthDeps,
  loginCodexBrowser,
  loginCodexDevice,
  refreshCodex,
} from "./oauth.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-codex-oauth-")), "absent.db");

function codexAccess(accountId: string, email: string, marker = "SECRET"): string {
  return jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    "https://api.openai.com/profile": { email },
    marker,
  });
}

interface FakeCodex {
  server: FakeAuthServer;
  /** Device polls answered "pending" (403) before the code is issued. */
  pendingPolls: number;
}

async function fakeCodex(opts: { tokenStatus?: number; pendingPolls?: number } = {}): Promise<FakeCodex> {
  const state: FakeCodex = { server: undefined as unknown as FakeAuthServer, pendingPolls: opts.pendingPolls ?? 1 };
  state.server = await startFakeAuthServer((req) => {
    if (req.path === "/oauth/token" && req.method === "POST") {
      if (opts.tokenStatus !== undefined) return { status: opts.tokenStatus, body: { error: "invalid_grant", access_token: "SECRET" } };
      const form = new URLSearchParams(req.body);
      const refresh = form.get("grant_type") === "refresh_token";
      return {
        body: {
          access_token: refresh ? codexAccess("acct-1", "user@example.com", "refreshed") : codexAccess("acct-1", "User@Example.com"),
          refresh_token: refresh ? "rotated-refresh" : "SECRET-refresh",
          id_token: jwt({ "https://api.openai.com/auth": { chatgpt_plan_type: "Pro" } }),
          expires_in: 3600,
        },
      };
    }
    if (req.path === "/api/accounts/deviceauth/usercode" && req.method === "POST") {
      return { body: { device_auth_id: "dev-auth-1", user_code: "ABCD-EFGH", interval: "5" } };
    }
    if (req.path === "/api/accounts/deviceauth/token" && req.method === "POST") {
      if (state.pendingPolls > 0) {
        state.pendingPolls -= 1;
        return { status: 403, body: {} };
      }
      return { body: { authorization_code: "device-code-1", code_verifier: "device-verifier-1" } };
    }
    return undefined;
  });
  return state;
}

function depsFor(server: FakeAuthServer, extra: CodexOAuthDeps = {}): CodexOAuthDeps {
  return {
    callbackPort: 0,
    now: () => 2_000_000,
    sleep: async () => {},
    urls: {
      tokenUrl: `${server.base}/oauth/token`,
      deviceUserCodeUrl: `${server.base}/api/accounts/deviceauth/usercode`,
      deviceTokenUrl: `${server.base}/api/accounts/deviceauth/token`,
    },
    ...extra,
  };
}

const EXPECTED_LOGIN = {
  type: "oauth",
  access: codexAccess("acct-1", "User@Example.com"),
  refresh: "SECRET-refresh",
  expires: 2_000_000 + 3_600_000,
  accountId: "acct-1",
  email: "user@example.com",
  orgId: "acct-1",
  orgName: "pro",
};

describe("Codex browser login (ticket 15, D3)", () => {
  it("advertises exactly the allowlisted redirect URI with Pi's originator, and exchanges as a form", async () => {
    const fake = await fakeCodex();
    try {
      let port = -1;
      const s = scriptedInteraction(() => undefined);
      const login = loginCodexBrowser(s.interaction, depsFor(fake.server, { onListening: (p) => (port = p) }));
      const url = await waitFor(() => (s.events.some((e) => e.type === "auth_url") ? announcedAuthUrl(s.events) : undefined));
      assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
      assert.equal(url.searchParams.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
      assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
      assert.notEqual(port, 1455, "the test bound an injected port, never 1455");
      assert.equal(url.searchParams.get("originator"), "pi");
      assert.equal(url.searchParams.get("scope"), "openid profile email offline_access api.connectors.read api.connectors.invoke");
      assert.equal(url.searchParams.get("id_token_add_organizations"), "true");
      assert.equal(url.searchParams.get("codex_cli_simplified_flow"), "true");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");

      assert.equal(await hitCallback(port, "/auth/callback", { code: "browser-code", state: url.searchParams.get("state")! }), 200);
      const credential = await login;
      assert.deepEqual(credential, EXPECTED_LOGIN);

      const call = fake.server.requests.find((r) => r.path === "/oauth/token")!;
      assert.equal(call.headers["content-type"], "application/x-www-form-urlencoded");
      const form = Object.fromEntries(new URLSearchParams(call.body));
      assert.deepEqual(form, {
        grant_type: "authorization_code",
        client_id: CODEX_CLIENT_ID,
        code: "browser-code",
        redirect_uri: CODEX_REDIRECT_URI,
        code_verifier: form.code_verifier,
      });
    } finally {
      await fake.server.close();
    }
  });

  it("a busy callback port fails plainly, without falling back to another port", async () => {
    const fake = await fakeCodex();
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const busy = (blocker.address() as AddressInfo).port;
    try {
      const s = scriptedInteraction(() => undefined);
      await assert.rejects(loginCodexBrowser(s.interaction, depsFor(fake.server, { callbackPort: busy })), (err: Error) => {
        assert.match(err.message, new RegExp(`OAuth callback port ${busy} is in use`));
        assert.match(err.message, /lykos login openai-codex/);
        return true;
      });
      assert.equal(s.events.filter((e) => e.type === "auth_url").length, 0, "no authorize URL with another port was announced");
      assert.equal(fake.server.requests.length, 0);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
      await fake.server.close();
    }
  });

  it("a failed exchange names the status and carries no token", async () => {
    const fake = await fakeCodex({ tokenStatus: 401 });
    try {
      let port = -1;
      const s = scriptedInteraction(() => undefined);
      const login = loginCodexBrowser(s.interaction, depsFor(fake.server, { onListening: (p) => (port = p) }));
      const url = await waitFor(() => (s.events.some((e) => e.type === "auth_url") ? announcedAuthUrl(s.events) : undefined));
      await hitCallback(port, "/auth/callback", { code: "c", state: url.searchParams.get("state")! });
      await assert.rejects(login, (err: Error) => {
        assert.match(err.message, /openai-codex token exchange failed: 401/);
        assert.ok(!err.message.includes("SECRET"), err.message);
        return true;
      });
    } finally {
      await fake.server.close();
    }
  });
});

describe("Codex device login (ticket 15, D3)", () => {
  it("polls through pending, then exchanges with the device redirect URI", async () => {
    const fake = await fakeCodex({ pendingPolls: 2 });
    try {
      const s = scriptedInteraction(() => undefined);
      const credential = await loginCodexDevice(s.interaction, depsFor(fake.server));
      assert.deepEqual(credential, EXPECTED_LOGIN);
      const device = s.events.find((e) => e.type === "device_code");
      assert.deepEqual(device, { type: "device_code", userCode: "ABCD-EFGH", verificationUri: CODEX_DEVICE_AUTH_URL, intervalSeconds: 5 });
      const init = fake.server.requests.find((r) => r.path === "/api/accounts/deviceauth/usercode")!;
      assert.deepEqual(JSON.parse(init.body), { client_id: CODEX_CLIENT_ID });
      const polls = fake.server.requests.filter((r) => r.path === "/api/accounts/deviceauth/token");
      assert.equal(polls.length, 3);
      assert.deepEqual(JSON.parse(polls[0]!.body), { device_auth_id: "dev-auth-1", user_code: "ABCD-EFGH" });
      const form = Object.fromEntries(new URLSearchParams(fake.server.requests.find((r) => r.path === "/oauth/token")!.body));
      assert.equal(form.code, "device-code-1");
      assert.equal(form.code_verifier, "device-verifier-1");
      assert.equal(form.redirect_uri, CODEX_DEVICE_REDIRECT_URI);
    } finally {
      await fake.server.close();
    }
  });
});

describe("Codex refresh (ticket 15, D3)", () => {
  it("refreshes a Pi-shaped row with the three form parameters, keeping every stored field", async () => {
    const fake = await fakeCodex();
    try {
      // Pi 0.84.3's `credentialsFromToken` shape: type, access, refresh, expires, accountId.
      const stored = { type: "oauth" as const, access: codexAccess("acct-1", "user@example.com"), refresh: "pi-refresh", expires: 0, accountId: "acct-1" };
      const next = await refreshCodex(stored, depsFor(fake.server));
      const form = Object.fromEntries(new URLSearchParams(fake.server.requests[0]!.body));
      assert.deepEqual(form, { grant_type: "refresh_token", client_id: CODEX_CLIENT_ID, refresh_token: "pi-refresh" });
      assert.equal(next.refresh, "rotated-refresh");
      assert.equal(next.accountId, "acct-1");
      assert.equal(next.email, "user@example.com");
      assert.equal(next.expires, 2_000_000 + 3_600_000);
      assert.equal(next.orgId, undefined, "refresh never invents an org the row did not have");
    } finally {
      await fake.server.close();
    }
  });
});

describe("both Codex variants store under openai-codex (ticket 15, D5.3)", () => {
  it("lykos login openai-codex asks browser or device through a select, and both land in the openai-codex pool", async () => {
    const fake = await fakeCodex({ pendingPolls: 0 });
    const dir = mkdtempSync(join(tmpdir(), "lykos-codex-variants-"));
    const dbPath = join(dir, "credentials.db");
    try {
      let port = -1;
      const errLines: string[] = [];
      const surface = (choice: string): LoginSurface => ({
        dbPath,
        out: () => {},
        err: (line) => errLines.push(line),
        ask: async (q) => {
          if (q.prompt === "choice") return choice;
          // The manual-paste prompt waits until the browser callback wins and aborts it.
          return new Promise<string | undefined>((_r, reject) => q.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
        },
        openBrowser: (url) => {
          if (url.startsWith("https://auth.openai.com/oauth/authorize")) {
            const state = new URL(url).searchParams.get("state")!;
            void waitFor(() => (port > 0 ? port : undefined)).then((p) => hitCallback(p, "/auth/callback", { code: "c1", state }));
          }
        },
        createRuntime: (opts) =>
          createLykosModelRuntime({
            ...opts,
            builtinLogins: { openaiCodex: depsFor(fake.server, { onListening: (p) => (port = p) }) },
          }),
      });

      assert.equal(await runLoginFlow("openai-codex", false, surface("1")), 0, errLines.join("\n"));
      assert.ok(errLines.includes("Select OpenAI Codex login method:"));
      assert.ok(errLines.some((l) => l.includes(sanctionWarning("openai-codex"))), "the ordinary sanction warning (D5.5)");
      port = -1;
      assert.equal(await runLoginFlow("openai-codex", false, surface("device_code")), 0, errLines.join("\n"));

      const db = openCredentialDb(dbPath, { create: false })!;
      try {
        const rows = listEnabledWithData(db, "openai-codex");
        assert.equal(rows.length, 1, "the same account from either variant is one pool row");
        assert.equal(rows[0]!.provider, "openai-codex");
        assert.equal(listEnabledWithData(db, "openai-codex-device").length, 0);
      } finally {
        db.close();
      }
      assert.equal(fake.server.requests.filter((r) => r.path === "/api/accounts/deviceauth/usercode").length, 1);
      assert.equal(fake.server.requests.filter((r) => r.path === "/oauth/token").length, 2);
    } finally {
      await fake.server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
