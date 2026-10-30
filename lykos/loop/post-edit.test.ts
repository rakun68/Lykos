import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { killProcessTree } from "../tools/job-runner.js";
import { osProcessAlive, waitForOsProcess } from "../tools/process-probe.js";
import {
  discoverPostEditCommand,
  isMutatingTool,
  newPostEditState,
  resolvePostEditPolicy,
  runPostEditCheck,
  spawnCommandRunner,
  type CommandRunner,
  type PostEditPolicy,
} from "./post-edit.js";

function tempProject(pkg: unknown, extra: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-postedit-"));
  if (pkg !== undefined) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg), "utf8");
  for (const [name, content] of Object.entries(extra)) writeFileSync(join(dir, name), content, "utf8");
  return dir;
}

const policy = (over: Partial<PostEditPolicy> = {}): PostEditPolicy => ({
  enabled: true,
  command: "check",
  timeoutMs: 5000,
  maxOutputBytes: 4000,
  slowDisableMs: 45_000,
  cwd: "/repo",
  ...over,
});

const runner = (runs: Array<{ exitCode: number | null; output?: string; ms?: number; problem?: string }>): CommandRunner => {
  let i = 0;
  return async () => {
    const next = runs[Math.min(i, runs.length - 1)]!;
    i += 1;
    return {
      exitCode: next.exitCode,
      output: next.output ?? "",
      ms: next.ms ?? 10,
      ...(next.problem !== undefined ? { problem: next.problem } : {}),
    };
  };
};

