// Kimi Code login and refresh against a local fake authorization server (P14 ticket 16,
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
  KIMI_CLIENT_ID,
  type KimiOAuthDeps,
  loginKimi,
  refreshKimi,
} from "./oauth.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-kimi-oauth-")), "absent.db");

const SECRET_ACCESS = "sk-kimi-SECRET-ACCESS-TOKEN-VALUE";
const SECRET_REFRESH = "sk-kimi-SECRET-REFRESH-TOKEN-VALUE";

function kimiServer(opts: {
  pollPendingCount?: number;
  pollStatus?: number;
  refreshStatus?: number;
  error?: string;
} = {}): Promise<FakeAuthServer> {
  let pollCount = 0;
  return startFakeAuthServer((req) => {
    if (req.path === "/api/oauth/device_authorization" && req.method === "POST") {
      return {
        body: {
          device_code: "kimi-device-code-123",
          user_code: "ABCD-EFGH",
          verification_uri: "https://auth.kimi.com/device",
          verification_uri_complete: "https://auth.kimi.com/device?code=ABCD-EFGH",
          interval: 1,
          expires_in: 300,
        },
      };
    }
    if (req.path === "/api/oauth/token" && req.method === "POST") {
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
        const token = jwt({ user_id: "kimi-user-uuid", sub: "kimi-sub" });
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
        const token = jwt({ user_id: "kimi-user-uuid", sub: "kimi-sub" });
        return {
          body: {
            access_token: token,
            refresh_token: "sk-kimi-refreshed-rt",
            expires_in: 7200,
          },
        };
      }
    }
    return undefined;
  });
}

function depsFor(server: FakeAuthServer, extra: KimiOAuthDeps = {}): KimiOAuthDeps {
  return {
    sleep: async () => {},
    pollIntervalSeconds: 0.001,
    urls: {
      base: server.base,
      deviceUrl: `${server.base}/api/oauth/device_authorization`,
      tokenUrl: `${server.base}/api/oauth/token`,
    },
    ...extra,
  };
}

describe("Kimi Code login (ticket 16, D3)", () => {
  it("runs device code flow without fingerprint headers and parses JWT accountId", async () => {
    const server = await kimiServer({ pollPendingCount: 1 });
    try {
      const s = scriptedInteraction(() => undefined);
      const login = loginKimi(s.interaction, depsFor(server));
      await waitFor(() => (s.events.some((e) => e.type === "device_code") ? true : undefined));

      const event = s.events.find((e) => e.type === "device_code")!;
      assert.equal(event.type, "device_code");
      if (event.type === "device_code") {
        assert.equal(event.userCode, "ABCD-EFGH");
        assert.equal(event.verificationUri, "https://auth.kimi.com/device?code=ABCD-EFGH");
      }

      const credential = await login;
      assert.equal(credential.type, "oauth");
      assert.equal(credential.refresh, SECRET_REFRESH);
      assert.equal(credential.accountId, "kimi-user-uuid");
      assert.ok(credential.expires > Date.now());

      const deviceReq = server.requests.find((r) => r.path === "/api/oauth/device_authorization")!;
      assert.ok(deviceReq);
      // Plan D3: like Pi's flow, no machine identifier is sent (no X-Msh-* fingerprint).
      assert.deepEqual(Object.keys(deviceReq.headers).filter((h) => h.startsWith("x-msh-")), []);
      assert.ok(!deviceReq.headers["user-agent"]?.includes("KimiCLI"));
      assert.equal(new URLSearchParams(deviceReq.body).get("client_id"), KIMI_CLIENT_ID);

      const tokenReqs = server.requests.filter((r) => r.path === "/api/oauth/token");
      assert.equal(tokenReqs.length, 2, "1 pending poll + 1 successful poll");
      for (const req of tokenReqs) {
        assert.equal(req.headers["x-msh-platform"], undefined);
        assert.equal(new URLSearchParams(req.body).get("client_id"), KIMI_CLIENT_ID);
        assert.equal(new URLSearchParams(req.body).get("device_code"), "kimi-device-code-123");
      }
    } finally {
      await server.close();
    }
  });

  it("refreshes token without fingerprint headers and preserves stored accountId", async () => {
    const server = await kimiServer();
    try {
      const cred = {
        type: "oauth" as const,
        access: "old-access",
        refresh: SECRET_REFRESH,
        expires: 1000,
        accountId: "kimi-user-uuid",
      };
      const refreshed = await refreshKimi(cred, depsFor(server));
      assert.equal(refreshed.type, "oauth");
      assert.equal(refreshed.refresh, "sk-kimi-refreshed-rt");
      assert.equal(refreshed.accountId, "kimi-user-uuid");
      assert.ok(refreshed.expires > Date.now());

      const req = server.requests.find((r) => r.path === "/api/oauth/token")!;
      assert.ok(req);
      assert.equal(req.headers["x-msh-platform"], undefined);
      const body = new URLSearchParams(req.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), SECRET_REFRESH);
      assert.equal(body.get("client_id"), KIMI_CLIENT_ID);
    } finally {
      await server.close();
    }
  });

  it("a failed poll or refresh names the status and carries no token", async () => {
    const pollServer = await kimiServer({ pollStatus: 500 });
    try {
      const s = scriptedInteraction(() => undefined);
      const login = loginKimi(s.interaction, depsFor(pollServer));
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

    const refreshServer = await kimiServer({ refreshStatus: 401 });
    try {
      const cred = {
        type: "oauth" as const,
        access: "old-access",
        refresh: SECRET_REFRESH,
        expires: 1000,
      };
      await assert.rejects(refreshKimi(cred, depsFor(refreshServer)), (err: Error) => {
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
    const deniedServer = await kimiServer({ error: "access_denied" });
    try {
      const s = scriptedInteraction(() => undefined);
      const login = loginKimi(s.interaction, depsFor(deniedServer));
      login.catch(() => {});
      await assert.rejects(login, /Kimi Code login was denied/);
    } finally {
      await deniedServer.close();
    }

    const expiredServer = await kimiServer({ error: "expired_token" });
    try {
      const s = scriptedInteraction(() => undefined);
      const login = loginKimi(s.interaction, depsFor(expiredServer));
      login.catch(() => {});
      await assert.rejects(login, /Kimi Code device authorization expired/);
    } finally {
      await expiredServer.close();
    }
  });
});
