/**
 * A TypeScript client of the engine server (P5 #35): what the tests drive it with, and what `lykos run` and the MCP
 * worker use when their sessions move onto it (#51). The TUI's client is the Rust crate `crates/client`.
 */
import { connect as netConnect, type Socket } from "node:net";
import type { EngineAddress } from "./address.js";
import { PROTOCOL_VERSION, type Event, type Method, type Welcome } from "./protocol.js";
import { clientHandshake, LineReader, send } from "./wire.js";

export interface EngineConnection {
  welcome: Welcome;
  request<T = unknown>(method: Method, params?: Record<string, unknown>): Promise<T>;
  onEvent(fn: (event: Event) => void): void;
  close(): void;
  closed: Promise<void>;
}

export async function connectEngine(address: EngineAddress, key: Buffer, opts: { client?: string; protocol?: number } = {}): Promise<EngineConnection> {
  const socket: Socket = await new Promise((resolve, reject) => {
    const s = netConnect(address.path);
    s.once("connect", () => {
      s.off("error", reject);
      resolve(s);
    });
    s.once("error", reject);
  });
  socket.on("error", () => {});
  const reader = new LineReader(socket);
  let welcome: Welcome;
  try {
    welcome = await clientHandshake(socket, reader, key, opts.client ?? "lykos-ts", opts.protocol ?? PROTOCOL_VERSION);
  } catch (err) {
    socket.destroy();
    throw err;
  }
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners: Array<(e: Event) => void> = [];
  let nextId = 1;
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => {
      for (const p of pending.values()) p.reject(new Error("the connection closed"));
      pending.clear();
      resolve();
    }),
  );
  reader.listen((value) => {
    const v = value as Record<string, unknown>;
    if (typeof v.event === "string") {
      for (const fn of listeners) fn(v as unknown as Event);
      return;
    }
    const p = typeof v.id === "number" ? pending.get(v.id) : undefined;
    if (!p) return;
    pending.delete(v.id as number);
    if (v.error !== undefined) p.reject(new Error((v.error as { message: string }).message));
    else p.resolve(v.result);
  });
  return {
    welcome,
    request: <T>(method: Method, params: Record<string, unknown> = {}): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
        send(socket, { id, method, params });
      }),
    onEvent: (fn) => listeners.push(fn),
    close: () => socket.end(),
    closed,
  };
}
