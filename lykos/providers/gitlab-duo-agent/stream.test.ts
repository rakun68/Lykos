// GitLab Duo Agent stream tests.
//
// Every case runs against `./fake-duo-server.ts` on 127.0.0.1 through Node's own `fetch`
// and global `WebSocket`: no network.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { classifyFailure } from "../../credentials/classify.js";
import type { AssistantMessage, AssistantMessageEvent, PiContext, PiModel, PiTool } from "../google-cca/types.js";
import { type FakeDuoServer, type FakeRestRequest, type FakeRestResponse, startFakeDuoServer } from "./fake-duo-server.js";
import { createGitLabDuoAgentStreamSimple, resetGitLabDuoAgentState, UNSUPPORTED_ACTION_MESSAGE } from "./stream.js";

process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-duo-agent-stream-")), "absent.db");

/** A workspace with no `.git`, so nothing outside the temp dir is read for a remote. */
const workspace = mkdtempSync(join(tmpdir(), "lykos-duo-agent-ws-"));

function modelAt(baseUrl: string): PiModel {
  return {
    id: "claude_sonnet_4_6_vertex",
    name: "Claude Sonnet 4.6 - Vertex",
    api: "gitlab-duo-agent",
    provider: "gitlab-duo-agent",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 16_384,
  } as unknown as PiModel;
}

const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} as unknown as PiTool;

const userContext: PiContext = {
  systemPrompt: "You are Lykos.",
  messages: [{ role: "user", content: "Help me update the code.", timestamp: Date.now() }],
  tools: [readTool],
};

function checkpoint(status: string, entries: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { newCheckpoint: { status, checkpoint: JSON.stringify({ channel_values: { ui_chat_log: entries } }) }, ...extra };
}

interface Rest {
  rest: (req: FakeRestRequest) => FakeRestResponse | undefined;
  created: string[];
  stopped: string[];
}

function pathOf(req: FakeRestRequest): string {
  return req.url.split("?")[0]!;
}

/** The REST routes a namespace-configured run calls (GITLAB_DUO_NAMESPACE_ID=1). */
function duoRest(overrides: { directAccess?: FakeRestResponse } = {}): Rest {
  const created: string[] = [];
  const stopped: string[] = [];
  return {
    created,
    stopped,
    rest: (req) => {
      const path = pathOf(req);
      if (req.method === "GET" && path === "/api/v4/groups/1") return { status: 200, body: { id: 1, full_path: "duo-group" } };
      if (req.method === "PUT" && path === "/api/v4/groups/1") return { status: 200, body: {} };
      if (req.method === "GET" && path === "/api/v4/groups/1/projects") {
        return { status: 200, body: [{ id: 7, path_with_namespace: "duo-group/app" }] };
      }
      if (req.method === "GET" && path === "/api/v4/projects/duo-group%2Fapp") {
        return { status: 200, body: { id: 7, path_with_namespace: "duo-group/app", namespace: { id: 1, full_path: "duo-group" } } };
      }
      if (path === "/api/v4/ai/duo_workflows/direct_access") {
        return overrides.directAccess ?? { status: 201, body: { gitlab_rails: { token: "rails-token" } } };
      }
      if (req.method === "POST" && path === "/api/v4/ai/duo_workflows/workflows") {
        const id = `workflow-${created.length + 1}`;
        created.push(id);
        return { status: 201, body: { id } };
      }
      if (req.method === "PATCH" && path.startsWith("/api/v4/ai/duo_workflows/workflows/")) {
        stopped.push(path.split("/").pop()!);
        return { status: 200, body: {} };
      }
      if (req.method === "POST" && path === "/api/graphql") {
        if (req.body.includes("rootAncestor")) {
          return { status: 200, body: { data: { project: { namespace: { id: "gid://gitlab/Group/1", rootAncestor: { id: "gid://gitlab/Group/1" } } } } } };
        }
        return {
          status: 200,
          body: {
            data: {
              aiChatAvailableModels: {
                defaultModel: { name: "Claude", ref: "claude_sonnet_4_6_vertex" },
                selectableModels: [],
                pinnedModel: null,
              },
            },
          },
        };
      }
      return undefined;
    },
  };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent> & { result(): Promise<AssistantMessage> }) {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result() };
}

let server: FakeDuoServer | undefined;

afterEach(async () => {
  resetGitLabDuoAgentState();
  await server?.close();
  server = undefined;
});

const namespaceEnv = { GITLAB_DUO_NAMESPACE_ID: "1" };

