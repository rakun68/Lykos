// Cursor login and refresh against a local fake authorization server.
//
// The endpoints' shapes (`GET auth/poll?uuid&verifier` answering 404 until the
// browser step is done, then `{ accessToken, refreshToken }`; `POST
// auth/exchange_user_api_key` with a bearer and `{}`) are written, not recorded
// against a live account. No test reaches the network.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openCredentialDb } from "../../credentials/db.js";
import { type LoginSurface, runLoginFlow, sanctionWarning } from "../../credentials/login-flow.js";
import { listEnabledWithData } from "../../credentials/pool.js";
import { createLykosModelRuntime } from "../../session/model-runtime.js";
import { loginProviders } from "../logins.js";
import { getTokenExpiry, loginCursor, POLL_BACKOFF_MULTIPLIER, POLL_BASE_DELAY, refreshCursor } from "./oauth.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-cursor-oauth-")), "absent.db");

/** A JWT-shaped token whose payload carries `exp` (seconds) and `sub`. Unsigned: only the payload is read. */
function jwt(exp: number, sub = "auth0|user_123"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp, sub })}.signature`;
}

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => void;

async function startServer(route: Route): Promise<{ base: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => route(req, body, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

describe("Cursor login (D2, D6.2)", () => {
  it("polls through 404s with backoff, then returns the tokens with the JWT expiry", async () => {
    const exp = 1_900_000_000;
    const access = jwt(exp);
    const polls: URL[] = [];
    const server = await startServer((req, _body, res) => {
      const url = new URL(req.url!, "http://x");
      if (req.method === "GET" && url.pathname === "/auth/poll") {
        polls.push(url);
        if (polls.length < 3) return json(res, 404, {});
        return json(res, 200, { accessToken: access, refreshToken: "cursor-refresh" });
      }
      res.writeHead(500).end();
    });
    try {
      const opened: string[] = [];
      const authUrls: string[] = [];
      const delays: number[] = [];
      const credentials = await loginCursor(
        { onAuth: (info) => authUrls.push(info.url) },
        {
          urls: { loginUrl: "https://cursor.example/loginDeepControl", pollUrl: `${server.base}/auth/poll` },
          sleep: async (ms) => {
            delays.push(ms);
          },
          openBrowser: (url) => opened.push(url),
        },
      );

      assert.equal(credentials.access, access);
      assert.equal(credentials.refresh, "cursor-refresh");
      assert.equal(credentials.expires, exp * 1000 - 5 * 60 * 1000);

      assert.deepEqual(opened, authUrls);
      const login = new URL(opened[0]!);
      assert.equal(login.origin + login.pathname, "https://cursor.example/loginDeepControl");
      assert.equal(login.searchParams.get("mode"), "login");
      assert.equal(login.searchParams.get("redirectTarget"), "cli");
      const uuid = login.searchParams.get("uuid")!;
      const challenge = login.searchParams.get("challenge")!;

      assert.equal(polls.length, 3);
      for (const poll of polls) assert.equal(poll.searchParams.get("uuid"), uuid);
      const verifier = polls[0]!.searchParams.get("verifier")!;
      assert.equal(createHash("sha256").update(verifier).digest("base64url"), challenge, "PKCE S256 pair");

      assert.deepEqual(delays, [POLL_BASE_DELAY, POLL_BASE_DELAY * POLL_BACKOFF_MULTIPLIER, POLL_BASE_DELAY * POLL_BACKOFF_MULTIPLIER ** 2]);
    } finally {
      await server.close();
    }
  });

  it("stops after three consecutive poll failures without quoting the verifier", async () => {
    let verifier = "";
    const server = await startServer((req, _body, res) => {
      verifier = new URL(req.url!, "http://x").searchParams.get("verifier") ?? "";
      json(res, 500, { error: "boom" });
    });
    try {
      await assert.rejects(
        loginCursor({}, { urls: { pollUrl: `${server.base}/auth/poll` }, sleep: async () => {} }),
        (err: Error) => {
          assert.equal(err.message, "Too many consecutive errors during Cursor auth polling");
          assert.ok(verifier.length > 0 && !err.message.includes(verifier));
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });

  it("refreshes through exchange_user_api_key, keeping the old refresh token when none comes back", async () => {
    const exp = 1_950_000_000;
    let seen: { auth?: string | undefined; body: string; method?: string | undefined } | undefined;
    const server = await startServer((req, body, res) => {
      seen = { auth: req.headers.authorization, body, method: req.method };
      if (req.url === "/auth/exchange_user_api_key") return json(res, 200, { accessToken: jwt(exp) });
      res.writeHead(404).end();
    });
    try {
      const refreshed = await refreshCursor({ refresh: "old-refresh" }, { urls: { refreshUrl: `${server.base}/auth/exchange_user_api_key` } });
      assert.equal(refreshed.access, jwt(exp));
      assert.equal(refreshed.refresh, "old-refresh");
      assert.equal(refreshed.expires, exp * 1000 - 300_000);
      assert.deepEqual(seen, { auth: "Bearer old-refresh", body: "{}", method: "POST" });
    } finally {
      await server.close();
    }
  });

  it("a failed refresh names the status and carries no token", async () => {
    const server = await startServer((_req, _body, res) => json(res, 401, { error: "invalid token secret-refresh-value" }));
    try {
      await assert.rejects(
        refreshCursor({ refresh: "secret-refresh-value" }, { urls: { refreshUrl: `${server.base}/r` } }),
        (err: Error) => {
          assert.equal(err.message, "Cursor token refresh failed: 401");
          assert.doesNotMatch(err.message, /secret-refresh-value/);
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });

  it("falls back to one hour when the token is not a JWT", () => {
    assert.equal(getTokenExpiry("opaque", () => 1000), 1000 + 3_600_000);
  });

  it("`lykos login cursor` on an empty pool warns, then stores the credential in the Lykos db (D6.5)", async () => {
    const access = jwt(1_900_000_000);
    let polls = 0;
    const server = await startServer((req, _body, res) => {
      if (new URL(req.url!, "http://x").pathname !== "/auth/poll") return res.writeHead(404).end();
      polls += 1;
      if (polls < 2) return json(res, 404, {});
      json(res, 200, { accessToken: access, refreshToken: "cursor-refresh" });
    });
    const dir = mkdtempSync(join(tmpdir(), "lykos-cursor-login-"));
    const dbPath = join(dir, "credentials.db");
    try {
      const err: string[] = [];
      const opened: string[] = [];
      const surface: LoginSurface = {
        dbPath,
        out: () => {},
        err: (line) => err.push(line),
        ask: async () => undefined,
        openBrowser: (url) => opened.push(url),
        createRuntime: (opts) =>
          createLykosModelRuntime({
            ...opts,
            providers: loginProviders({
              cursor: { urls: { loginUrl: `${server.base}/login`, pollUrl: `${server.base}/auth/poll` }, sleep: async () => {} },
            }),
          }),
      };

      assert.equal(await runLoginFlow("cursor", false, surface), 0, err.join("\n"));
      assert.ok(err.includes(sanctionWarning("cursor")), "the first login shows the sanction warning");
      assert.equal(opened.length, 1);
      assert.match(opened[0]!, /\/login\?challenge=/);

      const db = openCredentialDb(dbPath, { create: false })!;
      try {
        const rows = listEnabledWithData(db, "cursor");
        assert.equal(rows.length, 1);
        const data = JSON.parse(rows[0]!.data) as { access: string; refresh: string };
        assert.equal(data.access, access);
        assert.equal(data.refresh, "cursor-refresh");
      } finally {
        db.close();
      }

      // A second login finds a non-empty pool: no warning.
      err.length = 0;
      polls = 0;
      assert.equal(await runLoginFlow("cursor", false, surface), 0);
      assert.ok(!err.includes(sanctionWarning("cursor")));
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
