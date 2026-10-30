// The `devin-agent` stream against a local HTTP/1.1 Connect server.
//
// Every server frame is built from the schemas in `./proto.ts`. Nothing was recorded against a live account
// by Lykos. No test reaches the network.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { classifyFailure } from "../../credentials/classify.js";
import type { AssistantMessage, AssistantMessageEvent, PiContext, PiModel, PiTool, ToolCall } from "../google-cca/types.js";
import { create, toBinary } from "../protobuf/codec.js";
import {
  chatFrame,
  decodeAssignRequest,
  decodeChatRequest,
  decodeUserJwtRequest,
  endStreamFrame,
  type FakeDevinHandler,
  type FakeDevinServer,
  simpleDevinHandler,
  startFakeDevinServer,
} from "./fake-devin-server.js";
import {
  AssignModelResponseSchema,
  ChatMessageRequestType,
  ChatMessageSource,
  ChatToolCallSchema,
  ConversationalPlannerMode,
  ModelAssignmentSchema,
  ModelUsageStatsSchema,
  StopReason,
} from "./proto.js";
import {
  CHAT_MESSAGE_PATH,
  createDevinStreamSimple,
  DEVIN_ASSIGN_MODEL_PATH,
  DEVIN_AUTH_PATH,
  DEVIN_DEFAULT_STOP_PATTERNS,
  devinCliMetadata,
  parseStreamingJson,
} from "./stream.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-devin-stream-")), "absent.db");

function model(baseUrl: string, id = "swe-1-6"): PiModel {
  return {
    id,
    name: id,
    api: "devin-agent",
    provider: "devin",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 128_000,
  } as PiModel;
}

const TOOL: PiTool = {
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
};

const hi = (text = "hi", extra: Partial<PiContext> = {}): PiContext => ({
  messages: [{ role: "user", content: text, timestamp: 1 }],
  ...extra,
});

async function collect(stream: unknown) {
  const s = stream as AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> };
  const events: AssistantMessageEvent[] = [];
  for await (const e of s) events.push(e);
  return { events, result: await s.result() };
}

let server: FakeDevinServer | undefined;
async function serve(handler: FakeDevinHandler): Promise<FakeDevinServer> {
  server = await startFakeDevinServer(handler);
  return server;
}
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const streamSimple = createDevinStreamSimple();

