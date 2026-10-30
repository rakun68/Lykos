import { defaultCredentialDbPath } from "../credentials/db.js";
import { poolSummary, summaryPoolSizes } from "../credentials/presence.js";
import { SpecialistValidationError } from "./specialists.js";
import { PROVIDER_ENV_VARS, resolveReach } from "./providers.js";
import type { ProvidersConfig } from "./types.js";

export interface ProviderUsableInput {
  provider: string;
  providers: ProvidersConfig;
  env: NodeJS.ProcessEnv;
  dbPath?: string | undefined;
  poolSizes?: Map<string, number> | undefined;
}

export interface ProviderUsableResult {
  usable: boolean;
  reason: string;
}

export interface SpecialistCredentialCheckInput {
  /** The selected specialist's name, or undefined when none was selected. */
  specialistName?: string | undefined;
  /** The provider the specialist declared, or undefined when it declared none. */
  specialistProvider?: string | undefined;
  /** The providers table from the resolved config. */
  providers: ProvidersConfig;
  /** The environment to read credential presence from. Never `process.env` directly. */
  env: NodeJS.ProcessEnv;
  /** Specialist file path if known. */
  specialistPath?: string | undefined;
  /** Pre-resolved pool sizes (provider -> count of enabled credentials) — tests only. */
  poolSizes?: Map<string, number> | undefined;
  /** Credential db path if known. */
  dbPath?: string | undefined;
}

/**
 * Decides whether a provider is usable: consults the config providers: table,
 * provider env vars, and the credential pool (enabled rows only).
 * Secret-free: reason never contains credential content.
 */
export function providerUsable(input: ProviderUsableInput): ProviderUsableResult {
  const { provider, providers, env } = input;
  const poolSizes =
    input.poolSizes ?? summaryPoolSizes(poolSummary(input.dbPath ?? defaultCredentialDbPath(env)));
  const poolSize = poolSizes.get(provider) ?? 0;

  const isConfigured = Object.prototype.hasOwnProperty.call(providers, provider);
  const isKnownBuiltin =
    Object.prototype.hasOwnProperty.call(PROVIDER_ENV_VARS, provider) ||
    provider === "github-copilot";

  if (isConfigured) {
    const decl = providers[provider];
    if (!decl || typeof decl !== "object") {
      return { usable: false, reason: "declaration is invalid" };
    }
    const { reach, reachReason } = resolveReach(provider, decl, env, poolSize);
    return {
      usable: reach !== "unreachable",
      reason: reachReason,
    };
  }

  if (isKnownBuiltin) {
    const { reach, reachReason } = resolveReach(
      provider,
      { auth: "api_key" },
      env,
      poolSize,
    );
    return {
      usable: reach !== "unreachable",
      reason: reachReason,
    };
  }

  if (poolSize > 0) {
    return {
      usable: true,
      reason: `${poolSize} credential(s) in the Lykos store`,
    };
  }

  return {
    usable: false,
    reason: "not configured",
  };
}

/** Throws SpecialistValidationError when the specialist's provider has no usable credential. */
export function assertSpecialistProviderUsable(input: SpecialistCredentialCheckInput): void {
  const { specialistName, specialistProvider, providers, env } = input;
  if (!specialistName || !specialistProvider || specialistProvider.trim().length === 0) {
    return;
  }

  const configured = Object.keys(providers).sort();
  const configuredList = configured.length > 0 ? configured.join(", ") : "(none)";
  const path = input.specialistPath ?? specialistName;

  const poolSizes =
    input.poolSizes ?? summaryPoolSizes(poolSummary(input.dbPath ?? defaultCredentialDbPath(env)));

  const isConfigured = Object.prototype.hasOwnProperty.call(providers, specialistProvider);
  if (isConfigured) {
    const decl = providers[specialistProvider]!;
    if (!decl || typeof decl !== "object") {
      throw new SpecialistValidationError(
        specialistName,
        path,
        `provider "${specialistProvider}" declaration is invalid — configured providers: ${configuredList}`,
      );
    }
  }

  const { usable, reason } = providerUsable({
    provider: specialistProvider,
    providers,
    env,
    poolSizes,
  });

  if (usable) {
    return;
  }

  const loggedIn = [...poolSizes.entries()]
    .filter(([_, count]) => count > 0)
    .map(([p]) => p)
    .sort();
  const loggedInList = loggedIn.length > 0 ? loggedIn.join(", ") : "(none)";

  const poolSize = poolSizes.get(specialistProvider) ?? 0;
  const isKnownBuiltin =
    Object.prototype.hasOwnProperty.call(PROVIDER_ENV_VARS, specialistProvider) ||
    specialistProvider === "github-copilot";

  if (!isConfigured && !isKnownBuiltin && poolSize === 0) {
    throw new SpecialistValidationError(
      specialistName,
      path,
      `provider "${specialistProvider}" is not configured — configured providers: ${configuredList} — logged-in providers: ${loggedInList}`,
    );
  }

  throw new SpecialistValidationError(
    specialistName,
    path,
    `provider "${specialistProvider}" has no usable credential (${reason}) — configured providers: ${configuredList} — logged-in providers: ${loggedInList}`,
  );
}

export interface HostProviderCheckInput {
  provider: string;
  providers: ProvidersConfig;
  env: NodeJS.ProcessEnv;
  poolSizes?: Map<string, number> | undefined;
  dbPath?: string | undefined;
}

/**
 * Throws when the host model provider has no usable credential at session start
 * when no specialist named one (P14 plan D4; user story 38).
 */
export function assertHostProviderUsable(input: HostProviderCheckInput): void {
  const { provider, providers, env } = input;
  const isConfigured = Object.prototype.hasOwnProperty.call(providers, provider);
  const isKnownBuiltin =
    Object.prototype.hasOwnProperty.call(PROVIDER_ENV_VARS, provider) ||
    provider === "github-copilot";

  const poolSizes =
    input.poolSizes ?? summaryPoolSizes(poolSummary(input.dbPath ?? defaultCredentialDbPath(env)));
  const poolSize = poolSizes.get(provider) ?? 0;

  if (!isConfigured && !isKnownBuiltin && poolSize === 0) {
    return;
  }

  const { usable, reason } = providerUsable({
    provider,
    providers,
    env,
    poolSizes,
  });

  if (!usable) {
    const cleanReason = reason.replace(/\s*—\s*run `lykos login [^`]+`/, "");
    throw new Error(
      `lykos: provider "${provider}" has no usable credential (${cleanReason}) — run \`lykos login ${provider}\``,
    );
  }
}
