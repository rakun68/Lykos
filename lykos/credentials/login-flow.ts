// The login flow `lykos login` and the TUI's `/login` share (P14.6 ticket 06,
// plan D5; P14.1 ticket 02 wrote it inside `cli/login.ts`).
//
// Login puts a credential into the provider's pool in the Lykos credential db:
// an API key source (`--api-key`), or the result of Pi's own OAuth flow, run
// against an in-memory capture store so Pi cannot write it anywhere else. The
// caller supplies the surface: where lines go, how an answer is read (a secret
// is read masked), and how a URL is opened. Output names labels only: no key,
// token, or resolved key source reaches either line sink or a thrown message.
//
// It lives here, not in `cli/`, because the TUI may not import `cli/`
// (`rearchitecture/dependency-scan.ts`, rule `no-domain-imports-cli`).

import { spawn } from "node:child_process";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { CredentialStore, LykosModelRuntimeOptions } from "../session/model-runtime.js";
import { openCredentialDb } from "./db.js";
import { type Credential, listEnabled, upsertCredential } from "./pool.js";
import { isOpenableUrl, openUrl } from "../tui/open-url.js";

type AuthInteraction = Parameters<ModelRuntime["login"]>[2];
type AuthPrompt = Parameters<AuthInteraction["prompt"]>[0];
type AuthEvent = Parameters<AuthInteraction["notify"]>[0];

/** The runtime surface login needs; `createLykosModelRuntime`'s result satisfies it. */
export type LoginRuntime = Pick<ModelRuntime, "login"> & { getProvider?: ModelRuntime["getProvider"] };

export interface LoginAsk {
  /** The question, without a trailing `: `. */
  prompt: string;
  /** A secret is read without echo (CLI) or masked (TUI). */
  secret: boolean;
  /**
   * The prompt may be left unprinted when input is not interactive: the CLI
   * reads an API key from piped stdin without asking for it.
   */
  optionalPrompt?: boolean;
  signal?: AbortSignal;
}

export interface LoginSurface {
  /** Credential db path. */
  dbPath: string;
  /** One result line (the success line). No trailing newline. */
  out(line: string): void;
  /** One diagnostic line: the sanction warning, flow messages, errors. No trailing newline. */
  err(line: string): void;
  /** Read one answer; undefined at end of input. May reject (cancelled, aborted). */
  ask(q: LoginAsk): Promise<string | undefined>;
  /** Open an auth URL. The URL has already been printed through `err`. */
  openBrowser(url: string): void;
  /** Builds the runtime whose OAuth flow runs. */
  createRuntime(opts: LykosModelRuntimeOptions): Promise<LoginRuntime>;
}

/** Opens an auth URL in the platform browser. `rundll32` on Windows because `cmd /c start` splits an OAuth URL at its first `&`. */
export function openAuthUrl(url: string): void {
  if (!isOpenableUrl(url)) return;
  if (process.platform === "win32") {
    try {
      const child = spawn("rundll32", ["url.dll,FileProtocolHandler", url], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => {});
      child.unref();
    } catch {
      // Best effort: the URL is already printed.
    }
    return;
  }
  openUrl(url);
}

/** Only OpenRouter's sanction for third-party use has been confirmed. */
const SANCTIONED_PROVIDERS = new Set(["openrouter"]);

/** The one-line warning shown before the first login to an unsanctioned provider. */
export function sanctionWarning(provider: string): string {
  return `lykos: warning — ${provider}'s sanction for third-party use is unverified; the account may be exposed to vendor enforcement.`;
}

/** The source of Anthropic's statement. */
export const ANTHROPIC_PROHIBITION_URL = "https://code.claude.com/docs/en/legal-and-compliance";
/** Anthropic's statement, quoted verbatim from that page. */
export const ANTHROPIC_PROHIBITION_QUOTE =
  "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials on behalf of their users.";

/**
 * The warning printed before every Anthropic OAuth login (ticket 15, plan D4):
 * Anthropic prohibits this login outright, which is more than "unverified".
 */
export function anthropicProhibitionWarning(): string {
  return [
    `lykos: warning — Anthropic prohibits this login. Its legal and compliance page (${ANTHROPIC_PROHIBITION_URL}) says:`,
    `  "${ANTHROPIC_PROHIBITION_QUOTE}"`,
    "  Anthropic may enforce this without prior notice; the account you sign in with may be suspended.",
  ].join("\n");
}

/**
 * Masks anything shaped like a token in a message from Pi before it is
 * printed: a JWT, or an unbroken run of 32+ token characters.
 */
export function redactTokens(message: string): string {
  return message
    .replace(/[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, "[redacted]")
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, "[redacted]");
}

function enabledCount(dbPath: string, provider: string): number {
  const db = openCredentialDb(dbPath, { create: false });
  if (db === undefined) return 0;
  try {
    return listEnabled(db, provider).length;
  } finally {
    db.close();
  }
}

/** Upsert into the Lykos db and report the one success line. */
function storeCredential(surface: LoginSurface, provider: string, credential: Credential): void {
  const db = openCredentialDb(surface.dbPath, { create: true })!;
  try {
    const { row, inserted } = upsertCredential(db, provider, credential);
    const n = listEnabled(db, provider).length;
    surface.out(`${inserted ? "logged in to" : "updated"} ${provider} as ${row.label} (${n} credential(s) in pool)`);
  } finally {
    db.close();
  }
}

