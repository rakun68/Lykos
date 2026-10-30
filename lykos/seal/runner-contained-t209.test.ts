// T209 ACCEPTANCE: the sealed green run collects tests run inside a container.
//
// The P3 standalone demonstration (T207) found the gate's green run reporting
// `"adds" not collected` in a contained session whose `npm test` passed. Node
// writes the reporter file inside the container, so every `file` in it is a
// container path (`/work/...`), and the host never translates a file it reads
// from disk. This executor runs the real command on this machine and then
// rewrites the reporter file as a container would have written it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { localExecutor, type ProjectExecutor } from "../tools/executor.js";
import { runSealedTests } from "./runner.js";

const CONTAINER_DIR = "/work/.lykos/worktrees/seal-worktree-abc";

function containedExecutor(hostDir: string): ProjectExecutor {
  return {
    name: "contained-stand-in",
    shellOperations: (shell) => localExecutor.shellOperations(shell),
    spawn(command, args, options) {
      const dest = /--test-reporter-destination="\.\/([^"]+)"/.exec(command)?.[1];
      const child = localExecutor.spawn(command, args, options);
      // Registered before the runner's own listener, so the file is rewritten before it is read.
      child.once("close", () => {
        if (!dest) return;
        const path = join(hostDir, dest);
        const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
        const rewritten = lines.map((line) => {
          const event = JSON.parse(line);
          for (const key of ["file", "entryFile"]) {
            const value = event.data?.[key];
            if (typeof value === "string" && value.length > 0) {
              event.data[key] = `${CONTAINER_DIR}/${relative(hostDir, value).replace(/\\/g, "/")}`;
            }
          }
          return JSON.stringify(event);
        });
        writeFileSync(path, rewritten.join("\n") + "\n");
      });
      return child;
    },
  };
}

describe("T209 ACCEPTANCE: a contained green run collects its sealed tests", () => {
  it("node:test results reported under container paths are matched to the sealed files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-t209-"));
    try {
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(
        join(dir, "test/add.test.mjs"),
        'import { describe, it } from "node:test";\nimport assert from "node:assert/strict";\n' +
          'describe("math", () => { it("adds", () => { assert.equal(2 + 2, 4); }); });\n',
      );
      const res = await runSealedTests({
        executor: containedExecutor(dir),
        dir,
        files: ["test/add.test.mjs"],
        template: "node --test {files}",
        mode: "green",
        env: { ...process.env, NODE_TEST_CONTEXT: undefined },
      });
      assert.deepEqual(res.errors, [], res.rawOutput);
      assert.equal(res.ok, true);
      assert.deepEqual(
        res.tests.map((t) => ({ file: t.file, describe: t.describe, name: t.name, status: t.status })),
        [{ file: "test/add.test.mjs", describe: ["math"], name: "adds", status: "pass" }],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
