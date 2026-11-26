import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseOutcomeAnswer, renderOutcomePrompt, renderOutcomeResult } from "./outcome.js";

describe("T52.1: the question", () => {
  it("offers exactly four answers, and the agent's opinion is not one of them", () => {
    const text = renderOutcomePrompt({ sessionId: "1a2b3c4d5e6f", suggestedCmd: "npm test" });
    assert.match(text, /did that work\?/);
    assert.match(text, /\[c\] run `npm test`/);
    assert.match(text, /\[y\] yes/);
    assert.match(text, /\[n\] no/);
    assert.match(text, /\[s\] skip/);
    // The property that matters most in this file: nothing here invites the
    // model's own verdict. `agent_claim` exists so it can be excluded.
    assert.ok(!/agent/i.test(text), "the agent's own opinion must never be offered as an option");
  });

  it("names skip as legitimate rather than as a refusal", () => {
    const text = renderOutcomePrompt({ sessionId: "abc" });
    assert.match(text, /legitimate answer/);
  });

  it("falls back to a generic command line when the project suggests none", () => {
    const text = renderOutcomePrompt({ sessionId: "abc" });
    assert.match(text, /\[c\] run a verification command/);
  });

  it("shows a short session id, not a full uuid", () => {
    const text = renderOutcomePrompt({ sessionId: "0123456789abcdef0123", suggestedCmd: "npm test" });
    assert.match(text, /session 01234567\b/);
  });

  it("respects the ascii glyph set", () => {
    const text = renderOutcomePrompt({ sessionId: "abc", glyphs: { diamond: "*" } });
    assert.ok(text.includes("* did that work?"));
    assert.ok(!text.includes("◆"));
  });
});

describe("T52.1: the answer", () => {
  it("y/n/s and their long forms, case-insensitively", () => {
    assert.deepEqual(parseOutcomeAnswer("y"), { kind: "human", worked: true });
    assert.deepEqual(parseOutcomeAnswer("YES"), { kind: "human", worked: true });
    assert.deepEqual(parseOutcomeAnswer("n"), { kind: "human", worked: false });
    assert.deepEqual(parseOutcomeAnswer(" No "), { kind: "human", worked: false });
    assert.deepEqual(parseOutcomeAnswer("s"), { kind: "skip" });
    assert.deepEqual(parseOutcomeAnswer("skip"), { kind: "skip" });
  });

  it("a bare c uses the suggested command", () => {
    assert.deepEqual(parseOutcomeAnswer("c", "npm test"), { kind: "command", cmd: "npm test" });
  });

  it("a bare c with NO suggestion is unparseable, never a silent skip", () => {
    // Turning "run the tests" into "record nothing" without saying so is the
    // exact class of quiet wrong answer T52 exists to prevent.
    assert.equal(parseOutcomeAnswer("c"), null);
  });

  it("c <command> runs that command", () => {
    assert.deepEqual(parseOutcomeAnswer("c npm run test:ci", "npm test"), {
      kind: "command",
      cmd: "npm run test:ci",
    });
  });

  it("a typed command is taken as one when it looks like a command", () => {
    assert.deepEqual(parseOutcomeAnswer("npm test"), { kind: "command", cmd: "npm test" });
    assert.deepEqual(parseOutcomeAnswer("./scripts/check"), { kind: "command", cmd: "./scripts/check" });
  });

  it("a bare word is a fumbled keystroke, not a command to run against the repo", () => {
    assert.equal(parseOutcomeAnswer("yep"), null);
    assert.equal(parseOutcomeAnswer("q"), null);
  });

  it("an empty line asks again", () => {
    assert.equal(parseOutcomeAnswer(""), null);
    assert.equal(parseOutcomeAnswer("   "), null);
  });

  it("EOF is a skip — an unanswered outcome and a declined one are the same row", () => {
    assert.deepEqual(parseOutcomeAnswer(null), { kind: "skip" });
  });
});

describe("T52.1: the report", () => {
  it("names the command and its exit code for a verification_command outcome", () => {
    const text = renderOutcomeResult({
      status: "recorded",
      outcome: "success",
      outcomeSource: "verification_command",
      exitCode: 0,
      cmd: "npm test",
    });
    assert.match(text, /outcome=success/);
    assert.match(text, /verification_command \(`npm test`, exit 0\)/);
  });

  it("says human without inventing a command", () => {
    const text = renderOutcomeResult({ status: "recorded", outcome: "fail", outcomeSource: "human" });
    assert.match(text, /outcome=fail via human/);
    assert.ok(!text.includes("`"));
  });

  it("reports a skip and an error distinguishably", () => {
    assert.match(renderOutcomeResult({ status: "skipped", reason: "declined — stays NULL" }), /stays NULL/);
    assert.match(renderOutcomeResult({ status: "error", message: "boom" }), /could not record the outcome — boom/);
  });
});
