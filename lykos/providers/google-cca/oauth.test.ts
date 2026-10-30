// P14.2 ticket 04, plan D3 cases 1-5: the fake login server (test seam 2).
//
// One `node:http` server on 127.0.0.1:0 plays Google's authorization server,
// token endpoint, userinfo endpoint and the Cloud Code Assist control plane
// (`v1internal:loadCodeAssist`, `v1internal:onboardUser`, operation polling).
// Its responses are written, not recorded. The injected browser opener checks the authorize URL, then does
// what a browser would: GET the authorize URL and follow its redirect to the
// flow's loopback callback. Nothing reaches Google and no browser opens.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, beforeEach, describe, it } from "node:test";
import { runLogin } from "../../cli/login.js";
import { openCredentialDb } from "../../credentials/db.js";
import { listCredentials, readCredentialById } from "../../credentials/pool.js";
import { createLykosModelRuntime } from "../../session/model-runtime.js";
import { type GoogleOAuthDeps, loginGoogle, refreshGoogle } from "./oauth.js";
import { googleCcaProviders } from "./register.js";
import { decodeRuleValue, GOOGLE_OAUTH_RULES, type GoogleOAuthRule } from "./rules.js";
import type { GoogleCcaProviderId, OAuthCredentials } from "./types.js";

// Ticket 08: keep Pi's agent dir (piHostDir) off the real ~/.lykos/pi-host.
process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
process.env.LYKOS_CREDENTIALS_DB = join(tmp("lykos-oauth-absent-"), "absent.db");

// ---------------------------------------------------------------------------
// The fake Google
// ---------------------------------------------------------------------------

interface Hit {
  method: string;
  path: string;
  userAgent: string;
  body: string;
}

const fake = {
  url: "",
  hits: [] as Hit[],
  /** Email the next authorization is issued for. */
  nextEmail: "alice@example.com",
  /** When set, the authorize redirect carries this state instead of the one it was given. */
  stateOverride: undefined as string | undefined,
  refreshFails: false,
  /** "existing": the account has a project; "onboard": it must be provisioned first. */
  controlPlane: "existing" as "existing" | "onboard",
  onboarded: false,
  opPolls: 0,
  codes: new Map<string, { challenge: string | null; clientId: string; redirectUri: string; email: string }>(),
  accessEmail: new Map<string, string>(),
  seq: 0,
  tokenRequests: [] as URLSearchParams[],
  pkceVerified: [] as boolean[],
};

let server: Server;

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function projectFor(email: string): string {
  return `proj-${email.split("@")[0]}`;
}

