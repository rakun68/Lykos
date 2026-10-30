import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { BUILTIN_PROVIDERS } from "../config/provider-table.js";
import { openCredentialDb } from "../credentials/db.js";
import { anthropicProhibitionWarning, type LoginSurface, runLoginFlow, sanctionWarning } from "../credentials/login-flow.js";
import { upsertCredential } from "../credentials/pool.js";
import { startFakeCursorServer } from "../providers/cursor/fake-cursor-server.js";
import { AgentServerMessageSchema, InteractionUpdateSchema, TextDeltaUpdateSchema, TurnEndedUpdateSchema } from "../providers/cursor/proto.js";
import { chatFrame, endStreamFrame, simpleDevinHandler, startFakeDevinServer } from "../providers/devin/fake-devin-server.js";
import { startFakeDuoServer } from "../providers/gitlab-duo-agent/fake-duo-server.js";
import { resetGitLabDuoAgentState } from "../providers/gitlab-duo-agent/stream.js";
import { loginProviders } from "../providers/logins.js";
import { create } from "../providers/protobuf/codec.js";
import { createLykosModelRuntime, type Provider } from "./model-runtime.js";

// Runtimes built here default to the Lykos credential store (ticket 02); point
// it at a tmp path that is never created so no test reads the real home.
process.env.LYKOS_CREDENTIALS_DB = join(mkdtempSync(join(tmpdir(), "lykos-model-runtime-creds-")), "absent.db");

// Ticket 08: the factory keeps models.json and models-store.json under the
// pi-host, so point it at a tmp dir rather than the real ~/.lykos/pi-host.
process.env.LYKOS_PI_HOST_DIR = mkdtempSync(join(tmpdir(), "lykos-pi-host-"));

