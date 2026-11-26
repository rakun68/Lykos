// P5 #51: MCP and `lykos run` sessions in the TUI. A `lykos run` owner in a process of its own (the T243 fixture)
// lists in `sessions.history` while it runs; `session.watch` shows its transcript as a session's events; a prompt
// steers it as `lykos steer` does, and an interrupt stops it as `lykos stop` does. An MCP owner's row lists the same.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { admit } from "../delegate/ownership.js";
import { ledgerViews } from "../delegate/mcp-server.js";
import { defaultLedgerPath, withLedgerSync } from "../ledger/use.js";
import { TranscriptWriter } from "../session/transcript.js";
import { engineAddress, readOrCreateKey } from "./address.js";
import { connectEngine, type EngineConnection } from "./client.js";
import type { DelegatedInfo, Event, SessionSummary } from "./protocol.js";
import { EngineServer } from "./server.js";

const saved: Record<string, string | undefined> = {};
before(() => {
  const home = mkdtempSync(join(tmpdir(), "lykos-watch-home-"));
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

interface History {
  rows: Array<{ id: string }>;
  live: Record<string, string>;
  delegated: Record<string, DelegatedInfo>;
}

async function engine(): Promise<{ server: EngineServer; conn: EngineConnection; events: Event[] }> {
  const dir = mkdtempSync(join(tmpdir(), "lykos-watch-engine-"));
  const address = engineAddress(dir);
  const server = new EngineServer({ address, idleSeconds: 60, globalDir: dir, registryPath: join(dir, "projects.json"), log: () => {}, trust: async () => "stored" });
  await server.listen();
  const conn = await connectEngine(server.address, readOrCreateKey(address));
  const events: Event[] = [];
  conn.onEvent((e) => events.push(e));
  await conn.request("subscribe");
  return { server, conn, events };
}

async function until<T>(what: string, test: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = test();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const tsx = import.meta.resolve("tsx");
const fixture = resolve("lykos", "delegate", "delegation-core.fixture.ts");

describe("P5 #51: delegated sessions on the engine server", () => {
  it("a lykos run session lists while it runs; a watch shows it, steers it and stops it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos watch "));
    const steers = join(ws, "steers.log");
    const owner = spawn(process.execPath, ["--import", tsx, fixture, ws, join(ws, "never")], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LYKOS_FIXTURE_STEER_LOG: steers },
      windowsHide: true,
    });
    const exited = new Promise<number | null>((r) => owner.on("exit", (code) => r(code)));
    const { server, conn, events } = await engine();
    try {
      const id = await until("the owner row", () => ledgerViews(ws)[0]?.session_id);
      const history = await conn.request<History>("sessions.history", { cwd: ws });
      assert.equal(history.delegated[id]?.owner, "run");
      assert.equal(history.delegated[id]?.state, "running");
      assert.ok(history.rows.some((r) => r.id === id), "it lists before its ledger row is written");

      // What the session's live capture writes as it runs.
      const transcript = new TranscriptWriter(defaultLedgerPath(ws), id);
      transcript.append({ kind: "user_message", text: "fix the bug" });
      transcript.append({ kind: "tool_call", name: "read", state: "running", tool_call_id: "c1", args: { path: "README.md" } });

      const s = await conn.request<SessionSummary>("session.watch", { cwd: ws, id });
      assert.equal(s.origin, "run");
      assert.equal(s.ledgerSessionId, id);
      const of = (type: string) => events.filter((e) => e.session === s.id && e.event === type);
      await until("the transcript so far", () => of("message.user").length === 1 && of("tool.start").length === 1);
      assert.equal((of("message.user")[0]!.data as { text: string }).text, "fix the bug");
      await until("running", () => of("session.status").some((e) => (e.data as { session: SessionSummary }).session.status === "running"));
      const again = await conn.request<SessionSummary>("session.watch", { cwd: ws, id });
      assert.equal(again.id, s.id, "a second watch is the same session");

      transcript.append({ kind: "tool_result", name: "read", state: "ok", tool_call_id: "c1", result: { content: [{ type: "text", text: "# readme" }] } });
      transcript.append({ kind: "assistant_message", text: "Found it.", final: false });
      await until("the rest, as it is written", () => of("tool.end").length === 1 && of("message.delta").length === 1);
      assert.equal((of("tool.end")[0]!.data as { ok: boolean }).ok, true);

      await conn.request("session.prompt", { session: s.id, text: "look at main.ts too" });
      await until("the steer reaches the session", () => existsSync(steers) && readFileSync(steers, "utf8").includes("look at main.ts too"));

      await conn.request("session.interrupt", { session: s.id });
      assert.equal(await exited, 0, "the owner ended the session on its own, as lykos stop has it");
      await until("the end shows", () => of("system").some((e) => /ended: stopped/.test((e.data as { text: string }).text)));
      const last = of("session.status").at(-1)!.data as { session: SessionSummary };
      assert.equal(last.session.status, "idle");

      const ended = await conn.request<History>("sessions.history", { cwd: ws });
      assert.equal(ended.delegated[id], undefined, "an ended session is no longer listed as running");
      await conn.request("session.close", { session: s.id });
      await until("the watch closes", () => of("session.status").some((e) => (e.data as { session: SessionSummary }).session.status === "closed"));
    } finally {
      owner.kill("SIGKILL");
      conn.close();
      await server.stop("test");
    }
  });

  it("an MCP session lists with its owner; a session that is not delegated cannot be watched", async () => {
    const ws = mkdtempSync(join(tmpdir(), "lykos watch mcp "));
    withLedgerSync(defaultLedgerPath(ws), (l) => admit(l, { sessionId: "mcp-1", owner: "mcp", specialist: "general", projectCap: 10 }));
    const { server, conn } = await engine();
    try {
      const history = await conn.request<History>("sessions.history", { cwd: ws });
      assert.deepEqual(Object.keys(history.delegated), ["mcp-1"]);
      assert.equal(history.delegated["mcp-1"]!.owner, "mcp");
      await assert.rejects(conn.request("session.watch", { cwd: ws, id: "nope" }), /no MCP or lykos run session nope/);
    } finally {
      conn.close();
      await server.stop("test");
    }
  });
});
