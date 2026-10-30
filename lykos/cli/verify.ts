// `lykos verify` — CLI adapter: parse args, call the domain, print.
//
// Outcome recording lives in `session/verify-outcome.ts`.

import { defaultLedgerPath } from "../ledger/ledger.js";
import { stdoutWrite } from "../tui/io-mode.js";
import {
  runVerify,
  type VerifyAnswer,
  type VerifyResult,
} from "../session/verify-outcome.js";

export {
  VERIFICATION_OUTPUT_LIMIT,
  clampVerificationOutput,
  resolveSessionId,
  runVerificationCommand,
  runVerify,
  type RunVerifyOptions,
  type VerificationRun,
  type VerifyAnswer,
  type VerifyResult,
} from "../session/verify-outcome.js";

export interface VerifyCliOptions {
  cmd?: string;
  yes?: boolean;
  no?: boolean;
}

/** `lykos verify <session> [--cmd "..."] [--yes|--no]`. */
export async function runVerifyCli(cwd: string, sessionIdOrPrefix: string, opts: VerifyCliOptions): Promise<number> {
  const answer = parseVerifyAnswer(opts);
  if ("error" in answer) {
    process.stderr.write(`lykos verify: ${answer.error}\n`);
    return 1;
  }
  const result = await runVerify(sessionIdOrPrefix, {
    ledgerPath: defaultLedgerPath(cwd),
    cwd,
    answer: answer.answer,
  });
  return reportVerify(result);
}

export function parseVerifyAnswer(opts: VerifyCliOptions): { answer: VerifyAnswer } | { error: string } {
  const chosen = [opts.cmd !== undefined, opts.yes === true, opts.no === true].filter(Boolean).length;
  if (chosen === 0) {
    return {
      error:
        'expected one of --cmd "<command>", --yes, or --no. A verification command is the answer worth having: ' +
        "its exit code decides, and the row records outcome_source=verification_command rather than an opinion",
    };
  }
  if (chosen > 1) {
    return { error: "--cmd, --yes and --no are mutually exclusive — one session outcome has one source" };
  }
  if (opts.cmd !== undefined) {
    if (opts.cmd.trim().length === 0) return { error: "--cmd needs a command, e.g. --cmd \"npm test\"" };
    return { answer: { kind: "command", cmd: opts.cmd.trim() } };
  }
  return { answer: { kind: "human", worked: opts.yes === true } };
}

export function reportVerify(result: VerifyResult): number {
  if (result.status === "error") {
    process.stderr.write(`lykos verify: ${result.message}\n`);
    return 1;
  }
  if (result.status === "skipped") {
    stdoutWrite(`lykos verify: session ${result.sessionId} — ${result.reason}\n`);
    return 0;
  }
  const source = result.outcomeSource === "verification_command" ? `verification_command (\`${result.run?.cmd}\`)` : "human";
  const exit = result.run && result.run.exitCode !== null ? `, exit ${result.run.exitCode}` : "";
  stdoutWrite(`lykos verify: session ${result.sessionId} recorded outcome=${result.outcome} via ${source}${exit}\n`);
  return 0;
}
