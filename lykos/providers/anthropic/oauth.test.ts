// Anthropic login and refresh against a local fake authorization server (P14 ticket 15,
// plan D3, D5.1). Responses are written, not recorded.
// No test reaches the network; the callback port is injected (0), never the real 54545.

import assert from "node:assert/strict";
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
  ANTHROPIC_CLIENT_ID,
  ANTHROPIC_SCOPES,
  type AnthropicOAuthDeps,
  loginAnthropic,
  refreshAnthropic,
} from "./oauth.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-anthropic-oauth-")), "absent.db");

const SECRET_ACCESS = "sk-ant-oat01-SECRET-ACCESS-TOKEN-VALUE";
const SECRET_REFRESH = "sk-ant-ort01-SECRET-REFRESH-TOKEN-VALUE";

function tokenServer(opts: { identity?: boolean; status?: number } = {}): Promise<FakeAuthServer> {
  return startFakeAuthServer((req) => {
    if (req.path === "/v1/oauth/token" && req.method === "POST") {
      if (opts.status !== undefined) return { status: opts.status, body: { error: "invalid_grant", refresh_token: SECRET_REFRESH } };
      const body = JSON.parse(req.body) as Record<string, string>;
      const refresh = body.grant_type === "refresh_token";
      return {
        body: {
          access_token: refresh ? "sk-ant-oat01-refreshed" : SECRET_ACCESS,
          refresh_token: refresh ? "sk-ant-ort01-rotated" : SECRET_REFRESH,
          expires_in: 28_800,
          ...(opts.identity === false
            ? {}
            : {
                account: { uuid: "acct-1", email_address: "user@example.com" },
                ...(refresh ? {} : { organization: { uuid: "org-1", name: "Personal" } }),
              }),
        },
      };
    }
    if (req.path === "/api/claude_cli/bootstrap" && req.method === "GET") {
      return {
        body: {
          oauth_account: {
            account_uuid: "acct-boot",
            account_email: "boot@example.com",
            organization_uuid: "org-boot",
            organization_name: "Boot Org",
          },
        },
      };
    }
    return undefined;
  });
}

function depsFor(server: FakeAuthServer, extra: AnthropicOAuthDeps = {}): AnthropicOAuthDeps {
  return {
    callbackPort: 0,
    now: () => 1_000_000,
    urls: {
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: `${server.base}/v1/oauth/token`,
      bootstrapUrl: `${server.base}/api/claude_cli/bootstrap`,
    },
    ...extra,
  };
}

function tokenCalls(server: FakeAuthServer): FakeRequest[] {
  return server.requests.filter((r) => r.path === "/v1/oauth/token");
}

