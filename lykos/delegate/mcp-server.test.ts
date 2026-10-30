// Seam 2: the MCP server over an in-memory transport with a stand-in session
// runner. The real protocol (tools/list, tools/call, progress notifications)
// crosses the transport; no process is started. The runner that starts `lykos
// session-child` is proved in session-process.test.ts.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ensureWorkspaceTrust } from "../gate/trust.js";
import { sealCreate } from "../seal/create.js";
import { sealKeyInit } from "../seal/keys.js";
import { createMcpServer, TOOL_DEFS } from "./mcp-server.js";
import type { CommitSummary, SessionOutcome, SessionRequest, SessionRunInput, SessionRunner } from "./session-protocol.js";
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { TranscriptWriter } from "../session/transcript.js";

const TOOLS = ["lykos_debug", "lykos_implement", "lykos_refactor", "lykos_review"];

afterEach(() => {
  delete process.env.LYKOS_TRUST_WORKSPACE;
});

function repo(): string {
  const workspace = mkdtempSync(join(tmpdir(), "lykos-mcp-ws-"));
  execFileSync("git", ["init", "-q"], { cwd: workspace });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"], { cwd: workspace });
  return workspace;
}

function emptyTrustStore(): string {
  return join(mkdtempSync(join(tmpdir(), "lykos-mcp-store-")), "trust.json");
}

