// T188 -- `lykos-prune`, the read-supersession and useless-result prune as a
// default extension (ADR-0035, ADR-0028, ADR-0039).
//
// On each model request it overwrites the prunes already recorded in the copy
// of the messages Pi is about to send, decides new ones by the rules in
// `loop/tool-result-prune.ts`, and persists each decision as a `lykos-prune`
// custom entry (`pi.appendEntry`; a custom entry never reaches the model). It
// registers no tool, so the hop-0 schema is unchanged, and it touches nothing
// of Pi's own history (AGENTS.md rule 7).
//
// **Its switch is its entry in `extensions:`** -- listed, it loads; unlisted, it
// does not. `compaction.supersede_reads` and `compaction.drop_useless` choose
// which rules run; they are carried in by `PRUNE_POLICY_ENV`, which boot sets
// from the resolved configuration before Pi loads extensions. Loaded outside
// Lykos, with no policy in the environment, it does nothing.
//
// **Public Pi API only:** `context` and `pi.appendEntry`, and
// `ctx.sessionManager.getBranch()` to read the records back.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  applyPrunes,
  DEFAULT_SUFFIX_TOKEN_LIMIT,
  decodePrunePolicyEnv,
  idleFlushMs,
  planPrunes,
  PRUNE_ENTRY_TYPE,
  PRUNE_POLICY_ENV,
  pruneMap,
  pruneRecordsFromEntries,
  type PrunePolicyEnv,
} from "../../loop/tool-result-prune.js";

/** The clock and environment, injectable so a test need not wait out a cache retention. */
export interface PruneDeps {
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
}

export function installPrune(pi: ExtensionAPI, policy: PrunePolicyEnv, deps: PruneDeps = {}): void {
  pi.on("context", (event, ctx) => {
    const prior = pruneMap(pruneRecordsFromEntries(ctx.sessionManager.getBranch()));
    applyPrunes(event.messages, prior);
    const plan = planPrunes(
      event.messages,
      prior,
      {
        ...policy,
        suffixTokenLimit: DEFAULT_SUFFIX_TOKEN_LIMIT,
        idleFlushMs: idleFlushMs(deps.env ?? process.env, ctx.model?.api),
      },
      deps.now?.() ?? Date.now(),
    );
    if (plan !== undefined) {
      applyPrunes(event.messages, pruneMap([plan.record]));
      pi.appendEntry(PRUNE_ENTRY_TYPE, plan.record);
    }
    if (prior.size === 0 && plan === undefined) return undefined;
    return { messages: event.messages };
  });
}

export default function lykosPrune(pi: ExtensionAPI): void {
  // Read once, at load: a later session in the same process sets its own.
  const policy = decodePrunePolicyEnv(process.env[PRUNE_POLICY_ENV]);
  if (policy === null) return;
  installPrune(pi, policy);
}
