// The `cursor-agent` stream against a local HTTP/2 Connect server.
//
// Every server frame is built from the schemas; not recorded against a live account by Lykos. No test reaches the network.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { classifyFailure } from "../../credentials/classify.js";
import { create, encodeJsonValue } from "../protobuf/codec.js";
import type { AssistantMessage, AssistantMessageEvent, PiContext, PiModel, PiTool } from "../google-cca/types.js";
import { type FakeCursorServer, type FakeRunContext, type FakeRunHandler, startFakeCursorServer } from "./fake-cursor-server.js";
import {
  type AgentClientMessage,
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  GetBlobArgsSchema,
  InteractionQuerySchema,
  InteractionUpdateSchema,
  KvServerMessageSchema,
  McpArgsSchema,
  McpToolCallSchema,
  RequestContextArgsSchema,
  SetBlobArgsSchema,
  ShellArgsSchema,
  TextDeltaUpdateSchema,
  ThinkingDeltaUpdateSchema,
  TokenDeltaUpdateSchema,
  ToolCallCompletedUpdateSchema,
  ToolCallSchema,
  ToolCallStartedUpdateSchema,
  TurnEndedUpdateSchema,
  WebSearchArgsSchema,
  WebSearchRequestQuerySchema,
  type AgentServerMessage,
  type ExecServerMessage,
  type InteractionUpdate,
} from "./proto.js";
import { CURSOR_CLIENT_VERSION, MCP_EXTERNAL_HANDOFF_MESSAGE, createCursorStreamSimple, resetCursorConversationState } from "./stream.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-cursor-stream-")), "absent.db");

// ---------------------------------------------------------------------------
// Server frames (built from the schemas)
// ---------------------------------------------------------------------------

function update(message: InteractionUpdate["message"]): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, { message }) },
  });
}
const textDelta = (text: string) => update({ case: "textDelta", value: create(TextDeltaUpdateSchema, { text }) });
const thinkingDelta = (text: string) => update({ case: "thinkingDelta", value: create(ThinkingDeltaUpdateSchema, { text }) });
const tokenDelta = (tokens: number) => update({ case: "tokenDelta", value: create(TokenDeltaUpdateSchema, { tokens }) });
const turnEnded = () => update({ case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) });

function exec(id: number, message: ExecServerMessage["message"]): AgentServerMessage {
  return create(AgentServerMessageSchema, {
    message: { case: "execServerMessage", value: create(ExecServerMessageSchema, { id, execId: `exec-${id}`, message }) },
  });
}

function mcpArgs(toolCallId: string, name: string, args: Record<string, unknown>) {
  const encoded: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(args)) encoded[k] = encodeJsonValue(v as never);
  return create(McpArgsSchema, { name, toolName: name, toolCallId, providerIdentifier: "pi-agent", args: encoded });
}

function mcpToolCall(toolCallId: string, name: string, args: Record<string, unknown>) {
  return create(ToolCallSchema, {
    tool: { case: "mcpToolCall", value: create(McpToolCallSchema, { args: mcpArgs(toolCallId, name, args) }) },
  });
}

const isExecReply = (id: number) => (m: AgentClientMessage) => m.message.case === "execClientMessage" && m.message.value.id === id;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const TOOL: PiTool = {
  name: "read_file",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } as never,
};

function model(baseUrl: string, id = "claude-4.5-sonnet"): PiModel {
  return {
    id,
    name: id,
    api: "cursor-agent",
    provider: "cursor",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  } as PiModel;
}

async function collect(stream: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }) {
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return { events, result: await stream.result() };
}

let server: FakeCursorServer | undefined;
async function serve(...handlers: FakeRunHandler[]): Promise<FakeCursorServer> {
  server = await startFakeCursorServer(handlers);
  return server;
}

afterEach(async () => {
  await server?.close();
  server = undefined;
  resetCursorConversationState();
});
after(() => resetCursorConversationState());

const streamSimple = createCursorStreamSimple({ heartbeatMs: 20 });
const context = (text: string, extra: Partial<PiContext> = {}): PiContext => ({
  systemPrompt: "Be brief.",
  messages: [{ role: "user", content: text, timestamp: Date.now() }],
  ...extra,
});

