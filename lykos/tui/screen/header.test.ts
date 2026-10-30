import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "../theme/resolve.js";
import { backHoverLabel, backLabel, headerBackSpan, renderHeaderLine, type ScreenHeaderInfo } from "./header.js";

const mono = resolveTheme("mono", "none", "unicode");

/** ANSI-free view of a rendered row. */
const strip = (line: string): string => line.replace(/\[[0-9;]*m/g, "");

function info(overrides: Partial<ScreenHeaderInfo> = {}): ScreenHeaderInfo {
  return {
    product: "LYKOS",
    version: "0.0.1",
    model: "deepseek-v4-flash",
    cwd: "~/Workspace/Lykos",
    branch: "master",
    sessionId: "abc12345-xyz",
    executionShape: "standalone",
    ...overrides,
  };
}

describe("T42.2: the header line", () => {
  it("puts product, version, model and cwd(branch) on the left", () => {
    const line = renderHeaderLine(info(), mono, 120);
    assert.match(line, /^LYKOS · 0\.0\.1 · deepseek-v4-flash · ~\/Workspace\/Lykos \(master\)/);
  });

  it("right-aligns a short session id and the execution shape", () => {
    const line = renderHeaderLine(info(), mono, 120);
    assert.match(line, /abc12345 {2}standalone$/);
  });

  it("drops the right block whole rather than truncating it into fragments", () => {
    const line = renderHeaderLine(info({ cwd: "~/very/long/path/that/eats/most/of/the/width/available/here" }), mono, 40);
    assert.ok(!line.includes("standalone"), "right block dropped, not mangled, when there is no room");
  });

  it("no branch omits the parens", () => {
    const line = renderHeaderLine(info({ branch: null }), mono, 120);
    assert.match(line, /~\/Workspace\/Lykos(?! \()/);
  });

  it("specialists ticket 04: shows the active specialist in the right-aligned block, and omits it entirely when absent", () => {
    const withSpecialist = strip(renderHeaderLine(info({ specialist: "deliberate" }), mono, 120));
    assert.match(withSpecialist, /specialist:deliberate/);
    const withoutSpecialist = strip(renderHeaderLine(info(), mono, 120));
    assert.ok(!withoutSpecialist.includes("specialist:"), "no specialist selected must render exactly as it always has");
  });
});

describe("the back affordance (T114)", () => {
  it("is absent unless the header asks for it", () => {
    assert.equal(headerBackSpan(info(), mono), null);
    assert.ok(!renderHeaderLine(info(), mono, 120).includes("sessions"));
  });

  it("sits at column 0 so it survives truncation, and its span covers the hovered label", () => {
    const withBack = info({ back: true });
    const span = headerBackSpan(withBack, mono);
    // 2026-09-07 (UI feedback item 6): the span is sized to the EXPANDED
    // label in both states, so the pointer cannot fall out of the target by
    // moving right inside the button it just opened.
    assert.deepEqual(span, { colStart: 0, colEnd: backHoverLabel(mono).length });

    const line = renderHeaderLine(withBack, mono, 120);
    const plain = line.replace(/\[[0-9;]*m/g, "");
    assert.ok(plain.startsWith(backLabel(mono)), `expected the affordance first, got: ${plain}`);
  });

  it("expands into a sentence when hovered, and gives the row back when it is not", () => {
    const cold = strip(renderHeaderLine(info({ back: true }), mono, 120));
    const hot = strip(renderHeaderLine(info({ back: true, backHovered: true }), mono, 120));
    assert.ok(cold.startsWith("‹‹‹"), cold);
    assert.ok(cold.includes("LYKOS"), "the header reads normally when the pointer is elsewhere");
    assert.ok(hot.startsWith(backHoverLabel(mono)), hot);
    // Item 6's actual complaint: the hovered button used to blank the row by
    // padding its background out to the full header width. It now REPLACES
    // the left-hand segments with its own sentence and leaves the
    // right-aligned block alone, so the session id is still there.
    assert.ok(!hot.includes("LYKOS"), "the hovered button takes the left side");
    assert.ok(hot.includes("abc12345"), "the right-aligned block survives the hover");
  });

  it("falls back to ascii glyphs on an ascii theme", () => {
    const ascii = resolveTheme("mono", "none", "ascii");
    assert.equal(backLabel(ascii), "<<<");
    assert.equal(backHoverLabel(ascii), "<<< return to sessions");
    assert.ok(renderHeaderLine(info({ back: true }), ascii, 120).includes("<<<"));
  });

  it("does not push the session id off a wide header", () => {
    const line = renderHeaderLine(info({ back: true }), mono, 120);
    const plain = line.replace(/\[[0-9;]*m/g, "");
    assert.ok(plain.includes("abc12345"), "the right-aligned block should still fit at 120 columns");
  });
});
