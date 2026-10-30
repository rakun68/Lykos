// Devin login against a local fake authorization server.
//
// The token endpoint's shape (a JSON POST of `code` and `code_verifier` with
// `Accept: application/json`, answered `{ token }`) is not recorded against a live account by Lykos. The "browser" here is the test
// requesting the loopback redirect URI itself. No test reaches the network; the callback
// port is injected (0), never the real 59653.

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
import {
  DEVIN_API_ENDPOINT,
  DEVIN_ENTERPRISE_URL,
  DEVIN_EXPIRY_FALLBACK_MS,
  DEVIN_INSTRUCTIONS,
  devinTokenExpiry,
  loginDevin,
  refreshDevin,
} from "./oauth.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-devin-oauth-")), "absent.db");

/** A JWT-shaped token whose payload carries `exp` (seconds). Unsigned: only the payload is read. */
function jwt(exp: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp, sub: "devin-user" })}.signature`;
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
  return {
    base,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

interface TokenCall {
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

/** The fake `auth/cli/token`: records each call and answers `{ token }` (or `status` with `body`). */
async function startTokenServer(answer: { token?: string; status?: number; body?: string }) {
  const calls: TokenCall[] = [];
  const server = await startServer((req, body, res) => {
    if (req.method !== "POST" || new URL(req.url!, "http://x").pathname !== "/auth/cli/token") {
      res.writeHead(404).end();
      return;
    }
    calls.push({ headers: req.headers, body: JSON.parse(body) as Record<string, unknown> });
    if (answer.status !== undefined) {
      res.writeHead(answer.status, { "Content-Type": "application/json" }).end(answer.body ?? "{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ token: answer.token }));
  });
  return { ...server, calls };
}

/** Plays the browser: follows the authorize URL's redirect_uri back with a code and a state. */
function browser(results: { status?: number }[], code = "callback-code", state?: (real: string) => string) {
  return (url: string): void => {
    const authorize = new URL(url);
    const redirect = new URL(authorize.searchParams.get("redirect_uri")!);
    redirect.searchParams.set("code", code);
    const real = authorize.searchParams.get("state")!;
    redirect.searchParams.set("state", state ? state(real) : real);
    void fetch(redirect).then(
      async (r) => {
        await r.text();
        results.push({ status: r.status });
      },
      () => results.push({}),
    );
  };
}

describe("Devin login (D1, D6.1)", () => {
  it("runs PKCE with a uuid state through the loopback callback, exchanges JSON, and takes the JWT expiry", async () => {
    const exp = 1_900_000_000;
    const token = jwt(exp);
    const tokens = await startTokenServer({ token });
    try {
      const authUrls: { url: string; instructions?: string }[] = [];
      const callbackResults: { status?: number }[] = [];
      const credentials = await loginDevin(
        { onAuth: (info) => authUrls.push(info) },
        {
          callbackPort: 0,
          urls: { authorizeUrl: "https://devin.example/auth/cli/continue", tokenUrl: `${tokens.base}/auth/cli/token` },
          openBrowser: browser(callbackResults),
        },
      );

      assert.deepEqual(credentials, {
        access: token,
        refresh: token,
        expires: exp * 1000 - 300_000,
        apiEndpoint: DEVIN_API_ENDPOINT,
        enterpriseUrl: DEVIN_ENTERPRISE_URL,
      });
      assert.equal(authUrls.length, 1);
      assert.equal(authUrls[0]!.instructions, DEVIN_INSTRUCTIONS);
      const authorize = new URL(authUrls[0]!.url);
      assert.equal(`${authorize.origin}${authorize.pathname}`, "https://devin.example/auth/cli/continue");
      assert.deepEqual([...authorize.searchParams.keys()], [
        "response_type",
        "redirect_uri",
        "code_challenge",
        "code_challenge_method",
        "state",
        "prompt",
      ]);
      assert.equal(authorize.searchParams.get("response_type"), "code");
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      assert.equal(authorize.searchParams.get("prompt"), "select_account");
      assert.match(authorize.searchParams.get("state")!, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      assert.match(authorize.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

      assert.equal(tokens.calls.length, 1);
      const call = tokens.calls[0]!;
      assert.equal(call.headers.accept, "application/json");
      assert.equal(call.headers["content-type"], "application/json");
      assert.deepEqual(Object.keys(call.body).sort(), ["code", "code_verifier"], "standard=#false: no grant_type or redirect_uri");
      assert.equal(call.body.code, "callback-code");
      const challenge = createHash("sha256").update(String(call.body.code_verifier)).digest("base64url");
      assert.equal(challenge, authorize.searchParams.get("code_challenge"));
      await new Promise((r) => setImmediate(r));
      assert.deepEqual(callbackResults, [{ status: 200 }]);
    } finally {
      await tokens.close();
    }
  });

  it("refuses a callback with the wrong state and never exchanges its code", async () => {
    const tokens = await startTokenServer({ token: jwt(1_900_000_000) });
    try {
      await assert.rejects(
        loginDevin(
          { onAuth: () => {} },
          {
            callbackPort: 0,
            urls: { tokenUrl: `${tokens.base}/auth/cli/token` },
            openBrowser: browser([], "forged-code", () => "someone-elses-state"),
          },
        ),
        /State mismatch - possible CSRF attack/,
      );
      assert.equal(tokens.calls.length, 0);
    } finally {
      await tokens.close();
    }
  });

  it("a failed exchange names the status and carries no token or body", async () => {
    const tokens = await startTokenServer({ status: 400, body: JSON.stringify({ error: "bad code", token: "secret-token-abc" }) });
    try {
      await assert.rejects(
        loginDevin({ onAuth: () => {} }, { callbackPort: 0, urls: { tokenUrl: `${tokens.base}/auth/cli/token` }, openBrowser: browser([]) }),
        (err: Error) => {
          assert.equal(err.message, "devin token exchange failed: 400");
          assert.doesNotMatch(err.message, /secret-token-abc|callback-code/);
          return true;
        },
      );
    } finally {
      await tokens.close();
    }
  });

  it("reports a busy callback port plainly instead of falling back", async () => {
    const busy = await startServer((_req, _body, res) => res.writeHead(404).end());
    const port = Number(new URL(busy.base).port);
    try {
      await assert.rejects(
        loginDevin({ onAuth: () => assert.fail("no authorize URL when the port is busy") }, { callbackPort: port }),
        new RegExp(`127\\.0\\.0\\.1:${port} for its callback, and that port is in use`),
      );
    } finally {
      await busy.close();
    }
  });

  it("falls back to one year when the token is not a JWT, and refresh asks for a new login once expired", async () => {
    assert.equal(devinTokenExpiry("opaque-session-token", () => 1000), 1000 + DEVIN_EXPIRY_FALLBACK_MS);
    const live = { access: "a", refresh: "a", expires: 2000 };
    assert.equal(await refreshDevin(live, () => 1000), live);
    await assert.rejects(refreshDevin(live, () => 3000), /run `lykos login devin` again/);
  });

  it("`lykos login devin` on an empty pool warns, then stores the credential with the JWT expiry (D6.1, D6.4)", async () => {
    const exp = 1_900_000_000;
    const token = jwt(exp);
    const tokens = await startTokenServer({ token });
    const dir = mkdtempSync(join(tmpdir(), "lykos-devin-login-"));
    const dbPath = join(dir, "credentials.db");
    try {
      const err: string[] = [];
      const opened: string[] = [];
      const callbackResults: { status?: number }[] = [];
      const play = browser(callbackResults);
      const surface: LoginSurface = {
        dbPath,
        out: () => {},
        err: (line) => err.push(line),
        ask: async () => undefined,
        openBrowser: (url) => {
          opened.push(url);
          play(url);
        },
        createRuntime: (opts) =>
          createLykosModelRuntime({
            ...opts,
            providers: loginProviders({
              devin: {
                callbackPort: 0,
                urls: { authorizeUrl: `${tokens.base}/auth/cli/continue`, tokenUrl: `${tokens.base}/auth/cli/token` },
              },
            }),
          }),
      };

      assert.equal(await runLoginFlow("devin", false, surface), 0, err.join("\n"));
      assert.ok(err.includes(sanctionWarning("devin")), "the first login shows the sanction warning");
      assert.equal(opened.length, 1);
      assert.match(opened[0]!, /\/auth\/cli\/continue\?response_type=code&/);

      const db = openCredentialDb(dbPath, { create: false })!;
      try {
        const rows = listEnabledWithData(db, "devin");
        assert.equal(rows.length, 1);
        const data = JSON.parse(rows[0]!.data) as { access: string; refresh: string; expires: number };
        assert.equal(data.access, token);
        assert.equal(data.refresh, token);
        assert.equal(data.expires, exp * 1000 - 300_000);
      } finally {
        db.close();
      }

      // A second login finds a non-empty pool: no warning.
      err.length = 0;
      assert.equal(await runLoginFlow("devin", false, surface), 0, err.join("\n"));
      assert.ok(!err.includes(sanctionWarning("devin")));
    } finally {
      await tokens.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
