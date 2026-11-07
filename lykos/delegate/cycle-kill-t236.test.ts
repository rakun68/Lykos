// T236 ACCEPTANCE (G10, spec decision 13): a real `lykos cycle` process is killed while its fixer runs a job.
//
// Everything here is real except the model: the cycle is the `lykos cycle` command in a process of its own, its reviewer
// and fixer are real `lykos session-child` processes against the fake Anthropic server, the fixer's job is a real process
// behind its spawn guard, the checks run in real worktrees with `node --test`, and the recover is the `lykos recover`
// command in a third process. The model is scripted: the implementer writes the planted bug's file, the reviewer calls the
// `finding` tool with a reproduction, the fixer starts a job that never ends (and is cut off), and after the recover it
// writes the fix.
//
// What must hold: the job is gone once the cycle process is; `status` lists the cycle as crashed with `next recover`;
// `recover <cycle>` continues it; no second fixer starts (the step's request id found the session it had started); the
// cut-off call is replayed to the model as outcome unknown; the proof suite retires the finding; the cycle approves.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { openCredentialDb } from "../credentials/db.js";
import { startFakeAnthropicServer, type FakeAnthropicServer } from "../credentials/fake-anthropic-server.js";
import { upsertCredential } from "../credentials/pool.js";
import { defaultLedgerPath, openLedgerSync } from "../ledger/use.js";
import { resolveProject } from "../session/identity.js";
import { INTERRUPTED_OUTCOME } from "../session/replay.js";
import { findGuardedProcesses } from "../process/guard.js";
import { liveness } from "../process/identity.js";
import { runDelegated } from "./mcp-server.js";
import { ownerRow } from "./ownership.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "..", "..", "fixtures", "demo");
const tsx = import.meta.resolve("tsx");
const cli = resolve("lykos", "cli.ts");
const PROVIDER = "fakeprov";

let server: FakeAnthropicServer;
const saved: Record<string, string | undefined> = {};
before(async () => {
  server = await startFakeAnthropicServer();
  for (const k of ["HOME", "USERPROFILE", "LYKOS_TRUST_WORKSPACE", "NODE_TEST_CONTEXT", "LYKOS_CREDENTIALS_DB", "PI_CODING_AGENT_DIR"]) saved[k] = process.env[k];
});
after(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await server.close();
});

const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } }).trim();

const IMPLEMENTED = readFileSync(join(FIXTURE, "src", "pricing.js"), "utf8").replace("return 0;", "return Math.floor((cents * (100 - clampPercent(percent))) / 100 + 0.5);");
const FIXED = IMPLEMENTED.replace("Math.min(1000,", "Math.min(100,");
const REPRO = {
  kind: "reproduction",
  file: "test/cycle-repro.test.js",
  content: `import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { applyDiscount } from "../src/pricing.js";\ntest("a discount above 100 percent never makes a price negative", () => assert.equal(applyDiscount(1000, 150), 0));\n`,
  fails: ["a discount above 100 percent never makes a price negative"],
};

