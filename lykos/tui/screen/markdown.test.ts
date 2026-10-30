import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "../theme/resolve.js";
import { renderMarkdownLines } from "./markdown.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

const ANSI = /\x1b\[[0-9;]*m/g;

function plainOf(lines: ReturnType<typeof renderMarkdownLines>): string[] {
  return lines.map((l) => l.plain);
}

describe("renderMarkdownLines — **bold**", () => {
  it("wraps a bold span in SGR 1/22, not a colour escape, so it composes with an outer background", () => {
    const [line] = renderMarkdownLines("this is **bold** text", 80, color, "speech");
    assert.match(line!.styled, /\x1b\[1m/);
    assert.match(line!.styled, /\x1b\[22m/);
    assert.doesNotMatch(line!.styled, /\x1b\[22m.*\x1b\[0m.*bold/, "bold should not be followed by a full RESET mid-line");
  });

  it("the plain line is what the reader actually sees — markers removed, not retained", () => {
    const [line] = renderMarkdownLines("this is **bold** text", 80, color, "speech");
    // Changed 2026-09-02 round six, item 2: spans are now parsed off the
    // UNWRAPPED line and the wrap runs over the parsed runs, so `plain` is
    // the marker-free text the terminal shows rather than the raw source.
    // That is also what makes it a correct width measurement — the old
    // value overstated every line carrying a span by 4 columns per span.
    assert.equal(line!.plain, "this is bold text");
  });

  it("under the mono theme (colour capability none), markers pass through completely untouched", () => {
    const [line] = renderMarkdownLines("this is **bold** text", 80, mono, "speech");
    assert.equal(line!.styled, "this is **bold** text");
    assert.doesNotMatch(line!.styled, /\x1b\[/);
  });
});

describe("renderMarkdownLines — `inline code`", () => {
  it("gets the code token's colour, distinct from the surrounding text", () => {
    const [line] = renderMarkdownLines("run `npm test` now", 80, color, "speech");
    assert.match(line!.styled, /\x1b\[38;2;/); // some truecolor escape is present
    assert.doesNotMatch(line!.styled, /`/, "backticks are consumed once styled");
  });

  it("multiple spans on one line are all styled", () => {
    const [line] = renderMarkdownLines("`a` and `b` and **c**", 80, color, "speech");
    const escapeCount = (line!.styled.match(ANSI) ?? []).length;
    assert.ok(escapeCount >= 4, `expected at least 4 escapes (2 code spans + bold on/off), got ${escapeCount}`);
  });
});

describe("renderMarkdownLines — fenced code blocks", () => {
  it("a fenced block is rendered whole in the code token, never word-wrapped", () => {
    const text = "before\n```\nconst x = 1;\nconst y = 2;\n```\nafter";
    const lines = renderMarkdownLines(text, 80, color, "speech");
    const plain = plainOf(lines);
    assert.ok(plain.includes("const x = 1;"));
    assert.ok(plain.includes("const y = 2;"));
    // The fence markers themselves are still present as their own lines.
    assert.equal(plain.filter((l) => l.trim().startsWith("```")).length, 2);
  });

  it("~~~ fences work the same as backtick fences", () => {
    const lines = renderMarkdownLines("~~~\ncode here\n~~~", 80, color, "speech");
    assert.ok(plainOf(lines).includes("code here"));
  });
});

describe("renderMarkdownLines — list markers get a distinct colour", () => {
  it("a numbered list marker is styled separately from the body text", () => {
    const [line] = renderMarkdownLines("1. first item", 80, color, "speech");
    // The marker "1. " should be wrapped in its own accent escape, ending before "first"
    assert.match(line!.styled, /\x1b\[38;2;\d+;\d+;\d+m1\. \x1b\[0m/);
  });

  it("a bullet marker (-, *, +) is styled the same way", () => {
    for (const marker of ["-", "*", "+"]) {
      const [line] = renderMarkdownLines(`${marker} item`, 80, color, "speech");
      assert.match(line!.styled, new RegExp(`\\x1b\\[38;2;\\d+;\\d+;\\d+m\\${marker} \\x1b\\[0m`));
    }
  });

  it("continuation lines of a wrapped list item are indented to match, not re-marked", () => {
    const lines = renderMarkdownLines("1. " + "word ".repeat(20).trim(), 20, color, "speech");
    assert.ok(lines.length > 1, "the item should have wrapped onto more than one line");
    assert.ok(lines[1]!.plain.startsWith("   "), `continuation line should be indented, got "${lines[1]!.plain}"`);
    assert.doesNotMatch(lines[1]!.plain, /^\d+\./, "continuation line must not repeat the marker");
  });

  it("under mono, the literal marker still reads as a list — no colour needed to tell", () => {
    const [line] = renderMarkdownLines("1. first item", 80, mono, "speech");
    assert.equal(line!.styled, "1. first item");
  });
});

describe("renderMarkdownLines — plain text with no markdown is unaffected", () => {
  it("wraps the same way wrapPlain does, with speech styling applied", () => {
    const lines = renderMarkdownLines("just a normal sentence", 80, color, "speech");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.plain, "just a normal sentence");
  });
});
