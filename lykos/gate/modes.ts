// T131 / T208 (ADR-0041) — the three permission modes (manual, accept-edits, auto),
// and the one function that decides what each of them permits.
//
// Read-only-ness is no longer a permission mode (ADR-0041): it is a specialist's
// posture (e.g. Plan or Explore). The modes control when and what the gate prompts for.
//
// **Why the policy lives here and not in the modal.** The gate used to hold
// the mode and branch on it inline, which meant the only way to find out
// what a mode permitted was to read a UI file, and the only way to test it
// was to drive a renderer. This module is pure: modes in, verdict out. The
// modal renders the prompt; this decides whether there is one.

import { classifyCommandRisk, isAllowlisted, patternsFor, segmentHead, type CommandRisk } from "./command-safety.js";
import { splitShellSegments } from "../loop/exploration.js";
import { RISK_TIER_LABEL, tierForCommandRisk, tierForTool, type RiskTier } from "../tools/tool-risk.js";

export type InteractionMode = "manual" | "accept-edits" | "auto";

/**
 * Cycle order for `Shift+Tab`: manual -> accept-edits -> auto.
 */
export const INTERACTION_MODES = ["manual", "accept-edits", "auto"] as const;

export const DEFAULT_INTERACTION_MODE: InteractionMode = "manual";

export interface ModeInfo {
  /** What the header and the mode-switch notice call it. */
  label: string;
  /** One line, shown by `/help` and in the switch notice sent to the model. */
  description: string;
}

export const MODE_INFO: Record<InteractionMode, ModeInfo> = {
  manual: {
    label: "Manual",
    description: "asks before anything but a read",
  },
  "accept-edits": {
    label: "Accept Edits",
    description: "approves reads, file edits and common file commands; asks before deleting or running other commands",
  },
  auto: {
    label: "Auto",
    description: "approves safe work on its own; asks once before anything risky, and remembers the answer",
  },
};

export function isInteractionMode(value: string): value is InteractionMode {
  return (INTERACTION_MODES as readonly string[]).includes(value);
}

export type ParseInteractionModeResult =
  | { ok: true; mode: InteractionMode }
  | { ok: false; error: string };

export function parseInteractionMode(value: string): ParseInteractionModeResult {
  if (value === "plan" || value === "ask") {
    return {
      ok: false,
      error: `"${value}" is no longer a permission mode; use a read_only specialist instead (e.g. Plan or Explore)`,
    };
  }
  if (isInteractionMode(value)) {
    return { ok: true, mode: value };
  }
  return {
    ok: false,
    error: `unknown interaction mode "${value}" — valid modes are manual, accept-edits, auto`,
  };
}

/**
 * Does a session in this mode write? Read-only-ness is no longer a mode (ADR-0041);
 * all three modes write (they differ in what they approve without asking).
 * Kept for callers until fully retired.
 */
export function modeWrites(_mode: InteractionMode): boolean {
  return true;
}

export function nextMode(mode: InteractionMode): InteractionMode {
  const i = INTERACTION_MODES.indexOf(mode);
  return INTERACTION_MODES[(i + 1) % INTERACTION_MODES.length]!;
}

/**
 * What the model is trying to do. `bash` carries its command because the
 * verdict depends on what the command *is*.
 *
 * P10.4 (ticket 13): `powershell` carries no command, and that is the whole
 * point of it being its own arm. See `tierForAction`.
 */
export type GatedAction =
  | { kind: "write" }
  | { kind: "edit" }
  | { kind: "powershell" }
  // P10.6 (ticket 19, D3/D5): three more arms that carry no command, for the
  // same reason `powershell` carries none — see `tierForAction`, and the
  // comment on `GatedToolKind` in `approval.ts` for why each one is its own
  // arm rather than being folded into `write` or `bash`.
  | { kind: "read" }
  | { kind: "github" }
  | { kind: "eval" }
  // P10.9 (ticket 21, D4): every tool a Lykos extension registered, under one
  // arm. It names NO registry row on purpose — `tierForTool` finds no
  // declaration for it and returns T107.3's fail-closed `hard-write`, which is
  // how an extension-declared tier stays a declaration a human can read rather
  // than a promise the policy acts on.
  | { kind: "extension" }
  | { kind: "bash"; command: string };

