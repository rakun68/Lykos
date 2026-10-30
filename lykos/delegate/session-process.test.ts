// Seam 3: the production runner against real processes.
//
// Two kinds of child. The real one is `lykos session-child` under tsx, running
// a real delegated session against a fake model server (the model is the only
// stand-in; the credential is the pool's, as in delegated-session-credential.test.ts).
// The stand-ins are one-line node scripts that speak or break the protocol on
// purpose: a crash, a child that prints where it should not, a child that
// never answers.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openCredentialDb } from "../credentials/db.js";
import { startFakeAnthropicServer, type FakeAnthropicServer } from "../credentials/fake-anthropic-server.js";
import { upsertCredential } from "../credentials/pool.js";
import { createProcessRunner, defaultChildCommand, type ChildCommand } from "./session-process.js";
import { PROTOCOL_VERSION, type SessionOutcome, type SessionRequest } from "./session-protocol.js";

const PROVIDER = "fakeprov";
let server: FakeAnthropicServer;
before(async () => {
  server = await startFakeAnthropicServer();
});
after(async () => {
  await server.close();
});

interface World {
  root: string;
  home: string;
  workspace: string;
  env: NodeJS.ProcessEnv;
}

/** A throwaway home, a pooled credential for the fake provider, and a workspace whose config points at the fake server. */
function world(extraConfig = ""): World {
  const root = mkdtempSync(join(tmpdir(), "lykos-session-process-"));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  mkdirSync(join(home, ".lykos"), { recursive: true });
  mkdirSync(join(workspace, ".lykos"), { recursive: true });
  writeFileSync(
    join(workspace, ".lykos", "config.yaml"),
    [
      "providers:",
      `  ${PROVIDER}:`,
      "    auth: api_key",
      `    baseUrl: ${server.baseUrl}`,
      "    api: anthropic-messages",
      "    models:",
      "      - id: m1",
      extraConfig,
      "",
    ].join("\n"),
  );
  // A repository: a writing call works on a worktree and branch of its own, and refuses a folder without one (T184).
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
  server.reset();
  server.script.set("pooled-key", [{ kind: "ok", text: "pong" }]);
  return {
    root,
    home,
    workspace,
    env: { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), LYKOS_CREDENTIALS_DB: dbPath, LYKOS_SESSION_PROGRESS_MS: "50" },
  };
}

function request(w: World, extra: Partial<SessionRequest> = {}): SessionRequest {
  return {
    version: PROTOCOL_VERSION,
    tool: "lykos_implement",
    workspace: w.workspace,
    prompt: "Reply with the word pong.",
    label: "lykos_implement",
    model: `${PROVIDER}/m1`,
    // Off: this proves the process boundary, not a container, and must not need a runtime on the machine running the test.
    containment: "off",
    ...extra,
  };
}

async function run(
  w: World,
  req: SessionRequest,
  opts: { child?: ChildCommand; signal?: AbortSignal; trustSource?: "stored" | "flag" | "prompt" } = {},
): Promise<{ outcome: SessionOutcome; progress: string[] }> {
  const progress: string[] = [];
  const runner = createProcessRunner({ env: w.env, ...(opts.child !== undefined ? { child: opts.child } : {}), exitGraceMs: 2000 });
  const outcome = await runner({
    request: req,
    trustSource: opts.trustSource ?? "flag",
    onProgress: (m) => progress.push(m),
    signal: opts.signal ?? new AbortController().signal,
  });
  return { outcome, progress };
}

/** A stand-in child: a node one-liner that gets `session-child` as an extra argument, like the real one. */
const script = (code: string): ChildCommand => ({ command: process.execPath, args: ["-e", code, "--"] });

