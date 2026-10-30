// T223 (ADR-0056, ADR-0038) ACCEPTANCE: async calls. `lykos_start`, `lykos_status`,
// `lykos_steer`, `lykos_stop`, the lifetime of a started session, `mcp.max_sessions`
// and the `write_in_place` lock.
//
// Seam: the MCP server over an in-memory transport with a stand-in session
// runner (as in mcp-server.test.ts and result-contract-t220.test.ts). The
// stand-in plays the child: it writes the session's ledger row when it starts,
// blocks on a promise the test controls, and on release writes the session file
// and ends the row, the way the real child does. A stopped stand-in ends nothing,
// like a killed child.
//
// The runner seam gains ONE optional field (see t223-rulings.txt):
//   SessionRunInput.onSteerable?: (steer: (message: string) => void | Promise<void>) => void
// The runner calls it once the session can take a steering message, handing the
// server the function that delivers one. Stop uses the existing `signal`.
// The last describe drives the real process runner against a real
// `lykos session-child` and a held model reply, proving a steer frame reaches
// Pi's AgentSession.steer in a running child.
//
// Rulings these tests hold the implementation to (t223-rulings.txt):
// - lykos_start {specialist, brief, constraints?, budget?, containment?, session_id?,
//   write_in_place?, base?} -> {session_id, state: "running"} at once. The request is the
//   one T222's lykos_<specialist> tool builds (specialist set, prompt = brief, never model).
// - lykos_status {session_id | session_ids, wait_seconds? (max 300, clamped), any?} ->
//   {sessions: [{session_id, state, elapsed_seconds, turns, last_tool, cost_usd, question,
//   result?}]}, in the order asked. `result` is the blocking tools' result, built by the same
//   builder, present once the session ended. An id this server never ran -> isError, naming it.
// - lykos_steer on a finished/stopped session -> isError naming session_id resume.
// - lykos_stop aborts through the runner's signal; the server ends the ledger row with notes
//   containing "stopped", leaves resumable = 1 and outcome NULL; state "stopped".
// - Closing the server (transport close) stops every live session the same way.
// - mcp.max_sessions (default 4) counts every live session, blocking calls included; a start
//   over it -> isError with `running: [ids]`. One live write_in_place session per tree
//   (realpath of the workspace); a second, started or blocking, -> isError naming write_in_place.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";
import { createProcessRunner } from "./session-process.js";
import { PROTOCOL_VERSION, type SessionOutcome, type SessionRequest, type SessionRunInput, type SessionRunner } from "./session-protocol.js";
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { TranscriptWriter } from "../session/transcript.js";
import { openCredentialDb } from "../credentials/db.js";
import { upsertCredential } from "../credentials/pool.js";
import { textReply } from "../credentials/fake-anthropic-server.js";

// The trust store and any global config live in a temporary home, never the user's.
const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-t223-home-"));
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

function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: gitEnv() }).trim();
}

