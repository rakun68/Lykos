// T224 (ADR-0056) ACCEPTANCE: questions both ways. A delegated session has two
// tools: `ask_coordinator {question}` and `give_up {question}`.
//
// Seam: the MCP server over an in-memory transport with a stand-in session
// runner (as in async-sessions-t223.test.ts). The stand-in plays the child: it
// writes the session's ledger row when it starts, can ask a question through
// the runner seam, takes the answer as the next steer, and on release writes
// the session file and ends the row.
//
// The runner seam gains ONE optional field (t224-rulings.txt):
//   SessionRunInput.onQuestion?: (question: string) => void
// The runner calls it when the session asks; the answer goes back through the
// steer function T223's onSteerable handed over. On the wire, child -> parent,
// a question is one JSON line {"type":"question","question":string}; the answer
// is T223's steer line, which the child routes to the pending question.
//
// The later describes go through the real process runner (a tiny child script,
// no model) and the real `lykos session-child` against Pi's scripted model,
// proving both tools are on a delegated session's wire and work there.
//
// Rulings these tests hold the implementation to (t224-rulings.txt):
// - A question sets state `waiting` with `question` = its text in lykos_status; a status
//   call waiting on the session wakes on it. lykos_steer on a waiting session answers it,
//   the state goes back to `running`, question back to null. Same session, no new run.
// - A waiting session is live: it counts toward mcp.max_sessions and lykos_stop stops it.
// - Past mcp.ask_timeout (seconds, default 600) the server answers with a notice containing
//   "decide alone"; the session runs on; the result carries unanswered_questions: [question].
// - A blocking call's question is answered at once with that notice and recorded the same way.
// - give_up ends the session with outcome `needs_answer`, next `answer_question`, `question`,
//   sessionId; not isError, never `blocked`; lykos_status state `done`. A resume with
//   session_id and the answer as the brief continues that session.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "./mcp-server.js";
import { createProcessRunner } from "./session-process.js";
import { encodeFrame, parseFrame, PROTOCOL_VERSION, type SessionOutcome, type SessionRequest, type SessionRunInput, type SessionRunner } from "./session-protocol.js";
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { TranscriptWriter } from "../session/transcript.js";
import { runStandaloneTask } from "../session/session.js";
import { runSessionChild } from "../cli/session-child.js";
import { call, lastToolResult, reply, say, SCRIPTED_MODEL, scriptedWorld, type ModelContext } from "../cli/scripted-session.js";

// The trust store and any global config live in a temporary home, never the user's.
const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-t224-home-"));
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
  const ws = mkdtempSync(join(tmpdir(), "lykos-t224-ws-"));
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

/** Resolves to the value, or to "timeout" when it does not settle in time. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, deadline(ms).then(() => "timeout" as const)]);
}

// ---------------------------------------------------------------------------
// The extended seam, typed locally so this file compiles against today's protocol.

type SteerFn = (message: string) => void | Promise<void>;
type T224RunInput = SessionRunInput & { onSteerable?: (steer: SteerFn) => void; onQuestion?: (question: string) => void };

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
  /** The runner was handed onQuestion. */
  canAsk: boolean;
  /** Asks the coordinator, as ask_coordinator does in the child; resolves with the next steer. */
  ask(question: string): Promise<string>;
  /** Ends the session as give_up does in the child. */
  giveUp(question: string): void;
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

