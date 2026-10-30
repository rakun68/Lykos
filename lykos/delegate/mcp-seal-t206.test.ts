// T206 (#61) ACCEPTANCE: sealed TDD through MCP.
//
// Seam 2: the MCP server over an in-memory transport with a stand-in session
// runner, as in mcp-server.test.ts. The stand-in plays the delegated session:
// it makes a worktree on a lykos/ branch from the request's base, commits what
// a test writer or an implementer would, and reports the branch. The server's
// own seal work (create after a writer's run, verify after any run on a sealed
// branch) runs for real, on the host, against that branch.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";
import type { SessionOutcome, SessionRequest, SessionRunner } from "./session-protocol.js";

const cliPath = join(import.meta.dirname, "..", "cli.ts");
const tsxImport = import.meta.resolve("tsx");

const STUB = "export function add(a, b) { return 0; }\n";
const REAL = "export function add(a, b) { return a + b; }\n";
const RED_TEST =
  'import { describe, it } from "node:test";\n' +
  'import assert from "node:assert/strict";\n' +
  'import { add } from "../src/add.mjs";\n' +
  'describe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n';

// The signing key and the trust store live in a temporary home, never the user's.
const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-t206-home-"));
  for (const k of ["HOME", "USERPROFILE", "LYKOS_TRUST_WORKSPACE", "NODE_TEST_CONTEXT"]) saved[k] = process.env[k];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.LYKOS_TRUST_WORKSPACE = "1";
  delete process.env.NODE_TEST_CONTEXT;
});
after(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: env() }).trim();
}

function lykos(cwd: string, ...args: string[]): void {
  const res = spawnSync(process.execPath, ["--import", tsxImport, cliPath, ...args], { cwd, env: env(), encoding: "utf8", timeout: 120_000 });
  assert.equal(res.status, 0, `lykos ${args.join(" ")}:\n${res.stdout}\n${res.stderr}`);
}

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A repository on main with a tracked seal config and a trusted key, and no seal. */
function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "lykos-t206-ws-"));
  git(ws, "init", "-q", "-b", "main");
  put(ws, ".lykos/config.yaml", ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"));
  writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "config");
  lykos(ws, "seal", "key", "init");
  return ws;
}

interface Recorded {
  request: SessionRequest & { specialist?: string; base?: string };
  sawSealedTest?: boolean;
}

/**
 * The stand-in session: a worktree on `lykos/<id>` from the request's base (or
 * main's HEAD), where `work` writes and commits. It reports the branch as the
 * real runner does.
 */
function standIn(ws: string, calls: Recorded[], work: (dir: string, req: Recorded["request"]) => void): SessionRunner {
  let n = 0;
  return async ({ request }) => {
    const req = request as Recorded["request"];
    const rec: Recorded = { request: req };
    calls.push(rec);
    const id = `s${++n}-${Date.now()}`;
    const branch = `lykos/${id}`;
    const dir = join(mkdtempSync(join(tmpdir(), "lykos-t206-wt-")), "wt");
    git(ws, "worktree", "add", "-q", "-b", branch, dir, req.base ?? "HEAD");
    try {
      rec.sawSealedTest = (() => {
        try {
          return readFileSync(join(dir, "test/add.test.mjs"), "utf8").replace(/\r\n/g, "\n") === RED_TEST;
        } catch {
          return false;
        }
      })();
      work(dir, req);
    } finally {
      git(ws, "worktree", "remove", "--force", dir);
    }
    const outcome: SessionOutcome = { outcome: "ok", answer: "done", sessionId: id, branch };
    return outcome;
  };
}

const writeRed = (dir: string) => {
  put(dir, "src/add.mjs", STUB);
  put(dir, "test/add.test.mjs", RED_TEST);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "red: add");
};
const implement = (dir: string) => {
  put(dir, "src/add.mjs", REAL);
  git(dir, "commit", "-qam", "implement add");
};
const weaken = (dir: string) => {
  put(dir, "test/add.test.mjs", "// gone\n");
  git(dir, "commit", "-qam", "weaken");
};

async function withServer<T>(ws: string, run: SessionRunner, body: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer({ workspace: ws, version: "0.0.1-test", trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t206-store-")), "trust.json"), run });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t206", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await body(client);
  } finally {
    await client.close();
    await server.close();
  }
}

type Result = Record<string, unknown> & {
  outcome: string;
  branch?: string;
  seal?: { status: string; paths?: string[]; contained?: boolean };
  disputes?: unknown[];
};

async function call(client: Client, args: Record<string, unknown>, tool = "lykos_implement"): Promise<Result> {
  const res = await client.callTool({ name: tool, arguments: { brief: "do it", ...args } });
  const content = res.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]!.text) as Result;
}

/** Writer's run on a fresh workspace; returns the sealed branch. */
async function sealedBranch(client: Client): Promise<string> {
  const r = await call(client, { specialist: "test-writer" });
  assert.equal(r.seal?.status, "created", JSON.stringify(r));
  return r.branch!;
}

