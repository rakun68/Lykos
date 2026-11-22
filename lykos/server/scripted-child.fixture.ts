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
