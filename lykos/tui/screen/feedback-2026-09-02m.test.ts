// The thirteenth 2026-09-02 UI feedback round, four numbered items, one
// describe each. Item 2 gets the most tests: its screenshot is a
// formatting-test table where six of eleven rows rendered their own source
// instead of what it means, and each of those six is its own assertion
// here.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderMarkdownLines } from "./markdown.js";
import { renderDiffLines, extractFullDiff } from "./diff.js";
import { renderScreenBlock, toScrollbackBlock } from "./blocks.js";
import { resolveTheme } from "../theme/resolve.js";
import { S0_HELP } from "../renderers/conversation.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

function stripAnsi(v: string): string {
  return v.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

/** What the reader actually sees, markers and escapes gone. */
function plainOf(md: string): string {
  return renderMarkdownLines(md, 100, color, "speech")
    .map((l) => l.plain)
    .join("\n");
}

function styledOf(md: string): string {
  return renderMarkdownLines(md, 100, color, "speech")
    .map((l) => l.styled)
    .join("\n");
}

describe("round thirteen, item 2: every row of the formatting table renders as what it means", () => {
  it("emphasis, from the three rows that already worked — unchanged by the rewrite", () => {
    assert.equal(plainOf("**bold**"), "bold");
    assert.equal(plainOf("*italic*"), "italic");
    assert.equal(plainOf("***bold italic***"), "bold italic");
  });

  it("<u>underline</u> renders as underlined text, not as literal angle brackets", () => {
    assert.equal(plainOf("<u>underline</u>"), "underline");
    assert.match(styledOf("<u>underline</u>"), /\x1b\[4m/);
  });

  it("<u>**u + bold**</u> is underlined AND bold at once", () => {
    assert.equal(plainOf("<u>**u + bold**</u>"), "u + bold");
    const styled = styledOf("<u>**u + bold**</u>");
    assert.match(styled, /\x1b\[1m/, "bold");
    assert.match(styled, /\x1b\[4m/, "underline");
  });

  it("a link's label is markdown in its own right — bold and italic inside one are rendered, not printed", () => {
    assert.equal(plainOf("[**bold link**](https://example.com)"), "bold link[1]");
    assert.equal(plainOf("[*italic link*](https://example.com)"), "italic link[1]");
    assert.match(styledOf("[**bold link**](https://example.com)"), /\x1b\[1m/);
    assert.match(styledOf("[*italic link*](https://example.com)"), /\x1b\[3m/);
  });

  it("a plain link is unchanged — label plus its [n] marker, still one click target", () => {
    assert.equal(plainOf("[link](https://example.com)"), "link[1]");
  });

  it("markup inside a code span stays literal, and the padding spaces are dropped", () => {
    assert.equal(plainOf("` inline code `"), "inline code");
    // CommonMark: a code span's content is literal text. A link written
    // inside backticks is a link being SHOWN, not a link.
    assert.equal(plainOf("` [code link](https://example.com) `"), "[code link](https://example.com)");
  });

  it("the fully mixed row — underline, bold and a link together — renders as all three", () => {
    assert.equal(plainOf("<u>**[u bold link](https://example.com)**</u>"), "u bold link[1]");
    const styled = styledOf("<u>**[u bold link](https://example.com)**</u>");
    assert.match(styled, /\x1b\[1m/, "bold");
    assert.match(styled, /\x1b\[4m/, "underline");
  });

  it("strikethrough still works, and the other HTML tags map to the styles they mean", () => {
    assert.equal(plainOf("~~strike~~"), "strike");
    assert.match(styledOf("<b>x</b>"), /\x1b\[1m/);
    assert.match(styledOf("<i>x</i>"), /\x1b\[3m/);
    assert.match(styledOf("<del>x</del>"), /\x1b\[9m/);
    assert.equal(plainOf("<code>**not bold**</code>"), "**not bold**");
  });

  it("an unknown tag is left exactly as the model wrote it — this is not an HTML renderer", () => {
    assert.equal(plainOf("<script>x</script>"), "<script>x</script>");
    assert.equal(plainOf("<div>y</div>"), "<div>y</div>");
  });

  it("the space between two words of one span carries that span's styling, so an underline is not broken into pieces", () => {
    const styled = styledOf("<u>two words</u>");
    // One underline region, not one per word: the gap must not close and
    // reopen it.
    assert.equal(styled.split("\x1b[4m").length - 1, 1);
  });

  it("a table cell renders the same as a paragraph does — the screenshot was a table", () => {
    const table = ["| Format | Cell |", "| --- | --- |", "| Underline | <u>underline</u> |", "| Link + bold | [**bold link**](https://example.com) |"].join("\n");
    const plain = renderMarkdownLines(table, 100, color, "speech")
      .map((l) => stripAnsi(l.styled))
      .join("\n");
    assert.match(plain, /underline/);
    assert.doesNotMatch(plain, /<u>/, "the tag itself must not survive into a cell");
    assert.doesNotMatch(plain, /\*\*/, "nor the bold markers inside a link label");
  });

  it("the no-colour surface is untouched: raw markdown, because the markers are all the reader has left", () => {
    const lines = renderMarkdownLines("<u>**u + bold**</u>", 100, mono, "speech");
    assert.equal(lines.map((l) => l.plain).join("\n"), "<u>**u + bold**</u>");
  });
});

describe("round thirteen, item 1: an edit says which file, and where it starts and ends", () => {
  const patch = ["--- a/src/one.ts", "+++ b/src/one.ts", "@@ -1,2 +1,2 @@", "-old", "+new"].join("\n");

  it("the diff is bracketed by an opening and a closing rule", () => {
    const diff = extractFullDiff("edit", { path: "src/one.ts" }, { patch })!;
    const lines = renderDiffLines(diff, { width: 60, theme: mono });
    assert.ok(stripAnsi(lines[0]!).startsWith("┌"), `opening rule missing: ${JSON.stringify(lines[0])}`);
    assert.ok(stripAnsi(lines.at(-1)!).startsWith("└"), `closing rule missing: ${JSON.stringify(lines.at(-1))}`);
  });

  it("the opening rule names the file and the +N/-M counts, and fills the width", () => {
    const diff = extractFullDiff("edit", { path: "src/one.ts" }, { patch })!;
    const [head] = renderDiffLines(diff, { width: 60, theme: mono });
    assert.match(stripAnsi(head!), /src\/one\.ts/);
    assert.match(stripAnsi(head!), /\+1\/-1/);
    assert.equal(stripAnsi(head!).length, 60);
  });

  it("a tool that names its path argument something else still shows the file, not the tool name", () => {
    for (const args of [{ file_path: "src/two.ts" }, { filePath: "src/two.ts" }, { file: "src/two.ts" }]) {
      const diff = extractFullDiff("edit", { ...args, edits: [{ oldText: "a", newText: "b" }] }, undefined)!;
      assert.equal(diff.path, "src/two.ts", JSON.stringify(args));
    }
  });

  it("with no path anywhere in the arguments, the patch's own +++ header is used before falling back to the tool name", () => {
    const diff = extractFullDiff("apply_patch", {}, { patch })!;
    assert.equal(diff.path, "src/one.ts", "git's a/ and b/ prefixes are stripped");
    const noHeader = extractFullDiff("apply_patch", {}, { patch: "@@ -1 +1 @@\n-a\n+b" })!;
    assert.equal(noHeader.path, "apply_patch", "the tool name is the last resort, not the second");
  });
});

describe("round thirteen, item 3: an answer can be copied", () => {
  it("a finished answer carries a click-to-copy hint", () => {
    const lines = renderScreenBlock({ id: "a", kind: "speech", text: "the answer" }, { width: 60, theme: mono });
    assert.ok(lines.some((l) => l.includes("click to copy")), lines.join("|"));
  });

  it("a streaming answer does not — the hint would walk down the screen on every delta", () => {
    const lines = renderScreenBlock({ id: "a", kind: "speech", text: "half a sen", streaming: true }, { width: 60, theme: mono });
    assert.equal(lines.some((l) => l.includes("click to copy")), false);
  });

  it("clicking the hint yields the block's own SOURCE text, not the wrapped, bulleted screen text", () => {
    const source = "**bold** answer with a [link](https://example.com)";
    const block = toScrollbackBlock({ id: "a", kind: "speech", text: source }, mono);
    const lines = block.render(40);
    const regions = block.regionsFor!(lines)!;
    const copy = regions.flatMap((r) => r ?? []).find((r) => r.action.kind === "copyText");
    assert.ok(copy, "no copy region found");
    assert.equal(copy!.action.kind === "copyText" && copy!.action.text, source);
  });

  it("the help text names both ways out, since Lykos itself is what disables the terminal's own selection", () => {
    assert.match(S0_HELP, /Shift-drag/);
    assert.match(S0_HELP, /click to copy/);
    assert.match(S0_HELP, /\/copy\s+copy the last answer to the clipboard/);
  });
});
