// The engine server (P5 #35) against a scripted session child: the handshake, events in order to two clients,
// resync after a drop, and when it exits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { aclIsOwnerOnly, engineAddress, readOrCreateKey } from "./address.js";
import { connectEngine, type EngineConnection } from "./client.js";
import { EngineServer } from "./server.js";
import { PROTOCOL_VERSION, type Event, type SessionSummary } from "./protocol.js";
import { WorkspaceTrustError } from "../gate/trust.js";

const fixture = fileURLToPath(new URL("./scripted-child.fixture.ts", import.meta.url));
const child = { command: process.execPath, args: ["--import", import.meta.resolve("tsx"), fixture] };

function setup(idleSeconds = 60, trusted = true, firstClientMs?: number): { server: EngineServer; key: Buffer; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "lykos-engine-"));
  const address = engineAddress(dir);
  const server = new EngineServer({
    address,
    idleSeconds,
    ...(firstClientMs !== undefined ? { firstClientMs } : {}),
    child,
    log: () => {},
    trust: async (cwd, flag) => {
      if (trusted || flag) return trusted ? "stored" : "flag";
      throw new WorkspaceTrustError(cwd);
    },
  });
  return { server, key: readOrCreateKey(address), dir };
}

/** Collects one connection's events until `until` holds. */
function collect(conn: EngineConnection, until: (events: Event[]) => boolean, timeoutMs = 15000): Promise<Event[]> {
  const events: Event[] = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out with ${JSON.stringify(events.map((e) => e.event))}`)), timeoutMs);
    conn.onEvent((e) => {
      events.push(e);
      if (until(events)) {
        clearTimeout(timer);
        resolve(events);
      }
    });
  });
}

const idleAfterTurn = (events: Event[]): boolean => events.some((e) => e.event === "turn.end") && events.at(-1)?.event === "session.status" && (events.at(-1)!.data as { session: SessionSummary }).session.status === "idle";

describe("engine server", () => {
  it("refuses a client without the key, and one of another protocol naming both versions", async () => {
    const { server, key } = setup();
    await server.listen();
    try {
      const ok = await connectEngine(server.address, key);
      assert.equal(ok.welcome.protocol, PROTOCOL_VERSION);
      ok.close();
      await assert.rejects(connectEngine(server.address, Buffer.alloc(32, 7)), /did not prove/);
      await assert.rejects(connectEngine(server.address, key, { protocol: 0 }), new RegExp(`protocol ${PROTOCOL_VERSION}; this client speaks 0`));
    } finally {
      await server.stop("test");
    }
  });

  it("gives two clients the same session's events in the same order", async () => {
    const { server, key } = setup();
    await server.listen();
    try {
      const a = await connectEngine(server.address, key, { client: "a" });
      const b = await connectEngine(server.address, key, { client: "b" });
      await a.request("subscribe");
      await b.request("subscribe");
      const gotA = collect(a, idleAfterTurn);
      const gotB = collect(b, idleAfterTurn);
      const s = await a.request<SessionSummary>("session.start", { cwd: process.cwd() });
      await waitStatus(a, s.id, "idle");
      await b.request("session.prompt", { session: s.id, text: "hello world" });
      const [ea, eb] = await Promise.all([gotA, gotB]);
      assert.deepEqual(ea, eb);
      assert.deepEqual(ea.map((e) => e.seq), ea.map((_, i) => i + 1), "seq counts from 1 with no gap");
      const text = ea.filter((e) => e.event === "message.delta").map((e) => (e.data as { text: string }).text).join("");
      assert.equal(text, "hello world");
      const list = await a.request<SessionSummary[]>("sessions.list");
      assert.equal(list[0]?.title, "hello world");
      assert.equal(list[0]?.ledgerSessionId, "ledger-1");
      a.close();
      b.close();
    } finally {
      await server.stop("test");
    }
  });

  it("replays what a dropped client missed, after the last seq it saw", async () => {
    const { server, key } = setup();
    await server.listen();
    try {
      const a = await connectEngine(server.address, key);
      await a.request("subscribe");
      const s = await a.request<SessionSummary>("session.start", { cwd: process.cwd() });
      const first = await collect(a, (ev) => ev.some((e) => e.event === "session.status" && (e.data as { session: SessionSummary }).session.status === "idle"));
      const seen = first.at(-1)!.seq;
      a.close();
      await a.closed;
      const watcher = await connectEngine(server.address, key);
      await watcher.request("subscribe", { after: { [s.id]: seen } });
      const done = collect(watcher, idleAfterTurn);
      await watcher.request("session.prompt", { session: s.id, text: "while you were away" });
      const all = await done;
      const again = await connectEngine(server.address, key);
      const resynced = collect(again, (ev) => ev.length === all.length);
      await again.request("subscribe", { after: { [s.id]: seen } });
      const replay = await resynced;
      assert.deepEqual(replay, all, "the replay is exactly what came after the last seq seen");
      assert.equal(replay[0]?.seq, seen + 1);
      watcher.close();
      again.close();
    } finally {
      await server.stop("test");
    }
  });

  it("refuses an untrusted workspace unless the start says trust", async () => {
    const { server, key } = setup(60, false);
    await server.listen();
    try {
      const a = await connectEngine(server.address, key);
      await assert.rejects(a.request("session.start", { cwd: process.cwd() }), /untrusted workspace/);
      const s = await a.request<SessionSummary>("session.start", { cwd: process.cwd(), trust: true });
      assert.equal(s.status, "starting");
      a.close();
    } finally {
      await server.stop("test");
    }
  });

  it("exits at once with 0 after the last client leaves", async () => {
    const { server, key } = setup(0);
    await server.listen();
    const a = await connectEngine(server.address, key);
    const t = Date.now();
    a.close();
    assert.equal(await server.exited, "idle for 0s");
    assert.ok(Date.now() - t < 1000, `exited in ${Date.now() - t} ms`);
  });

  it("with idle 0, waits for its first client, and exits when none comes", async () => {
    const { server, key } = setup(0, true, 1500);
    await server.listen();
    let exited = false;
    void server.exited.then(() => (exited = true));
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(exited, false, "the client that started it has time to connect");
    const a = await connectEngine(server.address, key);
    a.close();
    assert.equal(await server.exited, "idle for 0s");

    const lone = setup(0, true, 500);
    await lone.server.listen();
    const t = Date.now();
    assert.equal(await lone.server.exited, "no client within 0.5s of starting");
    assert.ok(Date.now() - t >= 400, `exited after ${Date.now() - t} ms`);
  });

  it("waits the idle time, and never exits while a session runs", async () => {
    const { server, key } = setup(1);
    await server.listen();
    const a = await connectEngine(server.address, key);
    const s = await a.request<SessionSummary>("session.start", { cwd: process.cwd() });
    await waitStatus(a, s.id, "idle", true);
    await a.request("session.prompt", { session: s.id, text: "hold" });
    await waitStatus(a, s.id, "running");
    a.close();
    let exited = false;
    void server.exited.then(() => (exited = true));
    await new Promise((r) => setTimeout(r, 2500));
    assert.equal(exited, false, "a running session keeps the server up past the idle time");
    const b = await connectEngine(server.address, key);
    await b.request("session.prompt", { session: s.id, text: "release" });
    await waitStatus(b, s.id, "idle", true);
    const t = Date.now();
    b.close();
    await server.exited;
    const waited = Date.now() - t;
    assert.ok(waited >= 900 && waited < 3000, `waited ${waited} ms for an idle time of 1 s`);
  });

  it("stops on server.shutdown while a client stays connected", async () => {
    const { server, key } = setup(60);
    await server.listen();
    const a = await connectEngine(server.address, key);
    const t = Date.now();
    await a.request("server.shutdown");
    assert.equal(await server.exited, "shutdown requested");
    assert.ok(Date.now() - t < 3000, `stopped in ${Date.now() - t} ms`);
    await a.closed;
  });

  it("refuses a second server on the same address", async () => {
    const { server, dir } = setup();
    await server.listen();
    try {
      const second = new EngineServer({ address: engineAddress(dir), idleSeconds: 60, child, log: () => {} });
      await assert.rejects(second.listen(), (err: NodeJS.ErrnoException) => err.code === "EADDRINUSE");
    } finally {
      await server.stop("test");
    }
  });

  it("refuses a key file other users can read", { skip: process.platform === "win32" }, () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-engine-"));
    const address = engineAddress(dir);
    writeFileSync(address.keyPath, "00".repeat(32), { mode: 0o644 });
    assert.throws(() => readOrCreateKey(address), /readable by other users/);
  });

  it("gives a new key file an owner-only ACL on Windows", { skip: process.platform !== "win32" }, () => {
    const address = engineAddress(mkdtempSync(join(tmpdir(), "lykos-engine-")));
    readOrCreateKey(address);
    // icacls prints the path, then one "<account>:<rights>" entry per line, then a summary line.
    const entries = execFileSync("icacls", [address.keyPath], { encoding: "utf8" })
      .replace(address.keyPath, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.includes(":("));
    assert.deepEqual(entries.map((e) => e.split(":(")[0]!.split("\\").at(-1)), [userInfo().username], entries.join("; "));
    assert.ok(!entries[0]!.includes("(I)"), "not inherited");
  });

  // Outside the profile, where a directory's ACL lets other signed-in users read what it inherits (the checkout,
  // when it is not under the profile itself).
  const outside = join(fileURLToPath(new URL("../../", import.meta.url)), ".scratch");
  it("replaces an existing key file whose ACL is not owner-only, on Windows outside the profile", { skip: process.platform !== "win32" || !relative(homedir(), outside).startsWith("..") }, () => {
    mkdirSync(outside, { recursive: true });
    const address = engineAddress(mkdtempSync(join(outside, "lykos-engine-")));
    writeFileSync(address.keyPath, "00".repeat(32));
    assert.ok(!aclIsOwnerOnly(address.keyPath), "the planted key inherits its directory's ACL");
    const key = readOrCreateKey(address);
    assert.notDeepEqual(key, Buffer.alloc(32, 0));
    assert.ok(aclIsOwnerOnly(address.keyPath));
  });

  it("starts over a temp key file a dead server left under this pid", () => {
    const address = engineAddress(mkdtempSync(join(tmpdir(), "lykos-engine-")));
    mkdirSync(address.dir, { recursive: true });
    writeFileSync(`${address.keyPath}.${process.pid}.tmp`, "");
    assert.equal(readOrCreateKey(address).length, 32);
  });
});

/** Polls `sessions.list` until the session has `status`; with `subscribe` it also ignores events. */
async function waitStatus(conn: EngineConnection, id: string, status: SessionSummary["status"], _quiet = false): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const list = await conn.request<SessionSummary[]>("sessions.list");
    if (list.find((s) => s.id === id)?.status === status) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`session ${id} never reached ${status}`);
}
