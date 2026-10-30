// Child process for commit-killed.test.ts: a scripted session that commits and
// is then SIGKILLed by its own model step, so it never reaches its end.
// Prints `WS=<workspace>` to stdout, synchronously, before anything can kill it.

import { writeSync } from "node:fs";
import { call, reply, runScriptedSession } from "./scripted-session.js";

await runScriptedSession({
  files: { "a.txt": "one\n" },
  config: "feedback:\n  enabled: false\ngate:\n  enabled: false\n",
  setup: (ws) => {
    writeSync(1, `WS=${ws}\n`);
  },
  script: [
    reply(call("write", { path: "a.txt", content: "two\n" })),
    reply(call("commit", { message: "Made before the kill" })),
    () => {
      process.kill(process.pid, "SIGKILL");
      return reply();
    },
  ],
});
