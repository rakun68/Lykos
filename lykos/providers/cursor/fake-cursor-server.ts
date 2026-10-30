// A local Cursor Run server for tests.
//
// Plain-text HTTP/2 (h2c) on 127.0.0.1:0, built with `node:http2`
// `createServer`. It speaks Cursor's Run transport: Connect frames of
// `AgentClientMessage` in, `AgentServerMessage` out, an end-stream frame
// (flag 0x02) carrying a JSON error. Every frame is built from the ported
// schemas in `./proto.ts`; nothing here was recorded against a live account.
// Never point it at, or proxy it to, a real Cursor host.

import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { fromBinary, toBinary } from "../protobuf/codec.js";
import { type AgentClientMessage, AgentClientMessageSchema, type AgentServerMessage, AgentServerMessageSchema } from "./proto.js";
import { CONNECT_END_STREAM_FLAG, frameConnectMessage } from "./stream.js";

export interface FakeRunContext {
  headers: http2.IncomingHttpHeaders;
  /** Every client message decoded so far on this stream, in order. */
  received: AgentClientMessage[];
  /** Resolves with the first client message (already received or future) matching `predicate`. */
  waitFor(predicate: (m: AgentClientMessage) => boolean, timeoutMs?: number): Promise<AgentClientMessage>;
  /**
   * Respond 200 with the Connect content type (done once, lazily, by `send`).
   * With `trailers`, they are sent when the stream ends.
   */
  respondOk(trailers?: Record<string, string>): void;
  /** Respond with a non-200 status and a body, then end. */
  respondStatus(status: number, body: string): void;
  send(message: AgentServerMessage): void;
  /** Write one Connect end-stream frame carrying `{ error: { code, message } }`. */
  sendEndStreamError(code: string, message: string): void;
  end(): void;
}

export type FakeRunHandler = (ctx: FakeRunContext) => void | Promise<void>;

export interface FakeCursorServer {
  baseUrl: string;
  /** The handler for the next Run streams, in order; the last one repeats. */
  handlers: FakeRunHandler[];
  /** One context per Run stream served. */
  runs: FakeRunContext[];
  close(): Promise<void>;
}

export async function startFakeCursorServer(handlers: FakeRunHandler[] = []): Promise<FakeCursorServer> {
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("close", () => sessions.delete(session));
  });

  const fake: FakeCursorServer = {
    baseUrl: "",
    handlers,
    runs: [],
    async close() {
      for (const session of sessions) session.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  server.on("stream", (stream, headers) => {
    if (headers[":path"] !== "/agent.v1.AgentService/Run") {
      stream.respond({ ":status": 404 });
      stream.end();
      return;
    }
    const received: AgentClientMessage[] = [];
    const waiters: Array<{ predicate: (m: AgentClientMessage) => boolean; resolve: (m: AgentClientMessage) => void }> = [];
    let pending: Buffer = Buffer.alloc(0);
    stream.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 5) {
        const length = pending.readUInt32BE(1);
        if (pending.length < 5 + length) break;
        const message = fromBinary(AgentClientMessageSchema, pending.subarray(5, 5 + length));
        pending = pending.subarray(5 + length);
        received.push(message);
        for (const waiter of [...waiters]) {
          if (waiter.predicate(message)) {
            waiters.splice(waiters.indexOf(waiter), 1);
            waiter.resolve(message);
          }
        }
      }
    });
    stream.on("error", () => {});

    let responded = false;
    const ctx: FakeRunContext = {
      headers,
      received,
      waitFor(predicate, timeoutMs = 5000) {
        const found = received.find(predicate);
        if (found) return Promise.resolve(found);
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("fake Cursor server: timed out waiting for a client message")), timeoutMs);
          waiters.push({
            predicate,
            resolve: (m) => {
              clearTimeout(timer);
              resolve(m);
            },
          });
        });
      },
      respondOk(trailers) {
        if (responded) return;
        responded = true;
        const head = { ":status": 200, "content-type": "application/connect+proto" };
        if (trailers === undefined) {
          stream.respond(head);
          return;
        }
        stream.respond(head, { waitForTrailers: true });
        stream.on("wantTrailers", () => stream.sendTrailers(trailers));
      },
      respondStatus(status, body) {
        responded = true;
        stream.respond({ ":status": status, "content-type": "application/json" });
        stream.end(body);
      },
      send(message) {
        ctx.respondOk();
        stream.write(frameConnectMessage(toBinary(AgentServerMessageSchema, message)));
      },
      sendEndStreamError(code, message) {
        ctx.respondOk();
        stream.write(frameConnectMessage(Buffer.from(JSON.stringify({ error: { code, message } }), "utf8"), CONNECT_END_STREAM_FLAG));
      },
      end() {
        ctx.respondOk();
        stream.end();
      },
    };
    fake.runs.push(ctx);
    const handler = fake.handlers[Math.min(fake.runs.length - 1, fake.handlers.length - 1)];
    if (handler === undefined) {
      ctx.respondStatus(500, "no handler");
      return;
    }
    void Promise.resolve(handler(ctx)).catch((error: unknown) => {
      if (!stream.destroyed) stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      console.error("fake Cursor server handler failed:", error);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return fake;
}
