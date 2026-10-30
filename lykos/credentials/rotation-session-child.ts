// Child process for rotation.test.ts case 12: one real `runStandaloneTask`
// against the fake model server.
//
// It runs in its own process so the parent can give it a throwaway home
// (`HOME` / `USERPROFILE`), Pi agent dir and credential db: a standalone run
// registers the project and reads user-level config under the home directory,
// and a test must never touch the real one. The result goes to a file, not
// stdout (T32.2: stdout belongs to io-mode.ts).
//
// argv: <workspace> <provider/model> <outFile>

import { writeFileSync } from "node:fs";
import { runStandaloneTask } from "../session/session.js";

const [workspace, model, outFile] = process.argv.slice(2);
if (!workspace || !model || !outFile) {
  process.stderr.write("rotation-session-child: expected <workspace> <provider/model> <outFile>\n");
  process.exit(2);
}

const result = await runStandaloneTask({ workspace, prompt: "Reply with the word pong.", model, tools: [] });
writeFileSync(outFile, JSON.stringify(result));
process.exit(0);