function put(dir: string, rel: string, text: string): void {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

/** A plain repository on main with one commit; `config` becomes .lykos/config.yaml. */
function plainRepo(config?: string): string {
  const ws = mkdtempSync(join(tmpdir(), "lykos-t223-ws-"));
  git(ws, "init", "-q", "-b", "main");
  writeFileSync(join(ws, ".gitignore"), ".lykos/\n");
  put(ws, "README.md", "one\n");
  git(ws, "add", "-A");
  git(ws, "commit", "-q", "-m", "first");
  if (config !== undefined) put(ws, ".lykos/config.yaml", config);
  return ws;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A timer that does not keep the process alive: for the losing side of a race. */
const deadline = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

async function waitFor(what: string, check: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) assert.fail(`timed out waiting for: ${what}`);
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------
// The extended seam, typed locally so this file compiles against today's protocol.

type SteerFn = (message: string) => void | Promise<void>;
type T223RunInput = SessionRunInput & { onSteerable?: (steer: SteerFn) => void };

interface Verification {
  cmd: string;
  exit: number;
  output: string;
}

interface Live {
  id: string;
  request: SessionRequest;
  steers: string[];
  aborted: boolean;
  finished: boolean;
  /** Ends the session on its own: the session file, the row's end, a verification when given. */
  finish(verification?: Verification): void;
}

/** Like the child: the session's ledger row exists from its start. */
function startRow(ws: string, id: string): void {
  const ledger = openLedgerSync(defaultLedgerPath(ws));
  try {
    ledger.startSession({ id, brief: "do it", executionShape: "mcp_worker", runtime: "host", workspace: ws, captureMode: "stream" });
  } finally {
    ledger.close();
  }
}

function endRow(ws: string, id: string, verification: Verification | undefined): void {
  const ledgerPath = defaultLedgerPath(ws);
  const ledger = openLedgerSync(ledgerPath);
  try {
    const transcript = new TranscriptWriter(ledgerPath, id);
    transcript.append({ kind: "assistant_message", text: "transcript: finished", final: false });
    const file = transcript.finalize();
    ledger.endSession({ id, transcriptPath: file.path, transcriptSha256: file.sha256, transcriptBytes: file.bytes } as Parameters<typeof ledger.endSession>[0]);
    if (verification !== undefined) {
      ledger.recordOutcome({
        id,
        outcome: verification.exit === 0 ? "success" : "fail",
        outcomeSource: "verification_command",
        verificationCmd: verification.cmd,
        verificationOutput: verification.output,
        verificationExitCode: verification.exit,
      });
    }
  } finally {
    ledger.close();
  }
}

interface Row {
  ended_utc: string | null;
  notes: string | null;
  resumable: number | null;
  outcome: string | null;
}

function rowOf(ws: string, id: string): Row | undefined {
  const ledger = openLedgerSync(defaultLedgerPath(ws));
  try {
    return ledger.db.prepare("SELECT ended_utc, notes, resumable, outcome FROM sessions WHERE id = ?").get(id) as Row | undefined;
  } finally {
    ledger.close();
  }
}

/** A stand-in runner whose sessions run until the test finishes them, are stopped, or the server goes. */
function heldRunner(ws: string): { run: SessionRunner; lives: Live[]; releaseAll(): void } {
  const lives: Live[] = [];
  let n = 0;
  const run: SessionRunner = (raw) => {
    const input = raw as T223RunInput;
    const request = input.request;
    const continuation = request.sessionId !== undefined;
    const id = request.sessionId ?? request.newSessionId ?? `standin-${++n}-${Date.now()}`;
    if (!continuation) startRow(ws, id);
    return new Promise<SessionOutcome>((resolve) => {
      const live: Live = {
        id,
        request,
        steers: [],
        aborted: false,
        finished: false,
        finish(verification) {
          if (live.finished) return;
          live.finished = true;
          if (!continuation) endRow(ws, id, verification);
          resolve({ outcome: "ok", answer: "runner: done", sessionId: id });
        },
      };
      input.onSteerable?.((message) => {
        live.steers.push(message);
      });
      const onAbort = (): void => {
        if (live.finished) return;
        live.aborted = true;
        live.finished = true;
        // What session-process.ts returns for a cancelled call: the child was killed and ended nothing.
        resolve({ outcome: "error", message: "the call was cancelled; the session process was stopped", sessionId: id });
      };
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
      lives.push(live);
    });
  };
  return {
    run,
    lives,
    releaseAll() {
      for (const live of lives) live.finish();
    },
  };
}

interface Harness {
  client: Client;
  server: ReturnType<typeof createMcpServer>;
}

async function withServer<T>(ws: string, run: SessionRunner, body: (h: Harness) => Promise<T>, cleanup?: () => void): Promise<T> {
  const server = createMcpServer({ workspace: ws, version: "0.0.1-test", trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t223-store-")), "trust.json"), run });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t223", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await body({ client, server });
  } finally {
    cleanup?.();
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

interface Called {
  isError: boolean;
  text: string;
  json: Record<string, unknown> | undefined;
}

/** A tool call that never throws: an unknown tool or a protocol error is an error result here, so a test fails on an assertion. */
async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<Called> {
  try {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.map((c) => c.text ?? "").join("\n");
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = undefined;
    }
    return { isError: res.isError === true, text, json };
  } catch (err) {
    return { isError: true, text: err instanceof Error ? err.message : String(err), json: undefined };
  }
}

async function start(client: Client, args: Record<string, unknown> = {}): Promise<Called & { id: string | undefined }> {
  const r = await tool(client, "lykos_start", { specialist: "implementer", brief: "do it", ...args });
  const id = r.json?.session_id;
  return { ...r, id: typeof id === "string" ? id : undefined };
}

/** Starts a session and insists it started. */
async function started(client: Client, args: Record<string, unknown> = {}): Promise<string> {
  const r = await start(client, args);
  assert.equal(r.isError, false, `lykos_start was refused: ${r.text}`);
  assert.equal(typeof r.id, "string", `lykos_start returns a session_id: ${r.text}`);
  return r.id!;
}

interface Entry {
  session_id: string;
  state: string;
  elapsed_seconds?: unknown;
  turns?: unknown;
  last_tool?: unknown;
  cost_usd?: unknown;
  question?: unknown;
  result?: Record<string, unknown> & { outcome?: string; sessionId?: string; next?: string; verification?: { command: string | null; outcome: string } };
}

async function status(client: Client, args: Record<string, unknown>): Promise<Called & { sessions: Entry[] }> {
  const r = await tool(client, "lykos_status", args);
  const sessions = Array.isArray(r.json?.sessions) ? (r.json!.sessions as Entry[]) : [];
  return { ...r, sessions };
}

async function stateOf(client: Client, id: string): Promise<Entry> {
  const r = await status(client, { session_id: id });
  assert.equal(r.isError, false, `lykos_status was refused: ${r.text}`);
  assert.equal(r.sessions.length, 1, r.text);
  return r.sessions[0]!;
}

const PASSING: Verification = { cmd: "npm test", exit: 0, output: "# pass 3\n# fail 0\n" };

// ---------------------------------------------------------------------------

describe("T223 ACCEPTANCE: lykos_start returns before the session's first model call ends", () => {
  it("returns a session_id while the session is still running, and the session is running", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async ({ client }) => {
      const call = start(client, { brief: "implement the parser" });
      const first = await Promise.race([call, deadline(5000).then(() => "timeout" as const)]);
      assert.notEqual(first, "timeout", "lykos_start did not return while the session was still running");
      if (first === "timeout") return;
      assert.equal(first.isError, false, first.text);
      assert.equal(typeof first.id, "string", first.text);
      assert.equal(first.json?.state, "running", first.text);
      assert.equal(h.lives.length, 1, "the session was started");
      const live = h.lives[0]!;
      assert.equal(live.finished, false, "the session has not ended: start did not wait for it");
      assert.equal(live.id, first.id, "the session_id is the one the server minted and sent as newSessionId");
      assert.equal(live.request.specialist, "implementer");
      assert.ok(live.request.prompt.includes("implement the parser"), live.request.prompt);
      assert.equal(live.request.model, undefined, "lykos_start has no model input");

      const entry = await stateOf(client, first.id!);
      assert.equal(entry.state, "running");
      assert.equal(entry.session_id, first.id);
      for (const key of ["elapsed_seconds", "turns", "last_tool", "cost_usd", "question"]) {
        assert.ok(key in entry, `status carries ${key} (null when unmeasured): ${JSON.stringify(entry)}`);
      }
      assert.equal(typeof entry.elapsed_seconds, "number");
      assert.equal(entry.question, null, "no pending question (T224 fills it)");
      assert.equal(entry.result, undefined, "no result while running");
    }, h.releaseAll);
  });

  it("starts a read-only specialist by name and refuses one that does not exist, running nothing", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async ({ client }) => {
      await started(client, { specialist: "review", brief: "review the parser" });
      assert.equal(h.lives[0]?.request.specialist, "review");
      const unknown = await start(client, { specialist: "no-such-specialist" });
      assert.equal(unknown.isError, true, unknown.text);
      assert.match(unknown.text, /no-such-specialist/);
      assert.equal(h.lives.length, 1, "an unknown specialist starts nothing");
    }, h.releaseAll);
  });
});

