// T226 sealed acceptance test (ADR-0053).
//
// Measured before the build (T226): a built `lykos session-child`
// spends a median ~7.6 s of its 11.9 s to the first model request loading its
// module graph, before it has read its request. The ruling is a warm pool:
// children spawned ahead of the call, each one waiting on stdin with its modules
// loaded, one child per call, the request line written when the call arrives.
//
// The seam is session-process.ts: `createWarmPool(options)` returns
// `{ run, warm, idlePids, shutdown }`. `run` is a `SessionRunner` with exactly
// `createProcessRunner`'s contract. Children are keyed by (workspace, trust
// source), because both are fixed when a child is spawned (its cwd, and the
// LYKOS_TRUST_SOURCE claim in its environment) and the wire must not change.
//
// The stand-in child is a node one-liner, as in session-process.test.ts: it
// records when it started, waits for one request line, answers with what it saw
// (pid, start time, cwd, trust claim, the request bytes), and exits when its
// stdin closes. One test runs the real child through the pool.
//
// The pool API is reached through a dynamic import so that a missing export
// fails an assertion, never the import.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/load.js";
import { openCredentialDb } from "../credentials/db.js";
import { startFakeAnthropicServer, type FakeAnthropicServer } from "../credentials/fake-anthropic-server.js";
import { upsertCredential } from "../credentials/pool.js";
import type { TrustSource } from "../gate/trust.js";
import { createProcessRunner, type ChildCommand, type ProcessRunnerOptions } from "./session-process.js";
import { encodeFrame, PROTOCOL_VERSION, type SessionOutcome, type SessionRequest, type SessionRunner } from "./session-protocol.js";

const REPO = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** The pool's shape as this test rules it. */
interface WarmPoolLike {
  run: SessionRunner;
  warm(workspace: string, trustSource: TrustSource): void;
  idlePids(workspace?: string, trustSource?: TrustSource): number[];
  shutdown(): Promise<void>;
}

async function createPool(opts: ProcessRunnerOptions & { size: number }): Promise<WarmPoolLike> {
  const mod = (await import("./session-process.js")) as Record<string, unknown>;
  assert.equal(typeof mod.createWarmPool, "function", "session-process.ts exports createWarmPool (T226)");
  return (mod.createWarmPool as (o: ProcessRunnerOptions & { size: number }) => WarmPoolLike)(opts);
}

