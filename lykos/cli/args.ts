/**
 * Flags on `lykos run` that consume the argument after them. Kept beside the
 * parser so a new `--flag value` cannot silently start eating the prompt.
 */
export const RUN_VALUED_FLAGS = ["model", "tools", "budget", "shape", "task", "specialist", "containment", "network", "mode", "output-style"] as const;

/**
 * T90: the first argument that is neither a flag nor a flag's value.
 *
 * Found by the Phase 15 sweep, running real work through `lykos run`. The
 * prompt used to be `rest[0]` — whatever came first, flag or not — so
 * `lykos run --shape standalone "do the thing"` sent the literal string
 * `--shape` to the model as the task. It cost real money, burned six turns
 * of a confused model reading the repo to work out what `--shape` meant, and
 * gave no indication anything was wrong: a flag IS a valid prompt, so
 * nothing could have failed loudly.
 *
 * `valued` names the flags that consume the argument after them, so
 * `--model deepseek/x` does not offer `deepseek/x` as the prompt.
 */
export function firstPositional(args: readonly string[], valued: readonly string[]): string | undefined {
  const consumesNext = new Set(valued.map((n) => `--${n}`));
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return args[i + 1];
    if (arg.startsWith("--")) {
      // `--name=value` carries its value inline and consumes nothing.
      if (!arg.includes("=") && consumesNext.has(arg)) i += 1;
      continue;
    }
    return arg;
  }
  return undefined;
}

export const SPECIALIST_VALUED_FLAGS = ["context"] as const;

/** Arguments that are neither a flag nor a flag's value, in order. */
export function positionals(args: readonly string[], valueFlags: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      // `--flag=value` carries its own value;
      // `--flag value` eats the next.
      if (!name.includes("=") && valueFlags.includes(name)) i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}