describe("cursor-agent stream (D3, D6.3)", () => {
  it("streams a text turn with thinking and usage, sending the headers and run request", async () => {
    const fake = await serve(async (ctx: FakeRunContext) => {
      await ctx.waitFor((m) => m.message.case === "runRequest");
      await ctx.waitFor((m) => m.message.case === "clientHeartbeat");
      ctx.send(thinkingDelta("hmm"));
      ctx.send(textDelta("Hello, "));
      ctx.send(textDelta("world"));
      ctx.send(tokenDelta(5));
      ctx.send(tokenDelta(2));
      ctx.send(turnEnded());
      ctx.end();
    });

    const { events, result } = await collect(
      streamSimple(model(fake.baseUrl), context("Say hello"), { apiKey: "cursor-access-token", sessionId: "s-text" }) as never,
    );

    assert.equal(result.stopReason, "stop", result.errorMessage);
    const text = events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta).join("");
    assert.equal(text, "Hello, world");
    assert.ok(events.some((e) => e.type === "thinking_delta"), "thinking delta surfaced");
    assert.deepEqual(result.content.map((b) => b.type), ["thinking", "text"]);
    assert.equal(result.usage.output, 7);
    assert.equal(result.usage.totalTokens, 7);
    assert.deepEqual(result.usage.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    assert.equal(events[0]!.type, "start");
    assert.equal(events.at(-1)!.type, "done");

    const run = fake.runs[0]!;
    assert.equal(run.headers[":path"], "/agent.v1.AgentService/Run");
    assert.equal(run.headers["content-type"], "application/connect+proto");
    assert.equal(run.headers["connect-protocol-version"], "1");
    assert.equal(run.headers.authorization, "Bearer cursor-access-token");
    assert.equal(run.headers["x-cursor-client-version"], CURSOR_CLIENT_VERSION);
    assert.equal(CURSOR_CLIENT_VERSION, "cli-2026.07.23-e383d2b");
    assert.equal(run.headers["x-cursor-client-type"], "cli");
    assert.equal(run.headers["x-ghost-mode"], "true");

    const first = run.received[0]!;
    assert.equal(first.message.case, "runRequest");
    if (first.message.case !== "runRequest") return;
    const req = first.message.value;
    assert.equal(req.conversationId, "s-text");
    assert.equal(req.modelDetails?.modelId, "claude-4.5-sonnet");
    assert.equal(req.requestedModel?.modelId, "claude-4.5-sonnet");
    assert.equal(req.action?.action.case, "userMessageAction");
    if (req.action?.action.case === "userMessageAction") assert.equal(req.action.action.value.userMessage?.text, "Say hello");
    assert.equal(req.conversationState?.rootPromptMessagesJson.length, 1, "the system prompt blob id");
  });

  it("surfaces an MCP call as a Pi tool call, answers the exec frame with the handoff, and advertises Pi's tools", async () => {
    const fake = await serve(async (ctx) => {
      await ctx.waitFor((m) => m.message.case === "runRequest");
      ctx.send(exec(1, { case: "requestContextArgs", value: create(RequestContextArgsSchema, {}) }));
      const contextReply = await ctx.waitFor(isExecReply(1));
      ctx.send(textDelta("Reading."));
      ctx.send(
        update({
          case: "toolCallStarted",
          value: create(ToolCallStartedUpdateSchema, { callId: "env-1", toolCall: mcpToolCall("call-1", "read_file", { path: "a.txt" }) }),
        }),
      );
      ctx.send(
        update({
          case: "toolCallCompleted",
          value: create(ToolCallCompletedUpdateSchema, { callId: "env-1", toolCall: mcpToolCall("call-1", "read_file", { path: "a.txt" }) }),
        }),
      );
      ctx.send(exec(2, { case: "mcpArgs", value: mcpArgs("call-1", "read_file", { path: "a.txt" }) }));
      await ctx.waitFor(isExecReply(2));
      ctx.send(turnEnded());
      ctx.end();
      void contextReply;
    });

    const { events, result } = await collect(
      streamSimple(model(fake.baseUrl), context("Read a.txt", { tools: [TOOL] }), { apiKey: "tok", sessionId: "s-mcp" }) as never,
    );

    assert.equal(result.stopReason, "toolUse", result.errorMessage);
    const calls = result.content.filter((b) => b.type === "toolCall");
    assert.equal(calls.length, 1, "one Pi tool call, not a duplicate from the exec frame");
    assert.deepEqual(calls[0], { type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } });
    assert.ok(events.some((e) => e.type === "toolcall_start"));
    assert.ok(events.some((e) => e.type === "toolcall_end"));

    const run = fake.runs[0]!;
    const contextReply = run.received.find(isExecReply(1))!;
    assert.equal(contextReply.message.case, "execClientMessage");
    if (contextReply.message.case !== "execClientMessage") return;
    const reply = contextReply.message.value.message;
    assert.equal(reply.case, "requestContextResult");
    if (reply.case !== "requestContextResult" || reply.value.result.case !== "success") return assert.fail("context success");
    const ctxOut = reply.value.result.value.requestContext!;
    assert.deepEqual(ctxOut.tools.map((t) => [t.name, t.providerIdentifier]), [["read_file", "pi-agent"]]);
    assert.equal(ctxOut.rules[0]?.content, "Be brief.");

    const mcpReply = run.received.find(isExecReply(2))!;
    if (mcpReply.message.case !== "execClientMessage") return assert.fail("exec reply");
    const mcp = mcpReply.message.value.message;
    if (mcp.case !== "mcpResult" || mcp.value.result.case !== "success") return assert.fail("mcp success");
    const item = mcp.value.result.value.content[0]?.content;
    assert.equal(item?.case === "text" ? item.value.text : undefined, MCP_EXTERNAL_HANDOFF_MESSAGE);
  });

  it("sends the tool result back in the next request's history", async () => {
    let blobText = "";
    const fake = await serve(async (ctx) => {
      const first = await ctx.waitFor((m) => m.message.case === "runRequest");
      if (first.message.case !== "runRequest") throw new Error("no run request");
      const state = first.message.value.conversationState!;
      assert.ok(state.turns.length === 1, "one prior turn");
      // Ask the client for the last root-prompt blob over the KV channel.
      const lastId = state.rootPromptMessagesJson.at(-1)!;
      ctx.send(create(AgentServerMessageSchema, {
        message: { case: "kvServerMessage", value: create(KvServerMessageSchema, { id: 9, message: { case: "getBlobArgs", value: create(GetBlobArgsSchema, { blobId: lastId }) } }) },
      }));
      const kv = await ctx.waitFor((m) => m.message.case === "kvClientMessage");
      if (kv.message.case === "kvClientMessage" && kv.message.value.message.case === "getBlobResult") {
        blobText = Buffer.from(kv.message.value.message.value.blobData ?? new Uint8Array()).toString("utf8");
      }
      ctx.send(textDelta("It says hi."));
      ctx.send(turnEnded());
      ctx.end();
    });

    const ctx: PiContext = {
      systemPrompt: "Be brief.",
      tools: [TOOL],
      messages: [
        { role: "user", content: "Read a.txt", timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } }],
          api: "cursor-agent",
          provider: "cursor",
          model: "claude-4.5-sonnet",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: 2,
        },
        { role: "toolResult", toolCallId: "call-1", toolName: "read_file", content: [{ type: "text", text: "hi" }], isError: false, timestamp: 3 },
      ],
    };
    const { result } = await collect(streamSimple(model(fake.baseUrl), ctx, { apiKey: "tok", sessionId: "s-history" }) as never);
    assert.equal(result.stopReason, "stop", result.errorMessage);
    const first = fake.runs[0]!.received[0]!;
    if (first.message.case !== "runRequest") return assert.fail("run request");
    assert.equal(first.message.value.action?.action.case, "resumeAction", "a trailing tool result resumes");
    assert.deepEqual(JSON.parse(blobText), {
      role: "tool",
      id: "call-1",
      content: [{ type: "tool-result", toolName: "read_file", toolCallId: "call-1", result: "hi" }],
    });
  });

  it("answers native exec requests with the rejected result and runs nothing (D4)", async () => {
    const marker = join(mkdtempSync(join(tmpdir(), "lykos-cursor-exec-")), "ran");
    const command = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')"`;
    const fake = await serve(async (ctx) => {
      await ctx.waitFor((m) => m.message.case === "runRequest");
      ctx.send(exec(1, { case: "shellArgs", value: create(ShellArgsSchema, { command, workingDirectory: "/tmp", toolCallId: "sh-1" }) }));
      ctx.send(exec(2, { case: "shellStreamArgs", value: create(ShellArgsSchema, { command, workingDirectory: "/tmp", toolCallId: "sh-2" }) }));
      ctx.send(create(AgentServerMessageSchema, {
        message: {
          case: "kvServerMessage",
          value: create(KvServerMessageSchema, { id: 4, message: { case: "setBlobArgs", value: create(SetBlobArgsSchema, { blobId: new Uint8Array([1, 2]), blobData: new Uint8Array([3]) }) } }),
        },
      }));
      ctx.send(create(AgentServerMessageSchema, {
        message: {
          case: "interactionQuery",
          value: create(InteractionQuerySchema, {
            id: 11,
            query: { case: "webSearchRequestQuery", value: create(WebSearchRequestQuerySchema, { args: create(WebSearchArgsSchema, { searchTerm: "x", toolCallId: "ws-1" }) }) },
          }),
        },
      }));
      await ctx.waitFor(isExecReply(1));
      await ctx.waitFor((m) => m.message.case === "execClientControlMessage" && m.message.value.message.case === "streamClose");
      await ctx.waitFor((m) => m.message.case === "kvClientMessage");
      await ctx.waitFor((m) => m.message.case === "interactionResponse");
      ctx.send(textDelta("I could not run that."));
      ctx.send(turnEnded());
      ctx.end();
    });

    const { result } = await collect(streamSimple(model(fake.baseUrl), context("Run it"), { apiKey: "tok", sessionId: "s-exec" }) as never);
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(result.content.filter((b) => b.type === "toolCall").length, 0, "no tool call reaches Pi's loop");
    assert.equal(existsSync(marker), false, "nothing ran");

    const received = fake.runs[0]!.received;
    const shell = received.find(isExecReply(1))!;
    if (shell.message.case !== "execClientMessage" || shell.message.value.message.case !== "shellResult") return assert.fail("shellResult");
    const shellResult = shell.message.value.message.value.result;
    assert.equal(shellResult.case, "rejected");
    if (shellResult.case === "rejected") {
      assert.equal(shellResult.value.reason, "Tool not available");
      assert.equal(shellResult.value.command, command);
    }
    const streamEvents = received
      .filter(isExecReply(2))
      .map((m) => (m.message.case === "execClientMessage" ? m.message.value.message : undefined))
      .map((x) => (x?.case === "shellStream" ? `stream:${x.value.event.case}` : x?.case));
    assert.deepEqual(streamEvents, ["stream:start", "stream:rejected", "stream:exit", "shellResult"]);

    const kv = received.find((m) => m.message.case === "kvClientMessage")!;
    assert.equal(kv.message.case === "kvClientMessage" ? kv.message.value.message.case : undefined, "setBlobResult");
    const ir = received.find((m) => m.message.case === "interactionResponse")!;
    if (ir.message.case !== "interactionResponse" || ir.message.value.result.case !== "webSearchRequestResponse") return assert.fail("web search reply");
    assert.equal(ir.message.value.id, 11);
    assert.equal(ir.message.value.result.value.result.case, "rejected", "hosted tools are refused (D4)");
  });

  it("turns a Connect end-stream error into an error event", async () => {
    const fake = await serve(async (ctx) => {
      await ctx.waitFor((m) => m.message.case === "runRequest");
      ctx.send(textDelta("partial"));
      ctx.sendEndStreamError("resource_exhausted", "You have hit your usage limit");
      ctx.end();
    });
    const { events, result } = await collect(streamSimple(model(fake.baseUrl), context("Hi"), { apiKey: "tok" }) as never);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "Connect error resource_exhausted: You have hit your usage limit");
    assert.equal(events.at(-1)!.type, "error");
    assert.equal(classifyFailure({ message: result.errorMessage!, provider: "cursor" }).kind, "usage_limit");
  });

  it("classifies an HTTP 401 and a Connect unauthenticated end-stream as auth failures (ticket 05)", async () => {
    const fake = await serve(
      (ctx) => ctx.respondStatus(401, JSON.stringify({ code: "unauthenticated", message: "bad token" })),
      async (ctx) => {
        await ctx.waitFor((m) => m.message.case === "runRequest");
        ctx.sendEndStreamError("unauthenticated", "Invalid auth token");
        ctx.end();
      },
    );
    const http = await collect(streamSimple(model(fake.baseUrl), context("Hi"), { apiKey: "expired" }) as never);
    assert.equal(http.result.stopReason, "error");
    assert.match(http.result.errorMessage!, /^Cursor API error: 401 /);
    assert.equal(classifyFailure({ message: http.result.errorMessage!, provider: "cursor" }).kind, "auth_401");
    assert.doesNotMatch(http.result.errorMessage!, /expired/, "the token is not in the message");

    const connect = await collect(streamSimple(model(fake.baseUrl), context("Hi"), { apiKey: "expired" }) as never);
    assert.equal(connect.result.errorMessage, "Connect error unauthenticated: Invalid auth token (HTTP 401)");
    assert.equal(classifyFailure({ message: connect.result.errorMessage!, provider: "cursor" }).kind, "auth_401");
  });

  it("fails a turn whose end-stream or gRPC trailer reports an error after turnEnded", async () => {
    const fake = await serve(
      async (ctx) => {
        await ctx.waitFor((m) => m.message.case === "runRequest");
        ctx.send(textDelta("hello"));
        ctx.send(turnEnded());
        ctx.sendEndStreamError("unavailable", "post-turn connect failure");
        ctx.end();
      },
      async (ctx) => {
        await ctx.waitFor((m) => m.message.case === "runRequest");
        ctx.respondOk({ "grpc-status": "13", "grpc-message": encodeURIComponent("post-turn trailer failure") });
        ctx.send(textDelta("hello"));
        ctx.send(turnEnded());
        ctx.end();
      },
    );
    const connect = await collect(streamSimple(model(fake.baseUrl), context("Hi"), { apiKey: "tok" }) as never);
    assert.equal(connect.events.at(-1)!.type, "error");
    assert.ok(!connect.events.some((e) => e.type === "done"));
    assert.equal(connect.result.errorMessage, "Connect error unavailable: post-turn connect failure");

    const trailer = await collect(streamSimple(model(fake.baseUrl), context("Hi"), { apiKey: "tok" }) as never);
    assert.equal(trailer.result.stopReason, "error");
    assert.equal(trailer.result.errorMessage, "gRPC error 13: post-turn trailer failure");
  });

  it("an abort ends a hanging turn as aborted", async () => {
    const fake = await serve(async (ctx) => {
      await ctx.waitFor((m) => m.message.case === "runRequest");
      ctx.send(textDelta("thinking about it"));
      // The stream stays open: only the client's abort ends this turn.
    });
    const controller = new AbortController();
    const stream = streamSimple(model(fake.baseUrl), context("Hi"), { apiKey: "tok", signal: controller.signal }) as never as AsyncIterable<AssistantMessageEvent> & {
      result(): Promise<AssistantMessage>;
    };
    const seen: string[] = [];
    for await (const e of stream) {
      seen.push(e.type);
      if (e.type === "text_delta") controller.abort();
    }
    const result = await stream.result();
    assert.equal(result.stopReason, "aborted");
    assert.equal(seen.at(-1), "error");
  });

  it("fails a stream that ends before turnEnded, and one with no token", async () => {
    const fake = await serve(async (ctx) => {
      await ctx.waitFor((m) => m.message.case === "runRequest");
      ctx.send(textDelta("partial"));
      ctx.end();
    });
    const cut = await collect(streamSimple(model(fake.baseUrl), context("Hi"), { apiKey: "tok" }) as never);
    assert.equal(cut.result.errorMessage, "Cursor stream ended before turnEnded");

    const none = await collect(streamSimple(model(fake.baseUrl), context("Hi"), {}) as never);
    assert.equal(none.result.stopReason, "error");
    assert.match(none.result.errorMessage!, /lykos login cursor/);
  });
});
