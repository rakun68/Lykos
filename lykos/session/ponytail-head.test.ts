// Integrity test for the shipped ponytail ruleset: the file is non-empty,
// carries its attribution line, and is what the assembler injects, so a later
// edit cannot paraphrase it away unnoticed, plus the replace-vs-append seam `boot.ts` and `head-view.ts`
// both call through `resolvePonytailAndSpecialistHeads`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectVolatile } from "./head-contract.js";
import {
  assemblePonytailHead,
  isPonytailReplacement,
  PONYTAIL_ATTRIBUTION,
  PONYTAIL_HEADING,
  PONYTAIL_REPLACE_MARKER,
  PONYTAIL_RULESET_TEXT,
  PONYTAIL_SOURCE_COMMIT,
  PONYTAIL_SOURCE_URL,
  resolvePonytailAndSpecialistHeads,
} from "./ponytail-head.js";
import { SPECIALIST_HEADING } from "./specialist-head.js";

describe("ponytail ruleset — shipped-file integrity", () => {
  it("is non-empty", () => {
    assert.ok(PONYTAIL_RULESET_TEXT.length > 0);
    assert.ok(PONYTAIL_RULESET_TEXT.length > 500, "suspiciously short for the real ladder — check for accidental truncation");
  });

  it("carries its attribution line, naming the source, a pinned commit, and the MIT licence", () => {
    assert.match(PONYTAIL_ATTRIBUTION, /MIT/);
    assert.ok(PONYTAIL_ATTRIBUTION.includes(PONYTAIL_SOURCE_URL));
    assert.ok(PONYTAIL_ATTRIBUTION.includes(PONYTAIL_SOURCE_COMMIT));
    assert.match(PONYTAIL_SOURCE_COMMIT, /^[0-9a-f]{40}$/, "not a real pinned git commit SHA");
    const head = assemblePonytailHead();
    assert.ok(head.includes(PONYTAIL_ATTRIBUTION), "the attribution line must be in what the assembler actually injects");
  });

  it("is what assemblePonytailHead() actually injects, under the ## lykos-ponytail heading", () => {
    const head = assemblePonytailHead();
    assert.ok(head.startsWith(PONYTAIL_HEADING));
    assert.ok(head.includes(PONYTAIL_RULESET_TEXT));
  });

  it("carries the ladder's seven rungs, verbatim (spec: 'does this need to exist ... is it one line')", () => {
    const rungs = [
      "Does this need to be built at all? (YAGNI)",
      "Does it already exist in this codebase?",
      "Does the standard library already do this?",
      "Does a native platform feature cover it?",
      "Does an already-installed dependency solve it?",
      "Can this be one line?",
      "Only then: write the minimum code that works.",
    ];
    for (const rung of rungs) {
      assert.ok(PONYTAIL_RULESET_TEXT.includes(rung), `missing rung: ${rung}`);
    }
  });

  it("carries all four carve-outs verbatim, so minimalism is explicitly suspended for them", () => {
    for (const carveout of ["input validation at trust boundaries", "error handling that prevents data loss", "security", "accessibility"]) {
      assert.ok(PONYTAIL_RULESET_TEXT.includes(carveout), `missing carve-out: ${carveout}`);
    }
  });

  it("contains no volatile content (T17.1 — every head block must be freezable at boot)", () => {
    assert.deepEqual(detectVolatile(assemblePonytailHead()), []);
  });

  it("is deterministic — repeated calls are byte-identical", () => {
    assert.equal(assemblePonytailHead(), assemblePonytailHead());
  });
});

describe("resolvePonytailAndSpecialistHeads — replace vs append", () => {
  it("with no instructions: the default ladder, and no specialist block", () => {
    const heads = resolvePonytailAndSpecialistHeads(undefined);
    assert.equal(heads.ponytail, assemblePonytailHead());
    assert.equal(heads.specialist, "");
    assert.equal(heads.replaced, false);
  });

  it("with plain instructions (no marker): APPEND — ladder unchanged, specialist's text as its own block after it", () => {
    const heads = resolvePonytailAndSpecialistHeads("Prefer the smallest correct change.");
    assert.equal(heads.ponytail, assemblePonytailHead());
    assert.equal(heads.specialist, `${SPECIALIST_HEADING}\nPrefer the smallest correct change.`);
    assert.equal(heads.replaced, false);
  });

  it("with the marker as the first line: REPLACE — the marker's text stands in for the whole ponytail block, no separate specialist block", () => {
    const heads = resolvePonytailAndSpecialistHeads(`${PONYTAIL_REPLACE_MARKER}\nDeliberate fully; weigh alternatives before committing.`);
    assert.equal(heads.ponytail, `${PONYTAIL_HEADING}\nDeliberate fully; weigh alternatives before committing.`);
    assert.equal(heads.specialist, "");
    assert.equal(heads.replaced, true);
    assert.equal(heads.ponytail.includes("Does this need to be built at all?"), false);
  });

  it("isPonytailReplacement is true only when the marker is the literal first line", () => {
    assert.equal(isPonytailReplacement(`${PONYTAIL_REPLACE_MARKER}\nsomething`), true);
    assert.equal(isPonytailReplacement(`not the marker\n${PONYTAIL_REPLACE_MARKER}`), false);
    assert.equal(isPonytailReplacement("Prefer the smallest correct change."), false);
    assert.equal(isPonytailReplacement(""), false);
  });
});
