// T244: the inbox. A question is in the ledger, and so in every process's `status`, the moment it is asked (F1);
// `wait --questions` never returns on one already answered (G8); a steer from a second process reaches a session
// owned by an MCP server and one owned by `lykos run`.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, ledgerViews, waitForQuestions } from "./mcp-server.js";
import type { SessionRunner } from "./session-protocol.js";

const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-t244-home-"));
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

const tsx = import.meta.resolve("tsx");
const cli = resolve("lykos", "cli.ts");
const lykos = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, ["--import", tsx, cli, ...args], { cwd, encoding: "utf8", windowsHide: true, input: "" });

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "lykos-t244-"));
}

async function waitFor<T>(read: () => T | undefined, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("timed out");
    await sleep(50);
  }
}

/** A session that asks `question` at once, logs every steer, and ends on the first one. */
function asking(question: string | undefined): { run: SessionRunner; steers: string[] } {
  const steers: string[] = [];
  const run: SessionRunner = async ({ request, signal, onSteerable, onQuestion }) => {
    let answered!: () => void;
    const got = new Promise<void>((r) => (answered = r));
    onSteerable?.((message) => {
      steers.push(message);
      answered();
    });
    if (question !== undefined) onQuestion?.(question);
    await Promise.race([got, new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }))]);
    return { outcome: "ok", sessionId: request.newSessionId ?? request.sessionId!, answer: steers.join(";") };
  };
  return { run, steers };
}

async function mcp(ws: string, run: SessionRunner): Promise<Client> {
  const server = createMcpServer({ workspace: ws, version: "test", run });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t244", version: "1" });
  await client.connect(b);
  return client;
}

function json(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0]!.text) as Record<string, unknown>;
}

describe("T244: questions", () => {
  it("a question is visible at once, in the ledger and in `lykos status` from another process (F1)", async () => {
    const ws = workspace();
    const s = asking("Which currency rounding?");
    const client = await mcp(ws, s.run);
    const id = json(await client.callTool({ name: "lykos_start", arguments: { specialist: "general", brief: "x" } })).session_id as string;
    // No wait on the MCP side: the ledger has it as soon as it was asked.
    const view = await waitFor(() => ledgerViews(ws, [id]).find((v) => v.state === "waiting"), 5_000);
    assert.equal(view.question, "Which currency rounding?");
    assert.equal(view.next, "answer_question");
    const status = lykos(ws, "status", id);
    assert.equal(status.status, 0, status.stderr);
    const out = JSON.parse(status.stdout) as { sessions: Array<{ question: string; state: string }>; next: string };
    assert.equal(out.sessions[0]!.question, "Which currency rounding?");
    assert.equal(out.next, "answer_question");
    await client.callTool({ name: "lykos_steer", arguments: { session_id: id, message: "banker's" } });
    await client.close();
  });

  it("`wait --questions` returns on an open question and never on one already answered (G8)", async () => {
    const ws = workspace();
    const s = asking("Round half up or half even?");
    const client = await mcp(ws, s.run);
    const id = json(await client.callTool({ name: "lykos_start", arguments: { specialist: "general", brief: "x" } })).session_id as string;
    const open = await waitForQuestions(ws, [id], 10_000);
    assert.equal(open.questions.length, 1);
    assert.equal(open.questions[0]!.question, "Round half up or half even?");

    // Answer it from another process; the owner picks the steer up from the inbox.
    const steer = lykos(ws, "steer", id, "-m", "half even");
    assert.equal(steer.status, 0, steer.stderr);
    await waitFor(() => (s.steers.length > 0 ? true : undefined));
    assert.deepEqual(s.steers, ["half even"]);
    const answered = await waitForQuestions(ws, [id], 1_500);
    assert.equal(answered.questions.length, 0, "an answered question does not wake it");
    const cliWait = lykos(ws, "wait", id, "--questions", "--timeout", "2");
    assert.equal(cliWait.status, 0, cliWait.stderr);
    assert.deepEqual((JSON.parse(cliWait.stdout) as { questions: unknown[] }).questions, []);
    await client.close();
  });
});

describe("T244: steer from a second process", () => {
  it("reaches a session owned by an MCP server", async () => {
    const ws = workspace();
    const s = asking(undefined);
    const client = await mcp(ws, s.run);
    const id = json(await client.callTool({ name: "lykos_start", arguments: { specialist: "general", brief: "x" } })).session_id as string;
    const r = lykos(ws, "steer", id, "-m", "use the v2 API");
    assert.equal(r.status, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as { steered: boolean }).steered, true);
    await waitFor(() => (s.steers.length > 0 ? true : undefined));
    assert.deepEqual(s.steers, ["use the v2 API"]);
    await client.close();
  });

  it("reaches a session owned by `lykos run`, and an MCP server can steer it too", async () => {
    const ws = workspace();
    const log = join(ws, "steers.log");
    const child = spawn(process.execPath, ["--import", tsx, resolve("lykos", "delegate", "delegation-core.fixture.ts"), ws, join(ws, "release")], {
      stdio: "ignore",
      env: { ...process.env, LYKOS_FIXTURE_STEER_LOG: log },
      windowsHide: true,
    });
    const id = await waitFor(() => ledgerViews(ws)[0]?.session_id);
    const r = lykos(ws, "steer", id, "-m", "from the cli");
    assert.equal(r.status, 0, r.stderr);
    const client = await mcp(ws, asking(undefined).run);
    const viaMcp = json(await client.callTool({ name: "lykos_steer", arguments: { session_id: id, message: "from mcp" } }));
    assert.equal(viaMcp.steered, true);
    await waitFor(() => (existsSync(log) && readFileSync(log, "utf8").includes("from mcp") ? true : undefined));
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["from the cli", "from mcp"]);
    writeFileSync(join(ws, "release"), "go");
    await new Promise((done) => child.on("exit", done));
    await client.close();
  });

  it("a steer to a session that ended is refused, pointing at continue", async () => {
    const ws = workspace();
    const s = asking(undefined);
    const client = await mcp(ws, s.run);
    const id = json(await client.callTool({ name: "lykos_start", arguments: { specialist: "general", brief: "x" } })).session_id as string;
    await client.callTool({ name: "lykos_steer", arguments: { session_id: id, message: "end" } });
    await waitFor(() => ledgerViews(ws, [id]).find((v) => v.state === "done"));
    const r = lykos(ws, "steer", id, "-m", "too late");
    assert.equal(r.status, 1);
    assert.equal((JSON.parse(r.stdout) as { next: string }).next, "resume");
    await client.close();
  });
});
