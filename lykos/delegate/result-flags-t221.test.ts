// T221 (ADR-0056) ACCEPTANCE: result flags and the scope input.
//
// Seam: the same as result-contract-t220.test.ts. The MCP server over an
// in-memory transport with a stand-in session runner that plays the delegated
// session: it writes the session's ledger row and session file through their own
// writers and, where the case needs one, commits on a `lykos/<id>` branch (or
// edits the caller's tree for write_in_place). Tested through `lykos_implement`,
// which stays as an alias whatever T222 does to the tool list.
//
// Rulings these tests hold the implementation to (see t221-rulings.txt):
// - `scope` is an optional input: an array of glob strings, matched with
//   lykos/seal/matcher.ts (matchAnyGlob) against repo-relative paths.
// - `flags` = [{ flag: "OUT-OF-SCOPE" | "MISREPORT", detail: string, files?: string[] }],
//   omitted (not []) when no flag fires.
// - OUT-OF-SCOPE: the changed files are those of the diff `diff_stat` counts
//   (base..branch, or HEAD-at-start vs the working tree for write_in_place); the
//   flag lists, in `files`, every one no scope glob matches. No scope, no flag.
// - MISREPORT is deterministic: (1) the answer claims passing tests or a passing
//   verification while verification.outcome is `failed`; (2) the answer names a
//   commit sha (7-40 hex) that is neither among the result's commits nor
//   resolvable in the repository.
// - Any flag sets `next: inspect_flags`; a flag beats continue_with_failure and
//   run_verification. Flags never change `outcome` or `isError`.

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
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { TranscriptWriter } from "../session/transcript.js";

// The trust store lives in a temporary home, never the user's.
const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-t221-home-"));
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
  return { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: env() }).trim();
}

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A plain repository on main with one commit, tracked files in three places, and no seal files. */
function plainRepo(): string {
  const ws = mkdtempSync(join(tmpdir(), "lykos-t221-ws-"));
  git(ws, "init", "-q", "-b", "main");
  writeFileSync(join(ws, ".gitignore"), ".lykos/\n");
  put(ws, "README.md", "one\n");
  put(ws, "src/a.ts", "export const a = 1;\n");
  put(ws, "docs/guide.md", "guide\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "first");
  return ws;
}

function idOf(request: SessionRequest, fallback: string): string {
  return (request as SessionRequest & { newSessionId?: string }).newSessionId ?? fallback;
}

interface StoreFixture {
  verification?: { cmd: string; exit: number; output: string };
  said: string[];
}

/** What the real child leaves behind: a ledger row and a session file, written through their own writers. */
function writeStore(ws: string, id: string, f: StoreFixture): void {
  const ledgerPath = defaultLedgerPath(ws);
  const ledger = openLedgerSync(ledgerPath);
  try {
    ledger.startSession({ id, brief: "do it", executionShape: "mcp_worker", runtime: "host", workspace: ws, captureMode: "stream" });
    const transcript = new TranscriptWriter(ledgerPath, id);
    for (const text of f.said) transcript.append({ kind: "assistant_message", text, final: false });
    const file = transcript.finalize();
    ledger.endSession({ id, transcriptPath: file.path, transcriptSha256: file.sha256, transcriptBytes: file.bytes } as Parameters<typeof ledger.endSession>[0]);
    if (f.verification !== undefined) {
      ledger.recordOutcome({
        id,
        outcome: f.verification.exit === 0 ? "success" : "fail",
        outcomeSource: "verification_command",
        verificationCmd: f.verification.cmd,
        verificationOutput: f.verification.output,
        verificationExitCode: f.verification.exit,
      });
    }
  } finally {
    ledger.close();
  }
}

const PASSED = { cmd: "npm test", exit: 0, output: "# pass 3\n# fail 0\n" };
const FAILED = { cmd: "npm test", exit: 1, output: "# tests 3\n# pass 2\n# fail 1\n" };

/** A session that commits `files` on its own `lykos/<id>` branch and leaves `fixture` in the store. */
function branchRunner(ws: string, files: Record<string, string>, fixture: StoreFixture): SessionRunner {
  let n = 0;
  return async ({ request }) => {
    const id = idOf(request, `t221-${++n}-${Date.now()}`);
    const branch = `lykos/${id}`;
    const dir = join(mkdtempSync(join(tmpdir(), "lykos-t221-wt-")), "wt");
    git(ws, "worktree", "add", "-q", "-b", branch, dir, "HEAD");
    try {
      for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "change");
    } finally {
      git(ws, "worktree", "remove", "--force", dir);
    }
    writeStore(ws, id, fixture);
    return { outcome: "ok", answer: fixture.said.at(-1) ?? "", sessionId: id, branch };
  };
}