/** A stand-in runner whose sessions run until the test finishes them, are stopped, or give up. */
function heldRunner(ws: string): { run: SessionRunner; lives: Live[]; releaseAll(): void } {
  const lives: Live[] = [];
  let n = 0;
  const run: SessionRunner = (raw) => {
    const input = raw as T224RunInput;
    const request = input.request;
    const continuation = request.sessionId !== undefined;
    const id = request.sessionId ?? request.newSessionId ?? `standin-${++n}-${Date.now()}`;
    if (!continuation) startRow(ws, id);
    return new Promise<SessionOutcome>((resolve) => {
      let pending: ((answer: string) => void) | undefined;
      const end = (outcome: SessionOutcome, verification?: Verification): void => {
        if (live.finished) return;
        live.finished = true;
        if (!continuation) endRow(ws, id, verification);
        resolve(outcome);
      };
      const live: Live = {
        id,
        request,
        steers: [],
        aborted: false,
        finished: false,
        canAsk: typeof input.onQuestion === "function",
        ask(question) {
          return new Promise<string>((answered) => {
            pending = answered;
            input.onQuestion?.(question);
          });
        },
        giveUp(question) {
          end({ outcome: "needs_answer", question, sessionId: id } as unknown as SessionOutcome);
        },
        finish(verification) {
          end({ outcome: "ok", answer: "runner: done", sessionId: id }, verification);
        },
      };
      input.onSteerable?.((message) => {
        live.steers.push(message);
        const answer = pending;
        pending = undefined;
        answer?.(message);
      });
      const onAbort = (): void => {
        if (live.finished) return;
        live.aborted = true;
        live.finished = true;
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

async function withServer<T>(ws: string, run: SessionRunner, body: (client: Client) => Promise<T>, cleanup?: () => void): Promise<T> {
  const server = createMcpServer({ workspace: ws, version: "0.0.1-test", trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t224-store-")), "trust.json"), run });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t224", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return await body(client);
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

/** A tool call that never throws, so a test fails on an assertion. */
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

async function started(client: Client, args: Record<string, unknown> = {}): Promise<string> {
  const r = await start(client, args);
  assert.equal(r.isError, false, `lykos_start was refused: ${r.text}`);
  assert.equal(typeof r.id, "string", `lykos_start returns a session_id: ${r.text}`);
  return r.id!;
}

interface Entry {
  session_id: string;
  state: string;
  question?: unknown;
  result?: Record<string, unknown> & { outcome?: string; sessionId?: string; next?: string; question?: unknown; unanswered_questions?: unknown };
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
const QUESTION = "Which database should the cache use, SQLite or Postgres?";

// ---------------------------------------------------------------------------

describe("T224 ACCEPTANCE: ask_coordinator surfaces in lykos_status", () => {
  it("a question sets state waiting with the question text and wakes a status call already waiting", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async (client) => {
      const id = await started(client);
      const live = h.lives[0]!;
      assert.equal(live.canAsk, true, "the runner is handed onQuestion (SessionRunInput.onQuestion)");

      const t0 = Date.now();
      const waiting = status(client, { session_id: id, wait_seconds: 60 });
      setTimeout(() => void live.ask(QUESTION), 300);
      const r = await waiting;
      const took = Date.now() - t0;
      assert.equal(r.isError, false, r.text);
      assert.ok(took < 10_000, `the waiting status call woke on the question, not on its 60 s wait: ${took} ms`);
      const entry = r.sessions[0]!;
      assert.equal(entry.state, "waiting", r.text);
      assert.equal(entry.question, QUESTION, "the pending question is in the status entry");
      assert.equal(entry.result, undefined, "a waiting session has not ended: no result");

      const again = await stateOf(client, id);
      assert.equal(again.state, "waiting", "the session stays waiting until answered");
      assert.equal(again.question, QUESTION);
      assert.equal(live.finished, false);
    }, h.releaseAll);
  });

  it("with several ids and any, a question is what the call returns on", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async (client) => {
      const a = await started(client, { brief: "a" });
      const b = await started(client, { brief: "b" });
      const liveB = h.lives.find((l) => l.id === b)!;
      assert.equal(liveB.canAsk, true, "the runner is handed onQuestion");
      setTimeout(() => void liveB.ask(QUESTION), 300);
      const t0 = Date.now();
      const r = await status(client, { session_ids: [a, b], wait_seconds: 60, any: true });
      assert.ok(Date.now() - t0 < 10_000, "any returns at the first that asks");
      assert.deepEqual(r.sessions.map((e) => e.state), ["running", "waiting"], r.text);
      assert.equal(r.sessions[1]!.question, QUESTION);
      assert.equal(r.sessions[0]!.question, null, "a running session has no pending question");
    }, h.releaseAll);
  });
});

describe("T224 ACCEPTANCE: lykos_steer answers the question", () => {
  it("the answer reaches the pending question, the same session runs on, and the result records nothing unanswered", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async (client) => {
      const id = await started(client);
      const live = h.lives[0]!;
      assert.equal(live.canAsk, true, "the runner is handed onQuestion");
      const answer = live.ask(QUESTION);
      await status(client, { session_id: id, wait_seconds: 10 });
      assert.equal((await stateOf(client, id)).state, "waiting");

      const steered = await tool(client, "lykos_steer", { session_id: id, message: "SQLite, in .lykos/cache.db" });
      assert.equal(steered.isError, false, `a waiting session takes a steer: ${steered.text}`);
      const got = await within(answer, 5000);
      assert.equal(got, "SQLite, in .lykos/cache.db", "the steer is the answer to the pending question");

      const after = await stateOf(client, id);
      assert.equal(after.state, "running", "answered, the session runs on");
      assert.equal(after.question, null, "no pending question once answered");
      assert.equal(h.lives.length, 1, "the same session continued: nothing new was run");

      live.finish(PASSING);
      const done = await status(client, { session_id: id, wait_seconds: 30 });
      const entry = done.sessions[0]!;
      assert.equal(entry.state, "done", done.text);
      assert.equal(entry.result?.outcome, "ok", JSON.stringify(entry.result));
      assert.equal(entry.result?.sessionId, id);
      assert.equal(entry.result?.unanswered_questions, undefined, "an answered question is not recorded as unanswered");
    }, h.releaseAll);
  });
});

describe("T224 ACCEPTANCE: a waiting session is live", () => {
  it("it counts toward mcp.max_sessions, and lykos_stop stops it", async () => {
    const ws = plainRepo("mcp:\n  max_sessions: 2\n");
    const h = heldRunner(ws);
    await withServer(ws, h.run, async (client) => {
      const a = await started(client, { brief: "a" });
      const b = await started(client, { brief: "b" });
      const liveA = h.lives.find((l) => l.id === a)!;
      assert.equal(liveA.canAsk, true, "the runner is handed onQuestion");
      void liveA.ask(QUESTION);
      await status(client, { session_id: a, wait_seconds: 10 });
      assert.equal((await stateOf(client, a)).state, "waiting");

      const third = await start(client, { brief: "c" });
      assert.equal(third.isError, true, `a waiting session holds its slot: ${third.text}`);
      assert.deepEqual([...((third.json?.running as string[] | undefined) ?? [])].sort(), [a, b].sort(), third.text);
      assert.equal(h.lives.length, 2, "the refused start ran nothing");

      const stopped = await tool(client, "lykos_stop", { session_id: a });
      assert.equal(stopped.isError, false, stopped.text);
      await waitFor("the waiting session's signal is aborted", () => liveA.aborted, 3000);
      const s = await status(client, { session_id: a, wait_seconds: 10 });
      assert.equal(s.sessions[0]?.state, "stopped", s.text);
    }, h.releaseAll);
  });
});

describe("T224 ACCEPTANCE: ask_timeout", () => {
  it("past mcp.ask_timeout the session is told to decide alone, runs on, and the result records the unanswered question", async () => {
    const ws = plainRepo("mcp:\n  ask_timeout: 1\n");
    const h = heldRunner(ws);
    await withServer(ws, h.run, async (client) => {
      const id = await started(client);
      const live = h.lives[0]!;
      assert.equal(live.canAsk, true, "the runner is handed onQuestion");
      const answer = live.ask(QUESTION);
      await status(client, { session_id: id, wait_seconds: 10 });
      assert.equal((await stateOf(client, id)).state, "waiting");

      const got = await within(answer, 8000);
      assert.notEqual(got, "timeout", "past ask_timeout (1 s) the server answered the session itself");
      assert.match(String(got), /decide alone/i, `the session is told to decide alone: ${String(got)}`);
      const after = await stateOf(client, id);
      assert.equal(after.state, "running", "the session runs on");
      assert.equal(after.question, null);

      live.finish(PASSING);
      const done = await status(client, { session_id: id, wait_seconds: 30 });
      const result = done.sessions[0]?.result;
      assert.equal(result?.outcome, "ok", JSON.stringify(result));
      assert.deepEqual(result?.unanswered_questions, [QUESTION], `the result records the unanswered question: ${JSON.stringify(result)}`);
    }, h.releaseAll);
  });

  it("a blocking call's question is answered at once with decide-alone and recorded in its result", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async (client) => {
      const blocking = tool(client, "lykos_implement", { brief: "a blocking call" });
      await waitFor("the blocking call's session is live", () => h.lives.length === 1, 3000);
      const live = h.lives[0]!;
      assert.equal(live.canAsk, true, "the runner is handed onQuestion");
      const got = await within(live.ask(QUESTION), 5000);
      assert.notEqual(got, "timeout", "nobody can answer a blocking call mid-flight: the server answers at once, not after ask_timeout");
      assert.match(String(got), /decide alone/i);
      live.finish(PASSING);
      const r = await blocking;
      assert.equal(r.isError, false, r.text);
      assert.equal(r.json?.outcome, "ok", r.text);
      assert.deepEqual(r.json?.unanswered_questions, [QUESTION], r.text);
    }, h.releaseAll);
  });
});

describe("T224 ACCEPTANCE: give_up", () => {
  it("ends the session with outcome needs_answer and next answer_question, distinct from blocked; a resume with the answer continues it", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async (client) => {
      const id = await started(client);
      const live = h.lives[0]!;
      setTimeout(() => live.giveUp("Should the endpoint keep v1 or move to v2?"), 200);
      const r = await status(client, { session_id: id, wait_seconds: 30 });
      assert.equal(r.isError, false, r.text);
      const entry = r.sessions[0]!;
      assert.equal(entry.state, "done", `a session that gave up ended normally: ${r.text}`);
      const result = entry.result;
      assert.equal(result?.outcome, "needs_answer", JSON.stringify(result));
      assert.equal(result?.next, "answer_question", JSON.stringify(result));
      assert.equal(result?.question, "Should the endpoint keep v1 or move to v2?", JSON.stringify(result));
      assert.equal(result?.sessionId, id);
      assert.equal("reason" in (result ?? {}), false, "needs_answer is not blocked: no reason field");

      const resumed = await start(client, { brief: "Move to v2.", session_id: id });
      assert.equal(resumed.isError, false, resumed.text);
      assert.equal(resumed.id, id, "the resume answers to the same session_id");
      const cont = h.lives[1];
      assert.ok(cont !== undefined, "the resume ran");
      assert.equal(cont.request.sessionId, id, "the resume continues the session that gave up");
      assert.equal(cont.request.newSessionId, undefined);
      assert.ok(cont.request.prompt.includes("Move to v2."), `the answer is the resume's message: ${cont.request.prompt}`);
    }, h.releaseAll);
  });

  it("a blocking call that gives up returns needs_answer, not an error", async () => {
    const ws = plainRepo();
    const h = heldRunner(ws);
    await withServer(ws, h.run, async (client) => {
      const blocking = tool(client, "lykos_implement", { brief: "a blocking call" });
      await waitFor("the blocking call's session is live", () => h.lives.length === 1, 3000);
      h.lives[0]!.giveUp("Which branch is the release branch?");
      const r = await blocking;
      assert.equal(r.isError, false, `needs_answer is not an error: ${r.text}`);
      assert.equal(r.json?.outcome, "needs_answer", r.text);
      assert.equal(r.json?.next, "answer_question", r.text);
      assert.equal(r.json?.question, "Which branch is the release branch?", r.text);
      assert.equal(r.json?.sessionId, h.lives[0]!.id);
    }, h.releaseAll);
  });
});

