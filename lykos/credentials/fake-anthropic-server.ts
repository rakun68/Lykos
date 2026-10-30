// Test support: a fake Anthropic Messages server on 127.0.0.1:0, scripted per
// API key (the `x-api-key` header). The same wire shape as `rotation.test.ts`'s
// own server; every body here is WRITTEN, NOT RECORDED. Imported by tests only;
// nothing in a session uses it.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeBehaviour =
  | { kind: "ok"; text?: string }
  | { kind: "status"; status: number; body: string };

export interface FakeAnthropicServer {
  baseUrl: string;
  /** Behaviour per API key; a list is consumed one entry per request, the last entry repeating. */
  script: Map<string, FakeBehaviour[]>;
  /** Behaviours for the next requests whatever their key, consumed before `script`. */
  upcoming: FakeBehaviour[];
  /** The `x-api-key` of every request, in order. */
  seen: string[];
  reset(): void;
  close(): Promise<void>;
}

function sseEvent(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** A complete, successful streamed reply carrying `text`. */
export function textReply(text: string): string {
  return (
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_fake",
        type: "message",
        role: "assistant",
        model: "m1",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    }) +
    sseEvent("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    sseEvent("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) +
    sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 3 },
    }) +
    sseEvent("message_stop", { type: "message_stop" })
  );
}

/** An Anthropic error body. */
export function anthropicError(type: string, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

export async function startFakeAnthropicServer(): Promise<FakeAnthropicServer> {
  const script = new Map<string, FakeBehaviour[]>();
  const upcoming: FakeBehaviour[] = [];
  const seen: string[] = [];
  const server: Server = createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const key = String(req.headers["x-api-key"] ?? "");
      seen.push(key);
      const list = script.get(key);
      const behaviour =
        upcoming.shift() ?? (list === undefined ? undefined : list.length > 1 ? list.shift()! : list[0]!);
      if (behaviour === undefined) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(anthropicError("api_error", "unscripted key"));
        return;
      }
      if (behaviour.kind === "status") {
        res.writeHead(behaviour.status, { "content-type": "application/json" });
        res.end(behaviour.body);
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(textReply(behaviour.text ?? "hello"));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    script,
    upcoming,
    seen,
    reset() {
      script.clear();
      upcoming.length = 0;
      seen.length = 0;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
