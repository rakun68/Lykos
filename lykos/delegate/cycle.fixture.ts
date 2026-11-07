// T236 fixture: a `lykos cycle` owner in a process of its own, with a stand-in session runner whose fixer never ends.
//   cycle.fixture.ts <workspace> <cycle-or-session-id> <log-file>
// Every request the cycle starts a session with is appended to <log-file> as one JSON line. The fixer (a continuation of
// the implementer's session, not a review) asks nothing and runs until the process is killed.

import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { stdoutWrite } from "../tui/io-mode.js";
import { runCycle } from "./cycle.js";
import type { SessionRunner } from "./session-protocol.js";

const [workspace, target, log] = process.argv.slice(2);
if (workspace === undefined || target === undefined || log === undefined) {
  process.stderr.write("cycle.fixture: expected <workspace> <cycle-or-session-id> <log-file>\n");
  process.exit(2);
}

const run: SessionRunner = async ({ request, signal }) => {
  appendFileSync(log, `${JSON.stringify({ requestId: request.requestId ?? null, sessionId: request.sessionId ?? null, review: request.review === true, pid: process.pid })}\n`);
  while (!signal.aborted) await sleep(50);
  return { outcome: "error", message: "stopped", sessionId: request.sessionId ?? "unknown" };
};

const result = await runCycle(workspace, target, { trustSource: "flag", run });
stdoutWrite(`${JSON.stringify(result)}\n`);