before(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", fake.url);
      fake.hits.push({ method: req.method ?? "", path: url.pathname, userAgent: String(req.headers["user-agent"] ?? ""), body });
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const isCli = String(req.headers["user-agent"] ?? "").startsWith("GeminiCLI/");

      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        const code = `code-${++fake.seq}`;
        fake.codes.set(code, {
          challenge: q.get("code_challenge"),
          clientId: q.get("client_id") ?? "",
          redirectUri: q.get("redirect_uri") ?? "",
          email: fake.nextEmail,
        });
        const back = new URL(q.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", fake.stateOverride ?? q.get("state") ?? "");
        res.writeHead(302, { Location: back.toString() });
        res.end();
        return;
      }

      if (url.pathname === "/token") {
        const form = new URLSearchParams(body);
        fake.tokenRequests.push(form);
        if (form.get("grant_type") === "authorization_code") {
          const issued = fake.codes.get(form.get("code") ?? "");
          if (!issued || issued.redirectUri !== form.get("redirect_uri") || issued.clientId !== form.get("client_id")) {
            json(res, 400, { error: "invalid_grant" });
            return;
          }
          const verifier = form.get("code_verifier") ?? "";
          const ok = issued.challenge !== null && createHash("sha256").update(verifier).digest("base64url") === issued.challenge;
          fake.pkceVerified.push(ok);
          if (!ok) {
            json(res, 400, { error: "invalid_grant", error_description: "Missing code verifier." });
            return;
          }
          const n = ++fake.seq;
          fake.accessEmail.set(`at-${n}`, issued.email);
          json(res, 200, { access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: 3599, token_type: "Bearer", scope: "x" });
          return;
        }
        if (form.get("grant_type") === "refresh_token") {
          if (fake.refreshFails) {
            json(res, 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." });
            return;
          }
          json(res, 200, { access_token: `at-refreshed-${++fake.seq}`, expires_in: 3599, token_type: "Bearer" });
          return;
        }
        json(res, 400, { error: "unsupported_grant_type" });
        return;
      }

      if (url.pathname === "/userinfo") {
        const email = fake.accessEmail.get(bearer);
        if (email === undefined) json(res, 401, { error: "invalid_token" });
        else json(res, 200, { id: "1", email, verified_email: true });
        return;
      }

      const email = fake.accessEmail.get(bearer) ?? "unknown@example.com";
      const provisioned = fake.controlPlane === "existing" || fake.onboarded;
      if (url.pathname === "/v1internal:loadCodeAssist") {
        if (provisioned) {
          json(res, 200, {
            currentTier: { id: "free-tier" },
            allowedTiers: [{ id: "free-tier", isDefault: true }],
            cloudaicompanionProject: fake.onboarded ? "proj-onboarded" : projectFor(email),
          });
        } else {
          json(res, 200, { allowedTiers: [{ id: "free-tier", isDefault: true }] });
        }
        return;
      }
      if (url.pathname === "/v1internal:onboardUser") {
        json(res, 200, { name: "operations/onboard-1", done: false });
        return;
      }
      if (url.pathname === "/v1internal/operations/onboard-1") {
        fake.opPolls += 1;
        if (fake.opPolls < 2) {
          json(res, 200, { name: "operations/onboard-1", done: false });
          return;
        }
        fake.onboarded = true;
        json(res, 200, {
          name: "operations/onboard-1",
          done: true,
          response: {
            "@type": "type.googleapis.com/google.internal.cloud.code.v1internal.OnboardUserResponse",
            cloudaicompanionProject: isCli ? { id: "proj-onboarded" } : { id: "proj-onboarded", name: "proj-onboarded" },
          },
        });
        return;
      }
      json(res, 404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(() => {
  fake.hits = [];
  fake.nextEmail = "alice@example.com";
  fake.stateOverride = undefined;
  fake.refreshFails = false;
  fake.controlPlane = "existing";
  fake.onboarded = false;
  fake.opPolls = 0;
  fake.tokenRequests = [];
  fake.pkceVerified = [];
});

// ---------------------------------------------------------------------------
// The browser the flow is handed
// ---------------------------------------------------------------------------

interface Opener {
  open: (url: string) => void;
  opened: URL[];
  /** Settles once the redirect has been delivered to the loopback callback. */
  done: () => Promise<void>;
}

function browser(): Opener {
  const opened: URL[] = [];
  const pending: Promise<void>[] = [];
  return {
    opened,
    open(url: string) {
      opened.push(new URL(url));
      pending.push(
        (async () => {
          const auth = await fetch(url, { redirect: "manual" });
          const location = auth.headers.get("location");
          assert.ok(location, "the authorization server redirects back");
          const cb = await fetch(location);
          await cb.text();
        })(),
      );
    },
    done: async () => {
      await Promise.all(pending);
    },
  };
}

const NOW = 1_700_000_000_000;

function deps(opener?: Opener): GoogleOAuthDeps {
  return {
    ...(opener !== undefined ? { openBrowser: opener.open } : {}),
    callbackPort: 0,
    now: () => NOW,
    pollIntervalMs: 1,
    env: {},
    endpoints: {
      authorizeUrl: `${fake.url}/authorize`,
      tokenUrl: `${fake.url}/token`,
      userinfoUrl: `${fake.url}/userinfo`,
      controlPlaneUrl: fake.url,
    },
  };
}

const silent = { onAuth: () => {}, onProgress: () => {} };

const PROVIDERS: readonly GoogleCcaProviderId[] = ["google-antigravity", "google-gemini-cli"];

function checkAuthorizeUrl(rule: GoogleOAuthRule, url: URL): void {
  const q = url.searchParams;
  assert.equal(`${url.origin}${url.pathname}`, `${fake.url}/authorize`);
  assert.equal(q.get("client_id"), decodeRuleValue(rule.clientIdBase64));
  assert.match(q.get("client_id")!, /\.apps\.googleusercontent\.com$/);
  assert.equal(q.get("response_type"), "code");
  assert.equal(q.get("scope"), rule.scopes.join(" "));
  assert.match(q.get("state") ?? "", /^[0-9a-f]{32}$/);
  assert.match(q.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
  assert.match(q.get("redirect_uri") ?? "", new RegExp(`^http://127\\.0\\.0\\.1:\\d+${rule.callback.path}$`));
}

// ---------------------------------------------------------------------------
// Cases 1-4, for each provider
// ---------------------------------------------------------------------------

for (const provider of PROVIDERS) {
  const rule = GOOGLE_OAUTH_RULES[provider];

  describe(`${provider} login against the fake authorization server (plan D3)`, () => {
    it("1. completes with access, refresh, skewed expiry, email and projectId; the token request carried the PKCE verifier", async () => {
      const opener = browser();
      const credential = await loginGoogle(rule, silent, deps(opener));
      await opener.done();

      assert.equal(opener.opened.length, 1);
      checkAuthorizeUrl(rule, opener.opened[0]!);
      assert.match(credential.access, /^at-\d+$/);
      assert.match(credential.refresh, /^rt-\d+$/);
      assert.equal(credential.expires, NOW + 3_599_000 - 300_000, "expires_in minus the rule's 300 000 ms skew");
      assert.equal(credential.email, "alice@example.com");
      assert.equal(credential.projectId, "proj-alice");

      const exchange = fake.tokenRequests.find((f) => f.get("grant_type") === "authorization_code")!;
      assert.ok((exchange.get("code_verifier") ?? "").length >= 43);
      assert.equal(exchange.get("client_secret"), decodeRuleValue(rule.clientSecretBase64));
      assert.deepEqual(fake.pkceVerified, [true]);
      const expectedAgent = provider === "google-antigravity" ? /^antigravity\/hub\// : /^GeminiCLI\//;
      const control = fake.hits.filter((h) => h.path.startsWith("/v1internal"));
      assert.ok(control.length > 0 && control.every((h) => expectedAgent.test(h.userAgent)));
    });

    it("2. a callback with the wrong state fails the login and no code is exchanged", async () => {
      fake.stateOverride = "0".repeat(32);
      const opener = browser();
      await assert.rejects(loginGoogle(rule, silent, deps(opener)), /State mismatch/);
      await opener.done();
      assert.equal(fake.tokenRequests.length, 0);
    });

    it("3. refresh exchanges the refresh token and carries projectId; a refused refresh surfaces", async () => {
      const opener = browser();
      const credential = await loginGoogle(rule, silent, deps(opener));
      await opener.done();
      fake.hits = [];

      const refreshed = await refreshGoogle(rule, credential, deps());
      const grant = fake.tokenRequests.find((f) => f.get("grant_type") === "refresh_token")!;
      assert.equal(grant.get("refresh_token"), credential.refresh);
      assert.match(refreshed.access, /^at-refreshed-\d+$/);
      assert.equal(refreshed.refresh, credential.refresh, "an unrotated refresh token is kept");
      assert.equal(refreshed.expires, NOW + 3_599_000 - 300_000);
      assert.equal(refreshed.projectId, credential.projectId, "the after-refresh hook keeps the project");
      assert.equal(refreshed.email, credential.email, "email survives, so the identity key is stable");
      assert.equal(fake.hits.filter((h) => h.path.startsWith("/v1internal")).length, 0, "refresh makes no control-plane call");

      fake.refreshFails = true;
      await assert.rejects(refreshGoogle(rule, credential, deps()), /token refresh failed: 400 .*invalid_grant/);
      const { projectId: _p, ...noProject } = credential;
      await assert.rejects(refreshGoogle(rule, noProject as OAuthCredentials, deps()), /missing projectId; sign in again/);
    });

    it("3b. a token request whose connection never opened is retried; one that keeps failing names the cause", async () => {
      const opener = browser();
      const credential = await loginGoogle(rule, silent, deps(opener));
      await opener.done();

      // Node's fetch reports a connect timeout as TypeError("fetch failed") with the code on `cause`.
      const connectTimeout = (): Error =>
        Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
      const flaky = (failures: number): typeof fetch => {
        let left = failures;
        return (async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.endsWith("/token") && left > 0) {
            left -= 1;
            throw connectTimeout();
          }
          return fetch(input, init);
        }) as typeof fetch;
      };

      const before = fake.tokenRequests.length;
      const refreshed = await refreshGoogle(rule, credential, { ...deps(), fetch: flaky(2) });
      assert.match(refreshed.access, /^at-refreshed-\d+$/);
      assert.equal(fake.tokenRequests.length, before + 1, "the server saw the request once");

      await assert.rejects(
        refreshGoogle(rule, credential, { ...deps(), fetch: flaky(3) }),
        /failed: fetch failed \(UND_ERR_CONNECT_TIMEOUT, 3 attempt\(s\)\)/,
      );
    });

    it("4. an account without a project is onboarded and the operation polled", async () => {
      fake.controlPlane = "onboard";
      const opener = browser();
      const credential = await loginGoogle(rule, silent, deps(opener));
      await opener.done();
      assert.equal(credential.projectId, "proj-onboarded");
      const paths = fake.hits.map((h) => `${h.method} ${h.path}`);
      assert.ok(paths.includes("POST /v1internal:onboardUser"));
      assert.ok(paths.filter((p) => p === "GET /v1internal/operations/onboard-1").length >= 2, "polled until done");
      const onboard = fake.hits.find((h) => h.path === "/v1internal:onboardUser")!;
      assert.equal((JSON.parse(onboard.body) as { tierId: string }).tierId, "free-tier");
    });
  });
}

// ---------------------------------------------------------------------------
// Case 5: through `lykos login`
// ---------------------------------------------------------------------------

describe("lykos login google-* through the registered provider (plan D3, case 5)", () => {
  function loginIo(dbPath: string, opener: Opener) {
    let out = "";
    let err = "";
    const fetched: string[] = [];
    const recordingFetch: typeof fetch = (input, init) => {
      fetched.push(String(input));
      return fetch(input, init);
    };
    const providerDeps = { ...deps(), fetch: recordingFetch };
    return {
      io: {
        stdin: Readable.from([]),
        stdout: { write: (s: string) => (out += s) },
        stderr: { write: (s: string) => (err += s) },
        env: {},
        dbPath,
        openBrowser: opener.open,
        createRuntime: (opts: Parameters<typeof createLykosModelRuntime>[0]) =>
          createLykosModelRuntime({ ...opts, providers: googleCcaProviders(providerDeps) }),
      },
      out: () => out,
      err: () => err,
      fetched,
    };
  }

  for (const provider of PROVIDERS) {
    it(`5. ${provider}: two emails make two credentials in one pool; the first email again updates`, async () => {
      const dbPath = join(tmp("lykos-google-login-"), "credentials.db");
      const outputs: string[] = [];
      const login = async (email: string): Promise<string> => {
        fake.nextEmail = email;
        const opener = browser();
        const c = loginIo(dbPath, opener);
        const code = await runLogin([provider], c.io);
        await opener.done();
        assert.equal(code, 0, c.err());
        assert.equal(opener.opened.length, 1, "the CLI's opener received the provider's authorize URL");
        assert.ok(c.fetched.some((u) => u.endsWith("/token")), "the injected fetch reached the provider");
        outputs.push(c.out() + c.err());
        return c.out();
      };

      assert.equal(await login("alice@example.com"), `logged in to ${provider} as alice@example.com (1 credential(s) in pool)\n`);
      assert.equal(await login("bob@example.com"), `logged in to ${provider} as bob@example.com (2 credential(s) in pool)\n`);
      assert.equal(await login("alice@example.com"), `updated ${provider} as alice@example.com (2 credential(s) in pool)\n`);

      const db = openCredentialDb(dbPath, { create: false })!;
      try {
        const rows = listCredentials(db, provider);
        assert.deepEqual(rows.map((r) => [r.type, r.label, r.disabledCause]), [
          ["oauth", "alice@example.com", null],
          ["oauth", "bob@example.com", null],
        ]);
        const alice = JSON.parse(readCredentialById(db, rows[0]!.id)!.data) as Record<string, unknown>;
        const bob = JSON.parse(readCredentialById(db, rows[1]!.id)!.data) as Record<string, unknown>;
        assert.equal(alice.projectId, "proj-alice");
        assert.equal(bob.projectId, "proj-bob");
        assert.equal(alice.email, "alice@example.com");
        for (const text of outputs) {
          for (const secret of [alice.access, alice.refresh, bob.access, bob.refresh]) {
            assert.ok(!text.includes(String(secret)), "no token in CLI output");
          }
        }
      } finally {
        db.close();
      }
    });
  }

  it("a state mismatch under lykos login stores nothing", async () => {
    const dbPath = join(tmp("lykos-google-login-"), "credentials.db");
    fake.stateOverride = "f".repeat(32);
    const opener = browser();
    const c = loginIo(dbPath, opener);
    assert.equal(await runLogin(["google-antigravity"], c.io), 1);
    await opener.done();
    assert.match(c.err(), /google-antigravity OAuth login failed: .*State mismatch/);
    assert.equal(openCredentialDb(dbPath, { create: false }), undefined, "no db was created");
  });
});