async function withServer<T>(
  opts: { workspace?: string; trustPath?: string; run: SessionRunner },
  body: (client: Client) => Promise<T>,
): Promise<T> {
  let workspace = opts.workspace;
  if (workspace === undefined) {
    workspace = repo();
    process.env.LYKOS_TRUST_WORKSPACE = "1";
  }
  const server = createMcpServer({ workspace, version: "0.0.1-test", trustPath: opts.trustPath ?? emptyTrustStore(), run: opts.run });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "lykos-test-client", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await body(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const ok = (extra: Partial<Extract<SessionOutcome, { outcome: "ok" }>> = {}): SessionOutcome => ({
  outcome: "ok",
  answer: "done",
  sessionId: "sess-1",
  ...extra,
});

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("the four tools (T181, stories 67, 68, 73)", () => {
  it("keep their names and required field, and gain containment, session_id and write_in_place as optional inputs", async () => {
    await withServer({ run: async () => ok() }, async (client) => {
      const { tools } = await client.listTools();
      for (const name of TOOLS) {
        assert.ok(tools.some((t) => t.name === name), `${name} is present`);
      }
      for (const name of TOOLS) {
        const tool = tools.find((t) => t.name === name)!;
        const schema = tool.inputSchema as { properties?: Record<string, { enum?: string[] }>; required?: string[] };
        assert.deepEqual(schema.required, ["brief"], `${tool.name}: only brief is required`);
        for (const field of ["brief", "constraints", "model", "budget", "containment", "session_id", "write_in_place"]) {
          assert.ok(field in (schema.properties ?? {}), `${tool.name} accepts ${field}`);
        }
        assert.deepEqual(schema.properties!.containment!.enum, ["off", "auto", "required"]);
      }
    });
  });

  it("describe a Lykos session, not a cheap-tier worker behind a read-only mount", () => {
    for (const def of TOOL_DEFS) {
      assert.match(def.description, /Lykos session/, def.name);
      assert.doesNotMatch(def.description, /cheap-tier|read-only until|LYKOS_SANDBOX|workspace mount|D1\.4|D2\.3|problems\/11/i, def.name);
      assert.match(def.description, /session_id/, `${def.name} says how to continue`);
    }
  });
});

describe("the interaction mode is named by the tool (T184, story 49)", () => {
  it("all four tools run in auto (review is read-only via readOnly flag)", async () => {
    const seen: SessionRunInput[] = [];
    const run: SessionRunner = async (input) => (seen.push(input), ok());
    await withServer({ run }, async (client) => {
      for (const name of TOOLS) await client.callTool({ name, arguments: { brief: "x", write_in_place: true } });
    });
    const modes = Object.fromEntries(seen.map((s) => [s.request.tool, s.request.mode]));
    assert.deepEqual(modes, { lykos_debug: "auto", lykos_implement: "auto", lykos_refactor: "auto", lykos_review: "auto" });
  });

  it("the descriptions tell a caller where a writing session's work lands and what write_in_place changes", async () => {
    for (const def of TOOL_DEFS.filter((d) => d.name !== "lykos_review")) {
      assert.match(def.description, /lykos\/ branch/, def.name);
      assert.match(def.description, /write_in_place/, def.name);
    }
    await withServer({ run: async () => ok() }, async (client) => {
      const { tools } = await client.listTools();
      const schema = tools[0]!.inputSchema as { properties: Record<string, { description?: string }> };
      assert.doesNotMatch(schema.properties.write_in_place!.description ?? "", /no effect yet/);
    });
  });
});

describe("a call reaches the runner and its outcome reaches the client (T181, stories 69, 70)", () => {
  it("hands the runner the framed brief and every input, and returns the optional result fields", async () => {
    const seen: SessionRunInput[] = [];
    const run: SessionRunner = async (input) => {
      seen.push(input);
      return ok({
        containment: "auto",
        runtime: "docker",
        branch: "lykos/s1",
        commits: [{ sha: "abc1234", subject: "Fix it" }],
        skipped_extensions: ["lsp"],
      });
    };
    await withServer({ run }, async (client) => {
      const result = await client.callTool({
        name: "lykos_review",
        arguments: { brief: "the diff", constraints: "be brief", model: "faux/m", budget: 0.5, containment: "required", write_in_place: true },
      });
      assert.notEqual(result.isError, true);
      assert.deepEqual(textOf(result), {
        outcome: "unverified",
        answer: "done",
        answer_is_self_report: true,
        sessionId: "sess-1",
        next: "run_verification",
        verification: { command: null, exit: null, outcome: "unverified", output_tail: "" },
        diff_stat: { files_changed: 0, insertions: 0, deletions: 0 },
        containment: "auto",
        runtime: "docker",
        branch: "lykos/s1",
        commits: [{ sha: "abc1234", subject: "Fix it" }],
        skipped_extensions: ["lsp"],
      });
    });
    const request = seen[0]!.request;
    assert.equal(request.tool, "lykos_review");
    assert.equal(request.label, "lykos_review");
    assert.match(request.prompt, /the diff/);
    assert.match(request.prompt, /Constraints:\nbe brief/);
    assert.equal(request.model, "faux/m");
    assert.equal(request.budgetUsd, 0.5);
    assert.equal(request.containment, "required");
    assert.equal(request.writeInPlace, true);
    assert.equal(request.sessionId, undefined);
  });

  it("omits the new fields a plain call does not produce, so an existing caller sees what it saw", async () => {
    await withServer({ run: async () => ok() }, async (client) => {
      const result = await client.callTool({ name: "lykos_implement", arguments: { brief: "x" } });
      assert.deepEqual(textOf(result), {
        outcome: "unverified",
        answer: "done",
        answer_is_self_report: true,
        sessionId: "sess-1",
        next: "run_verification",
        verification: { command: null, exit: null, outcome: "unverified", output_tail: "" },
      });
    });
  });

  it("continues a session when session_id is given, and returns that id", async () => {
    const seen: string[] = [];
    await withServer(
      {
        run: async ({ request }) => {
          seen.push(request.sessionId ?? "(new)");
          return ok({ answer: "again" });
        },
      },
      async (client) => {
        const first = textOf(await client.callTool({ name: "lykos_implement", arguments: { brief: "start" } }));
        const second = textOf(await client.callTool({ name: "lykos_debug", arguments: { brief: "go on", session_id: first.sessionId as string } }));
        assert.equal(second.sessionId, "sess-1");
      },
    );
    assert.deepEqual(seen, ["(new)", "sess-1"]);
  });

  it("returns blocked and error outcomes as error results, with the session id when there is one", async () => {
    const outcomes: SessionOutcome[] = [
      { outcome: "blocked", reason: "daily spend cap reached" },
      { outcome: "error", message: 'containment level "off" is below the floor', sessionId: "s9" },
    ];
    await withServer({ run: async () => outcomes.shift()! }, async (client) => {
      const blocked = await client.callTool({ name: "lykos_implement", arguments: { brief: "x" } });
      assert.equal(blocked.isError, true);
      assert.deepEqual(textOf(blocked), { outcome: "blocked", reason: "daily spend cap reached", next: "fix_environment" });
      const failed = await client.callTool({ name: "lykos_implement", arguments: { brief: "x" } });
      assert.equal(failed.isError, true);
      assert.deepEqual(textOf(failed), { outcome: "error", message: 'containment level "off" is below the floor', sessionId: "s9", next: "fix_environment" });
    });
  });
});

describe("progress (T181, story 71)", () => {
  it("reaches a client that asked for it, increasing, and is silent for one that did not", async () => {
    const run: SessionRunner = async ({ onProgress }) => {
      onProgress("session started");
      onProgress("still running");
      return ok();
    };
    await withServer({ run }, async (client) => {
      const seen: Array<{ progress: number; message?: string | undefined }> = [];
      await client.callTool({ name: "lykos_implement", arguments: { brief: "x" } }, undefined, {
        onprogress: (p) => seen.push({ progress: p.progress, message: p.message }),
      });
      assert.deepEqual(seen, [
        { progress: 1, message: "session started" },
        { progress: 2, message: "still running" },
      ]);
      // No progress token: the runner's calls are harmless.
      const quiet = await client.callTool({ name: "lykos_implement", arguments: { brief: "x" } });
      assert.notEqual(quiet.isError, true);
    });
  });

  it("aborts the runner when the client cancels the call", async () => {
    let aborted: Promise<void> | undefined;
    let started!: () => void;
    const startedP = new Promise<void>((r) => (started = r));
    const run: SessionRunner = ({ signal }) => {
      aborted = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
      started();
      return new Promise(() => {});
    };
    await withServer({ run }, async (client) => {
      const controller = new AbortController();
      const call = client.callTool({ name: "lykos_implement", arguments: { brief: "x" } }, undefined, { signal: controller.signal });
      call.catch(() => {});
      await startedP;
      controller.abort();
      await assert.rejects(call);
      await aborted;
    });
  });
});

describe("a runner that fails does not take the server down (T181, story 72)", () => {
  it("turns a thrown runner into an error result, and the next call is served", async () => {
    let calls = 0;
    const run: SessionRunner = async () => {
      calls += 1;
      if (calls === 1) throw new Error("spawn exploded");
      return ok();
    };
    await withServer({ run }, async (client) => {
      const first = await client.callTool({ name: "lykos_implement", arguments: { brief: "x" } });
      assert.equal(first.isError, true);
      assert.match(String(textOf(first).message), /spawn exploded/);
      const second = await client.callTool({ name: "lykos_implement", arguments: { brief: "x" } });
      assert.notEqual(second.isError, true);
    });
  });

  it("refuses an untrusted workspace before any session is started", async () => {
    let started = 0;
    await withServer({ workspace: repo(), trustPath: emptyTrustStore(), run: async () => (started++, ok()) }, async (client) => {
      const result = await client.callTool({ name: "lykos_implement", arguments: { brief: "x" } });
      assert.equal(result.isError, true);
      assert.equal(textOf(result).outcome, "blocked");
    });
    assert.equal(started, 0);
  });
});

describe("T171: the trust source reaches the run", () => {
  async function trustSourceSeen(workspace: string, trustPath: string, flag: boolean): Promise<string | undefined> {
    const seen: string[] = [];
    if (flag) process.env.LYKOS_TRUST_WORKSPACE = "1";
    else delete process.env.LYKOS_TRUST_WORKSPACE;
    await withServer(
      {
        workspace,
        trustPath,
        run: async (input) => {
          seen.push(input.trustSource);
          return ok();
        },
      },
      (client) => client.callTool({ name: "lykos_implement", arguments: { brief: "x" } }),
    );
    return seen[0];
  }

  it("a flag-only project is passed as flag; the same project in the store is passed as stored, flag or not", async () => {
    const workspace = repo();
    const trustPath = emptyTrustStore();
    assert.equal(await trustSourceSeen(workspace, trustPath, true), "flag");
    writeFileSync(
      trustPath,
      JSON.stringify({ version: 1, projects: { [(await ensureWorkspaceTrust({ workspace, trustWorkspace: true, trustPath })).projectId]: { trustedUtc: "2026-01-01T00:00:00Z" } } }),
    );
    assert.equal(await trustSourceSeen(workspace, trustPath, true), "stored");
    assert.equal(await trustSourceSeen(workspace, trustPath, false), "stored");
  });
});

describe("T206: seal creation when branch is checked out in another worktree", () => {
  it("creates seal even if branch is still checked out in another worktree, and preserves git config user identity", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-mcp-seal-ws-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "TestUser"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "testuser@example.com"], { cwd: ws });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: ws });
    sealKeyInit(ws);

    const sessionWt = mkdtempSync(join(tmpdir(), "lykos-mcp-sess-wt-"));
    const branch = "lykos/sess-checked-out";
    execFileSync("git", ["worktree", "add", "-b", branch, sessionWt, "HEAD"], { cwd: ws });
    mkdirSync(join(sessionWt, "test"), { recursive: true });
    writeFileSync(
      join(sessionWt, "test", "add.test.mjs"),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('red', () => { assert.fail('red'); });\n",
    );
    execFileSync("git", ["add", "-A"], { cwd: sessionWt });
    execFileSync("git", ["commit", "-q", "-m", "red: add test"], { cwd: sessionWt });

    // Note: sessionWt is NOT removed, and holds an uncommitted change to an unrelated file!
    writeFileSync(join(sessionWt, "unrelated.txt"), "uncommitted work in progress");

    const run: SessionRunner = async () => ({
      outcome: "ok",
      answer: "done",
      sessionId: "sess-checked-out",
      branch,
      commits: [{ sha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: sessionWt }).toString().trim(), subject: "red: add test" }],
    });

    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await withServer({ workspace: ws, run }, async (client) => {
        const result = await client.callTool({
          name: "lykos_implement",
          arguments: { brief: "write tests", specialist: "test-writer" },
        });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        const data = textOf(result);
        const seal = data.seal as Record<string, unknown> | undefined;
        assert.equal(seal?.status, "created", JSON.stringify(data));
        assert.ok(Array.isArray(seal?.paths) && seal.paths.includes("test/add.test.mjs"), JSON.stringify(seal));

        // Check that the seal commit on the branch used git config user identity (TestUser), not Lykos
        const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>", branch], { cwd: ws }).toString().trim();
        assert.equal(author, "TestUser <testuser@example.com>");

        // Assert uncommitted change to unrelated file in sessionWt survived the seal
        assert.equal(existsSync(join(sessionWt, "unrelated.txt")), true, "unrelated uncommitted file survived");
        assert.equal(readFileSync(join(sessionWt, "unrelated.txt"), "utf8"), "uncommitted work in progress");

        // Assert seal file was checked out in sessionWt
        assert.equal(existsSync(join(sessionWt, ".lykos", "seals", `${branch}.json`)), true, "seal file was checked out into session worktree");
      });
    } finally {
      try {
        execFileSync("git", ["worktree", "remove", "--force", sessionWt], { cwd: ws });
      } catch {}
      try {
        rmSync(sessionWt, { recursive: true, force: true });
      } catch {}
      try {
        rmSync(ws, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("T206: writer whose red tests make the session gate fail", () => {
  it("still creates the seal, because it left a new commit", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-mcp-gatefail-ws-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@e"], { cwd: ws });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: ws });
    sealKeyInit(ws);

    let n = 0;
    const red = 'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ndescribe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n';
    const run: SessionRunner = async () => {
      const branch = `lykos/s${++n}`;
      const dir = join(mkdtempSync(join(tmpdir(), "repro-wt-")), "wt");
      execFileSync("git", ["worktree", "add", "-q", "-b", branch, dir, "HEAD"], { cwd: ws });
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "src", "add.mjs"), "export function add(a, b) { return 0; }\n");
      writeFileSync(join(dir, "test", "add.test.mjs"), red);
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "red: add"], { cwd: dir });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
      execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: ws });
      const outcome: SessionOutcome = {
        outcome: "error",
        message: "gate failed: the new red tests fail",
        sessionId: "s1",
        branch,
        commits: [{ sha, subject: "red: add" }],
      };
      return outcome;
    };

    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await withServer({ workspace: ws, run }, async (client) => {
        const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "do it", specialist: "test-writer" } });
        assert.notEqual(res.isError, true, JSON.stringify(res));
        const data = textOf(res);
        assert.equal(data.outcome, "ok");
        const seal = data.seal as Record<string, unknown> | undefined;
        assert.equal(seal?.status, "created");
      });
    } finally {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });

  it("a contained writer error result keeps its containment and Case A does not seal with off", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-mcp-gatefail-contained-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@e"], { cwd: ws });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: auto", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: ws });
    sealKeyInit(ws);

    const red = 'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ndescribe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n';
    const run: SessionRunner = async () => {
      const branch = "lykos/s-writer-err";
      const dir = join(mkdtempSync(join(tmpdir(), "repro-wt-contained-")), "wt");
      execFileSync("git", ["worktree", "add", "-q", "-b", branch, dir, "HEAD"], { cwd: ws });
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "src", "add.mjs"), "export function add(a, b) { return 0; }\n");
      writeFileSync(join(dir, "test", "add.test.mjs"), red);
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "red: add"], { cwd: dir });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
      execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: ws });
      const outcome: SessionOutcome = {
        outcome: "error",
        message: "gate failed: red tests fail",
        sessionId: "s-err",
        branch,
        commits: [{ sha, subject: "red: add" }],
        containment: "auto",
        runtime: "docker",
      };
      return outcome;
    };

    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await withServer({ workspace: ws, run }, async (client) => {
        const res = await client.callTool({
          name: "lykos_implement",
          arguments: { brief: "do it", specialist: "test-writer", containment: "auto" },
        });
        assert.notEqual(res.isError, true, JSON.stringify(res));
        const data = textOf(res);
        assert.equal(data.outcome, "ok");
        const seal = data.seal as Record<string, unknown> | undefined;
        assert.equal(seal?.status, "created");
        assert.equal(seal?.contained, true, "Case A must not seal with containment off");
      });
    } finally {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("T206: a write_in_place run on a branch whose HEAD has an active seal", () => {
  it("verifies that seal on the host instead of reporting none", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-mcp-inplace-ws-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@e"], { cwd: ws });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: ws });
    sealKeyInit(ws);
    execFileSync("git", ["checkout", "-q", "-b", "lykos/w"], { cwd: ws });
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "test"), { recursive: true });
    writeFileSync(join(ws, "src", "add.mjs"), "export function add(a, b) { return 0; }\n");
    writeFileSync(
      join(ws, "test", "add.test.mjs"),
      'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ndescribe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n',
    );
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "red: add"], { cwd: ws });
    const created = await sealCreate({ cwd: ws, branch: "lykos/w", creator: "cli", containmentLevel: "off", ledgerPath: join(ws, ".lykos", "ledger.db") });
    assert.equal(created.ok, true, created.errors?.join("\n"));

    const run: SessionRunner = async () => ({ outcome: "ok", answer: "done", sessionId: "s1", write_in_place: true });
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await withServer({ workspace: ws, run }, async (client) => {
        const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "change src only", write_in_place: true } });
        const data = textOf(res);
        const seal = data.seal as Record<string, unknown> | undefined;
        assert.equal(seal?.status, "intact", JSON.stringify(data));
      });
    } finally {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });

  it("verifies the checked-out branch even when base is set (tampered reports tampered, specialist defaults to implementer)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-mcp-inplace-base-ws-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@e"], { cwd: ws });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: ws });
    sealKeyInit(ws);
    execFileSync("git", ["checkout", "-q", "-b", "lykos/w"], { cwd: ws });
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "test"), { recursive: true });
    writeFileSync(join(ws, "src", "add.mjs"), "export function add(a, b) { return 0; }\n");
    writeFileSync(
      join(ws, "test", "add.test.mjs"),
      'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ndescribe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n',
    );
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "red: add"], { cwd: ws });
    const created = await sealCreate({ cwd: ws, branch: "lykos/w", creator: "cli", containmentLevel: "off", ledgerPath: join(ws, ".lykos", "ledger.db") });
    assert.equal(created.ok, true, created.errors?.join("\n"));

    let receivedRequest: SessionRequest | undefined;
    const run: SessionRunner = async (ctx) => {
      receivedRequest = ctx.request;
      writeFileSync(
        join(ws, "test", "add.test.mjs"),
        'import { describe, it } from "node:test";\ndescribe("math", () => { it("adds", () => {}); });\n',
      );
      execFileSync("git", ["add", "test/add.test.mjs"], { cwd: ws });
      execFileSync("git", ["commit", "-q", "-m", "tamper test"], { cwd: ws });
      return { outcome: "ok", answer: "tampered test", sessionId: "s1", write_in_place: true };
    };

    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await withServer({ workspace: ws, run }, async (client) => {
        const res = await client.callTool({
          name: "lykos_implement",
          arguments: { brief: "modify test", write_in_place: true, base: "main" },
        });
        const data = textOf(res);
        assert.equal(receivedRequest?.specialist, "implementer", "specialist should default to implementer");
        const seal = data.seal as Record<string, unknown> | undefined;
        assert.equal(seal?.status, "tampered", JSON.stringify(data));
      });
    } finally {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("T206: default specialist on a continuation", () => {
  it("runs implementer when the continued session's own branch has an active seal", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-mcp-cont-spec-ws-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@e"], { cwd: ws });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: ws });
    sealKeyInit(ws);
    execFileSync("git", ["checkout", "-q", "-b", "lykos/s1"], { cwd: ws });
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "test"), { recursive: true });
    writeFileSync(join(ws, "src", "add.mjs"), "export function add(a, b) { return 0; }\n");
    writeFileSync(
      join(ws, "test", "add.test.mjs"),
      'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ndescribe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n',
    );
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "red: add"], { cwd: ws });
    const created = await sealCreate({ cwd: ws, branch: "lykos/s1", creator: "cli", containmentLevel: "off", ledgerPath: join(ws, ".lykos", "ledger.db") });
    assert.equal(created.ok, true, created.errors?.join("\n"));
    execFileSync("git", ["checkout", "-q", "main"], { cwd: ws });

    let seen: SessionRequest | undefined;
    const run: SessionRunner = async ({ request }) => { seen = request; return { outcome: "ok", answer: "done", sessionId: "s1" }; };
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await withServer({ workspace: ws, run }, async (client) => {
        await client.callTool({ name: "lykos_implement", arguments: { brief: "keep going", session_id: "s1" } });
        assert.equal(seen?.specialist, "implementer", JSON.stringify(seen));
      });
    } finally {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("T206: the host red check inherits the run's environment", () => {
  it("runs the project test command with the server's environment, not only git identity", async () => {
    process.env.REPRO_FLAG = "1";
    const ws = mkdtempSync(join(tmpdir(), "lykos-mcp-envcheck-ws-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@e"], { cwd: ws });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["seal:", "  base: main", '  test_command: \'node -e "process.exit(process.env.REPRO_FLAG === String(1) ? 0 : 1)" && node --test {files}\'', "containment:", "  level: off", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: ws });
    sealKeyInit(ws);

    let n = 0;
    const run: SessionRunner = async () => {
      const branch = `lykos/s${++n}`;
      const dir = join(mkdtempSync(join(tmpdir(), "repro-wt-")), "wt");
      execFileSync("git", ["worktree", "add", "-q", "-b", branch, dir, "HEAD"], { cwd: ws });
      mkdirSync(join(dir, "src"), { recursive: true });
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "src", "add.mjs"), "export function add(a, b) { return 0; }\n");
      writeFileSync(
        join(dir, "test", "add.test.mjs"),
        'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ndescribe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n',
      );
      execFileSync("git", ["add", "-A"], { cwd: dir });
      execFileSync("git", ["commit", "-q", "-m", "red: add"], { cwd: dir });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir }).toString().trim();
      execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: ws });
      return { outcome: "ok" as const, answer: "done", sessionId: "s1", branch, commits: [{ sha, subject: "red: add" }] };
    };

    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await withServer({ workspace: ws, run }, async (client) => {
        const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "write red", specialist: "test-writer" } });
        const data = textOf(res);
        const seal = data.seal as Record<string, unknown> | undefined;
        assert.equal(seal?.status, "created", JSON.stringify(data));
      });
    } finally {
      delete process.env.REPRO_FLAG;
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("T206: a writer continuation that made no commit", () => {
  it("verifies the existing seal instead of claiming it created one", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-mcp-nocmt-ws-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@e"], { cwd: ws });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: ws });
    sealKeyInit(ws);
    execFileSync("git", ["checkout", "-q", "-b", "lykos/s1"], { cwd: ws });
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "test"), { recursive: true });
    writeFileSync(join(ws, "src", "add.mjs"), "export function add(a, b) { return 0; }\n");
    writeFileSync(
      join(ws, "test", "add.test.mjs"),
      'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ndescribe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n',
    );
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "red: add"], { cwd: ws });
    const created = await sealCreate({ cwd: ws, branch: "lykos/s1", creator: "cli", containmentLevel: "off", ledgerPath: join(ws, ".lykos", "ledger.db") });
    assert.equal(created.ok, true, created.errors?.join("\n"));
    execFileSync("git", ["checkout", "-q", "main"], { cwd: ws });

    const commits: CommitSummary[] = execFileSync("git", ["log", "--format=%H%x1f%s", "main..lykos/s1"], { cwd: ws, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, subject] = l.split("\x1f");
        return { sha: sha!, subject: subject! };
      });
    assert.ok(commits.length >= 2, "the branch still carries the red commit and the seal commit");

    const run: SessionRunner = async () => ({ outcome: "ok", answer: "read only, nothing to change", sessionId: "s1", branch: "lykos/s1", commits });
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await withServer({ workspace: ws, run }, async (client) => {
        const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "keep going", session_id: "s1", specialist: "test-writer" } });
        const data = textOf(res);
        const seal = data.seal as Record<string, unknown> | undefined;
        assert.equal(seal?.status, "intact", JSON.stringify(data));
      });
    } finally {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("T206: continuation with both session_id and base", () => {
  it("ignores base when session_id is present and uses the session branch's seal", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-mcp-cont-base-ws-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@e"], { cwd: ws });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: ws });
    sealKeyInit(ws);
    execFileSync("git", ["checkout", "-q", "-b", "lykos/s1"], { cwd: ws });
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "test"), { recursive: true });
    writeFileSync(join(ws, "src", "add.mjs"), "export function add(a, b) { return 0; }\n");
    writeFileSync(
      join(ws, "test", "add.test.mjs"),
      'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ndescribe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n',
    );
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "red: add"], { cwd: ws });
    const created = await sealCreate({ cwd: ws, branch: "lykos/s1", creator: "cli", containmentLevel: "off", ledgerPath: join(ws, ".lykos", "ledger.db") });
    assert.equal(created.ok, true, created.errors?.join("\n"));
    execFileSync("git", ["checkout", "-q", "main"], { cwd: ws });

    let seen: SessionRequest | undefined;
    const run: SessionRunner = async ({ request }) => { seen = request; return { outcome: "ok", answer: "done", sessionId: "s1" }; };
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await withServer({ workspace: ws, run }, async (client) => {
        await client.callTool({ name: "lykos_implement", arguments: { brief: "keep going", session_id: "s1", base: "main" } });
        assert.equal(seen?.specialist, "implementer", JSON.stringify(seen));
      });
    } finally {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("T206: a writer continuation by a successor session id that made no commit", () => {
  it("verifies the branch's existing seal instead of claiming it created one", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-mcp-succ-reseal-ws-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@e"], { cwd: ws });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: ws });
    sealKeyInit(ws);
    execFileSync("git", ["checkout", "-q", "-b", "lykos/s1"], { cwd: ws });
    mkdirSync(join(ws, "src"), { recursive: true });
    mkdirSync(join(ws, "test"), { recursive: true });
    writeFileSync(join(ws, "src", "add.mjs"), "export function add(a, b) { return 0; }\n");
    writeFileSync(
      join(ws, "test", "add.test.mjs"),
      'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ndescribe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n',
    );
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "red: add"], { cwd: ws });
    const created = await sealCreate({ cwd: ws, branch: "lykos/s1", creator: "cli", containmentLevel: "off", ledgerPath: join(ws, ".lykos", "ledger.db") });
    assert.equal(created.ok, true, created.errors?.join("\n"));
    execFileSync("git", ["checkout", "-q", "main"], { cwd: ws });

    const commits: CommitSummary[] = execFileSync("git", ["log", "--format=%H%x1f%s", "main..lykos/s1"], { cwd: ws, encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [sha, subject] = l.split("\x1f");
        return { sha: sha!, subject: subject! };
      });
    assert.ok(commits.length >= 2, "the branch still carries the red commit and the seal commit");

    const run: SessionRunner = async () => ({ outcome: "ok", answer: "read only, nothing to change", sessionId: "s1", branch: "lykos/s1", commits });
    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await withServer({ workspace: ws, run }, async (client) => {
        const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "keep going", session_id: "succ", specialist: "test-writer" } });
        const data = textOf(res);
        const seal = data.seal as Record<string, unknown> | undefined;
        assert.equal(seal?.status, "intact", JSON.stringify(data));
      });
    } finally {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });
});

