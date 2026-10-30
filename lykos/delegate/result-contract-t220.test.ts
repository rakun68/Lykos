// T220 (ADR-0056) ACCEPTANCE: the MCP result contract.
//
// Seam: the MCP server over an in-memory transport with a stand-in session
// runner, as in mcp-server.test.ts and mcp-seal-t206.test.ts. The stand-in
// plays the delegated session the way the real child does: it writes the
// session's ledger row (through the ledger's own writer API) and its session
// file (the transcript, through TranscriptWriter) at defaultLedgerPath(workspace),
// then returns a result. The server must build the result from those two
// stores after the session ends, never from the runner's text or the stream.
//
// Rulings these tests hold the implementation to (see t220-rulings.txt):
// - A new session's id is minted by the server and sent as `request.newSessionId`;
//   the child runs the session under that id. So the server can find the
//   ledger row even when the runner's result is lost.
// - `verification` = { command, exit, outcome: passed|failed|unverified, output_tail }
//   from the ledger `sessions` row; output_tail is at most 2000 chars, a suffix.
// - outcome: `ok` only with a passing verification; no command -> `unverified`
//   (not isError); a failing verification -> `error`.
// - `answer` is the text of the last `assistant_message` in the session file,
//   with `answer_is_self_report: true`.
// - `seal.status` gains `tamper_attempted`; `seal.attempts` lists
//   { tool, detail, paths } read from the ledger's seal_events for the session
//   (kinds `tamper_attempted` and `vetoed`). The child writes a
//   `tamper_attempted` seal_event for each denied action touching a sealed path.
// - `diff_stat` = { files_changed, insertions, deletions } of the branch against
//   the HEAD the call started from.
// - `next` is one token from a closed set, derived from evidence only.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";
import { encodeFrame, PROTOCOL_VERSION, type SessionOutcome, type SessionRequest, type SessionRunner } from "./session-protocol.js";
import { defaultLedgerPath, openLedgerSync, type SealEventKind } from "../ledger/use.js";
import { TranscriptWriter } from "../session/transcript.js";
import { runSessionChild } from "../cli/session-child.js";
import type { RunStandaloneTaskInput, RunStandaloneTaskResult } from "../session/session.js";

const NEXT_TOKENS = [
  "review_or_accept",
  "inspect_flags",
  "inspect_seal",
  "answer_question",
  "resolve_test_dispute",
  "continue_with_failure",
  "run_verification",
  "fix_environment",
] as const;

const cliPath = join(import.meta.dirname, "..", "cli.ts");
const tsxImport = import.meta.resolve("tsx");

// The signing key and the trust store live in a temporary home, never the user's.
const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-t220-home-"));
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

