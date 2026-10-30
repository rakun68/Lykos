// A real session's `bash` tool, driven by a scripted model, runs its command in
// a real container.
//
// Its own file because the scripted session points HOME at a throwaway
// directory for the rest of the process, and `live.test.ts` drives the runtimes
// with the real one. Skipped per runtime with the reason, like that suite.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { call, reply, runScriptedSession, say } from "../cli/scripted-session.js";
import { cliRuntime, type RuntimeName } from "./runtime.js";

const NAMES: RuntimeName[] = ["podman", "docker"];

for (const name of NAMES) {
  const driver = cliRuntime(name);
  const probed = await driver.probe();
  const skip = probed.available ? false : `${name} is not available on this machine: ${probed.reason}`;

  describe(`a scripted session's bash on ${name}`, { skip, timeout: 10 * 60_000 }, () => {
    it("runs in the container: the command sees /work, the kernel is Linux, and the host canary is absent", async () => {
      // A command that writes a file at a host path outside the workspace. On this machine it succeeds;
      // in the container that path means nothing, so the file can only appear if the command ran here.
      const canaryPath = join(tmpdir(), `lykos-live-canary-${process.pid}`).replaceAll("\\", "/");
      const writeCanary = `node -e "require('fs').writeFileSync(process.argv[1],'x')" ${canaryPath}`;
      execFileSync(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1],'x')", canaryPath]);
      assert.equal(existsSync(canaryPath), true, "positive control: the canary works on this machine");
      rmSync(canaryPath);

      let workspace = "";
      const inWorkspace = (rel: string): string => join(workspace, rel).replaceAll("\\", "/");
      const s = await runScriptedSession({
        files: { "marker.txt": "present\n" },
        config: `feedback:\n  enabled: false\ngate:\n  enabled: false\ncontainment:\n  level: required\n  runtime: ${name}\n`,
        setup: (w) => (workspace = w),
        extra: { containmentDrivers: [driver] },
        script: [
          // T174: the command names its files by host path, which only the translation to /work lets the container
          // find, and `pwd` is /work inside, which the model is shown as the host path. `uname` says Linux, which
          // this machine may not be.
          () =>
            reply(
              call("bash", { command: `pwd && uname -s && cat ${inWorkspace("marker.txt")} && echo made > ${inWorkspace("made-in-container.txt")}` }),
              call("bash", { command: writeCanary }),
            ),
          reply(say("done")),
        ],
      });
      assert.equal(s.result.status, "ok", JSON.stringify(s.result));
      const results = s.sent.at(-1)?.messages.filter((m) => m.role === "toolResult") ?? [];
      const first = (results[0]?.content as Array<{ text: string }>)[0]?.text;
      assert.equal(first, [workspace, "Linux", "present", ""].join("\n"));
      assert.equal(existsSync(canaryPath), false, "the canary ran on this machine");
      // Positive control: the container really shares the workspace.
      assert.equal(s.file("made-in-container.txt"), "made\n");
      assert.equal(s.session().containment_used, "required");
      assert.equal(s.session().container_runtime, name);
      // And it is gone at the end.
      const left = (await driver.listContainers("lykos.owner")).filter((c) => c.labels["lykos.owner"] === String(process.pid));
      assert.deepEqual(left, []);
    });
  });
}
