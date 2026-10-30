// `lykos-reviewer`, the reviewer that did not write the code, as a default
// Lykos extension.
//
// **What it is for** (T110's reason, unchanged). The post-edit loop says a
// check failed; the gate reports an exit code. Nothing looks at work that
// passes every mechanical check and is still wrong — syntactically plausible,
// semantically wrong, which is the failure a cheap model produces most. An
// agent reviewing its own diff in the context that produced it still holds
// the reasoning that caused the bug, so the review runs in a fresh, read-only
// child session whose whole input is the diff, the task list and the gate's
// verdict — never the parent's transcript.
//
// **Written only against the Lykos extension API** (spec stories 26, 35). It
// uses exactly three things any extension can use: `session_end` (the gate's
// verdict and the diff), `runChildSession` (read-only, model given), and
// `recordCounter` (its own numbers, in the ledger under its name). It imports
// nothing from Lykos's session, gate or ledger. Anything it does, a third
// party's extension can do.
//
// **Advisory, always.** It runs AFTER the gate, never instead of it, and the
// API it is written against has no way to write an outcome — so a review
// cannot turn a red gate green or a green one red. The refusal of an agent's
// self-report as a success is untouched.
//
// **What it records** (story 34). Per session, under `lykos-reviewer`:
// `invocations` (a child session was run), `findings` (how many FINDING lines
// it returned), `failures` (the child did not complete), and — when it chose
// not to run — `skipped_no_edits`, `skipped_no_diff` or `skipped_unfinished`,
// so `lykos show` can say why it did not run rather than print nothing. The
// model is the child session's own ledger row; the findings are its final
// text in its transcript.
//
// **Its setting** is `reviewer: { enabled, model }` in `config.yaml`, handed
// over by `REVIEWER_POLICY_ENV` (`reviewer-policy.ts`). Shipped off globally
// (story 30); on in this repository (story 29). Switched off either way: the
// setting, or a `lykos_extensions:` list without it.

import type { LykosExtension, SessionEndEvent } from "../api.js";
import { decodeReviewerPolicyEnv, REVIEWER_POLICY_ENV, type ReviewerPolicy } from "./reviewer-policy.js";

export const REVIEWER_NAME = "lykos-reviewer";

/**
 * The reviewer's prompt. Takes the `session_end` payload and nothing else —
 * the parent's transcript is not a parameter and so cannot reach it.
 */
export function buildReviewerPrompt(end: SessionEndEvent): string {
  const v = end.verdict;
  const gate =
    v.status === "recorded"
      ? [
          `- command: ${v.command ?? "(unknown)"}`,
          `- outcome: ${v.outcome ?? "(none)"}`,
          `- exit code: ${v.exitCode ?? "(none)"}`,
        ].join("\n")
      : `(the gate did not grade this session: ${v.reason ?? "no reason recorded"})`;
  const files =
    end.diff.files.length > 0
      ? end.diff.files
          .map((f) => `- ${f.path}${f.untracked ? " (new)" : ""}  +${f.added ?? "?"} -${f.removed ?? "?"}`)
          .join("\n")
      : "(none)";
  return [
    "You are an independent, read-only reviewer evaluating completed code changes.",
    "You did NOT write this code and did NOT see the conversation that produced it.",
    "You may read files in the repository for context. You cannot change anything.",
    "",
    "Your objective: find semantic bugs, regressions, unhandled edge cases, or requirements",
    "from the task list that were missed or implemented incorrectly. Mechanical checks",
    "(compiler, typechecker, tests) may already have passed; your job is what they cannot",
    "catch: work that is syntactically plausible but semantically wrong.",
    "",
    "## 1. Task list",
    end.taskList.trim().length > 0 ? end.taskList.trim() : "(no task list was kept)",
    "",
    "## 2. The verification gate",
    gate,
    "",
    "## 3. Files changed",
    files,
    "",
    "## 4. Diff",
    "```diff",
    end.diff.text.trim().length > 0 ? end.diff.text.trim() : "(no diff)",
    "```",
    "",
    "## How to answer",
    "For each semantic bug, logic error, omission or regression, write one line starting with",
    "  FINDING: <brief summary>",
    "then explain it, naming the file and line where you can.",
    "If there is nothing wrong, answer exactly: NO_FINDINGS",
  ].join("\n");
}

