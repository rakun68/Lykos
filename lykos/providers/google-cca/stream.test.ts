// P14.2 ticket 04, plan D3 cases 6-10: the fake Cloud Code Assist provider
// (test seam 1, CCA variant).
//
// A `node:http` server on 127.0.0.1:0 answers `v1internal:streamGenerateContent?alt=sse`.
// Every SSE and error body below is written, not recorded. No request leaves 127.0.0.1.
//
// The stream is driven through a real runtime from `createLykosModelRuntime`,
// with a fake OAuth credential stored in a throwaway credential db, so the
// path under test is Pi's own: store -> getApiKey -> streamSimple.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openCredentialDb } from "../../credentials/db.js";
import { upsertCredential } from "../../credentials/pool.js";
import { createLykosModelRuntime } from "../../session/model-runtime.js";
import { googleCcaProviders } from "./register.js";
import { sanitizeToolSchema } from "./stream.js";

// Ticket 08: keep Pi's agent dir (piHostDir) off the real ~/.lykos/pi-host.
process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));

interface Reply {
  status: number;
  body: string;
  contentType?: string;
}

interface Seen {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const dirs: string[] = [];
// Belt and braces: any runtime built without an explicit db path reads a tmp file that never exists.
const absentDir = mkdtempSync(join(tmpdir(), "lykos-cca-absent-"));
dirs.push(absentDir);
process.env.LYKOS_CREDENTIALS_DB = join(absentDir, "absent.db");
let server: Server;
let baseUrl = "";
const replies: Reply[] = [];
const seen: Seen[] = [];

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({ url: req.url ?? "", headers: req.headers, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} });
      const reply = replies.shift() ?? { status: 500, body: "no scripted reply" };
      res.writeHead(reply.status, { "Content-Type": reply.contentType ?? "text/event-stream" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function sse(...chunks: unknown[]): string {
  return chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join("");
}

/** A runtime whose credential db holds one Google OAuth credential and whose CCA base URL is the fake. */
async function runtimeFor(provider: "google-antigravity" | "google-gemini-cli") {
  const dir = mkdtempSync(join(tmpdir(), "lykos-cca-stream-"));
  dirs.push(dir);
  const credentialDbPath = join(dir, "credentials.db");
  const db = openCredentialDb(credentialDbPath, { create: true })!;
  try {
    upsertCredential(db, provider, {
      type: "oauth",
      access: "ya29.fake-access-token",
      refresh: "1//fake-refresh-token",
      expires: Date.now() + 3_600_000,
      email: "alice@example.com",
      projectId: "proj-123",
    });
  } finally {
    db.close();
  }
  return createLykosModelRuntime({ credentialDbPath, providers: googleCcaProviders({ baseUrl }) });
}

async function drive(provider: "google-antigravity" | "google-gemini-cli", modelId: string, context?: Parameters<Awaited<ReturnType<typeof runtimeFor>>["streamSimple"]>[1]) {
  const runtime = await runtimeFor(provider);
  const model = runtime.getModel(provider, modelId);
  assert.ok(model, `${provider}/${modelId} is registered`);
  const stream = runtime.streamSimple(
    model,
    context ?? { systemPrompt: "Be brief.", messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }] },
  );
  const events: Array<{ type: string } & Record<string, unknown>> = [];
  for await (const e of stream) events.push(e as { type: string } & Record<string, unknown>);
  return { events, message: await stream.result() };
}