/** An in-memory store for Pi's login flow: whatever Pi persists lands here and nowhere else. */
function captureStore(): { store: CredentialStore; captured: () => Credential | undefined } {
  const held = new Map<string, Credential>();
  let last: Credential | undefined;
  const store: CredentialStore = {
    async read(providerId) {
      return held.get(providerId);
    },
    async list() {
      return [...held.entries()].map(([providerId, c]) => ({ providerId, type: c.type }));
    },
    async modify(providerId, fn) {
      const next = await fn(held.get(providerId));
      if (next !== undefined) {
        held.set(providerId, next);
        last = next;
      }
      return next ?? held.get(providerId);
    },
    async delete(providerId) {
      held.delete(providerId);
    },
  };
  return { store, captured: () => last };
}

function interactionFor(surface: LoginSurface): AuthInteraction {
  return {
    async prompt(p: AuthPrompt): Promise<string> {
      const signal = p.signal;
      if (p.type === "select") {
        surface.err(p.message);
        p.options.forEach((o, i) => {
          surface.err(`  ${i + 1}. ${o.label}${o.description !== undefined ? ` — ${o.description}` : ""}`);
        });
        const answer = (await surface.ask({ prompt: "choice", secret: false, ...(signal !== undefined ? { signal } : {}) }))?.trim();
        if (answer === undefined) throw new Error("no answer");
        const byIndex = p.options[Number(answer) - 1];
        const byId = p.options.find((o) => o.id === answer);
        const chosen = byId ?? byIndex;
        if (chosen === undefined) throw new Error("no such option");
        return chosen.id;
      }
      const hint = p.placeholder !== undefined ? ` (${p.placeholder})` : "";
      const answer = await surface.ask({
        prompt: `${p.message}${hint}`,
        secret: p.type === "secret",
        ...(signal !== undefined ? { signal } : {}),
      });
      if (answer === undefined) throw new Error("no answer");
      return answer.trim();
    },
    notify(event: AuthEvent): void {
      switch (event.type) {
        case "auth_url":
          surface.err(`open this URL to sign in:\n  ${event.url}`);
          if (event.instructions !== undefined) surface.err(event.instructions);
          surface.openBrowser(event.url);
          return;
        case "device_code":
          surface.err(`visit ${event.verificationUri} and enter the code ${event.userCode}`);
          surface.openBrowser(event.verificationUri);
          return;
        case "info":
        case "progress":
          surface.err(event.message);
          if (event.type === "info") {
            for (const link of event.links ?? []) {
              surface.err(`  ${link.url}${link.label !== undefined ? ` (${link.label})` : ""}`);
            }
          }
          return;
      }
    },
  };
}

/**
 * Log in to `provider`: an API key source when `apiKey`, else the provider's
 * OAuth flow. Returns the process-style exit code (0 stored, 1 not).
 * `usage` names the command in the "no OAuth login" hint.
 */
export async function runLoginFlow(
  provider: string,
  apiKey: boolean,
  surface: LoginSurface,
  usage: { command: string } = { command: "lykos login" },
): Promise<number> {
  const warn = (): void => {
    if (!SANCTIONED_PROVIDERS.has(provider) && enabledCount(surface.dbPath, provider) === 0) {
      surface.err(sanctionWarning(provider));
    }
  };
  const noOAuth = (): void =>
    surface.err(`lykos login: ${provider} has no OAuth login; use \`${usage.command} ${provider} --api-key\``);

  if (apiKey) {
    warn();
    const source = (
      await surface.ask({ prompt: `${provider} API key, $VAR or !command`, secret: true, optionalPrompt: true })
    )?.trim();
    if (source === undefined || source.length === 0) {
      surface.err("lykos login: no API key given");
      return 1;
    }
    storeCredential(surface, provider, { type: "api_key", key: source });
    return 0;
  }

  const capture = captureStore();
  const runtime = await surface.createRuntime({ credentials: capture.store });
  if (runtime.getProvider !== undefined) {
    const known = runtime.getProvider(provider);
    if (known === undefined) {
      surface.err(`lykos login: unknown provider "${provider}"`);
      return 1;
    }
    if (known.auth.oauth?.login === undefined) {
      noOAuth();
      return 1;
    }
  }

  // Plan D4: Anthropic's OAuth login is prohibited by Anthropic, so it is
  // warned about before every login, not only the first.
  if (provider === "anthropic") surface.err(anthropicProhibitionWarning());
  else warn();
  let returned: Credential;
  try {
    returned = await runtime.login(provider, "oauth", interactionFor(surface));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/does not support oauth login/i.test(message)) noOAuth();
    else surface.err(`lykos login: ${provider} OAuth login failed: ${redactTokens(message)}`);
    return 1;
  }

  const credential = capture.captured() ?? returned;
  if (credential.type !== "oauth") {
    surface.err(`lykos login: ${provider}'s login returned no OAuth credential`);
    return 1;
  }
  storeCredential(surface, provider, credential);
  return 0;
}
