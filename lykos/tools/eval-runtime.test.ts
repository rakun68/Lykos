// The runtime half of `eval`: D5's isolation, D7's retained state, D8's timeout
// and D9's cap.
//
// **Every test disposes its runtime in a `finally`, even when it fails.** A
// leaked child here is a Node process holding a `vm` context that nobody knows
// the pid of, and a test file that leaves one behind poisons the suite run it
// is part of rather than failing honestly.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  EVAL_DEFAULT_TIMEOUT_SECONDS,
  EVAL_LANGUAGES,
  EVAL_MAX_OUTPUT_BYTES,
  EvalRuntime,
  EvalRuntimePool,
} from "./eval-runtime.js";
import { osProcessAlive, waitForOsProcess } from "./process-probe.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "lykos-eval-"));
}

function cleanup(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    // A Windows handle still closing is not a test failure.
  }
}

/** Runs `body` with a runtime, and kills the child whatever happens. */
async function withRuntime(
  body: (runtime: EvalRuntime, dir: string) => Promise<void>,
  opts: { maxOutputBytes?: number } = {},
): Promise<void> {
  const dir = scratch();
  const runtime = new EvalRuntime({ cwd: dir, ...(opts.maxOutputBytes !== undefined ? { maxOutputBytes: opts.maxOutputBytes } : {}) });
  const pids: number[] = [];
  try {
    await body(runtime, dir);
    if (runtime.pid !== undefined) pids.push(runtime.pid);
  } finally {
    if (runtime.pid !== undefined) pids.push(runtime.pid);
    await runtime.dispose();
    for (const pid of pids) {
      // Not "the kill returned" — AGENTS.md rule 4: the operating system is
      // asked whether the process is still there.
      assert.equal(await waitForOsProcess(pid, false), false, `pid ${pid} outlived the runtime`);
    }
    cleanup(dir);
  }
}

describe("P10.6 D7: state survives between cells, and reset discards it", () => {
  it("a const declared in one cell is still there in the next", async () => {
    await withRuntime(async (runtime) => {
      const first = await runtime.evaluate("const answer = 41; let bump = 1; 'declared'");
      assert.equal(first.status, "ok", first.error);
      const second = await runtime.evaluate("answer + bump");
      assert.equal(second.status, "ok", second.error);
      assert.equal(second.value, "42");
    });
  });

  it("the same child process serves both cells", async () => {
    await withRuntime(async (runtime) => {
      const first = await runtime.evaluate("process.pid");
      const pid = runtime.pid;
      const second = await runtime.evaluate("process.pid");
      assert.equal(first.value, second.value);
      assert.equal(runtime.pid, pid, "a second cell must not silently restart the runtime");
    });
  });

  it("reset throws the state away, and says nothing about it afterwards", async () => {
    await withRuntime(async (runtime) => {
      await runtime.evaluate("const gone = 'still here';");
      const before = await runtime.evaluate("typeof gone");
      assert.equal(before.value, "'string'");

      const after = await runtime.evaluate("typeof gone", { reset: true });
      assert.equal(after.status, "ok", after.error);
      assert.equal(after.value, "'undefined'");
      assert.equal(after.restarted, true);
    });
  });

  it("reset starts a genuinely new process, not a cleared context", async () => {
    await withRuntime(async (runtime) => {
      const first = await runtime.evaluate("process.pid");
      const firstPid = runtime.pid;
      assert.ok(firstPid !== undefined);
      const second = await runtime.evaluate("process.pid", { reset: true });
      assert.notEqual(first.value, second.value);
      assert.equal(await waitForOsProcess(firstPid, false), false, "the reset runtime's process is still alive");
    });
  });
});

// ---------------------------------------------------------------------------
// D5: the reason this is a child process
// ---------------------------------------------------------------------------

