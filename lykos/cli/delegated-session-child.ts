// Child process for delegated-session-credential.test.ts: one real `lykos run` (the
// default, delegated shape) against the fake model server, in a process of its
// own so the parent can give it a throwaway home and credential db.
//
// argv: <workspace> <provider/model> <outFile>

import { writeFileSync } from "node:fs";
import { runRun } from "./run.js";

const [workspace, model, outFile] = process.argv.slice(2);
if (!workspace || !model || !outFile) {
  process.stderr.write("delegated-session-child: expected <workspace> <provider/model> <outFile>\n");
  process.exit(2);
}

// Containment off: this proves the credential, not the container, and must not need a runtime on the machine running the test.
// In place: the workspace is a plain folder, and a writing delegated session refuses one without a repository (T184).
const code = await runRun(workspace, "Reply with the word pong.", { model, tools: [], trustWorkspace: true, containment: "off", inPlace: true });
writeFileSync(outFile, JSON.stringify({ code }));
process.exit(0);
