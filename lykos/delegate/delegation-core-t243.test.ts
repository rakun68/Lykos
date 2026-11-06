// T243: one delegation core under `lykos run` and the MCP tools. Sessions are owned in the project ledger, so any
// process sees them: `lykos wait` from another process returns a run's result, a crashed owner wakes `wait` with
// `next recover`, a retried request finds its session, one writer per tree across MCP and the CLI, and the project
// cap names its holders. The session runner is a stand-in (as in the P7 tests); the owners are real processes
// where the lesson is about processes.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { TranscriptWriter } from "../session/transcript.js";
import { parseFlags } from "../cli/delegation.js";
import { unknownRunFlag } from "../cli/args.js";
import { createMcpServer, ledgerViews, runDelegated, waitForSessions } from "./mcp-server.js";
import type { SessionRunner } from "./session-protocol.js";
import { watchStepCap, type StepCappable } from "./step-cap.js";

const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-t243-home-"));
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

function workspace(config?: string): string {
  // A space in the path: arguments pass as arrays (F6).
  const ws = mkdtempSync(join(tmpdir(), "lykos t243 "));
  if (config !== undefined) {
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(join(ws, ".lykos", "config.yaml"), config);
  }
  return ws;
}

/** A stand-in session held until `release()`. */
function held(): { run: SessionRunner; release: () => void; calls: () => number } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  return {
    run: async ({ request, signal }) => {
      calls += 1;
      await Promise.race([gate, new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }))]);
      return { outcome: "ok", sessionId: request.newSessionId ?? request.sessionId!, answer: "done", steps: 2 };
    },
    release: () => release(),
    calls: () => calls,
  };
}

async function untilViews(ws: string, n: number): Promise<string[]> {
  const until = Date.now() + 30_000;
  for (;;) {
    const views = ledgerViews(ws);
    if (views.length >= n) return views.map((v) => v.session_id);
    if (Date.now() > until) throw new Error(`no ${n} owner rows in ${ws}`);
    await sleep(50);
  }
}

const tsx = import.meta.resolve("tsx");
const fixture = resolve("lykos", "delegate", "delegation-core.fixture.ts");
function owner(ws: string, releaseFile: string, requestId?: string): ChildProcess {
  return spawn(process.execPath, ["--import", tsx, fixture, ws, releaseFile, ...(requestId !== undefined ? [requestId] : [])], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    windowsHide: true,
  });
}

async function mcpClient(ws: string, run: SessionRunner): Promise<Client> {
  const server = createMcpServer({ workspace: ws, version: "test", run });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t243", version: "1" });
  await client.connect(b);
  return client;
}