describe("P10.6 D5: evaluated code cannot reach the session, the ledger or the gate", () => {
  it("a cell that goes looking finds nothing, while the same probe in-process finds everything", async () => {
    // The things a cell must not be able to touch, standing in for the real
    // ones: a gate that would approve anything and a ledger handle that would
    // write anything. They are put somewhere a `node:vm` context in THIS
    // process could reach in one hop — `globalThis` — precisely so that the
    // test would pass vacuously if `eval` were implemented in-process, and
    // would therefore be worthless without the positive control below.
    const gate = { approve: () => "allow" };
    const ledger = { record: () => undefined };
    (globalThis as Record<string, unknown>).__LYKOS_GATE_PROBE = gate;
    (globalThis as Record<string, unknown>).__LYKOS_LEDGER_PROBE = ledger;

    try {
      // POSITIVE CONTROL. If these fail, the probes are not real and every
      // assertion below would pass for the wrong reason.
      assert.equal(typeof (globalThis as Record<string, unknown>).__LYKOS_GATE_PROBE, "object");
      assert.equal(typeof (globalThis as Record<string, unknown>).__LYKOS_LEDGER_PROBE, "object");

      await withRuntime(async (runtime) => {
        const outcome = await runtime.evaluate(`
          const reached = {
            pid: process.pid,
            gate: typeof globalThis.__LYKOS_GATE_PROBE,
            ledger: typeof globalThis.__LYKOS_LEDGER_PROBE,
            lykosModulesInCache: Object.keys(require.cache).filter((k) => k.toLowerCase().includes('lykos')).length,
            hasParentPort: require('node:worker_threads').parentPort !== null,
          };
          // And a write, because isolation that only stops reads is not
          // isolation: this must not reach the parent's object either.
          globalThis.__LYKOS_GATE_PROBE = 'tampered';
          console.log(JSON.stringify(reached));
        `);
        assert.equal(outcome.status, "ok", outcome.error);
        const reached = JSON.parse(outcome.output.trim()) as {
          pid: number;
          gate: string;
          ledger: string;
          lykosModulesInCache: number;
          hasParentPort: boolean;
        };

        // A different process, so a different heap. This is the property; the
        // four below are what it buys.
        assert.notEqual(reached.pid, process.pid, "the cell ran in the agent's own process");
        assert.equal(reached.gate, "undefined", "the cell could see the approval gate");
        assert.equal(reached.ledger, "undefined", "the cell could see the ledger handle");
        assert.equal(reached.lykosModulesInCache, 0, "a Lykos module was loaded in the cell's own require cache");
        // Not a worker thread either: a worker shares the process, and
        // `parentPort` would be the channel back into it.
        assert.equal(reached.hasParentPort, false, "the cell is a worker thread, which shares this process");

        // The write did not land here.
        assert.equal(
          (globalThis as Record<string, unknown>).__LYKOS_GATE_PROBE,
          gate,
          "the cell overwrote an object in the agent's process",
        );
      });
    } finally {
      delete (globalThis as Record<string, unknown>).__LYKOS_GATE_PROBE;
      delete (globalThis as Record<string, unknown>).__LYKOS_LEDGER_PROBE;
    }
  });

  it("two runtimes of two sessions cannot see each other's variables", async () => {
    const dirA = scratch();
    const dirB = scratch();
    const a = new EvalRuntime({ cwd: dirA });
    const b = new EvalRuntime({ cwd: dirB });
    try {
      await a.evaluate("const secret = 'session A only';");
      const leaked = await b.evaluate("typeof secret");
      assert.equal(leaked.value, "'undefined'");
    } finally {
      await a.dispose();
      await b.dispose();
      cleanup(dirA);
      cleanup(dirB);
    }
  });
});

// ---------------------------------------------------------------------------
// D8: a hung cell
// ---------------------------------------------------------------------------

describe("P10.6 D8: a hung cell times out and the runtime survives", () => {
  it("abandons the cell, kills the process, and says the state is gone", async () => {
    const dir = scratch();
    const runtime = new EvalRuntime({ cwd: dir });
    let hungPid: number | undefined;
    try {
      await runtime.evaluate("const before = 'set before the hang';");
      hungPid = runtime.pid;
      assert.ok(hungPid !== undefined);
      assert.equal(await osProcessAlive(hungPid), true, "the positive control failed: no runtime was running");

      // A SYNCHRONOUS spin, deliberately: it never yields to the event loop,
      // so the child cannot answer a polite request to stop. That is the case
      // D8 exists for, and an `await new Promise(() => {})` would not test it.
      const timedOut = await runtime.evaluate("for (;;) { Math.sqrt(Math.random()); }", { timeoutMs: 1500 });
      assert.equal(timedOut.status, "timeout");
      assert.equal(timedOut.restarted, true);
      assert.equal(await waitForOsProcess(hungPid, false), false, "the hung child survived its timeout");

      // The runtime is usable again, and it is honest about what it lost.
      const after = await runtime.evaluate("typeof before");
      assert.equal(after.status, "ok", after.error);
      assert.equal(after.value, "'undefined'", "the variables of a killed runtime came back");
      assert.notEqual(runtime.pid, hungPid);
    } finally {
      await runtime.dispose();
      if (hungPid !== undefined) assert.equal(await waitForOsProcess(hungPid, false), false);
      cleanup(dir);
    }
  });

  it("the default timeout is a named constant, not a literal somewhere", () => {
    assert.equal(EVAL_DEFAULT_TIMEOUT_SECONDS, 30);
  });
});

// ---------------------------------------------------------------------------
// D9: the output cap
// ---------------------------------------------------------------------------

