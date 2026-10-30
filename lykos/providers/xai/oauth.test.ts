// xAI login and refresh against a local fake authorization server (P14 ticket 16,
// plan D3, D5.1). Responses are written, not recorded. No test reaches the network.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  type FakeAuthServer,
  type FakeRequest,
  jwt,
  scriptedInteraction,
  startFakeAuthServer,
  waitFor,
} from "../builtin-logins/fake-auth.js";
import {
  XAI_CLIENT_ID,
  XAI_EXPIRY_SKEW_MS,
  XAI_SCOPE,
  type XaiOAuthDeps,
  loginXai,
  refreshXai,
} from "./oauth.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-xai-oauth-")), "absent.db");

const SECRET_ACCESS = "sk-xai-SECRET-ACCESS-TOKEN-VALUE";
const SECRET_REFRESH = "sk-xai-SECRET-REFRESH-TOKEN-VALUE";

function xaiServer(opts: {
  pollPendingCount?: number;
  pollStatus?: number;
  refreshStatus?: number;
  error?: string;
} = {}): Promise<FakeAuthServer> {
  let pollCount = 0;
  return startFakeAuthServer((req) => {
    if (req.path === "/.well-known/openid-configuration" && req.method === "GET") {
      return {
        body: {
          token_endpoint: "http://127.0.0.1:0/oauth2/token", // replaced dynamically in deps or route
        },
      };
    }
    if (req.path === "/oauth2/device/code" && req.method === "POST") {
      return {
        body: {
          device_code: "xai-device-code-123",
          user_code: "XAI-USER-1",
          verification_uri: "https://auth.x.ai/device",
          verification_uri_complete: "https://auth.x.ai/device?code=XAI-USER-1",
          interval: 1,
          expires_in: 600,
        },
      };
    }
    if (req.path === "/oauth2/token" && req.method === "POST") {
      const params = new URLSearchParams(req.body);
      const grantType = params.get("grant_type");
      if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
        if (opts.pollStatus !== undefined) {
          return { status: opts.pollStatus, body: { error: opts.error ?? "server_error", leak: SECRET_ACCESS } };
        }
        if (opts.error) {
          return { status: 400, body: { error: opts.error } };
        }
        if (pollCount < (opts.pollPendingCount ?? 1)) {
          pollCount++;
          return { status: 400, body: { error: "authorization_pending" } };
        }
        const token = jwt({ sub: "xai-user-sub-1" });
        return {
          body: {
            access_token: token,
            refresh_token: SECRET_REFRESH,
            expires_in: 3600,
          },
        };
      }
      if (grantType === "refresh_token") {
        if (opts.refreshStatus !== undefined) {
          return { status: opts.refreshStatus, body: { error: "invalid_grant", leak: SECRET_REFRESH } };
        }
        const token = jwt({ sub: "xai-user-sub-1" });
        return {
          body: {
            access_token: token,
            refresh_token: "sk-xai-refreshed-rt",
            expires_in: 3600,
          },
        };
      }
    }
    if (req.path === "/oauth2/userinfo" && req.method === "GET") {
      return {
        body: {
          sub: "xai-user-sub-1",
          email: "Elon@Example.COM",
          name: "Test User",
        },
      };
    }
    return undefined;
  });
}

function depsFor(server: FakeAuthServer, extra: XaiOAuthDeps = {}): XaiOAuthDeps {
  return {
    sleep: async () => {},
    pollIntervalSeconds: 0.001,
    urls: {
      discoveryUrl: `${server.base}/.well-known/openid-configuration`,
      deviceCodeUrl: `${server.base}/oauth2/device/code`,
      tokenUrl: `${server.base}/oauth2/token`,
      userinfoUrl: `${server.base}/oauth2/userinfo`,
    },
    ...extra,
  };
}