export type ModeVerdict = "allow" | "deny" | "ask";

export interface ModeDecision {
  verdict: ModeVerdict;
  /** Present on every `deny`, and written into the tool result so the model learns the rule instead of retrying it. Always names the mode responsible, and the CLASS of action rather than the tool. */
  reason?: string;
  /** Whether the approval prompt should offer "always allow". False for destructive actions — see `command-safety.ts`. */
  offerAlways?: boolean;
  /** The patterns "always" would store. Empty unless `offerAlways`. */
  patterns?: string[];
  /**
   * The command's three-value risk, absent for write/edit.
   */
  risk?: CommandRisk;
  /**
   * T107: the risk tier this decision was made from. Always present — it is
   * now the thing the policy below actually branches on, and it is what
   * `calls.risk_tier` records so approvals can be counted by class rather
   * than estimated.
   */
  tier: RiskTier;
}

/**
 * T107.2: the tier of one gated action, and the only place the two
 * vocabularies meet.
 *
 * `bash` is a function of its command, through the single classifier and
 * the single mapping. Everything else is the tool's declaration — so adding
 * a tool means declaring what it does, not editing this function.
 *
 * `write` and `edit` are looked up like any other tool, and their
 * declaration says `soft-write` for a reason worth stating here:
 * `approval.ts`'s scope clamp has already refused any path outside the
 * project root *before* the gate is reached, so every write and edit that
 * gets this far is by construction inside the working directory, which is
 * exactly what `soft-write` means.
 *
 * **P10.4 (ticket 13): `powershell` is a shell and is still not `bash`.** It
 * takes its DECLARED tier, the same as `write` and `edit`, and never reaches
 * `classifyCommandRisk`. The classifier parses POSIX shell — it is
 * `loop/exploration.ts`'s tokenizer, built for bash — and a PowerShell line
 * put through it does not fail loudly; it comes back "ordinary", because an
 * unrecognised head is the classifier's honest answer for a command it has
 * no rule for. `Remove-Item -Recurse -Force build` is exactly that line, and
 * "ordinary" in Auto means prompt once and offer to remember it, which would
 * turn a recursive delete into an always-allow entry on a single yes.
 * `tool-surface.ts`'s registry row already says the tier is the fail-closed
 * `hard-write` for precisely this reason; this is where that declaration is
 * honoured instead of overridden.
 *
 * **P10.6 (ticket 19): `read`, `github` and `eval` land on the same line as
 * `powershell`.** Every one of them names a registry row and takes the tier
 * declared there — `read` for a network read, `hard-write` for a pull request
 * and for an evaluated cell. None of them carries a command, so none of them
 * can reach the classifier, which is the point: a `gh` argument array and a
 * JavaScript cell are not shell lines and a shell parser has nothing true to
 * say about either.
 *
 * **P10.9 (ticket 21): `extension` is the one arm that names no row at all**,
 * and it takes the undeclared-tool answer for exactly the reason T107.3 chose
 * it — an unreviewed tool is not a read-only one. An extension may declare
 * whatever tier it likes; that declaration is shown to the human beside the
 * extension's name and is never consulted here.
 */
export function tierForAction(action: GatedAction): RiskTier {
  if (action.kind === "bash") return tierForCommandRisk(classifyCommandRisk(action.command));
  return tierForTool(action.kind);
}

/** Commands permitted by Accept Edits alongside read-tier actions and edits. */
const ACCEPT_EDITS_COMMANDS: ReadonlySet<string> = new Set(["mkdir", "touch", "mv", "cp"]);

