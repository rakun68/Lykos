import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { loginKilo, ONE_YEAR_MS } from "./oauth.js";

function jsonResponse(data: unknown): string {
  return JSON.stringify(data);
}

describe("Kilo OAuth flow (D2, D4.1, D4.3)", () => {
  it("shows device code via onDeviceCode, polls pending (202), and completes on approval", async () => {
    let pollCount = 0;
    const server: Server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/codes") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          jsonResponse({
            code: "KILO-USER-CODE",
            verificationUrl: "https://kilo.ai/device",
            expiresIn: 300,
          }),
        );
        return;
      }

      if (req.method === "GET" && req.url === "/codes/KILO-USER-CODE") {
        pollCount++;
        if (pollCount === 1) {
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(jsonResponse({ status: "pending" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          jsonResponse({
            status: "approved",
            token: "kilo-access-token-12345",
          }),
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      let deviceCodeCalledWith: any;
      let authCalledWith: any;
      const progress: string[] = [];

      const credentials = await loginKilo(
        {
          onDeviceCode: (info) => {
            deviceCodeCalledWith = info;
          },
          onAuth: (info) => {
            authCalledWith = info;
          },
          onProgress: (msg) => {
            progress.push(msg);
          },
        },
        {
          deviceAuthBaseUrl: base,
          pollIntervalMs: 10,
        },
      );

      assert.deepEqual(deviceCodeCalledWith, {
        userCode: "KILO-USER-CODE",
        verificationUri: "https://kilo.ai/device",
      });
      assert.deepEqual(authCalledWith, {
        url: "https://kilo.ai/device",
        instructions: "Enter code: KILO-USER-CODE",
      });
      assert.equal(credentials.access, "kilo-access-token-12345");
      assert.equal(credentials.refresh, "");
      assert.ok(credentials.expires > Date.now());
      assert.ok(credentials.expires <= Date.now() + ONE_YEAR_MS + 1000);
      assert.equal(pollCount, 2);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("surfaces rate-limit errors from device authorization start", async () => {
    const server: Server = createServer((req, res) => {
      res.writeHead(429, { "Content-Type": "text/plain" });
      res.end("Too Many Requests");
    });

    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      await assert.rejects(
        async () => {
          await loginKilo({}, { deviceAuthBaseUrl: base, pollIntervalMs: 10 });
        },
        (err: Error) => {
          assert.equal(err.message, "Too many pending authorization requests. Please try again later.");
          return true;
        },
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("surfaces denied device authorization state without leaking token", async () => {
    const server: Server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/codes") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          jsonResponse({
            code: "DENY-CODE",
            verificationUrl: "https://kilo.ai/device",
            expiresIn: 300,
          }),
        );
        return;
      }
      if (req.url === "/codes/DENY-CODE") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(jsonResponse({ error: "denied", secret_token: "secret_token_12345678901234567890123456789012" }));
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
          await loginKilo({}, { deviceAuthBaseUrl: base, pollIntervalMs: 10 });
        },
        (err: Error) => {
          assert.ok(err.message.includes("Authorization was denied"));
          assert.ok(!err.message.includes("secret_token_12345678901234567890123456789012"));
          return true;
        },
      );
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
