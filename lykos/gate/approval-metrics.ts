// Approval friction, counted rather than felt.
//
// **This is what makes T107 a mechanism rather than a refactor.** A tier
// table nobody can count is a rename; this counts every gate decision by
// the tier it was made from, so "what is this agent actually allowed to do"
// has a data answer.
//
// **The breakdown is by tier AND by mode, and the second half is not
// optional.** An approval count that cannot tell Manual (which asks before
// everything, by definition) from Auto (which asks before almost nothing)
// measures the maintainer's own mode choice and reports it as a property of
// the agent. Both breakdowns come off the same decisions, so they always
// agree on the totals.
//
// **Three outcomes, deliberately not two.** A prompt the human declined and
// an action the MODE refused without asking are different events, and
// folding them together would inflate the friction number with the policy
// doing exactly its job — Plan mode denying a write is not friction, it is
// Plan mode. So:
//
//   - `requested`   a prompt was put in front of a human (verdict `ask`).
//                   This is the friction number.
//   - `denied`      the human answered no to one of those. A subset of
//                   `requested`.
//   - `autoDenied`  the mode refused outright, with nobody asked.
//   - `allowed`     the mode permitted it with no prompt.
//
// Every counter here is a plain integer incremented by the gate. Nothing is
// derived, nothing is a rate, and this module never sees a command.

import type { InteractionMode, ModeVerdict } from "./modes.js";
import { INTERACTION_MODES } from "./modes.js";
import { RISK_TIERS, type RiskTier } from "../tools/tool-risk.js";

export interface ApprovalTally {
  requested: number;
  denied: number;
  autoDenied: number;
  allowed: number;
}

function emptyTally(): ApprovalTally {
  return { requested: 0, denied: 0, autoDenied: 0, allowed: 0 };
}

/**
 * Session-scoped, in memory, handed to the ledger at session end — the same
 * shape as `DenialLog` in `approval.ts`, which counts a narrower thing (a
 * refusal as a human intervention) and is deliberately left alone.
 */
export class ApprovalMetrics {
  private readonly tiers = new Map<RiskTier, ApprovalTally>();
  private readonly modes = new Map<InteractionMode, ApprovalTally>();

  private tally(tier: RiskTier, mode: InteractionMode): ApprovalTally[] {
    let t = this.tiers.get(tier);
    if (t === undefined) {
      t = emptyTally();
      this.tiers.set(tier, t);
    }
    let m = this.modes.get(mode);
    if (m === undefined) {
      m = emptyTally();
      this.modes.set(mode, m);
    }
    return [t, m];
  }

  /** Every gate decision, as the policy made it. Called once per gated action. */
  record(mode: InteractionMode, tier: RiskTier, verdict: ModeVerdict): void {
    const field = verdict === "ask" ? "requested" : verdict === "deny" ? "autoDenied" : "allowed";
    for (const tally of this.tally(tier, mode)) tally[field] += 1;
  }

  /**
   * The human answered no to a prompt this session already counted as
   * `requested`. Kept separate from `record` because the verdict that
   * produced the prompt is known at a different moment from the answer.
   */
  recordHumanDenial(mode: InteractionMode, tier: RiskTier): void {
    for (const tally of this.tally(tier, mode)) tally.denied += 1;
  }

  get totals(): ApprovalTally {
    const out = emptyTally();
    // Summed over TIERS rather than modes; the two are the same decisions
    // counted twice, so either works and summing both would double.
    for (const t of this.tiers.values()) {
      out.requested += t.requested;
      out.denied += t.denied;
      out.autoDenied += t.autoDenied;
      out.allowed += t.allowed;
    }
    return out;
  }

  /** JSON keyed by tier, in `RISK_TIERS` order, omitting tiers nothing reached. */
  serializeByTier(): string {
    const out: Record<string, ApprovalTally> = {};
    for (const tier of RISK_TIERS) {
      const t = this.tiers.get(tier);
      if (t !== undefined) out[tier] = t;
    }
    return JSON.stringify(out);
  }

  /** JSON keyed by interaction mode, in `INTERACTION_MODES` order, omitting modes the session never used. */
  serializeByMode(): string {
    const out: Record<string, ApprovalTally> = {};
    for (const mode of INTERACTION_MODES) {
      const m = this.modes.get(mode);
      if (m !== undefined) out[mode] = m;
    }
    return JSON.stringify(out);
  }
}