describe("the real child (T181, stories 70-72)", () => {
  it("runs a delegated session in a process of its own, progress first, and continues it when given its id", async () => {
    const w = world();
    const { outcome, progress } = await run(w, request(w));
    assert.equal(outcome.outcome, "ok", JSON.stringify(outcome));
    if (outcome.outcome !== "ok") return;
    assert.match(outcome.answer!, /pong/);
    assert.ok(outcome.sessionId.length > 0, "every call returns a session id");
    assert.equal(outcome.containment, "off");
    assert.equal(outcome.runtime, undefined);
    assert.equal(outcome.branch, `lykos/${outcome.sessionId}`, "a writing call names the branch its work is on");
    assert.equal(progress[0], "session starting");
    assert.ok(progress.some((m) => /elapsed/.test(m)), `heartbeats arrive while the session runs: ${progress.join(" | ")}`);
    assert.deepEqual([...new Set(server.seen)], ["pooled-key"], "the model call used the pool's credential");

    // Continuation: a later call with the id is the same session, with the earlier turn replayed.
    server.script.set("pooled-key", [{ kind: "ok", text: "again" }]);
    const continued = await run(w, request(w, { sessionId: outcome.sessionId, prompt: "Say it again." }));
    const second = continued.outcome;
    assert.ok(continued.progress.some((m) => /replayed context.*unmeasured/.test(m) && !/\d+ tokens/.test(m)), `no invented size: ${continued.progress.join(" | ")}`);
    assert.equal(second.outcome, "ok", JSON.stringify(second));
    if (second.outcome !== "ok") return;
    assert.equal(second.sessionId, outcome.sessionId);
    assert.match(second.answer!, /again/);
  });

  it("refuses to continue a session that does not exist, naming it", async () => {
    const w = world();
    const { outcome } = await run(w, request(w, { sessionId: "no-such-session" }));
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") {
      assert.match(outcome.message, /could not continue session no-such-session/);
      assert.equal(outcome.sessionId, "no-such-session");
    }
    assert.equal(server.seen.length, 0, "no model call was made");
  });

  it("applies the floor across the boundary: a request below containment.minimum is refused in the child before any model call", async () => {
    const w = world("containment:\n  minimum: required");
    const { outcome } = await run(w, request(w, { containment: "off" }));
    assert.equal(outcome.outcome, "error", JSON.stringify(outcome));
    if (outcome.outcome === "error") {
      assert.match(outcome.message, /containment level "off" \(from --containment\) is below the floor "required"/);
      assert.match(outcome.message, new RegExp(w.workspace.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&").replace(/\\\\/g, "\\\\")));
    }
    assert.equal(server.seen.length, 0, "the session never booted");
  });
});

describe("a child that breaks the protocol (T181, story 72)", () => {
  it("a crash returns an error result with the exit code and what the child said, and the next call is served", async () => {
    const w = world();
    const crashed = await run(w, request(w), { child: script("process.stderr.write('boom: out of memory\\n'); process.exit(3)") });
    assert.equal(crashed.outcome.outcome, "error");
    if (crashed.outcome.outcome === "error") {
      assert.match(crashed.outcome.message, /exited with code 3 before reporting a result/);
      assert.match(crashed.outcome.message, /boom: out of memory/);
    }
    const okChild = script("process.stdin.once('data', () => console.log(JSON.stringify({type:'result',result:{outcome:'ok',answer:'fine',sessionId:'s2'}})));");
    const next = await run(w, request(w), { child: okChild });
    assert.deepEqual(next.outcome, { outcome: "ok", answer: "fine", sessionId: "s2" });
  });

  it("a child killed by a signal is reported as killed", async () => {
    const w = world();
    const { outcome } = await run(w, request(w), { child: script("process.kill(process.pid, 'SIGKILL'); setTimeout(() => {}, 5000)") });
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") assert.match(outcome.message, /killed by SIGKILL|exited with code/);
  });

  it("anything the child prints that is not a frame never reaches this process's stdout, and the frames still work", async () => {
    const w = world();
    const seen: string[] = [];
    const realWrite = process.stdout.write;
    process.stdout.write = ((chunk: unknown) => (seen.push(String(chunk)), true)) as typeof process.stdout.write;
    let outcome: SessionOutcome;
    let progress: string[];
    try {
      ({ outcome, progress } = await run(w, request(w), {
        child: script(
          "console.log('hello from a dependency banner');" +
            "console.log(JSON.stringify({type:'progress',message:'working'}));" +
            "console.log('{not json');" +
            "console.log(JSON.stringify({type:'result',result:{outcome:'ok',answer:'fine',sessionId:'s1'}}));",
        ),
      }));
    } finally {
      process.stdout.write = realWrite;
    }
    // (The test runner writes to stdout too, so look for the child's words, not for silence.)
    assert.deepEqual(seen.filter((c) => /dependency banner|not json|"type":"(progress|result)"/.test(c)), [], "nothing the child printed reached this process's stdout");
    assert.deepEqual(progress, ["working"]);
    assert.deepEqual(outcome, { outcome: "ok", answer: "fine", sessionId: "s1" });
  });
});

describe("one process per call (T181, story 72)", () => {
  it("two concurrent calls run in two processes at the same time", async () => {
    const w = world();
    // Each stand-in waits 400 ms and answers with its own pid and the interval it was alive.
    const child = script(
      "const start = Date.now(); process.stdin.once('data', () => setTimeout(() => {" +
        "console.log(JSON.stringify({type:'result',result:{outcome:'ok',answer:JSON.stringify({pid:process.pid,start,end:Date.now()}),sessionId:'s'}}));" +
        "}, 400));",
    );
    const [a, b] = await Promise.all([run(w, request(w), { child }), run(w, request(w), { child })]);
    const seen = [a, b].map((r) => {
      assert.equal(r.outcome.outcome, "ok", JSON.stringify(r.outcome));
      return JSON.parse((r.outcome as Extract<SessionOutcome, { outcome: "ok" }>).answer!) as { pid: number; start: number; end: number };
    });
    assert.notEqual(seen[0]!.pid, seen[1]!.pid, "two processes");
    assert.notEqual(seen[0]!.pid, process.pid);
    assert.ok(seen[0]!.start < seen[1]!.end && seen[1]!.start < seen[0]!.end, "their lifetimes overlapped");
  });

  it("cancelling a call stops its process", async () => {
    const w = world();
    const pids = new Map<string, number>();
    const hang = script("process.stdin.once('data', () => { console.log(JSON.stringify({type:'progress',message:String(process.pid)})); setInterval(() => {}, 1000); });");
    const controller = new AbortController();
    const progress: string[] = [];
    const runner = createProcessRunner({ env: w.env, child: hang });
    const cancelled = runner({
      request: request(w),
      trustSource: "flag",
      onProgress: (m) => {
        progress.push(m);
        pids.set("pid", Number(m));
        controller.abort();
      },
      signal: controller.signal,
    });
    const outcome = await cancelled;
    assert.equal(outcome.outcome, "error");
    if (outcome.outcome === "error") assert.match(outcome.message, /cancelled/);
    const pid = pids.get("pid")!;
    await new Promise((r) => setTimeout(r, 200));
    assert.throws(() => process.kill(pid, 0), "the child process is gone");
  });
});

describe("how the child is started (T181)", () => {
  it("is node on Lykos's entry script, never a .cmd shim", () => {
    const command = defaultChildCommand();
    assert.equal(command.command, process.execPath);
    assert.match(command.args.at(-1)!, /[\\/]cli\.(ts|js)$/);
    assert.doesNotMatch(command.command, /\.cmd$/i);
  });
});
