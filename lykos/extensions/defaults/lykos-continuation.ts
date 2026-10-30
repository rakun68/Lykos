// P4 T150 — `lykos-continuation`, the `continue` context strategy as a default
// extension.
//
// Continuation (T109) stops a session at a measured share of its context window
// and lets the session owner start a successor from what is on disk (the task
// list, the checkpoint, the gate command) rather than from a summary. The
// threshold watch used to be a branch inside the `lykos-harness` inline
// extension; it is now this Pi extension, shipped in Lykos's package, declared
// in the shipped `extensions:` list, and removed by writing that list without
// it (GLOSSARY.md, "Default extension").
//
// **Public Pi API only** (spec story 26) — the same calls Pi's own
// `examples/extensions/trigger-compact.ts` uses to watch the window:
// `turn_end` with `ctx.getContextUsage()`, then `ctx.abort()` and
// `pi.appendEntry` to record the crossing. `turn_end` is the last safe point
// before Pi's next provider request and before its own threshold compaction.
//
// **What it does not do.** It never decides whether a successor may start —
// the gate, the task list and the cap decide that in the session owner
// (`loop/continuation.ts` `decideContinuation`), because an extension cannot
// start a session. And it never turns Pi's compaction off: that stays
// underneath as the last resort (spec story 38).
//
// **Its setting is `context_strategy: continue`**, carried in by
// `CONTINUATION_POLICY_ENV`, which boot sets from the resolved configuration
// before Pi loads extensions (`loop/context-strategy.ts` decides). Any other
// strategy loads it inert. Loaded outside Lykos, with no policy in the
// environment, it does nothing — there is no owner to start a successor.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CONTINUATION_ENTRY_TYPE,
  CONTINUATION_POLICY_ENV,
  decodeContinuationPolicyEnv,
  type ContinuationCrossing,
} from "../../loop/continuation.js";

export default function lykosContinuation(pi: ExtensionAPI): void {
  // Read once, at load: a later session in the same process sets its own.
  const policy = decodeContinuationPolicyEnv(process.env[CONTINUATION_POLICY_ENV]);
  if (policy === null || !policy.enabled) return;
  let crossed = false;

  pi.on("turn_end", (_event, ctx) => {
    if (crossed) return;
    const usage = ctx.getContextUsage();
    if (usage === undefined || usage.tokens === null) return;
    const contextWindow = usage.contextWindow > 0 ? usage.contextWindow : (ctx.model?.contextWindow ?? 0);
    if (contextWindow <= 0 || usage.tokens / contextWindow < policy.threshold) return;
    crossed = true;
    const crossing: ContinuationCrossing = { tokens: usage.tokens, contextWindow };
    pi.appendEntry(CONTINUATION_ENTRY_TYPE, crossing);
    ctx.abort();
  });
}
