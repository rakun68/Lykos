// P14 plan D5 / D7.6: all-refused message and usage limit exhaustion tests.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createLykosModelRuntime } from "../session/model-runtime.js";
import { openCredentialDb } from "./db.js";
import { anthropicError, type FakeAnthropicServer, startFakeAnthropicServer } from "./fake-anthropic-server.js";
import { upsertCredential } from "./pool.js";

describe("all-refused message and exhaustion (D5 / D7.6)", () => {
  let server: FakeAnthropicServer;
  const dirs: string[] = [];

  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), "lykos-all-refused-"));
    dirs.push(d);
    return d;
  }

  before(async () => {
    server = await startFakeAnthropicServer();
  });

  after(async () => {
    await server.close();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  beforeEach(() => {
    server.reset();
  });

  it("two api_key rows both getting 401 produce D5 message naming both labels", async () => {
    const dir = tmp();
    const dbPath = join(dir, "credentials.db");
    const modelsPath = join(dir, "models.json");

    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          anthropic: {
            baseUrl: server.baseUrl,
            api: "anthropic-messages",
            models: [{ id: "m1" }],
          },
        },
      }),
    );

    const db = openCredentialDb(dbPath, { create: true })!;
    const row1 = upsertCredential(db, "anthropic", { type: "api_key", key: "key-1" });
    const row2 = upsertCredential(db, "anthropic", { type: "api_key", key: "key-2" });
    db.close();

    server.script.set("key-1", [
      { kind: "status", status: 401, body: anthropicError("authentication_error", "invalid api key 1") },
    ]);
    server.script.set("key-2", [
      { kind: "status", status: 401, body: anthropicError("authentication_error", "invalid api key 2") },
    ]);

    const runtime = await createLykosModelRuntime({
      modelsPath,
      credentialDbPath: dbPath,
    });

    const model = runtime.getModel("anthropic", "m1")!;
    const stream = runtime.streamSimple(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as never,
    );
    const result = await stream.result();

    assert.equal(result.stopReason, "error");
    const firstKey = server.seen[0]!;
    const secondKey = server.seen[1]!;
    const firstRow = firstKey === "key-1" ? row1 : row2;
    const secondRow = firstKey === "key-1" ? row2 : row1;
    const expected = `lykos: authentication failure for provider "anthropic" — credentials ${firstRow.row.label}, ${secondRow.row.label} were present and refused (first error: 401 ${anthropicError("authentication_error", firstKey === "key-1" ? "invalid api key 1" : "invalid api key 2")})`;
    assert.equal(result.errorMessage, expected);
  });

  it("single api_key row getting 401 produces singular credential label form", async () => {
    const dir = tmp();
    const dbPath = join(dir, "credentials.db");
    const modelsPath = join(dir, "models.json");

    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          anthropic: {
            baseUrl: server.baseUrl,
            api: "anthropic-messages",
            models: [{ id: "m1" }],
          },
        },
      }),
    );

    const db = openCredentialDb(dbPath, { create: true })!;
    const row1 = upsertCredential(db, "anthropic", { type: "api_key", key: "key-single" });
    db.close();

    server.script.set("key-single", [
      { kind: "status", status: 401, body: anthropicError("authentication_error", "invalid single key") },
    ]);

    const runtime = await createLykosModelRuntime({
      modelsPath,
      credentialDbPath: dbPath,
    });

    const model = runtime.getModel("anthropic", "m1")!;
    const stream = runtime.streamSimple(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as never,
    );
    const result = await stream.result();

    assert.equal(result.stopReason, "error");
    const expected = `lykos: authentication failure for provider "anthropic" — credential ${row1.row.label} was present and refused (first error: 401 ${anthropicError("authentication_error", "invalid single key")})`;
    assert.equal(result.errorMessage, expected);
  });

  it("pool exhausted by usage limits reports the first error unchanged", async () => {
    const dir = tmp();
    const dbPath = join(dir, "credentials.db");
    const modelsPath = join(dir, "models.json");

    writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          anthropic: {
            baseUrl: server.baseUrl,
            api: "anthropic-messages",
            models: [{ id: "m1" }],
          },
        },
      }),
    );

    const db = openCredentialDb(dbPath, { create: true })!;
    upsertCredential(db, "anthropic", { type: "api_key", key: "key-limit-1" });
    upsertCredential(db, "anthropic", { type: "api_key", key: "key-limit-2" });
    db.close();

    server.script.set("key-limit-1", [
      { kind: "status", status: 429, body: anthropicError("rate_limit_error", "rate limit on key 1") },
    ]);
    server.script.set("key-limit-2", [
      { kind: "status", status: 429, body: anthropicError("rate_limit_error", "rate limit on key 2") },
    ]);

    const runtime = await createLykosModelRuntime({
      modelsPath,
      credentialDbPath: dbPath,
    });

    const model = runtime.getModel("anthropic", "m1")!;
    const stream = runtime.streamSimple(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] } as never,
    );
    const result = await stream.result();

    assert.equal(result.stopReason, "error");
    // Reports first error unchanged
    const firstKey = server.seen[0]!;
    const expectedError = `429 ${anthropicError("rate_limit_error", firstKey === "key-limit-1" ? "rate limit on key 1" : "rate limit on key 2")}`;
    assert.equal(result.errorMessage, expectedError);
  });
});