/**
 * The whole policy, in one pure function.
 *
 * `allowed` is the project's persisted allowlist (see `permissions.ts`).
 * Only Auto consults it: Manual ignores it by definition, and Accept Edits
 * approves its defined set and asks for everything else.
 */
export function decideForMode(
  mode: InteractionMode,
  action: GatedAction,
  allowed: ReadonlySet<string>,
  opts?: { readOnly?: boolean | undefined; verifyCommand?: string | undefined },
): ModeDecision {
  const label = MODE_INFO[mode].label;

  // T107.2: the policy branches on the TIER from here down.
  const tier = tierForAction(action);

  const risk: Partial<Pick<ModeDecision, "risk">> =
    action.kind === "bash" ? { risk: classifyCommandRisk(action.command) } : {};
  const patterns = action.kind === "bash" ? patternsFor(action.command) : [];
  // Never offer to remember a destructive action, however it was reached.
  const offerAlways = tier !== "destructive";
  const ask: ModeDecision = { verdict: "ask", offerAlways, patterns, tier, ...risk };

  // T214 (ADR-0043): read_only is a ceiling no mode lifts. Non-read actions are
  // denied outright with a reason naming read-only; reads and read-only bash run.
  if (opts?.readOnly) {
    if (tier === "read") return { verdict: "allow", tier, ...risk };
    return {
      verdict: "deny",
      reason: "read-only specialist: writes and modifying commands are not permitted",
      tier,
      ...risk,
    };
  }

  switch (mode) {
    case "manual":
      // Manual allows read-tier actions and asks for everything else (ADR-0041).
      if (tier === "read") return { verdict: "allow", tier, ...risk };
      return ask;

    case "accept-edits":
      // Accept Edits allows read tier, file writes/edits, and common file commands (mkdir, touch, mv, cp).
      if (tier === "read" || action.kind === "write" || action.kind === "edit") {
        return { verdict: "allow", tier, ...risk };
      }
      if (action.kind === "bash") {
        // T208 / Ruling 4 & 6:
        // Allow the four commands by command alone for now; inside-directory check arrives with
        // path rules in T210/T212.
        // A compound line is allowed under Accept Edits only when every parsed segment is a read-tier
        // command or one of the four; any rm or other segment asks.
        const segments = splitShellSegments(action.command);
        if (segments.length > 0) {
          const allAllowed = segments.every((seg) => {
            const head = segmentHead(seg);
            if (head !== undefined && ACCEPT_EDITS_COMMANDS.has(head)) return true;
            return classifyCommandRisk(seg) === "read-only";
          });
          if (allAllowed) return { verdict: "allow", tier, ...risk };
        }
      }
      return ask;

    case "auto":
      // Reads and soft writes — the working directory, which the scope
      // clamp has already bounded — run on their own.
      if (tier === "read" || tier === "soft-write") return { verdict: "allow", tier, ...risk };
      // L4: the session's own verification command runs without asking in Auto.
      const verifyCommand = opts?.verifyCommand?.trim();
      if (
        action.kind === "bash" &&
        verifyCommand !== undefined &&
        verifyCommand.length > 0 &&
        action.command.trim() === verifyCommand &&
        classifyCommandRisk(verifyCommand) !== "destructive"
      ) {
        return { verdict: "allow", tier, ...risk };
      }
      // A remembered approval can raise a hard write to "allow" and can
      // never raise a destructive one: `isAllowlisted` refuses those
      // outright, so an entry for `rm` can never silence `rm -rf`.
      if (action.kind === "bash" && isAllowlisted(action.command, allowed)) {
        return { verdict: "allow", tier, ...risk };
      }
      return ask;
  }
}

/** The line written into the conversation when the mode changes, so the model learns the new rule without a head rewrite (T17). */
export function modeSwitchNotice(mode: InteractionMode): string {
  const info = MODE_INFO[mode];
  return `Interaction mode is now ${info.label}: ${info.description}.`;
}
