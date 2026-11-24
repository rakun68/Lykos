// A real `lykos server-session` child under the engine server (P5 #35): a real interactive session against a fake
// model server, its events over the protocol, an approval asked and answered over it, and its ledger row.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openCredentialDb } from "../credentials/db.js";
import { startFakeAnthropicServer, type FakeAnthropicServer } from "../credentials/fake-anthropic-server.js";
import { upsertCredential } from "../credentials/pool.js";
import { engineAddress, readOrCreateKey } from "./address.js";
import { connectEngine } from "./client.js";
import type { Event, SessionOptions, SessionSummary } from "./protocol.js";
import { EngineServer } from "./server.js";
import { defaultLedgerPath } from "../ledger/ledger.js";
import { openLedger } from "../ledger/use.js";
import { loadSessionSummary } from "../ledger/summary.js";

const PROVIDER = "fakeprov";
let model: FakeAnthropicServer;
before(async () => {
  model = await startFakeAnthropicServer();
});
after(async () => {
  await model.close();
});

function world(): { root: string; workspace: string; env: NodeJS.ProcessEnv; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "lykos-server-session-"));
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
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: workspace, stdio: "pipe" });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  const dbPath = join(root, "credentials.db");
  const db = openCredentialDb(dbPath, { create: true })!;
  try {
    upsertCredential(db, PROVIDER, { type: "api_key", key: "pooled-key" });
  } finally {
    db.close();
  }
  model.reset();
  return {
    root,
    workspace,
    dir: join(root, "run"),
    env: { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), LYKOS_CREDENTIALS_DB: dbPath },
  };
}