/** A plain repository on main with one commit and no seal files. */
function plainRepo(): string {
  const ws = mkdtempSync(join(tmpdir(), "lykos-t220-ws-"));
  git(ws, "init", "-q", "-b", "main");
  writeFileSync(join(ws, ".gitignore"), ".lykos/\n");
  put(ws, "README.md", "one\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "first");
  return ws;
}

/** The id the server assigned to this new session, or a stand-in's own when it assigned none. */
function idOf(request: SessionRequest, fallback: string): string {
  const assigned = (request as SessionRequest & { newSessionId?: string }).newSessionId;
  return assigned ?? fallback;
}

interface StoreFixture {
  /** Verification the harness ran: absent means no verification command ran. */
  verification?: { cmd: string; exit: number; output: string };
  /** The session file's assistant messages, in order. */
  said: string[];
  /** seal_events the session's gate or seal extension wrote. */
  sealEvents?: Array<{ branch: string; kind: SealEventKind; paths: string[]; detail: string | Record<string, unknown> }>;
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
    for (const e of f.sealEvents ?? []) {
      ledger.recordSealEvent({ sessionId: id, creator: id, specialist: "implementer", branch: e.branch, kind: e.kind, paths: e.paths, detail: e.detail });
    }
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

async function withServer<T>(ws: string, run: SessionRunner, body: (client: Client) => Promise<T>): Promise<T> {
  const server = createMcpServer({ workspace: ws, version: "0.0.1-test", trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t220-store-")), "trust.json"), run });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t220", version: "0.0.1" });
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
  answer?: string;
  answer_is_self_report?: boolean;
  branch?: string;
  next?: string;
  verification?: { command: string | null; exit: number | null; outcome: string; output_tail?: string };
  seal?: { status: string; paths?: string[]; attempts?: Array<{ tool: string; detail: string; paths: string[] }>; disputes?: unknown[] };
  diff_stat?: { files_changed: number; insertions: number; deletions: number };
};

async function call(client: Client, args: Record<string, unknown> = {}, tool = "lykos_implement"): Promise<{ r: Result; isError: boolean }> {
  const res = await client.callTool({ name: tool, arguments: { brief: "do it", ...args } });
  const content = res.content as Array<{ type: string; text: string }>;
  return { r: JSON.parse(content[0]!.text) as Result, isError: res.isError === true };
}

/** A stand-in that writes the store under the session's id and returns what `reply` gives (the runner's own text). */
function storeRunner(ws: string, fixture: StoreFixture, reply: (id: string) => SessionOutcome | Error, seen: SessionRequest[] = []): SessionRunner {
  let n = 0;
  return async ({ request, onProgress }) => {
    seen.push(request);
    const id = idOf(request, `standin-${++n}-${Date.now()}`);
    onProgress("session starting");
    writeStore(ws, id, fixture);
    const out = reply(id);
    if (out instanceof Error) throw out;
    return out;
  };
}

describe("T220 ACCEPTANCE: verification comes from the harness's own run", () => {
  it("a session whose verification passed returns ok, with verification read from the ledger row, not the runner's text", async () => {
    const ws = plainRepo();
    const output = `${"x".repeat(80)}\n`.repeat(60) + "# tests 12\n# pass 12\n# fail 0\n";
    const fixture: StoreFixture = { verification: { cmd: "npm test", exit: 0, output }, said: ["looking", "transcript: implemented and tested"] };
    const run = storeRunner(ws, fixture, (id) => ({
      outcome: "ok",
      answer: "runner: everything passes",
      sessionId: id,
      // A runner (or a model) cannot supply its own verification.
      verification: { command: "echo trust me", exit: 0, outcome: "passed", output_tail: "fake" },
    }) as unknown as SessionOutcome);
    await withServer(ws, run, async (client) => {
      const { r, isError } = await call(client);
      assert.equal(r.outcome, "ok", JSON.stringify(r));
      assert.equal(isError, false);
      assert.equal(r.verification?.command, "npm test", JSON.stringify(r.verification));
      assert.equal(r.verification?.exit, 0);
      assert.equal(r.verification?.outcome, "passed");
      const tail = r.verification?.output_tail ?? "";
      assert.ok(tail.length > 0 && tail.length <= 2000, `output_tail is capped at 2000 chars: ${tail.length}`);
      assert.ok(output.replace(/\r\n/g, "\n").endsWith(tail.replace(/\r\n/g, "\n")), "output_tail is the end of the recorded output");
      assert.ok(tail.includes("# pass 12"));
      assert.equal(r.next, "review_or_accept");
    });
  });

  it("the answer is the session file's last assistant message, marked as a self-report", async () => {
    const ws = plainRepo();
    const fixture: StoreFixture = { verification: { cmd: "npm test", exit: 0, output: "ok\n" }, said: ["first turn", "transcript: final words"] };
    const run = storeRunner(ws, fixture, (id) => ({ outcome: "ok", answer: "runner: something else", sessionId: id }));
    await withServer(ws, run, async (client) => {
      const { r } = await call(client);
      assert.equal(r.answer, "transcript: final words", JSON.stringify(r));
      assert.equal(r.answer_is_self_report, true);
    });
  });

  it("a session with no verification command returns unverified, never ok, and is not an error", async () => {
    const ws = plainRepo();
    const run = storeRunner(ws, { said: ["done, all tests pass"] }, (id) => ({ outcome: "ok", answer: "done, all tests pass", sessionId: id }));
    await withServer(ws, run, async (client) => {
      const { r, isError } = await call(client);
      assert.equal(r.outcome, "unverified", JSON.stringify(r));
      assert.equal(isError, false, "unverified is not an error");
      assert.deepEqual(
        { command: r.verification?.command, exit: r.verification?.exit, outcome: r.verification?.outcome },
        { command: null, exit: null, outcome: "unverified" },
      );
      assert.equal(r.next, "run_verification");
    });
  });

  it("model text claiming success over a failing verification is not ok, and next is inspect_flags (a MISREPORT, T221)", async () => {
    const ws = plainRepo();
    const fixture: StoreFixture = {
      verification: { cmd: "npm test", exit: 1, output: "# tests 3\n# pass 2\n# fail 1\n" },
      said: ["All tests pass. The task is complete and verified."],
    };
    const run = storeRunner(ws, fixture, (id) => ({ outcome: "ok", answer: "All tests pass. The task is complete and verified.", sessionId: id }));
    await withServer(ws, run, async (client) => {
      const { r, isError } = await call(client);
      assert.equal(r.outcome, "error", JSON.stringify(r));
      assert.equal(isError, true);
      assert.equal(r.verification?.outcome, "failed");
      assert.equal(r.verification?.exit, 1);
      // T221: the claim contradicts the failed verification, a MISREPORT flag, and a flag beats continue_with_failure.
      assert.equal(r.next, "inspect_flags");
      assert.equal(r.answer_is_self_report, true, "the claim rides along as a self-report");
    });
  });
});

describe("T220 ACCEPTANCE: the result is built from the store, not the stream", () => {
  it("the server mints a new session's id and sends it as newSessionId; a continuation sends none", async () => {
    const ws = plainRepo();
    const seen: SessionRequest[] = [];
    const run = storeRunner(ws, { verification: { cmd: "npm test", exit: 0, output: "ok\n" }, said: ["done"] }, (id) => ({ outcome: "ok", answer: "done", sessionId: id }), seen);
    await withServer(ws, run, async (client) => {
      const first = await call(client);
      const assigned = (seen[0] as SessionRequest & { newSessionId?: string }).newSessionId;
      assert.equal(typeof assigned, "string", `a new call carries newSessionId: ${JSON.stringify(seen[0])}`);
      assert.equal(first.r.sessionId, assigned);
      // A continuation names its session through sessionId; it is given no new one.
      await call(client, { session_id: assigned });
      assert.equal((seen[1] as SessionRequest & { newSessionId?: string }).newSessionId, undefined);
      assert.equal(seen[1]!.sessionId, assigned);
    });
  });

  it("a runner whose stream died before the result frame still yields the whole result", async () => {
    const ws = plainRepo();
    const fixture: StoreFixture = { verification: { cmd: "npm test", exit: 0, output: "# pass 4\n" }, said: ["transcript: finished the change"] };
    // What session-process.ts returns when the child's stdout ends before the result line.
    const run = storeRunner(ws, fixture, () => ({ outcome: "error", message: "the session process was killed by SIGKILL before reporting a result" }));
    const seen: SessionRequest[] = [];
    const wrapped: SessionRunner = async (input) => {
      seen.push(input.request);
      return run(input);
    };
    await withServer(ws, wrapped, async (client) => {
      const { r, isError } = await call(client);
      assert.equal(r.outcome, "ok", JSON.stringify(r));
      assert.equal(isError, false);
      assert.equal(r.sessionId, (seen[0] as SessionRequest & { newSessionId?: string }).newSessionId);
      assert.equal(r.verification?.outcome, "passed");
      assert.equal(r.verification?.command, "npm test");
      assert.equal(r.answer, "transcript: finished the change");
      assert.equal(r.answer_is_self_report, true);
      assert.equal(r.next, "review_or_accept");
    });
  });

  it("a runner that rejects after the session ended still yields the whole result", async () => {
    const ws = plainRepo();
    const fixture: StoreFixture = { verification: { cmd: "npm test", exit: 1, output: "# fail 1\n" }, said: ["transcript: stuck on one test"] };
    const run = storeRunner(ws, fixture, () => new Error("stream closed"));
    await withServer(ws, run, async (client) => {
      const { r } = await call(client);
      assert.equal(r.outcome, "error", JSON.stringify(r));
      assert.equal(typeof r.sessionId, "string", "the session is named");
      assert.equal(r.verification?.outcome, "failed");
      assert.equal(r.verification?.exit, 1);
      assert.equal(r.answer, "transcript: stuck on one test");
      assert.equal(r.next, "continue_with_failure", "a session that ended is judged on its verification, not on the lost stream");
    });
  });

  it("the child runs a new session under the id the server sent", async () => {
    const ws = plainRepo();
    const input = new PassThrough();
    const lines: string[] = [];
    const seen: RunStandaloneTaskInput[] = [];
    const request = { version: PROTOCOL_VERSION, tool: "lykos_implement", workspace: ws, prompt: "do it", label: "lykos_implement", newSessionId: "t220-assigned-id" };
    input.write(encodeFrame(request as SessionRequest));
    await runSessionChild({
      input,
      write: (text) => void lines.push(...text.split("\n").filter((l) => l.length > 0)),
      env: { LYKOS_TRUST_SOURCE: "flag" },
      trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t220-store-")), "trust.json"),
      worktreesRoot: mkdtempSync(join(tmpdir(), "lykos-t220-wt-")),
      runTask: async (task): Promise<RunStandaloneTaskResult> => {
        seen.push(task);
        return { status: "ok", sessionId: task.sessionId ?? "none", text: "done", snapshot: {} as never };
      },
    });
    input.end();
    assert.equal(seen[0]?.sessionId, "t220-assigned-id");
    const last = JSON.parse(lines.at(-1)!) as { result: { sessionId?: string; branch?: string } };
    assert.equal(last.result.sessionId, "t220-assigned-id");
    assert.equal(last.result.branch, "lykos/t220-assigned-id");
  });
});

describe("T220 ACCEPTANCE: diff stat", () => {
  it("a writing session's result carries files changed, insertions and deletions against the starting HEAD", async () => {
    const ws = plainRepo();
    let n = 0;
    const run: SessionRunner = async ({ request }) => {
      const id = idOf(request, `diff-${++n}-${Date.now()}`);
      const branch = `lykos/${id}`;
      const dir = join(mkdtempSync(join(tmpdir(), "lykos-t220-wt-")), "wt");
      git(ws, "worktree", "add", "-q", "-b", branch, dir, "HEAD");
      try {
        put(dir, "README.md", "two\n");
        put(dir, "src/a.txt", "a\nb\nc\n");
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "change");
      } finally {
        git(ws, "worktree", "remove", "--force", dir);
      }
      writeStore(ws, id, { verification: { cmd: "npm test", exit: 0, output: "ok\n" }, said: ["done"] });
      return { outcome: "ok", answer: "done", sessionId: id, branch };
    };
    await withServer(ws, run, async (client) => {
      const { r } = await call(client);
      assert.deepEqual(r.diff_stat, { files_changed: 2, insertions: 4, deletions: 1 }, JSON.stringify(r));
    });
  });
});

describe("T220 ACCEPTANCE: a denied write to a sealed path is a tamper attempt", () => {
  const STUB = "export function add(a, b) { return 0; }\n";
  const REAL = "export function add(a, b) { return a + b; }\n";
  const RED_TEST =
    'import { describe, it } from "node:test";\n' +
    'import assert from "node:assert/strict";\n' +
    'import { add } from "../src/add.mjs";\n' +
    'describe("math", () => { it("adds", () => { assert.equal(add(1, 2), 3); }); });\n';

  let ws = "";
  let sealed = "";

  /** A sealed workspace, made once: a writer's run through the server creates the seal (T206). */
  before(async () => {
    ws = mkdtempSync(join(tmpdir(), "lykos-t220-sealed-"));
    git(ws, "init", "-q", "-b", "main");
    put(ws, ".lykos/config.yaml", ["seal:", "  base: main", '  test_command: "node --test {files}"', "containment:", "  level: off", ""].join("\n"));
    writeFileSync(join(ws, ".gitignore"), ".lykos/*\n!.lykos/config.yaml\n!.lykos/seals/\n");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "config");
    const res = spawnSync(process.execPath, ["--import", tsxImport, cliPath, "seal", "key", "init"], { cwd: ws, env: env(), encoding: "utf8", timeout: 120_000 });
    assert.equal(res.status, 0, `seal key init:\n${res.stdout}\n${res.stderr}`);
    const writer: SessionRunner = async ({ request }) => {
      const id = idOf(request, `writer-${Date.now()}`);
      const branch = `lykos/${id}`;
      const dir = join(mkdtempSync(join(tmpdir(), "lykos-t220-wt-")), "wt");
      git(ws, "worktree", "add", "-q", "-b", branch, dir, "HEAD");
      try {
        put(dir, "src/add.mjs", STUB);
        put(dir, "test/add.test.mjs", RED_TEST);
        git(dir, "add", "-A");
        git(dir, "commit", "-q", "-m", "red: add");
      } finally {
        git(ws, "worktree", "remove", "--force", dir);
      }
      return { outcome: "ok", answer: "red", sessionId: id, branch };
    };
    await withServer(ws, writer, async (client) => {
      const { r } = await call(client, { specialist: "test-writer" });
      assert.equal(r.seal?.status, "created", `precondition, a sealed branch (T206): ${JSON.stringify(r)}`);
      sealed = r.branch!;
    });
  });

  /** An implementer that makes the honest change and whose session recorded `events` in the ledger. */
  function implementer(events: (id: string) => NonNullable<StoreFixture["sealEvents"]>): SessionRunner {
    let n = 0;
    return async ({ request }) => {
      const id = idOf(request, `impl-${++n}-${Date.now()}`);
      const branch = `lykos/${id}`;
      const dir = join(mkdtempSync(join(tmpdir(), "lykos-t220-wt-")), "wt");
      git(ws, "worktree", "add", "-q", "-b", branch, dir, request.base ?? "HEAD");
      try {
        put(dir, "src/add.mjs", REAL);
        git(dir, "commit", "-qam", "implement add");
      } finally {
        git(ws, "worktree", "remove", "--force", dir);
      }
      writeStore(ws, id, { verification: { cmd: "node --test test/add.test.mjs", exit: 0, output: "# pass 1\n" }, said: ["implemented add"], sealEvents: events(id) });
      return { outcome: "ok", answer: "implemented add", sessionId: id, branch };
    };
  }

  it("a denied bash write to a sealed path yields seal.status tamper_attempted with the attempt listed", async () => {
    const command = "echo '// gone' > test/add.test.mjs";
    const run = implementer(() => [
      { branch: sealed, kind: "tamper_attempted", paths: ["test/add.test.mjs"], detail: { tool: "bash", detail: command, rule: "auto mode: high" } },
    ]);
    await withServer(ws, run, async (client) => {
      const { r } = await call(client, { specialist: "implementer", base: sealed });
      assert.equal(r.seal?.status, "tamper_attempted", JSON.stringify(r));
      const attempts = r.seal?.attempts ?? [];
      assert.equal(attempts.length, 1, JSON.stringify(attempts));
      assert.equal(attempts[0]!.tool, "bash");
      assert.ok(attempts[0]!.detail.includes(command), attempts[0]!.detail);
      assert.deepEqual(attempts[0]!.paths, ["test/add.test.mjs"]);
      assert.ok(Array.isArray(r.seal?.disputes), "seal carries its disputes");
      // The deny held, the seal is intact and the verification passed: the work stands, but the coordinator is told to look.
      assert.equal(r.outcome, "ok");
      assert.equal(r.next, "inspect_seal");
    });
  });

  it("a vetoed edit or write to a sealed path is listed as an attempt too", async () => {
    const run = implementer(() => [{ branch: sealed, kind: "vetoed", paths: ["test/add.test.mjs"], detail: "write test/add.test.mjs" }]);
    await withServer(ws, run, async (client) => {
      const { r } = await call(client, { specialist: "implementer", base: sealed });
      assert.equal(r.seal?.status, "tamper_attempted", JSON.stringify(r));
      const attempts = r.seal?.attempts ?? [];
      assert.equal(attempts.length, 1, JSON.stringify(attempts));
      assert.equal(attempts[0]!.tool, "write");
      assert.deepEqual(attempts[0]!.paths, ["test/add.test.mjs"]);
    });
  });

  it("the child records a denied action that touches a sealed path in the ledger, and no other denial", async () => {
    const input = new PassThrough();
    const lines: string[] = [];
    let sid = "";
    const request: SessionRequest = { version: PROTOCOL_VERSION, tool: "lykos_implement", workspace: ws, prompt: "do it", label: "lykos_implement", specialist: "implementer", base: sealed };
    input.write(encodeFrame(request));
    await runSessionChild({
      input,
      write: (text) => void lines.push(...text.split("\n").filter((l) => l.length > 0)),
      env: { LYKOS_TRUST_SOURCE: "flag" },
      trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t220-store-")), "trust.json"),
      worktreesRoot: mkdtempSync(join(tmpdir(), "lykos-t220-wt-")),
      runTask: async (task): Promise<RunStandaloneTaskResult> => {
        sid = task.sessionId ?? "";
        return {
          status: "ok",
          sessionId: sid,
          text: "done",
          snapshot: {} as never,
          denied: [
            { kind: "bash", summary: "bash", detail: "echo '// gone' > test/add.test.mjs", rule: "auto mode: high" },
            { kind: "bash", summary: "bash", detail: "rm -rf build", rule: "auto mode: high" },
          ],
        };
      },
    });
    input.end();
    assert.ok(sid.length > 0, "the session ran");
    const ledger = openLedgerSync(defaultLedgerPath(ws));
    let rows;
    try {
      rows = ledger.sealEvents().filter((e) => e.session_id === sid && e.kind === "tamper_attempted");
    } finally {
      ledger.close();
    }
    assert.equal(rows.length, 1, `one tamper_attempted event for the sealed path: ${JSON.stringify(rows)}`);
    assert.deepEqual(JSON.parse(rows[0]!.paths), ["test/add.test.mjs"]);
    assert.ok(String(rows[0]!.detail).includes("echo '// gone' > test/add.test.mjs"), String(rows[0]!.detail));
  });
});