describe("createLykosModelRuntime (Ticket 01)", () => {
  it("ModelRuntime.create({ is only called in lykos/session/model-runtime.ts", () => {
    const sessionDir = dirname(fileURLToPath(import.meta.url));
    const lykosRoot = join(sessionDir, "..");
    const workspaceRoot = join(lykosRoot, "..");

    function findTsFiles(dir: string, out: string[] = []): string[] {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          findTsFiles(full, out);
        } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
          out.push(full);
        }
      }
      return out;
    }

    const tsFiles = findTsFiles(lykosRoot);
    const pattern = /ModelRuntime\.create\(\s*\{/;
    const matches: string[] = [];

    for (const file of tsFiles) {
      const content = readFileSync(file, "utf8");
      if (pattern.test(content)) {
        matches.push(relative(workspaceRoot, file).replace(/\\/g, "/"));
      }
    }

    assert.deepEqual(matches, ["lykos/session/model-runtime.ts"]);
  });

  it("createLykosModelRuntime returns a runtime configured with modelsPath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-model-runtime-test-"));
    const modelsPath = join(dir, "models.json");
    const payload = {
      providers: {
        "test-provider": {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          models: [{ id: "test-model" }],
        },
      },
    };
    writeFileSync(modelsPath, JSON.stringify(payload, null, 2), "utf8");

    try {
      const runtime = await createLykosModelRuntime({ modelsPath });
      assert.ok(runtime, "expected runtime to be created");
      const model = runtime.getModel("test-provider", "test-model");
      assert.ok(model, "expected runtime to find the configured model");
      assert.equal(model.id, "test-model");
      assert.equal(model.provider, "test-provider");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers nativeProviders and makes them retrievable", async () => {
    // Constructing a full native Provider with stream/complete functions is impractical and unnecessary
    // here because getRegisteredNativeProvider only indexes by provider id in the runtime.
    const fakeProvider = {
      id: "fake-native-provider",
      name: "Fake Native Provider",
    } as unknown as Provider;

    const runtime = await createLykosModelRuntime({
      nativeProviders: [fakeProvider],
    });

    const registered = runtime.getRegisteredNativeProvider("fake-native-provider");
    assert.equal(registered, fakeProvider);
  });

  it("registers the Cloud Code Assist providers by default, with model ids from the generated table (ticket 04, D2)", async () => {
    const runtime = await createLykosModelRuntime();
    for (const id of ["google-antigravity", "google-gemini-cli"]) {
      const provider = runtime.getProvider(id);
      assert.ok(provider, `${id} is registered`);
      assert.equal(typeof provider.auth.oauth?.login, "function", `${id} has an OAuth login`);
      const models = runtime.getModels(id);
      assert.deepEqual(
        models.map((m) => m.id),
        BUILTIN_PROVIDERS[id]!.models.map((m) => m.id),
      );
      for (const m of models) {
        assert.equal(m.api, "google-gemini-cli");
        assert.equal(m.baseUrl, BUILTIN_PROVIDERS[id]!.baseUrl);
        assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "unpriced (rule 5)");
      }
    }
    assert.ok(runtime.getModel("google-antigravity", "gemini-3-pro"));
    assert.equal(runtime.getModel("google-antigravity", "gemini-3-pro-high"), undefined, "wire ids are not model ids");
  });

  it("registers only the providers it is given", async () => {
    const runtime = await createLykosModelRuntime({ providers: {} });
    assert.equal(runtime.getProvider("google-antigravity"), undefined);
    // Tickets 15 & 16, D1: the six builtin-login wrappers are native providers, always registered.
    assert.deepEqual([...runtime.getRegisteredProviderIds()].sort(), [
      "anthropic",
      "github-copilot",
      "kimi-coding",
      "openai-codex",
      "openrouter",
      "xai",
    ]);
    assert.deepEqual(
      runtime.getRegisteredProviderIds().map((id) => runtime.getRegisteredProviderConfig(id)),
      [undefined, undefined, undefined, undefined, undefined, undefined],
    );
  });

  it("wraps streamSimple for rotation as an own property, leaving Pi's prototype untouched (ticket 05)", async () => {
    const protoStream = ModelRuntime.prototype.streamSimple;
    const runtime = await createLykosModelRuntime({ providers: {} });
    assert.ok(Object.prototype.hasOwnProperty.call(runtime, "streamSimple"));
    assert.equal(ModelRuntime.prototype.streamSimple, protoStream);

    // A foreign store (login's capture store, say) gets Pi's own stream path.
    const foreign = await createLykosModelRuntime({
      providers: {},
      credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async () => undefined,
        delete: async () => {},
      },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(foreign, "streamSimple"), false);
  });

  it("defaults to the Lykos credential store, which a runtime build never creates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-model-runtime-store-"));
    const credentialDbPath = join(dir, "credentials.db");
    try {
      const runtime = await createLykosModelRuntime({ credentialDbPath });
      assert.deepEqual(await runtime.listCredentials(), []);
      assert.equal(existsSync(credentialDbPath), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runLoginFlow prints sanction warning on empty pool for the login providers and suppresses on second (D4.5; ticket 12 D6.5; ticket 14 D6.4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-login-flow-sanctions-"));
    const dbPath = join(dir, "credentials.db");
    try {
      for (const provider of ["zai", "kilo", "gitlab-duo", "muse-code", "cursor", "gitlab-duo-agent", "devin"] as const) {
        let errOutput = "";
        const surface: LoginSurface = {
          dbPath,
          out: () => {},
          err: (line) => {
            errOutput += line + "\n";
          },
          ask: async () => undefined,
          openBrowser: () => {},
          createRuntime: async () => ({
            login: async () => ({
              type: "oauth",
              access: "test-token",
              refresh: "test-refresh",
              expires: Date.now() + 3600_000,
            }),
          }),
        };

        // First login -> empty pool -> warning printed
        await runLoginFlow(provider, false, surface);
        assert.ok(
          errOutput.includes(sanctionWarning(provider)),
          `expected sanction warning on first login for ${provider}`,
        );

        // Second login -> non-empty pool -> warning suppressed
        errOutput = "";
        await runLoginFlow(provider, false, surface);
        assert.ok(
          !errOutput.includes(sanctionWarning(provider)),
          `expected no sanction warning on second login for ${provider}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runLoginFlow warns before every Anthropic login with Anthropic's prohibition; Codex keeps the sanction warning (ticket 15, D4, D5.5)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-login-flow-anthropic-"));
    const dbPath = join(dir, "credentials.db");
    try {
      let errOutput = "";
      let n = 0;
      const surface: LoginSurface = {
        dbPath,
        out: () => {},
        err: (line) => {
          errOutput += line + "\n";
        },
        ask: async () => undefined,
        openBrowser: () => {},
        createRuntime: async () => ({
          login: async () => ({ type: "oauth", access: `access-${++n}`, refresh: `refresh-${n}`, expires: Date.now() + 3_600_000 }),
        }),
      };
      for (const attempt of ["first", "second"]) {
        errOutput = "";
        assert.equal(await runLoginFlow("anthropic", false, surface), 0);
        assert.ok(errOutput.includes(anthropicProhibitionWarning()), `prohibition warning on the ${attempt} login`);
        assert.ok(
          errOutput.includes(
            '"Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users."',
          ),
          "quotes Anthropic's statement",
        );
        assert.ok(errOutput.includes("https://code.claude.com/docs/en/legal-and-compliance"), "names the source");
        assert.match(errOutput, /may be suspended/);
        assert.ok(!errOutput.includes(sanctionWarning("anthropic")), "not merely 'unverified'");
      }

      errOutput = "";
      assert.equal(await runLoginFlow("openai-codex", false, surface), 0);
      assert.ok(errOutput.includes(sanctionWarning("openai-codex")), "the ordinary sanction warning");
      assert.ok(!errOutput.includes("Anthropic prohibits"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runLoginFlow: openrouter prints no warning; kimi-coding and xai print it on an empty pool (ticket 16, D4, D5.3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-login-flow-16-"));
    const dbPath = join(dir, "credentials.db");
    try {
      let errOutput = "";
      let n = 0;
      const surface: LoginSurface = {
        dbPath,
        out: () => {},
        err: (line) => {
          errOutput += line + "\n";
        },
        ask: async () => undefined,
        openBrowser: () => {},
        createRuntime: async () => ({
          login: async () => ({ type: "oauth", access: `access-${++n}`, refresh: `refresh-${n}`, expires: Date.now() + 3_600_000 }),
        }),
      };

      // OpenRouter on empty pool -> no warning
      errOutput = "";
      assert.equal(await runLoginFlow("openrouter", false, surface), 0);
      assert.ok(!errOutput.includes("sanction"), "openrouter shows no sanction warning on empty pool");

      // Kimi on empty pool -> sanction warning; second login -> suppressed
      errOutput = "";
      assert.equal(await runLoginFlow("kimi-coding", false, surface), 0);
      assert.ok(errOutput.includes(sanctionWarning("kimi-coding")), "kimi-coding shows sanction warning on empty pool");
      errOutput = "";
      assert.equal(await runLoginFlow("kimi-coding", false, surface), 0);
      assert.ok(!errOutput.includes(sanctionWarning("kimi-coding")), "kimi-coding second login suppresses warning");

      // xAI on empty pool -> sanction warning; second login -> suppressed
      errOutput = "";
      assert.equal(await runLoginFlow("xai", false, surface), 0);
      assert.ok(errOutput.includes(sanctionWarning("xai")), "xai shows sanction warning on empty pool");
      errOutput = "";
      assert.equal(await runLoginFlow("xai", false, surface), 0);
      assert.ok(!errOutput.includes(sanctionWarning("xai")), "xai second login suppresses warning");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("createLykosModelRuntime exposes OAuth login for all four (D4.6)", async () => {
    const runtime = await createLykosModelRuntime();
    for (const id of ["zai", "kilo", "gitlab-duo", "muse-code", "cursor", "gitlab-duo-agent", "devin"] as const) {
      const provider = runtime.getProvider(id);
      assert.ok(provider, `expected provider ${id} to be registered`);
      assert.equal(
        typeof (provider as any)?.auth?.oauth?.login,
        "function",
        `expected ${id} to expose auth.oauth.login`,
      );
    }
  });
  it("registers cursor by default: api cursor-agent, the table's models at zero cost (ticket 12, D5)", async () => {
    const runtime = await createLykosModelRuntime();
    const models = runtime.getModels("cursor");
    assert.deepEqual(
      models.map((m) => m.id),
      BUILTIN_PROVIDERS["cursor"]!.models.map((m) => m.id),
    );
    for (const m of models) {
      assert.equal(m.api, "cursor-agent");
      assert.equal(m.baseUrl, "https://api2.cursor.sh");
      assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "unpriced (rule 5)");
    }
  });

  it("streams one Cursor turn through the runtime with a pooled OAuth credential (ticket 12, D6.4)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-cursor-runtime-"));
    const credentialDbPath = join(dir, "credentials.db");
    const db = openCredentialDb(credentialDbPath, { create: true })!;
    try {
      upsertCredential(db, "cursor", {
        type: "oauth",
        access: "pooled-cursor-access",
        refresh: "pooled-cursor-refresh",
        expires: Date.now() + 3_600_000,
      });
    } finally {
      db.close();
    }
    const fake = await startFakeCursorServer([
      async (ctx) => {
        await ctx.waitFor((m) => m.message.case === "runRequest");
        const update = (message: Parameters<typeof InteractionUpdateSchema.create>[0]) =>
          create(AgentServerMessageSchema, { message: { case: "interactionUpdate", value: create(InteractionUpdateSchema, message) } });
        ctx.send(update({ message: { case: "textDelta", value: create(TextDeltaUpdateSchema, { text: "Hi from the fake Cursor" }) } }));
        ctx.send(update({ message: { case: "turnEnded", value: create(TurnEndedUpdateSchema, {}) } }));
        ctx.end();
      },
    ]);
    try {
      const runtime = await createLykosModelRuntime({
        credentialDbPath,
        providers: loginProviders({ cursor: { baseUrl: fake.baseUrl } }),
      });
      const model = runtime.getModel("cursor", "claude-4.5-sonnet");
      assert.ok(model, "expected the cursor model");
      const stream = await runtime.streamSimple(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
        { sessionId: "cursor-runtime-test" },
      );
      let text = "";
      for await (const event of stream) if (event.type === "text_delta") text += event.delta;
      const result = await stream.result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(text, "Hi from the fake Cursor");
      assert.equal(fake.runs[0]!.headers.authorization, "Bearer pooled-cursor-access");
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers gitlab-duo-agent by default: api gitlab-duo-agent, the table's models at zero cost (ticket 13, D5)", async () => {
    const runtime = await createLykosModelRuntime();
    const models = runtime.getModels("gitlab-duo-agent");
    assert.deepEqual(
      models.map((m) => m.id),
      BUILTIN_PROVIDERS["gitlab-duo-agent"]!.models.map((m) => m.id),
    );
    for (const m of models) {
      assert.equal(m.api, "gitlab-duo-agent");
      assert.equal(m.baseUrl, "https://gitlab.com");
      assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "unpriced (rule 5)");
    }
  });

  it("streams one GitLab Duo Agent turn through the runtime with a pooled OAuth credential (ticket 13, D6.3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-duo-agent-runtime-"));
    const credentialDbPath = join(dir, "credentials.db");
    const db = openCredentialDb(credentialDbPath, { create: true })!;
    try {
      upsertCredential(db, "gitlab-duo-agent", {
        type: "oauth",
        access: "pooled-duo-agent-access",
        refresh: "pooled-duo-agent-refresh",
        expires: Date.now() + 3_600_000,
      });
    } finally {
      db.close();
    }
    let created = 0;
    const fake = await startFakeDuoServer({
      rest: (req) => {
        const path = req.url.split("?")[0];
        if (path === "/api/v4/groups/1") return { status: 200, body: { id: 1, full_path: "duo-group" } };
        if (path === "/api/v4/groups/1/projects") return { status: 200, body: [{ id: 7, path_with_namespace: "duo-group/app" }] };
        if (path === "/api/v4/ai/duo_workflows/direct_access") return { status: 201, body: { gitlab_rails: { token: "rails-token" } } };
        if (path === "/api/v4/ai/duo_workflows/workflows" && req.method === "POST") return { status: 201, body: { id: ++created } };
        if (path === "/api/graphql") return { status: 200, body: { data: { aiChatAvailableModels: null } } };
        return undefined;
      },
      onSocket: async (socket) => {
        await socket.next();
        socket.send({
          newCheckpoint: {
            status: "INPUT_REQUIRED",
            checkpoint: JSON.stringify({ channel_values: { ui_chat_log: [{ message_type: "agent", content: "Hi from the fake Duo" }] } }),
          },
        });
      },
    });
    try {
      const runtime = await createLykosModelRuntime({
        credentialDbPath,
        providers: loginProviders({
          gitlabDuoAgent: { baseUrl: fake.baseUrl, env: { GITLAB_DUO_NAMESPACE_ID: "1" }, cwd: dir },
        }),
      });
      const model = runtime.getModel("gitlab-duo-agent", "claude_sonnet_4_6_vertex");
      assert.ok(model, "expected the gitlab-duo-agent model");
      const stream = await runtime.streamSimple(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
        { sessionId: "duo-agent-runtime-test" },
      );
      let text = "";
      for await (const event of stream) if (event.type === "text_delta") text += event.delta;
      const result = await stream.result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(text, "Hi from the fake Duo");
      assert.ok(fake.requests.length > 0);
      for (const req of fake.requests) assert.equal(req.headers.authorization, "Bearer pooled-duo-agent-access");
      assert.equal(fake.sockets[0]!.headers.authorization, "Bearer rails-token");
    } finally {
      resetGitLabDuoAgentState();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registers devin by default: api devin-agent, the table's models at zero cost (ticket 14, D5)", async () => {
    const runtime = await createLykosModelRuntime();
    const models = runtime.getModels("devin");
    assert.deepEqual(
      models.map((m) => m.id),
      BUILTIN_PROVIDERS["devin"]!.models.map((m) => m.id),
    );
    for (const m of models) {
      assert.equal(m.api, "devin-agent");
      assert.equal(m.baseUrl, "https://server.codeium.com");
      assert.deepEqual(m.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "unpriced (rule 5)");
    }
  });

  it("streams one Devin turn through the runtime with a pooled OAuth credential (ticket 14, D6.3)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-devin-runtime-"));
    const credentialDbPath = join(dir, "credentials.db");
    const db = openCredentialDb(credentialDbPath, { create: true })!;
    try {
      upsertCredential(db, "devin", {
        type: "oauth",
        access: "pooled-devin-token",
        refresh: "pooled-devin-token",
        expires: Date.now() + 3_600_000,
      });
    } finally {
      db.close();
    }
    const fake = await startFakeDevinServer(simpleDevinHandler([chatFrame({ deltaText: "Hi from the fake Devin" }), endStreamFrame()]));
    try {
      const runtime = await createLykosModelRuntime({
        credentialDbPath,
        providers: loginProviders({ devin: { baseUrl: fake.baseUrl } }),
      });
      const model = runtime.getModel("devin", "swe-1-6");
      assert.ok(model, "expected the devin model");
      const stream = await runtime.streamSimple(
        model,
        { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] },
        { sessionId: "devin-runtime-test" },
      );
      let text = "";
      for await (const event of stream) if (event.type === "text_delta") text += event.delta;
      const result = await stream.result();
      assert.equal(result.stopReason, "stop", result.errorMessage);
      assert.equal(text, "Hi from the fake Devin");
      assert.equal(fake.requests[0]!.path, "/exa.auth_pb.AuthService/GetUserJwt");
      assert.ok(fake.requests[0]!.body.includes(Buffer.from("devin-session-token$pooled-devin-token")), "the pooled token rides in Metadata.apiKey");
    } finally {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