function json(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

describe("T243: sessions are owned in the project ledger", () => {
  it("`wait` from another process returns the result of a `lykos run` when it ends", async () => {
    const ws = workspace();
    const releaseFile = join(ws, "release");
    const child = owner(ws, releaseFile);
    let out = "";
    child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    const [id] = await untilViews(ws, 1);
    assert.equal(ledgerViews(ws, [id!])[0]!.state, "running");
    assert.equal(ledgerViews(ws, [id!])[0]!.owner, "run");
    const waiting = waitForSessions(ws, [id!], false);
    await sleep(300);
    writeFileSync(releaseFile, "go");
    const [view] = await waiting;
    assert.equal(view!.state, "done");
    assert.equal((view!.result as { sessionId?: string }).sessionId, id);
    assert.equal(await exited, 0);
    assert.equal((JSON.parse(out.trim()) as { sessionId: string }).sessionId, id, "the run printed the same result");
  });

  it("`wait` wakes for a session whose owner died without a result, with next recover (R4)", async () => {
    const ws = workspace();
    const child = owner(ws, join(ws, "never"));
    const [id] = await untilViews(ws, 1);
    const waiting = waitForSessions(ws, [id!], false, 60_000);
    child.kill("SIGKILL");
    const [view] = await waiting;
    assert.equal(view!.state, "crashed");
    assert.equal(view!.next, "recover");
    assert.equal(view!.result, undefined);
  });

  it("`wait --any` returns when the first of several ends", async () => {
    const ws = workspace();
    const a = held();
    const b = held();
    const first = runDelegated(ws, { brief: "a" }, { trustSource: "flag", run: a.run });
    const second = runDelegated(ws, { brief: "b" }, { trustSource: "flag", run: b.run });
    const ids = await untilViews(ws, 2);
    const waiting = waitForSessions(ws, ids, true);
    a.release();
    const views = await waiting;
    assert.equal(views.filter((v) => v.state === "done").length, 1);
    assert.equal(views.filter((v) => v.state === "running").length, 1);
    b.release();
    await Promise.all([first, second]);
  });

  it("a session started over MCP is visible to `lykos status`, and a `lykos run` session to lykos_status", async () => {
    const ws = workspace();
    const m = held();
    const client = await mcpClient(ws, m.run);
    const started = json(await client.callTool({ name: "lykos_start", arguments: { specialist: "general", brief: "over mcp" } }));
    const mcpId = started.session_id as string;
    const cliStatus = spawnSync(process.execPath, ["--import", tsx, resolve("lykos", "cli.ts"), "status", mcpId], { cwd: ws, encoding: "utf8", windowsHide: true });
    assert.equal(cliStatus.status, 0, cliStatus.stderr);
    const seen = JSON.parse(cliStatus.stdout) as { sessions: Array<{ session_id: string; owner: string; state: string }>; next: string };
    assert.equal(seen.sessions[0]!.session_id, mcpId);
    assert.equal(seen.sessions[0]!.owner, "mcp");
    assert.equal(seen.next, "wait");

    const r = held();
    const run = runDelegated(ws, { brief: "over the cli" }, { trustSource: "flag", run: r.run });
    const runId = (await untilViews(ws, 2)).find((id) => id !== mcpId)!;
    const status = json(await client.callTool({ name: "lykos_status", arguments: { session_id: runId } })) as { sessions: Array<{ session_id: string; owner: string }> };
    assert.equal(status.sessions[0]!.session_id, runId);
    assert.equal(status.sessions[0]!.owner, "run");
    m.release();
    r.release();
    await run;
    await client.close();
  });

  it("a retried request with the same request id returns the existing session", async () => {
    const ws = workspace();
    const s = held();
    const first = runDelegated(ws, { brief: "once", request_id: "cycle-1/step-1" }, { trustSource: "flag", run: s.run });
    const [id] = await untilViews(ws, 1);
    const retry = runDelegated(ws, { brief: "once", request_id: "cycle-1/step-1" }, { trustSource: "flag", run: s.run });
    await sleep(200);
    s.release();
    const [a, b] = await Promise.all([first, retry]);
    assert.equal(s.calls(), 1, "one session ran");
    assert.equal(a.sessionId, id);
    assert.equal(b.sessionId, id);
    assert.equal(b.duplicate, true);
    assert.equal(ledgerViews(ws).length, 1);
  });

  it("two write-in-place sessions on one tree, from the CLI and MCP: the second is refused, naming the first", async () => {
    const ws = workspace();
    const releaseFile = join(ws, "release");
    const child = owner(ws, releaseFile);
    const [cliId] = await untilViews(ws, 1);
    const m = held();
    const client = await mcpClient(ws, m.run);
    const refused = await client.callTool({ name: "lykos_general", arguments: { brief: "second writer", write_in_place: true } });
    assert.equal(refused.isError, true);
    const body = json(refused);
    assert.match(String(body.reason), new RegExp(cliId!));
    assert.equal(body.holder, cliId);
    writeFileSync(releaseFile, "go");
    await new Promise((r) => child.on("exit", r));
    // The lock went with the session.
    const after = json(await client.callTool({ name: "lykos_start", arguments: { specialist: "general", brief: "now", write_in_place: true } }));
    assert.equal(after.state, "running");
    m.release();
    await client.close();
  });

  it("delegation.max_sessions: 1 runs a project serially, and the refusal names the holder (R2)", async () => {
    const ws = workspace("delegation:\n  max_sessions: 1\n");
    const s = held();
    const first = runDelegated(ws, { brief: "first" }, { trustSource: "flag", run: s.run });
    const [id] = await untilViews(ws, 1);
    const second = await runDelegated(ws, { brief: "second" }, { trustSource: "flag", run: s.run });
    assert.equal(second.outcome, "blocked");
    assert.match(String(second.reason), /delegation\.max_sessions \(1\)/);
    assert.deepEqual(second.running, [id]);
    s.release();
    await first;
  });

  it("the result is built from the ledger and the session file: a last step the runner lost is still there (F5)", async () => {
    const ws = workspace();
    const run: SessionRunner = async ({ request }) => {
      const id = request.newSessionId!;
      const ledgerPath = defaultLedgerPath(ws);
      mkdirSync(dirname(ledgerPath), { recursive: true });
      const ledger = openLedgerSync(ledgerPath);
      try {
        ledger.startSession({ id, brief: "x", executionShape: "mcp_worker", runtime: "host", workspace: ws, captureMode: "stream" });
        const transcript = new TranscriptWriter(ledgerPath, id);
        transcript.append({ kind: "assistant_message", text: "the last step", final: true });
        const file = transcript.finalize();
        ledger.endSession({ id, transcriptPath: file.path, transcriptSha256: file.sha256, transcriptBytes: file.bytes } as Parameters<typeof ledger.endSession>[0]);
      } finally {
        ledger.close();
      }
      // The report the child sent lost its answer.
      return { outcome: "ok", sessionId: id };
    };
    const result = await runDelegated(ws, { brief: "x" }, { trustSource: "flag", run });
    assert.equal(result.answer, "the last step");
  });
});

describe("T243: the step cap is enforced and reported from one count (R13)", () => {
  it("the cap aborts at the count, and the count is what the result reports", async () => {
    const listeners: Array<(e: { type: string }) => void> = [];
    let aborted = 0;
    const session = {
      subscribe: (fn: (e: { type: string }) => void) => {
        listeners.push(fn);
        return () => {};
      },
      abort: async () => {
        aborted += 1;
      },
    } as unknown as StepCappable;
    const counter = { turns: 0 };
    let capped = 0;
    watchStepCap(session, 3, () => (capped += 1), counter);
    // A turn already under way when the abort lands still ends: it is not counted past the cap.
    for (let i = 0; i < 4; i++) for (const fn of listeners) fn({ type: "turn_end" });
    assert.equal(capped, 1);
    assert.equal(aborted, 1);
    assert.equal(counter.turns, 3);

    const ws = workspace();
    const run: SessionRunner = async ({ request }) => ({ outcome: "ok", sessionId: request.newSessionId!, steps: 3 });
    const result = await runDelegated(ws, { brief: "x", max_steps: 3 }, { trustSource: "flag", run });
    assert.equal(result.steps, 3);
    assert.equal(result.max_steps, 3);
  });
});

describe("T243: the commands", () => {
  const cli = resolve("lykos", "cli.ts");
  const lykos = (cwd: string, ...args: string[]) =>
    spawnSync(process.execPath, ["--import", tsx, cli, ...args], { cwd, encoding: "utf8", windowsHide: true, input: "" });

  it("every command with no arguments prints its usage (G12)", () => {
    const ws = workspace();
    for (const cmd of ["status", "wait", "stop"]) {
      const r = lykos(ws, cmd);
      assert.equal(r.status, 2, `${cmd}: ${r.stderr}`);
      assert.match(r.stdout, new RegExp(`usage: lykos ${cmd}`));
    }
  });

  it("unknown flags are errors (R19)", () => {
    assert.equal(unknownRunFlag(["--model", "x", "--bogus", "brief"]), "--bogus");
    assert.equal(unknownRunFlag(["--max-steps", "3", "--in-place", "brief"]), undefined);
    assert.equal(unknownRunFlag(["--", "--not-a-flag"]), undefined);
    const parsed = parseFlags(["a", "--since", "1"], "wait", ["timeout"], ["any"]);
    assert.ok("error" in parsed && /unknown flag --since/.test(parsed.error));
    const ws = workspace();
    const r = lykos(ws, "wait", "abc", "--since", "1");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown flag --since/);
    const run = lykos(ws, "run", "--bogus", "brief");
    assert.equal(run.status, 1);
    assert.match(run.stderr, /lykos run: unknown flag --bogus/);
  });

  it("several ids pass as separate arguments in a path with spaces (F6)", async () => {
    const ws = workspace();
    const a = held();
    const b = held();
    const runs = [runDelegated(ws, { brief: "a" }, { trustSource: "flag", run: a.run }), runDelegated(ws, { brief: "b" }, { trustSource: "flag", run: b.run })];
    const ids = await untilViews(ws, 2);
    a.release();
    b.release();
    await Promise.all(runs);
    const r = lykos(ws, "wait", ...ids);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { sessions: Array<{ session_id: string; state: string }> };
    assert.deepEqual(out.sessions.map((s) => s.session_id).sort(), [...ids].sort());
    assert.ok(out.sessions.every((s) => s.state === "done"));
  });

  it("a 200 KB prompt runs: it travels on the child's stdin, never as an argument (G19)", async () => {
    const ws = workspace();
    const brief = "x".repeat(200 * 1024);
    let got = 0;
    const run: SessionRunner = async ({ request }) => {
      got = request.prompt.length;
      return { outcome: "ok", sessionId: request.newSessionId! };
    };
    const result = await runDelegated(ws, { brief }, { trustSource: "flag", run });
    assert.ok(got >= brief.length);
    assert.notEqual(result.outcome, "blocked");
  });
});
