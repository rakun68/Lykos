// Rotation (ADR-0026).
//
// `wrapStreamWithRotation` replaces one `ModelRuntime` instance's
// `streamSimple` with an own property that calls the original bound method.
// Pi's agent `streamFn` calls `modelRuntime.streamSimple` for every session,
// subagent and extension stream (`pi-coding-agent/dist/core/sdk.js`), so this
// one seam covers them all without patching Pi (AGENTS.md rule 7).
//
// Each call runs attempts. An attempt runs Pi's original `streamSimple` inside
// `credentialContext` naming the session id and the pool row chosen for it,
// so the store's `read` hands Pi exactly that row. Events are held back until
// the first content event (`text_*`, `thinking_*`, `toolcall_*`) or a terminal
// event. A terminal `error` that arrives first, and that the classifier says
// is the credential's fault, is not forwarded: the row is cooled (or
// soft-disabled) and the same `(model, context, options)` is replayed on the
// next row. Once any content event has been forwarded the attempt is
// committed and every later event, `error` included, passes through untouched:
// nothing already shown, and no tool call, is ever produced twice.

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { formatAuthenticationFailure } from "./auth-failure.js";
import { classifyFailure, type FailureKind } from "./classify.js";
import { credentialContext } from "./context.js";
import type { LykosCredentialStore, PoolRowRef } from "./pi-store.js";

type StreamSimple = ModelRuntime["streamSimple"];
type PiModel = Parameters<StreamSimple>[0];
type PiContext = Parameters<StreamSimple>[1];
type PiOptions = Parameters<StreamSimple>[2];
type PiEventStream = ReturnType<StreamSimple>;
type AssistantMessageEvent = PiEventStream extends AsyncIterable<infer E> ? E : never;
type AssistantMessage = Awaited<ReturnType<PiEventStream["result"]>>;

/** The cooldown when no reset is stated. */
export const DEFAULT_COOLDOWN_MS = 60_000;
export const REFRESH_FAILURE_COOLDOWN_MS = 5 * 60_000;
/** The soft-disable cause for a token the provider says was invalidated. */
export const INVALIDATED_CAUSE = "invalidated_token";

export interface RotationEvent {
  provider: string;
  fromLabel: string;
  toLabel: string;
  /** The classifier's verdict on the failure that caused the move. */
  reason: Exclude<FailureKind, "none">;
}

/** The one-line TUI notice for a rotation (ticket 06, plan D4). Labels only, never a secret. */
export function formatRotationNotice(event: RotationEvent): string {
  return `credential rotated: ${event.provider} ${event.fromLabel} → ${event.toLabel} (${event.reason})`;
}

export interface RotationOptions {
  /** Called on each rotation, for ticket 06 to render. Carries labels only, never a secret. */
  onRotation?: (event: RotationEvent) => void;
  /** Clock, for tests. */
  now?: () => number;
}

export interface ServedCredential {
  id: number;
  label: string;
  type: PoolRowRef["type"];
}

/** Which row served the last successful call, per `(sessionId, provider)`. */
const served = new Map<string, ServedCredential>();

/**
 * Which row produced each assistant message this wrapper returned (ticket 06,
 * plan D2). Keyed by the message object itself: Pi's agent loop emits
 * `message_end` with the very object `result()` resolved to
 * (`pi-agent-core/dist/agent-loop.js`), and an extension's replacement is
 * applied in place (`agent-session.js` `_replaceMessageInPlace`), so the
 * session's usage listener can look each call up by the message it saw. A
 * rotation mid-turn therefore attributes every call to its own row.
 */
const servedByMessage = new WeakMap<object, ServedCredential>();

/** The Lykos credential that produced this assistant message, if one did. Labels and type only. */
export function servedCredentialFor(message: unknown): ServedCredential | undefined {
  return typeof message === "object" && message !== null ? servedByMessage.get(message) : undefined;
}

function servedKey(sessionId: string | undefined, provider: string): string {
  return `${sessionId ?? ""}\u0000${provider}`;
}

/** The credential that served the last completed call for this session and provider. */
export function lastServedCredential(sessionId: string | undefined, provider: string): ServedCredential | undefined {
  return served.get(servedKey(sessionId, provider));
}

/**
 * The async-iterable + `result()` surface Pi consumes from a stream (Pi's
 * `AssistantMessageEventStream` lives in `@earendil-works/pi-ai`, which Lykos
 * cannot resolve). Same semantics: `done` / `error` resolve the result.
 */
class RotationEventStream implements AsyncIterable<AssistantMessageEvent> {
  private readonly queue: AssistantMessageEvent[] = [];
  private readonly waiting: Array<(r: IteratorResult<AssistantMessageEvent>) => void> = [];
  private done = false;
  private resolveResult!: (m: AssistantMessage) => void;
  private readonly finalResult = new Promise<AssistantMessage>((resolve) => {
    this.resolveResult = resolve;
  });