describe("T206: a seal.writers run with write_in_place that left a new commit", () => {
  it("creates a seal on the current branch", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-mcp-inplace-writer-ws-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
    execFileSync("git", ["config", "user.name", "t"], { cwd: ws });
    execFileSync("git", ["config", "user.email", "t@e"], { cwd: ws });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    execFileSync("git", ["add", "-A"], { cwd: ws });
    execFileSync("git", ["commit", "-q", "-m", "config"], { cwd: ws });
    sealKeyInit(ws);
    execFileSync("git", ["checkout", "-q", "-b", "feat"], { cwd: ws });

    const run: SessionRunner = async () => {
      mkdirSync(join(ws, "src"), { recursive: true });
      mkdirSync(join(ws, "test"), { recursive: true });
      writeFileSync(join(ws, "src", "add.mjs"), "export function add(a, b) { return 0; }\n");
      writeFileSync(
        join(ws, "test", "add.test.mjs"),
        'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/add.mjs";\ndescribe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n',
      );
      execFileSync("git", ["add", "-A"], { cwd: ws });
      execFileSync("git", ["commit", "-q", "-m", "red: add"], { cwd: ws });
      const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws }).toString().trim();
      return {
        outcome: "ok",
        answer: "written",
        sessionId: "s1",
        write_in_place: true,
        commits: [{ sha, subject: "red: add" }],
      };
    };

    process.env.LYKOS_TRUST_WORKSPACE = "1";
    try {
      await withServer({ workspace: ws, run }, async (client) => {
        const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "write tests", specialist: "test-writer", write_in_place: true } });
        const data = textOf(res);
        assert.equal(data.outcome, "ok", JSON.stringify(data));
        const seal = data.seal as Record<string, unknown> | undefined;
        assert.equal(seal?.status, "created", JSON.stringify(data));
        assert.equal(data.branch, undefined, "write_in_place reports no branch");
      });
    } finally {
      try { rmSync(ws, { recursive: true, force: true }); } catch {}
    }
  });

  describe("T220 review round 1 reproductions", () => {
    function writeStore(ws: string, id: string, verificationCmd = "npm test") {
      const ledgerPath = defaultLedgerPath(ws);
      const ledger = openLedgerSync(ledgerPath);
      try {
        ledger.startSession({ id, brief: "do it", executionShape: "mcp_worker", runtime: "host", workspace: ws, captureMode: "stream" });
        const t = new TranscriptWriter(ledgerPath, id);
        t.append({ kind: "assistant_message", text: "done", final: true });
        const file = t.finalize();
        ledger.endSession({ id, transcriptPath: file.path, transcriptSha256: file.sha256, transcriptBytes: file.bytes } as Parameters<typeof ledger.endSession>[0]);
        ledger.recordOutcome({ id, outcome: "success", outcomeSource: "verification_command", verificationCmd, verificationOutput: "ok\n", verificationExitCode: 0 });
      } finally {
        ledger.close();
      }
    }

    it("1.both.1: write-in-place diff_stat includes the working tree", async () => {
      const ws = mkdtempSync(join(tmpdir(), "lykos-repro-ws-"));
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
      writeFileSync(join(ws, ".gitignore"), ".lykos/\n");
      writeFileSync(join(ws, "README.md"), "one\n");
      execFileSync("git", ["add", "-A"], { cwd: ws });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "first"], { cwd: ws });

      const run: SessionRunner = async ({ request }) => {
        const id = (request as SessionRequest & { newSessionId?: string }).newSessionId ?? "x";
        writeFileSync(join(ws, "README.md"), "one\ntwo\nthree\n");
        writeStore(ws, id);
        return { outcome: "ok", answer: "done", sessionId: id } as SessionOutcome;
      };

      process.env.LYKOS_TRUST_WORKSPACE = "1";
      try {
        await withServer({ workspace: ws, run }, async (client) => {
          const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "do it", write_in_place: true } });
          const r = textOf(res) as { diff_stat?: { files_changed: number; insertions: number; deletions: number } };
          assert.ok(r.diff_stat, "diff_stat present");
          assert.equal(r.diff_stat!.files_changed, 1, "one changed file in the working tree");
          assert.equal(r.diff_stat!.insertions, 2);
          assert.equal(r.diff_stat!.deletions, 0);
        });
      } finally {
        try { rmSync(ws, { recursive: true, force: true }); } catch {}
      }
    });

    it("1.both.2: verification is present when a session ended but seal creation is refused", async () => {
      const ws = mkdtempSync(join(tmpdir(), "lykos-repro2-ws-"));
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
      writeFileSync(join(ws, ".gitignore"), ".lykos/\n");
      writeFileSync(join(ws, "README.md"), "one\n");
      execFileSync("git", ["add", "-A"], { cwd: ws });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "first"], { cwd: ws });

      const run: SessionRunner = async ({ request }) => {
        const id = (request as SessionRequest & { newSessionId?: string }).newSessionId ?? "x";
        const branch = `lykos/${id}`;
        const dir = join(mkdtempSync(join(tmpdir(), "lykos-repro2-wt-")), "wt");
        execFileSync("git", ["worktree", "add", "-q", "-b", branch, dir, "HEAD"], { cwd: ws });
        try {
          mkdirSync(join(dir, "test"), { recursive: true });
          writeFileSync(join(dir, "test", "a.test.mjs"), "// x\n");
          execFileSync("git", ["add", "-A"], { cwd: dir });
          execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "red: a"], { cwd: dir });
        } finally {
          execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: ws });
        }
        writeStore(ws, id, "node --test");
        return { outcome: "ok", answer: "red", sessionId: id, branch } as SessionOutcome;
      };

      process.env.LYKOS_TRUST_WORKSPACE = "1";
      try {
        await withServer({ workspace: ws, run }, async (client) => {
          const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "do it", specialist: "test-writer" } });
          const r = textOf(res) as { outcome: string; message?: string; verification?: any; refusals?: string[]; next?: string };
          assert.equal(r.outcome, "error");
          assert.equal(r.next, "fix_environment", "seal refusal recommends fix_environment, not continue_with_failure");
          assert.ok(r.verification, "verification is present");
          assert.equal(r.verification.outcome, "passed");
          assert.ok(r.refusals);
        });
      } finally {
        try { rmSync(ws, { recursive: true, force: true }); } catch {}
      }
    });

    it("1.both.2: a needs_answer run whose seal creation is refused gets next fix_environment", { timeout: 60_000 }, async () => {
      const ws = mkdtempSync(join(tmpdir(), "lykos-next-ws-"));
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
      writeFileSync(join(ws, ".gitignore"), ".lykos/\n");
      writeFileSync(join(ws, "README.md"), "one\n");
      execFileSync("git", ["add", "-A"], { cwd: ws });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "first"], { cwd: ws });

      const id = "sess-needs-answer-seal";
      const branch = "lykos/T";
      execFileSync("git", ["checkout", "-q", "-b", branch], { cwd: ws });
      writeFileSync(join(ws, "README.md"), "two\n");
      execFileSync("git", ["add", "-A"], { cwd: ws });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "writer work"], { cwd: ws });
      const writerSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" }).trim();
      execFileSync("git", ["checkout", "-q", "main"], { cwd: ws });

      const run: SessionRunner = () => {
        writeStore(ws, id);
        return Promise.resolve({
          outcome: "needs_answer",
          question: "Keep v1 or move to v2?",
          sessionId: id,
          branch,
          commits: [{ sha: writerSha, subject: "writer work" }],
        } as SessionOutcome);
      };

      process.env.LYKOS_TRUST_WORKSPACE = "1";
      try {
        await withServer({ workspace: ws, run }, async (client) => {
          const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "write tests", specialist: "test-writer" } });
          const r = textOf(res) as { outcome: string; next?: string; refusals?: string[]; message?: string };
          assert.equal(r.outcome, "error");
          assert.equal(r.next, "fix_environment");
          assert.ok(Array.isArray(r.refusals));
        });
      } finally {
        try { rmSync(ws, { recursive: true, force: true }); } catch {}
      }
    });

    it("2.both.1: in-place diff_stat is against HEAD at call start even when base is passed", async () => {
      const ws = mkdtempSync(join(tmpdir(), "lykos-repro5-ws-"));
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
      writeFileSync(join(ws, ".gitignore"), ".lykos/\n");
      writeFileSync(join(ws, "README.md"), "one\n");
      execFileSync("git", ["add", "-A"], { cwd: ws });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "c1"], { cwd: ws });
      const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws, encoding: "utf8" }).trim();
      writeFileSync(join(ws, "README.md"), "one\ntwo\n");
      execFileSync("git", ["add", "-A"], { cwd: ws });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "c2"], { cwd: ws });

      const run: SessionRunner = async ({ request }) => {
        const id = (request as SessionRequest & { newSessionId?: string }).newSessionId ?? "x";
        writeFileSync(join(ws, "README.md"), "one\ntwo\nthree\n");
        writeStore(ws, id);
        return { outcome: "ok", answer: "done", sessionId: id } as SessionOutcome;
      };

      process.env.LYKOS_TRUST_WORKSPACE = "1";
      try {
        await withServer({ workspace: ws, run }, async (client) => {
          const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "do it", write_in_place: true, base } });
          const r = textOf(res) as { diff_stat?: { files_changed: number; insertions: number; deletions: number } };
          assert.ok(r.diff_stat, "diff_stat present");
          assert.equal(r.diff_stat!.files_changed, 1);
          assert.equal(r.diff_stat!.insertions, 1, "only the working-tree line, not c2");
          assert.equal(r.diff_stat!.deletions, 0);
        });
      } finally {
        try { rmSync(ws, { recursive: true, force: true }); } catch {}
      }
    });
  });

  describe("T221 review round 1 reproductions", () => {
    it("1.both.1: a refused call (error with no ended session) carries no flags", async () => {
      const ws = mkdtempSync(join(tmpdir(), "t221-repro1-ws-"));
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
      writeFileSync(join(ws, ".gitignore"), ".lykos/\n");
      writeFileSync(join(ws, "README.md"), "one\n");
      mkdirSync(join(ws, "src"), { recursive: true });
      writeFileSync(join(ws, "src", "a.ts"), "export const a = 1;\n");
      execFileSync("git", ["add", "-A"], { cwd: ws });
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "first"], { cwd: ws });

      let n = 0;
      const run: SessionRunner = async ({ request }) => {
        const id = (request as SessionRequest & { newSessionId?: string }).newSessionId ?? `t221-${++n}-${Date.now()}`;
        const branch = `lykos/${id}`;
        const dir = join(mkdtempSync(join(tmpdir(), "t221-repro1-wt-")), "wt");
        execFileSync("git", ["worktree", "add", "-q", "-b", branch, dir, "HEAD"], { cwd: ws });
        try {
          writeFileSync(join(dir, "README.md"), "two\n");
          execFileSync("git", ["add", "-A"], { cwd: dir });
          execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-q", "-m", "change"], { cwd: dir });
        } finally {
          execFileSync("git", ["worktree", "remove", "--force", dir], { cwd: ws });
        }
        // The session started but never ended: no ended_utc on the ledger row.
        const ledger = openLedgerSync(defaultLedgerPath(ws));
        try {
          ledger.startSession({ id, brief: "do it", executionShape: "mcp_worker", runtime: "host", workspace: ws, captureMode: "stream" });
        } finally {
          ledger.close();
        }
        return { outcome: "ok", answer: "changed readme", sessionId: id, branch } as SessionOutcome;
      };

      process.env.LYKOS_TRUST_WORKSPACE = "1";
      try {
        await withServer({ workspace: ws, run }, async (client) => {
          const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "do it", specialist: "test-writer", scope: ["src/**"] } });
          const r = textOf(res) as Record<string, unknown>;
          assert.equal(r.outcome, "error", "precondition: seal/refusal made it an error");
          assert.equal("flags" in r, false, `a refused call carries no flags, got ${JSON.stringify(r.flags)}`);
        });
      } finally {
        try { rmSync(ws, { recursive: true, force: true }); } catch {}
      }
    });
  });
});
