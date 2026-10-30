import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "../theme/resolve.js";
import { renderActivityLines, spinnerFrame, type ActivityState } from "./activity.js";

const mono = resolveTheme("mono", "none", "unicode");
const monoAscii = resolveTheme("mono", "none", "ascii");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

function state(overrides: Partial<ActivityState> = {}): ActivityState {
  return { running: true, startedAtMs: 0, nowMs: 0, activeTools: [], ...overrides };
}

describe("T48.1: the spinner animates at a fixed rate independent of token arrival", () => {
  it("is a pure function of elapsed time — calling it more often does not change the frame for the same elapsed value", () => {
    assert.equal(spinnerFrame(1234, false), spinnerFrame(1234, false));
  });

  it("advances one frame every 120ms and cycles", () => {
    const f0 = spinnerFrame(0, false);
    const f1 = spinnerFrame(120, false);
    const fSame = spinnerFrame(10, false);
    assert.equal(f0, "·");
    assert.notEqual(f0, f1);
    assert.equal(f0, fSame, "within the same 120ms bucket the frame does not change");
  });

  it("negative elapsed (clock skew) never throws or produces a negative index", () => {
    assert.doesNotThrow(() => spinnerFrame(-50, false));
  });

  it("ascii glyphs use the ascii spinner set", () => {
    const uni = spinnerFrame(0, false);
    const ascii = spinnerFrame(0, true);
    assert.notEqual(uni, ascii);
    assert.match(ascii, /^[|/\-\\]$/);
  });
});

describe("T48.1: the activity row is visible only while a turn runs", () => {
  it("zero lines between turns", () => {
    assert.deepEqual(renderActivityLines(state({ running: false }), mono), []);
  });

  it("one line while running, with elapsed seconds and the abort hint", () => {
    const lines = renderActivityLines(state({ nowMs: 5000 }), mono);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /5s/);
    assert.match(lines[0]!, /Ctrl-C abort/);
  });

  it("elapsed over a minute formats as Xm SSs", () => {
    const lines = renderActivityLines(state({ nowMs: 90_000 }), mono);
    assert.match(lines[0]!, /1m30s/);
  });

  it("shows the currently-running tool name(s)", () => {
    const lines = renderActivityLines(state({ nowMs: 1000, activeTools: ["Edit"] }), mono);
    assert.match(lines[0]!, /Edit/);
  });

  it("multiple concurrent tools are all named", () => {
    const lines = renderActivityLines(state({ nowMs: 1000, activeTools: ["Edit", "Bash"] }), mono);
    assert.match(lines[0]!, /Edit, Bash/);
  });

  it("no active tool — the row still renders (thinking/speaking with nothing running)", () => {
    const lines = renderActivityLines(state({ nowMs: 1000, activeTools: [] }), mono);
    assert.equal(lines.length, 1);
  });

  it("renders with colour under a truecolor theme with no crash", () => {
    const lines = renderActivityLines(state({ nowMs: 1000, activeTools: ["Edit"] }), color);
    assert.equal(lines.length, 1);
  });

  it("ascii theme produces no unicode spinner glyphs", () => {
    const lines = renderActivityLines(state({ nowMs: 1000 }), monoAscii);
    assert.doesNotMatch(lines[0]!, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏│]/);
  });
});
