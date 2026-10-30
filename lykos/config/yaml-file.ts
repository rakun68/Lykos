// A tiny shared reader, split out of `load.ts` so `config/specialists.ts` can
// parse a specialist file without importing the config-layer module (and
// risking a cycle back into it) — both call the same lazy `yaml` import.
//
// T27.2's reasoning for the lazy require applies here unchanged: `yaml`
// costs real import time and must not be paid until a file on disk actually
// needs parsing.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let cachedParseYaml: ((input: string) => unknown) | undefined;

function lazyParseYaml(raw: string): unknown {
  if (!cachedParseYaml) {
    const req = createRequire(import.meta.url);
    cachedParseYaml = (req("yaml") as { parse: (input: string) => unknown }).parse;
  }
  return cachedParseYaml(raw);
}

export function parseYaml(raw: string): unknown {
  return lazyParseYaml(raw);
}

/**
 * Parse `path` as YAML into a plain object. `{}` for an empty file. Throws
 * when the file does not parse to an object — a list or a scalar at the top
 * level is never a valid config or specialist file.
 */
export function readYamlObjectFile(path: string): Record<string, unknown> {
  const raw = readFileSync(path, "utf8");
  const parsed = lazyParseYaml(raw);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`lykos: ${path} did not parse to an object`);
  }
  return parsed as Record<string, unknown>;
}
