// OpenRouter login and refresh against a local fake authorization server (P14 ticket 16,
// plan D3, D5.1). Responses are written, not recorded.
// No test reaches the network; the callback port is injected (0), never the real 54549.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  announcedAuthUrl,
  type FakeAuthServer,
  type FakeRequest,
  hitCallback,
  scriptedInteraction,
  startFakeAuthServer,
  waitFor,
} from "../builtin-logins/fake-auth.js";
import {
  OPENROUTER_AUTHORIZE_URL,
  type OpenRouterOAuthDeps,
  loginOpenRouter,
  refreshOpenRouter,
} from "./oauth.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-openrouter-oauth-")), "absent.db");

const SECRET_KEY = "sk-or-v1-SECRET-API-KEY-VALUE";

function tokenServer(opts: { status?: number; errorBody?: unknown } = {}): Promise<FakeAuthServer> {
  return startFakeAuthServer((req) => {
    if (req.path === "/api/v1/auth/keys" && req.method === "POST") {
      if (opts.status !== undefined) {
        return {
          status: opts.status,
          body: opts.errorBody ?? { error: { message: "Invalid authorization code", secret_leak: SECRET_KEY } },
        };
      }
      return {
        body: {
          key: SECRET_KEY,
        },
      };
    }
    return undefined;
  });
}

function depsFor(server: FakeAuthServer, extra: OpenRouterOAuthDeps = {}): OpenRouterOAuthDeps {
  return {
    callbackPort: 0,
    urls: {
      authorizeUrl: OPENROUTER_AUTHORIZE_URL,
      tokenUrl: `${server.base}/api/v1/auth/keys`,
    },
    ...extra,
  };
}

function tokenCalls(server: FakeAuthServer): FakeRequest[] {
  return server.requests.filter((r) => r.path === "/api/v1/auth/keys");
}

describe("OpenRouter login (ticket 16, D3)", () => {
  it("runs PKCE through the loopback callback with state none and exchanges as JSON", async () => {
    const server = await tokenServer();
    try {
      let port = -1;
      const s = scriptedInteraction(() => undefined);
      const login = loginOpenRouter(s.interaction, depsFor(server, { onListening: (p) => (port = p) }));
      const url = await waitFor(() => (s.events.some((e) => e.type === "auth_url") ? announcedAuthUrl(s.events) : undefined));

      assert.equal(url.origin + url.pathname, "https://openrouter.ai/auth");
      assert.equal(url.searchParams.get("callback_url"), `http://localhost:${port}/callback`);
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(url.searchParams.has("state"), false, "OpenRouter has state 'none'");
      assert.equal(url.searchParams.has("client_id"), false, "OpenRouter has no client_id");

      const status = await hitCallback(port, "/callback", { code: "openrouter-auth-code-123" });
      assert.equal(status, 200);

      const credential = await login;
      assert.equal(credential.type, "oauth");
      assert.equal(credential.access, SECRET_KEY);
      assert.equal(credential.refresh, "");
      assert.equal(credential.expires, Number.MAX_SAFE_INTEGER);

      const calls = tokenCalls(server);
      assert.equal(calls.length, 1);
      const body = JSON.parse(calls[0]!.body) as Record<string, string>;
      assert.equal(body.code, "openrouter-auth-code-123");
      assert.equal(body.code_challenge_method, "S256");
      const verifier = body.code_verifier;
      assert.ok(verifier, "verifier must be present");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      assert.equal(url.searchParams.get("code_challenge"), challenge);
    } finally {
      await server.close();
    }
  });

  it("accepts a pasted authorization code or redirect URL", async () => {
    const server = await tokenServer();
    try {
      const s = scriptedInteraction((p) =>
        p.type === "manual_code" ? "http://localhost:54549/callback?code=pasted-or-code" : undefined,
      );
      const credential = await loginOpenRouter(s.interaction, depsFor(server));
      assert.equal(credential.access, SECRET_KEY);
      const calls = tokenCalls(server);
      assert.equal(calls.length, 1);
      assert.equal((JSON.parse(calls[0]!.body) as Record<string, string>).code, "pasted-or-code");
    } finally {
      await server.close();
    }
  });

  it("refresh returns the credential unchanged (refresh none)", async () => {
    const cred = {
      type: "oauth" as const,
      access: "sk-or-existing",
      refresh: "",
      expires: Number.MAX_SAFE_INTEGER,
    };
    const refreshed = await refreshOpenRouter(cred);
    assert.deepEqual(refreshed, cred);
  });

  it("a failed exchange names the status and carries no token or body secret", async () => {
    const server = await tokenServer({ status: 401 });
    try {
      let port = -1;
      const s = scriptedInteraction(() => undefined);
      const login = loginOpenRouter(s.interaction, depsFor(server, { onListening: (p) => (port = p) }));
      await waitFor(() => (s.events.some((e) => e.type === "auth_url") ? true : undefined));
      await hitCallback(port, "/callback", { code: "openrouter-bad-code" });
      await assert.rejects(
        login,
        (err: Error) => {
          assert.equal(err.name, "OAuthLoginError");
          assert.match(err.message, /401/);
          assert.ok(!err.message.includes(SECRET_KEY), "error must not leak secret");
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });

  it("an authorization denial fails the login cleanly", async () => {
    const server = await tokenServer();
    try {
      let port = -1;
      const s = scriptedInteraction(() => undefined);
      const login = loginOpenRouter(s.interaction, depsFor(server, { onListening: (p) => (port = p) }));
      login.catch(() => {});
      await waitFor(() => (s.events.some((e) => e.type === "auth_url") ? true : undefined));
      const status = await hitCallback(port, "/callback", { error: "access_denied", error_description: "User denied" });
      assert.equal(status, 500);
      await assert.rejects(login, /Authorization failed: User denied/);
      assert.equal(tokenCalls(server).length, 0, "denial stops before token exchange");
    } finally {
      await server.close();
    }
  });
});