describe("a real session on the engine server", () => {
  it("streams a turn, asks an approval over the protocol, and closes into the ledger", async () => {
    const w = world();
    model.script.set("pooled-key", [
      { kind: "ok", text: "pong" },
      { kind: "ok", text: "an aside" },
      { kind: "tool", name: "write", input: { path: "note.txt", content: "hi\n" } },
      { kind: "ok", text: "written" },
    ]);
    const address = engineAddress(w.dir);
    const server = new EngineServer({ address, idleSeconds: 60, env: w.env, log: () => {}, trust: async () => "flag" });
    await server.listen();
    try {
      const c = await connectEngine(address, readOrCreateKey(address));
      const events: Event[] = [];
      const waiters: Array<() => void> = [];
      c.onEvent((e) => {
        events.push(e);
        for (const w of waiters.splice(0)) w();
      });
      const until = async (pred: (e: Event) => boolean, what: string): Promise<Event> => {
        const deadline = Date.now() + 60_000;
        for (;;) {
          const hit = events.find(pred);
          if (hit) return hit;
          if (Date.now() > deadline) throw new Error(`no ${what} in ${JSON.stringify(events.map((e) => e.data), null, 1)}`);
          await new Promise<void>((r) => {
            waiters.push(r);
            setTimeout(r, 500);
          });
        }
      };
      const status = (s: SessionSummary["status"], from = 0) => (e: Event) => e.seq > from && e.data.type === "session.status" && e.data.session.status === s;
      await c.request("subscribe");
      const s = await c.request<SessionSummary>("session.start", { cwd: w.workspace, model: `${PROVIDER}/m1` });
      const booted = await until(status("idle"), "boot");
      assert.ok(booted.data.type === "session.status" && booted.data.session.ledgerSessionId, "the ledger's session id is known once booted");

      await c.request("session.prompt", { session: s.id, text: "Reply with the word pong." });
      const turn = await until((e) => e.data.type === "turn.end", "turn.end");
      const reply = events.filter((e) => e.seq < turn.seq && e.data.type === "message.delta").map((e) => (e.data as { text: string }).text).join("");
      assert.match(reply, /pong/);
      const usage = await until((e) => e.data.type === "usage", "usage");
      // P5 #53: the old footer's numbers ride the usage event, as the ledger's HUD read them.
      assert.ok(usage.data.type === "usage");
      assert.equal(typeof usage.data.usage.tokens.fresh, "number");
      assert.equal(typeof usage.data.usage.tokens.cacheWrite, "number");
      assert.ok(Array.isArray(usage.data.usage.alerts));
      const commands = await until((e) => e.data.type === "commands", "the commands event");
      assert.ok(commands.data.type === "commands" && commands.data.commands.some((c) => c.name === "/help" && c.source === "builtin"));

      // A side question: answered by the model, and kept out of the conversation the next turn sends.
      const before = events.length;
      assert.deepEqual(await c.request("session.aside", { session: s.id, text: "What did you just say?" }), { answer: "an aside", model: `${PROVIDER}/m1` });
      assert.equal(events.length, before, "an aside adds no event");
      // What the pickers list, read from the live session.
      const options = await c.request<SessionOptions>("session.options", { session: s.id });
      assert.equal(options.model, `${PROVIDER}/m1`);
      assert.ok(options.models.some((m) => m.provider === PROVIDER && m.id === "m1"), "the session's model is listed");
      assert.ok(options.specialists.some((p) => p.name === options.specialist), "the active specialist is listed");

      await c.request("session.prompt", { session: s.id, text: "Write note.txt." });
      const req = await until((e) => e.data.type === "request", "an approval request");
      assert.ok(req.data.type === "request");
      assert.equal(req.data.request.kind, "approval");
      assert.ok(req.data.request.options.some((o) => o.value === "y"));
      // P5 #46: a write shows its change as a diff, and the standing decisions say what they keep allowing.
      assert.match(req.data.request.patch ?? "", /^@@ -0,0 \+1(,1)? @@\n\+hi$/m, "a new file's lines are all added");
      assert.match(req.data.request.options.find((o) => o.value === "a")?.note ?? "", /every write for the rest of this session/);
      await c.request("session.answer", { session: s.id, requestId: req.data.request.requestId, answer: "y" });
      await until((e) => e.data.type === "request.resolved", "request.resolved");
      await until((e) => e.data.type === "tool.end" && e.data.ok, "the write finishing");
      assert.ok(model.bodies.at(-1)!.includes("Write note.txt.") && !model.bodies.at(-1)!.includes("What did you just say?"), "the aside is not in the conversation");

      await c.request("session.close", { session: s.id });
      const closed = await until(status("closed"), "closed");
      // P5 #53: the gate's verdict at the session's end is a system line the client shows.
      assert.ok(
        events.some((e) => e.seq < closed.seq && e.data.type === "system" && e.data.text.startsWith("lykos gate:")),
        `the gate's line: ${JSON.stringify(events.filter((e) => e.data.type === "system").map((e) => e.data))}`,
      );
      c.close();
      // `crates/client`'s store is tested against this stream: LYKOS_RECORD_EVENTS=<file> rewrites it.
      if (process.env.LYKOS_RECORD_EVENTS) writeFileSync(process.env.LYKOS_RECORD_EVENTS, events.map((e) => `${JSON.stringify(e).split(JSON.stringify(w.root).slice(1, -1)).join("/fixture")}\n`).join(""));
      assert.ok(closed.data.type === "session.status");
      const ledgerId = closed.data.session.ledgerSessionId!;
      await new Promise((r) => setTimeout(r, 500));
      const ledger = await openLedger(defaultLedgerPath(w.workspace));
      try {
        const row = loadSessionSummary(ledger, ledgerId);
        assert.ok(row, "the session has its ledger row");
        assert.ok(row.session.ended_utc, "and it was ended when the session closed");
        assert.ok(row.session.turns >= 2, `both turns recorded: ${row.session.turns}`);
        const asides = ledger.db.prepare("SELECT COUNT(*) AS n FROM calls WHERE session_id = ? AND phase = 'aside'").get(ledgerId) as { n: number };
        assert.equal(asides.n, 1, "the aside's call is in the ledger");
      } finally {
        ledger.close();
      }
    } finally {
      await server.stop("test");
    }
  });

  it("runs the old TUI's commands: /context, /mode, and /followup (P5 #55)", async () => {
    const w = world();
    model.script.set("pooled-key", [
      { kind: "tool", name: "write", input: { path: "note.txt", content: "hi\n" } },
      { kind: "ok", text: "written" },
      { kind: "ok", text: "done" },
    ]);
    const address = engineAddress(w.dir);
    const server = new EngineServer({ address, idleSeconds: 60, env: w.env, log: () => {}, trust: async () => "flag" });
    await server.listen();
    try {
      const c = await connectEngine(address, readOrCreateKey(address));
      const events: Event[] = [];
      c.onEvent((e) => events.push(e));
      const until = async (pred: (e: Event) => boolean, what: string): Promise<Event> => {
        const deadline = Date.now() + 60_000;
        for (;;) {
          const hit = events.find(pred);
          if (hit) return hit;
          if (Date.now() > deadline) throw new Error(`no ${what} in ${JSON.stringify(events.map((e) => e.data), null, 1)}`);
          await new Promise((r) => setTimeout(r, 200));
        }
      };
      const system = (re: RegExp) => (e: Event) => e.data.type === "system" && re.test(e.data.text);
      await c.request("subscribe");
      const s = await c.request<SessionSummary>("session.start", { cwd: w.workspace, model: `${PROVIDER}/m1` });
      await until((e) => e.data.type === "session.status" && e.data.session.status === "idle", "boot");

      await c.request("session.prompt", { session: s.id, text: "/context" });
      // A command's answer is a report the TUI shows in a popup, not a line of the conversation (#58).
      await until((e) => e.data.type === "report" && e.data.command === "context" && /^context /.test(e.data.text), "the context report");

      // Auto runs a write inside the workspace without asking, and the model is told the mode changed.
      await c.request("session.prompt", { session: s.id, text: "/mode auto" });
      await until(system(/^mode: Auto/), "the mode line");
      await c.request("session.prompt", { session: s.id, text: "Write note.txt." });
      const first = await until((e) => e.data.type === "turn.end", "the write's turn");
      assert.ok(events.some((e) => e.seq < first.seq && e.data.type === "tool.end" && e.data.ok), "the write ran");
      assert.ok(!events.some((e) => e.data.type === "request"), "Auto asked nothing");
      assert.ok(model.bodies.some((b) => b.includes("Interaction mode is now Auto")), "the model was told");

      await c.request("session.prompt", { session: s.id, text: "/followup Reply with done." });
      const second = await until((e) => e.seq > first.seq && e.data.type === "turn.end", "the follow-up's turn");
      const reply = events.filter((e) => e.seq > first.seq && e.seq < second.seq && e.data.type === "message.delta").map((e) => (e.data as { text: string }).text).join("");
      assert.match(reply, /done/);
      assert.ok(model.bodies.at(-1)!.includes("Reply with done."));

      await c.request("session.close", { session: s.id });
      await until((e) => e.data.type === "session.status" && e.data.session.status === "closed", "closed");
      c.close();
    } finally {
      await server.stop("test");
    }
  });

  it("puts an undone prompt back in the client's prompt, and resumes the session it closed under the same id (P5 #42)", async () => {
    const w = world();
    model.script.set("pooled-key", [
      { kind: "ok", text: "pong" },
      { kind: "ok", text: "again" },
    ]);
    const address = engineAddress(w.dir);
    const logs: string[] = [];
    const server = new EngineServer({ address, idleSeconds: 60, env: w.env, log: (l) => logs.push(l), trust: async () => "flag" });
    await server.listen();
    try {
      const c = await connectEngine(address, readOrCreateKey(address));
      const events: Event[] = [];
      c.onEvent((e) => events.push(e));
      const until = async (pred: (e: Event) => boolean, what: string): Promise<Event> => {
        const deadline = Date.now() + 60_000;
        for (;;) {
          const hit = events.find(pred);
          if (hit) return hit;
          if (Date.now() > deadline) throw new Error(`no ${what} in ${JSON.stringify(events.map((e) => e.data), null, 1)}`);
          await new Promise((r) => setTimeout(r, 200));
        }
      };
      await c.request("subscribe");
      const first = await c.request<SessionSummary>("session.start", { cwd: w.workspace, model: `${PROVIDER}/m1` });
      const mine = (id: string) => (e: Event) => e.session === id;
      await until((e) => mine(first.id)(e) && e.data.type === "session.status" && e.data.session.status === "idle", "boot");
      await c.request("session.prompt", { session: first.id, text: "Reply with the word pong." });
      await until((e) => mine(first.id)(e) && e.data.type === "turn.end", "turn.end");
      await c.request("session.prompt", { session: first.id, text: "/undo" });
      const set = await until((e) => mine(first.id)(e) && e.data.type === "prompt.set", "prompt.set");
      assert.ok(set.data.type === "prompt.set" && set.data.text === "Reply with the word pong.");
      await c.request("session.prompt", { session: first.id, text: "Say it again." });
      await until((e) => mine(first.id)(e) && e.data.type === "turn.end" && events.filter((x) => mine(first.id)(x) && x.data.type === "turn.end").length === 2, "second turn.end");
      await c.request("session.close", { session: first.id });
      const closed = await until((e) => mine(first.id)(e) && e.data.type === "session.status" && e.data.session.status === "closed", "closed");
      const ledgerId = closed.data.type === "session.status" ? closed.data.session.ledgerSessionId! : "";

      const again = await c.request<SessionSummary>("session.start", { cwd: w.workspace, resume: ledgerId });
      const boot = (e: Event) => mine(again.id)(e) && e.data.type === "session.status" && e.data.session.status === "idle";
      // A resume whose preflight needs agreement asks for it over the protocol.
      while (!events.some(boot)) {
        const ask = events.find((e) => mine(again.id)(e) && e.data.type === "request" && !events.some((r) => r.data.type === "request.resolved" && e.data.type === "request" && r.data.requestId === e.data.request.requestId));
        if (ask && ask.data.type === "request") await c.request("session.answer", { session: again.id, requestId: ask.data.request.requestId, answer: "y" });
        if (events.some((e) => mine(again.id)(e) && e.data.type === "session.status" && e.data.session.status === "closed")) {
          throw new Error(`the resume ended:\n${logs.slice(-40).join("\n")}`);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      const booted = events.find(boot)!;
      assert.ok(booted.data.type === "session.status" && booted.data.session.ledgerSessionId === ledgerId, "the same ledger session continues");
      // The conversation so far shows in the resumed session, without the turn the undo took back.
      const said = events.filter((e) => mine(again.id)(e) && e.data.type === "message.user").map((e) => (e.data.type === "message.user" ? e.data.text : ""));
      assert.deepEqual(said, ["Say it again."]);
      assert.ok(events.some((e) => mine(again.id)(e) && e.data.type === "message.delta" && e.data.text === "again"), "the answer shows too");
      await c.request("session.close", { session: again.id });
      await until((e) => mine(again.id)(e) && e.data.type === "session.status" && e.data.session.status === "closed", "closed again");
      c.close();
    } finally {
      await server.stop("test");
    }
  });
});
