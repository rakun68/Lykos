// Child process for rotation-visible.test.ts: one real interactive Lykos
// session (the append-only surface, a real AgentUi) against the parent's fake
// model server, driven by a scripted line source.
//
// It runs in its own process so the parent can give it a throwaway home, Pi
// agent dir and credential db, and read what the surface printed. It observes
// the session's real extension host by wrapping `LykosExtensionHost.prototype
// .emit`: no production path installs a Lykos extension yet, so this is the
// only way to watch `credential_rotated` leave the session's own sink. Each
// payload is appended to `eventsFile` as one JSON line.
//
// argv: <workspace> <provider/model> <ledgerPath> <eventsFile> <prompt>...

import { appendFileSync } from "node:fs";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { LykosExtensionHost } from "../extensions/api.js";
import { runInteractiveStandaloneSession, type LineSource } from "../session/interactive.js";

const [workspace, model, ledgerPath, eventsFile, ...prompts] = process.argv.slice(2);
if (!workspace || !model || !ledgerPath || !eventsFile || prompts.length === 0) {
  process.stderr.write("rotation-visible-child: expected <workspace> <provider/model> <ledgerPath> <eventsFile> <prompt>...\n");
  process.exit(2);
}

const emit = LykosExtensionHost.prototype.emit;
LykosExtensionHost.prototype.emit = function (this: LykosExtensionHost, event, payload) {
  if (event === "credential_rotated") appendFileSync(eventsFile, `${JSON.stringify(payload)}\n`);
  return emit.call(this, event, payload as never);
} as typeof emit;

// The session the loop drives, captured so each scripted line waits for the
// previous turn to settle: a line that arrived mid-turn would be a steer.
let current: AgentSession | undefined;
const prompt = AgentSession.prototype.prompt;
AgentSession.prototype.prompt = function (this: AgentSession, ...args: Parameters<typeof prompt>) {
  current = this;
  return prompt.apply(this, args);
};

const lines = [...prompts, "/exit"];
const lineSource: LineSource = {
  async next() {
    if (current !== undefined) await current.waitForIdle();
    await new Promise((r) => setImmediate(r));
    return lines.shift() ?? null;
  },
  close() {},
};

const result = await runInteractiveStandaloneSession({
  workspace,
  model,
  ledgerPath,
  tools: [],
  lineSource,
  askOutcome: false,
  noFullscreen: true,
});
process.stderr.write(`\nrotation-visible-child: ${JSON.stringify({ status: result.status })}\n`);
process.exit(result.status === "ok" ? 0 : 1);