/** A session that writes nothing and leaves `fixture` in the store. */
function storeRunner(ws: string, fixture: StoreFixture): SessionRunner {
  let n = 0;
  return async ({ request }) => {
    const id = idOf(request, `t221-store-${++n}-${Date.now()}`);
    writeStore(ws, id, fixture);
    return { outcome: "ok", answer: fixture.said.at(-1) ?? "", sessionId: id } as SessionOutcome;
  };
}

async function withServer<T>(ws: string, run: SessionRunner, body: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer({ workspace: ws, version: "0.0.1-test", trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t221-store-")), "trust.json"), run });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t221", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await body(client);
  } finally {
    await client.close();
    await server.close();
  }
}

type Flag = { flag: string; detail: string; files?: string[] };
type Result = Record<string, unknown> & {
  outcome: string;
  next?: string;
  answer?: string;
  flags?: Flag[];
  verification?: { outcome: string };
  diff_stat?: { files_changed: number };
  commits?: Array<{ sha: string }>;
};

async function call(client: Client, args: Record<string, unknown> = {}): Promise<{ r: Result; isError: boolean }> {
  const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "do it", ...args } });
  const content = res.content as Array<{ type: string; text: string }>;
  return { r: JSON.parse(content[0]!.text) as Result, isError: res.isError === true };
}

function flagOf(r: Result, name: string): Flag | undefined {
  return (r.flags ?? []).find((f) => f.flag === name);
}

/** Every flag has the documented shape: a known name, a non-empty detail, files only as a string array. */
function assertFlagShapes(r: Result): void {
  for (const f of r.flags ?? []) {
    assert.ok(["OUT-OF-SCOPE", "MISREPORT"].includes(f.flag), `known flag: ${JSON.stringify(f)}`);
    assert.equal(typeof f.detail, "string");
    assert.ok(f.detail.length > 0, `a flag says why: ${JSON.stringify(f)}`);
    if (f.files !== undefined) assert.ok(Array.isArray(f.files) && f.files.every((x) => typeof x === "string"), JSON.stringify(f));
    assert.deepEqual(Object.keys(f).filter((k) => !["flag", "detail", "files"].includes(k)), [], `no other keys: ${JSON.stringify(f)}`);
  }
}

const SPREAD = { "src/a.ts": "export const a = 2;\n", "src/b.ts": "export const b = 1;\n", "README.md": "two\n", "docs/guide.md": "guide, revised\n" };

describe("T221 ACCEPTANCE: the scope input", () => {
  it("lykos_implement accepts an optional scope: an array of glob strings", async () => {
    const ws = plainRepo();
    await withServer(ws, async () => assert.fail("no session runs"), async (client) => {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === "lykos_implement");
      assert.ok(tool, "lykos_implement is listed");
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string; items?: { type?: string } }>;
      assert.ok(props.scope, `scope is an input: ${JSON.stringify(Object.keys(props))}`);
      assert.equal(props.scope.type, "array");
      assert.equal(props.scope.items?.type, "string");
      assert.ok(!(tool.inputSchema.required ?? []).includes("scope"), "scope is optional");
    });
  });
});