describe("T206 ACCEPTANCE: the new inputs", () => {
  it("every task tool takes optional specialist and base", async () => {
    const ws = workspace();
    await withServer(ws, async () => ({ outcome: "ok", answer: "", sessionId: "x" }), async (client) => {
      const { tools } = await client.listTools();
      const taskTools = tools.filter((t) =>
        ["lykos_implement", "lykos_refactor", "lykos_debug", "lykos_review"].includes(t.name),
      );
      assert.equal(taskTools.length, 4);
      for (const t of taskTools) {
        const schema = t.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
        assert.ok("specialist" in (schema.properties ?? {}), `${t.name} takes specialist`);
        assert.ok("base" in (schema.properties ?? {}), `${t.name} takes base`);
        assert.deepEqual(schema.required, ["brief"]);
      }
    });
  });
});

describe("T206 ACCEPTANCE: the seal through MCP", () => {
  it("a test-writer call that commits red tests returns seal: created, and the seal is on its branch", async () => {
    const ws = workspace();
    const calls: Recorded[] = [];
    await withServer(ws, standIn(ws, calls, writeRed), async (client) => {
      const r = await call(client, { specialist: "test-writer" });
      assert.equal(calls[0]!.request.specialist, "test-writer");
      assert.equal(r.seal?.status, "created", JSON.stringify(r));
      assert.ok(r.seal?.paths?.includes("test/add.test.mjs"), JSON.stringify(r.seal));
      assert.equal(r.seal?.contained, false, "the run was not contained");
      const files = git(ws, "ls-tree", "-r", "--name-only", r.branch!).split("\n");
      assert.ok(files.some((f) => /^\.lykos\/seals\/.+\.json$/.test(f) && !f.includes("/keys/")), `a seal file on ${r.branch}: ${files}`);
    });
  });

  it("an implementer call with base set to the writer's branch starts from it, sees the sealed test, and an honest change is intact", async () => {
    const ws = workspace();
    const calls: Recorded[] = [];
    let step = 0;
    await withServer(ws, standIn(ws, calls, (dir) => (step++ === 0 ? writeRed(dir) : implement(dir))), async (client) => {
      const base = await sealedBranch(client);
      const r = await call(client, { specialist: "implementer", base });
      assert.equal(calls[1]!.request.base, base, "the request carries base");
      assert.equal(calls[1]!.sawSealedTest, true, "the implementer's worktree starts from the writer's branch");
      assert.equal(r.seal?.status, "intact", JSON.stringify(r));
    });
  });

  it("an implementer call that changes a sealed test returns seal: tampered with the path", async () => {
    const ws = workspace();
    const calls: Recorded[] = [];
    let step = 0;
    await withServer(ws, standIn(ws, calls, (dir) => (step++ === 0 ? writeRed(dir) : weaken(dir))), async (client) => {
      const base = await sealedBranch(client);
      const r = await call(client, { specialist: "implementer", base });
      assert.equal(r.seal?.status, "tampered", JSON.stringify(r));
      assert.ok(r.seal?.paths?.includes("test/add.test.mjs"), JSON.stringify(r.seal));
    });
  });
});

describe("T206 ACCEPTANCE: choosing the specialist", () => {
  it("lykos_implement with no specialist runs implementer from a sealed branch and build otherwise; an explicit one wins", async () => {
    const ws = workspace();
    const calls: Recorded[] = [];
    let step = 0;
    await withServer(ws, standIn(ws, calls, (dir) => (step++ === 0 ? writeRed(dir) : undefined)), async (client) => {
      const base = await sealedBranch(client);
      await call(client, { base });
      await call(client, {});
      await call(client, { base, specialist: "general" });
      assert.equal(calls[1]!.request.specialist, "implementer", "a sealed starting branch defaults to implementer");
      assert.equal(calls[2]!.request.specialist ?? "build", "build", "an unsealed one defaults to build");
      assert.equal(calls[3]!.request.specialist, "general", "an explicit specialist always wins");
    });
  });
});

describe("T206 ACCEPTANCE: what does not change", () => {
  it("a call without base starts from HEAD as before, and a project without seal files gets no new fields", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos-t206-plain-"));
    git(ws, "init", "-q", "-b", "main");
    git(ws, "commit", "-q", "--allow-empty", "-m", "first");
    const calls: Recorded[] = [];
    await withServer(ws, standIn(ws, calls, () => undefined), async (client) => {
      const r = await call(client, {});
      assert.equal("base" in calls[0]!.request, false, "no base in the request");
      assert.equal("seal" in r, false, JSON.stringify(r));
      assert.equal("disputes" in r, false, JSON.stringify(r));
    });
  });
});

describe("T206 ACCEPTANCE: disputes", () => {
  it("a delegated run's disputes are returned, and one failing only on disputed tests returns outcome disputed", async () => {
    const ws = workspace();
    const dispute = { test: { file: "test/add.test.mjs", describe: ["math"], name: "adds" }, reason: "r", evidence: "e", status: "open" };
    let step = 0;
    const calls: Recorded[] = [];
    const base = standIn(ws, calls, (dir) => (step++ === 0 ? writeRed(dir) : undefined));
    // The child session reports its disputes and its disputed ending; the server must carry both to the caller.
    const run: SessionRunner = async (input) => {
      const out = await base(input);
      if (step <= 1) return out;
      return { ...out, outcome: "disputed", disputes: [dispute] } as unknown as SessionOutcome;
    };
    await withServer(ws, run, async (client) => {
      const sealed = await sealedBranch(client);
      const r = await call(client, { specialist: "implementer", base: sealed });
      assert.equal(r.outcome, "disputed", JSON.stringify(r));
      assert.deepEqual(r.disputes, [dispute]);
    });
  });
});