// ---------------------------------------------------------------------------
// The wire and the process runner, with a tiny child script and no model.

describe("T224 ACCEPTANCE: the question frame and the process runner", () => {
  it("a question frame parses; a result frame with outcome needs_answer parses", () => {
    assert.deepEqual(parseFrame(JSON.stringify({ type: "question", question: "Q?" })) as unknown, { type: "question", question: "Q?" });
    const res = parseFrame(JSON.stringify({ type: "result", result: { outcome: "needs_answer", question: "Q?", sessionId: "s" } }));
    assert.equal(res?.type, "result", "a needs_answer result is a frame, not a stray line");
  });

  it("the process runner hands a child's question to onQuestion, and the steer answers it in the child", { timeout: 30_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t224-script-"));
    const script = join(dir, "child.cjs");
    writeFileSync(
      script,
      [
        "const out = (f, cb) => process.stdout.write(JSON.stringify(f) + '\\n', cb);",
        "const timer = setTimeout(() => out({ type: 'result', result: { outcome: 'error', message: 'no answer came' } }, () => process.exit(0)), 5000);",
        "let n = 0;",
        "require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {",
        "  n += 1;",
        "  if (n === 1) { out({ type: 'question', question: 'Q?' }); return; }",
        "  let m; try { m = JSON.parse(line); } catch { return; }",
        "  if (m.type !== 'steer') return;",
        "  clearTimeout(timer);",
        "  out({ type: 'result', result: { outcome: 'ok', sessionId: 's-1', answer: m.message } }, () => process.exit(0));",
        "});",
        "",
      ].join("\n"),
    );
    const runner = createProcessRunner({ child: { command: process.execPath, args: [script] }, exitGraceMs: 2000 });
    const ws = plainRepo();
    const questions: string[] = [];
    let steer: SteerFn | undefined;
    const input: T224RunInput = {
      request: { version: PROTOCOL_VERSION, tool: "lykos_implement", workspace: ws, prompt: "p", label: "lykos_implement" },
      trustSource: "flag",
      onProgress: () => {},
      signal: new AbortController().signal,
      onSteerable: (fn) => {
        steer = fn;
      },
      onQuestion: (q) => {
        questions.push(q);
        void steer?.("ANSWER-1");
      },
    };
    const result = (await runner(input)) as SessionOutcome & { answer?: string };
    assert.deepEqual(questions, ["Q?"], `the runner passed the child's question to onQuestion: ${JSON.stringify(result)}`);
    assert.equal(result.outcome, "ok", JSON.stringify(result));
    assert.equal(result.answer, "ANSWER-1", "the steer reached the child as the answer");
  });
});

