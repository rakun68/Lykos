// A tool per specialist. Sealed acceptance test. Seam: createMcpServer over an
// InMemoryTransport with a stand-in SessionRunner (as mcp-server.test.ts), and,
// for the read-only criterion, a runner that hands the server's request to the
// real `runSessionChild` on a scripted model, so the tool set asserted is the
// one the session actually sent to its model (ADR-0056).
//
// Nothing here reads T220's result fields: assertions are on tools/list, on the
// SessionRequest the runner receives, on tool descriptions, and on the wire.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { reply, say, SCRIPTED_MODEL, scriptedWorld } from "../cli/scripted-session.js";
import { runSessionChild } from "../cli/session-child.js";
import { createMcpServer } from "./mcp-server.js";
import { encodeFrame, parseFrame, type Frame, type SessionOutcome, type SessionRequest, type SessionRunner } from "./session-protocol.js";

const FRAMED = ["lykos_implement", "lykos_refactor", "lykos_debug", "lykos_review"];
const BUILT_IN_SUBAGENTS = ["lykos_explore", "lykos_general", "lykos_implementer", "lykos_review", "lykos_test-writer"];
const ASYNC = ["lykos_start", "lykos_status", "lykos_steer", "lykos_stop"];
const SPECIALIST_INPUTS = ["brief", "constraints", "budget", "containment", "session_id", "write_in_place", "base"];
const MUTATING = ["edit", "write", "bash", "powershell", "commit"];

afterEach(() => {
  delete process.env.LYKOS_TRUST_WORKSPACE;
});

type Files = Record<string, string>;

function writeFiles(root: string, files: Files): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

/** A git repository holding `files` (project specialists go under .lykos/specialists/). */
function repo(files: Files = {}): string {
  const workspace = mkdtempSync(join(tmpdir(), "lykos-t222-ws-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  writeFiles(workspace, files);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: workspace });
  return workspace;
}

/** A home directory whose ~/.lykos/specialists holds `user` (name -> YAML). */
function home(user: Files = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t222-home-"));
  mkdirSync(join(dir, ".lykos", "specialists"), { recursive: true });
  for (const [name, yaml] of Object.entries(user)) writeFileSync(join(dir, ".lykos", "specialists", `${name}.yaml`), yaml);
  return dir;
}

/** Runs `body` with HOME and USERPROFILE (what os.homedir() reads) pointing at `dir`, restoring them after. */
async function withHome<T>(dir: string, body: () => Promise<T>): Promise<T> {
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  try {
    return await body();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function emptyTrustStore(): string {
  return join(mkdtempSync(join(tmpdir(), "lykos-t222-store-")), "trust.json");
}

const ok = (): SessionOutcome => ({ outcome: "ok", answer: "done", sessionId: "sess-1" });

/** The server is created inside the temp HOME: it learns the specialist list at creation. */
async function withServer<T>(
  opts: { workspace?: string; homeDir?: string; run?: SessionRunner },
  body: (client: Client) => Promise<T>,
): Promise<T> {
  const workspace = opts.workspace ?? repo();
  process.env.LYKOS_TRUST_WORKSPACE = "1";
  return withHome(opts.homeDir ?? home(), async () => {
    const server = createMcpServer({ workspace, version: "0.0.1-test", trustPath: emptyTrustStore(), run: opts.run ?? (async () => ok()) });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "lykos-t222-client", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      return await body(client);
    } finally {
      await client.close();
      await server.close();
    }
  });
}

type ListedTool = { name: string; description?: string; inputSchema: { properties?: Record<string, unknown>; required?: string[] } };

async function listTools(opts: { workspace?: string; homeDir?: string } = {}): Promise<Map<string, ListedTool>> {
  return withServer(opts, async (client) => {
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t as ListedTool]));
  });
}

/** Calls `name` and returns the request the runner received; fails on an assertion when no session was started. */
async function requestOf(name: string, args: Record<string, unknown>, opts: { workspace?: string; homeDir?: string } = {}): Promise<SessionRequest> {
  const seen: SessionRequest[] = [];
  const result = await withServer({ ...opts, run: async ({ request }) => (seen.push(request), ok()) }, (client) =>
    client.callTool({ name, arguments: args }),
  );
  const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
  assert.equal(seen.length, 1, `${name} started a session (result: ${text})`);
  return seen[0]!;
}

