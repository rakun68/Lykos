/**
 * A scripted `server-session` child for the engine server's tests: the IPC messages a real session child sends,
 * with no model behind them. `hold` keeps a turn running until `release`; `ask` waits on an answer; anything else
 * streams itself back in three deltas.
 */
import type { FromChild, ToChild } from "./session-child.js";

const send = (msg: FromChild): void => {
  process.send?.(msg);
};
let holding = false;
let asked: string | undefined;

process.on("message", (msg: ToChild) => {
  switch (msg.kind) {
    case "start":
      send({ kind: "status", status: "idle", ledgerSessionId: "ledger-1", model: msg.params.model ?? "faux/scripted" });
      send({ kind: "event", data: { type: "commands", commands: [{ name: "/help", description: "list commands", source: "builtin" }, { name: "/skill:tdd", description: "test first", source: "skill" }] } });
      break;
    case "aside":
      // An answer that names the question, and nothing in the conversation.
      if (msg.text === "fail") send({ kind: "aside", id: msg.id, error: "overloaded" });
      else send({ kind: "aside", id: msg.id, answer: `aside: ${msg.text}`, model: "faux/scripted" });
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
      if (msg.text === "tool") {
        // A tool call and the usage after it, as a real turn sends them (the TUI's end-to-end test, #37).
        send({ kind: "event", data: { type: "tool.start", toolId: "t1", name: "read", summary: "README.md", args: { path: "README.md" } } });
        send({ kind: "event", data: { type: "tool.end", toolId: "t1", name: "read", ok: true, preview: "# Lykos" } });
        const usage = { model: "faux/scripted", effort: "high", contextTokens: 12345, contextWindow: 200000, contextPercent: 6.2, runUsd: null, todayUsd: null, cacheHitRatio: null, calls: 1 };
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
      send({ kind: "event", data: { type: "system", text: "interrupted" } });
      send({ kind: "status", status: "idle" });
      break;
    case "close":
      send({ kind: "exit", ok: true, ledgerSessionId: "ledger-1" });
      process.disconnect();
      break;
    default:
      break;
  }
});
