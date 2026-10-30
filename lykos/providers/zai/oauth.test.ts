import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import {
  extractCodeFromInput,
  loginZai,
  NEVER_EXPIRES,
  ZAI_CLIENT_ID,
  ZAI_REDIRECT_URI,
} from "./oauth.js";

function jsonResponse(data: unknown, status = 200): string {
  return JSON.stringify(data);
}

describe("Z.ai OAuth flow (D2, D4.1, D4.2)", () => {
  it("extracts authorization code from redirect URL and bare input", () => {
    assert.equal(
      extractCodeFromInput("zcode://zai-auth/callback?code=abc123xyz&state=state1"),
      "abc123xyz",
    );
    assert.equal(
      extractCodeFromInput("zcode://zai-auth/callback?foo=bar&code=mycode#somestate"),
      "mycode",
    );
    assert.equal(extractCodeFromInput("code123#state456"), "code123");
    assert.equal(extractCodeFromInput("  bare-code-789  "), "bare-code-789");
  });

  it("exchanges code, performs business login, and mints id.secret key with pasted redirect URL", async () => {
    const requests: Array<{ method: string; url: string; body: any; auth?: string | undefined }> = [];

    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        const body = raw.length > 0 ? JSON.parse(raw) : undefined;
        const auth = req.headers.authorization;
        requests.push({ method: req.method ?? "GET", url: req.url ?? "", body, auth });

        if (req.url === "/oauth/token") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              code: 0,
              msg: "ok",
              data: {
                zai: { access_token: "short-lived-oauth-token-xyz" },
                user: { email: "user@example.com", id: "user_123" },
              },
            }),
          );
          return;
        }

        if (req.url === "/api/auth/z/login") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              code: 200,
              success: true,
              data: { access_token: "biz-token-456" },
            }),
          );
          return;
        }

        if (req.url === "/api/biz/customer/getCustomerInfo") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              code: 200,
              success: true,
              data: {
                organizations: [
                  {
                    organizationId: "org-1",
                    isDefault: true,
                    projects: [{ projectId: "proj-1", isDefault: true }],
                  },
                ],
              },
            }),
          );
          return;
        }

        if (req.url === "/api/biz/v1/organization/org-1/projects/proj-1/api_keys") {
          if (req.method === "GET") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(jsonResponse({ code: 200, success: true, data: [] }));
            return;
          }
          if (req.method === "POST") {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              jsonResponse({
                code: 200,
                success: true,
                data: { apiKey: "created-key-id", name: "lykos" },
              }),
            );
            return;
          }
        }

        if (req.url === "/api/biz/v1/organization/org-1/projects/proj-1/api_keys/copy/created-key-id") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              code: 200,
              success: true,
              data: { apiKey: "created-key-id", secretKey: "real-secret-key" },
            }),
          );
          return;
        }

        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      let authUrl = "";
      const credentials = await loginZai(
        {
          onAuth: (info) => {
            authUrl = info.url;
          },
          onManualCodeInput: async () => `${ZAI_REDIRECT_URI}?code=test-auth-code&state=s1`,
        },
        {
          urls: {
            authorizeUrl: `${base}/oauth/authorize`,
            tokenUrl: `${base}/oauth/token`,
            businessLoginUrl: `${base}/api/auth/z/login`,
            bizBase: base,
          },
        },
      );

      assert.equal(credentials.access, "created-key-id.real-secret-key");
      assert.equal(credentials.refresh, "");
      assert.equal(credentials.expires, NEVER_EXPIRES);
      assert.equal(credentials.email, "user@example.com");
      assert.equal(credentials.accountId, "user_123");

      const parsedAuth = new URL(authUrl);
      assert.equal(parsedAuth.searchParams.get("client_id"), ZAI_CLIENT_ID);
      assert.equal(parsedAuth.searchParams.get("redirect_uri"), ZAI_REDIRECT_URI);

      assert.equal(requests.length, 6);
      assert.equal(requests[0]!.url, "/oauth/token");
      assert.equal(requests[0]!.body.code, "test-auth-code");
      assert.equal(requests[1]!.url, "/api/auth/z/login");
      assert.equal(requests[1]!.body.token, "short-lived-oauth-token-xyz");
      assert.equal(requests[2]!.url, "/api/biz/customer/getCustomerInfo");
      assert.equal(requests[2]!.auth, "Bearer biz-token-456");
      assert.equal(requests[3]!.url, "/api/biz/v1/organization/org-1/projects/proj-1/api_keys");
      assert.equal(requests[3]!.method, "GET");
      assert.equal(requests[4]!.url, "/api/biz/v1/organization/org-1/projects/proj-1/api_keys");
      assert.equal(requests[4]!.method, "POST");
      assert.equal(requests[4]!.body.name, "lykos");
      assert.equal(requests[5]!.url, "/api/biz/v1/organization/org-1/projects/proj-1/api_keys/copy/created-key-id");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("reuses existing key and works with bare code input", async () => {
    const requests: Array<{ method: string; url: string }> = [];

    const server: Server = createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        requests.push({ method: req.method ?? "GET", url: req.url ?? "" });

        if (req.url === "/oauth/token") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              code: 0,
              data: {
                zai: { access_token: "token-abc" },
              },
            }),
          );
          return;
        }

        if (req.url === "/api/auth/z/login") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(jsonResponse({ code: 200, data: { access_token: "biz-token" } }));
          return;
        }

        if (req.url === "/api/biz/customer/getCustomerInfo") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              code: 200,
              data: {
                organizations: [
                  {
                    organizationId: "org-default",
                    isDefault: true,
                    projects: [{ projectId: "proj-default", isDefault: true }],
                  },
                ],
              },
            }),
          );
          return;
        }

        if (req.url === "/api/biz/v1/organization/org-default/projects/proj-default/api_keys") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              code: 200,
              data: [
                { name: "other-key", apiKey: "other-key-id" },
                { name: "lykos", apiKey: "existing-lykos-key" },
              ],
            }),
          );
          return;
        }

        if (req.url === "/api/biz/v1/organization/org-default/projects/proj-default/api_keys/copy/existing-lykos-key") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            jsonResponse({
              code: 200,
              data: { apiKey: "existing-lykos-key", secretKey: "copied-secret-key" },
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
      const credentials = await loginZai(
        {
          onPrompt: async () => "bare-code-12345",
        },
        {
          urls: {
            authorizeUrl: `${base}/oauth/authorize`,
            tokenUrl: `${base}/oauth/token`,
            businessLoginUrl: `${base}/api/auth/z/login`,
            bizBase: base,
          },
        },
      );

      assert.equal(credentials.access, "existing-lykos-key.copied-secret-key");
      // Assert no POST to api_keys was made (it reused existing key)
      assert.ok(!requests.some((r) => r.method === "POST" && r.url.endsWith("/api_keys")));
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("reports error without leaking tokens when token exchange fails", async () => {
    const server: Server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          jsonResponse({
            code: 400,
            msg: "invalid_grant: secret_token_value_abc123def456ghi789jkl012mno345pqr",
          }),
        );
      });
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      await assert.rejects(
        async () => {
          await loginZai(
            {
              onManualCodeInput: async () => "bad-code",
            },
            {
              urls: {
                tokenUrl: `${base}/oauth/token`,
              },
            },
          );
        },
        (err: Error) => {
          assert.ok(!err.message.includes("secret_token_value_abc123def456ghi789jkl012mno345pqr"));
          assert.ok(err.message.includes("[redacted]"));
          return true;
        },
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
