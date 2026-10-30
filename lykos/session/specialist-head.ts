// The specialist's own head block.
//
// One function assembles every Lykos-owned system-prompt block
// (`boot.ts`'s `buildAppendSystemPromptOverride`), governed by the
// cache-stable head contract: deterministic order, computed once at boot,
// never mutated afterwards (`head-contract.ts`). This module supplies one
// more block to that function, the same way `memory-head.ts` and
// `prompt-diet.ts` already do — it does not assemble anything itself.
//
// Volatile content is rejected at config LOAD time
// (`config/specialists.ts::resolveSpecialistLayer`, using this same package's
// `detectVolatile`), before a specialist's instructions ever reach a resolved
// config, let alone a session. Nothing here re-validates that; a second,
// weaker check at injection time would only hide which layer actually
// caught the problem.
//
// **The seam ticket 03 extends.** Ticket 03 ("ponytail as the default
// system-prompt block") adds a second, always-on block that sits BEFORE this
// one, so a specialist's own text stays the last word — `boot.ts` is where that
// ordering is decided, not here.

export const SPECIALIST_HEADING = "## lykos-specialist";

/**
 * `instructions` is the resolved config's `instructions` field
 * (`ResolvedConfig.instructions`) — already merged across every layer, so
 * the caller does not need to know whether it came from a specialist, a
 * project config.yaml, or a flag. Callers only call this with non-empty
 * text; an empty block would spend tokens to say nothing (the same rule
 * `memory-head.ts` and `repo-map.ts` both follow).
 */
export function assembleSpecialistHead(instructions: string): string {
  return [SPECIALIST_HEADING, instructions].join("\n");
}