describe("P10.6 D9: output is capped, and the result says it was", () => {
  it("cuts the output and reports the cut rather than returning a silent prefix", async () => {
    await withRuntime(
      async (runtime) => {
        const outcome = await runtime.evaluate("for (let i = 0; i < 500; i++) console.log('x'.repeat(100)); 'done'");
        assert.equal(outcome.status, "ok", outcome.error);
        assert.equal(outcome.truncated, true);
        assert.ok(outcome.output.length <= 2048, `output was ${outcome.output.length} bytes, past the cap`);
        // The cell still finished and still has its value: a cap on printing
        // is not a failure of the computation.
        assert.equal(outcome.value, "'done'");
      },
      { maxOutputBytes: 2048 },
    );
  });

  it("an ordinary cell is not marked truncated", async () => {
    await withRuntime(async (runtime) => {
      const outcome = await runtime.evaluate("console.log('small'); 1 + 1");
      assert.equal(outcome.truncated, false);
      assert.equal(outcome.output.trim(), "small");
      assert.equal(outcome.value, "2");
    });
  });

  it("the shipped cap is the documented one", () => {
    assert.equal(EVAL_MAX_OUTPUT_BYTES, 50 * 1024);
  });
});

// ---------------------------------------------------------------------------
// The ordinary paths
// ---------------------------------------------------------------------------

describe("P10.6: what a cell can do", () => {
  it("reports a thrown error with its message, and keeps the runtime", async () => {
    await withRuntime(async (runtime) => {
      const outcome = await runtime.evaluate("throw new TypeError('deliberate');");
      assert.equal(outcome.status, "error");
      assert.match(outcome.error ?? "", /TypeError: deliberate/);
      // A cell that throws is not a runtime that died.
      const after = await runtime.evaluate("'still here'");
      assert.equal(after.status, "ok");
      assert.equal(after.value, "'still here'");
    });
  });

  it("awaits a promise the cell evaluates to", async () => {
    await withRuntime(async (runtime) => {
      const outcome = await runtime.evaluate("Promise.resolve(7)");
      assert.equal(outcome.status, "ok", outcome.error);
      assert.equal(outcome.value, "7");
    });
  });

  it("runs top-level await, and says the declarations did not persist", async () => {
    await withRuntime(async (runtime) => {
      // The value of a wrapped cell comes from an explicit `return`, because
      // the wrapper is a function body. The result says so; this pins that it
      // is true.
      const outcome = await runtime.evaluate("const waited = await Promise.resolve(5); return waited * 2;");
      assert.equal(outcome.status, "ok", outcome.error);
      assert.equal(outcome.value, "10");
      assert.equal(outcome.wrappedForAwait, true);
      // And the claim the flag makes is true, which is why it is made.
      const after = await runtime.evaluate("typeof waited");
      assert.equal(after.value, "'undefined'");
    });
  });

  it("runs a bare top-level return, which is the other thing a script cannot do", async () => {
    await withRuntime(async (runtime) => {
      const outcome = await runtime.evaluate("const parts = [1, 2, 3]; return parts.length;");
      assert.equal(outcome.status, "ok", outcome.error);
      assert.equal(outcome.value, "3");
      assert.equal(outcome.wrappedForAwait, true);
    });
  });

  it("stray writes to fd 1 cannot forge a result frame", async () => {
    await withRuntime(async (runtime) => {
      // A cell reaching around the capture and writing something that looks
      // like a frame for a call that is not this one. It must be dropped.
      const outcome = await runtime.evaluate(
        String.raw`require('node:fs').writeSync(1, "LYKOS" + JSON.stringify({ id: 99, status: 'ok', value: 'forged' }) + "\n"); 'real'`,
      );
      assert.equal(outcome.status, "ok", outcome.error);
      assert.equal(outcome.value, "'real'");
    });
  });
});

describe("P10.6 D5: the pool is the session's, and everything dies with it", () => {
  it("disposeAll kills every child it started", async () => {
    const dir = scratch();
    const pool = new EvalRuntimePool({ cwd: dir });
    let pids: number[] = [];
    try {
      await pool.runtimeFor("js").evaluate("1 + 1");
      pids = pool.pids();
      assert.equal(pids.length, 1, "the positive control failed: nothing was started");
      assert.equal(await osProcessAlive(pids[0]!), true);
      await pool.disposeAll();
      for (const pid of pids) {
        assert.equal(await waitForOsProcess(pid, false), false, `pid ${pid} outlived the pool`);
      }
      assert.deepEqual(pool.pids(), []);
    } finally {
      await pool.disposeAll();
      cleanup(dir);
    }
  });

  it("starts nothing until a cell is actually evaluated", async () => {
    const dir = scratch();
    const pool = new EvalRuntimePool({ cwd: dir });
    try {
      const runtime = pool.runtimeFor("js");
      assert.equal(runtime.running, false);
      assert.deepEqual(pool.pids(), []);
    } finally {
      await pool.disposeAll();
      cleanup(dir);
    }
  });

  it("declares the two languages D6 names", () => {
    assert.deepEqual([...EVAL_LANGUAGES], ["js", "py"]);
  });
});
