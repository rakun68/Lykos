// GitHub Copilot login and refresh against a local fake GitHub / Copilot server (P14 ticket
// 15, plan D3, D5.1). Request shapes follow Pi 0.84.3's dist/auth/oauth/github-copilot.js;
// responses are written, not recorded.
// No test reaches the network.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type FakeAuthServer, scriptedInteraction, startFakeAuthServer } from "../builtin-logins/fake-auth.js";
import {
  COPILOT_CLIENT_ID,
  COPILOT_DOMAIN_PROMPT,
  type CopilotOAuthDeps,
  copilotBaseUrl,
  loginCopilot,
  refreshCopilot,
} from "./oauth.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-copilot-oauth-")), "absent.db");

const COPILOT_TOKEN = "tid=SECRET;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;sku=pro";

async function fakeGitHub(opts: { pending?: number; exchangeStatus?: number } = {}): Promise<FakeAuthServer> {
  let pending = opts.pending ?? 1;
  return startFakeAuthServer((req) => {
    if (req.path === "/login/device/code" && req.method === "POST") {
      return { body: { device_code: "dc-1", user_code: "WXYZ-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 } };
    }
    if (req.path === "/login/oauth/access_token" && req.method === "POST") {
      if (pending > 0) {
        pending -= 1;
        return { body: { error: "authorization_pending" } };
      }
      return { body: { access_token: "gho_SECRET_github_token", token_type: "bearer" } };
    }
    if (req.path === "/copilot_internal/v2/token" && req.method === "GET") {
      if (opts.exchangeStatus !== undefined) return { status: opts.exchangeStatus, body: { message: "gho_SECRET_github_token" } };
      return { body: { token: COPILOT_TOKEN, expires_at: 5_000 } };
    }
    if (req.path === "/models" && req.method === "GET") {
      return {
        body: {
          data: [
            { id: "gpt-picker", model_picker_enabled: true, policy: { state: "enabled" } },
            { id: "claude-policy", model_picker_enabled: true, policy: { state: "unconfigured" } },
            { id: "no-tools", model_picker_enabled: true, capabilities: { supports: { tool_calls: false } } },
          ],
        },
      };
    }
    if (req.path === "/models/claude-policy/policy" && req.method === "POST") return { body: {} };
    return undefined;
  });
}

function depsFor(server: FakeAuthServer): CopilotOAuthDeps {
  return {
    sleep: async () => {},
    knownModelIds: () => ["gpt-picker", "claude-policy"],
    urls: {
      deviceCodeUrl: `${server.base}/login/device/code`,
      accessTokenUrl: `${server.base}/login/oauth/access_token`,
      copilotTokenUrl: `${server.base}/copilot_internal/v2/token`,
      apiBaseUrl: server.base,
    },
  };
}

describe("GitHub Copilot login (ticket 15, D3)", () => {
  it("asks for the enterprise domain first, runs the device flow, exchanges for a Copilot token, stores Pi's shape", async () => {
    const server = await fakeGitHub({ pending: 2 });
    try {
      const s = scriptedInteraction((p) => (p.type === "text" ? "" : undefined));
      const credential = await loginCopilot(s.interaction, depsFor(server));
      assert.equal(s.prompts[0]!.type, "text");
      assert.equal((s.prompts[0] as { message: string }).message, COPILOT_DOMAIN_PROMPT);
      assert.equal(server.requests[0]!.path, "/login/device/code", "the domain prompt comes before the device request");
      assert.deepEqual(Object.fromEntries(new URLSearchParams(server.requests[0]!.body)), { client_id: COPILOT_CLIENT_ID, scope: "read:user" });
      assert.equal(COPILOT_CLIENT_ID, "Iv1.b507a08c87ecfe98");
      assert.deepEqual(
        s.events.find((e) => e.type === "device_code"),
        { type: "device_code", userCode: "WXYZ-1234", verificationUri: "https://github.com/login/device", intervalSeconds: 5, expiresInSeconds: 900 },
      );
      assert.equal(server.requests.filter((r) => r.path === "/login/oauth/access_token").length, 3);
      const exchange = server.requests.find((r) => r.path === "/copilot_internal/v2/token")!;
      assert.equal(exchange.headers.authorization, "Bearer gho_SECRET_github_token");
      assert.equal(exchange.headers["user-agent"], "GitHubCopilotChat/0.35.0");
      assert.equal(exchange.headers["editor-version"], "vscode/1.107.0");
      assert.equal(exchange.headers["copilot-integration-id"], "vscode-chat");
      const models = server.requests.find((r) => r.path === "/models")!;
      assert.equal(models.headers["x-github-api-version"], "2026-06-01");
      assert.ok(server.requests.some((r) => r.path === "/models/claude-policy/policy"), "an unconfigured model Pi knows is enabled");
      assert.deepEqual(credential, {
        type: "oauth",
        refresh: "gho_SECRET_github_token",
        access: COPILOT_TOKEN,
        expires: 5_000_000 - 300_000,
        availableModelIds: ["gpt-picker", "claude-policy"],
      });
    } finally {
      await server.close();
    }
  });

  it("an enterprise domain is stored as enterpriseUrl and refresh re-exchanges the GitHub token, keeping every field", async () => {
    const server = await fakeGitHub({ pending: 0 });
    try {
      const s = scriptedInteraction((p) => (p.type === "text" ? "https://company.ghe.com/" : undefined));
      const credential = await loginCopilot(s.interaction, depsFor(server));
      assert.equal(credential.enterpriseUrl, "company.ghe.com");

      server.requests.length = 0;
      const stored = { ...credential, access: "stale", expires: 0, extra: "kept" };
      const next = await refreshCopilot(stored, depsFor(server));
      assert.deepEqual(
        server.requests.map((r) => r.path),
        ["/copilot_internal/v2/token", "/models"],
        "refresh = one exchange plus Pi's model re-read",
      );
      assert.equal(server.requests[0]!.headers.authorization, "Bearer gho_SECRET_github_token");
      assert.deepEqual(next, { ...stored, access: COPILOT_TOKEN, expires: 5_000_000 - 300_000, availableModelIds: ["gpt-picker", "claude-policy"] });
    } finally {
      await server.close();
    }
  });

  it("a failed exchange names the status and carries no token; an invalid domain is refused", async () => {
    const server = await fakeGitHub({ exchangeStatus: 401 });
    try {
      await assert.rejects(
        refreshCopilot({ type: "oauth", access: "a", refresh: "gho_SECRET_github_token", expires: 0 }, depsFor(server)),
        (err: Error) => {
          assert.match(err.message, /Copilot token exchange failed: 401/);
          assert.ok(!err.message.includes("SECRET"), err.message);
          return true;
        },
      );
      const s = scriptedInteraction((p) => (p.type === "text" ? "http://" : undefined));
      await assert.rejects(loginCopilot(s.interaction, depsFor(server)), /Invalid GitHub Enterprise URL\/domain/);
    } finally {
      await server.close();
    }
  });

  it("the base URL is Pi's: the token's proxy-ep, else the enterprise or individual endpoint", () => {
    assert.equal(copilotBaseUrl(COPILOT_TOKEN, undefined), "https://api.individual.githubcopilot.com");
    assert.equal(copilotBaseUrl("tid=x", "company.ghe.com"), "https://copilot-api.company.ghe.com");
    assert.equal(copilotBaseUrl(undefined, undefined), "https://api.individual.githubcopilot.com");
  });
});