describe("T223 ACCEPTANCE: lykos_status", () => {
  it("with wait_seconds returns early when the session ends, carrying the full result from the same builder as a blocking call", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async ({ client }) => {
      const id = await started(client);
      setTimeout(() => h.lives[0]?.finish(PASSING), 300);
      const t0 = Date.now();
      const r = await status(client, { session_id: id, wait_seconds: 60 });
      const took = Date.now() - t0;
      assert.equal(r.isError, false, r.text);
      assert.ok(took < 10_000, `returned when the session ended, not when the wait expired: ${took} ms`);
      const entry = r.sessions[0]!;
      assert.equal(entry.state, "done", r.text);
      assert.equal(entry.result?.outcome, "ok", JSON.stringify(entry.result));
      assert.equal(entry.result?.sessionId, id);
      assert.equal(entry.result?.verification?.command, "npm test", "the result is built from the ledger, as a blocking call's is");
      assert.equal(entry.result?.next, "review_or_accept");

      // A wait above the maximum is clamped, not refused; on an ended session it returns at once.
      const t1 = Date.now();
      const again = await status(client, { session_id: id, wait_seconds: 100_000 });
      assert.equal(again.isError, false, again.text);
      assert.ok(Date.now() - t1 < 5000);
      assert.equal(again.sessions[0]?.state, "done");
    }, h.releaseAll);
  });

  it("with several ids and any returns at the first that ends; without any it waits for all or the wait's end", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async ({ client }) => {
      const a = await started(client, { brief: "a" });
      const b = await started(client, { brief: "b" });
      const liveA = h.lives.find((l) => l.id === a)!;
      const liveB = h.lives.find((l) => l.id === b)!;
      setTimeout(() => liveA.finish(PASSING), 300);
      const t0 = Date.now();
      const first = await status(client, { session_ids: [a, b], wait_seconds: 60, any: true });
      assert.equal(first.isError, false, first.text);
      assert.ok(Date.now() - t0 < 10_000, "any returns at the first that ends");
      assert.deepEqual(first.sessions.map((e) => e.session_id), [a, b], "entries come back in the order asked");
      assert.equal(first.sessions[0]!.state, "done");
      assert.equal(first.sessions[1]!.state, "running");

      // Without any, a wait that expires returns what is true then; it is not an error.
      const t1 = Date.now();
      const expired = await status(client, { session_ids: [a, b], wait_seconds: 1 });
      const took = Date.now() - t1;
      assert.equal(expired.isError, false, expired.text);
      assert.ok(took >= 800 && took < 10_000, `without any it waited for all, up to wait_seconds: ${took} ms`);
      assert.equal(expired.sessions[1]!.state, "running");

      setTimeout(() => liveB.finish(PASSING), 300);
      const all = await status(client, { session_ids: [a, b], wait_seconds: 60 });
      assert.deepEqual(all.sessions.map((e) => e.state), ["done", "done"], all.text);
    }, h.releaseAll);
  });

  it("refuses an id this server never ran, naming it", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async ({ client }) => {
      const r = await status(client, { session_id: "no-such-session" });
      assert.equal(r.isError, true, r.text);
      assert.match(r.text, /no-such-session/);
    }, h.releaseAll);
  });
});

