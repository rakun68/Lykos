/**
 * A scripted `server-session` child for the engine server's tests: the IPC messages a real session child sends,
 * with no model behind them. `hold` keeps a turn running until `release`; `ask` waits on an answer; anything else
 * streams itself back in three deltas. P5 #48: `job` starts a real background job and `shell` runs a real shell call
 * that holds the turn, on the session child's own job calls.
 */
import { buildBashOperations, type ApprovalDecision } from "../gate/approval.js";
import { JobRegistry } from "../tools/job-runner.js";
import { answerJobCall, watchJobs, type FromChild, type ToChild } from "./session-child.js";

const send = (msg: FromChild): void => {
  process.send?.(msg);
};
let jobs: JobRegistry | undefined;
let shellAbort: AbortController | undefined;
/** Prints a line every 200 ms until it is killed. */
const ticking = `${JSON.stringify(process.execPath)} -e "let n=0;setInterval(()=>console.log('tick '+(++n)),200)"`;
let holding = false;
let asked: string | undefined;
let ledgerSessionId = "ledger-1";

// The server gone (a test that failed, or killed it): stop the jobs and go, as `lykos serve` does.
process.once("disconnect", () => {
  void (jobs?.stopAll() ?? Promise.resolve()).then(() => process.exit(0));
});
process.on("message", (msg: ToChild) => {
  switch (msg.kind) {
    case "start":
      // A resume keeps the ledger session; the ledger it writes is said, so a test can see which.
      ledgerSessionId = msg.params.resume ?? "ledger-1";
      jobs = new JobRegistry({ cwd: msg.params.cwd });
      watchJobs(jobs, (data) => send({ kind: "event", data }));
      send({ kind: "status", status: "idle", ledgerSessionId, model: msg.params.model ?? "faux/scripted" });
      send({ kind: "event", data: { type: "system", text: `ledger ${msg.params.ledgerPath}` } });
      send({ kind: "event", data: { type: "commands", commands: [{ name: "/help", description: "list commands", source: "builtin" }, { name: "/skill:tdd", description: "test first", source: "skill" }] } });
      break;
    case "job":
      answerJobCall(jobs, msg).then(
        (result) => send({ kind: "job", id: msg.id, result }),
        (err: unknown) => send({ kind: "job", id: msg.id, error: err instanceof Error ? err.message : String(err) }),
      );
      break;
    case "aside":
      // An answer that names the question, and nothing in the conversation.
      if (msg.text === "fail") send({ kind: "aside", id: msg.id, error: "overloaded" });
      else send({ kind: "aside", id: msg.id, answer: `aside: ${msg.text}`, model: "faux/scripted" });
      break;
    case "options":
      send({
        kind: "options",
        id: msg.id,
        options: {
          model: "faux/scripted",
          models: [
            { provider: "faux", id: "scripted", name: "Scripted", contextWindow: 200000, reasoning: true },
            { provider: "faux", id: "other", name: "Other", contextWindow: null, reasoning: false },
          ],
          effort: "medium",
          efforts: ["off", "low", "medium", "high"],
          specialist: "build",
          specialists: [
            { name: "build", description: "writes code" },
            { name: "plan", description: "reads and plans" },
          ],
          providers: [{ name: "faux", auth: "api_key", reach: "reachable", reason: "scripted" }],
        },
      });
      break;
    case "prompt": {
      if (holding && msg.text === "release") {
        holding = false;
        send({ kind: "event", data: { type: "message.delta", text: "released" } });
        send({ kind: "event", data: { type: "message.end" } });
        send({ kind: "event", data: { type: "turn.end" } });
        send({ kind: "status", status: "idle" });
        break;
      }
      send({ kind: "status", status: "running" });
      send({ kind: "event", data: { type: "message.user", text: msg.text } });
      if (msg.text === "hold") {
        holding = true;
        break;
      }
      if (msg.text === "ask") {
        asked = "r1";
        send({ kind: "event", data: { type: "request", request: { requestId: asked, kind: "question", title: "which?", detail: "", options: [{ value: "1", label: "a" }] } } });
        send({ kind: "status", status: "waiting" });
        break;
      }
      if (msg.text === "approve") {
        // An edit's approval, as the gate's request reaches a client (P5 #46).
        asked = "r2";
        const patch = "--- notes.md\n+++ notes.md\n@@ -1,1 +1,2 @@\n # notes\n+a new line\n";
        const options = [
          { value: "y", label: "Allow once" },
          { value: "a", label: "Always allow edit this session", note: "This will allow every edit for the rest of this session." },
          { value: "n", label: "Deny" },
        ];
        send({ kind: "event", data: { type: "request", request: { requestId: asked, kind: "approval", title: "edit: notes.md", detail: "notes.md", patch, options } } });
        send({ kind: "status", status: "waiting" });
        break;
      }
      if (msg.text === "job" && jobs !== undefined) {
        const job = jobs.start({ command: ticking });
        send({ kind: "event", data: { type: "message.delta", text: `started ${job.id}` } });
        send({ kind: "event", data: { type: "message.end" } });
        send({ kind: "event", data: { type: "turn.end" } });
        send({ kind: "status", status: "idle" });
        break;
      }
      if (msg.text === "shell" && jobs !== undefined) {
        const allow = { request: (): Promise<ApprovalDecision> => Promise.resolve("allow") };
        const ops = buildBashOperations(jobs.cwd, allow, undefined, { jobs, defaultTimeoutSeconds: 120 });
        shellAbort = new AbortController();
        send({ kind: "event", data: { type: "tool.start", toolId: "sh1", name: "bash", summary: "ticking", args: { command: ticking } } });
        let out = "";
        ops.exec(ticking, jobs.cwd, { onData: (d) => (out += d.toString()), signal: shellAbort.signal }).then(
          (r) => {
            send({ kind: "event", data: { type: "tool.end", toolId: "sh1", name: "bash", ok: r.exitCode === 0, preview: out.slice(-300) } });
            send({ kind: "event", data: { type: "turn.end" } });
            send({ kind: "status", status: "idle" });
          },
          () => undefined,
        );
        break;
      }
      if (msg.text === "tool") {
        // A tool call and the usage after it, as a real turn sends them (the TUI's end-to-end test, #37).
        send({ kind: "event", data: { type: "tool.start", toolId: "t1", name: "read", summary: "README.md", args: { path: "README.md" } } });
        send({ kind: "event", data: { type: "tool.end", toolId: "t1", name: "read", ok: true, preview: "# Lykos" } });
        const usage = { model: "faux/scripted", effort: "high", contextTokens: 12345, contextWindow: 200000, contextPercent: 6.2, runUsd: null, todayUsd: null, cacheHitRatio: 0.74, calls: 1,
          tokens: { fresh: 1200, cacheRead: 3400, cacheWrite: 500, output: 230, reasoning: 0 },
          cache: { model: "faux/scripted", cachedTokens: 3400, writtenTokens: 500, ageSeconds: 4, pct: 0.74, status: "fresh" as const },
          alerts: [{ id: "budget.run", severity: "warn" as const, message: "run spend at 80% of its cap", remedy: "raise budget.run_usd" }],
          outcome: null };
        send({ kind: "event", data: { type: "usage", usage } });
        send({ kind: "event", data: { type: "message.delta", text: "read the readme" } });
        send({ kind: "event", data: { type: "message.end" } });
        send({ kind: "event", data: { type: "turn.end" } });
        send({ kind: "status", status: "idle" });
        break;
      }
      const third = Math.ceil(msg.text.length / 3);
      for (let i = 0; i < msg.text.length; i += third) send({ kind: "event", data: { type: "message.delta", text: msg.text.slice(i, i + third) } });
      send({ kind: "event", data: { type: "message.end" } });
      send({ kind: "event", data: { type: "turn.end" } });
      send({ kind: "status", status: "idle" });
      break;
    }
    case "answer":
      if (msg.requestId === asked) {
        send({ kind: "event", data: { type: "request.resolved", requestId: asked, answer: msg.answer } });
        send({ kind: "event", data: { type: "turn.end" } });
        send({ kind: "status", status: "idle" });
        asked = undefined;
      }
      break;
    case "interrupt":
      holding = false;
      shellAbort?.abort();
      send({ kind: "event", data: { type: "system", text: "interrupted" } });
      send({ kind: "status", status: "idle" });
      break;
    case "close":
      void (jobs?.stopAll() ?? Promise.resolve()).then(() => {
        send({ kind: "exit", ok: true, ledgerSessionId });
        process.disconnect();
      });
      break;
    default:
      break;
  }
});
