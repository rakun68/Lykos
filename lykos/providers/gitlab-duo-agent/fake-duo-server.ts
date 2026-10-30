// A local GitLab Duo Agent server for tests.
//
// Plain HTTP on 127.0.0.1:0 with `node:http`: the REST routes the stream calls, answered by
// a test-supplied router, and the workflow WebSocket at `/api/v4/ai/duo_workflows/ws`, done by
// hand (the HTTP upgrade and RFC 6455 framing) so no dependency is added. Nothing here was recorded against a
// live account. Never point it at, or proxy it to, a real GitLab host.

import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

export interface FakeRestRequest {
  method: string;
  /** Path and query, as received. */
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface FakeRestResponse {
  status: number;
  body?: unknown;
}

export interface FakeDuoSocket {
  /** Path and query of the upgrade request. */
  url: string;
  headers: IncomingHttpHeaders;
  /** Every text message received so far, parsed as JSON. */
  received: unknown[];
  /** Resolves with the next message not yet taken by `next`. */
  next(timeoutMs?: number): Promise<unknown>;
  send(message: unknown): void;
  close(code?: number): void;
  /** Resolves when the client closes or the socket ends. */
  closed: Promise<void>;
}

export interface FakeDuoServer {
  baseUrl: string;
  requests: FakeRestRequest[];
  sockets: FakeDuoSocket[];
  close(): Promise<void>;
}

export interface FakeDuoOptions {
  /** Answers one REST request; undefined is a 404. */
  rest: (req: FakeRestRequest) => FakeRestResponse | undefined;
  /** Drives one WebSocket connection; `index` counts connections from 0. */
  onSocket?: (socket: FakeDuoSocket, index: number) => void | Promise<void>;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function acceptSocket(req: IncomingMessage, socket: Socket, head: Buffer): FakeDuoSocket {
  const key = String(req.headers["sec-websocket-key"] ?? "");
  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const received: unknown[] = [];
  let taken = 0;
  const waiters: Array<() => void> = [];
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));
  let ended = false;
  const end = (): void => {
    if (ended) return;
    ended = true;
    resolveClosed();
    for (const w of waiters.splice(0)) w();
  };

  let buffer: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  let fragments: Buffer[] = [];
  const drain = (): void => {
    for (;;) {
      if (buffer.length < 2) return;
      const b0 = buffer[0]!;
      const b1 = buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskOffset = offset;
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (masked) {
        for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ buffer[maskOffset + (i % 4)]!;
      }
      buffer = buffer.subarray(offset + length);

      if (opcode === 0x8) {
        if (!socket.destroyed) socket.end(encodeFrame(0x8, payload.subarray(0, 2)));
        end();
        return;
      }
      if (opcode === 0x9) {
        socket.write(encodeFrame(0xa, payload));
        continue;
      }
      if (opcode === 0xa) continue;
      fragments.push(payload);
      if (!fin) continue;
      const text = Buffer.concat(fragments).toString("utf8");
      fragments = [];
      try {
        received.push(JSON.parse(text) as unknown);
      } catch {
        received.push(text);
      }
      for (const w of waiters.splice(0)) w();
    }
  };
  socket.on("data", (chunk: Buffer) => {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    drain();
  });
  socket.on("close", end);
  socket.on("error", end);
  if (buffer.length > 0) drain();

  return {
    url: req.url ?? "/",
    headers: req.headers,
    received,
    closed,
    async next(timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (taken >= received.length) {
        if (ended) throw new Error("fake Duo socket closed before the next message");
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("fake Duo socket: no message within the timeout");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      return received[taken++];
    },
    send(message) {
      if (ended || socket.destroyed) return;
      socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(message), "utf8")));
    },
    close(code = 1000) {
      if (ended || socket.destroyed) return;
      const payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
      socket.write(encodeFrame(0x8, payload));
    },
  };
}

export async function startFakeDuoServer(options: FakeDuoOptions): Promise<FakeDuoServer> {
  const requests: FakeRestRequest[] = [];
  const sockets: FakeDuoSocket[] = [];
  const raw = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      const request: FakeRestRequest = { method: req.method ?? "GET", url: req.url ?? "/", headers: req.headers, body };
      requests.push(request);
      const answer = options.rest(request) ?? { status: 404, body: { message: "404 Not Found" } };
      const text = answer.body === undefined ? "" : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
      res.writeHead(answer.status, { "Content-Type": "application/json" }).end(text);
    });
  });
  server.on("connection", (s: Socket) => {
    raw.add(s);
    s.on("close", () => raw.delete(s));
  });
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    raw.add(socket);
    if (!(req.url ?? "").startsWith("/api/v4/ai/duo_workflows/ws")) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    const duo = acceptSocket(req, socket, head);
    const index = sockets.length;
    sockets.push(duo);
    void Promise.resolve(options.onSocket?.(duo, index)).catch(() => {
      // A handler that throws (a `next` timeout after the client left) only ends its socket.
      duo.close();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    baseUrl,
    requests,
    sockets,
    close: async () => {
      for (const s of raw) s.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
