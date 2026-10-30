// T168 part B (ADR-0031, decision 12) — why a failed `edit` call failed, read
// off the error text the model was handed.
//
// `lykos show` prints the non-zero counts so the edit mode can be judged from
// evidence: the WISHLIST entry for line-anchored editing (W19) is armed on
// "replace doing badly on a model Lykos uses", and "badly" has to be a count of
// something. The only record of why a call failed is the text of its error
// result in the transcript, so that text is what is classified.
//
// The matching is against the strings the tools throw, imported rather than
// retyped: the not-found, not-unique and overlap sentences are `edit-match.ts`'s
// (Pi's wording), and the unread and stale tails are `read-record.ts`'s. The
// tests also drive the real errors through the real functions, so a reworded
// error fails a test instead of silently landing in `other`.
//
// **What `other` holds, and does not hide.** A declined approval, a file that
// could not be opened, an empty `oldText`, an edit that changed nothing, a
// `replaceAll` mixed with a fuzzy match, a bad argument shape, an aborted call:
// every failure that is none of the five named. A count of `other` that grows
// is the signal to name a sixth reason, not something to read past.

import {
  NOT_FOUND_MULTI_PREFIX,
  NOT_FOUND_SINGLE_PREFIX,
  OVERLAP_MARKER,
} from "./edit-match.js";
import { STALE_TAIL, UNREAD_TAIL } from "./read-record.js";

export const EDIT_FAILURE_REASONS = ["not_found", "not_unique", "overlap", "unread", "stale", "other"] as const;
export type EditFailureReason = (typeof EDIT_FAILURE_REASONS)[number];

/** `Found 3 occurrences of ...`: the count is a number, so this is the one pattern, and `occurrencesPrefix()` is tested against it. */
const NOT_UNIQUE = /^Found \d+ occurrences of /;
/** `edits[0] and edits[2] overlap in a.ts. ...` */
const OVERLAP = new RegExp(`^edits\\[\\d+\\] and edits\\[\\d+\\]${OVERLAP_MARKER}`);

/** The reason an `edit` call's error text names. Anything unrecognised, and an absent text, is `other`. */
export function classifyEditFailure(text: string | undefined): EditFailureReason {
  if (text === undefined) return "other";
  // The unread and stale sentences name the path first, so they are found by their tails.
  if (text.includes(UNREAD_TAIL)) return "unread";
  if (text.includes(STALE_TAIL)) return "stale";
  if (text.startsWith(NOT_FOUND_SINGLE_PREFIX) || text.startsWith(NOT_FOUND_MULTI_PREFIX)) return "not_found";
  if (NOT_UNIQUE.test(text)) return "not_unique";
  if (OVERLAP.test(text)) return "overlap";
  return "other";
}

/** Every reason, zero included, so a record's shape does not depend on what happened. */
export function emptyFailureCounts(): Record<EditFailureReason, number> {
  return { not_found: 0, not_unique: 0, overlap: 0, unread: 0, stale: 0, other: 0 };
}