/** The findings in a review: every `FINDING:` line, or the items under a Findings heading. */
export function parseReviewerFindings(text: string): string[] {
  const findings: string[] = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const m = line.trim().match(/^(?:[-*]\s*)?FINDING:\s*(.+)$/i);
    if (m?.[1] !== undefined && m[1].trim().length > 0) findings.push(m[1].trim());
  }
  if (findings.length > 0 || /\bNO_FINDINGS\b/i.test(text)) return findings;
  // A model that ignored the format but wrote a Findings list is still read.
  let inSection = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^#{1,4}\s*(?:findings|issues|defects)\b/i.test(t)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,4}\s+/.test(t)) break;
    if (!inSection) continue;
    const item = t.match(/^(?:\d+\.|\*|-)\s+(.+)$/)?.[1]?.trim();
    if (item !== undefined && item.length > 0 && !/^none\b/i.test(item) && !/^no (?:findings|issues)\b/i.test(item)) {
      findings.push(item);
    }
  }
  return findings;
}

/** T162: how many findings the end-of-session report lists before pointing at `lykos show`. */
export const TOP_FINDINGS = 3;

/** T162: the end-of-session report for a review that ran. The full text stays in `lykos show`. */
export function renderReviewReport(findings: readonly string[], model: string, sessionId: string): string {
  if (findings.length === 0) return `found nothing (on ${model})`;
  const shown = findings.slice(0, TOP_FINDINGS);
  const more = findings.length - shown.length;
  return [
    `${findings.length} finding(s) on ${model}, advisory:`,
    ...shown.map((f, i) => `${i + 1}. ${f}`),
    `${more > 0 ? `${more} more; ` : ""}full text: \`lykos show ${sessionId}\``,
  ].join("\n");
}

const reviewer: LykosExtension = {
  name: REVIEWER_NAME,
  register(api) {
    // Read once, at load: a later session in the same process sets its own.
    const policy: ReviewerPolicy = decodeReviewerPolicyEnv(process.env[REVIEWER_POLICY_ENV]) ?? {
      enabled: true,
      model: "",
    };
    if (!policy.enabled) {
      // T162: off by its setting, an edited session still says why it was not
      // reviewed. Nothing else is said and nothing is counted.
      api.on("session_end", (end) => {
        if (end.state === "done" && end.edited) {
          api.reportAtSessionEnd("did not run — it is off (`reviewer.enabled: false`)");
        }
      });
      return;
    }

    api.on("session_end", async (end) => {
      if (end.state !== "done") {
        api.recordCounter("skipped_unfinished");
        api.reportAtSessionEnd(`did not run — the session ended ${end.state}, so there is no finished work to review`);
        return;
      }
      if (!end.edited) {
        api.recordCounter("skipped_no_edits");
        api.reportAtSessionEnd("did not run — the session edited no files");
        return;
      }
      if (end.diff.text.trim().length === 0) {
        // Edited, then put back: there is nothing left to review.
        api.recordCounter("skipped_no_diff");
        api.reportAtSessionEnd("did not run — the session's edits left no diff");
        return;
      }
      const model = policy.model.length > 0 ? policy.model : end.model;
      api.recordCounter("invocations");
      const result = await api.runChildSession({
        model,
        prompt: buildReviewerPrompt(end),
        label: `lykos-reviewer (${model})`,
      });
      if (result.status !== "ok") {
        api.recordCounter("failures");
        api.reportAtSessionEnd(`did not finish — its review session ${result.status === "unavailable" ? "was unavailable" : "failed"}: ${result.message.split("\n")[0]}`);
        return;
      }
      const findings = parseReviewerFindings(result.text);
      api.recordCounter("findings", findings.length);
      api.reportAtSessionEnd(renderReviewReport(findings, model, end.sessionId));
    });
  },
};

export default reviewer;