describe("gitlab-duo-agent stream (ticket 13, D6.2)", () => {
  it("a text turn completes: REST setup, startRequest, checkpoint deltas, context usage", async () => {
    const rest = duoRest();
    server = await startFakeDuoServer({
      rest: rest.rest,
      onSocket: async (socket) => {
        await socket.next();
        socket.send(checkpoint("RUNNING", [{ message_type: "agent", message_id: "m1", content: "Hel" }]));
        socket.send(
          checkpoint("INPUT_REQUIRED", [{ message_type: "agent", message_id: "m1", content: "Hello from Duo" }], {
            agent_context_usage: { "Chat Agent": { total_tokens: 1234, max_tokens: 1_000_000 } },
          }),
        );
      },
    });
    const streamSimple = createGitLabDuoAgentStreamSimple({ env: namespaceEnv, cwd: workspace });
    const { events, result } = await collect(streamSimple(modelAt(server.baseUrl), userContext, { apiKey: "gl-access" }) as never);

    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.content, [{ type: "text", text: "Hello from Duo" }]);
    assert.deepEqual(
      events.filter((e) => e.type === "text_delta").map((e) => (e as { delta: string }).delta),
      ["Hel", "lo from Duo"],
    );
    assert.equal(events[0]!.type, "start");
    assert.equal(events.at(-1)!.type, "done");
    // The server's context-occupancy estimate is the only usage the protocol carries.
    assert.equal(result.usage.input, 1234);
    assert.equal(result.usage.output, 0);

    for (const req of server.requests) assert.equal(req.headers.authorization, "Bearer gl-access", `${req.method} ${req.url}`);
    // The group-settings PUT is opt-in: without LYKOS_GITLAB_DUO_ENABLE_GROUP_SETTINGS nothing changes the group.
    assert.equal(server.requests.filter((r) => r.method === "PUT").length, 0);
    const create = server.requests.find((r) => r.method === "POST" && pathOf(r) === "/api/v4/ai/duo_workflows/workflows")!;
    assert.deepEqual(JSON.parse(create.body), {
      workflow_definition: "ambient",
      environment: "ide",
      allow_agent_to_request_user: false,
      agent_privileges: [6],
      pre_approved_agent_privileges: [6],
      requires_duo_cli_enabled: false,
      project_id: "duo-group/app",
      goal: "",
    });
    const direct = server.requests.find((r) => pathOf(r) === "/api/v4/ai/duo_workflows/direct_access")!;
    assert.deepEqual(JSON.parse(direct.body), {
      workflow_definition: "ambient",
      root_namespace_id: "gid://gitlab/Group/1",
      project_id: "duo-group/app",
    });

    const socket = server.sockets[0]!;
    const url = new URL(socket.url, "http://x");
    assert.equal(url.pathname, "/api/v4/ai/duo_workflows/ws");
    assert.equal(url.searchParams.get("project_id"), "7");
    assert.equal(url.searchParams.get("namespace_id"), "1");
    assert.equal(url.searchParams.get("root_namespace_id"), "1");
    assert.equal(url.searchParams.get("user_selected_model_identifier"), "claude_sonnet_4_6_vertex");
    assert.equal(url.searchParams.get("workflow_definition"), "ambient");
    assert.equal(socket.headers.authorization, "Bearer rails-token");
    assert.equal(socket.headers["x-gitlab-client-type"], "node-websocket");
    assert.equal(socket.headers["x-gitlab-language-server-version"], "8.104.0");

    const start = (socket.received[0] as { startRequest: Record<string, any> }).startRequest;
    assert.equal(start.workflowID, "workflow-1");
    assert.equal(start.goal, "Help me update the code.");
    assert.deepEqual(start.preapproved_tools, ["read"]);
    assert.equal(start.mcpTools[0].name, "read");
    assert.deepEqual(JSON.parse(start.mcpTools[0].inputSchema), (readTool as { parameters: unknown }).parameters);
    assert.equal(start.flowConfig.prompts[0].prompt_template.system, "You are Lykos.");
  });

  it("a runMCPTool action becomes a Pi tool call; the next call's tool result goes back as the actionResponse on the same socket", async () => {
    const rest = duoRest();
    let actionResponse: unknown;
    server = await startFakeDuoServer({
      rest: rest.rest,
      onSocket: async (socket) => {
        await socket.next();
        socket.send(checkpoint("RUNNING", [{ message_type: "agent", message_id: "pre-1", content: "PRE_TOOL" }]));
        socket.send({ requestID: "req-read-1", runMCPTool: { name: "mcp__lykos__read", args: JSON.stringify({ path: "README.md" }) } });
        actionResponse = await socket.next();
        socket.send(
          checkpoint("INPUT_REQUIRED", [
            { message_type: "agent", message_id: "pre-2", content: "PRE_TOOL" },
            { message_type: "tool", content: "read result" },
            { message_type: "agent", message_id: "post", content: "POST_TOOL" },
          ]),
        );
      },
    });
    const streamSimple = createGitLabDuoAgentStreamSimple({ env: namespaceEnv, cwd: workspace });
    const model = modelAt(server.baseUrl);
    const options = { apiKey: "gl-access", sessionId: "duo-tool-session" };

    const first = await collect(streamSimple(model, userContext, options) as never);
    assert.equal(first.result.stopReason, "toolUse", first.result.errorMessage);
    assert.deepEqual(first.result.content, [
      { type: "text", text: "PRE_TOOL" },
      { type: "toolCall", id: "req-read-1", name: "read", arguments: { path: "README.md" } },
    ]);
    assert.deepEqual(
      first.events.map((e) => e.type).filter((t) => t.startsWith("toolcall") || t === "done"),
      ["toolcall_start", "toolcall_delta", "toolcall_end", "done"],
    );

    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "req-read-1",
      toolName: "read",
      content: [{ type: "text" as const, text: "README file text" }],
      isError: false,
      timestamp: Date.now(),
    };
    const second = await collect(
      streamSimple(model, { ...userContext, messages: [...userContext.messages, first.result, toolResult] }, options) as never,
    );
    assert.equal(second.result.stopReason, "stop", second.result.errorMessage);
    assert.deepEqual(second.result.content, [{ type: "text", text: "POST_TOOL" }]);
    assert.deepEqual(actionResponse, {
      actionResponse: { requestID: "req-read-1", plainTextResponse: { response: "README file text" } },
    });
    assert.equal(server.sockets.length, 1, "the tool result goes back on the same socket");
    assert.deepEqual(rest.created, ["workflow-1"]);
  });

  it("an error checkpoint becomes an error event, with no restart", async () => {
    const rest = duoRest();
    server = await startFakeDuoServer({
      rest: rest.rest,
      onSocket: async (socket) => {
        await socket.next();
        socket.send({ status: "FAILED", message: "The model refused the request." });
      },
    });
    const streamSimple = createGitLabDuoAgentStreamSimple({ env: namespaceEnv, cwd: workspace });
    const { events, result } = await collect(streamSimple(modelAt(server.baseUrl), userContext, { apiKey: "gl-access" }) as never);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "The model refused the request.");
    assert.equal(events.at(-1)!.type, "error");
    assert.deepEqual(rest.created, ["workflow-1"]);
  });

  it("a 401 on direct_access is an error the rotation classifier reads as auth", async () => {
    const rest = duoRest({ directAccess: { status: 401, body: { message: "401 Unauthorized" } } });
    server = await startFakeDuoServer({ rest: rest.rest });
    const streamSimple = createGitLabDuoAgentStreamSimple({ env: namespaceEnv, cwd: workspace });
    const { result } = await collect(streamSimple(modelAt(server.baseUrl), userContext, { apiKey: "gl-access" }) as never);
    assert.equal(result.stopReason, "error");
    assert.equal(result.errorMessage, "GitLab Duo Workflow direct_access failed with HTTP 401: 401 Unauthorized");
    assert.equal(classifyFailure({ message: result.errorMessage!, provider: "gitlab-duo-agent" }).kind, "auth_401");
    assert.equal(server.sockets.length, 0);
  });

  it("an action other than runMCPTool is refused on the socket; nothing runs and no tool call surfaces (D3)", async () => {
    const rest = duoRest();
    const sentinel = join(workspace, "action-ran");
    let refusal: unknown;
    server = await startFakeDuoServer({
      rest: rest.rest,
      onSocket: async (socket) => {
        await socket.next();
        socket.send({
          action: {
            requestID: "req-shell-1",
            name: "runShellCommand",
            args: { command: `node -e "require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'x')"` },
          },
        });
        refusal = await socket.next();
        socket.send(checkpoint("INPUT_REQUIRED", [{ message_type: "agent", message_id: "a", content: "Understood." }]));
      },
    });
    const streamSimple = createGitLabDuoAgentStreamSimple({ env: namespaceEnv, cwd: workspace });
    const { result } = await collect(streamSimple(modelAt(server.baseUrl), userContext, { apiKey: "gl-access" }) as never);
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.content, [{ type: "text", text: "Understood." }]);
    assert.deepEqual(refusal, {
      actionResponse: { requestID: "req-shell-1", plainTextResponse: { error: UNSUPPORTED_ACTION_MESSAGE("runShellCommand") } },
    });
    assert.equal(existsSync(sentinel), false);
  });

  it("an idle socket triggers exactly one restart, on a fresh workflow", async () => {
    const rest = duoRest();
    server = await startFakeDuoServer({
      rest: rest.rest,
      onSocket: async (socket, index) => {
        await socket.next();
        if (index === 0) return; // half-open: never another frame
        socket.send(checkpoint("INPUT_REQUIRED", [{ message_type: "agent", message_id: "r", content: "After restart" }]));
      },
    });
    const streamSimple = createGitLabDuoAgentStreamSimple({ env: namespaceEnv, cwd: workspace, idleTimeoutMs: 200 });
    const { result } = await collect(streamSimple(modelAt(server.baseUrl), userContext, { apiKey: "gl-access" }) as never);
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.deepEqual(result.content, [{ type: "text", text: "After restart" }]);
    assert.equal(server.sockets.length, 2);
    assert.deepEqual(rest.created, ["workflow-1", "workflow-2"]);
    assert.ok(rest.stopped.includes("workflow-1"), "the dead workflow is stopped");
    assert.deepEqual(
      server.sockets.map((s) => (s.received[0] as { startRequest: { workflowID: string } }).startRequest.workflowID),
      ["workflow-1", "workflow-2"],
    );
  });

  it("a second idle socket is not restarted again: the stream ends and the workflow is stopped", async () => {
    const rest = duoRest();
    server = await startFakeDuoServer({
      rest: rest.rest,
      onSocket: async (socket) => {
        await socket.next();
      },
    });
    const streamSimple = createGitLabDuoAgentStreamSimple({ env: namespaceEnv, cwd: workspace, idleTimeoutMs: 150 });
    const { result } = await collect(streamSimple(modelAt(server.baseUrl), userContext, { apiKey: "gl-access" }) as never);
    assert.equal(server.sockets.length, 2);
    assert.deepEqual(rest.created, ["workflow-1", "workflow-2"]);
    assert.deepEqual(result.content, []);
    // The stop PATCH follows the stream's terminal event.
    for (let i = 0; i < 100 && !rest.stopped.includes("workflow-2"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.ok(rest.stopped.includes("workflow-2"));
  });
});

