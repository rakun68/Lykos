// T181 end to end: `lykos mcp` as a real process, spoken to over stdio by the
// SDK's own client, each call a real `lykos session-child` running a real
// delegated session against a fake model server.
//
// What this proves that the unit seams cannot: nothing but JSON-RPC reaches
// the transport's stdout (the SDK client would fail to parse a stray line and
// report it through `onerror`), progress arrives as MCP notifications, and two
// calls made at once are two sessions.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { openCredentialDb } from "../credentials/db.js";
import { startFakeAnthropicServer, type FakeAnthropicServer } from "../credentials/fake-anthropic-server.js";
import { upsertCredential } from "../credentials/pool.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROVIDER = "fakeprov";

let server: FakeAnthropicServer;
before(async () => {
  server = await startFakeAnthropicServer();
});
after(async () => {
  await server.close();
});

describe("`lykos mcp` serves calls through child processes (T181)", () => {
  it("keeps stdout to the transport, streams progress, and runs two concurrent calls as two sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-mcp-e2e-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(join(home, ".lykos"), { recursive: true });
    mkdirSync(join(workspace, ".lykos"), { recursive: true });
    writeFileSync(
      join(workspace, ".lykos", "config.yaml"),
      ["providers:", `  ${PROVIDER}:`, "    auth: api_key", `    baseUrl: ${server.baseUrl}`, "    api: anthropic-messages", "    models:", "      - id: m1", "containment:", "  level: off", ""].join("\n"),
    );
    const dbPath = join(root, "credentials.db");
    const db = openCredentialDb(dbPath, { create: true })!;
    try {
      upsertCredential(db, PROVIDER, { type: "api_key", key: "pooled-key" });
    } finally {
      db.close();
    }
    server.reset();
    server.script.set("pooled-key", [{ kind: "ok", text: "pong" }]);

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, {
      HOME: home,
      USERPROFILE: home,
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      LYKOS_CREDENTIALS_DB: dbPath,
      LYKOS_TRUST_WORKSPACE: "1",
      LYKOS_SESSION_PROGRESS_MS: "100",
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", import.meta.resolve("tsx"), join(repoRoot, "lykos", "cli.ts"), "mcp"],
      cwd: workspace,
      env,
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr?.on("data", (c: Buffer) => (stderr += c.toString()));
    const client = new Client({ name: "e2e", version: "0.0.1" });
    const transportErrors: string[] = [];
    client.onerror = (e) => transportErrors.push(e.message);
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.length >= 4);
      for (const name of ["lykos_implement", "lykos_refactor", "lykos_debug", "lykos_review"]) {
        assert.ok(tools.some((t) => t.name === name), `${name} is present`);
      }

      const progress: Array<{ progress: number; message?: string | undefined }> = [];
      const args = { brief: "Reply with the word pong.", model: `${PROVIDER}/m1`, containment: "off" };
      const [a, b] = await Promise.all([
        client.callTool({ name: "lykos_review", arguments: args }, undefined, { onprogress: (p) => progress.push({ progress: p.progress, message: p.message }) }),
        client.callTool({ name: "lykos_review", arguments: args }),
      ]);
      const [ra, rb] = [a, b].map((r) => {
        assert.notEqual(r.isError, true, JSON.stringify(r.content) + stderr);
        return JSON.parse((r.content as Array<{ text: string }>)[0]!.text) as { outcome: string; answer: string; sessionId: string; containment?: string };
      }) as [{ outcome: string; answer: string; sessionId: string; containment?: string }, { outcome: string; answer: string; sessionId: string; containment?: string }];
      // T220: no verification command ran, so the result says unverified, never ok.
      assert.equal(ra.outcome, "unverified");
      assert.match(ra.answer, /pong/);
      assert.equal(ra.containment, "off");
      assert.notEqual(ra.sessionId, rb.sessionId, "two calls, two sessions");
      assert.ok(progress.length >= 2, `progress notifications arrived: ${progress.length}`);
      assert.deepEqual(
        progress.map((p) => p.progress),
        progress.map((_, i) => i + 1),
        "progress counts up from 1",
      );
      assert.equal(progress[0]!.message, "session starting");
      assert.deepEqual(transportErrors, [], "nothing but JSON-RPC reached the transport's stdout");
    } finally {
      await client.close();
    }
  });
});