describe("T222: tools/list shows a tool per subagent specialist (AC 1)", () => {
  it("lists a tool for each built-in subagent specialist and none for the primary ones (build, plan)", async () => {
    const tools = await listTools();
    for (const name of BUILT_IN_SUBAGENTS) assert.ok(tools.has(name), `${name} listed; got ${[...tools.keys()].join(", ")}`);
    assert.ok(!tools.has("lykos_build"), "build is primary: not listed");
    assert.ok(!tools.has("lykos_plan"), "plan is primary: not listed");
    for (const name of FRAMED) assert.ok(tools.has(name), `the deprecated alias ${name} is still listed`);
    assert.equal(tools.size, new Set([...BUILT_IN_SUBAGENTS, ...FRAMED, ...ASYNC]).size, `exactly the specialists and the aliases: ${[...tools.keys()].join(", ")}`);
  });

  it("describes each specialist tool from its specialist file", async () => {
    const tools = await listTools();
    const expected: Record<string, string> = {
      lykos_explore: "Explore an unfamiliar codebase — search and read, touch nothing.",
      lykos_general: "General helper for a side task — read, edit, and run commands.",
      lykos_implementer: "Make sealed tests pass without modifying them, reporting wrong tests with dispute_test.",
      lykos_review: "Review a change without touching it — report findings, never fix them.",
      "lykos_test-writer": "Write failing tests and stubs, then commit without implementing.",
    };
    for (const [name, description] of Object.entries(expected)) {
      assert.ok(tools.get(name)?.description?.startsWith(description), `${name} description starts with the file's: ${tools.get(name)?.description}`);
    }
    assert.match(tools.get("lykos_explore")!.description!, /read-only/i, "a read_only specialist's tool says so");
    assert.match(tools.get("lykos_implementer")!.description!, /lykos\/ branch/, "a writer's tool says where its work lands");
    for (const name of ["lykos_explore", "lykos_general", "lykos_implementer", "lykos_test-writer"]) {
      assert.match(tools.get(name)!.description!, /session_id/, `${name} says how to continue`);
      assert.doesNotMatch(tools.get(name)!.description!, /deprecated/i, `${name} is not deprecated`);
    }
  });

  it("a specialist tool takes brief, constraints, budget, containment, session_id, write_in_place and base, and no model, provider or specialist", async () => {
    const tools = await listTools();
    for (const name of ["lykos_explore", "lykos_general", "lykos_implementer", "lykos_test-writer"]) {
      const schema = tools.get(name)?.inputSchema;
      assert.ok(schema, `${name} listed`);
      assert.deepEqual(schema.required, ["brief"], `${name}: only brief is required`);
      for (const field of SPECIALIST_INPUTS) assert.ok(field in (schema.properties ?? {}), `${name} accepts ${field}`);
      for (const field of ["model", "provider", "specialist"]) assert.ok(!(field in (schema.properties ?? {})), `${name} has no ${field} input`);
    }
  });

  it("lists user and project subagent specialists (role subagent or all), never a primary one, and skips a file it cannot read", async () => {
    const workspace = repo({
      ".lykos/specialists/auditor.yaml": "description: Audit dependencies.\nrole: subagent\nread_only: true\n",
      ".lykos/specialists/helper.yaml": "description: A helper with no role, so role all.\n",
      ".lykos/specialists/lead.yaml": "description: Leads.\nrole: primary\n",
      ".lykos/specialists/broken.yaml": "description: [unclosed\nrole: subagent\n",
    });
    const homeDir = home({ scribe: "description: Writes notes from home.\nrole: subagent\n" });
    const tools = await listTools({ workspace, homeDir });
    assert.ok(tools.has("lykos_auditor"), `project subagent listed: ${[...tools.keys()].join(", ")}`);
    assert.ok(tools.has("lykos_helper"), "role all is a subagent too");
    assert.ok(tools.has("lykos_scribe"), "user subagent listed");
    assert.ok(tools.get("lykos_scribe")?.description?.startsWith("Writes notes from home."));
    assert.ok(!tools.has("lykos_lead"), "a primary project specialist is not listed");
    assert.ok(!tools.has("lykos_broken"), "a malformed file is skipped, and the server still starts");
    for (const name of BUILT_IN_SUBAGENTS) assert.ok(tools.has(name), `${name} still listed`);
  });

  it("sanitises a name MCP disallows, and the request still names the specialist by its real name", async () => {
    const workspace = repo({ ".lykos/specialists/data loader.yaml": "description: Loads data.\nrole: subagent\n" });
    const tools = await listTools({ workspace });
    assert.ok(tools.has("lykos_data_loader"), `space replaced by _: ${[...tools.keys()].join(", ")}`);
    for (const name of tools.keys()) assert.match(name, /^[A-Za-z0-9_.-]{1,128}$/, name);
    const request = await requestOf("lykos_data_loader", { brief: "load" }, { workspace });
    assert.equal(request.specialist, "data loader");
  });
});