const now = (): number => performance.timeOrigin + performance.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A stand-in child that serves one request. `T226_DIE_FLAG`: if that file exists when it starts, it exits at once. */
const STAND_IN: ChildCommand = {
  command: process.execPath,
  args: [
    "-e",
    [
      "const startedAt = performance.timeOrigin + performance.now();",
      "const fs = require('fs');",
      "if (process.env.T226_DIE_FLAG && fs.existsSync(process.env.T226_DIE_FLAG)) process.exit(0);",
      "let buf = ''; let served = false;",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (c) => {",
      "  if (served) return; buf += c; const i = buf.indexOf('\\n'); if (i < 0) return; served = true;",
      "  const line = buf.slice(0, i + 1);",
      "  const answer = JSON.stringify({ pid: process.pid, startedAt, cwd: process.cwd(), trust: process.env.LYKOS_TRUST_SOURCE, line: Buffer.from(line, 'utf8').toString('base64') });",
      "  process.stdout.write(JSON.stringify({ type: 'result', result: { outcome: 'ok', answer, sessionId: 's' } }) + '\\n');",
      "});",
      "process.stdin.on('end', () => process.exit(0));",
    ].join("\n"),
    "--",
  ],
};

interface Seen {
  pid: number;
  startedAt: number;
  cwd: string;
  trust: string | undefined;
  line: string;
}

function seenOf(outcome: SessionOutcome): Seen {
  assert.equal(outcome.outcome, "ok", JSON.stringify(outcome));
  const s = JSON.parse((outcome as Extract<SessionOutcome, { outcome: "ok" }>).answer!) as Seen;
  return { ...s, line: Buffer.from(s.line, "base64").toString("utf8") };
}

function workspace(): string {
  const ws = mkdtempSync(join(tmpdir(), "lykos-t226-ws-"));
  return ws;
}

function request(ws: string, extra: Partial<SessionRequest> = {}): SessionRequest {
  return { version: PROTOCOL_VERSION, tool: "lykos_ask", workspace: ws, prompt: "Is the pool warm?", label: "lykos_ask", containment: "off", ...extra };
}

async function call(run: SessionRunner, req: SessionRequest, trustSource: TrustSource = "flag"): Promise<SessionOutcome> {
  return run({ request: req, trustSource, onProgress: () => {}, signal: new AbortController().signal });
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(what: string, test: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (test()) return;
    await sleep(25);
  }
  assert.fail(`timed out waiting for: ${what}`);
}

const samePath = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase();

describe("T226 warm pool: a call is served by a child spawned before it", () => {
  it("(a) with a pool of K, the call is served by a child that was idle before the call was made", async () => {
    const ws = workspace();
    const pool = await createPool({ size: 2, child: STAND_IN, exitGraceMs: 2000 });
    try {
      pool.warm(ws, "flag");
      await until("two idle children", () => pool.idlePids(ws, "flag").length === 2);
      await sleep(1500); // let them start running, so their start time is a real one
      const idleBefore = pool.idlePids(ws, "flag");
      const callAt = now();
      const seen = seenOf(await call(pool.run, request(ws)));
      assert.ok(idleBefore.includes(seen.pid), `served by pid ${seen.pid}, idle before the call: ${idleBefore.join(", ")}`);
      assert.ok(seen.startedAt < callAt, `the child started (${seen.startedAt.toFixed(0)}) before the call was made (${callAt.toFixed(0)})`);
    } finally {
      await pool.shutdown();
    }
  });

  it("(b) after a call takes a child the pool refills to K, and never hands the same child out twice", async () => {
    const ws = workspace();
    const pool = await createPool({ size: 2, child: STAND_IN, exitGraceMs: 2000 });
    try {
      pool.warm(ws, "flag");
      await until("two idle children", () => pool.idlePids(ws, "flag").length === 2);
      const first = seenOf(await call(pool.run, request(ws)));
      await until("the pool refilled to two", () => pool.idlePids(ws, "flag").length === 2);
      assert.ok(!pool.idlePids(ws, "flag").includes(first.pid), "the child that served a call is not idle again");
      const second = seenOf(await call(pool.run, request(ws)));
      assert.notEqual(second.pid, first.pid, "a child serves one call");
    } finally {
      await pool.shutdown();
    }
  });
});

describe("T226 warm pool: sessions stay isolated", () => {
  it("(c) two concurrent calls get two pre-spawned processes, each with its own workspace and trust claim, and each exits after one request", async () => {
    const wsA = workspace();
    const wsB = workspace();
    const pool = await createPool({ size: 1, child: STAND_IN, exitGraceMs: 2000 });
    try {
      pool.warm(wsA, "flag");
      pool.warm(wsB, "prompt");
      await until("one idle child per key", () => pool.idlePids(wsA, "flag").length === 1 && pool.idlePids(wsB, "prompt").length === 1);
      const idleA = pool.idlePids(wsA, "flag");
      const idleB = pool.idlePids(wsB, "prompt");
      const [a, b] = await Promise.all([call(pool.run, request(wsA), "flag"), call(pool.run, request(wsB), "prompt")]);
      const sa = seenOf(a);
      const sb = seenOf(b);
      assert.notEqual(sa.pid, sb.pid, "two processes");
      assert.deepEqual([idleA.includes(sa.pid), idleB.includes(sb.pid)], [true, true], "each was a pre-spawned child of its own key");
      assert.ok(samePath(sa.cwd, wsA), `A ran in its workspace: ${sa.cwd}`);
      assert.ok(samePath(sb.cwd, wsB), `B ran in its workspace: ${sb.cwd}`);
      assert.equal(sa.trust, "flag");
      assert.equal(sb.trust, "prompt", "a child's trust claim is the one its call carried, never another call's");
      await until("both served children exited", () => !alive(sa.pid) && !alive(sb.pid));
    } finally {
      await pool.shutdown();
    }
  });

  it("a call whose key has no idle child is served cold, and the pool fills that key for the next one", async () => {
    const ws = workspace();
    const pool = await createPool({ size: 1, child: STAND_IN, exitGraceMs: 2000 });
    try {
      assert.deepEqual(pool.idlePids(ws, "stored"), []);
      const callAt = now();
      const first = seenOf(await call(pool.run, request(ws), "stored"));
      assert.ok(first.startedAt > callAt, "nothing was idle, so the child was spawned for this call");
      assert.equal(first.trust, "stored");
      await until("the key was filled", () => pool.idlePids(ws, "stored").length === 1);
    } finally {
      await pool.shutdown();
    }
  });

  it("an idle child that died is never handed a call; the call is still served", async () => {
    const ws = workspace();
    const flag = join(ws, "die");
    writeFileSync(flag, "");
    const pool = await createPool({ size: 2, child: STAND_IN, exitGraceMs: 2000, env: { T226_DIE_FLAG: flag } });
    try {
      pool.warm(ws, "flag");
      const doomed = pool.idlePids(ws, "flag");
      assert.equal(doomed.length, 2);
      // The idle children start and exit at once. A dead child leaves the idle set, and is not respawned until a call
      // takes from the key (no spawn loop against a child that cannot start).
      await until("the dead children left the idle set", () => pool.idlePids(ws, "flag").length === 0);
      rmSync(flag);
      const seen = seenOf(await call(pool.run, request(ws)));
      assert.ok(!doomed.includes(seen.pid), "not served by a dead child");
    } finally {
      await pool.shutdown();
    }
  });
});

describe("T226 warm pool: the wire is unchanged", () => {
  it("(d) the request line a pooled child reads is byte for byte the one the cold path writes, and encodeFrame's", async () => {
    const ws = workspace();
    const req = request(ws, { prompt: "line one\nline two — ünïcode", model: "fakeprov/m1", budgetUsd: 0.5 });
    const cold = seenOf(await call(createProcessRunner({ child: STAND_IN, exitGraceMs: 2000 }), req));
    const pool = await createPool({ size: 1, child: STAND_IN, exitGraceMs: 2000 });
    try {
      pool.warm(ws, "flag");
      await until("an idle child", () => pool.idlePids(ws, "flag").length === 1);
      const pooled = seenOf(await call(pool.run, req));
      assert.equal(pooled.line, encodeFrame(req));
      assert.equal(pooled.line, cold.line);
    } finally {
      await pool.shutdown();
    }
  });
});

describe("T226 warm pool: size 0 is the cold path", () => {
  it("(e) a pool of size 0 keeps nothing idle and spawns each child inside its call, as createProcessRunner does", async () => {
    const ws = workspace();
    const pool = await createPool({ size: 0, child: STAND_IN, exitGraceMs: 2000 });
    try {
      pool.warm(ws, "flag");
      await sleep(300);
      assert.deepEqual(pool.idlePids(), [], "nothing pre-spawned");
      const callAt = now();
      const seen = seenOf(await call(pool.run, request(ws)));
      assert.ok(seen.startedAt > callAt, "spawned for the call");
      await sleep(300);
      assert.deepEqual(pool.idlePids(), [], "and nothing refilled");
    } finally {
      await pool.shutdown();
    }
  });

  it("(e) config: `mcp.warm_pool` resolves to 2 by default, takes 0, and refuses anything but a whole number from 0", () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-t226-config-"));
    const globalDir = join(root, "home", ".lykos");
    const ws = join(root, "ws");
    mkdirSync(globalDir, { recursive: true });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    const poolOf = (): unknown => (loadConfig({ cwd: ws, globalDir, env: {} }).resolved as unknown as { mcp?: { warm_pool?: unknown } }).mcp?.warm_pool;
    assert.equal(poolOf(), 2, "shipped default");
    writeFileSync(join(ws, ".lykos", "config.yaml"), "mcp:\n  warm_pool: 0\n");
    assert.equal(poolOf(), 0);
    writeFileSync(join(ws, ".lykos", "config.yaml"), "mcp:\n  warm_pool: 4\n");
    assert.equal(poolOf(), 4);
    for (const bad of ["-1", "1.5", "lots"]) {
      writeFileSync(join(ws, ".lykos", "config.yaml"), `mcp:\n  warm_pool: ${bad}\n`);
      assert.throws(() => loadConfig({ cwd: ws, globalDir, env: {} }), /mcp\.warm_pool/, `refuses ${bad}`);
    }
  });
});

