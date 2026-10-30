// What class of action does a call to this tool perform?
//
// **The gap this closes.** The approval gate reasoned about tool *names*. It
// knew `write`, `edit` and `bash`, and every future tool would have needed a
// new branch somewhere. T105 generalised the interception but not the
// vocabulary: a hook policy had nothing to ask a tool about except its name,
// and "what is this agent actually allowed to do" could only be answered by
// reading the approval path. This module is the vocabulary.
//
// **Four tiers**, from the blueprint `24-strength-and-tooling-audit.md` §1
// recorded and never put in the register:
//
//   - `read`         provably reads and nothing else. Auto-allowed.
//   - `soft-write`   the working directory and its artifacts. Reachable by
//                    `write` and `edit` (the scope clamp in `approval.ts`
//                    has already refused anything outside the project root
//                    before the gate is consulted) and, deliberately, by no
//                    command — a shell is categorically not a soft write.
//   - `hard-write`   a shell, a network POST, a secret, an unbounded child.
//                    Also what an UNDECLARED tool gets: see below.
//   - `destructive`  deletion, force-push, migration, production.
//
// **The four hints, two declared and two derived — a judgement call worth
// stating.** The field's vocabulary is `readOnlyHint`, `destructiveHint`,
// `idempotentHint`, `openWorldHint`. The first two are functions of the tier
// (`read` IS the read-only hint; `destructive` IS the destructive hint), so
// declaring them separately would create a second field that can contradict
// the tier — which is the same class of mistake as a second classifier. They
// are therefore derived (`readOnlyHint`, `destructiveHint` below) and cannot
// disagree. The other two carry information the tier does not: `write` is
// idempotent and `edit` is not, though both are `soft-write`; `bash` reaches
// the network and `read` does not, though tiers say nothing about reach. So
// those two are declared.
//
// **There is exactly one command classifier, and exactly one mapping.**
// `command-safety.ts` owns the only thing in this codebase that parses a
// shell command, and it already reuses T63's parser rather than adding a
// second. `tierForCommandRisk` below consumes that classifier's three-value
// answer and never re-reads the command. T131's review round found the
// failure mode this rule exists for — a directory-search command carrying a
// `-delete` flag classified read-only by one module and trusted by another —
// and the conclusion recorded then governs here: one occasionally
// over-conservative classifier beats two that can disagree.
//
// **An undeclared tool is `hard-write`, never `read` (T107.3).** An
// unannotated tool is an unreviewed tool, and the failure mode of guessing
// generously is silent. `tool-risk.test.ts` also fails on an undeclared
// tool, so the miss arrives at commit time rather than at approval time.

import type { CommandRisk } from "../gate/command-safety.js";
import { REGISTRY_TOOL_RISKS, LYKOS_TOOL_NAMES, TOOL_REGISTRY } from "./tool-surface.js";

export type RiskTier = "read" | "soft-write" | "hard-write" | "destructive";

/** Ascending order of danger. The order is meaningful: index is the tier's rank. */
export const RISK_TIERS = ["read", "soft-write", "hard-write", "destructive"] as const;

/**
 * T107.3: a tool with no declared tier is treated as the second-most
 * dangerous class. Never `read` — an unannotated tool is an unreviewed one.
 */
export const DEFAULT_RISK_TIER: RiskTier = "hard-write";

/** Prose for a refusal the model reads. A denial names the class of action, not the tool. */
export const RISK_TIER_LABEL: Record<RiskTier, string> = {
  read: "read",
  "soft-write": "soft write",
  "hard-write": "hard write",
  destructive: "destructive",
};

export interface ToolRisk {
  /** What a call to this tool may do. */
  tier: RiskTier;
  /**
   * Set when the declared `tier` is only the answer for a call whose real
   * tier could not be determined. `bash` is the only tool that carries this:
   * its tier is a function of the command, through `tierForCommandRisk`.
   *
   * Callers that record a tier from a tool NAME alone must skip a tool
   * carrying this, rather than recording the fallback as though it were
   * measured. Keying that on the flag rather than on the literal name
   * "bash" is the whole point of this ticket.
   */
  tierDerivedFrom?: "command";
  /** Does calling it twice with the same arguments leave the same state? */
  idempotent: boolean;
  /** Can it reach something outside this machine's project directory — the network, a human, an unbounded child? */
  openWorld: boolean;
}

/** Derived, never declared: it cannot disagree with the tier. */
export function readOnlyHint(tier: RiskTier): boolean {
  return tier === "read";
}

/** Derived, never declared: it cannot disagree with the tier. */
export function destructiveHint(tier: RiskTier): boolean {
  return tier === "destructive";
}

export function isRiskTier(value: string): value is RiskTier {
  return (RISK_TIERS as readonly string[]).includes(value);
}

/**
 * The tools Lykos registers itself (`loadTools` in this module), as
 * opposed to the runtime's own built-ins, which declare their tier in
 * `tool-surface.ts`'s registry beside the reason they ride hop-0.
 *
 * Keyed by literal name rather than by importing each module's exported
 * name constant, because `plan-tool.ts` imports `modes.ts` and `modes.ts`
 * imports this module — the import would be a cycle. `tool-risk.test.ts`
 * asserts these keys equal those constants, so drift fails at commit time,
 * which is the same enforcement an import would have bought.
 *
 * `write`, `edit` and `bash` are absent here deliberately: Lykos registers
 * gated shadows of them (`approval.ts`), but they are Pi's tools and the
 * registry is their one home. Two declarations would be two answers.
 */
export const LYKOS_TOOL_RISKS: Readonly<Record<string, ToolRisk>> = Object.fromEntries(
  TOOL_REGISTRY.filter((e) => (LYKOS_TOOL_NAMES as readonly string[]).includes(e.name)).map((e) => [e.name, e.risk]),
);

export const TOOL_RISKS: Readonly<Record<string, ToolRisk>> = {
  ...REGISTRY_TOOL_RISKS,
  ...LYKOS_TOOL_RISKS,
};

/** The declaration, or undefined when the tool has none. Use `tierForTool` to get the fail-closed answer. */
export function riskForTool(name: string): ToolRisk | undefined {
  return TOOL_RISKS[name];
}

/** T107.3: the declared tier, or `hard-write` when nothing declared one. */
export function tierForTool(name: string): RiskTier {
  return TOOL_RISKS[name]?.tier ?? DEFAULT_RISK_TIER;
}

/**
 * **T107.4 — the one mapping, written once.**
 *
 * `command-safety.ts` answers what a command IS; this says what that answer
 * means in tier vocabulary. It takes the classifier's verdict as a value and
 * never looks at the command, so there is no second opinion to disagree with
 * the first.
 *
 * `soft-write` is unreachable here on purpose: a shell command is never a
 * soft write, whatever it does. That tier belongs to `write` and `edit`,
 * which are categorically not a shell.
 */
export function tierForCommandRisk(risk: CommandRisk): RiskTier {
  switch (risk) {
    case "read-only":
      return "read";
    case "ordinary":
      return "hard-write";
    case "destructive":
      return "destructive";
  }
}
