// The segment registry (docs/07-ui-and-hud.md §6): format strings are over
// named segments; each segment is ViewModel → StyledSpan[]. An unknown name
// in a format is a loud config error at load, never a silently empty string.

import type { ResolvedTheme } from "../theme/resolve.js";
import type { ViewModel } from "../types.js";

/** Already-styled text. The registry never emits raw colour names. */
export type StyledSpan = string;

export interface SegmentContext {
  theme: ResolvedTheme;
  width: number;
  /** Optional extras statusline/hud pass through (parent model name, etc.). */
  meta?: {
    parentModelName?: string | null;
    delegateModelName?: string | null;
    delegateCalls?: number;
  };
}

export type SegmentFn = (vm: ViewModel, ctx: SegmentContext) => StyledSpan[];

const registry = new Map<string, SegmentFn>();

export function registerSegment(name: string, fn: SegmentFn): void {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    throw new Error(`lykos segments: invalid segment name "${name}" (expected [a-z][a-z0-9_]*)`);
  }
  registry.set(name, fn);
}

export function listSegmentNames(): string[] {
  return [...registry.keys()].sort();
}

/** Test-only: drop every registration so a suite can re-register builtins. */
export function clearSegmentRegistry(): void {
  registry.clear();
}

/**
 * Parse a format string into literal / segment tokens. `{cost}` is a segment;
 * `{{` / `}}` escape a brace. Throws on an unclosed `{`.
 */
export function parseFormat(format: string): Array<{ kind: "literal"; text: string } | { kind: "segment"; name: string }> {
  const out: Array<{ kind: "literal"; text: string } | { kind: "segment"; name: string }> = [];
  let i = 0;
  let literal = "";
  while (i < format.length) {
    const ch = format[i]!;
    if (ch === "{" && format[i + 1] === "{") {
      literal += "{";
      i += 2;
      continue;
    }
    if (ch === "}" && format[i + 1] === "}") {
      literal += "}";
      i += 2;
      continue;
    }
    if (ch === "{") {
      if (literal) {
        out.push({ kind: "literal", text: literal });
        literal = "";
      }
      const end = format.indexOf("}", i + 1);
      if (end === -1) throw new Error(`lykos segments: unclosed "{" in format: ${JSON.stringify(format)}`);
      const name = format.slice(i + 1, end).trim();
      if (!name) throw new Error(`lykos segments: empty segment name in format: ${JSON.stringify(format)}`);
      out.push({ kind: "segment", name });
      i = end + 1;
      continue;
    }
    literal += ch;
    i += 1;
  }
  if (literal) out.push({ kind: "literal", text: literal });
  return out;
}

/**
 * Validate every `{name}` in a format against the registry. Loud on unknown
 * names — "a status line that quietly drops the cost segment because of a
 * typo is the exact failure this project cannot afford."
 */
export function validateFormat(format: string): void {
  for (const tok of parseFormat(format)) {
    if (tok.kind !== "segment") continue;
    if (!registry.has(tok.name)) {
      throw new Error(
        `lykos segments: unknown segment "{${tok.name}}" in format ${JSON.stringify(format)}. ` +
          `Known: ${listSegmentNames().join(", ") || "(none registered)"}`,
      );
    }
  }
}

/** Render a validated format string. Call validateFormat at config load. */
export function renderFormat(format: string, vm: ViewModel, ctx: SegmentContext): string {
  const parts: string[] = [];
  for (const tok of parseFormat(format)) {
    if (tok.kind === "literal") {
      parts.push(tok.text);
      continue;
    }
    const fn = registry.get(tok.name);
    if (!fn) {
      throw new Error(`lykos segments: unknown segment "{${tok.name}}" (validateFormat was not called)`);
    }
    parts.push(...fn(vm, ctx));
  }
  return parts.join("");
}