describe("T223 ACCEPTANCE: lykos_steer", () => {
  it("reaches a running session; on a finished one it is refused, naming resume by session_id", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async ({ client }) => {
      const id = await started(client);
      const steered = await tool(client, "lykos_steer", { session_id: id, message: "use the streaming API instead" });
      assert.equal(steered.isError, false, steered.text);
      await waitFor("the steer reaches the session", () => (h.lives[0]?.steers.length ?? 0) > 0, 3000);
      assert.deepEqual(h.lives[0]!.steers, ["use the streaming API instead"]);

      h.lives[0]!.finish(PASSING);
      const done = await status(client, { session_id: id, wait_seconds: 30 });
      assert.equal(done.sessions[0]?.state, "done", done.text);
      const refused = await tool(client, "lykos_steer", { session_id: id, message: "one more thing" });
      assert.equal(refused.isError, true, refused.text);
      assert.match(refused.text, /resum/i, "the refusal points at resume");
      assert.match(refused.text, /session_id/);
      assert.ok(refused.text.includes(id), "the refusal names the session");
      assert.deepEqual(h.lives[0]!.steers, ["use the streaming API instead"], "nothing reached a finished session");

      const unknown = await tool(client, "lykos_steer", { session_id: "no-such-session", message: "hi" });
      assert.equal(unknown.isError, true, unknown.text);
    }, h.releaseAll);
  });
});

