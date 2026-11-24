// T131's interaction modes, applied in front of whatever gate asks the human. The policy is `decideForMode`
// (gate/modes.ts); this class holds the session's live mode and remembered approvals, refuses or allows what
// the mode settles, and hands the rest to the asking gate. It renders nothing: the asker owns the prompt.
//
// P5 #55: this was the policy half of the old full-screen surface's `RawApprovalGate`. The engine server's
// session child wraps its `TerminalApprovalGate` in it, so `/mode` works in lykos-tui.

import type { ApprovalMetrics } from "./approval-metrics.js";
import type { ApprovalDecision, ApprovalGate, ApprovalRequest } from "./approval.js";
import { DEFAULT_INTERACTION_MODE, decideForMode, type GatedAction, type InteractionMode, type ModeDecision } from "./modes.js";

export interface ModeGateOptions {
  /** Counted by tier and by mode. Omitted, the session records NULL: no gate counted anything. */
  metrics?: ApprovalMetrics;
  /** A request the mode refused outright, with the reason, so the refusal is never silent. */
  onDenied?: (req: ApprovalRequest, reason: string) => void;
  /** The human answered "always": remember these command patterns. Never called for a destructive command. */
  onRemember?: (patterns: readonly string[]) => void;
}

/** The mode's request as `decideForMode` reads it. A `powershell` request is `kind: "bash"` with `shell` set. */
function actionOf(req: ApprovalRequest): GatedAction {
  if (req.kind !== "bash") return { kind: req.kind };
  return req.shell === "powershell" ? { kind: "powershell" } : { kind: "bash", command: req.detail };
}

export class ModeGate implements ApprovalGate {
  private current: InteractionMode = DEFAULT_INTERACTION_MODE;
  private allowlist: ReadonlySet<string> = new Set();
  verifyCommand?: string | undefined;

  /** `asker` is deliberately not `inner`: `unwrapGate` must stop here, where the mode is. */
  constructor(
    private readonly asker: ApprovalGate,
    private readonly opts: ModeGateOptions = {},
  ) {}

  get mode(): InteractionMode {
    return this.current;
  }

  setMode(mode: InteractionMode): void {
    this.current = mode;
  }

  /** Replace the remembered approvals, e.g. after one is added by answering "always". */
  setAllowlist(allow: ReadonlySet<string>): void {
    this.allowlist = allow;
  }

  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    let decision: ModeDecision = decideForMode(this.current, actionOf(req), this.allowlist, { verifyCommand: this.verifyCommand });
    // T210/T211: a path rule's ask reaches the person in every mode. A mode's allow (Auto's, or a remembered
    // command approval) becomes a prompt that offers no "always". A protected path asks in every mode.
    if (req.pathAsk !== undefined && (decision.verdict === "allow" || req.pathAsk.protected)) {
      decision = { ...decision, verdict: "ask", offerAlways: false, patterns: [] };
    }
    this.opts.metrics?.record(this.current, decision.tier, decision.verdict);
    if (decision.verdict === "allow") return "allow";
    if (decision.verdict === "deny") {
      this.opts.onDenied?.(req, decision.reason ?? "denied by the current interaction mode");
      return "deny";
    }
    const answer = await this.asker.request(req);
    if (answer === "deny") this.opts.metrics?.recordHumanDenial(this.current, decision.tier);
    if (answer !== "allow-always") return answer;
    // "Always" on a request the mode marked un-rememberable (a destructive command, a path ask) runs it once
    // and stores nothing: downgrading beats both refusing the answer and remembering `rm -rf`.
    if (decision.offerAlways !== true) return "allow";
    const patterns = decision.patterns ?? [];
    if (patterns.length > 0) this.opts.onRemember?.(patterns);
    return "allow-always";
  }
}
