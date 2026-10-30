import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCredentialDb } from "../../credentials/db.js";
import { upsertCredential } from "../../credentials/pool.js";
import { startFakeAnthropicServer } from "../../credentials/fake-anthropic-server.js";
import { createLykosModelRuntime } from "../../session/model-runtime.js";
import { googleCcaProviders } from "../google-cca/register.js";
import { loginProviders } from "../logins.js";
import {
  clearGitLabDuoDirectAccessCache,
  GITLAB_CLIENT_ID,
  loginGitLabDuo,
  refreshGitLabDuo,
} from "./oauth.js";

// Nothing here may read the real home: the pi-host and the credential db point at tmp.
process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-gitlab-duo-")), "absent.db");

/** Whether this host can bind `host` (IPv6 loopback is missing on some CI and container hosts). */
async function canListen(host: string): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(0, host, () => probe.close(() => resolve(true)));
  });
}

function jsonResponse(data: unknown): string {
  return JSON.stringify(data);
}

describe("GitLab Duo OAuth flow and stream (D2, D4.1, D4.4)", () => {
  it("performs PKCE authorization code exchange and sets up credential", async () => {
    let tokenRequest: { body: any; headers: any } | undefined;

    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/oauth/token") {
          const params = Object.fromEntries(new URLSearchParams(raw));
          tokenRequest = { body: params, headers: req.headers };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              access_token: "gl-access-token-12345",
              refresh_token: "gl-refresh-token-67890",
              expires_in: 7200,
              created_at: 1700000000,
            }),
          );
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      let authInfo: any;
      const progress: string[] = [];

      // Start the flow with callbackPort: 0 so it uses an ephemeral loopback port
      const loginPromise = loginGitLabDuo(
        {
          onAuth: (info) => {
            authInfo = info;
            // Simulate browser redirect to callback server
            const parsed = new URL(info.url);
            const redirectUri = parsed.searchParams.get("redirect_uri")!;
            const state = parsed.searchParams.get("state")!;
            fetch(`${redirectUri}?code=gitlab-code-123&state=${state}`).catch(() => {});
          },
          onProgress: (msg) => {
            progress.push(msg);
          },
        },
        {
          callbackPort: 0,
          urls: {
            authorizeUrl: `${base}/oauth/authorize`,
            tokenUrl: `${base}/oauth/token`,
          },
        },
      );

      const credentials = await loginPromise;

      assert.equal(credentials.access, "gl-access-token-12345");
      assert.equal(credentials.refresh, "gl-refresh-token-67890");
      assert.equal(credentials.expires, (1700000000 + 7200) * 1000 - 300_000);

      assert.ok(tokenRequest);
      assert.equal(tokenRequest.body.grant_type, "authorization_code");
      assert.equal(tokenRequest.body.code, "gitlab-code-123");
      assert.equal(tokenRequest.body.client_id, GITLAB_CLIENT_ID);
      assert.ok(tokenRequest.body.code_verifier);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  // A browser opens the redirect URI's `localhost`, which may resolve to either loopback family. The
  // callback must answer on both, while the redirect URI keeps GitLab's registered `localhost`.
  for (const family of ["127.0.0.1", "::1"] as const) {
    it(`the callback answers over ${family} while the redirect URI keeps the registered localhost host`, async (t) => {
      if (family === "::1" && !(await canListen("::1"))) {
        t.skip("this host has no IPv6 loopback");
        return;
      }
      const server: Server = createServer((req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(jsonResponse({ access_token: "a", refresh_token: "r", expires_in: 7200, created_at: 1700000000 }));
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const literal = family === "::1" ? "[::1]" : family;
      try {
        let redirectHost = "";
        await loginGitLabDuo(
          {
            onAuth: (info) => {
              const parsed = new URL(info.url);
              const redirect = new URL(parsed.searchParams.get("redirect_uri")!);
              redirectHost = redirect.hostname;
              const state = parsed.searchParams.get("state")!;
              fetch(`http://${literal}:${redirect.port}${redirect.pathname}?code=c&state=${state}`).catch(() => {});
            },
            onProgress: () => {},
          },
          {
            callbackPort: 0,
            callbackTimeoutMs: 5_000,
            urls: { authorizeUrl: `${base}/oauth/authorize`, tokenUrl: `${base}/oauth/token` },
          },
        );
        assert.equal(redirectHost, "localhost");
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  }

  it("refresh works and updates tokens while clearing direct access cache", async () => {
    let refreshBody: any;
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/oauth/token") {
          refreshBody = Object.fromEntries(new URLSearchParams(raw));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              access_token: "refreshed-gl-access-token",
              refresh_token: "refreshed-gl-refresh-token",
              expires_in: 3600,
              created_at: 1700005000,
            }),
          );
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const refreshed = await refreshGitLabDuo(
        {
          access: "old-access",
          refresh: "old-refresh-token",
          expires: 1000,
        },
        {
          urls: {
            tokenUrl: `${base}/oauth/token`,
          },
        },
      );

      assert.equal(refreshed.access, "refreshed-gl-access-token");
      assert.equal(refreshed.refresh, "refreshed-gl-refresh-token");
      assert.equal(refreshed.expires, (1700005000 + 3600) * 1000 - 300_000);
      assert.equal(refreshBody.grant_type, "refresh_token");
      assert.equal(refreshBody.refresh_token, "old-refresh-token");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("stream call through createLykosModelRuntime exchanges direct-access token and caches for 25 min", async () => {
    clearGitLabDuoDirectAccessCache();

    // 1. Fake Anthropic server
    const anthropicServer = await startFakeAnthropicServer();
    anthropicServer.script.set("gateway-direct-token-xyz", [
      { kind: "ok", text: "Turn 1 answer from Anthropic wire" },
      { kind: "ok", text: "Turn 2 answer from Anthropic wire" },
    ]);

    // 2. Fake GitLab Direct Access server
    let directAccessCount = 0;
    const gitlabServer: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.method === "POST" && req.url === "/api/v4/ai/third_party_agents/direct_access") {
          directAccessCount++;
          assert.equal(req.headers.authorization, "Bearer my-gitlab-token");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              token: "gateway-direct-token-xyz",
              headers: { "x-gitlab-gateway-header": "test-header-val" },
            }),
          );
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((r) => gitlabServer.listen(0, "127.0.0.1", r));
    const gitlabPort = (gitlabServer.address() as AddressInfo).port;
    const gitlabBaseUrl = `http://127.0.0.1:${gitlabPort}`;

    try {
      // 3. Create Lykos Model Runtime
      // The GitLab token reaches the stream the way it does in a session: an
      // OAuth row in the pool, resolved by Pi through the Lykos store.
      const credentialDbPath = join(mkdtempSync(join(tmpdir(), "lykos-gitlab-duo-pool-")), "credentials.db");
      const db = openCredentialDb(credentialDbPath, { create: true })!;
      try {
        upsertCredential(db, "gitlab-duo", {
          type: "oauth",
          access: "my-gitlab-token",
          refresh: "my-gitlab-refresh",
          expires: Date.now() + 3_600_000,
        });
      } finally {
        db.close();
      }

      const runtime = await createLykosModelRuntime({
        credentialDbPath,
        providers: {
          ...googleCcaProviders(),
          ...loginProviders({
            runtime: () => runtime,
            gitlabDuo: {
              baseUrl: anthropicServer.baseUrl,
              directAccessUrl: `${gitlabBaseUrl}/api/v4/ai/third_party_agents/direct_access`,
            },
          }),
        },
      });

      const model = runtime.getModel("gitlab-duo", "duo-chat-haiku-4-5");
      assert.ok(model, "expected duo-chat-haiku-4-5 model");

      // Turn 1
      const stream1 = await runtime.streamSimple(
        model,
        { messages: [{ role: "user", content: "Turn 1 prompt", timestamp: Date.now() }] },
        { sessionId: "gitlab-duo-test" },
      );

      let text1 = "";
      for await (const event of stream1) {
        if (event.type === "text_delta") text1 += event.delta;
      }

      assert.equal(text1, "Turn 1 answer from Anthropic wire");
      assert.equal(directAccessCount, 1, "direct access endpoint called once");
      assert.deepEqual(anthropicServer.seen, ["gateway-direct-token-xyz"]);

      // Turn 2 (within 25 min)
      const stream2 = await runtime.streamSimple(
        model,
        { messages: [{ role: "user", content: "Turn 2 prompt", timestamp: Date.now() }] },
        { sessionId: "gitlab-duo-test" },
      );

      let text2 = "";
      for await (const event of stream2) {
        if (event.type === "text_delta") text2 += event.delta;
      }

      assert.equal(text2, "Turn 2 answer from Anthropic wire");
      assert.equal(directAccessCount, 1, "reused cached direct access token, no second exchange");
      assert.deepEqual(anthropicServer.seen, ["gateway-direct-token-xyz", "gateway-direct-token-xyz"]);
    } finally {
      await anthropicServer.close();
      await new Promise<void>((r) => gitlabServer.close(() => r()));
      clearGitLabDuoDirectAccessCache();
    }
  });
});
