// The tenth 2026-09-02 UI feedback round, five numbered items following a
// screenshot of round nine's own footer glossary bugging out. Structured
// the same way as every round before it, one describe per numbered item.
//
// Item 3 (the glossary's own de-dupe-on-repeat-click behaviour) is not
// covered here: it lives in `session/interactive.ts`'s `handleClickAction`, a
// private closure inside `runOwningTheTerminal()` that no round has ever
// unit-tested directly — the same gap round nine's own tests left for
// `footerLegend`/`handleClickAction`. `ScreenPipeline.lastBlockId()`, the
// new primitive that de-dupe logic is built on, is tested here instead.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderScreenBlock, type ScreenBlock, type SystemPart } from "./blocks.js";
import { renderDiffLines, renderBashLines, extractFullDiff, type BashBlockInfo } from "./diff.js";
import { renderCompletionPopup, type Candidate } from "./completion.js";
import { renderMarkdownLines } from "./markdown.js";
import { ScreenPipeline } from "./pipeline.js";
import { resolveTheme } from "../theme/resolve.js";
import type { ApprovalView } from "../renderers/conversation.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function header() {
  return { product: "LYKOS", version: "0", model: "m", cwd: "/w", branch: null, sessionId: "s", executionShape: "standalone" };
}

describe("item 1: a multi-row `parts` system message no longer corrupts the terminal", () => {
  const rows: Array<[string, string]> = [
    ["A", "row one"],
    ["B", "row two"],
    ["C", "row three"],
  ];
  const parts: SystemPart[] = [{ text: "header\n", token: "dim" }];
  for (const [glyph, desc] of rows) parts.push({ text: `  ${glyph} `, token: "accent" }, { text: `${desc}\n`, token: "dim" });

  it("renders one array element per row — never a single element with an embedded \\n", () => {
    const lines = renderScreenBlock({ id: "s", kind: "system", text: "header", parts }, { width: 80, theme: color, expanded: false });
    // header + 3 rows + the trailing blank spacer `toScrollbackBlock` appends is not part of renderScreenBlock itself
    const content = lines.filter((l) => l.length > 0 || true);
    assert.equal(content.length, 4, `expected 4 lines (header + 3 rows), got ${content.length}: ${JSON.stringify(content)}`);
    for (const line of content) assert.ok(!line.includes("\n"), `a rendered line must never contain a literal newline: ${JSON.stringify(line)}`);
  });

  it("every row's text survives, in order, once ANSI is stripped", () => {
    const lines = renderScreenBlock({ id: "s", kind: "system", text: "header", parts }, { width: 80, theme: color, expanded: false });
    const plain = lines.map(stripAnsi);
    assert.match(plain[0]!, /header/);
    assert.match(plain[1]!, /A row one/);
    assert.match(plain[2]!, /B row two/);
    assert.match(plain[3]!, /C row three/);
  });

  it("a single-line `parts` message (the pre-existing /effort case) is unaffected — still exactly one line", () => {
    const single: SystemPart[] = [{ text: "effort is set to ", token: "dim" }, { text: "high", token: "danger" }];
    const lines = renderScreenBlock({ id: "s", kind: "system", text: "effort is set to high", parts: single }, { width: 80, theme: color, expanded: false });
    assert.equal(lines.length, 1);
    assert.match(stripAnsi(lines[0]!), /effort is set to high/);
  });
});