describe("T223 ACCEPTANCE: lykos_stop", () => {
  it("stops a running session through its signal, records it stopped and resumable, and session_id continues it", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async ({ client }) => {
      const id = await started(client);
      const stopped = await tool(client, "lykos_stop", { session_id: id });
      assert.equal(stopped.isError, false, stopped.text);
      await waitFor("the runner's signal is aborted", () => h.lives[0]?.aborted === true, 3000);

      const r = await status(client, { session_id: id, wait_seconds: 10 });
      assert.equal(r.sessions[0]?.state, "stopped", r.text);

      await waitFor("the ledger records the session stopped", () => rowOf(ws, id)?.ended_utc != null, 3000);
      const row = rowOf(ws, id)!;
      assert.match(row.notes ?? "", /stopped/, `the row says it was stopped: ${JSON.stringify(row)}`);
      assert.equal(row.resumable, 1, "a stopped session stays resumable");
      assert.equal(row.outcome, null, "stopping grades nothing");

      const steer = await tool(client, "lykos_steer", { session_id: id, message: "late" });
      assert.equal(steer.isError, true, "a stopped session cannot be steered");
      assert.match(steer.text, /resum/i);

      const resumed = await start(client, { brief: "carry on", session_id: id });
      assert.equal(resumed.isError, false, resumed.text);
      assert.equal(resumed.id, id, "the continuation answers to the same session_id");
      const cont = h.lives[1];
      assert.ok(cont !== undefined, "the continuation ran");
      assert.equal(cont.request.sessionId, id, "the request continues the stopped session");
      assert.equal(cont.request.newSessionId, undefined);

      const unknown = await tool(client, "lykos_stop", { session_id: "no-such-session" });
      assert.equal(unknown.isError, true, unknown.text);
    }, h.releaseAll);
  });
});

