// T210 ACCEPTANCE: the sealed green run works where the run's directory is read-only.
//
// The second live `npm run phase3:live` (2026-10-23) still failed every contained
// gate with `"adds" not collected`. The green run's worktree is under `.lykos/`,
// which a container mounts read-only, so the reporter file node is told to write
// there never reaches the host. The gate then said "not collected" and hid the
// runner's own error.
//
// This executor stands in for a container: it runs the command in a copy of the
// directory, so nothing the command writes reaches the host's directory, and it
// translates the copy's paths in stdout back to host paths, as containment's
// output translation does.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localExecutor, type ExecChild, type ProjectExecutor } from "../tools/executor.js";
import { runSealedTests } from "./runner.js";

function readOnlyContainer(hostDir: string): ProjectExecutor {
  return {
    name: "readonly-stand-in",
    shellOperations: (shell) => localExecutor.shellOperations(shell),
    spawn(command, args, options) {
      const inside = mkdtempSync(join(tmpdir(), "lykos-t210-container-"));
      cpSync(hostDir, inside, { recursive: true });
      const child = localExecutor.spawn(command, args, { ...options, cwd: inside });
      const stdout = new PassThrough();
      const events = new EventEmitter();
      let out = "";
      child.stdout?.on("data", (c: Buffer | string) => {
        out += c.toString();
      });
      child.once("error", (err) => events.emit("error", err));
      child.once("close", (code, signal) => {
        const variants = [inside, inside.replace(/\\/g, "/"), inside.replace(/\\/g, "\\\\")];
        const hosts = [hostDir, hostDir.replace(/\\/g, "/"), hostDir.replace(/\\/g, "\\\\")];
        variants.forEach((v, i) => {
          out = out.split(v).join(hosts[i]!);
        });
        stdout.end(out);
        rmSync(inside, { recursive: true, force: true });
        stdout.once("end", () => events.emit("close", code, signal));
        stdout.resume();
      });
      const wrapped = {
        pid: child.pid,
        stdout,
        stderr: child.stderr,
        stdin: child.stdin,
        kill: (s?: NodeJS.Signals | number) => child.kill(s),
        on(event: string, listener: (...a: any[]) => void) {
          events.on(event, listener);
          return wrapped;
        },
        once(event: string, listener: (...a: any[]) => void) {
          events.once(event, listener);
          return wrapped;
        },
      };
      // The data listener the runner attaches must see the text, so pause until it does.
      stdout.pause();
      return wrapped as unknown as ExecChild;
    },
  };
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "lykos-t210-"));
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(
    join(dir, "test/add.test.mjs"),
    'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\n' +
      'describe("math", () => { it("adds", () => { assert.equal(2 + 2, 4); }); });\n',
  );
  return dir;
}

describe("T210 ACCEPTANCE: a green run in a read-only container", () => {
  it("collects node:test results without writing a file the host must read", async () => {
    const dir = project();
    try {
      const res = await runSealedTests({
        executor: readOnlyContainer(dir),
        dir,
        files: ["test/add.test.mjs"],
        template: "node --test {files}",
        mode: "green",
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });
      assert.deepEqual(res.errors, [], res.rawOutput);
      assert.deepEqual(
        res.tests.map((t) => ({ file: t.file, describe: t.describe, name: t.name, status: t.status })),
        [{ file: "test/add.test.mjs", describe: ["math"], name: "adds", status: "pass" }],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a red check in the same container records the failing test", async () => {
    const dir = project();
    writeFileSync(
      join(dir, "test/add.test.mjs"),
      'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\n' +
        'describe("math", () => { it("adds", () => { assert.equal(2 + 2, 5); }); });\n',
    );
    try {
      const res = await runSealedTests({
        executor: readOnlyContainer(dir),
        dir,
        files: ["test/add.test.mjs"],
        template: "node --test {files}",
        mode: "red",
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });
      assert.deepEqual(res.errors, [], res.rawOutput);
      assert.deepEqual(
        res.tests.map((t) => ({ name: t.name, status: t.status })),
        [{ name: "adds", status: "assertion" }],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
