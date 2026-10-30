// The session-end outcome block, as a pure function pair.
//
// This file renders the question and parses the answer. It does not write to
// the ledger, does not open one, and does not run the verification command:
// `07-ui-and-hud.md` §1.1 is unchanged by Phase 3.5, so the renderer collects
// the answer and `cli/verify.ts` performs the mutation. The scan in
// `s0-writes.test.ts` is what enforces that, and it watches `recordOutcome`
// as of T52.
//
// The one design rule with teeth: **the agent's own opinion is never offered
// as an option.** `agent_claim` exists in the schema so `lykos cost` can
// exclude it, and nothing in this flow may produce one — there is no
// "the agent says it worked" answer here, and the ledger writer rejects the
// value outright so this cannot be reintroduced by a future caller passing a
// string.
//
// The second rule: **declining is a first-class answer, not a nag.** A NULL
// outcome is honest. A guessed one silently falsifies the column every cost
// claim in the project depends on, which is worse than a gap by a margin
// that is not close.

import type { GlyphMap } from "./theme/types.js";

/** What the person chose. Mapped to `cli/verify.ts`'s `VerifyAnswer` by the caller. */
export type OutcomeChoice =
  | { kind: "command"; cmd: string }
  | { kind: "human"; worked: boolean }
  | { kind: "skip" };

export interface OutcomePromptInput {
  sessionId: string;
  /**
   * The command to offer as the default, derived from the project rather than
   * configured — `npm test` when the project has a `test` script, and nothing
   * when it does not. A session-end block that requires typing the command
   * every time gets skipped every time, and T52's entire value is that
   * closing a session as verified-successful is a natural gesture.
   */
  suggestedCmd?: string;
  glyphs?: Pick<GlyphMap, "diamond">;
}

/**
 * The question, as lines. Kept as text rather than as a frame because it must
 * work on both surfaces: T37's append-only renderer today, and T42's
 * composer once the full-screen frame exists.
 */
export function renderOutcomePrompt(input: OutcomePromptInput): string {
  const mark = input.glyphs?.diamond ?? "◆";
  const cmdLine = input.suggestedCmd
    ? `  [c] run \`${input.suggestedCmd}\` and let its exit code decide`
    : "  [c] run a verification command and let its exit code decide";
  return [
    "",
    `${mark} did that work?  (session ${input.sessionId.slice(0, 8)})`,
    cmdLine,
    "  [y] yes — record success, decided by you",
    "  [n] no  — record failure, decided by you",
    "  [s] skip — record nothing; an unanswered outcome is a legitimate answer",
    "",
  ].join("\n");
}

/**
 * Parse one line of input into a choice, or `null` for "ask again".
 *
 * `c <command>` runs that command; a bare `c` runs `suggestedCmd`, and is
 * *unparseable* rather than a silent skip when there is no suggestion —
 * turning "run the tests" into "record nothing" without saying so is the kind
 * of quiet wrong answer this whole task exists to prevent.
 *
 * EOF (`null` line) is a skip: a piped or closed stdin has not declined, it
 * has simply not answered, and those are the same row in the ledger.
 */
export function parseOutcomeAnswer(line: string | null, suggestedCmd?: string): OutcomeChoice | null {
  if (line === null) return { kind: "skip" };
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  if (lower === "s" || lower === "skip") return { kind: "skip" };
  if (lower === "y" || lower === "yes") return { kind: "human", worked: true };
  if (lower === "n" || lower === "no") return { kind: "human", worked: false };
  if (lower === "c" || lower === "cmd") {
    return suggestedCmd ? { kind: "command", cmd: suggestedCmd } : null;
  }
  if (lower.startsWith("c ") || lower.startsWith("cmd ")) {
    const cmd = trimmed.slice(trimmed.indexOf(" ") + 1).trim();
    return cmd.length > 0 ? { kind: "command", cmd } : null;
  }
  // Anything else is a command only if it looks like the user typed one
  // directly rather than mistyping a letter — a bare word is far more likely
  // to be a fumbled `y` than a command worth running against their repo.
  if (trimmed.includes(" ") || trimmed.includes("/")) return { kind: "command", cmd: trimmed };
  return null;
}

/** The one-line report shown after the answer is recorded. Mirrors `reportVerify()`'s wording so the two surfaces agree. */
export function renderOutcomeResult(
  result:
    | { status: "recorded"; outcome: string; outcomeSource: string; exitCode?: number | null; cmd?: string }
    | { status: "skipped"; reason: string }
    | { status: "error"; message: string },
): string {
  if (result.status === "error") return `lykos: could not record the outcome — ${result.message}`;
  if (result.status === "skipped") return `lykos: ${result.reason}`;
  const via =
    result.outcomeSource === "verification_command"
      ? `verification_command (\`${result.cmd}\`, exit ${result.exitCode})`
      : "human";
  return `lykos: recorded outcome=${result.outcome} via ${via}`;
}