describe("Anthropic login (ticket 15, D3)", () => {
  it("runs PKCE through the loopback callback and exchanges as JSON with state", async () => {
    const server = await tokenServer();
    try {
      let port = -1;
      const s = scriptedInteraction(() => undefined);
      const login = loginAnthropic(s.interaction, depsFor(server, { onListening: (p) => (port = p) }));
      const url = await waitFor(() => (s.events.some((e) => e.type === "auth_url") ? announcedAuthUrl(s.events) : undefined));
      assert.equal(url.origin + url.pathname, "https://claude.ai/oauth/authorize");
      assert.equal(url.searchParams.get("client_id"), ANTHROPIC_CLIENT_ID);
      assert.equal(ANTHROPIC_CLIENT_ID, "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
      assert.equal(url.searchParams.get("response_type"), "code");
      assert.equal(url.searchParams.get("scope"), ANTHROPIC_SCOPES.join(" "));
      assert.equal(url.searchParams.get("code"), "true");
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const redirect = url.searchParams.get("redirect_uri")!;
      assert.equal(redirect, `http://localhost:${port}/callback`);
      const state = url.searchParams.get("state")!;
      assert.match(state, /^[0-9a-f]{32}$/);

      assert.equal(await hitCallback(port, "/callback", { code: "auth-code-1", state }), 200);
      const credential = await login;

      const [call] = tokenCalls(server);
      assert.equal(call!.headers["content-type"], "application/json");
      const body = JSON.parse(call!.body) as Record<string, string>;
      assert.deepEqual(Object.keys(body).sort(), ["client_id", "code", "code_verifier", "grant_type", "redirect_uri", "state"]);
      assert.equal(body.grant_type, "authorization_code");
      assert.equal(body.code, "auth-code-1");
      assert.equal(body.state, state);
      assert.equal(body.redirect_uri, redirect);
      assert.ok(body.code_verifier!.length >= 43);

      assert.deepEqual(credential, {
        type: "oauth",
        access: SECRET_ACCESS,
        refresh: SECRET_REFRESH,
        expires: 1_000_000 + 28_800_000 - 300_000,
        accountId: "acct-1",
        email: "user@example.com",
        orgId: "org-1",
        orgName: "Personal",
      });
      assert.equal(server.requests.filter((r) => r.path === "/api/claude_cli/bootstrap").length, 0, "identity was in the token response");
    } finally {
      await server.close();
    }
  });

  it("accepts a pasted redirect URL, and fills identity from the bootstrap endpoint when the response omits it", async () => {
    const server = await tokenServer({ identity: false });
    try {
      let state = "";
      const s = scriptedInteraction((p) => {
        if (p.type !== "manual_code") return undefined;
        return waitFor(() => (s.events.some((e) => e.type === "auth_url") ? announcedAuthUrl(s.events) : undefined)).then((u) => {
          state = u.searchParams.get("state")!;
          return `http://localhost:54545/callback?code=pasted-code&state=${state}`;
        });
      });
      const credential = await loginAnthropic(s.interaction, depsFor(server));
      const body = JSON.parse(tokenCalls(server)[0]!.body) as Record<string, string>;
      assert.equal(body.code, "pasted-code");
      assert.equal(body.state, state);
      assert.equal(credential.accountId, "acct-boot");
      assert.equal(credential.email, "boot@example.com");
      assert.equal(credential.orgId, "org-boot");
      assert.equal(credential.orgName, "Boot Org");
      const boot = server.requests.find((r) => r.path === "/api/claude_cli/bootstrap")!;
      assert.equal(boot.query.get("entrypoint"), "cli");
      assert.equal(boot.query.get("model"), "claude-opus-4-8");
      assert.equal(boot.headers.authorization, `Bearer ${SECRET_ACCESS}`);
      assert.equal(boot.headers["user-agent"], "claude-code/2.1.257");
    } finally {
      await server.close();
    }
  });

  it("refreshes with the Claude Code headers, keeps the stored org and every stored field", async () => {
    const server = await tokenServer();
    try {
      const stored = {
        type: "oauth" as const,
        access: "old-access",
        refresh: "old-refresh",
        expires: 0,
        accountId: "acct-1",
        email: "user@example.com",
        orgId: "org-1",
        orgName: "Personal",
      };
      const next = await refreshAnthropic(stored, depsFor(server));
      const [call] = tokenCalls(server);
      assert.equal(call!.headers["anthropic-beta"], "oauth-2025-04-20");
      assert.equal(call!.headers["user-agent"], "anthropic-sdk-typescript/0.112.1 userOAuthProvider");
      assert.deepEqual(JSON.parse(call!.body), { grant_type: "refresh_token", client_id: ANTHROPIC_CLIENT_ID, refresh_token: "old-refresh" });
      assert.deepEqual(next, {
        ...stored,
        access: "sk-ant-oat01-refreshed",
        refresh: "sk-ant-ort01-rotated",
        expires: 1_000_000 + 28_800_000 - 300_000,
      });
    } finally {
      await server.close();
    }
  });

  it("a failed exchange or refresh names the status and carries no token", async () => {
    const server = await tokenServer({ status: 400 });
    try {
      await assert.rejects(
        refreshAnthropic({ type: "oauth", access: SECRET_ACCESS, refresh: SECRET_REFRESH, expires: 0 }, depsFor(server)),
        (err: Error) => {
          assert.match(err.message, /anthropic token refresh failed: 400/);
          assert.ok(!err.message.includes("SECRET"), err.message);
          return true;
        },
      );
      let port = -1;
      const s = scriptedInteraction(() => undefined);
      const login = loginAnthropic(s.interaction, depsFor(server, { onListening: (p) => (port = p) }));
      const url = await waitFor(() => (s.events.some((e) => e.type === "auth_url") ? announcedAuthUrl(s.events) : undefined));
      await hitCallback(port, "/callback", { code: "SECRET-CODE", state: url.searchParams.get("state")! });
      await assert.rejects(login, (err: Error) => {
        assert.match(err.message, /anthropic token exchange failed: 400/);
        assert.ok(!err.message.includes("SECRET"), err.message);
        return true;
      });
    } finally {
      await server.close();
    }
  });

  it("a denial carrying the state fails the login; a callback with another state is ignored", async () => {
    const server = await tokenServer();
    try {
      let port = -1;
      const s = scriptedInteraction(() => undefined);
      const login = loginAnthropic(s.interaction, depsFor(server, { onListening: (p) => (port = p) }));
      login.catch(() => {});
      const url = await waitFor(() => (s.events.some((e) => e.type === "auth_url") ? announcedAuthUrl(s.events) : undefined));
      assert.equal(await hitCallback(port, "/callback", { code: "forged", state: "not-ours" }), 500);
      assert.equal(await hitCallback(port, "/callback", { error: "access_denied", state: url.searchParams.get("state")! }), 500);
      await assert.rejects(login, /Authorization failed: access_denied/);
      assert.equal(tokenCalls(server).length, 0);
    } finally {
      await server.close();
    }
  });
});
