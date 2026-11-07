// A delegated session's claims, judged when its result is built (T234, ADR-0059). The claims were recorded by the
// `claim` tool; this reads them from the ledger, has the harness run each check at the final head (`claim-checks.ts`),
// stores the verdicts, and says what the result carries: the verdicts and, for a claim the check found false, a
// reason for `MISREPORT`. Results come from tools, never from the session's text (R15, R24).

import type { TrustSource } from "../gate/trust.js";
import { hostGit } from "../git/host-git.js";
import { withLedger, withLedgerSync } from "../ledger/use.js";
import { checkClaims } from "./claim-checks.js";
import { claimsOf, recordClaimVerdicts, reportedCheck, type ClaimResult } from "./claims.js";
import type { ContainmentChoice } from "./session-protocol.js";

export interface SessionClaimsInput {
  workspace: string;
  ledgerPath: string;
  sessionId: string;
  /** The final head: the session's branch, or the caller's HEAD for a session with no branch of its own. */
  head: string;
  /** Where the work started. */
  base?: string | undefined;
  /** The session wrote in the caller's own tree: its changes are not a commit, so no check at a commit can see them. */
  wroteInPlace: boolean;
  trust: TrustSource | undefined;
  containment: ContainmentChoice;
  testCommand: string;
  shellPath?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface SessionClaimsReport {
  claims: ClaimResult[];
  /** One line per claim the harness found false, for the `MISREPORT` flag. */
  misreports: string[];
}

function shaOf(workspace: string, ref: string): string | undefined {
  const r = hostGit(["rev-parse", "--verify", `${ref}^{commit}`], workspace);
  return r.ok ? r.stdout : undefined;
}

/** Judges a session's claims. Undefined when it made none. Never throws. */
export async function judgeSessionClaims(input: SessionClaimsInput): Promise<SessionClaimsReport | undefined> {
  const stored = await withLedger(input.ledgerPath, async (ledger) => claimsOf(ledger, input.sessionId)).catch(() => []);
  if (stored.length === 0) return undefined;
  const claims: ClaimResult[] = input.wroteInPlace
    ? stored.map((c) => ({ id: c.id, text: c.text, check: reportedCheck(c.check), verdict: "unchecked" as const, reason: "the session wrote in the caller's own tree: its changes are not a commit, so no check can run at them" }))
    : await checkClaims({
        repo: input.workspace,
        ledgerPath: input.ledgerPath,
        sessionId: input.sessionId,
        claims: stored,
        head: input.head,
        base: input.base,
        trust: input.trust,
        containment: input.containment,
        testCommand: input.testCommand,
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.shellPath !== undefined ? { shellPath: input.shellPath } : {}),
      });
  try {
    withLedgerSync(input.ledgerPath, (ledger) => recordClaimVerdicts(ledger, claims, shaOf(input.workspace, input.head), input.base !== undefined ? shaOf(input.workspace, input.base) : undefined));
  } catch {
    // The verdicts are still in the result; a ledger that cannot be written to has bigger problems.
  }
  const misreports = claims
    .filter((c) => c.verdict === "failed")
    .map((c) => `claim ${c.id} (${c.text.length > 120 ? `${c.text.slice(0, 120)}...` : c.text}) is false: ${c.reason}`);
  return { claims, misreports };
}