describe("gitlab-duo-agent project discovery (ticket 13, D4)", () => {
  it("reads the GitLab project from .git/config without running git, and scopes the workflow to it", async () => {
    const rest = duoRest();
    server = await startFakeDuoServer({
      rest: rest.rest,
      onSocket: async (socket) => {
        await socket.next();
        socket.send(checkpoint("INPUT_REQUIRED", [{ message_type: "agent", message_id: "m", content: "ok" }]));
      },
    });
    const repo = mkdtempSync(join(tmpdir(), "lykos-duo-agent-repo-"));
    try {
      mkdirSync(join(repo, ".git"));
      writeFileSync(
        join(repo, ".git", "config"),
        `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${server.baseUrl}/duo-group/app.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`,
      );
      const streamSimple = createGitLabDuoAgentStreamSimple({ env: {}, cwd: repo });
      const { result } = await collect(streamSimple(modelAt(server.baseUrl), userContext, { apiKey: "gl-access" }) as never);
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.ok(server.requests.some((r) => r.method === "GET" && pathOf(r) === "/api/v4/projects/duo-group%2Fapp"));
      assert.ok(!server.requests.some((r) => pathOf(r) === "/api/v4/groups/1/projects"), "the remote's project wins over a listing");
      const create = server.requests.find((r) => r.method === "POST" && pathOf(r) === "/api/v4/ai/duo_workflows/workflows")!;
      assert.equal(JSON.parse(create.body).project_id, "duo-group/app");
      assert.equal(new URL(server.sockets[0]!.url, "http://x").searchParams.get("project_id"), "7");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("with no project resolved, the run goes out namespace-only and a failure says so", async () => {
    const base = duoRest();
    const rest = (req: FakeRestRequest) => (pathOf(req).endsWith("/projects") ? { status: 200, body: [] } : base.rest(req));
    server = await startFakeDuoServer({
      rest,
      onSocket: async (socket) => {
        await socket.next();
        socket.send({ status: "FAILED", message: "Project required." });
      },
    });
    const streamSimple = createGitLabDuoAgentStreamSimple({ env: namespaceEnv, cwd: workspace });
    const { result } = await collect(streamSimple(modelAt(server.baseUrl), userContext, { apiKey: "gl-access" }) as never);
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage!, /^Project required\. \(no GitLab project resolved for this workspace/);
    const create = server.requests.find((r) => r.method === "POST" && pathOf(r) === "/api/v4/ai/duo_workflows/workflows")!;
    assert.equal(JSON.parse(create.body).namespace_id, "duo-group");
    assert.equal(new URL(server.sockets[0]!.url, "http://x").searchParams.has("project_id"), false);
  });
});
