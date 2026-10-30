// `/login`, `/credential` and the rotation notice for the interactive surfaces.
// Both render modes build theirs here, so the two cannot drift. The work itself
// is not here: `/login` runs the flow `lykos login` runs
// (`credentials/login-flow.ts`) and `/credential` reads and pins through
// `credentials/session-pool.ts`. This file only adapts them to a line printer
// and the session's line source.

import type { ResolvedConfig } from "../config/types.js";
import { defaultCredentialDbPath } from "../credentials/db.js";
import { openAuthUrl, runLoginFlow } from "../credentials/login-flow.js";
import { formatRotationNotice } from "../credentials/rotate.js";
import {
  describeSessionPool,
  formatSessionPool,
  pinSessionCredential,
  unpinSessionCredential,
} from "../credentials/session-pool.js";
import type { TuiLoginIO } from "../session/interactive.js";
import { createLykosModelRuntime, type RotationRelay } from "../session/model-runtime.js";

export interface CredentialCommandsOptions {
  /** The running session: its id keys the pin, its model names the provider. */
  session: { readonly sessionId: string; readonly model?: { provider: string } | undefined };
  config: ResolvedConfig;
  /** Defaults to `defaultCredentialDbPath()` (`LYKOS_CREDENTIALS_DB` or `~/.lykos/credentials.db`). */
  dbPath?: string;
  /** Opens an auth URL. Defaults to the platform browser. */
  openBrowser?: (url: string) => void;
  /** Builds the runtime whose OAuth flow runs. Defaults to `createLykosModelRuntime`. */
  createRuntime?: Parameters<typeof runLoginFlow>[2]["createRuntime"];
}

export interface CredentialCommands {
  login: (provider: string, apiKey: boolean, io: TuiLoginIO) => Promise<void>;
  credential: (arg: string) => string;
}

export function createCredentialCommands(opts: CredentialCommandsOptions): CredentialCommands {
  const dbPath = (): string => opts.dbPath ?? defaultCredentialDbPath();
  const provider = (): string | undefined => opts.session.model?.provider;
  const fallback = (id: string): boolean => opts.config.providers[id]?.fallbackToApiKey === true;

  return {
    login: async (providerId, apiKey, io) => {
      let warnedUnmasked = false;
      await runLoginFlow(
        providerId,
        apiKey,
        {
          dbPath: dbPath(),
          out: io.write,
          err: io.write,
          ask: async (q) => {
            if (q.secret && !io.masks && !warnedUnmasked) {
              warnedUnmasked = true;
              io.write("lykos: this surface cannot mask input; a $VAR or !command source keeps the secret off the screen");
            }
            io.write(`${q.prompt}:`);
            const line = await io.read(q.secret);
            return line ?? undefined;
          },
          openBrowser: opts.openBrowser ?? openAuthUrl,
          createRuntime: opts.createRuntime ?? createLykosModelRuntime,
        },
        { command: "/login" },
      );
    },
    credential: (arg) => {
      const id = provider();
      if (id === undefined) return "lykos: this session has no model, so no provider to list credentials for";
      const trimmed = arg.trim();
      const input = { dbPath: dbPath(), sessionId: opts.session.sessionId, provider: id, fallbackToApiKey: fallback(id) };
      if (trimmed.length === 0) return formatSessionPool(id, describeSessionPool(input));
      if (trimmed === "auto") return unpinSessionCredential(input).message;
      const pinned = pinSessionCredential({ ...input, label: trimmed });
      return pinned.ok ? pinned.message : `lykos: ${pinned.message}`;
    },
  };
}

/** Show the one-line rotation notice through `write` for every rotation the relay carries. */
export function showRotationNotices(relay: RotationRelay | undefined, write: (line: string) => void): () => void {
  if (relay === undefined) return () => {};
  return relay.on((event) => write(formatRotationNotice(event)));
}
