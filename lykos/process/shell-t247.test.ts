// T247: one shell, guarded. Pi's bash tool on Lykos's own guarded backend, the guard recorded before the command
// runs, harness shell lines in the resolved bash (never cmd.exe), `lykos doctor` naming it, and no `powershell`
// tool in a delegated session unless config turns it on.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createBashToolDefinition, type BashOperations } from "@earendil-works/pi-coding-agent";
import { checkHostBash } from "../cli/doctor.js";
import { call, reply, runScriptedSession, say } from "../cli/scripted-session.js";
import { openLedgerSync } from "../ledger/use.js";
import { runVerificationCommand } from "../session/verify-outcome.js";
import { localExecutor } from "../tools/executor.js";
import { bashCommandLine, resolveHostBash } from "./host-bash.js";
import { pidExists } from "./identity.js";
import { createGuardedExecutor } from "./shell.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lykos-t247-"));
}

async function waitFor(check: () => boolean, ms = 10_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return true;
    await sleep(50);
  }
  return check();
}

function guardedBash(records: Array<{ pid: number; command: string }> = []): BashOperations {
  return createGuardedExecutor({ record: (pid, command) => void records.push({ pid, command }) }).shellOperations("bash");
}

async function exec(ops: BashOperations, command: string, cwd: string, opts: { timeout?: number; signal?: AbortSignal } = {}): Promise<{ out: string; exitCode: number | null }> {
  let out = "";
  const { exitCode } = await ops.exec(command, cwd, { onData: (d: Buffer) => (out += d.toString("utf8")), ...opts });
  return { out, exitCode };
}

describe("T247: the guarded bash backend", () => {
  it("runs a command, streams its output and returns its exit code", async () => {
    const dir = tmp();
    const ran = await exec(guardedBash(), "echo hello; echo err >&2; exit 3", dir);
    assert.match(ran.out, /hello/);
    assert.match(ran.out, /err/);
    assert.equal(ran.exitCode, 3);
  });

  it("Pi's bash tool runs on it", async () => {
    const dir = tmp();
    const tool = createBashToolDefinition(dir, { operations: guardedBash() });
    const result = await tool.execute("call-1", { command: "echo via-tool" }, undefined, undefined, undefined as never);
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    assert.match(text, /via-tool/);
  });

  it("the guard is recorded before the command runs", async () => {
    const dir = tmp();
    const marker = join(dir, "recorded");
    const ops = createGuardedExecutor({ record: () => writeFileSync(marker, "x") }).shellOperations("bash");
    const ran = await exec(ops, "test -f recorded && echo was-recorded || echo not-recorded", dir);
    assert.match(ran.out, /was-recorded/);
  });

  it("a record that fails runs nothing", async () => {
    const dir = tmp();
    const ops = createGuardedExecutor({
      record: () => {
        throw new Error("ledger unavailable");
      },
    }).shellOperations("bash");
    await assert.rejects(exec(ops, "echo ran > ran.txt", dir), /ledger unavailable/);
    await sleep(300);
    assert.equal(existsSync(join(dir, "ran.txt")), false);
  });

  it("a timeout kills the command's tree and reports timeout:<s>", async () => {
    const dir = tmp();
    const pidFile = join(dir, "pid");
    const started = Date.now();
    await assert.rejects(exec(guardedBash(), `sleep 30 & echo $! > pid; wait`, dir, { timeout: 1 }), /^Error: timeout:1$/);
    assert.ok(Date.now() - started < 15_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    // Git Bash's `$!` is its own pid, not a Windows one: the tree kill is checked where the pid is the OS's.
    if (process.platform !== "win32") assert.ok(await waitFor(() => pidExists(pid) === false), "the background sleep is gone");
  });

  it("an abort kills the command and reports aborted", async () => {
    const dir = tmp();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    await assert.rejects(exec(guardedBash(), "sleep 30", dir, { signal: controller.signal }), /^Error: aborted$/);
    assert.ok(Date.now() - started < 15_000);
  });

  it("an aborted signal before the call runs nothing", async () => {
    const records: Array<{ pid: number; command: string }> = [];
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(exec(guardedBash(records), "echo x", tmp(), { signal: controller.signal }), /aborted/);
    assert.equal(records.length, 0);
  });

  it("every other process the executor starts runs behind a recorded guard", async () => {
    const records: Array<{ pid: number; command: string }> = [];
    const executor = createGuardedExecutor({ record: (pid, command) => void records.push({ pid, command }) });
    const child = executor.spawn(process.execPath, ["-e", "console.log('spawned')"], { cwd: tmp() });
    let out = "";
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.once("close", (c) => resolve(c)));
    assert.equal(code, 0);
    assert.match(out, /spawned/);
    assert.equal(records.length, 1);
    assert.equal(records[0]!.pid, child.pid, "the record names the guard, whose tree holds the command");
  });
});