describe("devin-agent stream (D3, D6.2)", () => {
  it("streams a text turn with thinking and usage, sending Devin's paths, headers and metadata", async () => {
    // Written from the wire format; not recorded against a live account.
    const fake = await serve(
      simpleDevinHandler([
        chatFrame({ messageId: "msg-1", deltaThinking: "hmm", deltaSignature: "sig-1" }),
        chatFrame({ deltaText: "Hello, " }),
        chatFrame({ deltaText: "world" }),
        chatFrame({
          stopReason: StopReason.STOP_PATTERN,
          usage: create(ModelUsageStatsSchema, { inputTokens: 11n, outputTokens: 7n, cacheReadTokens: 100n, cacheWriteTokens: 13n }),
        }),
        endStreamFrame(),
      ]),
    );

    const { events, result } = await collect(
      streamSimple(model(fake.baseUrl), hi("Say hello", { systemPrompt: "Be brief.", tools: [TOOL] }), {
        apiKey: "devin-token",
        sessionId: "cascade-1",
      }),
    );

    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(events[0]!.type, "start");
    assert.equal(events.at(-1)!.type, "done");
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta).join("");
    assert.equal(text, "Hello, world");
    assert.deepEqual(result.content, [
      { type: "thinking", thinking: "hmm", thinkingSignature: "sig-1" },
      { type: "text", text: "Hello, world" },
    ]);
    assert.equal(result.responseId, "msg-1");
    assert.deepEqual(
      { ...result.usage, cost: undefined },
      { input: 11, output: 7, cacheRead: 100, cacheWrite: 13, totalTokens: 131, cost: undefined },
    );
    assert.deepEqual(result.usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, "zero cost (rule 5)");

    assert.deepEqual(
      fake.requests.map((r) => r.path),
      [DEVIN_AUTH_PATH, CHAT_MESSAGE_PATH],
    );
    const [auth, chat] = fake.requests;
    assert.equal(auth!.headers["content-type"], "application/proto");
    assert.equal(auth!.headers["connect-protocol-version"], "1");
    const authMetadata = decodeUserJwtRequest(auth!.body).metadata!;
    for (const [key, value] of Object.entries(devinCliMetadata("devin-token"))) {
      assert.equal(authMetadata[key as keyof typeof authMetadata], value, key);
    }
    assert.equal(authMetadata.apiKey, "devin-session-token$devin-token");
    assert.equal(authMetadata.userJwt, "");

    assert.equal(chat!.headers["content-type"], "application/connect+proto");
    assert.equal(chat!.headers["connect-content-encoding"], "gzip");
    assert.equal(chat!.headers["connect-accept-encoding"], "gzip");
    assert.equal(chat!.headers["user-agent"], "connect-go/1.18.1 (go1.26.3)");
    assert.equal(chat!.body[0], 0x01, "the request frame is gzipped");
    const request = decodeChatRequest(chat!.body);
    assert.equal(request.metadata?.ideName, "devin-cli");
    assert.equal(request.metadata?.ideType, "chisel");
    assert.equal(request.metadata?.ideVersion, "3000.6.2");
    assert.equal(request.metadata?.extensionName, "chisel");
    assert.equal(request.metadata?.extensionVersion, "3000.6.2");
    assert.equal(request.metadata?.userJwt, "user-jwt");
    assert.equal(request.prompt, "Be brief.");
    assert.equal(request.chatModelUid, "swe-1-6");
    assert.equal(request.cascadeId, "cascade-1");
    assert.equal(request.requestType, ChatMessageRequestType.CASCADE);
    assert.equal(request.plannerMode, ConversationalPlannerMode.DEFAULT);
    assert.equal(request.disableParallelToolCalls, false, "swe-1-6 supports parallel tool calls");
    assert.equal(request.modelAssignmentJwt, undefined);
    assert.deepEqual(request.configuration?.stopPatterns, DEVIN_DEFAULT_STOP_PATTERNS);
    assert.equal(request.configuration?.maxTokens, 128_000n);
    assert.equal(request.chatMessagePrompts.length, 1);
    assert.equal(request.chatMessagePrompts[0]!.source, ChatMessageSource.USER);
    assert.equal(request.chatMessagePrompts[0]!.prompt, "Say hello");
    assert.equal(request.tools[0]!.name, "read_file");
    assert.deepEqual(JSON.parse(request.tools[0]!.jsonSchemaString), TOOL.parameters);
  });

  it("assembles a tool call whose arguments are split across frames, and ends with toolUse", async () => {
    // Written from the wire format; not recorded against a live account.
    const delta = (argumentsJson: string, stopReason = StopReason.UNSPECIFIED) =>
      chatFrame({
        messageId: "msg-1",
        stopReason,
        deltaToolCalls: [create(ChatToolCallSchema, { id: "call-1", name: "task", argumentsJson })],
      });
    const fake = await serve(
      simpleDevinHandler([
        delta(`{"agent":"task","note":"initial"`),
        delta(`{"agent":"task","note":"initial","step":1`),
        delta(`{"agent":"task","note":"initial","step":12`, StopReason.FUNCTION_CALL),
      ]),
    );
    const s = streamSimple(model(fake.baseUrl), hi("call tool"), { apiKey: "t" }) as unknown as AsyncIterable<AssistantMessageEvent> & {
      result(): Promise<AssistantMessage>;
    };
    const snapshots: unknown[] = [];
    const deltas: string[] = [];
    for await (const event of s) {
      if (event.type === "toolcall_delta") {
        deltas.push(event.delta);
        snapshots.push((event.partial.content.find((b) => b.type === "toolCall") as ToolCall | undefined)?.arguments);
      }
    }
    const result = await s.result();
    assert.equal(result.stopReason, "toolUse", result.errorMessage);
    assert.deepEqual(snapshots[0], { agent: "task", note: "initial" }, "partial JSON is tolerated mid-stream");
    assert.equal(snapshots[1], snapshots[0], "small growth is not re-parsed");
    assert.equal(snapshots[2], snapshots[0]);
    assert.equal(deltas.join(""), `{"agent":"task","note":"initial","step":12`);
    assert.deepEqual(result.content, [{ type: "toolCall", id: "call-1", name: "task", arguments: { agent: "task", note: "initial", step: 12 } }]);
  });

  it("reads gzip frames and a gzip end-stream trailer", async () => {
    const fake = await serve(simpleDevinHandler([chatFrame({ deltaText: "zipped" }, true), chatFrame({ deltaText: " text" }, true), endStreamFrame()]));
    const { result } = await collect(streamSimple(model(fake.baseUrl), hi(), { apiKey: "t" }));
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.content, [{ type: "text", text: "zipped text" }]);
  });

  it("maps MAX_TOKENS to length", async () => {
    const fake = await serve(simpleDevinHandler([chatFrame({ deltaText: "cut", stopReason: StopReason.MAX_TOKENS })]));
    const { result } = await collect(streamSimple(model(fake.baseUrl), hi(), { apiKey: "t" }));
    assert.equal(result.stopReason, "length");
  });

  it("turns an end-stream error trailer into an error event carrying the server's text and details", async () => {
    // Written from the wire format; not recorded against a live account.
    const fake = await serve(
      simpleDevinHandler([
        chatFrame({ deltaText: "partial" }),
        endStreamFrame({
          code: "invalid_argument",
          message: "Error",
          details: [{ type: "google.rpc.DebugInfo", debug: { detail: "field X rejected" } }],
        }),
      ]),
    );
    const { events, result } = await collect(streamSimple(model(fake.baseUrl), hi(), { apiKey: "t" }));
    assert.equal(events.at(-1)!.type, "error");
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage!, /^Devin stream error invalid_argument: Error \[details: google\.rpc\.DebugInfo: /);
    assert.match(result.errorMessage!, /field X rejected/);
    assert.deepEqual(result.content, [{ type: "text", text: "partial" }]);
    assert.equal(classifyFailure({ message: result.errorMessage!, provider: "devin" }).kind, "none", "not a credential failure");
  });

  it("a 401 on GetUserJwt fails the turn with an error that classifies as auth", async () => {
    const fake = await serve((req, res) => {
      if (req.path === DEVIN_AUTH_PATH) res.writeHead(401, { "content-type": "text/plain" }).end("unauthenticated: invalid session token");
    });
    const { events, result } = await collect(streamSimple(model(fake.baseUrl), hi(), { apiKey: "stale-token" }));
    assert.deepEqual(events.map((e) => e.type), ["error"]);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage!, /^Devin auth error: 401 Unauthorized: unauthenticated/);
    assert.doesNotMatch(result.errorMessage!, /stale-token/);
    assert.equal(classifyFailure({ message: result.errorMessage!, provider: "devin" }).kind, "auth_401");
    assert.deepEqual(fake.requests.map((r) => r.path), [DEVIN_AUTH_PATH], "no chat request after a failed auth");
  });

  it("a non-200 chat response names the status", async () => {
    const fake = await serve(async (req, res) => {
      if (req.path === DEVIN_AUTH_PATH) return void simpleDevinHandler([])(req, res);
      if (req.path === CHAT_MESSAGE_PATH) res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
    });
    const { result } = await collect(streamSimple(model(fake.baseUrl), hi(), { apiKey: "t" }));
    assert.equal(result.errorMessage, "Devin API error: 403 Forbidden: forbidden");
    assert.equal(classifyFailure({ message: result.errorMessage!, provider: "devin" }).kind, "forbidden");
  });

  it("rejects a frame advertising more than 16 MiB without buffering it", async () => {
    // Written from the wire format; not recorded against a live account.
    const header = Buffer.alloc(5);
    header.writeUInt32BE(32 * 1024 * 1024, 1);
    let written = 0;
    const fake = await serve(async (req, res) => {
      if (req.path === DEVIN_AUTH_PATH) return void simpleDevinHandler([])(req, res);
      if (req.path !== CHAT_MESSAGE_PATH) return;
      res.writeHead(200, { "content-type": "application/connect+proto" });
      res.write(header);
      const filler = Buffer.alloc(1024 * 1024);
      written += filler.length;
      res.write(filler);
      res.end();
    });
    const { result } = await collect(streamSimple(model(fake.baseUrl), hi(), { apiKey: "t" }));
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, `Devin Connect frame length ${32 * 1024 * 1024} exceeds 16777216-byte cap`);
    assert.ok(written < 2 * 1024 * 1024);
  });

  it("reports a large-history opaque invalid_argument as a context overflow, and a small one plainly", async () => {
    // Written from the wire format; not recorded against a live account.
    const trailer = endStreamFrame({ code: "invalid_argument", message: "an internal error occurred (trace ID: large-request)" });
    const largeRead: PiContext = {
      messages: Array.from({ length: 4 }, (_, index) => ({
        role: "toolResult" as const,
        toolCallId: `read-${index}`,
        toolName: "read",
        content: [{ type: "text" as const, text: String(index).repeat(160 * 1024) }],
        isError: false,
        timestamp: index + 1,
      })),
    };
    const fake = await serve(simpleDevinHandler([trailer]));
    const large = await collect(streamSimple(model(fake.baseUrl), largeRead, { apiKey: "t" }));
    assert.equal(large.result.stopReason, "error");
    assert.match(large.result.errorMessage!, /trace ID: large-request/);
    assert.match(large.result.errorMessage!, /context_length_exceeded: \d+-byte history/);

    const small = await collect(streamSimple(model(fake.baseUrl), hi(), { apiKey: "t" }));
    assert.equal(small.result.errorMessage, "Devin stream error invalid_argument: an internal error occurred (trace ID: large-request)");

    const hugeActive = await collect(streamSimple(model(fake.baseUrl), hi("u".repeat(520 * 1024)), { apiKey: "t" }));
    assert.doesNotMatch(hugeActive.result.errorMessage!, /context_length_exceeded/, "the active prompt is not compactable history");
  });

  it("assigns a router model before chat and forwards the assignment", async () => {
    // Written from the wire format; not recorded against a live account.
    const fake = await serve(
      simpleDevinHandler([chatFrame({ messageId: "msg-1", stopReason: StopReason.STOP_PATTERN, actualModelUid: "gpt-5-codex" })], {
        extra: (req, res) => {
          if (req.path !== DEVIN_ASSIGN_MODEL_PATH) return;
          const body = create(AssignModelResponseSchema, {
            assignment: create(ModelAssignmentSchema, { assignmentJwt: "assign-jwt", modelUid: "claude-sonnet-4-5" }),
          });
          res.writeHead(200, { "content-type": "application/proto" }).end(Buffer.from(toBinary(AssignModelResponseSchema, body)));
        },
      }),
    );
    const routed = createDevinStreamSimple({ compat: () => ({ modelRouter: true }) });
    const { result } = await collect(routed(model(fake.baseUrl, "adaptive"), hi("route me"), { apiKey: "token", sessionId: "cascade-42" }));
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(fake.requests.map((r) => r.path), [DEVIN_AUTH_PATH, DEVIN_ASSIGN_MODEL_PATH, CHAT_MESSAGE_PATH]);
    const assign = decodeAssignRequest(fake.requests[1]!.body);
    assert.equal(assign.modelRouterUid, "adaptive");
    assert.equal(assign.cascadeId, "cascade-42");
    assert.equal(assign.chatMessagePrompt?.messageId, "");
    assert.equal(assign.chatMessagePrompt?.prompt, "route me");
    assert.equal(assign.metadata?.userJwt, "");
    const chat = decodeChatRequest(fake.requests[2]!.body);
    assert.equal(chat.chatModelUid, "claude-sonnet-4-5");
    assert.equal(chat.modelAssignmentJwt, "assign-jwt");
    assert.equal(chat.disableParallelToolCalls, true);
    assert.equal(result.responseModel, "gpt-5-codex");
  });

  it("replays history on the USER / SYSTEM / TOOL channels", async () => {
    const fake = await serve(simpleDevinHandler([chatFrame({ deltaText: "ok" })]));
    const context: PiContext = {
      messages: [
        { role: "user", content: "read it", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "text", text: "reading" },
            { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } },
          ],
          api: "devin-agent",
          provider: "devin",
          model: "swe-1-6",
          responseId: "srv-msg-1",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "call-1", toolName: "read_file", content: [{ type: "text", text: "contents" }], isError: false, timestamp: 3 },
      ],
    };
    const { result } = await collect(streamSimple(model(fake.baseUrl), context, { apiKey: "t", sessionId: "c" }));
    assert.equal(result.stopReason, "stop", result.errorMessage);
    const prompts = decodeChatRequest(fake.requests[1]!.body).chatMessagePrompts;
    assert.deepEqual(prompts.map((p) => p.source), [ChatMessageSource.USER, ChatMessageSource.SYSTEM, ChatMessageSource.TOOL]);
    assert.equal(prompts[1]!.messageId, "srv-msg-1");
    assert.equal(prompts[1]!.toolCalls[0]!.argumentsJson, `{"path":"a.txt"}`);
    assert.equal(prompts[2]!.toolCallId, "call-1");
    assert.equal(prompts[2]!.prompt, "contents");
  });
});

describe("parseStreamingJson", () => {
  it("parses whole JSON, closes a truncated prefix, and falls back to {}", () => {
    assert.deepEqual(parseStreamingJson(`{"a":1}`), { a: 1 });
    assert.deepEqual(parseStreamingJson(`{"a":"x`), { a: "x" });
    assert.deepEqual(parseStreamingJson(`{"a":[1,2`), { a: [1, 2] });
    assert.deepEqual(parseStreamingJson(`{"a":1,"b`), { a: 1 });
    assert.deepEqual(parseStreamingJson(`{"a":1,`), { a: 1 });
    assert.deepEqual(parseStreamingJson(`{"a":`), {});
    assert.deepEqual(parseStreamingJson(""), {});
    assert.deepEqual(parseStreamingJson("not json"), {});
  });
});
