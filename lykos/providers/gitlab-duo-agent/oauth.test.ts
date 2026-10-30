// GitLab Duo Agent login tests.
//
// A local fake token server on 127.0.0.1; no network.

import assert from "node:assert/strict";
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
  GITLAB_DUO_AGENT_CLIENT_ID,
  GITLAB_DUO_AGENT_REDIRECT_URI,
  loginGitLabDuoAgent,
  parseCallbackInput,
  refreshGitLabDuoAgent,
} from "./oauth.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-duo-agent-oauth-")), "absent.db");

type Route = (req: IncomingMessage, body: string, res: ServerResponse) => void;

async function startServer(route: Route): Promise<{ base: string; bodies: string[]; close: () => Promise<void> }> {
  const bodies: string[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      bodies.push(body);
      route(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    bodies,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

const tokenBody = { access_token: "access-token", refresh_token: "refresh-token", expires_in: 7200, created_at: 1000 };

describe("gitlab-duo-agent login (ticket 13, D6.1)", () => {
  it("a pasted vscode:// callback URL exchanges with the VS Code OAuth app and PKCE", async () => {
    const server = await startServer((_req, _body, res) => json(res, 200, tokenBody));
    try {
      let authUrl = "";
      let instructions = "";
      const opened: string[] = [];
      const credentials = await loginGitLabDuoAgent(
        {
          onAuth: (info) => {
            authUrl = info.url;
            instructions = info.instructions ?? "";
          },
          onPrompt: async () => {
            const state = new URL(authUrl).searchParams.get("state");
            return `${GITLAB_DUO_AGENT_REDIRECT_URI}?code=oauth-code&state=${state}`;
          },
        },
        { urls: { tokenUrl: `${server.base}/oauth/token` }, openBrowser: (url) => opened.push(url) },
      );

      const authorize = new URL(authUrl);
      assert.ok(authUrl.startsWith("https://gitlab.com/oauth/authorize?"));
      assert.equal(authorize.searchParams.get("client_id"), GITLAB_DUO_AGENT_CLIENT_ID);
      assert.equal(authorize.searchParams.get("redirect_uri"), GITLAB_DUO_AGENT_REDIRECT_URI);
      assert.equal(authorize.searchParams.get("response_type"), "code");
      assert.equal(authorize.searchParams.get("scope"), "api");
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      assert.deepEqual(opened, [authUrl]);
      assert.match(instructions, /VS Code/);
      assert.match(instructions, /copy/);

      const params = new URLSearchParams(server.bodies[0]);
      assert.equal(params.get("grant_type"), "authorization_code");
      assert.equal(params.get("client_id"), GITLAB_DUO_AGENT_CLIENT_ID);
      assert.equal(params.get("redirect_uri"), GITLAB_DUO_AGENT_REDIRECT_URI);
      assert.equal(params.get("code"), "oauth-code");
      assert.ok((params.get("code_verifier") ?? "").length > 0);

      assert.equal(credentials.access, "access-token");
      assert.equal(credentials.refresh, "refresh-token");
      assert.equal(credentials.expires, 1000 * 1000 + 7200 * 1000 - 5 * 60 * 1000);
    } finally {
      await server.close();
    }
  });

  it("a bare pasted code exchanges too", async () => {
    const server = await startServer((_req, _body, res) => json(res, 200, tokenBody));
    try {
      const credentials = await loginGitLabDuoAgent(
        { onAuth: () => {}, onPrompt: async () => "  bare-code  " },
        { urls: { tokenUrl: `${server.base}/oauth/token` } },
      );
      assert.equal(new URLSearchParams(server.bodies[0]).get("code"), "bare-code");
      assert.equal(credentials.access, "access-token");
    } finally {
      await server.close();
    }
  });

  it("a callback carrying the wrong state is refused before any exchange", async () => {
    const server = await startServer((_req, _body, res) => json(res, 200, tokenBody));
    try {
      await assert.rejects(
        loginGitLabDuoAgent(
          { onAuth: () => {}, onPrompt: async () => `${GITLAB_DUO_AGENT_REDIRECT_URI}?code=oauth-code&state=not-the-state` },
          { urls: { tokenUrl: `${server.base}/oauth/token` } },
        ),
        /State mismatch - possible CSRF attack/,
      );
      assert.equal(server.bodies.length, 0);
    } finally {
      await server.close();
    }
  });

  it("parses a callback URL, a query string and a bare code", () => {
    assert.deepEqual(parseCallbackInput(`${GITLAB_DUO_AGENT_REDIRECT_URI}?code=c&state=s`), { code: "c", state: "s" });
    assert.deepEqual(parseCallbackInput("?code=c&state=s"), { code: "c", state: "s" });
    assert.deepEqual(parseCallbackInput("c#s"), { code: "c", state: "s" });
    assert.deepEqual(parseCallbackInput("c"), { code: "c" });
  });

  it("refresh sends the VS Code redirect URI and keeps an unrotated refresh token", async () => {
    const server = await startServer((_req, _body, res) =>
      json(res, 200, { access_token: "fresh-access", expires_in: 7200, created_at: 2000 }),
    );
    try {
      const refreshed = await refreshGitLabDuoAgent(
        { access: "old-access", refresh: "old-refresh", expires: 0 },
        { urls: { tokenUrl: `${server.base}/oauth/token` } },
      );
      const params = new URLSearchParams(server.bodies[0]);
      assert.equal(params.get("grant_type"), "refresh_token");
      assert.equal(params.get("client_id"), GITLAB_DUO_AGENT_CLIENT_ID);
      assert.equal(params.get("refresh_token"), "old-refresh");
      assert.equal(params.get("redirect_uri"), GITLAB_DUO_AGENT_REDIRECT_URI);
      assert.equal(refreshed.access, "fresh-access");
      assert.equal(refreshed.refresh, "old-refresh");
      assert.equal(refreshed.expires, 2000 * 1000 + 7200 * 1000 - 300_000);
    } finally {
      await server.close();
    }
  });

  it("failed exchange and refresh name the status and carry no token", async () => {
    const secret = "glrt-0123456789abcdef0123456789abcdef0123456789abcdef";
    const server = await startServer((_req, _body, res) => json(res, 401, { error: "invalid_grant", echoed: secret }));
    try {
      await assert.rejects(
        refreshGitLabDuoAgent({ access: "a", refresh: secret, expires: 0 }, { urls: { tokenUrl: `${server.base}/oauth/token` } }),
        (err: Error) => {
          assert.match(err.message, /^GitLab Duo Agent token refresh failed: 401 /);
          assert.doesNotMatch(err.message, new RegExp(secret));
          return true;
        },
      );
      await assert.rejects(
        loginGitLabDuoAgent(
          { onAuth: () => {}, onPrompt: async () => secret },
          { urls: { tokenUrl: `${server.base}/oauth/token` } },
        ),
        (err: Error) => {
          assert.match(err.message, /^GitLab Duo Agent token exchange failed: 401 /);
          assert.doesNotMatch(err.message, new RegExp(secret));
          return true;
        },
      );
    } finally {
      await server.close();
    }
  });

  it("a response without expires_in is refused", async () => {
    const server = await startServer((_req, _body, res) => json(res, 200, { access_token: "a", refresh_token: "r" }));
    try {
      await assert.rejects(
        loginGitLabDuoAgent({ onAuth: () => {}, onPrompt: async () => "code" }, { urls: { tokenUrl: `${server.base}/t` } }),
        /missing expires_in/,
      );
    } finally {
      await server.close();
    }
  });
});

describe("`lykos login gitlab-duo-agent` (ticket 13, D6.4)", () => {
  it("on an empty pool warns, takes the pasted callback, and stores the credential in the Lykos db", async () => {
    const server = await startServer((_req, _body, res) => json(res, 200, { ...tokenBody, access_token: "duo-agent-access" }));
    const dir = mkdtempSync(join(tmpdir(), "lykos-duo-agent-login-"));
    const dbPath = join(dir, "credentials.db");
    try {
      const err: string[] = [];
      const opened: string[] = [];
      const surface: LoginSurface = {
        dbPath,
        out: () => {},
        err: (line) => err.push(line),
        ask: async () => {
          const state = new URL(opened.at(-1)!).searchParams.get("state");
          return `${GITLAB_DUO_AGENT_REDIRECT_URI}?code=oauth-code&state=${state}`;
        },
        openBrowser: (url) => opened.push(url),
        createRuntime: (opts) =>
          createLykosModelRuntime({
            ...opts,
            providers: loginProviders({ gitlabDuoAgent: { urls: { tokenUrl: `${server.base}/oauth/token` } } }),
          }),
      };

      assert.equal(await runLoginFlow("gitlab-duo-agent", false, surface), 0, err.join("\n"));
      assert.ok(err.includes(sanctionWarning("gitlab-duo-agent")), "the first login shows the sanction warning");
      assert.equal(opened.length, 1);
      assert.ok(opened[0]!.startsWith("https://gitlab.com/oauth/authorize?"));

      const db = openCredentialDb(dbPath, { create: false })!;
      try {
        const rows = listEnabledWithData(db, "gitlab-duo-agent");
        assert.equal(rows.length, 1);
        const data = JSON.parse(rows[0]!.data) as { access: string; refresh: string };
        assert.equal(data.access, "duo-agent-access");
        assert.equal(data.refresh, "refresh-token");
      } finally {
        db.close();
      }

      err.length = 0;
      assert.equal(await runLoginFlow("gitlab-duo-agent", false, surface), 0);
      assert.ok(!err.includes(sanctionWarning("gitlab-duo-agent")), "a second login finds a non-empty pool: no warning");
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