describe("T247: one shell for harness commands", () => {
  it("a shell line runs in the resolved bash, not cmd.exe", async () => {
    const resolved = resolveHostBash();
    assert.ok(resolved.ok, "this machine resolves a bash");
    assert.equal(bashCommandLine("true")?.command, resolved.resolved.shell);
    // `[[ ]]` and `$BASH_VERSION` exist in bash only: cmd.exe would fail the line.
    const run = await runVerificationCommand('[[ -n "$BASH_VERSION" ]] && echo in-bash', tmp(), 60_000, localExecutor);
    assert.equal(run.exitCode, 0, run.output);
    assert.match(run.output, /in-bash/);
  });

  it("the guarded executor runs a shell line in the same bash", async () => {
    const executor = createGuardedExecutor({ record: () => {} });
    const run = await runVerificationCommand('[[ -n "$BASH_VERSION" ]] && echo guarded-bash', tmp(), 60_000, executor);
    assert.equal(run.exitCode, 0, run.output);
    assert.match(run.output, /guarded-bash/);
  });

  it("`lykos doctor` names the resolved bash, and fails with the fix when none resolves", () => {
    const resolved = resolveHostBash();
    assert.ok(resolved.ok);
    const ok = checkHostBash(undefined);
    assert.equal(ok.status, "ok");
    assert.ok(ok.label.includes(resolved.resolved.shell), ok.label);
    const missing = checkHostBash(join(tmp(), "no-bash.exe"));
    assert.equal(missing.status, "fail");
    assert.match(missing.label, /delegation\.shell_path/);
  });
});

describe("T247: a delegated session", () => {
  const DELEGATED = { delegated: true, trustSource: "stored" } as const;
  const FILES = { "package.json": "{}\n" };

  it("records its bash command in process_records before it runs", async () => {
    const run = await runScriptedSession({
      files: FILES,
      config: "gate:\n  enabled: false\n",
      extra: DELEGATED,
      script: [reply(call("bash", { command: "echo guarded-run" })), reply(say("done"))],
    });
    assert.equal(run.result.status, "ok", JSON.stringify(run.result));
    const sessionId = (run.result as { sessionId: string }).sessionId;
    const ledger = openLedgerSync(run.ledgerPath);
    try {
      const rows = ledger.processRecords(sessionId);
      const row = rows.find((r) => r.command === "echo guarded-run");
      assert.ok(row, JSON.stringify(rows));
      assert.equal(row.kind, "guard");
    } finally {
      ledger.close();
    }
  });

  it("has no powershell tool unless delegation.powershell turns it on", async () => {
    const script = () => [reply(say("done"))];
    const delegated = await runScriptedSession({ files: FILES, extra: DELEGATED, script: script() });
    const names = (r: typeof delegated): string[] => (r.sent[0]!.tools ?? []).map((t) => t.name);
    assert.ok(!names(delegated).includes("powershell"), names(delegated).join(","));
    assert.ok(names(delegated).includes("bash"));
    const standalone = await runScriptedSession({ files: FILES, script: script() });
    const on = await runScriptedSession({ files: FILES, config: "delegation:\n  powershell: true\n", extra: DELEGATED, script: script() });
    // Where the standalone session has the tool, the config turns it back on for a delegated one.
    assert.equal(names(on).includes("powershell"), names(standalone).includes("powershell"));
  });
});
