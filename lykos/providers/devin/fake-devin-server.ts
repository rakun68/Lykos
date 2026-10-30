// A local Devin (Codeium Cascade) server for tests.
//
// Plain HTTP/1.1 on 127.0.0.1:0, built with `node:http`. It speaks the Devin transport:
// unary protobuf `GetUserJwt` and `AssignModel`,
// then `GetChatMessage` answered with Connect frames (flag 0x01 = gzip, 0x02 = end-stream JSON
// trailer). Every frame is built from the ported schemas in `./proto.ts`; nothing here was
// recorded against a live account. Never point it at, or proxy it to, a real Devin host.

import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import { create, fromBinary, toBinary } from "../protobuf/codec.js";
import {
  type AssignModelRequest,
  AssignModelRequestSchema,
  type GetChatMessageRequest,
  GetChatMessageRequestSchema,
  type GetChatMessageResponse,
  GetChatMessageResponseSchema,
  type GetUserJwtRequest,
  GetUserJwtRequestSchema,
  GetUserJwtResponseSchema,
} from "./proto.js";
import { CHAT_MESSAGE_PATH, CONNECT_COMPRESSED_FLAG, CONNECT_END_STREAM_FLAG, DEVIN_AUTH_PATH } from "./stream.js";

export interface FakeDevinRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/** Answers one request; a request it leaves unanswered gets a 404. */
export type FakeDevinHandler = (req: FakeDevinRequest, res: ServerResponse) => void | Promise<void>;

export interface FakeDevinServer {
  baseUrl: string;
  requests: FakeDevinRequest[];
  close(): Promise<void>;
}

export async function startFakeDevinServer(handler: FakeDevinHandler): Promise<FakeDevinServer> {
  const requests: FakeDevinRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const record: FakeDevinRequest = {
        method: req.method ?? "GET",
        path: new URL(req.url ?? "/", "http://x").pathname,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(record);
      void Promise.resolve(handler(record, res)).then(
        () => {
          if (!res.headersSent) res.writeHead(404).end();
        },
        () => {
          if (!res.headersSent) res.writeHead(500).end();
          else res.destroy();
        },
      );
    });
  });
  // A client that cancels mid-body leaves a reset socket; that is expected here.
  server.on("clientError", (_err, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** One Connect frame: a flag byte, a big-endian length, the payload. */
export function connectFrame(payload: Uint8Array, flag = 0): Buffer {
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = flag;
  frame.writeUInt32BE(payload.length, 1);
  frame.set(payload, 5);
  return frame;
}

/** A `GetChatMessageResponse` frame, gzipped when asked (flag 0x01). */
export function chatFrame(fields: Partial<GetChatMessageResponse>, gzip = false): Buffer {
  const bytes = toBinary(GetChatMessageResponseSchema, create(GetChatMessageResponseSchema, fields));
  return gzip ? connectFrame(gzipSync(bytes), CONNECT_COMPRESSED_FLAG) : connectFrame(bytes);
}

/** An end-stream frame (flag 0x02) carrying `{ error }`, or `{}` when none. */
export function endStreamFrame(error?: Record<string, unknown>): Buffer {
  return connectFrame(Buffer.from(JSON.stringify(error ? { error } : {}), "utf8"), CONNECT_END_STREAM_FLAG);
}

export function userJwtResponse(userJwt: string, customApiServerUrl = ""): Buffer {
  return Buffer.from(toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt, customApiServerUrl })));
}

export function decodeUserJwtRequest(body: Buffer): GetUserJwtRequest {
  return fromBinary(GetUserJwtRequestSchema, body);
}

export function decodeAssignRequest(body: Buffer): AssignModelRequest {
  return fromBinary(AssignModelRequestSchema, body);
}

/** The client's single gzipped request frame, decoded. */
export function decodeChatRequest(body: Buffer): GetChatMessageRequest {
  const flag = body[0]!;
  const length = body.readUInt32BE(1);
  const payload = body.subarray(5, 5 + length);
  return fromBinary(GetChatMessageRequestSchema, flag & CONNECT_COMPRESSED_FLAG ? gunzipSync(payload) : payload);
}

/**
 * The usual edge: `GetUserJwt` answers `userJwt`, `GetChatMessage` writes `frames` then ends.
 * Anything else (`AssignModel`) is left to `extra`.
 */
export function simpleDevinHandler(frames: Buffer[], opts: { userJwt?: string; extra?: FakeDevinHandler } = {}): FakeDevinHandler {
  return async (req, res) => {
    if (req.path === DEVIN_AUTH_PATH) {
      res.writeHead(200, { "content-type": "application/proto" }).end(userJwtResponse(opts.userJwt ?? "user-jwt"));
      return;
    }
    if (req.path === CHAT_MESSAGE_PATH) {
      res.writeHead(200, { "content-type": "application/connect+proto" });
      for (const frame of frames) res.write(frame);
      res.end();
      return;
    }
    await opts.extra?.(req, res);
  };
}
