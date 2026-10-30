// Model runtime factory.
//
// The single place in Lykos that constructs Pi's ModelRuntime. Both the
// one-shot standalone path (session.ts) and the interactive loop
// (interactive.ts) boot through this factory, providing one seam to inject
// Lykos's credential store (ticket 02), the providers Lykos implements
// (ticket 04), and credential rotation around `streamSimple` (ticket 05).

import { join } from "node:path";
import { type CreateModelRuntimeOptions, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { piHostDir } from "../config/pi-host.js";
import type { ProvidersConfig } from "../config/types.js";
import { defaultCredentialDbPath } from "../credentials/db.js";
import { LykosCredentialStore } from "../credentials/pi-store.js";
import { type RotationEvent, wrapStreamWithRotation } from "../credentials/rotate.js";
import { type BuiltinLoginOptions, registerBuiltinLogins } from "../providers/builtin-logins/register.js";
import { googleCcaProviders } from "../providers/google-cca/register.js";
import { loginProviders } from "../providers/logins.js";
import type { LykosEventSink } from "../extensions/api.js";

export type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
export type Provider = Parameters<ModelRuntime["registerNativeProvider"]>[0];
/** Pi's `ProviderConfigInput`, derived because it is not exported by name. */
export type ProviderConfigInput = Parameters<ModelRuntime["registerProvider"]>[1];

export interface LykosModelRuntimeOptions {
  /** Generated models.json path; omitted when no provider config was written. */
  modelsPath?: string;
  /**
   * Credential store to hand Pi. Omitted = Lykos's own store (ticket 02,
   * ADR-0025). Pi never falls back to `auth.json` once a store is passed.
   * Rotation wraps the runtime only when the store is a `LykosCredentialStore`.
   */
  credentials?: CredentialStore;
  /** Native providers to register once, after creation. */
  nativeProviders?: readonly Provider[];
  /**
   * Providers Lykos implements itself, registered through `registerProvider`
   * after creation (ticket 04). Omitted = `googleCcaProviders()`, the Cloud
   * Code Assist stream and Google logins. Pass `{}` to register none.
   */
  providers?: Record<string, ProviderConfigInput>;
  /**
   * Lykos's own login and refresh for Pi's builtins: `anthropic`, `openai-codex`,
   * `github-copilot`, `openrouter`, `kimi-coding` and `xai` (tickets 15 & 16):
   * the injectable deps (fetch, URLs, ports). Always registered; Pi's stream
   * and `toAuth` stay in charge.
   */
  builtinLogins?: BuiltinLoginOptions;
  /**
   * Session id for selection outside a stream call. Inside `streamSimple`
   * the session id Pi passes in `options.sessionId` wins (ticket 05).
   */
  sessionId?: string;
  /** Credential db path. Omitted = `defaultCredentialDbPath()` (`LYKOS_CREDENTIALS_DB` or `~/.lykos/credentials.db`). */
  credentialDbPath?: string;
  /**
   * `config.providers`, read for `providers.<id>.fallbackToApiKey` (ADR-0026).
   * Omitted = no provider falls back from OAuth to an API key.
   */
  providerConfig?: ProvidersConfig;
  /** Called on each credential rotation (ticket 06 renders it). Labels only, never a secret. */
  onRotation?: (event: RotationEvent) => void;
}

/**
 * The late-bound receiver for a runtime's rotation callback (ticket 06).
 *
 * The runtime is built before `boot()` creates the session's extension event
 * sink, and before a TUI surface exists, so the callback handed to
 * `createLykosModelRuntime` is this relay's `emit`; the sink and the surface
 * subscribe once they exist. A listener that throws never disturbs rotation.
 */
export class RotationRelay {
  private readonly listeners = new Set<(event: RotationEvent) => void>();

  readonly emit = (event: RotationEvent): void => {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A notice or an extension failing must not fail the request that rotated.
      }
    }
  };

  /** Subscribe; returns the unsubscribe. */
  on(listener: (event: RotationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** Fire `credential_rotated` on the session's Lykos event sink for every rotation the relay carries. */
export function forwardRotationsToSink(relay: RotationRelay, sink: LykosEventSink): () => void {
  return relay.on((event) =>
    sink.emit("credential_rotated", {
      provider: event.provider,
      from: event.fromLabel,
      to: event.toLabel,
      reason: event.reason,
    }),
  );
}

/** The only place in Lykos that builds Pi's model runtime. */
export async function createLykosModelRuntime(opts: LykosModelRuntimeOptions = {}): Promise<ModelRuntime> {
  const providerConfig = opts.providerConfig;
  const credentials =
    opts.credentials ??
    new LykosCredentialStore({
      dbPath: opts.credentialDbPath ?? defaultCredentialDbPath(),
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      fallbackToApiKey: (provider) => providerConfig?.[provider]?.fallbackToApiKey === true,
    });
  // Ticket 08 (ADR-0027): Pi defaults an omitted modelsPath to
  // getAgentDir()/models.json and keeps models-store.json beside it
  // (pi-coding-agent dist/core/model-runtime.js create()). Name the pi-host
  // here so no caller depends on PI_CODING_AGENT_DIR having been set.
  const runtime = await ModelRuntime.create({
    modelsPath: opts.modelsPath ?? join(piHostDir(), "models.json"),
    credentials,
  });

  const defaultProviders = () => ({
    ...googleCcaProviders(),
    ...loginProviders({ runtime: () => runtime }),
  });

  for (const [id, config] of Object.entries(opts.providers ?? defaultProviders())) {
    runtime.registerProvider(id, config);
  }

  // Ticket 15, plan D1: replace only login and refresh on these three builtins.
  registerBuiltinLogins(runtime, opts.builtinLogins);

  if (opts.nativeProviders !== undefined) {
    for (const provider of opts.nativeProviders) {
      runtime.registerNativeProvider(provider);
    }
  }

  if (credentials instanceof LykosCredentialStore) {
    wrapStreamWithRotation(runtime, credentials, opts.onRotation !== undefined ? { onRotation: opts.onRotation } : {});
  }

  return runtime;
}