async function waitFor<T>(read: () => T | undefined, ms: number, what: string | (() => string)): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${typeof what === "string" ? what : what()}`);
    await sleep(100);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("T236 ACCEPTANCE (G10): the `lykos cycle` process killed while its fixer runs a job", () => {
  it("the job is gone, recover continues the cycle, no second fixer starts, the cut-off call shows outcome unknown", { timeout: 900_000 }, async () => {
    // The world: a throwaway home with a pooled credential and the project trusted by the user's store, a repository
    // made of the demonstration fixture, a config that points every model at the fake server.
    const root = mkdtempSync(join(tmpdir(), "lykos-t236k-"));
    const home = join(root, "home");
    const ws = join(root, "ws");
    mkdirSync(join(home, ".lykos"), { recursive: true });
    cpSync(FIXTURE, ws, { recursive: true });
    mkdirSync(join(ws, ".lykos"), { recursive: true });
    writeFileSync(
      join(ws, ".lykos", "config.yaml"),
      [
        "providers:",
        `  ${PROVIDER}:`,
        "    auth: api_key",
        `    baseUrl: ${server.baseUrl}`,
        "    api: anthropic-messages",
        "    models:",
        "      - id: m1",
        "models:",
        "  roles:",
        `    review-both: ${PROVIDER}/m1`,
        `    review-both-alt: ${PROVIDER}/m1`,
        "seal:",
        "  test_command: node --test {files}",
        "delegation:",
        "  spec_check: false",
        "feedback:",
        "  enabled: false",
        "",
      ].join("\n"),
    );
    writeFileSync(join(ws, ".gitignore"), ".lykos/\nnode_modules/\n");
    git(ws, "init", "-q", "-b", "main");
    git(ws, "config", "core.autocrlf", "false");
    git(ws, "add", "-A");
    git(ws, "commit", "-q", "-m", "first");
    const dbPath = join(root, "credentials.db");
    const db = openCredentialDb(dbPath, { create: true })!;
    try {
      upsertCredential(db, PROVIDER, { type: "api_key", key: "pooled-key" });
    } finally {
      db.close();
    }
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), LYKOS_CREDENTIALS_DB: dbPath, LYKOS_SESSION_PROGRESS_MS: "200" };
    delete env["LYKOS_TRUST_WORKSPACE"];
    delete env["NODE_TEST_CONTEXT"];
    Object.assign(process.env, env);
    delete process.env["LYKOS_TRUST_WORKSPACE"];
    delete process.env["NODE_TEST_CONTEXT"];
    // The user's store trusts the project, so the harness may run a reviewer's reproduction on the host.
    const project = resolveProject(ws);
    writeFileSync(join(home, ".lykos", "trust.json"), JSON.stringify({ version: 1, projects: { [project.id]: { trustedUtc: new Date().toISOString() } } }));

    // The project's remembered approvals: the fixer's long job is a command a person approved, as in a real project.
    writeFileSync(join(home, ".lykos", "permissions.json"), JSON.stringify({ version: 1, projects: { [project.id]: { allow: ["npm run slow-check", "npm run"] } } }));

    const lykos = (...args: string[]) => spawnSync(process.execPath, ["--import", tsx, cli, ...args], { cwd: ws, encoding: "utf8", windowsHide: true, input: "", env, timeout: 600_000 });

    // 1. The implementer: a real session that writes the file, planted bug and all.
    server.reset();
    server.script.set("pooled-key", [{ kind: "ok", text: "nothing more to say" }]);
    server.upcoming.push({ kind: "tool", name: "write", input: { path: "src/pricing.js", content: IMPLEMENTED } }, { kind: "ok", text: "implemented applyDiscount" });
    const made = await runDelegated(ws, { brief: "Implement applyDiscount in src/pricing.js following SPEC.md.", specialist: "implement", model: `${PROVIDER}/m1` }, { trustSource: "stored" });
    assert.equal(made["outcome"] === "ok" || made["outcome"] === "unverified", true, JSON.stringify(made));
    const implementer = made["sessionId"] as string;
    assert.match(git(ws, "show", `lykos/${implementer}:src/pricing.js`), /cents \* \(100 - clampPercent\(percent\)\)/);
    assert.equal(server.seen.length, 2, "the implementer made two model calls");

    // 2. The cycle, as its own process. The scripted model: the reviewer reports the planted bug with a reproduction, then
    //    the fixer starts a job that never ends. Later calls are the recover's: the fix, then the recheck's answer.
    server.upcoming.push(
      { kind: "tool", name: "finding", input: { text: "A discount above 100 percent makes the price negative (SPEC rules 1 and 2).", severity: "high", basis: "src/pricing.js:5", check: REPRO } },
      { kind: "ok", text: "reviewed: one finding" },
      { kind: "tool", name: "bash", input: { command: "npm run slow-check" } },
      { kind: "tool", name: "write", input: { path: "src/pricing.js", content: FIXED } },
      { kind: "ok", text: "fixed: the clamp is 0..100" },
      { kind: "ok", text: "rechecked: nothing more" },
    );
    const owner = spawn(process.execPath, ["--import", tsx, cli, "cycle", implementer], { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let ownerOut = "";
    let ownerErr = "";
    owner.stdout!.on("data", (c: Buffer) => (ownerOut += c.toString()));
    owner.stderr!.on("data", (c: Buffer) => (ownerErr += c.toString()));
    const ownerPid = owner.pid!;

    // The job: the command a guard of the fixer's session holds. Its tree is read from the OS while the fixer waits on it.
    const jobPids = await waitFor(() => {
      const l = openLedgerSync(defaultLedgerPath(ws));
      try {
        for (const r of l.processRecords(implementer).filter((x) => x.kind === "guard" && x.ended_at === null)) {
          const tree = findGuardedProcesses({ pid: r.pid, recordedAt: r.recorded_at_ms });
          if (tree !== undefined && tree.filter((p) => p !== r.pid).length > 0) return tree;
        }
        return undefined;
      } finally {
        l.close();
      }
    }, 300_000, () => `the fixer's job (cycle said: ${ownerErr.slice(-1500)}; the model was asked ${server.seen.length} times)`);
    assert.ok(jobPids.some(alive), "the fixer's job is running");
    const cycleId = await waitFor(() => {
      const l = openLedgerSync(defaultLedgerPath(ws));
      try {
        return (l.db.prepare("SELECT id FROM cycles").get() as { id: string } | undefined)?.id;
      } finally {
        l.close();
      }
    }, 10_000, "the cycle row");
    const fixStep = await waitFor(() => {
      const l = openLedgerSync(defaultLedgerPath(ws));
      try {
        return l.db.prepare("SELECT step_id, request_id, state FROM cycle_steps WHERE cycle_id = ? AND kind = 'fix'").get(cycleId) as { step_id: string; request_id: string; state: string } | undefined;
      } finally {
        l.close();
      }
    }, 10_000, "the fix step");
    assert.equal(fixStep.state, "started");
    assert.equal(fixStep.request_id, `${cycleId}.${fixStep.step_id}`);

    // 3. Killed. The job dies with it: its guard saw its session go.
    owner.kill("SIGKILL");
    await new Promise<void>((r) => (owner.exitCode !== null || owner.signalCode !== null ? r() : owner.once("exit", () => r())));
    await waitFor(() => (jobPids.some(alive) ? undefined : true), 60_000, `the job (pids ${jobPids.join(", ")}) to be gone`);
    assert.equal(jobPids.some(alive), false, "the job is gone");

    // The session child is gone too, and the ledger can prove it (confirmed quiescence).
    const fixerRecords = (() => {
      const l = openLedgerSync(defaultLedgerPath(ws));
      try {
        return l.processRecords(implementer).filter((r) => r.ended_at === null);
      } finally {
        l.close();
      }
    })();
    await waitFor(() => (fixerRecords.every((r) => liveness({ pid: r.pid, recordedAt: r.recorded_at_ms }) === "dead") ? true : undefined), 60_000, "the fixer's processes to be gone");

    // 4. `status` lists the cycle with next recover.
    const status = JSON.parse(lykos("status", cycleId).stdout) as { cycles: Array<{ state: string; next: string; owner_pid: number; step: { kind: string; state: string } }>; next: string };
    assert.equal(status.cycles[0]!.state, "crashed");
    assert.equal(status.cycles[0]!.owner_pid, ownerPid);
    assert.equal(status.cycles[0]!.next, "recover");
    assert.deepEqual([status.cycles[0]!.step.kind, status.cycles[0]!.step.state], ["fix", "started"]);
    assert.equal(status.next, "recover");
    const callsBefore = server.seen.length;

    // 5. `lykos recover <cycle>` continues it from the fix step.
    // Asynchronously: the fake model server lives in this process, and a blocked event loop would answer nobody.
    const recovered = await new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
      const child = spawn(process.execPath, ["--import", tsx, cli, "recover", cycleId], { cwd: ws, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      child.on("exit", (code) => res({ status: code, stdout, stderr }));
    });
    assert.equal(recovered.status, 0, `recover failed (the model was answered with: ${server.served.join(", ")}): ${recovered.stdout}
${recovered.stderr.slice(-1500)}`);
    const result = JSON.parse(recovered.stdout) as { stop: string; recovered?: { from_pid: number; crashes: number }; rounds: number; fixes: number; steps: Array<{ kind: string; state: string }> };
    assert.equal(result.stop, "approve", recovered.stdout);
    assert.deepEqual(result.recovered, { from_pid: ownerPid, crashes: 1 });
    assert.deepEqual(result.steps.map((s) => `${s.kind}:${s.state}`), ["review:done", "judge:done", "fix:done", "proof:done", "recheck:done", "judge:done"]);

    // No second fixer: one fix step, one request id for it, the one session crashed once.
    const l = openLedgerSync(defaultLedgerPath(ws));
    try {
      assert.equal((l.db.prepare("SELECT COUNT(*) AS n FROM cycle_steps WHERE cycle_id = ? AND kind = 'fix'").get(cycleId) as { n: number }).n, 1);
      assert.equal((l.db.prepare("SELECT COUNT(*) AS n FROM owner_requests WHERE request_id = ?").get(fixStep.request_id) as { n: number }).n, 1);
      assert.equal(ownerRow(l, implementer)!.crashes, 1, "the fixer's session was recovered once");
      const decisions = l.db.prepare("SELECT action, cycle_id FROM finding_decisions WHERE session_id = ? ORDER BY id").all(implementer) as Array<{ action: string; cycle_id: string }>;
      assert.deepEqual(decisions.map((d) => d.action), ["forwarded", "retired"]);
      assert.ok(decisions.every((d) => d.cycle_id === cycleId));
    } finally {
      l.close();
    }

    // The model was asked five more times in all after the kill: the recovered turn (the fix and its answer), the recheck.
    assert.equal(server.seen.length - callsBefore, 3, "the fix, its answer and the recheck's: the cut-off bash call was not asked for again");
    // The cut-off call is outcome unknown to the model: the recovered turn's request replays it so.
    const replay = server.bodies[callsBefore]!;
    assert.ok(replay.includes(INTERRUPTED_OUTCOME), "the recovered fixer is told the bash call's outcome is unknown");
    assert.match(replay, /You were interrupted: the process running this session died/);
    assert.match(git(ws, "show", `lykos/${implementer}:src/pricing.js`), /Math\.min\(100,/);
    void ownerOut;
  });
});
