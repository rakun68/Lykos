// The engine server (P5 #35) against a scripted session child: the handshake, events in order to two clients,
// resync after a drop, and when it exits.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { aclIsOwnerOnly, engineAddress, readOrCreateKey } from "./address.js";
import { connectEngine, type EngineConnection } from "./client.js";
import { EngineServer } from "./server.js";
import { PROTOCOL_VERSION, type Event, type KeybindsResult, type ProvidersResult, type SessionOptions, type SessionSummary } from "./protocol.js";
import { WorkspaceTrustError } from "../gate/trust.js";
import { Ledger } from "../ledger/ledger.js";

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
    globalDir: dir,
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

  it("sends the session's commands once it boots, and answers an aside without an event", async () => {
    const { server, key } = setup();
    await server.listen();
    try {
      const a = await connectEngine(server.address, key);
      await a.request("subscribe");
      const got = collect(a, (ev) => ev.some((e) => e.event === "commands"));
      const s = await a.request<SessionSummary>("session.start", { cwd: process.cwd() });
      const commands = (await got).find((e) => e.event === "commands")!.data as { commands: { name: string }[] };
      assert.deepEqual(commands.commands.map((c) => c.name), ["/help", "/skill:tdd"]);
      await waitStatus(a, s.id, "idle");
      const before = (await a.request<SessionSummary[]>("sessions.list"))[0];
      const seen: Event[] = [];
      a.onEvent((e) => seen.push(e));
      assert.deepEqual(await a.request("session.aside", { session: s.id, text: "why?" }), { answer: "aside: why?", model: "faux/scripted" });
      await assert.rejects(a.request("session.aside", { session: s.id, text: "fail" }), /overloaded/);
      await assert.rejects(a.request("session.aside", { session: s.id, text: " " }), /needs text/);
      const options = await a.request<SessionOptions>("session.options", { session: s.id });
      assert.equal(options.model, "faux/scripted");
      assert.deepEqual(options.models.map((m) => m.id), ["scripted", "other"]);
      assert.deepEqual([options.effort, options.specialist], ["medium", "build"]);
      assert.deepEqual(seen, [], "an aside and the options send no event");
      assert.deepEqual((await a.request<SessionSummary[]>("sessions.list"))[0], before);
      a.close();
    } finally {
      await server.stop("test");
    }
  });

  it("lists a session's jobs, reads and stops one, and moves a running shell call to the background (#48)", async () => {
    const { server, key, dir } = setup();
    await server.listen();
    const work = mkdtempSync(join(tmpdir(), "lykos-jobs-"));
    try {
      const a = await connectEngine(server.address, key);
      await a.request("subscribe");
      const s = await a.request<SessionSummary>("session.start", { cwd: work });
      await waitStatus(a, s.id, "idle");
      type Jobs = { jobs: { id: string; status: string }[]; foreground: { id: string }[] };
      const jobsWhere = (test: (j: Jobs) => boolean): Promise<Jobs> =>
        collect(a, (ev) => ev.some((e) => e.event === "jobs" && test(e.data as Jobs))).then((ev) => ev.filter((e) => e.event === "jobs" && test(e.data as Jobs)).at(-1)!.data as Jobs);
      const started = jobsWhere((j) => j.jobs.some((x) => x.status === "running"));
      await a.request("session.prompt", { session: s.id, text: "job" });
      const id = (await started).jobs[0]!.id;
      let log = "";
      for (let i = 0; i < 100 && !log.includes("tick"); i++) {
        log = (await a.request<{ text: string }>("session.job.logs", { session: s.id, jobId: id })).text;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.match(log, /tick 1/);
      const stopped = jobsWhere((j) => j.jobs.some((x) => x.id === id && x.status === "stopped"));
      assert.deepEqual(await a.request("session.job.stop", { session: s.id, jobId: id }), { status: "stopped" });
      await stopped;
      await assert.rejects(a.request("session.job.stop", { session: s.id, jobId: "job-none" }), /no job job-none/);
      const holding = jobsWhere((j) => j.foreground.length === 1);
      await a.request("session.prompt", { session: s.id, text: "shell" });
      await holding;
      const back = collect(a, (ev) => ev.some((e) => e.event === "tool.end"));
      const moved = await a.request<{ jobs: string[] }>("session.background", { session: s.id });
      assert.equal(moved.jobs.length, 1);
      const end = (await back).find((e) => e.event === "tool.end")!.data as { preview: string };
      assert.match(end.preview, new RegExp(`moved this command to the background as ${moved.jobs[0]}`));
      const gone = jobsWhere((j) => j.jobs.some((x) => x.id === moved.jobs[0] && x.status === "stopped"));
      await a.request("session.job.stop", { session: s.id, jobId: moved.jobs[0] });
      await gone;
      a.close();
    } finally {
      await server.stop("test");
      rmSync(work, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers config.keybinds with what each layer sets and where", async () => {
    const { server, key, dir } = setup();
    const work = mkdtempSync(join(tmpdir(), "lykos-keybinds-"));
    mkdirSync(join(work, ".lykos"));
    writeFileSync(join(dir, "config.yaml"), ["tui:", "  keybinds:", "    leader: ctrl+o", "    app.exit: none", ""].join("\n"));
    writeFileSync(join(work, ".lykos", "config.yaml"), ["tui:", "  keybinds:", "    app.exit: [ctrl+q]", "    input.undo: false", "  colors:", "    accent: '#ff8800'", ""].join("\n"));
    await server.listen();
    try {
      const a = await connectEngine(server.address, key);
      const got = await a.request<KeybindsResult>("config.keybinds", { cwd: work });
      assert.deepEqual(Object.fromEntries(Object.entries(got.keybinds).map(([k, v]) => [k, [v.value, v.source.split(" ")[0]]])), {
        leader: ["ctrl+o", "global"],
        "app.exit": [["ctrl+q"], "project"],
        "input.undo": [false, "project"],
      });
      assert.match(got.keybinds.leader?.source ?? "", /config\.yaml\)$/);
      // #58 items 9 and 10: the colours set, and what a new session starts with.
      assert.deepEqual([got.colors.accent?.value, got.colors.accent?.source.split(" ")[0]], ["#ff8800", "project"]);
      if (got.defaults) {
        assert.ok(got.defaults.specialist.length > 0 && got.defaults.effort.length > 0, JSON.stringify(got.defaults));
      }
      writeFileSync(join(work, ".lykos", "config.yaml"), ["tui:", "  colors:", "    accent: orange", ""].join("\n"));
      await assert.rejects(a.request("config.keybinds", { cwd: work }), /tui\.colors\.accent/);
      writeFileSync(join(work, ".lykos", "config.yaml"), ["tui:", "  keybinds:", "    app.exit: 3", ""].join("\n"));
      await assert.rejects(a.request("config.keybinds", { cwd: work }), /tui\.keybinds\.app\.exit must be/);
      a.close();
    } finally {
      await server.stop("test");
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("lists every provider, adds a custom one and stores a key, with no session open", async () => {
    const { server, key, dir } = setup();
    const work = mkdtempSync(join(tmpdir(), "lykos-providers-"));
    const before = process.env.LYKOS_CREDENTIALS_DB;
    process.env.LYKOS_CREDENTIALS_DB = join(dir, "credentials.db");
    await server.listen();
    try {
      const a = await connectEngine(server.address, key);
      const list = async () => (await a.request<ProvidersResult>("providers.list", { cwd: work })).providers;
      const first = await list();
      assert.ok(first.length > 30, `${first.length} providers`);
      assert.equal(first.find((p) => p.name === "anthropic")?.login, "oauth");
      assert.equal(first.find((p) => p.name === "groq")?.login, "api_key");
      // How each signs in comes from the runtime: Anthropic takes a browser sign-in or a key, Antigravity a browser only.
      const kinds = (name: string) => { const p = first.find((e) => e.name === name); return [p?.oauth, p?.apiKey]; };
      assert.deepEqual(kinds("anthropic"), [true, true]);
      assert.deepEqual(kinds("google-antigravity"), [true, false]);
      assert.deepEqual(kinds("groq"), [false, true]);
      await assert.rejects(a.request("provider.models", { cwd: work, provider: "omniroute" }), /omniroute has no endpoint/);

      const added = await a.request<{ path: string }>("provider.add", { cwd: work, scope: "project", id: "local", api: "openai-completions", baseUrl: "http://localhost:11434/v1", models: "qwen3:8b" });
      assert.equal(added.path, join(work, ".lykos", "config.yaml"));
      await assert.rejects(a.request("provider.add", { cwd: work, scope: "project", id: "groq", api: "openai-completions", baseUrl: "http://x", models: "m" }), /already exists/);
      // Models are optional: the model list's picker adds them later, to the file that declares the provider.
      await a.request("provider.add", { cwd: work, scope: "project", id: "omni", api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1", models: "" });
      const at = await a.request<{ path: string }>("provider.model.add", { cwd: work, provider: "omni", model: "auto/best-coding" });
      assert.equal(at.path, added.path);
      assert.match(readFileSync(at.path, "utf8"), /omni:\n(.*\n)*? {4}models:\n {6}- id: "auto\/best-coding"/);
      await assert.rejects(a.request("provider.model.add", { cwd: work, provider: "nowhere", model: "m" }), /nowhere is not declared in a config file/);

      const stored = await a.request<{ message: string }>("credential.add", { provider: "local", key: "sk-SERVER-SECRET" });
      assert.match(stored.message, /logged in to local as key#1/);
      assert.ok(!stored.message.includes("sk-SERVER-SECRET"));
      const local = (await list()).find((p) => p.name === "local");
      assert.deepEqual([local?.configured, local?.reason], [true, "1 credential in the pool"]);

      // The accounts: listed without secrets, removed as `lykos logout` does (disabled, never deleted).
      const { credentials } = await a.request<{ credentials: { id: number; type: string; label: string }[] }>("credentials.list", { provider: "local" });
      assert.deepEqual(credentials.map((c) => [c.type, c.label]), [["api_key", "key#1"]]);
      assert.ok(!JSON.stringify(credentials).includes("sk-SERVER-SECRET"));
      const removed = await a.request<{ message: string }>("credential.remove", { provider: "local", id: credentials[0]!.id });
      assert.equal(removed.message, "logged out key#1 from local");
      await assert.rejects(a.request("credential.remove", { provider: "local", id: credentials[0]!.id }), /has no credential/);
      assert.equal((await list()).find((p) => p.name === "local")?.configured, false, "no credential left, and no key source declared");

      // The skills a session here would offer, before one starts: `.lykos/skills` among Pi's own places.
      mkdirSync(join(work, ".lykos", "skills", "fold-socks"), { recursive: true });
      writeFileSync(join(work, ".lykos", "skills", "fold-socks", "SKILL.md"), ["---", "name: fold-socks", "description: Folds the socks.", "---", "Fold them.", ""].join("\n"));
      const { skills } = await a.request<{ skills: { name: string; description: string }[] }>("skills.list", { cwd: work });
      assert.deepEqual(skills.find((k) => k.name === "/skill:fold-socks"), { name: "/skill:fold-socks", description: "Folds the socks." });
      a.close();
    } finally {
      if (before === undefined) delete process.env.LYKOS_CREDENTIALS_DB;
      else process.env.LYKOS_CREDENTIALS_DB = before;
      await server.stop("test");
      rmSync(work, { recursive: true, force: true });
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

describe("sessions, rename, archive, export and worktrees (P5 #42)", () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();

  /** A project with one recorded session, "s1", and a commit. */
  function project(): string {
    const cwd = mkdtempSync(join(tmpdir(), "lykos-engine-project-"));
    git(cwd, "init", "-q");
    writeFileSync(join(cwd, "a.txt"), "a\n");
    git(cwd, "add", "-A");
    git(cwd, "commit", "-q", "-m", "first");
    mkdirSync(join(cwd, ".lykos"));
    const led = Ledger.open(join(cwd, ".lykos", "ledger.db"));
    led.startSession({ id: "s1", brief: "first go", startedUtc: "2026-09-01T00:00:00.000Z" });
    led.endSession({ id: "s1", endedUtc: "2026-09-01T00:30:00.000Z" });
    led.close();
    mkdirSync(join(cwd, ".lykos", "sessions", "s1"), { recursive: true });
    writeFileSync(join(cwd, ".lykos", "sessions", "s1", "transcript.jsonl"), "");
    return cwd;
  }

  it("lists, renames, exports and archives a recorded session; the archived one is listed only on request", async () => {
    const { server, key } = setup();
    await server.listen();
    const cwd = project();
    try {
      const c = await connectEngine(server.address, key);
      type History = { rows: { id: string; title: string | null; archived: boolean }[]; live: Record<string, string> };
      const first = await c.request<History>("sessions.history", { cwd });
      assert.deepEqual(first.rows.map((r) => [r.id, r.title]), [["s1", "first go"]]);
      await c.request("session.rename", { cwd, ledgerSessionId: "s1", title: "the parser" });
      assert.equal((await c.request<History>("sessions.history", { cwd })).rows[0]!.title, "the parser");
      const exported = await c.request<{ markdown: string }>("session.export", { cwd, ledgerSessionId: "s1" });
      assert.match(exported.markdown, /^# Session s1/);
      await c.request("session.archive", { cwd, ledgerSessionId: "s1" });
      assert.deepEqual((await c.request<History>("sessions.history", { cwd })).rows, []);
      const all = await c.request<History>("sessions.history", { cwd, archived: true });
      assert.deepEqual(all.rows.map((r) => [r.id, r.archived]), [["s1", true]]);
      await assert.rejects(c.request("session.rename", { cwd, ledgerSessionId: "nope", title: "x" }), /no session nope/);
      c.close();
    } finally {
      await server.stop("test");
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("moves a session keeping its ledger, checks the target before closing it, and never resumes one ledger session twice", async () => {
    const { server, key } = setup();
    await server.listen();
    const cwd = project();
    const elsewhere = mkdtempSync(join(tmpdir(), "lykos-engine-elsewhere-"));
    try {
      const c = await connectEngine(server.address, key);
      // Every event from the subscribe on, so none is missed between a reply and a wait.
      const seen: Event[] = [];
      c.onEvent((e) => seen.push(e));
      await c.request("subscribe");
      const ledgerOf = async (id: string): Promise<string> => {
        for (let i = 0; i < 300; i += 1) {
          const said = seen.find((e) => e.session === id && e.data.type === "system");
          if (said !== undefined) return (said.data as { text: string }).text.replace(/^ledger /, "");
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error(`no ledger said by ${id}`);
      };
      await c.request("session.rename", { cwd, ledgerSessionId: "s1", title: "the parser" });
      const first = await c.request<SessionSummary>("session.start", { cwd, resume: "s1" });
      assert.equal(first.title, "the parser", "a resumed session keeps its title, so its tab is named");
      const ledger = await ledgerOf(first.id);
      assert.equal(ledger, join(cwd, ".lykos", "ledger.db"));
      await assert.rejects(c.request("session.start", { cwd, resume: "s1" }), /already open/, "one ledger session runs in one child");
      await assert.rejects(c.request("session.move", { session: first.id, cwd: join(cwd, "nope") }), /not a directory/);
      assert.equal((await c.request<SessionSummary[]>("sessions.list", {})).find((s) => s.id === first.id)?.status, "idle", "a bad target leaves it running");
      // cd outside the project, then move again: the ledger stays the project's.
      const moved = await c.request<SessionSummary>("session.move", { session: first.id, cwd: elsewhere });
      assert.equal(await ledgerOf(moved.id), ledger);
      const back = await c.request<SessionSummary>("session.move", { session: moved.id, cwd });
      assert.equal(await ledgerOf(back.id), ledger);
      c.close();
    } finally {
      await server.stop("test");
      rmSync(cwd, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("creates, lists and removes a worktree; its work stays on its branch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-engine-wt-"));
    const address = engineAddress(dir);
    const server = new EngineServer({ address, idleSeconds: 60, child, globalDir: dir, log: () => {}, worktreesRoot: join(dir, "worktrees"), trust: async () => "stored" });
    await server.listen();
    const cwd = project();
    try {
      const c = await connectEngine(server.address, readOrCreateKey(address));
      const made = await c.request<{ path: string; branch: string }>("worktree.create", { cwd, name: "spike" });
      assert.equal(made.branch, "lykos/spike");
      const listed = await c.request<{ path: string; main: boolean }[]>("worktree.list", { cwd });
      assert.equal(listed.length, 2);
      writeFileSync(join(made.path, "a.txt"), "b\n");
      const removed = await c.request<{ removed: boolean; savedUncommitted: boolean }>("worktree.remove", { cwd, path: made.path });
      assert.deepEqual([removed.removed, removed.savedUncommitted], [true, true]);
      assert.equal(git(cwd, "show", "lykos/spike:a.txt"), "b");
      await assert.rejects(c.request("worktree.remove", { cwd, path: cwd }), /own checkout|not a worktree/);
      // P5 #46: the diff viewer's changes.
      writeFileSync(join(cwd, "a.txt"), "changed\n");
      const diff = await c.request<{ base: string; files: { file: string; patch: string }[] }>("vcs.diff", { cwd, mode: "working" });
      assert.equal(diff.base, "HEAD");
      assert.deepEqual(diff.files.map((f) => f.file), ["a.txt"]);
      assert.match(diff.files[0]!.patch, /^\+changed$/m);
      await assert.rejects(c.request("vcs.diff", { cwd, mode: "nope" }), /unknown mode/);
      c.close();
    } finally {
      await server.stop("test");
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
