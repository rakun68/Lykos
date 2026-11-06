// T243 fixture: a `lykos run` owner in a process of its own, with a stand-in session runner. Usage:
//   delegation-core.fixture.ts <workspace> <release-file> [request-id]
// The stand-in session runs until <release-file> exists (or forever, if it never does), then returns ok. The
// result is printed as one JSON line on stdout.

import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { runDelegated } from "./mcp-server.js";
import type { SessionRunner } from "./session-protocol.js";

const [workspace, releaseFile, requestId] = process.argv.slice(2);
if (workspace === undefined || releaseFile === undefined) {
  process.stderr.write("delegation-core.fixture: expected <workspace> <release-file> [request-id]\n");
  process.exit(2);
}

const run: SessionRunner = async ({ request, signal }) => {
  while (!existsSync(releaseFile) && !signal.aborted) await sleep(50);
  return { outcome: "ok", sessionId: request.newSessionId ?? request.sessionId ?? "unknown", answer: "released", steps: 1 };
};

const result = await runDelegated(
  workspace,
  { brief: "fixture task", write_in_place: true, ...(requestId !== undefined ? { request_id: requestId } : {}) },
  { trustSource: "flag", run },
);
process.stdout.write(`${JSON.stringify(result)}\n`);