describe("T222: precedence on a clash, project over user over built-in (AC 2)", () => {
  it("a project specialist with a built-in's name replaces it in the list", async () => {
    const workspace = repo({ ".lykos/specialists/general.yaml": "description: PROJECT general helper.\nrole: subagent\n" });
    const tools = await listTools({ workspace });
    assert.ok(tools.get("lykos_general")?.description?.startsWith("PROJECT general helper."), tools.get("lykos_general")?.description);
    assert.equal([...tools.keys()].filter((n) => n === "lykos_general").length, 1);
  });

  it("a user specialist replaces the built-in, and a project one replaces both", async () => {
    const homeDir = home({ general: "description: USER general helper.\nrole: subagent\n" });
    const userOnly = await listTools({ homeDir });
    assert.ok(userOnly.get("lykos_general")?.description?.startsWith("USER general helper."), userOnly.get("lykos_general")?.description);
    const workspace = repo({ ".lykos/specialists/general.yaml": "description: PROJECT general helper.\nrole: subagent\n" });
    const both = await listTools({ workspace, homeDir });
    assert.ok(both.get("lykos_general")?.description?.startsWith("PROJECT general helper."), both.get("lykos_general")?.description);
  });

  it("a project file that makes a built-in subagent primary removes its tool", async () => {
    const workspace = repo({ ".lykos/specialists/explore.yaml": "description: Explore, as a primary here.\nrole: primary\nread_only: true\n" });
    const tools = await listTools({ workspace });
    assert.ok(!tools.has("lykos_explore"), "the winning file is primary");
    assert.ok(tools.has("lykos_general"), "the rest stay");
  });

  it("the review specialist's tool is lykos_review, one tool, described from the winning review file", async () => {
    const workspace = repo({ ".lykos/specialists/review.yaml": "description: PROJECT reviewer.\nrole: subagent\nread_only: true\n" });
    const tools = await listTools({ workspace });
    assert.ok(tools.get("lykos_review")?.description?.startsWith("PROJECT reviewer."), tools.get("lykos_review")?.description);
  });
});

describe("T222: what a specialist tool sends the session", () => {
  it("names the specialist, sends the brief unframed with constraints appended, runs in auto, and carries no model", async () => {
    const request = await requestOf("lykos_implementer", {
      brief: "make the sealed tests pass",
      constraints: "touch src/ only",
      budget: 0.25,
      containment: "auto",
      write_in_place: true,
      base: "main",
    });
    assert.equal(request.tool, "lykos_implementer");
    assert.equal(request.label, "lykos_implementer");
    assert.equal(request.specialist, "implementer");
    assert.equal(request.mode, "auto");
    assert.equal(request.prompt, "make the sealed tests pass\n\nConstraints:\ntouch src/ only");
    assert.equal(request.budgetUsd, 0.25);
    assert.equal(request.containment, "auto");
    assert.equal(request.writeInPlace, true);
    assert.equal(request.base, "main");
    assert.ok(!("model" in request), "no model on the request");
    assert.ok(!("provider" in request), "no provider on the request");
  });

  it("a plain brief is the prompt as given, and a model or specialist argument cannot change what runs", async () => {
    const request = await requestOf("lykos_explore", { brief: "where is the gate?", model: "faux/other", specialist: "build" });
    assert.equal(request.prompt, "where is the gate?");
    assert.equal(request.specialist, "explore");
    assert.equal(request.model, undefined);
  });

  it("session_id continues a session", async () => {
    const request = await requestOf("lykos_general", { brief: "go on", session_id: "sess-7" });
    assert.equal(request.sessionId, "sess-7");
    assert.equal(request.specialist, "general");
  });
});