describe("T223 ACCEPTANCE: a session dies with its server", () => {
  it("closing the server stops every live session, started or blocking, and records each stopped and resumable", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    const server = createMcpServer({ workspace: ws, version: "0.0.1-test", trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t223-store-")), "trust.json"), run: h.run });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t223", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await started(client, { brief: "a" });
      await started(client, { brief: "b" });
      const blocking = tool(client, "lykos_implement", { brief: "c" });
      await waitFor("three live sessions", () => h.lives.length === 3, 3000);
      const ids = h.lives.map((l) => l.id);

      await server.close();
      await blocking;
      await waitFor("every live session's signal is aborted", () => h.lives.every((l) => l.aborted), 3000);
      await waitFor("every live session is recorded ended", () => ids.every((id) => rowOf(ws, id)?.ended_utc != null), 3000);
      for (const id of ids) {
        const row = rowOf(ws, id)!;
        assert.match(row.notes ?? "", /stopped/, `${id}: ${JSON.stringify(row)}`);
        assert.equal(row.resumable, 1, `${id} stays resumable`);
        assert.equal(row.outcome, null);
      }
    } finally {
      h.releaseAll();
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
});

describe("T223 ACCEPTANCE: mcp.max_sessions", () => {
  it("the fifth live session is refused at the default cap, naming the running ids; an ended one frees its slot", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async ({ client }) => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(await started(client, { brief: `task ${i}` }));
      const fifth = await start(client, { brief: "one too many" });
      assert.equal(fifth.isError, true, fifth.text);
      assert.equal(h.lives.length, 4, "the refused start ran nothing");
      assert.deepEqual([...((fifth.json?.running as string[] | undefined) ?? [])].sort(), [...ids].sort(), fifth.text);
      for (const id of ids) assert.ok(fifth.text.includes(id), `the refusal names ${id}`);

      h.lives[0]!.finish(PASSING);
      await status(client, { session_id: ids[0], wait_seconds: 30 });
      await started(client, { brief: "now there is room" });
    }, h.releaseAll);
  });

  it("blocking calls count toward the cap", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async ({ client }) => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push(await started(client, { brief: `task ${i}` }));
      const blocking = tool(client, "lykos_implement", { brief: "a blocking call" });
      await waitFor("the blocking call's session is live", () => h.lives.length === 4, 3000);
      const blockingId = h.lives[3]!.id;
      const refused = await start(client, { brief: "one too many" });
      assert.equal(refused.isError, true, refused.text);
      assert.deepEqual([...((refused.json?.running as string[] | undefined) ?? [])].sort(), [...ids, blockingId].sort(), refused.text);
      h.lives[3]!.finish(PASSING);
      await blocking;
    }, h.releaseAll);
  });

  it("mcp.max_sessions in the project config overrides the default", async () => {
    const ws = plainRepo("mcp:\n  max_sessions: 2\n");
    const h = heldRunner(ws);
    await withServer(ws, h.run, async ({ client }) => {
      await started(client, { brief: "a" });
      await started(client, { brief: "b" });
      const third = await start(client, { brief: "c" });
      assert.equal(third.isError, true, third.text);
      assert.equal(h.lives.length, 2);
      assert.equal(((third.json?.running as string[] | undefined) ?? []).length, 2, third.text);
    }, h.releaseAll);
  });
});

describe("T223 ACCEPTANCE: one write_in_place session per tree", () => {
  it("a second write_in_place session on the tree is refused, started or blocking; others still run; the lock frees on end", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async ({ client }) => {
      await started(client, { brief: "in place", write_in_place: true });
      const second = await start(client, { brief: "in place too", write_in_place: true });
      assert.equal(second.isError, true, second.text);
      assert.match(second.text, /write_in_place/);
      assert.equal(h.lives.length, 1, "the refused start ran nothing");

      const blocking = await tool(client, "lykos_implement", { brief: "blocking in place", write_in_place: true });
      assert.equal(blocking.isError, true, blocking.text);
      assert.match(blocking.text, /write_in_place/);
      assert.equal(h.lives.length, 1, "the refused blocking call ran nothing");

      await started(client, { brief: "on a branch of its own" });
      assert.equal(h.lives.length, 2);

      const holder = h.lives[0]!;
      holder.finish(PASSING);
      await status(client, { session_id: holder.id, wait_seconds: 30 });
      await started(client, { brief: "in place, after", write_in_place: true });
    }, h.releaseAll);
  });
});

// ---------------------------------------------------------------------------
// The real child: a steer frame on stdin reaches Pi's AgentSession.steer.

const PROVIDER = "fakeprov";

interface HeldModel {
  baseUrl: string;
  bodies: string[];
  firstArrived: Promise<void>;
  releaseFirst(): void;
  close(): Promise<void>;
}

