import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { openCredentialDb, upsertCooldown } from "../credentials/db.js";
import { disableCredential, upsertCredential } from "../credentials/pool.js";
import { readCachedReport, storeReport } from "../credentials/usage/cache.js";
import { parseClaudeUsage } from "../credentials/usage/claude.js";
import { claudeFableScopedBody } from "../credentials/usage/fixtures/claude.js";
import { codexAccessTokenFixture, codexUsagePayload } from "../credentials/usage/fixtures/codex.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const cliPath = join(repoRoot, "lykos", "cli.ts");

function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(payload)}.signature`;
}

describe("lykos usage CLI (D2 / D7.1)", () => {
  it("absent store prints no-credentials line, exits 0, and does not create the file", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-usage-absent-"));
    const dbPath = join(dir, "absent.db");

    const res = spawnSync(process.execPath, ["--import", "tsx", cliPath, "usage"], {
      cwd: repoRoot,
      env: { ...process.env, LYKOS_CREDENTIALS_DB: dbPath },
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /no credentials — run `lykos login <provider>`/);
    assert.equal(existsSync(dbPath), false, "absent db file must not be created");
  });

  it("empty store prints no-credentials line and exits 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-usage-empty-"));
    const dbPath = join(dir, "empty.db");
    const db = openCredentialDb(dbPath, { create: true })!;
    db.close();

    const res = spawnSync(process.execPath, ["--import", "tsx", cliPath, "usage"], {
      cwd: repoRoot,
      env: { ...process.env, LYKOS_CREDENTIALS_DB: dbPath },
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /no credentials — run `lykos login <provider>`/);
  });

  it("lists pools and credentials with labels, states, resets and never prints secrets", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-usage-seeded-"));
    const dbPath = join(dir, "creds.db");
    const db = openCredentialDb(dbPath, { create: true })!;

    const secretOAuth = "oauth-access-token-DISTINCTIVE-SECRET-DO-NOT-PRINT";
    const secretApiKey = "sk-test-DO-NOT-PRINT";

    // 1 OAuth row
    const oauthRow = upsertCredential(db, "google-antigravity", {
      type: "oauth",
      access: jwt({ email: "engineer@example.com", token: secretOAuth }),
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
    });

    // 1 api_key literal row
    const apiKeyRow = upsertCredential(db, "anthropic", {
      type: "api_key",
      key: secretApiKey,
    });

    // 1 cooling row with a known reset
    const resetTime = 1900000000000;
    const resetIso = new Date(resetTime).toISOString();
    const coolingRow = upsertCredential(db, "anthropic", {
      type: "api_key",
      key: "env:ANTHROPIC_COOLING_KEY",
    });
    upsertCooldown(db, coolingRow.row.id, resetTime, { reason: "usage_limit" });

    // 1 disabled row
    const disabledRow = upsertCredential(db, "anthropic", {
      type: "api_key",
      key: "env:ANTHROPIC_DISABLED_KEY",
    });
    disableCredential(db, disabledRow.row.id, "revoked_by_admin");

    db.close();

    const res = spawnSync(process.execPath, ["--import", "tsx", cliPath, "usage"], {
      cwd: repoRoot,
      env: { ...process.env, LYKOS_CREDENTIALS_DB: dbPath },
      encoding: "utf8",
    });

    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const out = res.stdout;

    // Headers
    assert.match(out, /anthropic\s+\(2 enabled, 1 cooling, 1 disabled\)/);
    assert.match(out, /google-antigravity\s+\(1 enabled, 0 cooling, 0 disabled\)/);

    // Labels
    assert.ok(out.includes(oauthRow.row.label), `missing oauth label: ${oauthRow.row.label}`);
    assert.ok(out.includes(apiKeyRow.row.label), `missing api key label: ${apiKeyRow.row.label}`);
    assert.ok(out.includes(coolingRow.row.label), `missing cooling label: ${coolingRow.row.label}`);
    assert.ok(out.includes(disabledRow.row.label), `missing disabled label: ${disabledRow.row.label}`);

    // Types
    assert.match(out, /\boauth\b/);
    assert.match(out, /\bapi_key\b/);

    // States
    assert.match(out, /\bok\b/);
    assert.match(out, /cooling \(usage_limit\)/);
    assert.match(out, /disabled \(revoked_by_admin\)/);

    // Reset timestamp
    assert.ok(out.includes(resetIso), `expected reset ${resetIso} in output:\n${out}`);

    // usage: unmeasured
    assert.match(out, /usage: unmeasured/);

    // Neither secret appears in stdout or stderr
    assert.equal(out.includes(secretOAuth), false, "OAuth secret leaked in stdout");
    assert.equal(out.includes(secretApiKey), false, "API key secret leaked in stdout");
    assert.equal(out.includes("DO-NOT-PRINT"), false, "Marker DO-NOT-PRINT leaked in stdout");
    assert.equal(res.stderr.includes(secretOAuth), false, "OAuth secret leaked in stderr");
    assert.equal(res.stderr.includes(secretApiKey), false, "API key secret leaked in stderr");
    assert.equal(res.stderr.includes("DO-NOT-PRINT"), false, "Marker DO-NOT-PRINT leaked in stderr");
  });
});

// ---------------------------------------------------------------------------
// Ticket 09, plan D4 / D5.4: usage windows and `--refresh`.
// Usage bodies are written fixtures, not recordings.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const preload = pathToFileURL(join(repoRoot, "lykos", "credentials", "usage", "redirect-fetch-preload.ts")).href;

function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: repoRoot, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => resolveRun({ status, stdout, stderr }));
  });
}

describe("lykos usage windows (ticket 09, D4)", () => {
  it("shows each cached window with its reset and age, and unmeasured for a row without a report", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-usage-windows-"));
    const dbPath = join(dir, "creds.db");
    const db = openCredentialDb(dbPath, { create: true })!;
    const secret = "oauth-access-DO-NOT-PRINT";
    const measured = upsertCredential(db, "anthropic", {
      type: "oauth",
      access: `${secret}-1`,
      refresh: "r1",
      expires: Date.now() + HOUR,
      email: "one@example.com",
    } as never);
    const unmeasured = upsertCredential(db, "anthropic", {
      type: "oauth",
      access: `${secret}-2`,
      refresh: "r2",
      expires: Date.now() + HOUR,
      email: "two@example.com",
    } as never);
    const fetchedAt = Date.now() - 3 * 60_000;
    const report = parseClaudeUsage(claudeFableScopedBody(fetchedAt), fetchedAt)!;
    storeReport(db, measured.row.id, report);
    db.close();

    const res = spawnSync(process.execPath, ["--import", "tsx", cliPath, "usage"], {
      cwd: repoRoot,
      env: { ...process.env, LYKOS_CREDENTIALS_DB: dbPath },
      encoding: "utf8",
    });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    const lines = res.stdout.split("\n");
    const one = lines.find((l) => l.includes(measured.row.label))!;
    const two = lines.find((l) => l.includes(unmeasured.row.label))!;
    const iso = (ms: number | undefined): string => new Date(ms!).toISOString();
    assert.ok(one.includes(`5h 16% resets ${iso(report.windows[0]!.resetAtMs)}`), one);
    assert.ok(one.includes(`7d 18% resets ${iso(report.windows[1]!.resetAtMs)}`), one);
    assert.ok(one.includes(`7d:fable 28% resets ${iso(report.windows[2]!.resetAtMs)}`), one);
    assert.match(one, /\(fetched 3m ago\)/);
    assert.match(two, /usage: unmeasured/);
    assert.equal(res.stdout.includes("DO-NOT-PRINT"), false, "secret leaked in stdout");
    assert.equal(res.stderr.includes("DO-NOT-PRINT"), false, "secret leaked in stderr");
  });

  it("--refresh fetches each enabled OAuth row of anthropic and openai-codex exactly once", async () => {
    const hits: Array<{ path: string; bearer: string; account: string | undefined }> = [];
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const path = (req.url ?? "").split("?")[0]!;
        const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
        const account = req.headers["chatgpt-account-id"];
        hits.push({ path, bearer, account: typeof account === "string" ? account : undefined });
        const body =
          path === "/api/oauth/usage"
            ? claudeFableScopedBody(Date.now())
            : path === "/backend-api/wham/usage"
              ? codexUsagePayload()
              : undefined;
        res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify(body ?? {}));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const dir = mkdtempSync(join(tmpdir(), "lykos-usage-refresh-"));
      const dbPath = join(dir, "creds.db");
      const db = openCredentialDb(dbPath, { create: true })!;
      const oauth = (provider: string, access: string, email: string) =>
        upsertCredential(db, provider, {
          type: "oauth",
          access,
          refresh: `r-${access}`,
          expires: Date.now() + HOUR,
          email,
        } as never).row;
      const claudeA = oauth("anthropic", "claude-tok-a", "a@example.com");
      const claudeB = oauth("anthropic", "claude-tok-b", "b@example.com");
      const codex = oauth("openai-codex", codexAccessTokenFixture(), "fixture@example.com");
      const disabled = oauth("anthropic", "claude-tok-disabled", "d@example.com");
      disableCredential(db, disabled.id, "logged_out");
      oauth("google-antigravity", "gcp-tok", "g@example.com");
      upsertCredential(db, "anthropic", { type: "api_key", key: "sk-DO-NOT-PRINT" });
      db.close();

      const env = { ...process.env, LYKOS_CREDENTIALS_DB: dbPath, LYKOS_TEST_FETCH_REDIRECT: origin };
      const res = await runCli(["--import", preload, cliPath, "usage", "--refresh"], env);
      assert.equal(res.status, 0, `stderr: ${res.stderr}`);
      assert.deepEqual(
        hits.map((h) => `${h.path} ${h.bearer}`).sort(),
        [
          "/api/oauth/usage claude-tok-a",
          "/api/oauth/usage claude-tok-b",
          `/backend-api/wham/usage ${codexAccessTokenFixture()}`,
        ].sort(),
      );
      assert.equal(hits.find((h) => h.path === "/backend-api/wham/usage")!.account, "acct-fixture");

      const check = openCredentialDb(dbPath, { create: false })!;
      try {
        assert.ok(readCachedReport(check, claudeA.id));
        assert.ok(readCachedReport(check, claudeB.id));
        assert.equal(readCachedReport(check, codex.id)!.report.plan, "pro");
        assert.equal(readCachedReport(check, disabled.id), undefined);
      } finally {
        check.close();
      }
      assert.match(res.stdout, /5h 16% resets/);
      assert.match(res.stdout, /spark:7d 61% resets 2033-/);
      assert.match(res.stdout, /\(fetched 0m ago\)/);
      assert.equal(res.stdout.includes("DO-NOT-PRINT"), false);
      assert.equal(res.stdout.includes("claude-tok-a"), false);

      // Without --refresh the endpoints are never called.
      hits.length = 0;
      const plain = await runCli(["--import", preload, cliPath, "usage"], env);
      assert.equal(plain.status, 0, `stderr: ${plain.stderr}`);
      assert.equal(hits.length, 0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
