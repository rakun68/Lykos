// P4 T149 — how `lykos-reviewer`'s setting crosses from `config.yaml` to the
// extension.
//
// The same move T148 made for the repo map (`REPO_MAP_POLICY_ENV`): the
// setting stays where a person already writes it — `reviewer: { enabled,
// model }` — and boot hands the resolved value over in one environment
// variable before extensions load. The extension reads it once, in
// `register`. A third party's extension that wants a setting does the same
// thing with its own variable; nothing here is a door only Lykos's own
// extensions can use.

/** The reviewer's resolved setting, as JSON. */
export const REVIEWER_POLICY_ENV = "LYKOS_REVIEWER_POLICY";

export interface ReviewerPolicy {
  /** False is the shipped default (spec story 30); this repository turns it on (story 29). */
  enabled: boolean;
  /** `provider/model` the review runs on. Empty means the reviewed session's own model. */
  model: string;
}

export function encodeReviewerPolicyEnv(policy: ReviewerPolicy): string {
  return JSON.stringify({ enabled: policy.enabled, model: policy.model });
}

/** Null on anything malformed — the extension then falls back to its own default. */
export function decodeReviewerPolicyEnv(raw: string | undefined): ReviewerPolicy | null {
  if (raw === undefined || raw === "") return null;
  try {
    const v = JSON.parse(raw) as Partial<ReviewerPolicy>;
    if (typeof v.enabled !== "boolean") return null;
    return { enabled: v.enabled, model: typeof v.model === "string" ? v.model.trim() : "" };
  } catch {
    return null;
  }
}