// ---------------------------------------------------------------------------
// The real child: `lykos session-child` (runSessionChild + runStandaloneTask) on Pi's scripted model.

function childRequest(workspace: string): SessionRequest {
  return { version: PROTOCOL_VERSION, tool: "lykos_implement", workspace, prompt: "do it", label: "lykos_implement", containment: "off", model: SCRIPTED_MODEL };
}

/** Runs one request in the child; answers every question frame on stdout with a steer line carrying `answer`. */
async function driveChild(
  world: Awaited<ReturnType<typeof scriptedWorld>>,
  answer: string,
): Promise<{ frames: Array<Record<string, unknown>> }> {
  const input = new PassThrough();
  const frames: Array<Record<string, unknown>> = [];
  input.write(encodeFrame(childRequest(world.workspace)));
  await runSessionChild({
    input,
    write: (text) => {
      for (const line of text.split("\n")) {
        if (line.trim().length === 0) continue;
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        frames.push(frame);
        if (frame.type === "question") input.write(`${JSON.stringify({ type: "steer", message: answer })}\n`);
      }
    },
    env: { LYKOS_TRUST_WORKSPACE: "1", LYKOS_TRUST_SOURCE: "flag" },
    trustPath: join(mkdtempSync(join(tmpdir(), "lykos-t224-store-")), "trust.json"),
    worktreesRoot: mkdtempSync(join(tmpdir(), "lykos-t224-wt-")),
    runTask: (task) => runStandaloneTask(task),
    sessionExtras: { nativeProviders: [world.provider], ledgerPath: world.ledgerPath },
  });
  input.end();
  return { frames };
}

