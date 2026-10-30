// API-key sources.
//
// A stored `api_key` row holds a source: a literal key, `$VAR` / `${VAR}`, or
// `!command`. Pi resolves `!` the same way (see `lykos/config/providers.ts`).
// An unresolvable source is treated as absent, never as an error: an error
// message is exactly where a source or its resolved value would leak.

import { execSync } from "node:child_process";

/** `$VAR` or `${VAR}`, braces balanced; the same shapes `config.yaml` accepts. */
const ENV_SOURCE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;

/** Resolve a key source. Returns undefined for an unset variable, a failed command, or an empty result. */
export function resolveKeySource(source: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envMatch = ENV_SOURCE.exec(source);
  if (envMatch) {
    const value = env[envMatch[1] ?? envMatch[2]!];
    return value !== undefined && value.length > 0 ? value : undefined;
  }

  if (source.startsWith("!")) {
    const command = source.slice(1);
    if (command.trim().length === 0) return undefined;
    try {
      const out = execSync(command, {
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
        env,
        windowsHide: true,
      })
        .toString()
        .trim();
      return out.length > 0 ? out : undefined;
    } catch {
      return undefined;
    }
  }

  return source.length > 0 ? source : undefined;
}