describe("T221 ACCEPTANCE: OUT-OF-SCOPE", () => {
  it("a change outside scope is flagged with the file names, and next is inspect_flags", async () => {
    const ws = plainRepo();
    const run = branchRunner(ws, SPREAD, { verification: PASSED, said: ["changed a and b"] });
    await withServer(ws, run, async (client) => {
      const { r, isError } = await call(client, { scope: ["src/**"] });
      assertFlagShapes(r);
      const flag = flagOf(r, "OUT-OF-SCOPE");
      assert.ok(flag, `OUT-OF-SCOPE fires: ${JSON.stringify(r)}`);
      assert.deepEqual([...(flag.files ?? [])].sort(), ["README.md", "docs/guide.md"], "lists exactly the files no scope glob matches");
      assert.equal(r.next, "inspect_flags");
      // A flag changes what the coordinator should do next, never the outcome.
      assert.equal(r.outcome, "ok");
      assert.equal(isError, false);
      assert.equal(r.diff_stat?.files_changed, 4, "the flag is judged on the diff diff_stat counts");
    });
  });

  it("a scope whose globs match every changed file raises no flag", async () => {
    const ws = plainRepo();
    const run = branchRunner(ws, SPREAD, { verification: PASSED, said: ["changed four files"] });
    await withServer(ws, run, async (client) => {
      const { r } = await call(client, { scope: ["src/**", "docs/*.md", "README.md"] });
      assert.equal("flags" in r, false, `flags is omitted, not empty: ${JSON.stringify(r)}`);
      assert.equal(r.next, "review_or_accept");
    });
  });

  it("no scope input means no OUT-OF-SCOPE flag, however wide the change", async () => {
    const ws = plainRepo();
    const run = branchRunner(ws, SPREAD, { verification: PASSED, said: ["changed four files"] });
    await withServer(ws, run, async (client) => {
      const { r } = await call(client);
      assert.equal(flagOf(r, "OUT-OF-SCOPE"), undefined, JSON.stringify(r));
      assert.equal("flags" in r, false, "a clean result carries no flags field");
      assert.equal(r.next, "review_or_accept");
    });
  });

  it("writing in place, a working-tree change outside scope is flagged", async () => {
    const ws = plainRepo();
    let n = 0;
    const run: SessionRunner = async ({ request }) => {
      const id = idOf(request, `t221-inplace-${++n}-${Date.now()}`);
      put(ws, "src/a.ts", "export const a = 3;\n");
      put(ws, "README.md", "edited in place\n");
      writeStore(ws, id, { verification: PASSED, said: ["edited a"] });
      return { outcome: "ok", answer: "edited a", sessionId: id, write_in_place: true } as SessionOutcome;
    };
    await withServer(ws, run, async (client) => {
      const { r } = await call(client, { scope: ["src/**"], write_in_place: true });
      assertFlagShapes(r);
      const flag = flagOf(r, "OUT-OF-SCOPE");
      assert.ok(flag, `OUT-OF-SCOPE fires in place: ${JSON.stringify(r)}`);
      assert.deepEqual(flag.files, ["README.md"]);
      assert.equal(r.next, "inspect_flags");
    });
  });

  it("a flag beats run_verification: an unverified session out of scope is told to inspect the flags", async () => {
    const ws = plainRepo();
    const run = branchRunner(ws, SPREAD, { said: ["changed four files"] });
    await withServer(ws, run, async (client) => {
      const { r, isError } = await call(client, { scope: ["src/**"] });
      assert.ok(flagOf(r, "OUT-OF-SCOPE"), JSON.stringify(r));
      assert.equal(r.outcome, "unverified");
      assert.equal(isError, false);
      assert.equal(r.next, "inspect_flags");
    });
  });
});

