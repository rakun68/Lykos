// T232 review: the interactive session reads whether it can write from its posture, as the delegated session does, so
// a read-only conversation is not put through the seal's order and a plan the human accepted is.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sessionIsReadOnly } from "./interactive.js";

describe("T232: the interactive session tells the seal order whether it is read-only", () => {
  it("follows the posture while it exists, so an accepted plan makes the session writable", () => {
    assert.equal(sessionIsReadOnly({ readOnlyPosture: { readOnly: true } }, { readOnly: undefined }), true);
    assert.equal(sessionIsReadOnly({ readOnlyPosture: { readOnly: false } }, { readOnly: true }), false);
  });

  it("falls back to the config without a posture", () => {
    assert.equal(sessionIsReadOnly({}, { readOnly: true }), true);
    assert.equal(sessionIsReadOnly({}, { readOnly: undefined }), false);
  });
});
