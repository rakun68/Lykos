// T168 part B (ADR-0031, decision 12): the classifier `lykos show` uses to say
// why a failed `edit` failed. Every case below drives the REAL error through the
// real function that throws it, so rewording an error fails here instead of
// quietly moving its failures into `other`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyEditsToNormalizedContent, occurrencesPrefix } from "./edit-match.js";
import { EDIT_FAILURE_REASONS, classifyEditFailure, emptyFailureCounts } from "./edit-failure.js";
import { FileReadRecord, contentHash } from "./read-record.js";

function matchError(content: string, edits: Array<{ oldText: string; newText: string; replaceAll?: boolean }>): string {
  try {
    applyEditsToNormalizedContent(content, edits, "a.ts");
  } catch (err) {
    return (err as Error).message;
  }
  throw new assert.AssertionError({ message: "expected the edit to fail" });
}

describe("classifyEditFailure", () => {
  it("not_found: a single edit, one of several, and a replaceAll that found nothing", () => {
    assert.equal(classifyEditFailure(matchError("abc\n", [{ oldText: "zzz", newText: "y" }])), "not_found");
    assert.equal(
      classifyEditFailure(matchError("abc\n", [{ oldText: "abc", newText: "x" }, { oldText: "zzz", newText: "y" }])),
      "not_found",
    );
    assert.equal(classifyEditFailure(matchError("abc\n", [{ oldText: "zzz", newText: "y", replaceAll: true }])), "not_found");
  });

  it("not_unique: a single edit and one of several", () => {
    assert.equal(classifyEditFailure(matchError("ab ab\n", [{ oldText: "ab", newText: "x" }])), "not_unique");
    assert.equal(
      classifyEditFailure(matchError("ab ab cd\n", [{ oldText: "cd", newText: "x" }, { oldText: "ab", newText: "y" }])),
      "not_unique",
    );
    assert.match(`${occurrencesPrefix(12)}the text in a.ts.`, /^Found \d+ occurrences of /);
    assert.equal(classifyEditFailure(`${occurrencesPrefix(12)}the text in a.ts. The text must be unique.`), "not_unique");
  });

  it("overlap: two entries that touch the same text", () => {
    assert.equal(
      classifyEditFailure(matchError("hello world\n", [{ oldText: "hello wor", newText: "x" }, { oldText: "o world", newText: "y" }])),
      "overlap",
    );
  });

  it("unread and stale: the two require_read rejections", () => {
    const record = new FileReadRecord(true);
    const abs = "/some/where/a.ts";
    let unread = "";
    try {
      record.check(abs, Buffer.from("x"), "src/deep/a.ts");
    } catch (err) {
      unread = (err as Error).message;
    }
    record.noteRead(abs, contentHash("x"));
    let stale = "";
    try {
      record.check(abs, Buffer.from("y"), "src/deep/a.ts");
    } catch (err) {
      stale = (err as Error).message;
    }
    assert.equal(classifyEditFailure(unread), "unread");
    assert.equal(classifyEditFailure(stale), "stale");
  });

  it("other: everything that is none of the five, and no text at all", () => {
    for (const text of [
      "Could not edit file: a.ts. Error code: ENOENT.",
      "oldText must not be empty in a.ts.",
      "No changes made to a.ts. The replacement produced identical content.",
      "edits[0] in a.ts only matches after whitespace or quote folding, and a call cannot mix that with a replaceAll edit.",
      "Edit tool input is invalid. edits must contain at least one replacement.",
      "lykos: refused — the human declined this edit.",
      "Operation aborted",
      "",
    ]) {
      assert.equal(classifyEditFailure(text), "other", text);
    }
    assert.equal(classifyEditFailure(undefined), "other");
  });

  it("the reasons are the six the ticket names, in the order they print", () => {
    assert.deepEqual([...EDIT_FAILURE_REASONS], ["not_found", "not_unique", "overlap", "unread", "stale", "other"]);
    assert.deepEqual(Object.keys(emptyFailureCounts()), [...EDIT_FAILURE_REASONS]);
  });
});