describe("xAI login (ticket 16, D3)", () => {
  it("runs device code flow, discovers token endpoint and extracts userinfo", async () => {
    const server = await xaiServer({ pollPendingCount: 1 });
    try {
      const s = scriptedInteraction(() => undefined);
      const nowMs = 1_700_000_000_000;
      const login = loginXai(s.interaction, depsFor(server, { now: () => nowMs }));
      await waitFor(() => (s.events.some((e) => e.type === "device_code") ? true : undefined));

      const event = s.events.find((e) => e.type === "device_code")!;
      assert.equal(event.type, "device_code");
      if (event.type === "device_code") {
        assert.equal(event.userCode, "XAI-USER-1");
        assert.equal(event.verificationUri, "https://auth.x.ai/device?code=XAI-USER-1");
      }

      const credential = await login;
      assert.equal(credential.type, "oauth");
      assert.equal(credential.refresh, SECRET_REFRESH);
      assert.equal(credential.accountId, "xai-user-sub-1");
      assert.equal(credential.email, "elon@example.com", "userinfo email is normalized to lowercase");
      assert.equal(credential.expires, nowMs + 3600 * 1000 - XAI_EXPIRY_SKEW_MS);

      const deviceReq = server.requests.find((r) => r.path === "/oauth2/device/code")!;
      assert.ok(deviceReq);
      const deviceBody = new URLSearchParams(deviceReq.body);
      assert.equal(deviceBody.get("client_id"), XAI_CLIENT_ID);
      assert.equal(deviceBody.get("scope"), XAI_SCOPE);

      const tokenReqs = server.requests.filter((r) => r.path === "/oauth2/token");
      assert.equal(tokenReqs.length, 2, "1 pending poll + 1 successful poll");
      for (const req of tokenReqs) {
        const body = new URLSearchParams(req.body);
        assert.equal(body.get("client_id"), XAI_CLIENT_ID);
        assert.equal(body.get("device_code"), "xai-device-code-123");
        assert.equal(body.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
      }

      const userinfoReq = server.requests.find((r) => r.path === "/oauth2/userinfo")!;
      assert.ok(userinfoReq);
      assert.match(userinfoReq.headers.authorization ?? "", /^Bearer /);
    } finally {
      await server.close();
    }
  });

  it("refreshes token, queries userinfo, and keeps accountId and email", async () => {
    const server = await xaiServer();
    try {
      const nowMs = 1_700_000_000_000;
      const cred = {
        type: "oauth" as const,
        access: "old-access",
        refresh: SECRET_REFRESH,
        expires: 1000,
        accountId: "xai-user-sub-1",
        email: "elon@example.com",
      };
      const refreshed = await refreshXai(cred, depsFor(server, { now: () => nowMs }));
      assert.equal(refreshed.type, "oauth");
      assert.equal(refreshed.refresh, "sk-xai-refreshed-rt");
      assert.equal(refreshed.accountId, "xai-user-sub-1");
      assert.equal(refreshed.email, "elon@example.com");
      assert.equal(refreshed.expires, nowMs + 3600 * 1000 - XAI_EXPIRY_SKEW_MS);

      const req = server.requests.find((r) => r.path === "/oauth2/token")!;
      assert.ok(req);
      const body = new URLSearchParams(req.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), SECRET_REFRESH);
      assert.equal(body.get("client_id"), XAI_CLIENT_ID);
    } finally {
      await server.close();
    }
  });

  it("a failed poll or refresh names the status and carries no token", async () => {
    const pollServer = await xaiServer({ pollStatus: 500 });
    try {
      const s = scriptedInteraction(() => undefined);
      const login = loginXai(s.interaction, depsFor(pollServer));
      login.catch(() => {});
      await assert.rejects(login, (err: Error) => {
        assert.equal(err.name, "OAuthLoginError");
        assert.match(err.message, /500/);
        assert.ok(!err.message.includes(SECRET_ACCESS), "error must not leak access token");
        return true;
      });
    } finally {
      await pollServer.close();
    }

    const refreshServer = await xaiServer({ refreshStatus: 401 });
    try {
      const cred = {
        type: "oauth" as const,
        access: "old-access",
        refresh: SECRET_REFRESH,
        expires: 1000,
      };
      await assert.rejects(refreshXai(cred, depsFor(refreshServer)), (err: Error) => {
        assert.equal(err.name, "OAuthLoginError");
        assert.match(err.message, /401/);
        assert.ok(!err.message.includes(SECRET_REFRESH), "error must not leak refresh token");
        return true;
      });
    } finally {
      await refreshServer.close();
    }
  });

  it("handles access_denied and expired_token errors cleanly", async () => {
    const deniedServer = await xaiServer({ error: "access_denied" });
    try {
      const s = scriptedInteraction(() => undefined);
      const login = loginXai(s.interaction, depsFor(deniedServer));
      login.catch(() => {});
      await assert.rejects(login, /xAI device authorization was denied/);
    } finally {
      await deniedServer.close();
    }

    const expiredServer = await xaiServer({ error: "expired_token" });
    try {
      const s = scriptedInteraction(() => undefined);
      const login = loginXai(s.interaction, depsFor(expiredServer));
      login.catch(() => {});
      await assert.rejects(login, /xAI device code expired/);
    } finally {
      await expiredServer.close();
    }
  });
});
