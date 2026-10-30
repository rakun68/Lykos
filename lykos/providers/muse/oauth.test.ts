import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
  encodeMuseCodeCredential,
  loginMuse,
  NEVER_EXPIRES,
  parseMuseCodeCredential,
} from "./oauth.js";

function jsonResponse(data: unknown, status = 200): string {
  return JSON.stringify(data);
}

describe("Muse Code OAuth flow (D2, D4.1, D4.3)", () => {
  it("parses and encodes muse credential correctly", () => {
    const raw = encodeMuseCodeCredential("token123", "key456");
    const parsed = parseMuseCodeCredential(raw);
    assert.equal(parsed.oauthAccessToken, "token123");
    assert.equal(parsed.apiKey, "key456");

    assert.throws(() => parseMuseCodeCredential("not-json"), /invalid/);
    assert.throws(() => parseMuseCodeCredential(JSON.stringify({ apiKey: "only" })), /invalid/);
  });

  it("shows device code via onDeviceCode, polls pending, and mints Model API key", async () => {
    let pollCount = 0;
    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        if (req.url === "/oidc/device/authorization/") {
          assert.equal(req.headers["x-api-version"], "1.0.0");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              user_code: "MUSE-CODE",
              device_code: "dev-code-xyz",
              verification_uri: "https://auth.meta.com/device",
              interval: 5,
              expires_in: 300,
            }),
          );
          return;
        }

        if (req.url === "/oidc/device/token/") {
          assert.equal(req.headers["x-api-version"], "1.0.0");
          pollCount++;
          if (pollCount === 1) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(jsonResponse({ error: "authorization_pending" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(jsonResponse({ access_token: "meta-access-token-999" }));
          return;
        }

        if (req.url === "/muse-code/key") {
          assert.equal(req.headers.authorization, "Bearer meta-access-token-999");
          assert.equal(req.headers["x-api-version"], "1.0.0");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              api_key: "minted-model-key-777",
              user_email: "User@Meta.com",
              user_id: "meta_user_42",
              is_subs_active: true,
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
      let deviceCodeInfo: any;
      let authInfo: any;

      const credentials = await loginMuse(
        {
          onDeviceCode: (info) => {
            deviceCodeInfo = info;
          },
          onAuth: (info) => {
            authInfo = info;
          },
        },
        {
          urls: {
            deviceAuthUrl: `${base}/oidc/device/authorization/`,
            tokenUrl: `${base}/oidc/device/token/`,
            keyUrl: `${base}/muse-code/key`,
          },
          pollIntervalMs: 10,
        },
      );

      assert.deepEqual(deviceCodeInfo, {
        userCode: "MUSE-CODE",
        verificationUri: "https://auth.meta.com/device",
      });
      assert.deepEqual(authInfo, {
        url: "https://auth.meta.com/device",
        instructions: "Enter code: MUSE-CODE",
      });

      const parsed = parseMuseCodeCredential(credentials.access);
      assert.equal(parsed.oauthAccessToken, "meta-access-token-999");
      assert.equal(parsed.apiKey, "minted-model-key-777");
      assert.equal(credentials.refresh, "");
      assert.equal(credentials.expires, NEVER_EXPIRES);
      assert.equal(credentials.email, "user@meta.com");
      assert.equal(credentials.accountId, "meta_user_42");
      assert.equal(pollCount, 2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("handles inactive subscription error without leaking tokens", async () => {
    const server: Server = createServer((req, res) => {
      if (req.url === "/oidc/device/authorization/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          jsonResponse({
            user_code: "CODE",
            device_code: "dev",
            verification_uri: "https://auth.meta.com/device",
            expires_in: 300,
          }),
        );
        return;
      }
      if (req.url === "/oidc/device/token/") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(jsonResponse({ access_token: "secret-token-12345678901234567890123456789012" }));
        return;
      }
      if (req.url === "/muse-code/key") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(jsonResponse({ is_subs_active: false }));
        return;
      }
      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      await assert.rejects(
        async () => {
          await loginMuse(
            {},
            {
              urls: {
                deviceAuthUrl: `${base}/oidc/device/authorization/`,
                tokenUrl: `${base}/oidc/device/token/`,
                keyUrl: `${base}/muse-code/key`,
              },
              pollIntervalMs: 10,
            },
          );
        },
        (err: Error) => {
          assert.ok(err.message.includes("subscription is inactive"));
          assert.ok(!err.message.includes("secret-token-12345678901234567890123456789012"));
          return true;
        },
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