const QUIET = "feedback:\n  enabled: false\ngate:\n  enabled: false\n";

describe("T224 ACCEPTANCE: the two tools in a real delegated session", () => {
  it("ask_coordinator and give_up are on a delegated session's wire", { timeout: 60_000 }, async () => {
    const world = await scriptedWorld({ config: QUIET, script: [reply(say("done"))] });
    const { frames } = await driveChild(world, "unused");
    const wire = (world.sent[0]?.tools ?? []).map((t) => t.name);
    assert.ok(wire.length > 0, `the model was called: ${JSON.stringify(frames.at(-1))}`);
    assert.ok(wire.includes("ask_coordinator"), `ask_coordinator is on the wire: ${wire.join(", ")}`);
    assert.ok(wire.includes("give_up"), `give_up is on the wire: ${wire.join(", ")}`);
  });

  it("ask_coordinator writes a question frame and the steer line comes back as its tool result", { timeout: 60_000 }, async () => {
    let seen: { tool: string; text: string; isError: boolean } | undefined;
    const world = await scriptedWorld({
      config: QUIET,
      script: [
        reply(call("ask_coordinator", { question: "Which port should the server listen on?" })),
        (context: ModelContext) => {
          seen = lastToolResult(context);
          return reply(say("done"));
        },
      ],
    });
    const { frames } = await driveChild(world, "PORT-8080");
    const questions = frames.filter((f) => f.type === "question");
    assert.deepEqual(questions.map((f) => f.question), ["Which port should the server listen on?"], `one question frame: ${JSON.stringify(frames)}`);
    assert.equal(seen?.tool, "ask_coordinator", JSON.stringify(seen));
    assert.equal(seen?.isError, false, JSON.stringify(seen));
    assert.ok(seen?.text.includes("PORT-8080"), `the answer is the tool result: ${JSON.stringify(seen)}`);
    const result = frames.at(-1);
    assert.equal(result?.type, "result");
  });

  it("give_up ends the session at once with outcome needs_answer and the question", { timeout: 60_000 }, async () => {
    // One scripted reply only: a session that called the model again would run out of script and error.
    const world = await scriptedWorld({ config: QUIET, script: [reply(call("give_up", { question: "Keep v1 or move to v2?" }))] });
    const { frames } = await driveChild(world, "unused");
    const last = frames.at(-1) as { type?: string; result?: Record<string, unknown> } | undefined;
    assert.equal(last?.type, "result", JSON.stringify(frames));
    assert.equal(last?.result?.outcome, "needs_answer", JSON.stringify(last?.result));
    assert.equal(last?.result?.question, "Keep v1 or move to v2?", JSON.stringify(last?.result));
    assert.equal(world.modelCalls(), 1, "give_up ended the session without another model call");
  });
});