describe("T221 ACCEPTANCE: MISREPORT", () => {
  for (const claim of [
    "All tests pass. The task is complete.",
    "Done: the suite is green.",
    "Verification passed; ready to merge.",
    "Fixed it, tests passing now.",
  ]) {
    it(`an answer claiming green over a red verification is flagged MISREPORT: ${JSON.stringify(claim)}`, async () => {
      const ws = plainRepo();
      const run = storeRunner(ws, { verification: FAILED, said: ["working", claim] });
      await withServer(ws, run, async (client) => {
        const { r, isError } = await call(client);
        assertFlagShapes(r);
        assert.equal(r.answer, claim, "precondition: the claim is the answer");
        assert.ok(flagOf(r, "MISREPORT"), `MISREPORT fires: ${JSON.stringify(r)}`);
        // The flag beats continue_with_failure: a coordinator told the worker misreported reads the flags first.
        assert.equal(r.next, "inspect_flags");
        assert.equal(r.outcome, "error");
        assert.equal(isError, true);
        assert.equal(r.verification?.outcome, "failed");
      });
    });
  }

  it("an honest answer over a red verification raises no flag and stays continue_with_failure", async () => {
    const ws = plainRepo();
    const run = storeRunner(ws, { verification: FAILED, said: ["One test still fails: add returns 0 for negative input."] });
    await withServer(ws, run, async (client) => {
      const { r } = await call(client);
      assert.equal("flags" in r, false, JSON.stringify(r));
      assert.equal(r.next, "continue_with_failure");
    });
  });

  it("a claim of passing tests over a passing verification is not a misreport", async () => {
    const ws = plainRepo();
    const run = storeRunner(ws, { verification: PASSED, said: ["All tests pass."] });
    await withServer(ws, run, async (client) => {
      const { r } = await call(client);
      assert.equal("flags" in r, false, JSON.stringify(r));
      assert.equal(r.next, "review_or_accept");
    });
  });

  it("an answer naming a commit sha that is neither in the result nor in the repository is flagged MISREPORT", async () => {
    const ws = plainRepo();
    const ghost = "4f9e2c7a1b3d5e60";
    const probe = spawnSync("git", ["cat-file", "-e", `${ghost}^{commit}`], { cwd: ws });
    assert.notEqual(probe.status, 0, "precondition: the sha resolves to nothing in this repository");
    const run = branchRunner(ws, { "src/a.ts": "export const a = 9;\n" }, { verification: PASSED, said: [`Committed the fix as ${ghost}.`] });
    await withServer(ws, run, async (client) => {
      const { r, isError } = await call(client);
      assertFlagShapes(r);
      const flag = flagOf(r, "MISREPORT");
      assert.ok(flag, `MISREPORT fires for a commit that does not exist: ${JSON.stringify(r)}`);
      assert.ok(flag.detail.includes(ghost), `the detail names the sha: ${flag.detail}`);
      assert.equal(r.next, "inspect_flags");
      assert.equal(r.outcome, "ok");
      assert.equal(isError, false);
    });
  });

  it("an answer naming a real commit, short or full, raises no flag", async () => {
    const ws = plainRepo();
    const base = git(ws, "rev-parse", "HEAD");
    // The answer names the branch's commit (short) and the base commit (full): both resolve in the repository.
    let n = 0;
    const honest: SessionRunner = async ({ request }) => {
      const id = idOf(request, `t221-real-${++n}-${Date.now()}`);
      const branch = `lykos/${id}`;
      const dir = join(mkdtempSync(join(tmpdir(), "lykos-t221-wt-")), "wt");
      git(ws, "worktree", "add", "-q", "-b", branch, dir, "HEAD");
      let sha = "";
      try {
        put(dir, "src/a.ts", "export const a = 9;\n");
        git(dir, "commit", "-qam", "change");
        sha = git(dir, "rev-parse", "HEAD");
      } finally {
        git(ws, "worktree", "remove", "--force", dir);
      }
      writeStore(ws, id, { verification: PASSED, said: [`Committed ${sha.slice(0, 7)} on top of ${base}.`] });
      return { outcome: "ok", answer: "done", sessionId: id, branch };
    };
    await withServer(ws, honest, async (client) => {
      const { r } = await call(client);
      assert.equal("flags" in r, false, JSON.stringify(r));
      assert.equal(r.next, "review_or_accept");
    });
  });
});

describe("T221 ACCEPTANCE: docs/reference/mcp.md documents the flags", () => {
  it("names the scope input, the flags field, both flags and inspect_flags", () => {
    const doc = readFileSync(join(import.meta.dirname, "..", "..", "docs", "reference", "mcp.md"), "utf8");
    const missing = ["scope", "flags", "OUT-OF-SCOPE", "MISREPORT", "inspect_flags", "files", "detail"].filter((f) => !doc.includes(`\`${f}\``));
    assert.deepEqual(missing, [], "each is named in backticks");
  });
});
