// L1 (#93 items 2, 4 and the second half of 6) ACCEPTANCE: a test writer that did its job.
//
// Seam: the MCP server over an in-memory transport with a stand-in session
// runner, as in result-contract-t220.test.ts and mcp-seal-t206.test.ts. The
// stand-in plays a test-writer session: it commits red tests on a lykos/ branch,
// writes the session's ledger row and session file the way the real child does
// (verification red, because the tests are red by design), and returns. The
// server's own seal creation runs for real against that branch.
//
// Rulings (see l1-rulings.txt):
// - A seal this session created (`seal.status` `created`) puts `next` at
//   `review_or_accept` whatever the verification says, in the slot right after
//   `inspect_flags`: fix_environment > inspect_seal > resolve_test_dispute >
//   answer_question > inspect_flags > review_or_accept (seal created) >
//   continue_with_failure > run_verification > review_or_accept.
// - The seal file the server commits is the server's change, not the session's:
//   it never makes an OUT-OF-SCOPE flag.
// - The `created` seal_events row carries the session's id; `creator` stays `mcp`.
// - A refused seal creation is `fix_environment`, never `continue_with_failure`.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";
import type { SessionOutcome, SessionRequest, SessionRunner } from "./session-protocol.js";
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { TranscriptWriter } from "../session/transcript.js";

const cliPath = join(import.meta.dirname, "..", "cli.ts");
const tsxImport = import.meta.resolve("tsx");

const STUB = "export function add(a, b) { return 0; }\n";
const REAL = "export function add(a, b) { return a + b; }\n";
const RED_TEST =
  'import { describe, it } from "node:test";\n' +
  'import assert from "node:assert/strict";\n' +
  'import { add } from "../src/add.mjs";\n' +
  'describe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n';
const RED_RUN = { cmd: "node --test test/add.test.mjs", exit: 1, output: "# tests 1\n# pass 0\n# fail 1\n" };

// The signing key and the trust store live in a temporary home, never the user's.
const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-l1-home-"));
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

/** A repository on main with a tracked seal config and a trusted key, and no seal (T206). */
function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "lykos-l1-ws-"));
  git(ws, "init", "-q", "-b", "main");
  put(ws, ".lykos/config.yaml", ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"));
  writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "config");
  const res = spawnSync(process.execPath, ["--import", tsxImport, cliPath, "seal", "key", "init"], { cwd: ws, env: env(), encoding: "utf8", timeout: 120_000 });
  assert.equal(res.status, 0, `seal key init:\n${res.stdout}\n${res.stderr}`);
  return ws;
}

interface Store {
  verification?: { cmd: string; exit: number; output: string };
  said: string[];
}

/** What the real child leaves behind: a ledger row and a session file, written through their own writers. */
function writeStore(ws: string, id: string, f: Store): void {
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

/**
 * A stand-in test writer: commits `files` on `lykos/<id>` from HEAD, leaves the
 * store, and returns what `reply` makes of the plain ok result.
 */
function writer(
  ws: string,
  files: Record<string, string>,
  store: Store,
  reply: (out: SessionOutcome & { sessionId: string; branch: string }) => SessionOutcome = (o) => o,
): SessionRunner {
  let n = 0;
  return async ({ request }) => {
    const id = (request as SessionRequest & { newSessionId?: string }).newSessionId ?? `writer-${++n}-${Date.now()}`;
    const branch = `lykos/${id}`;
    const dir = join(mkdtempSync(join(tmpdir(), "lykos-l1-wt-")), "wt");
    git(ws, "worktree", "add", "-q", "-b", branch, dir, request.base ?? "HEAD");
    try {
      for (const [rel, text] of Object.entries(files)) put(dir, rel, text);
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "-m", "red: add");
    } finally {
      git(ws, "worktree", "remove", "--force", dir);
    }
    writeStore(ws, id, store);
    return reply({ outcome: "ok", answer: store.said[store.said.length - 1] ?? "", sessionId: id, branch });
  };
}

const RED_FILES = { "src/add.mjs": STUB, "test/add.test.mjs": RED_TEST };

async function withServer<T>(ws: string, run: SessionRunner, body: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer({ workspace: ws, version: "0.0.1-test", trustPath: join(mkdtempSync(join(tmpdir(), "lykos-l1-store-")), "trust.json"), run });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "l1", version: "0.0.1" });
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
  sessionId?: string;
  next?: string;
  branch?: string;
  verification?: { outcome: string };
  seal?: { status: string; paths?: string[] };
  flags?: Array<{ flag: string; detail: string; files?: string[] }>;
  refusals?: string[];
};

async function call(client: Client, args: Record<string, unknown> = {}): Promise<{ r: Result; isError: boolean }> {
  const res = await client.callTool({ name: "lykos_implement", arguments: { brief: "write the tests", specialist: "test-writer", ...args } });
  const content = res.content as Array<{ type: string; text: string }>;
  return { r: JSON.parse(content[0]!.text) as Result, isError: res.isError === true };
}

