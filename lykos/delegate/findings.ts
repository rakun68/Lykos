// Findings (T235, ADR-0059, ADR-0061, spec decision 13): what a reviewer says is wrong with a change. A finding is a
// claim, the claim being that the defect exists, with a severity and a basis (the `path:line` it rests on). Its check
// is one of the claim checks (`claims.ts`) and is expected to HOLD on the branch: a reproduction's named tests fail
// there, a command exits the code the defect gives. The reviewer records a finding with the `finding` tool; the
// harness runs the check (`claim-checks.ts`), never the reviewer, and decides what the finding does:
//
//   - `blocks`: the defect was reproduced on the branch and is not already there at the base or in the baseline.
//   - `triage`: nothing reproduced it and it is medium or worse: the coordinator decides. Never dropped silently.
//   - `dropped`: a low finding with no reproduction (W7), a check that ran and did not hold (a false positive), or a
//     defect the base or the baseline already has (not this change's).
//
// A verdict says the check held or did not; it is not proof the finding's wider claim is true, which is why a
// reviewer also judges the acceptance criteria and the tests (ADR-0061).

import type { Ledger } from "../ledger/use.js";
import { nameMatches } from "./claim-checks.js";
import { parseClaimCheck, reportedCheck, type BaseVerdict, type ClaimCheck, type ClaimResult, type ClaimVerdict, type ReportedCheck } from "./claims.js";
import type { Cause } from "./decisions.js";

export const SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const MAX_FINDING_TEXT_CHARS = 2000;

export interface FindingInput {
  text: string;
  severity: Severity;
  /** What the finding rests on: `path:line`, or the requirement it breaks. */
  basis: string;
  /** Absent: the reviewer had no reproduction to give. */
  check?: ClaimCheck;
}

export type ParsedFinding = { ok: true; finding: FindingInput } | { ok: false; message: string };

/** Validates a finding as the model wrote it. A check that is not one of the claim shapes is refused, never guessed at. */
export function parseFinding(value: unknown): ParsedFinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, message: "a finding must be an object" };
  const v = value as Record<string, unknown>;
  const text = typeof v["text"] === "string" ? v["text"].trim() : "";
  if (text === "") return { ok: false, message: "`text` is empty. State what is wrong, in a sentence or two." };
  if (text.length > MAX_FINDING_TEXT_CHARS) return { ok: false, message: `\`text\` is over ${MAX_FINDING_TEXT_CHARS} characters` };
  const severity = v["severity"];
  if (typeof severity !== "string" || !(SEVERITIES as readonly string[]).includes(severity)) {
    return { ok: false, message: `\`severity\` must be one of ${SEVERITIES.join(", ")}` };
  }
  const basis = typeof v["basis"] === "string" ? v["basis"].trim() : "";
  if (basis === "") return { ok: false, message: "`basis` is empty. Give the path:line the finding rests on, or the requirement it breaks." };
  if (v["check"] === undefined || v["check"] === null) return { ok: true, finding: { text, severity: severity as Severity, basis } };
  const check = parseClaimCheck(v["check"]);
  if (!check.ok) return check;
  return { ok: true, finding: { text, severity: severity as Severity, basis, check: check.check } };
}

export type Disposition = "blocks" | "triage" | "dropped";

export interface Disposed {
  disposition: Disposition;
  /** What the tools saw and the rule applied, never the reviewer's words. */
  why: string;
  /** The ledger cause when the finding turned out wrong. */
  cause?: Cause;
}

/** A check that runs project code and so can reproduce a defect: a `line` or a `search` only confirms the cited evidence. */
export function reproduces(check: ClaimCheck): boolean {
  return check.kind === "command" || check.kind === "reproduction";
}

export interface DisposeInput {
  severity: Severity;
  check?: ClaimCheck | undefined;
  /** What the harness found when it ran the check. */
  result?: Pick<ClaimResult, "verdict" | "reason" | "base"> | undefined;
  /**
   * The tests that fail on the base already, from the baseline of known failures. Undefined when there is no measured
   * baseline: the base verdict of the reproduction is then the only evidence.
   */
  baselineFailing?: readonly string[] | undefined;
}

/**
 * The rule that decides what a finding does (ADR-0061, W7, `review_false_positive`). Pure: the harness's findings in, a
 * disposition out.
 */
export function dispose(input: DisposeInput): Disposed {
  const { severity, check, result } = input;
  const withoutReproduction = (reason: string): Disposed =>
    severity === "low"
      ? { disposition: "dropped", why: `${reason}; a low finding needs a reproduction to block` }
      : { disposition: "triage", why: `${reason}; a ${severity} finding without a reproduction is the coordinator's to triage` };
  if (check === undefined || result === undefined) return withoutReproduction("the reviewer gave no check");
  if (result.verdict === "failed") {
    return { disposition: "dropped", why: `its check ran and did not hold: ${result.reason}`, cause: "review_false_positive" };
  }
  if (result.verdict === "unchecked") return withoutReproduction(`its check could not run: ${result.reason}`);
  if (!reproduces(check)) return withoutReproduction("its check only confirms the evidence it cites, it does not reproduce the defect");
  if (check.kind === "reproduction") {
    if (result.base?.verdict === "fails") {
      return { disposition: "dropped", why: `the defect is not this change's: ${result.base.reason}` };
    }
    const known = (input.baselineFailing ?? []).filter((full) => check.fails.some((name) => nameMatches(name, full)));
    if (known.length > 0) return { disposition: "dropped", why: `the baseline of known failures already has it: ${known.join(", ")}` };
  }
  return { disposition: "blocks", why: `reproduced on the branch: ${result.reason}` };
}