describe("item 4: clickable markers carry a persistent underline under colour, and none at all under mono", () => {
  it("an approval's [y]/[n]/[a]/[Esc] pills are underlined under colour, plain under mono", () => {
    const view: ApprovalView = { kind: "bash", summary: "run", detail: "ls" };
    const block: ScreenBlock = { id: "a", kind: "approval", approval: view };
    const colored = renderScreenBlock(block, { width: 60, theme: color, expanded: false }).join("\n");
    assert.match(colored, /\x1b\[4m[^]*\[y\][^]*\x1b\[24m/);
    const plain = renderScreenBlock(block, { width: 60, theme: mono, expanded: false }).join("\n");
    assert.doesNotMatch(plain, /\x1b\[4m/);
    assert.match(plain, /\[y\]/, "the literal bracket marker still reads under mono");
  });

  it("a fold hint is underlined under colour, plain under mono, and still names 'to expand'", () => {
    const diff = extractFullDiff("write_patch", {}, { patch: `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +100 @@\n${Array.from({ length: 100 }, (_, i) => `+l${i}`).join("\n")}` })!;
    const colored = renderDiffLines(diff, { width: 80, theme: color }).join("\n");
    assert.match(colored, /\x1b\[4m[^]*to expand[^]*\x1b\[24m/);
    const plain = renderDiffLines(diff, { width: 80, theme: mono }).join("\n");
    assert.doesNotMatch(plain, /\x1b\[4m/);
    assert.match(plain, /to expand/);
  });

  it("a tab-completion candidate row is underlined under colour, plain under mono", () => {
    const candidates: Candidate[] = [{ label: "/help", kind: "command", costClass: "local", description: "this list" }];
    const colored = renderCompletionPopup(candidates, { width: 60, theme: color }).join("\n");
    assert.match(colored, /\x1b\[4m/);
    const plain = renderCompletionPopup(candidates, { width: 60, theme: mono }).join("\n");
    assert.doesNotMatch(plain, /\x1b\[4m/);
    assert.match(plain, /\/help/);
  });

  it("a rendered link is underlined under colour; mono still shows the raw markdown untouched", () => {
    const [line] = renderMarkdownLines("see [docs](https://x.test)", 80, color, "speech");
    assert.match(line!.styled, /\x1b\[4m/);
    const [monoLine] = renderMarkdownLines("see [docs](https://x.test)", 80, mono, "speech");
    assert.doesNotMatch(monoLine!.styled, /\x1b\[4m/);
  });
});

describe("item 5: an expanded, foldable block shows a 'show less' hint too", () => {
  it("renderDiffLines: expanded and originally-foldable shows a collapse hint", () => {
    const diff = extractFullDiff("write_patch", {}, { patch: `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +100 @@\n${Array.from({ length: 100 }, (_, i) => `+l${i}`).join("\n")}` })!;
    const collapsed = renderDiffLines(diff, { width: 80, theme: mono, fold: { maxVisible: 40 } });
    assert.ok(collapsed.some((l) => l.includes("to expand")));
    assert.ok(!collapsed.some((l) => l.includes("to collapse")));
    const expanded = renderDiffLines(diff, { width: 80, theme: mono, fold: { maxVisible: 40, expanded: true } });
    assert.ok(!expanded.some((l) => l.includes("to expand")));
    assert.ok(expanded.some((l) => l.includes("to collapse")));
  });

  it("renderDiffLines: a diff that never needed folding shows neither hint, even when expanded is set", () => {
    const diff = extractFullDiff("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y" }] }, undefined)!;
    const lines = renderDiffLines(diff, { width: 80, theme: mono, fold: { expanded: true } });
    assert.ok(!lines.some((l) => l.includes("to expand") || l.includes("to collapse")));
  });

  it("renderBashLines: expanded and originally-foldable shows a collapse hint", () => {
    const bash: BashBlockInfo = { command: "seq 1 60", output: Array.from({ length: 60 }, (_, i) => `${i}`).join("\n"), exitCode: 0, sendToModel: false };
    const collapsed = renderBashLines(bash, { width: 80, theme: mono, expanded: false });
    assert.ok(collapsed.some((l) => l.includes("to expand")));
    assert.ok(!collapsed.some((l) => l.includes("to collapse")));
    const expanded = renderBashLines(bash, { width: 80, theme: mono, expanded: true });
    assert.ok(!expanded.some((l) => l.includes("to expand")));
    assert.ok(expanded.some((l) => l.includes("to collapse")));
  });

  it("renderBashLines: output short enough to never fold shows neither hint when expanded", () => {
    const bash: BashBlockInfo = { command: "echo hi", output: "hi", exitCode: 0, sendToModel: false };
    const lines = renderBashLines(bash, { width: 80, theme: mono, expanded: true });
    assert.ok(!lines.some((l) => l.includes("to expand") || l.includes("to collapse")));
  });

  it("renderApproval: expanded and originally-foldable shows a collapse hint", () => {
    const big = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const view: ApprovalView = { kind: "bash", summary: "run", detail: big };
    const block: ScreenBlock = { id: "a", kind: "approval", approval: view };
    const collapsed = renderScreenBlock(block, { width: 80, theme: mono, expanded: false });
    assert.ok(collapsed.some((l) => l.includes("to expand")));
    const expanded = renderScreenBlock(block, { width: 80, theme: mono, expanded: true });
    assert.ok(!expanded.some((l) => l.includes("to expand")));
    assert.ok(expanded.some((l) => l.includes("to collapse")));
  });
});

describe("ScreenPipeline.lastBlockId — the primitive round ten's de-dupe (item 3) is built on", () => {
  it("is undefined before anything has been pushed", () => {
    const frames: string[] = [];
    const pipeline = new ScreenPipeline({ width: 80, height: 24, theme: mono, header: header(), sink: { write: (f) => frames.push(f) } });
    assert.equal(pipeline.lastBlockId(), undefined);
  });

  it("tracks the most recently pushed block's id, even across mixed pushBlock/updateBlock calls", () => {
    const frames: string[] = [];
    const pipeline = new ScreenPipeline({ width: 80, height: 24, theme: mono, header: header(), sink: { write: (f) => frames.push(f) } });
    pipeline.pushBlock({ id: "one", kind: "system", text: "a" });
    assert.equal(pipeline.lastBlockId(), "one");
    pipeline.pushBlock({ id: "two", kind: "system", text: "b" });
    assert.equal(pipeline.lastBlockId(), "two");
    pipeline.updateBlock("one", { id: "one", kind: "system", text: "a2" });
    assert.equal(pipeline.lastBlockId(), "two", "updating an earlier block does not change what the TAIL is");
  });
});