describe("discoverPostEditCommand", () => {
  it("prefers a project's own typecheck script", () => {
    const dir = tempProject({ scripts: { typecheck: "tsc --noEmit", test: "node --test" } });
    try {
      assert.equal(discoverPostEditCommand(dir), "npm run typecheck --silent");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to tsc for a TypeScript project that never wrote the script down", () => {
    const dir = tempProject({ devDependencies: { typescript: "^5.7.3" } }, { "tsconfig.json": "{}" });
    try {
      assert.equal(discoverPostEditCommand(dir), "npx tsc --noEmit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not guess a test or build script — those are T100's question, not this one", () => {
    const dir = tempProject({ scripts: { test: "node --test", build: "tsc", lint: "eslint ." } });
    try {
      assert.equal(discoverPostEditCommand(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns undefined rather than throwing when there is no package.json", () => {
    const dir = tempProject(undefined);
    try {
      assert.equal(discoverPostEditCommand(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not claim tsc without a tsconfig", () => {
    const dir = tempProject({ devDependencies: { typescript: "^5" } });
    try {
      assert.equal(discoverPostEditCommand(dir), undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolvePostEditPolicy", () => {
  it("lets a configured command win over discovery", () => {
    const dir = tempProject({ scripts: { typecheck: "tsc --noEmit" } });
    try {
      const p = resolvePostEditPolicy(dir, { command: "make check" });
      assert.equal(p.command, "make check");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is on by default and off when the project says so", () => {
    const dir = tempProject({});
    try {
      assert.equal(resolvePostEditPolicy(dir).enabled, true);
      assert.equal(resolvePostEditPolicy(dir, { enabled: false }).enabled, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a blank configured command as no command rather than as an empty shell call", () => {
    const dir = tempProject({});
    try {
      assert.equal(resolvePostEditPolicy(dir, { command: "   " }).command, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isMutatingTool", () => {
  it("fires for the tools whose success means a file changed", () => {
    assert.equal(isMutatingTool("edit"), true);
    assert.equal(isMutatingTool("write"), true);
    assert.equal(isMutatingTool("read"), false);
    assert.equal(isMutatingTool("bash"), false);
    assert.equal(isMutatingTool(undefined), false);
    assert.equal(isMutatingTool("tool_call", { name: "edit", arguments: { path: "a.ts" } }), true);
    assert.equal(isMutatingTool("tool_call", { name: "write", arguments: { path: "a.ts" } }), true);
    assert.equal(isMutatingTool("tool_call", { name: "read", arguments: { path: "a.ts" } }), false);
    assert.equal(isMutatingTool("tool_call", { name: "bash", arguments: { command: "ls" } }), false);
  });
});

describe("runPostEditCheck", () => {
  it("says nothing at all when disabled or when nothing was discovered", async () => {
    const off = newPostEditState();
    assert.equal(await runPostEditCheck(policy({ enabled: false }), off, runner([{ exitCode: 1 }])), undefined);
    assert.equal(off.runs, 0, "a disabled loop must not spend a subprocess");
    const nothing = newPostEditState();
    assert.equal(await runPostEditCheck(policy({ command: undefined }), nothing, runner([{ exitCode: 1 }])), undefined);
    assert.equal(nothing.runs, 0);
  });

  it("announces itself once on the first clean run, then goes quiet", async () => {
    const state = newPostEditState();
    const run = runner([{ exitCode: 0 }]);
    const first = await runPostEditCheck(policy(), state, run);
    assert.match(String(first), /runs after every edit and currently passes/);
    assert.equal(await runPostEditCheck(policy(), state, run), undefined);
    assert.equal(await runPostEditCheck(policy(), state, run), undefined);
    assert.equal(state.passes, 3);
  });

  it("reports a failure with the command, the exit code and the output", async () => {
    const state = newPostEditState();
    const note = await runPostEditCheck(
      policy(),
      state,
      runner([{ exitCode: 2, output: "src/a.ts(3,1): error TS2304: Cannot find name 'foo'." }]),
    );
    assert.match(String(note), /did not survive the post-edit check/);
    assert.match(String(note), /`check` exited 2/);
    assert.match(String(note), /TS2304/);
    assert.equal(state.failures, 1);
    assert.equal(state.lastFailed, true);
  });

  it("repeats the failure every time, because the model needs the current error text", async () => {
    const state = newPostEditState();
    const run = runner([{ exitCode: 2, output: "still broken" }]);
    assert.match(String(await runPostEditCheck(policy(), state, run)), /still broken/);
    assert.match(String(await runPostEditCheck(policy(), state, run)), /still broken/);
    assert.equal(state.failures, 2);
  });

  it("says once when a failure clears, then goes quiet again", async () => {
    const state = newPostEditState();
    await runPostEditCheck(policy(), state, runner([{ exitCode: 1, output: "boom" }]));
    const clean = runner([{ exitCode: 0 }]);
    assert.match(String(await runPostEditCheck(policy(), state, clean)), /passes again/);
    assert.equal(await runPostEditCheck(policy(), state, clean), undefined);
  });

  it("clamps a huge output rather than putting a compiler's whole tantrum in the context", async () => {
    const state = newPostEditState();
    const note = await runPostEditCheck(
      policy({ maxOutputBytes: 300 }),
      state,
      runner([{ exitCode: 1, output: `HEAD${"x".repeat(50_000)}TAIL` }]),
    );
    assert.ok(String(note).length < 1200, `note was ${String(note).length} bytes`);
    assert.match(String(note), /HEAD/);
    assert.match(String(note), /TAIL/, "the tail is where the failing assertion lives");
  });

  it("turns itself off, and says so, when the command cannot be started", async () => {
    const state = newPostEditState();
    const note = await runPostEditCheck(
      policy(),
      state,
      runner([{ exitCode: null, problem: "spawn ENOENT" }]),
    );
    assert.match(String(note), /off for the rest of this session/);
    assert.equal(state.disabled, true);
    assert.equal(state.disabledReason, "spawn ENOENT");
    // And it never spends another subprocess.
    assert.equal(await runPostEditCheck(policy(), state, runner([{ exitCode: 1 }])), undefined);
    assert.equal(state.runs, 1);
  });

  it("records a failed start as neither a pass nor a failure of the code", async () => {
    const state = newPostEditState();
    await runPostEditCheck(policy(), state, runner([{ exitCode: null, problem: "timed out after 5s" }]));
    assert.equal(state.failures, 0, "a command that never ran says nothing about the edit");
    assert.equal(state.passes, 0);
    assert.equal(state.runs, 1, "but the attempt is still counted");
  });

  it("turns itself off when a single run is slower than the budget, keeping the verdict", async () => {
    const state = newPostEditState();
    const note = await runPostEditCheck(
      policy({ slowDisableMs: 1000 }),
      state,
      runner([{ exitCode: 1, output: "slow and broken", ms: 9000 }]),
    );
    assert.match(String(note), /took 9\.0s/);
    assert.match(String(note), /slow and broken/, "the verdict it did produce is not thrown away");
    assert.equal(state.disabled, true);
    assert.equal(state.failures, 1);
  });

  it("accumulates wall time so the loop's own cost is visible", async () => {
    const state = newPostEditState();
    const run = runner([{ exitCode: 0, ms: 250 }]);
    await runPostEditCheck(policy(), state, run);
    await runPostEditCheck(policy(), state, run);
    assert.equal(state.totalMs, 500);
  });
});

describe("spawnCommandRunner", () => {
  it("runs a real command and reports its exit code and output", async () => {
    const result = await spawnCommandRunner("node -e \"console.log('hi'); process.exit(3)\"", process.cwd(), 20_000);
    assert.equal(result.exitCode, 3);
    assert.match(result.output, /hi/);
    assert.equal(result.problem, undefined);
    assert.ok(result.ms >= 0);
  });

  it("kills a command that overruns the timeout and says so", async () => {
    const result = await spawnCommandRunner("node -e \"setTimeout(()=>{},10000)\"", process.cwd(), 400);
    assert.match(String(result.problem), /timed out after/);
    assert.equal(result.exitCode, null);
  });

  // P10.5 (ticket 16, D9) — defect D11, the post-edit half.
  //
  // The runner spawns through a shell. Before this, the timeout called
  // `child.kill()`, which on Windows terminates the command interpreter and
  // leaves the type-checker beneath it alive — several timeouts in one long
  // session meant several compilers running concurrently, none of them
  // attached to anything that would ever read their output. The assertion is
  // the operating system's answer about the process two levels down, because
  // a kill's return code is a self-report (AGENTS.md rule 4).
  it("D11: a grandchild of a timed-out command is gone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-postedit-tree-"));
    const grandPidFile = join(dir, "grand.pid");
    writeFileSync(
      join(dir, "grandchild.js"),
      `require('fs').writeFileSync(${JSON.stringify(grandPidFile)}, String(process.pid));\nsetInterval(() => {}, 1000);`,
      "utf8",
    );
    writeFileSync(
      join(dir, "child.js"),
      `require('child_process').spawn(process.execPath, [${JSON.stringify(join(dir, "grandchild.js"))}], { stdio: 'ignore' });\nsetInterval(() => {}, 1000);`,
      "utf8",
    );
    const readPid = (): number | undefined => {
      try {
        const n = Number(readFileSync(grandPidFile, "utf8").trim());
        return Number.isInteger(n) && n > 0 ? n : undefined;
      } catch {
        return undefined;
      }
    };

    const pending = spawnCommandRunner(`node ${JSON.stringify(join(dir, "child.js"))}`, dir, 3000);
    let grandPid: number | undefined;
    const deadline = Date.now() + 20_000;
    while (grandPid === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      grandPid = readPid();
    }
    assert.ok(grandPid !== undefined, "the grandchild started");
    // The positive control. Without it the assertion below could pass on a
    // probe that answered "gone" to everything.
    assert.equal(await osProcessAlive(grandPid), true, "grandchild is alive before the timeout");

    try {
      const result = await pending;
      assert.match(String(result.problem), /timed out after/);
      assert.equal(
        await waitForOsProcess(grandPid, false),
        false,
        "the post-edit check timed out and left its grandchild running",
      );
    } finally {
      await killProcessTree(grandPid);
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