export interface StoredFinding {
  id: number;
  session_id: string;
  ts: string;
  text: string;
  severity: Severity;
  basis: string;
  check?: ClaimCheck;
}

interface FindingRow {
  id: number;
  session_id: string;
  ts: string;
  text: string;
  severity: Severity;
  basis: string;
  check_json: string | null;
}

/** Writes a finding the moment the tool is called. Returns its id. */
export function recordFinding(ledger: Ledger, sessionId: string, finding: FindingInput): number {
  const info = ledger.db
    .prepare("INSERT INTO findings (session_id, ts, text, severity, basis, kind, check_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(
      sessionId,
      new Date().toISOString(),
      finding.text,
      finding.severity,
      finding.basis,
      finding.check?.kind ?? null,
      finding.check !== undefined ? JSON.stringify(finding.check) : null,
    );
  return Number(info.lastInsertRowid);
}

/** A reviewer session's findings, oldest first. */
export function findingsOf(ledger: Ledger, sessionId: string): StoredFinding[] {
  const rows = ledger.db.prepare("SELECT id, session_id, ts, text, severity, basis, check_json FROM findings WHERE session_id = ? ORDER BY id ASC").all(sessionId) as FindingRow[];
  return rows.map((r) => ({
    id: r.id,
    session_id: r.session_id,
    ts: r.ts,
    text: r.text,
    severity: r.severity,
    basis: r.basis,
    ...(r.check_json !== null ? { check: JSON.parse(r.check_json) as ClaimCheck } : {}),
  }));
}

/** The id a finding is known by in `finding_decisions`: the reviewer's session and the finding's row. */
export function findingKey(f: Pick<StoredFinding, "session_id" | "id">): string {
  return `${f.session_id}#${f.id}`;
}

/** A finding and what the harness decided, as a review's result carries it. */
export interface JudgedFinding {
  /** `<reviewer session>#<n>`, the id `finding_decisions` files it under. */
  finding_id: string;
  severity: Severity;
  text: string;
  basis: string;
  check?: ReportedCheck;
  disposition: Disposition;
  why: string;
  cause?: Cause;
  /** What the check found, when it ran or could not. */
  verdict?: ClaimVerdict;
  reason?: string;
  uncontained?: true;
  base?: { verdict: BaseVerdict; reason: string };
  regression?: true;
}

export function judged(f: StoredFinding, result: ClaimResult | undefined, disposed: Disposed): JudgedFinding {
  return {
    finding_id: findingKey(f),
    severity: f.severity,
    text: f.text,
    basis: f.basis,
    ...(f.check !== undefined ? { check: reportedCheck(f.check) } : {}),
    disposition: disposed.disposition,
    why: disposed.why,
    ...(disposed.cause !== undefined ? { cause: disposed.cause } : {}),
    ...(result !== undefined
      ? {
          verdict: result.verdict,
          reason: result.reason,
          ...(result.uncontained === true ? { uncontained: true as const } : {}),
          ...(result.base !== undefined ? { base: result.base } : {}),
          ...(result.regression === true ? { regression: true as const } : {}),
        }
      : {}),
  };
}

/** Stores what the harness found and decided about each finding, with the commits it found it at. A later run replaces an earlier one. */
export function recordFindingJudgements(ledger: Ledger, items: readonly JudgedFinding[], head: string | undefined, base: string | undefined): void {
  const stmt = ledger.db.prepare(
    `UPDATE findings SET verdict = ?, reason = ?, uncontained = ?, base_verdict = ?, base_reason = ?, head_commit = ?, base_commit = ?,
       disposition = ?, why = ?, checked_at = ? WHERE session_id = ? AND id = ?`,
  );
  const checkedAt = new Date().toISOString();
  ledger.db.transaction(() => {
    for (const item of items) {
      const [session, id] = item.finding_id.split("#");
      stmt.run(
        item.verdict ?? null,
        item.reason ?? null,
        item.uncontained === true ? 1 : 0,
        item.base?.verdict ?? null,
        item.base?.reason ?? null,
        head ?? null,
        base ?? null,
        item.disposition,
        item.why,
        checkedAt,
        session,
        Number(id),
      );
    }
  })();
}

/** What the next step is, from the closed `next` set, given how the findings were disposed. */
export function nextOfFindings(findings: readonly Pick<JudgedFinding, "disposition">[], hasFlags: boolean): "triage" | "resume" | "inspect_flags" | "approve" {
  if (findings.some((f) => f.disposition === "triage")) return "triage";
  if (findings.some((f) => f.disposition === "blocks")) return "resume";
  return hasFlags ? "inspect_flags" : "approve";
}