describe("T226 warm pool: shutdown", () => {
  it("(f) shutting the pool down kills every idle child, and a later call is still served, cold", async () => {
    const ws = workspace();
    const pool = await createPool({ size: 2, child: STAND_IN, exitGraceMs: 2000 });
    pool.warm(ws, "flag");
    pool.warm(ws, "prompt");
    await until("four idle children", () => pool.idlePids().length === 4);
    const idle = pool.idlePids();
    await pool.shutdown();
    await until("no idle child is left running", () => idle.every((pid) => !alive(pid)), 3000);
    assert.deepEqual(pool.idlePids(), []);
    const callAt = now();
    const seen = seenOf(await call(pool.run, request(ws)));
    assert.ok(seen.startedAt > callAt, "after shutdown a call is spawned cold");
    await sleep(300);
    assert.deepEqual(pool.idlePids(), [], "and the pool does not refill");
  });
});

describe("T226 warm pool: the real child", () => {
  const PROVIDER = "fakeprov";
  let server: FakeAnthropicServer;
  before(async () => {
    server = await startFakeAnthropicServer();
  });
  after(async () => {
    await server.close();
  });

  it("a real `lykos session-child` taken from the pool runs a delegated session to its result", { timeout: 120_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "lykos-t226-real-"));
    const home = join(root, "home");
    const ws = join(root, "workspace");
    mkdirSync(join(home, ".lykos"), { recursive: true });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      ["providers:", `  ${PROVIDER}:`, "    auth: api_key", `    baseUrl: ${server.baseUrl}`, "    api: anthropic-messages", "    models:", "      - id: m1", ""].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/\n");
    writeFileSync(join(ws, "README.md"), "fixture\n");
    const sh = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: ws, stdio: "pipe" });
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
    server.reset();
    server.script.set("pooled-key", [{ kind: "ok", text: "pong" }]);
    const env = { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), LYKOS_CREDENTIALS_DB: dbPath };
    const pool = await createPool({ size: 1, env, exitGraceMs: 5000 });
    try {
      pool.warm(ws, "flag");
      await until("an idle real child", () => pool.idlePids(ws, "flag").length === 1);
      const idle = pool.idlePids(ws, "flag");
      await sleep(2000); // a request that arrives while the child is still loading must be read as well
      const outcome = await call(
        pool.run,
        { version: PROTOCOL_VERSION, tool: "lykos_implement", workspace: ws, prompt: "Reply with the word pong.", label: "lykos_implement", model: `${PROVIDER}/m1`, containment: "off" },
        "flag",
      );
      assert.equal(outcome.outcome, "ok", JSON.stringify(outcome));
      if (outcome.outcome === "ok") assert.match(outcome.answer!, /pong/);
      assert.ok(!pool.idlePids(ws, "flag").includes(idle[0]!), "the idle child was the one taken");
    } finally {
      await pool.shutdown();
    }
  });
});

describe("T226 is wired and recorded", () => {
  it("lykos mcp serves its calls through the pool, sized from mcp.warm_pool, and shuts it down", () => {
    const server = readFileSync(join(REPO, "lykos", "delegate", "mcp-server.ts"), "utf8");
    const cli = readFileSync(join(REPO, "lykos", "cli", "mcp.ts"), "utf8");
    const both = `${server}\n${cli}`;
    assert.match(both, /createWarmPool\(/, "the MCP server builds its runner with createWarmPool");
    assert.match(both, /warm_pool/, "sized from the resolved mcp.warm_pool");
    assert.match(both, /\.shutdown\(\)/, "and shuts the pool down when the server goes away");
  });

  it("the reference documents the setting", () => {
    assert.ok(existsSync(join(REPO, "docs", "reference", "cli-and-config.md")));
    assert.match(readFileSync(join(REPO, "docs", "reference", "cli-and-config.md"), "utf8"), /warm_pool/);
  });
});