describe("T222: a read-only specialist runs on the read-only child path (AC 3)", () => {
  /** A runner that hands the server's request to the real child, on a scripted model, and records the tools the session offered. */
  async function wireOf(tool: string, files: Files = {}): Promise<{ wire: string[]; request: SessionRequest | undefined }> {
    const world = await scriptedWorld({ files: { "src/a.ts": "export const a = 1;\n", ...files }, script: [reply(say("looked"))] });
    let seen: SessionRequest | undefined;
    const run: SessionRunner = async ({ request }) => {
      seen = request;
      const input = new PassThrough();
      const lines: string[] = [];
      input.write(encodeFrame(request));
      await runSessionChild({
        input,
        write: (text) => void lines.push(...text.split("\n").filter((l) => l.length > 0)),
        env: { LYKOS_TRUST_SOURCE: "flag", LYKOS_TRUST_WORKSPACE: "1" },
        trustPath: emptyTrustStore(),
        worktreesRoot: mkdtempSync(join(tmpdir(), "lykos-t222-wt-")),
        sessionExtras: { nativeProviders: [world.provider], ledgerPath: world.ledgerPath, model: SCRIPTED_MODEL },
      });
      input.end();
      const last = parseFrame(lines.at(-1) ?? "") as Extract<Frame, { type: "result" }> | undefined;
      return last?.result ?? { outcome: "error", message: "no result frame" };
    };
    // The scripted world isolated HOME; keep it, so the child and the server see the same home.
    await withServer({ workspace: world.workspace, homeDir: process.env.HOME!, run }, (client) => client.callTool({ name: tool, arguments: { brief: "look around" } }));
    return { wire: (world.sent[0]?.tools ?? []).map((t) => t.name), request: seen };
  }

  it("lykos_explore's session holds no edit, write, bash, powershell or commit", async () => {
    const { wire, request } = await wireOf("lykos_explore");
    assert.equal(request?.specialist, "explore", "the server named the specialist");
    assert.ok(wire.includes("read"), `a session ran and can read: ${wire.join(",")}`);
    for (const forbidden of MUTATING) assert.ok(!wire.includes(forbidden), `${forbidden} not in ${wire.join(",")}`);
  });

  it("a project read_only specialist that lists write and bash still gets none of them", async () => {
    const { wire, request } = await wireOf("lykos_auditor", {
      ".lykos/specialists/auditor.yaml": "description: Audit.\nrole: subagent\nread_only: true\ntools: [read, bash, write]\n",
    });
    assert.equal(request?.specialist, "auditor");
    assert.ok(wire.includes("read"), `a session ran and can read: ${wire.join(",")}`);
    for (const forbidden of MUTATING) assert.ok(!wire.includes(forbidden), `${forbidden} not in ${wire.join(",")}`);
  });

  it("a writing specialist keeps the full surface", async () => {
    const { wire } = await wireOf("lykos_general");
    for (const wanted of ["edit", "write", "bash"]) assert.ok(wire.includes(wanted), `${wanted} in ${wire.join(",")}`);
  });
});

describe("T222: the four framed tools stay as deprecated aliases (AC 4)", () => {
  it("each framed tool's description says it is deprecated, and each keeps its model input", async () => {
    const tools = await listTools();
    for (const name of FRAMED) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} listed`);
      // L5 (issue #93 item 7): lykos_review is the review specialist's tool, which wins the clash and carries no deprecation note.
      if (name !== "lykos_review") assert.match(tool.description ?? "", /deprecated/i, `${name} is marked deprecated: ${tool.description}`);
      assert.ok("model" in (tool.inputSchema.properties ?? {}), `${name} keeps model for this release`);
    }
  });

  it("lykos_review, the alias and the review specialist's tool in one, still takes model and runs the review specialist", async () => {
    const request = await requestOf("lykos_review", { brief: "the diff", model: "faux/m" });
    assert.equal(request.tool, "lykos_review");
    assert.equal(request.specialist, "review");
    assert.equal(request.model, "faux/m");
  });
});
