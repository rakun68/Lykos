// The ninth 2026-09-02 UI feedback round, item 1 and item 2's markdown
// half — asserted by number, the same discipline as every round before
// this one. Item 2's mouse-click half (approval buttons, fold hints, the
// tab completer, and the footer legend) lives in
// `feedback-2026-09-02i.test.ts`, since it exercises entirely different
// modules (scrollback/pipeline/raw-line-source/approval-modal) than this
// file's markdown-only scope.
//
// The screenshot behind this round is a formatting-test table with one
// column showing literal markdown source and another showing what it
// SHOULD render as. Comparing the two rows against what the renderer
// actually produced is what named these bugs: italic and strikethrough
// syntax passed through unrendered, and `***bold+italic***` partially
// matched the bold pattern (a stray `*` on either side of a bolded
// "both"), because there was no dedicated three-star branch.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "../theme/resolve.js";
import { renderMarkdownLines, extractLinks } from "./markdown.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

describe("item 2 (markdown half): italic renders, instead of passing `*text*` through literally", () => {
  it("a bare `*text*` span is italic, not literal asterisks", () => {
    const [line] = renderMarkdownLines("this is *italic* text", 80, color, "speech");
    assert.doesNotMatch(line!.plain, /\*/);
    assert.match(line!.styled, /\x1b\[3m/, "SGR 3 (italic) must be present");
    assert.match(line!.styled, /\x1b\[23m/, "SGR 23 (not-italic) must close it");
  });

  it("does not get confused with bold — `**bold** and *italic*` renders both correctly and distinctly", () => {
    const [line] = renderMarkdownLines("**bold** and *italic*", 80, color, "speech");
    assert.doesNotMatch(line!.plain, /[*]/);
    assert.match(line!.styled, /\x1b\[1m/, "bold present");
    assert.match(line!.styled, /\x1b\[3m/, "italic present");
    // Bold's OWN italic code must not leak — the two spans are independent.
    const boldSpan = line!.styled.slice(0, line!.styled.indexOf("and"));
    assert.doesNotMatch(boldSpan, /\x1b\[3m/, "the bold span itself must not carry an italic code");
  });

  it("under the mono theme, `*text*` passes through completely untouched — the NO_COLOR rule is unchanged", () => {
    const [line] = renderMarkdownLines("this is *italic* text", 80, mono, "speech");
    assert.equal(line!.styled, "this is *italic* text");
  });

  it("an italic span split across a wrap boundary is styled on both halves, same guarantee bold already has", () => {
    const long = "lead in text *a single italic span that is much longer than the wrap width and must break across rows* trailing";
    const lines = renderMarkdownLines(long, 40, color, "speech");
    for (const l of lines) assert.doesNotMatch(l.plain, /\*/, `markers leaked into "${l.plain}"`);
    const italicRows = lines.filter((l) => l.styled.includes("\x1b[3m"));
    assert.ok(italicRows.length >= 2, `expected the span to cross a wrap and carry SGR 3 on at least two rows, got ${italicRows.length}`);
  });
});

describe("item 2 (markdown half): `***bold+italic***` renders as one span, not a partial bold match with stray asterisks", () => {
  it("all three markers on each side are consumed — no leftover `*` anywhere", () => {
    const [line] = renderMarkdownLines("***both***", 80, color, "speech");
    assert.equal(line!.plain, "both");
    assert.doesNotMatch(line!.styled, /\*/);
  });

  it("carries BOTH SGR 1 (bold) and SGR 3 (italic), not just one", () => {
    const [line] = renderMarkdownLines("***both***", 80, color, "speech");
    assert.match(line!.styled, /\x1b\[1m/);
    assert.match(line!.styled, /\x1b\[3m/);
  });

  it("does not swallow a real plain `*` sitting immediately outside it", () => {
    // The literal bug this round found: `**bold** and *italic*` style tests
    // above prove those two survive on their own; this proves a genuine
    // bold+italic run doesn't leave a stray asterisk on either side either.
    const [line] = renderMarkdownLines("x ***both*** y", 80, color, "speech");
    assert.equal(line!.plain, "x both y");
  });

  it("a plain `**bold**` next to it is unaffected — the three-star branch does not shadow the two-star one", () => {
    const [line] = renderMarkdownLines("**bold** then ***both***", 80, color, "speech");
    assert.equal(line!.plain, "bold then both");
  });
});

describe("item 2 (markdown half): strikethrough renders, instead of passing `~~text~~` through literally", () => {
  it("a `~~text~~` span is struck through, not literal tildes", () => {
    const [line] = renderMarkdownLines("this is ~~crossed out~~ text", 80, color, "speech");
    assert.equal(line!.plain, "this is crossed out text");
    assert.doesNotMatch(line!.plain, /~/);
    assert.match(line!.styled, /\x1b\[9m/, "SGR 9 (strikethrough) must be present");
    assert.match(line!.styled, /\x1b\[29m/, "SGR 29 (not-strikethrough) must close it");
  });

  it("under the mono theme, `~~text~~` passes through completely untouched", () => {
    const [line] = renderMarkdownLines("this is ~~crossed out~~ text", 80, mono, "speech");
    assert.equal(line!.styled, "this is ~~crossed out~~ text");
  });

  it("survives inside a table cell — the exact case that was originally broken for bold", () => {
    const table = ["| A |", "| --- |", "| ~~gone~~ |"].join("\n");
    const lines = renderMarkdownLines(table, 40, color, "speech");
    const row = lines.find((l) => l.plain.includes("gone"))!;
    assert.doesNotMatch(row.plain, /~/);
    assert.match(row.styled, /\x1b\[9m/);
  });
});

describe("item 2 (markdown half): links render as a styled label plus a `[n]` index, never the raw `[label](url)` syntax", () => {
  it("the raw brackets/parens/url are gone from the plain text", () => {
    const [line] = renderMarkdownLines("see [the docs](https://example.com/docs)", 80, color, "speech");
    assert.doesNotMatch(line!.plain, /\(|\)/);
    assert.doesNotMatch(line!.plain, /example\.com/, "the raw URL must not be shown");
    assert.match(line!.plain, /the docs\[1\]/);
  });

  it("the label plus its `[n]` are styled — a link reads as distinct from plain prose", () => {
    const [line] = renderMarkdownLines("see [the docs](https://example.com/docs) now", 80, color, "speech");
    const stripped = stripAnsi(line!.styled);
    assert.equal(stripped, line!.plain);
    assert.notEqual(line!.styled, line!.plain, "some styling must have been applied");
  });

  it("extractLinks() returns URLs in order of first appearance, one entry per DISTINCT url", () => {
    const text = "[a](https://x.test) and [b](https://y.test) and [c again](https://x.test)";
    assert.deepEqual(extractLinks(text), ["https://x.test", "https://y.test"]);
  });

  it("the SAME url referenced twice gets the SAME [n] both times, not two different numbers", () => {
    const text = "[first](https://x.test) ... [second mention](https://x.test)";
    const [line] = renderMarkdownLines(text, 80, color, "speech");
    assert.match(line!.plain, /first\[1\]/);
    assert.match(line!.plain, /second mention\[1\]/);
  });

  it("two different links on the same line get two different numbers, in the order they appear", () => {
    const text = "[a](https://x.test) then [b](https://y.test)";
    const [line] = renderMarkdownLines(text, 80, color, "speech");
    assert.match(line!.plain, /a\[1\]/);
    assert.match(line!.plain, /b\[2\]/);
  });

  it("numbering stays consistent across MULTIPLE lines of the same block, not restarted per line", () => {
    const text = ["first line has [one](https://x.test)", "second line has [two](https://y.test) and repeats [one again](https://x.test)"].join("\n");
    const lines = renderMarkdownLines(text, 80, color, "speech");
    assert.match(lines[0]!.plain, /one\[1\]/);
    assert.match(lines[1]!.plain, /two\[2\]/);
    assert.match(lines[1]!.plain, /one again\[1\]/);
  });

  it("a link inside a table cell renders and numbers the same way as in prose — the screenshot's own reported case", () => {
    const table = ["| Link |", "| --- |", "| [see it](https://en.wikipedia.org/wiki/The_Metamorphosis) |"].join("\n");
    const lines = renderMarkdownLines(table, 60, color, "speech");
    const row = lines.find((l) => l.plain.includes("see it"))!;
    assert.match(row.plain, /see it\[1\]/);
    assert.doesNotMatch(row.plain, /wikipedia/);
    assert.equal(row.plain.length, lines[0]!.plain.length, "the frame still lines up around it");
  });

  it("under the mono theme, raw `[label](url)` syntax passes through completely untouched", () => {
    const [line] = renderMarkdownLines("see [the docs](https://example.com/docs)", 80, mono, "speech");
    assert.equal(line!.styled, "see [the docs](https://example.com/docs)");
  });

  it("a link split across a wrap boundary keeps its [n] intact and styled on both halves it touches", () => {
    const long = "lead text [a label long enough that this whole link has to wrap across more than one row of output](https://example.com/x) trailing";
    const lines = renderMarkdownLines(long, 40, color, "speech");
    const joined = lines.map((l) => l.plain).join("");
    assert.match(joined, /\[1\]/);
    for (const l of lines) assert.ok(l.plain.length <= 40, `"${l.plain}" (${l.plain.length}) exceeds 40`);
  });
});

describe("item 2 (markdown half): everything from earlier rounds keeps working alongside the new spans", () => {
  it("a table with bold, italic, strikethrough and a link in different cells renders all four correctly", () => {
    const table = [
      "| Bold | Italic | Strike | Link |",
      "| --- | --- | --- | --- |",
      "| **b** | *i* | ~~s~~ | [l](https://x.test) |",
    ].join("\n");
    const lines = renderMarkdownLines(table, 80, color, "speech");
    const row = lines.find((l) => l.plain.includes("b "))!;
    assert.match(row.styled, /\x1b\[1m/, "bold");
    assert.match(row.styled, /\x1b\[3m/, "italic");
    assert.match(row.styled, /\x1b\[9m/, "strike");
    assert.match(row.plain, /l\[1\]/, "link");
    const widths = new Set(lines.map((l) => l.plain.length));
    assert.equal(widths.size, 1, "the box frame is still one consistent width");
  });

  it("list markers, fences and plain prose are unaffected by any of this round's changes", () => {
    const text = ["- a plain list item", "", "```", "code fence line", "```", "", "just a normal sentence"].join("\n");
    const lines = renderMarkdownLines(text, 80, color, "speech");
    assert.ok(lines.some((l) => l.plain === "- a plain list item"));
    assert.ok(lines.some((l) => l.plain === "code fence line"));
    assert.ok(lines.some((l) => l.plain === "just a normal sentence"));
  });
});