describe("Cloud Code Assist stream against a fake provider (plan D3, cases 6-10)", () => {
  for (const [provider, modelId] of [
    ["google-antigravity", "gemini-3-pro"],
    ["google-gemini-cli", "gemini-2.5-flash"],
  ] as const) {
    it(`6. ${provider}: a plain text reply streams in order, with the final text and mapped usage`, async () => {
      replies.push({
        status: 200,
        body: sse(
          {
            response: {
              candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] } }],
              responseId: "resp-1",
              modelVersion: "gemini-wire",
            },
            traceId: "trace-1",
          },
          {
            response: {
              candidates: [{ content: { role: "model", parts: [{ text: ", world" }] }, finishReason: "STOP" }],
              usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 5, totalTokenCount: 17, cachedContentTokenCount: 2 },
            },
          },
        ),
      });
      const { events, message } = await drive(provider, modelId);
      assert.deepEqual(
        events.map((e) => e.type),
        ["start", "text_start", "text_delta", "text_delta", "text_end", "done"],
      );
      assert.equal(message.stopReason, "stop");
      assert.deepEqual(message.content, [{ type: "text", text: "Hello, world" }]);
      assert.equal(message.usage.input, 10);
      assert.equal(message.usage.output, 5);
      assert.equal(message.usage.cacheRead, 2);
      assert.equal(message.usage.totalTokens, 17);
      assert.equal(message.usage.cost.total, 0, "unpriced (rule 5)");
      assert.equal(message.responseId, "resp-1");
      assert.equal(message.provider, provider);
    });
  }

  it("7. thought parts become thinking events, keep their signature, and count as reasoning", async () => {
    replies.push({
      status: 200,
      body: sse(
        { response: { candidates: [{ content: { role: "model", parts: [{ thought: true, text: "Let me think.", thoughtSignature: "c2lnbmF0dXJl" }] } }] } },
        {
          response: {
            candidates: [{ content: { role: "model", parts: [{ text: "Four." }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 7, totalTokenCount: 17 },
          },
        },
      ),
    });
    const { events, message } = await drive("google-antigravity", "gemini-3-pro");
    assert.deepEqual(
      events.map((e) => e.type),
      ["start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_end", "done"],
    );
    assert.deepEqual(message.content[0], { type: "thinking", thinking: "Let me think.", thinkingSignature: "c2lnbmF0dXJl" });
    assert.deepEqual(message.content[1], { type: "text", text: "Four." });
    assert.equal(message.usage.output, 9, "candidates + thoughts");
    assert.equal(message.usage.reasoning, 7);
  });

  it("8. a function call becomes a tool call with parsed arguments and stop reason toolUse", async () => {
    replies.push({
      status: 200,
      body: sse({
        response: {
          candidates: [
            {
              content: { role: "model", parts: [{ functionCall: { name: "read", args: { path: "a.txt", limit: 3 } } }] },
              finishReason: "STOP",
            },
          ],
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 4, totalTokenCount: 24 },
        },
      }),
    });
    const { events, message } = await drive("google-antigravity", "claude-sonnet-4-6", {
      messages: [{ role: "user", content: "Read a.txt", timestamp: Date.now() }],
      tools: [
        {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string", minLength: 1 }, limit: { type: ["integer", "null"] } },
            required: ["path"],
            additionalProperties: false,
          } as never,
        },
      ],
    });
    assert.deepEqual(
      events.map((e) => e.type),
      ["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"],
    );
    assert.equal(message.stopReason, "toolUse");
    const call = message.content[0];
    assert.equal(call?.type, "toolCall");
    assert.ok(call?.type === "toolCall");
    assert.equal(call.name, "read");
    assert.deepEqual(call.arguments, { path: "a.txt", limit: 3 });
    assert.ok(call.id.startsWith("read_"), "a call without an id gets one");

    const body = seen.at(-1)!.body as { request: { tools: Array<{ functionDeclarations: Array<Record<string, unknown>> }>; toolConfig: unknown } };
    const decl = body.request.tools[0]!.functionDeclarations[0]!;
    assert.deepEqual(decl.parameters, {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"],
    });
    assert.deepEqual(body.request.toolConfig, { functionCallingConfig: { mode: "VALIDATED" } });
  });

  for (const [status, bodyText] of [
    [
      429,
      JSON.stringify({
        error: {
          code: 429,
          message: "You have exhausted your capacity on this model. Your quota will reset after 3h12m5s.",
          status: "RESOURCE_EXHAUSTED",
          details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "QUOTA_EXHAUSTED" }],
        },
      }),
    ],
    [401, JSON.stringify({ error: { code: 401, message: "Request had invalid authentication credentials.", status: "UNAUTHENTICATED" } })],
  ] as const) {
    it(`9. HTTP ${status} produces an error event carrying the status and body, before any output`, async () => {
      replies.push({ status, body: bodyText, contentType: "application/json" });
      const { events, message } = await drive("google-antigravity", "gemini-3-pro");
      assert.deepEqual(events.map((e) => e.type), ["error"], "no start event precedes the error");
      assert.equal(message.stopReason, "error");
      assert.ok(message.errorMessage?.includes(`${status} ${bodyText}`), message.errorMessage);
      if (status === 429) assert.match(message.errorMessage!, /RESOURCE_EXHAUSTED/);
    });
  }

  it("an in-band stream error surfaces its code and status", async () => {
    replies.push({
      status: 200,
      body: sse({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (e.g. check quota)." } }),
    });
    const { message } = await drive("google-gemini-cli", "gemini-2.5-flash");
    assert.equal(message.stopReason, "error");
    assert.match(message.errorMessage!, /429 RESOURCE_EXHAUSTED/);
  });

  it("10. the request carried the Bearer token, the stored projectId and the Antigravity envelope", async () => {
    replies.push({
      status: 200,
      body: sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } }),
    });
    const { message } = await drive("google-antigravity", "gemini-3-pro");
    assert.equal(message.stopReason, "stop");
    const req = seen.at(-1)!;
    assert.equal(req.url, "/v1internal:streamGenerateContent?alt=sse");
    assert.equal(req.headers.authorization, "Bearer ya29.fake-access-token");
    assert.match(String(req.headers["user-agent"]), /^antigravity\/hub\//);
    const body = req.body as { project: string; model: string; userAgent: string; requestType: string; request: Record<string, unknown> };
    assert.equal(body.project, "proj-123");
    assert.equal(body.model, "gemini-3-pro-low", "thinking off routes to the low wire id");
    assert.equal(body.userAgent, "antigravity");
    assert.equal(body.requestType, "agent");
    assert.deepEqual(body.request.systemInstruction, { role: "user", parts: [{ text: "Be brief." }] });
    assert.deepEqual(body.request.contents, [{ role: "user", parts: [{ text: "Say hello" }] }]);

    replies.push({
      status: 200,
      body: sse({ response: { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] } }),
    });
    await drive("google-gemini-cli", "gemini-2.5-flash");
    const cli = seen.at(-1)!;
    assert.equal(cli.headers.authorization, "Bearer ya29.fake-access-token");
    assert.match(String(cli.headers["user-agent"]), /^GeminiCLI\//);
    assert.equal((cli.body as { project: string }).project, "proj-123");
    assert.equal((cli.body as { requestType?: string }).requestType, undefined, "no Antigravity envelope");
  });
});

describe("sanitizeToolSchema", () => {
  it("turns a union of literals into an enum and drops unsupported keywords", () => {
    assert.deepEqual(
      sanitizeToolSchema({
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: {
          mode: { anyOf: [{ const: "a", type: "string" }, { const: "b", type: "string" }], description: "m" },
          n: { type: "number", minimum: 0, format: "double" },
        },
        required: ["mode", "gone"],
      }),
      {
        type: "object",
        properties: { mode: { description: "m", type: "string", enum: ["a", "b"] }, n: { type: "number" } },
        required: ["mode"],
      },
    );
  });
});