describe("T220 ACCEPTANCE: next on a refused call", () => {
  it("a call refused before a session (untrusted workspace) is blocked with next fix_environment and no verification", async () => {
    const ws = plainRepo();
    const prior = process.env.LYKOS_TRUST_WORKSPACE;
    delete process.env.LYKOS_TRUST_WORKSPACE;
    try {
      await withServer(ws, async () => assert.fail("no session runs"), async (client) => {
        const { r, isError } = await call(client);
        assert.equal(r.outcome, "blocked", JSON.stringify(r));
        assert.equal(isError, true);
        assert.equal(r.next, "fix_environment");
        assert.equal("verification" in r, false);
      });
    } finally {
      if (prior === undefined) delete process.env.LYKOS_TRUST_WORKSPACE;
      else process.env.LYKOS_TRUST_WORKSPACE = prior;
    }
  });
});

describe("T220 ACCEPTANCE: docs/reference/mcp.md is the contract", () => {
  it("lists every result field and every next token", () => {
    const doc = readFileSync(join(import.meta.dirname, "..", "..", "docs", "reference", "mcp.md"), "utf8");
    const fields = [
      "verification", "command", "exit", "output_tail", "passed", "failed", "unverified",
      "seal", "intact", "tampered", "tamper_attempted", "none", "attempts", "disputes",
      "diff_stat", "files_changed", "insertions", "deletions",
      "next", "answer", "answer_is_self_report", "newSessionId",
    ];
    const missingFields = fields.filter((f) => !doc.includes(`\`${f}\``));
    assert.deepEqual(missingFields, [], "every field is named in backticks");
    const missingTokens = NEXT_TOKENS.filter((t) => !doc.includes(`\`${t}\``));
    assert.deepEqual(missingTokens, [], "every next token is named in backticks");
  });
});
