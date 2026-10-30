// Test support: a local fake authorization server on 127.0.0.1:0, a scripted Pi
// login interaction, and unsigned JWTs. Every response a test scripts here is
// WRITTEN from the providers' request/response shapes and Pi 0.84.3's dist, NOT
// RECORDED against a live vendor. Imported by tests only.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LoginInteraction } from "./code-flow.js";

export interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: string;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type FakeRoute = (req: FakeRequest) => FakeReply | undefined;

export interface FakeAuthServer {
  base: string;
  requests: FakeRequest[];
  close(): Promise<void>;
}

/** A fake server: `route` answers each request (undefined = 404) and every request is recorded. */
export async function startFakeAuthServer(route: FakeRoute): Promise<FakeAuthServer> {
  const requests: FakeRequest[] = [];
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://fake");
      const recorded: FakeRequest = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, headers: req.headers, body };
      requests.push(recorded);
      const reply = route(recorded);
      if (reply === undefined) {
        res.writeHead(404, { "Content-Type": "application/json" }).end("{}");
        return;
      }
      const payload = reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
      res.writeHead(reply.status ?? 200, { "Content-Type": "application/json", ...reply.headers }).end(payload);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}

/** An unsigned JWT whose payload is `payload`; only the payload is ever read. */
export function jwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none" })}.${enc(payload)}.signature`;
}

export type InteractionEvent = Parameters<LoginInteraction["notify"]>[0];
export type InteractionPrompt = Parameters<LoginInteraction["prompt"]>[0];

export interface ScriptedInteraction {
  interaction: LoginInteraction;
  events: InteractionEvent[];
  prompts: InteractionPrompt[];
}

/**
 * A Pi login interaction. `answer` returns a prompt's answer, or undefined to leave it
 * pending until its signal aborts (the manual-paste prompt while the browser completes).
 */
export function scriptedInteraction(
  answer: (p: InteractionPrompt) => string | Promise<string> | undefined,
  signal: AbortSignal = new AbortController().signal,
): ScriptedInteraction {
  const events: InteractionEvent[] = [];
  const prompts: InteractionPrompt[] = [];
  const interaction: LoginInteraction = {
    signal,
    notify: (e) => {
      events.push(e);
    },
    prompt: (p) => {
      prompts.push(p);
      const a = answer(p);
      if (a !== undefined) return Promise.resolve(a);
      return new Promise<string>((_resolve, reject) => {
        const s = p.signal;
        if (s === undefined) return;
        if (s.aborted) reject(new Error("aborted"));
        else s.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    },
  };
  return { interaction, events, prompts };
}

/** The authorize URL the flow announced. */
export function announcedAuthUrl(events: InteractionEvent[]): URL {
  const e = events.find((x) => x.type === "auth_url");
  if (e === undefined || e.type !== "auth_url") throw new Error("no auth_url event");
  return new URL(e.url);
}

/** Wait until `check` returns a value (polling the event loop), or throw after `ms`. */
export async function waitFor<T>(check: () => T | undefined, ms = 5_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Play the browser: GET the loopback callback on `port` with `query`. */
export async function hitCallback(port: number, path: string, query: Record<string, string>): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}${path}?${new URLSearchParams(query).toString()}`);
  await res.text();
  return res.status;
}
