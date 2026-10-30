// The context strategy: the one setting that decides what a session does as its
// context window fills (GLOSSARY.md, "Context strategy").
//
//   self-compact  the agent writes its own note to self and compacts (the
//                 default; `lykos-self-compact`, T151 and T152).
//   continue      `lykos-continuation` stops the session at
//                 `compaction.threshold` and the owner starts a successor from
//                 disk (T109).
//   pi            nothing of Lykos's; Pi's own threshold compaction decides.
//
// **Exactly one runs** (story 36). This module is the only place that turns
// the declared value into the active one, and every mechanism asks it: a
// strategy that is not active leaves its extension loaded and inert. **Pi's
// compaction is underneath every value** (story 38) — nothing here turns it
// off, so a strategy that fails or never fires still ends in Pi compacting
// rather than in the wall.
//
// A strategy whose default extension is not loaded cannot run, so it resolves
// to `pi` and says so. T152 finished `self-compact` (the handoff), so it no
// longer falls back to `pi` for being unbuilt; it still does below the
// smallest tier (boot decides that, from the model's window).

export type ContextStrategy = "self-compact" | "continue" | "pi";

export const CONTEXT_STRATEGIES: readonly ContextStrategy[] = ["self-compact", "continue", "pi"];

/** The shipped value (spec story 37). */
export const DEFAULT_CONTEXT_STRATEGY: ContextStrategy = "self-compact";

/** The default extension that carries each Lykos strategy; `pi` needs none. */
export const STRATEGY_EXTENSION: Readonly<Record<Exclude<ContextStrategy, "pi">, string>> = {
  "self-compact": "lykos-self-compact",
  continue: "lykos-continuation",
};

export interface ResolvedContextStrategy {
  /** What configuration asked for, verbatim (an unknown value is kept so the note can quote it). */
  declared: string;
  /** What actually runs in this session. Exactly one. */
  active: ContextStrategy;
  /** Set whenever `active` differs from `declared`: the one line the session prints. */
  note?: string;
}

export function isContextStrategy(value: unknown): value is ContextStrategy {
  return typeof value === "string" && (CONTEXT_STRATEGIES as readonly string[]).includes(value);
}

/**
 * The active strategy for a session.
 *
 * @param declared `context_strategy` as resolved from configuration.
 * @param loadedExtensions names of the Pi extensions this session declares.
 */
export function resolveContextStrategy(
  declared: string | undefined,
  loadedExtensions: readonly string[],
): ResolvedContextStrategy {
  const value = declared ?? DEFAULT_CONTEXT_STRATEGY;
  if (!isContextStrategy(value)) {
    return {
      declared: value,
      active: "pi",
      note:
        `lykos: context_strategy "${value}" is not one of ${CONTEXT_STRATEGIES.join(", ")}; ` +
        `Pi's own compaction is in charge this session`,
    };
  }
  if (value === "pi") return { declared: value, active: "pi" };
  const extension = STRATEGY_EXTENSION[value];
  if (!loadedExtensions.includes(extension)) {
    return {
      declared: value,
      active: "pi",
      note: `lykos: context_strategy ${value} needs the ${extension} extension, which is not declared; Pi's own compaction is in charge this session`,
    };
  }
  return { declared: value, active: value };
}
