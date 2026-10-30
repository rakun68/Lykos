// A process for the live suite to kill: it starts a real container the way a
// session does, writes a marker file, and then waits to be killed without disposing of it.
//
// Not a test file. `live.test.ts` runs it, waits for the marker file it writes, and
// SIGKILLs it, which is how a Lykos process that died leaves a container behind.
//
//   node --import tsx live-orphan-child.ts <runtime> <workspace> <sessionId> <markerFile>

import { writeFileSync } from "node:fs";
import { startContainment } from "./containment.js";
import { cliRuntime, type RuntimeName } from "./runtime.js";

const [runtime, workspace, sessionId, marker] = process.argv.slice(2);
if (runtime === undefined || workspace === undefined || sessionId === undefined || marker === undefined) {
  process.stderr.write("usage: live-orphan-child <runtime> <workspace> <sessionId> <markerFile>\n");
  process.exit(2);
}

await startContainment({
  config: { level: "required", runtime: runtime as RuntimeName },
  workspace,
  sessionId,
  drivers: [cliRuntime(runtime as RuntimeName)],
});
writeFileSync(marker, "started");
setInterval(() => {}, 1 << 30);