describe("L1 ACCEPTANCE: a test writer that created its seal is told to review or accept (#93 item 2)", () => {
  it("a created seal with red verification is ok, not an error, and next is review_or_accept", async () => {
    const ws = workspace();
    const run = writer(ws, RED_FILES, { verification: RED_RUN, said: ["Wrote the red tests for add; they fail against the stub as intended."] });
    await withServer(ws, run, async (client) => {
      const { r, isError } = await call(client);
      assert.equal(r.seal?.status, "created", `precondition, the server sealed the branch: ${JSON.stringify(r)}`);
      assert.equal(r.verification?.outcome, "failed", "precondition, the writer's verification is red by design");
      assert.equal(r.outcome, "ok", JSON.stringify(r));
      assert.equal(isError, false);
      assert.equal("flags" in r, false, `no flag fires: ${JSON.stringify(r.flags)}`);
      assert.equal(r.next, "review_or_accept", "red verification is expected when this session created the seal");
    });
  });

  it("a created seal with no verification command is review_or_accept too", async () => {
    const ws = workspace();
    const run = writer(ws, RED_FILES, { said: ["Wrote the red tests for add."] });
    await withServer(ws, run, async (client) => {
      const { r } = await call(client);
      assert.equal(r.seal?.status, "created", JSON.stringify(r));
      assert.equal(r.next, "review_or_accept", JSON.stringify(r));
    });
  });

  it("the seal file the server commits is not the session's change: a scope covering the writer's files raises no flag", async () => {
    const ws = workspace();
    const run = writer(ws, RED_FILES, { verification: RED_RUN, said: ["Wrote the red tests for add."] });
    await withServer(ws, run, async (client) => {
      const { r } = await call(client, { scope: ["src/**", "test/**"] });
      assert.equal(r.seal?.status, "created", JSON.stringify(r));
      assert.equal("flags" in r, false, `the server's seal commit is outside the session's diff for OUT-OF-SCOPE: ${JSON.stringify(r.flags)}`);
      assert.equal(r.next, "review_or_accept");
    });
  });

  it("a flag outranks a created seal: a phantom commit sha in the answer is inspect_flags", async () => {
    const ws = workspace();
    const run = writer(ws, RED_FILES, { verification: RED_RUN, said: ["Wrote the red tests for add in commit 1a2b3c4d5e."] });
    await withServer(ws, run, async (client) => {
      const { r } = await call(client);
      assert.equal(r.seal?.status, "created", JSON.stringify(r));
      assert.equal(r.flags?.[0]?.flag, "MISREPORT", JSON.stringify(r.flags));
      assert.equal(r.next, "inspect_flags");
      assert.equal(r.outcome, "ok", "a flag never changes the outcome");
    });
  });

  it("a dispute outranks a created seal: a disputed writer run is resolve_test_dispute", async () => {
    const ws = workspace();
    const dispute = { test: { file: "test/add.test.mjs", describe: ["math"], name: "adds" }, reason: "r", evidence: "e", status: "open" };
    const run = writer(ws, RED_FILES, { verification: RED_RUN, said: ["Wrote the red tests for add."] }, (o) => ({ ...o, outcome: "disputed", disputes: [dispute] }) as unknown as SessionOutcome);
    await withServer(ws, run, async (client) => {
      const { r } = await call(client);
      assert.equal(r.seal?.status, "created", JSON.stringify(r));
      assert.equal(r.outcome, "disputed");
      assert.equal(r.next, "resolve_test_dispute");
    });
  });
});

describe("L1 ACCEPTANCE: the created seal event names the session (#93 item 4)", () => {
  it("the seal_events row of kind created carries the session's id, and creator stays mcp", async () => {
    const ws = workspace();
    const run = writer(ws, RED_FILES, { verification: RED_RUN, said: ["Wrote the red tests for add."] });
    await withServer(ws, run, async (client) => {
      const { r } = await call(client);
      assert.equal(r.seal?.status, "created", JSON.stringify(r));
      assert.ok(r.sessionId, "the result names its session");
      const ledger = openLedgerSync(defaultLedgerPath(ws));
      let rows;
      try {
        rows = ledger.sealEvents().filter((e) => e.kind === "created");
      } finally {
        ledger.close();
      }
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.equal(rows[0]!.creator, "mcp");
      assert.equal(rows[0]!.session_id, r.sessionId, `the created event belongs to the writer's session: ${JSON.stringify(rows[0])}`);
      assert.equal(rows[0]!.branch, r.branch);
    });
  });
});

describe("L1 ACCEPTANCE: a refused seal creation (#93 item 6, second half)", () => {
  it("tests that already pass are refused as a seal, and next is fix_environment, never continue_with_failure", async () => {
    const ws = workspace();
    // The tests pass against a real implementation, so the red check refuses the seal.
    const run = writer(ws, { "src/add.mjs": REAL, "test/add.test.mjs": RED_TEST }, { verification: RED_RUN, said: ["Wrote tests for add."] });
    await withServer(ws, run, async (client) => {
      const { r, isError } = await call(client);
      assert.equal(r.outcome, "error", JSON.stringify(r));
      assert.equal(isError, true);
      assert.ok(Array.isArray(r.refusals) && r.refusals.length > 0, `the refusal reasons are returned: ${JSON.stringify(r)}`);
      assert.notEqual(r.seal?.status, "created");
      assert.equal(r.next, "fix_environment");
      const ledger = openLedgerSync(defaultLedgerPath(ws));
      try {
        assert.equal(ledger.sealEvents().filter((e) => e.kind === "created").length, 0, "no created event for a refused seal");
      } finally {
        ledger.close();
      }
    });
  });
});