/** An Anthropic Messages stand-in that holds its first reply until released, and keeps every request body. */
async function heldModel(): Promise<HeldModel> {
  const bodies: string[] = [];
  let releaseFirst!: () => void;
  const released = new Promise<void>((r) => (releaseFirst = r));
  let arrived!: () => void;
  const firstArrived = new Promise<void>((r) => (arrived = r));
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += String(c)));
    req.on("end", () => {
      bodies.push(body);
      const n = bodies.length;
      const reply = (): void => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(textReply(n === 1 ? "first answer" : "steered answer"));
      };
      if (n === 1) {
        arrived();
        void released.then(reply);
      } else reply();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bodies,
    firstArrived,
    releaseFirst: () => releaseFirst(),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

describe("T223 ACCEPTANCE: steering a real session-child", () => {
  it("a steer sent while the child's first model call is in flight is queued in the session and reaches the next model call", { timeout: 90_000 }, async () => {
    const model = await heldModel();
    const root = mkdtempSync(join(tmpdir(), "lykos-t223-child-"));
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(join(home, ".lykos"), { recursive: true });
    mkdirSync(join(workspace, ".lykos"), { recursive: true });
    writeFileSync(
      join(workspace, ".lykos", "config.yaml"),
      ["providers:", `  ${PROVIDER}:`, "    auth: api_key", `    baseUrl: ${model.baseUrl}`, "    api: anthropic-messages", "    models:", "      - id: m1", ""].join("\n"),
    );
    writeFileSync(join(workspace, ".gitignore"), ".lykos/\n");
    writeFileSync(join(workspace, "README.md"), "fixture\n");
    const sh = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, stdio: "pipe" });
    sh("init", "-q");
    sh("add", "-A");
    sh("commit", "-q", "-m", "fixture");
    const dbPath = join(root, "credentials.db");
    const db = openCredentialDb(dbPath, { create: true })!;
    try {
      upsertCredential(db, PROVIDER, { type: "api_key", key: "pooled-key" });
    } finally {
      db.close();
    }
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), LYKOS_CREDENTIALS_DB: dbPath, LYKOS_SESSION_PROGRESS_MS: "50" };

    const runner = createProcessRunner({ env, exitGraceMs: 2000 });
    const controller = new AbortController();
    const progress: string[] = [];
    let steer: SteerFn | undefined;
    const input: T223RunInput = {
      request: {
        version: PROTOCOL_VERSION,
        tool: "lykos_implement",
        workspace,
        prompt: "Reply with one word.",
        label: "lykos_implement",
        model: `${PROVIDER}/m1`,
        containment: "off",
      },
      trustSource: "flag",
      onProgress: (m) => progress.push(m),
      signal: controller.signal,
      onSteerable: (fn) => {
        steer = fn;
      },
    };
    const outcome = runner(input);
    try {
      const arrived = await Promise.race([model.firstArrived.then(() => true), outcome.then(() => false), deadline(60_000).then(() => false)]);
      assert.equal(arrived, true, `the child's first model call never arrived: ${progress.join(" | ")}`);
      assert.ok(steer !== undefined, "the process runner handed the server a steer function (onSteerable)");
      await steer("STEER-MARKER-7: also say the word banana.");
      await waitFor("the child reports the steer queued in its session", () => progress.some((m) => /steer queued/.test(m)), 20_000);
      model.releaseFirst();
      const result = await outcome;
      assert.ok(model.bodies.length >= 2, `the steer started another model call: ${model.bodies.length} call(s), ${JSON.stringify(result)}`);
      assert.ok(!model.bodies[0]!.includes("STEER-MARKER-7"), "the first call predates the steer");
      assert.ok(model.bodies[1]!.includes("STEER-MARKER-7"), "the steering message is in the next model call");
    } finally {
      model.releaseFirst();
      controller.abort();
      await outcome.catch(() => undefined);
      await model.close();
    }
  });
});