  push(event: AssistantMessageEvent): void {
    if (this.done) return;
    if (event.type === "done") {
      this.done = true;
      this.resolveResult(event.message);
    } else if (event.type === "error") {
      this.done = true;
      this.resolveResult(event.error);
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }

  end(result?: AssistantMessage): void {
    this.done = true;
    if (result !== undefined) this.resolveResult(result);
    while (this.waiting.length > 0) this.waiting.shift()!({ value: undefined, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    for (;;) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const next = await new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => this.waiting.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }

  result(): Promise<AssistantMessage> {
    return this.finalResult;
  }
}

function isContentEvent(event: AssistantMessageEvent): boolean {
  return (
    event.type.startsWith("text_") || event.type.startsWith("thinking_") || event.type.startsWith("toolcall_")
  );
}

/** An error message shaped as Pi's own setup failures are (`pi-ai/dist/api/lazy.js`). */
function errorMessage(model: PiModel, text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: text,
    timestamp: Date.now(),
  } as AssistantMessage;
}

type AttemptOutcome =
  | { kind: "committed" }
  | { kind: "failed"; events: AssistantMessageEvent[]; error: AssistantMessage; aborted: boolean };

/**
 * Run one attempt. Buffers until the first content or terminal event. On a
 * content event (or `done`) it forwards the buffer and pipes the rest of the
 * source into `out`, returning `committed` once the source ends. On an `error`
 * before content it returns the buffered events, forwarding nothing.
 */
async function runAttempt(
  source: PiEventStream,
  out: RotationEventStream,
  onDone: () => void,
  attribute: (message: AssistantMessage) => void = () => {},
): Promise<AttemptOutcome> {
  const buffered: AssistantMessageEvent[] = [];
  const iterator = source[Symbol.asyncIterator]();
  let committed = false;
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    const event = next.value;
    if (committed) {
      if (event.type === "done") {
        attribute(event.message);
        onDone();
      } else if (event.type === "error") {
        attribute(event.error);
      }
      out.push(event);
      continue;
    }
    if (event.type === "error") {
      buffered.push(event);
      return { kind: "failed", events: buffered, error: event.error, aborted: event.reason === "aborted" };
    }
    if (isContentEvent(event) || event.type === "done") {
      committed = true;
      for (const held of buffered) out.push(held);
      buffered.length = 0;
      if (event.type === "done") {
        attribute(event.message);
        onDone();
      }
      out.push(event);
      continue;
    }
    buffered.push(event);
  }
  if (!committed) {
    // The source ended with no terminal event and no content: forward what it
    // said, as Pi's own `forwardStream` would.
    for (const held of buffered) out.push(held);
  }
  const result = await source.result();
  attribute(result);
  out.end(result);
  return { kind: "committed" };
}

function describeCooling(provider: string, untilMs: number | undefined): string {
  const when = untilMs !== undefined ? ` until ${new Date(untilMs).toISOString()}` : "";
  return (
    `No usable credential for ${provider}: every credential that may serve it is cooling or already failed${when}. ` +
    `API-key credentials are used for a provider with OAuth credentials only when providers.${provider}.fallbackToApiKey is true.`
  );
}

/**
 * Replace `runtime.streamSimple` with the rotating wrapper. The original bound
 * method is kept and called for every attempt; Pi's prototype is untouched.
 */
export function wrapStreamWithRotation(
  runtime: ModelRuntime,
  store: LykosCredentialStore,
  opts: RotationOptions = {},
): void {
  const original: StreamSimple = runtime.streamSimple.bind(runtime);
  const now = opts.now ?? Date.now;

  const rotating: StreamSimple = (model, context, options) => {
    const out = new RotationEventStream();
    void rotate(original, store, opts, now, model, context, options, out).catch((err: unknown) => {
      const message = errorMessage(model, err instanceof Error ? err.message : String(err));
      out.push({ type: "error", reason: "error", error: message } as AssistantMessageEvent);
      out.end(message);
    });
    return out as unknown as PiEventStream;
  };
  runtime.streamSimple = rotating;
}

async function rotate(
  original: StreamSimple,
  store: LykosCredentialStore,
  opts: RotationOptions,
  now: () => number,
  model: PiModel,
  context: PiContext,
  options: PiOptions,
  out: RotationEventStream,
): Promise<void> {
  const provider = model.provider;
  const sessionId = options?.sessionId;
  const markServed = (row: PoolRowRef | undefined) => (): void => {
    if (row !== undefined) served.set(servedKey(sessionId, provider), { id: row.id, label: row.label, type: row.type });
  };
  const attributeTo = (row: PoolRowRef) => (message: AssistantMessage): void => {
    if (typeof message === "object" && message !== null) {
      servedByMessage.set(message, { id: row.id, label: row.label, type: row.type });
    }
  };
  const run = (row: PoolRowRef | undefined): PiEventStream =>
    credentialContext.run(
      {
        provider,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(row !== undefined ? { credentialId: row.id } : {}),
      },
      () => original(model, context, options),
    );

  // No pool for this provider (an env key, a models.json source): Pi resolves
  // auth as before. The wrapper only carries the session id.
  if (store.enabledCount(provider) === 0) {
    const outcome = await runAttempt(run(undefined), out, () => {});
    if (outcome.kind === "failed") {
      // runAttempt forwards nothing on a failure; without this the stream
      // never ends and the session waits on it forever.
      for (const event of outcome.events) out.push(event);
      out.end(outcome.error);
    }
    return;
  }

  const cap = store.reachableCount(provider, now());
  let row = store.selectForRequest(provider, sessionId, new Set(), now(), model.id);
  if (row === undefined) {
    // The pool exists but nothing in it may serve (ADR-0026): never let Pi
    // fall through to an ambient key.
    const message = errorMessage(model, describeCooling(provider, store.nextCooldownEnd(provider, now())));
    out.push({ type: "error", reason: "error", error: message } as AssistantMessageEvent);
    out.end(message);
    return;
  }

  const tried = new Set<number>();
  const refreshed = new Set<number>();
  const attemptedLabels: string[] = [];
  const failureVerdicts: FailureKind[] = [];
  let first: { events: AssistantMessageEvent[]; error: AssistantMessage; row: PoolRowRef } | undefined;
  let attempts = 0;

  for (;;) {
    tried.add(row.id);
    if (!attemptedLabels.includes(row.label)) attemptedLabels.push(row.label);
    attempts += 1;
    const outcome = await runAttempt(run(row), out, markServed(row), attributeTo(row));
    if (outcome.kind === "committed") return;

    const failure = outcome.error;
    const verdict =
      outcome.aborted || options?.signal?.aborted
        ? { kind: "none" as const }
        : classifyFailure({
            ...(failure.errorMessage !== undefined ? { message: failure.errorMessage } : {}),
            provider,
            modelId: model.id,
            now: now(),
          });

    if (verdict.kind === "none") {
      // Not the credential's fault (a transient 429, a 5xx, an abort): Pi's
      // own retry owns it. Surface this attempt's failure as it came.
      attributeTo(row)(failure);
      for (const event of outcome.events) out.push(event);
      out.end(failure);
      return;
    }
    failureVerdicts.push(verdict.kind);
    first ??= { events: outcome.events, error: failure, row };

    if (verdict.kind === "auth_401" && row.type === "oauth" && !refreshed.has(row.id)) {
      // Same row, once: an expired token is renewed rather than abandoned.
      // The refresh replay does not count against the cap: the cap bounds rows.
      refreshed.add(row.id);
      if (await store.expireAccessToken(row.id, options?.signal)) {
        attempts -= 1;
        continue;
      }
    }

    const at = now();
    if (verdict.kind === "invalidated") {
      store.softDisable(row.id, INVALIDATED_CAUSE);
    } else if (verdict.kind === "refresh_failed") {
      store.recordCooldown(row.id, at + REFRESH_FAILURE_COOLDOWN_MS, verdict.kind);
    } else {
      const until =
        verdict.kind === "usage_limit" && verdict.resetAtMs !== undefined && verdict.resetAtMs > at
          ? verdict.resetAtMs
          : at + DEFAULT_COOLDOWN_MS;
      store.recordCooldown(row.id, until, verdict.kind);
      // Ticket 09, plan D2: the cooldown above is recorded first; the usage
      // report may then extend it to the exhausted window's reset. The replay
      // below does not wait for that fetch.
      if (verdict.kind === "usage_limit" && row.type === "oauth") {
        store.extendCooldownFromUsage(row.id, provider, { baseUrl: model.baseUrl, modelId: model.id });
      }
    }

    const next = attempts >= cap ? undefined : store.selectForRequest(provider, sessionId, tried, now(), model.id);
    if (next === undefined) break;
    opts.onRotation?.({ provider, fromLabel: row.label, toLabel: next.label, reason: verdict.kind });
    row = next;
  }

  // Every credential that could serve has failed: report what actually went wrong first.
  const AUTH_KINDS = new Set<FailureKind>(["auth_401", "forbidden", "invalidated", "refresh_failed"]);
  const allAuthFailures = failureVerdicts.length > 0 && failureVerdicts.every((k) => AUTH_KINDS.has(k));
  if (allAuthFailures && first !== undefined) {
    const originalMsg = first.error.errorMessage ?? "";
    first.error.errorMessage = formatAuthenticationFailure(provider, attemptedLabels, originalMsg);
  }

  attributeTo(first!.row)(first!.error);
  for (const event of first!.events) out.push(event);
  out.end(first!.error);
}
