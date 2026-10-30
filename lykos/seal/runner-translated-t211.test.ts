// T211 ACCEPTANCE: a contained sealed run reads the reporter's JSON as the container wrote it.
//
// The third live `npm run phase3:live` (2026-10-23) still failed the contained
// green run with `"adds" not collected (0 tests collected)`. Containment turns
// every `/work` path in a command's output into the host path, and on Windows
// that puts raw backslashes (`C:\Users\...`) inside the reporter's JSON
// strings, so every test event is invalid JSON and is dropped. The T210 stand-in
// escaped its paths, which the real translation never does.
//
// The fix: a caller that parses output, never shows it to the model, asks the
// executor for it untranslated (`containerPaths: true`). The runner already
// maps a `/work/...` reported path to its sealed file (T209).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { afterEach, describe, it } from "node:test";
import { startContainment } from "../containment/containment.js";
import { pathTranslator } from "../containment/paths.js";
import { standInRuntime } from "../cli/scripted-container.js";
import { localExecutor, type ExecChild, type ExecSpawnOptions, type ProjectExecutor } from "../tools/executor.js";
import { runSealedTests } from "./runner.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Everything a child writes to stdout, once it closes. */
function stdoutOf(child: ExecChild): Promise<string> {
  return new Promise((done, fail) => {
    let out = "";
    child.stdout?.on("data", (c: Buffer | string) => (out += c.toString()));
    child.once("error", fail);
    child.once("close", () => done(out));
  });
}

describe("T211 ACCEPTANCE: the container executor returns output untranslated when asked", () => {
  it("translates /work paths by default and leaves them when containerPaths is set", async () => {
    const dir = tempDir("lykos-t211-ws-");
    const runtime = standInRuntime({ respond: () => ({ stdout: '{"file":"/work/test/a.test.mjs"}\n' }) });
    const c = await startContainment({ config: { level: "required" }, workspace: dir, sessionId: "t211", drivers: [runtime.driver] });
    try {
      const translated = await stdoutOf(c.executor.spawn("node --test", [], { cwd: dir, shell: true }));
      assert.ok(!translated.includes("/work/"), `default output is translated: ${translated}`);

      const options: ExecSpawnOptions & { containerPaths: boolean } = { cwd: dir, shell: true, containerPaths: true };
      const raw = await stdoutOf(c.executor.spawn("node --test", [], options));
      assert.equal(raw, '{"file":"/work/test/a.test.mjs"}\n');
    } finally {
      await c.dispose();
    }
  });
});

/** A Windows workspace, whatever machine runs this: the translation decides by the workspace string. */
const WINDOWS_WORKSPACE = "C:\\Users\\me\\ws";
const CONTAINER_DIR = "/work/.lykos/worktrees/seal-worktree-abc";

/**
 * Runs the real command on this machine, then hands back its stdout as a Windows-hosted container would: node
 * reports `/work/...` paths, and the executor translates them to host paths unless the caller set `containerPaths`.
 */
function windowsHostedContainer(hostDir: string): ProjectExecutor {
  const paths = pathTranslator(WINDOWS_WORKSPACE);
  return {
    name: "windows-hosted-stand-in",
    shellOperations: (shell) => localExecutor.shellOperations(shell),
    spawn(command, args, options) {
      const child = localExecutor.spawn(command, args, options);
      const stdout = new PassThrough();
      const events = new EventEmitter();
      let out = "";
      child.stdout?.on("data", (c: Buffer | string) => (out += c.toString()));
      child.once("error", (err) => events.emit("error", err));
      child.once("close", (code, signal) => {
        const inContainer = out
          .split("\n")
          .map((line) => {
            let event: any;
            try {
              event = JSON.parse(line);
            } catch {
              return line;
            }
            for (const key of ["file", "entryFile"]) {
              const value = event?.data?.[key];
              if (typeof value === "string" && value.length > 0) {
                event.data[key] = `${CONTAINER_DIR}/${relative(hostDir, value).replace(/\\/g, "/")}`;
              }
            }
            return JSON.stringify(event);
          })
          .join("\n");
        const raw = (options as { containerPaths?: boolean }).containerPaths === true;
        stdout.end(raw ? inContainer : paths.toHost(inContainer));
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
      stdout.pause();
      return wrapped as unknown as ExecChild;
    },
  };
}

function project(expected: number): string {
  const dir = tempDir("lykos-t211-");
  mkdirSync(join(dir, "test"), { recursive: true });
  writeFileSync(
    join(dir, "test/add.test.mjs"),
    'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\n' +
      `describe("math", () => { it("adds", () => { assert.equal(2 + 2, ${expected}); }); });\n`,
  );
  return dir;
}

describe("T211 ACCEPTANCE: a sealed run under a Windows-hosted container collects its tests", () => {
  it("a green run collects the passing test", async () => {
    const dir = project(4);
    const res = await runSealedTests({
      executor: windowsHostedContainer(dir),
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
  });

  it("a red check records the failing assertion", async () => {
    const dir = project(5);
    const res = await runSealedTests({
      executor: windowsHostedContainer(dir),
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
  });
});
