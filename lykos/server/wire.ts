/**
 * The engine server's wire: newline-delimited JSON, and the handshake both ends run before anything else
 * (P5 #35). The protocol is `protocol.ts`; the reference is `docs/reference/engine-server.md`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { PROTOCOL_VERSION, type Auth, type Challenge, type Hello, type Refused, type Welcome } from "./protocol.js";

/** A refused line is cut here: a peer that never sends a newline cannot grow the buffer without limit. */
const MAX_LINE = 16 * 1024 * 1024;

/** Reads one JSON value per line from a socket. */
export class LineReader {
  private buffer = "";
  private readonly waiting: Array<(line: unknown) => void> = [];
  private readonly lines: unknown[] = [];
  private ended = false;
  onLine?: (value: unknown) => void;

  constructor(socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      if (this.buffer.length > MAX_LINE) {
        socket.destroy(new Error("line too long"));
        return;
      }
      let nl: number;
      while ((nl = this.buffer.indexOf("\n")) >= 0) {
        const raw = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (raw.trim() === "") continue;
        let value: unknown;
        try {
          value = JSON.parse(raw);
        } catch {
          socket.destroy(new Error("not JSON"));
          return;
        }
        this.push(value);
      }
    });
    socket.on("close", () => {
      this.ended = true;
      while (this.waiting.length > 0) this.waiting.shift()!(null);
    });
  }

  private push(value: unknown): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter(value);
    else if (this.onLine) this.onLine(value);
    else this.lines.push(value);
  }

  /** The next line, or null once the socket closed. */
  next(timeoutMs?: number): Promise<unknown> {
    if (this.lines.length > 0) return Promise.resolve(this.lines.shift());
    if (this.ended) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = (v: unknown): void => {
        if (timer) clearTimeout(timer);
        resolve(v);
      };
      const timer =
        timeoutMs !== undefined
          ? setTimeout(() => {
              const i = this.waiting.indexOf(waiter);
              if (i >= 0) this.waiting.splice(i, 1);
              resolve(null);
            }, timeoutMs)
          : undefined;
      this.waiting.push(waiter);
    });
  }

  /** Hands every later line, and any already read, to `fn`. */
  listen(fn: (value: unknown) => void): void {
    this.onLine = fn;
    while (this.lines.length > 0) fn(this.lines.shift());
  }
}

export function send(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`);
}

export function proof(key: Buffer, side: "server" | "client", nonce: string): string {
  return createHmac("sha256", key).update(`${side}:${nonce}`).digest("hex");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const HANDSHAKE_MS = 5000;

export type ServerHandshake = { ok: true; client: string } | { ok: false; reason: string };

/** The server's half: the client says hello, the server proves the key first, the client proves it back. */
export async function serverHandshake(socket: Socket, reader: LineReader, key: Buffer, serverName: string): Promise<ServerHandshake> {
  const hello = await reader.next(HANDSHAKE_MS);
  if (!isObject(hello) || hello.type !== "hello" || typeof hello.nonce !== "string") return { ok: false, reason: "no hello" };
  if (hello.protocol !== PROTOCOL_VERSION) {
    const refused: Refused = {
      type: "refused",
      reason: "protocol",
      message: `the server speaks protocol ${PROTOCOL_VERSION}; this client speaks ${String(hello.protocol)}`,
      server: PROTOCOL_VERSION,
      ...(typeof hello.protocol === "number" ? { client: hello.protocol } : {}),
    };
    send(socket, refused);
    return { ok: false, reason: refused.message };
  }
  const nonce = randomBytes(32).toString("hex");
  const challenge: Challenge = { type: "challenge", nonce, proof: proof(key, "server", hello.nonce) };
  send(socket, challenge);
  const auth = await reader.next(HANDSHAKE_MS);
  if (!isObject(auth) || auth.type !== "auth" || typeof auth.proof !== "string" || !same(auth.proof, proof(key, "client", nonce))) {
    const refused: Refused = { type: "refused", reason: "auth", message: "the client did not prove it holds this user's engine key" };
    send(socket, refused);
    return { ok: false, reason: refused.message };
  }
  const welcome: Welcome = { type: "welcome", protocol: PROTOCOL_VERSION, server: serverName, pid: process.pid };
  send(socket, welcome);
  return { ok: true, client: typeof hello.client === "string" ? hello.client : "unknown" };
}

export class HandshakeError extends Error {
  constructor(
    message: string,
    readonly reason: "protocol" | "auth" | "closed",
  ) {
    super(message);
  }
}

/** The client's half. Throws `HandshakeError` when refused, or when the server cannot prove the key. */
export async function clientHandshake(socket: Socket, reader: LineReader, key: Buffer, client: string, protocol = PROTOCOL_VERSION): Promise<Welcome> {
  const nonce = randomBytes(32).toString("hex");
  const hello: Hello = { type: "hello", protocol, client, nonce };
  send(socket, hello);
  const challenge = await reader.next(HANDSHAKE_MS);
  if (!isObject(challenge)) throw new HandshakeError("the server closed the connection", "closed");
  if (challenge.type === "refused") throw new HandshakeError(String(challenge.message), challenge.reason === "protocol" ? "protocol" : "auth");
  if (challenge.type !== "challenge" || typeof challenge.nonce !== "string" || typeof challenge.proof !== "string" || !same(challenge.proof, proof(key, "server", nonce))) {
    throw new HandshakeError("the server did not prove it holds this user's engine key", "auth");
  }
  const auth: Auth = { type: "auth", proof: proof(key, "client", challenge.nonce) };
  send(socket, auth);
  const welcome = await reader.next(HANDSHAKE_MS);
  if (!isObject(welcome)) throw new HandshakeError("the server closed the connection", "closed");
  if (welcome.type === "refused") throw new HandshakeError(String(welcome.message), "auth");
  if (welcome.type !== "welcome") throw new HandshakeError("unexpected reply to auth", "auth");
  return welcome as unknown as Welcome;
}
