import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "../theme/resolve.js";
import { extractFullDiff, foldDiff, renderBashLines, renderDiffLines, summarizeDiff, type DiffView } from "./diff.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

function bigPatch(lines: number): string {
  const body = Array.from({ length: lines }, (_, i) => `+line ${i}`).join("\n");
  return `diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -0,0 +${lines} @@\n${body}`;
}

describe("T45.1: real diff rendering — per-file header, hunk headers, +N/-M summary", () => {
  it("a 3-line edit shows every line", () => {
    const diff = extractFullDiff("edit", { path: "a.ts", edits: [{ oldText: "x", newText: "y\nz\nw" }] }, undefined)!;
    const lines = renderDiffLines(diff, { width: 80, theme: mono });
    // opening rule + 1 del + 3 add + closing rule (round thirteen, item 1:
    // every edit is bracketed so its scope is visible).
    assert.equal(lines.length, 1 + 1 + 3 + 1);
    assert.match(lines[0]!, /a\.ts/);
    assert.match(lines[0]!, /\+3\/-1/);
  });

  it("summarizeDiff counts additions and deletions separately", () => {
    const diff: DiffView = {
      path: "x",
      lines: [
        { kind: "add", text: "a" },
        { kind: "add", text: "b" },
        { kind: "del", text: "c" },
        { kind: "ctx", text: "d" },
      ],
    };
    assert.deepEqual(summarizeDiff(diff), { added: 2, removed: 1 });
  });

  it("hunk headers render distinct from add/del lines", () => {
    const diff = extractFullDiff("write_patch", {}, { patch: "@@ -1,2 +1,2 @@\n-old\n+new" })!;
    const lines = renderDiffLines(diff, { width: 80, theme: mono });
    assert.ok(lines.some((l) => l.startsWith("@@")));
  });
});

describe("T45.2: large diffs fold rather than truncate", () => {
  it("a 2000-line diff folds to a constant number of visible rows with a marker naming the hidden count", () => {
    const diff = extractFullDiff("write_patch", {}, { patch: bigPatch(2000) })!;
    assert.equal(diff.lines.length > 1900, true, "the parsed diff is NOT silently capped at parse time");
    const lines = renderDiffLines(diff, { width: 80, theme: mono });
    assert.ok(lines.length < 100, "rendering is folded, not 2000 rows");
    assert.ok(lines.some((l) => /\d+ more lines? folded/.test(l)));
  });

  it("expanded:true renders every line with no fold marker, but does show a collapse hint", () => {
    const diff = extractFullDiff("write_patch", {}, { patch: bigPatch(200) })!;
    const lines = renderDiffLines(diff, { width: 80, theme: mono, fold: { expanded: true } });
    assert.ok(!lines.some((l) => l.includes("folded")));
    // Round ten, item 5: "There is show more but not any show less
    // button." A diff that WOULD have folded still gets a hint once
    // expanded, so there is a way back — +1 for the opening rule (which
    // carries the path and summary), +1 for the "to collapse" hint, +1
    // for round thirteen's closing rule.
    assert.equal(lines.length, diff.lines.length + 3);
    assert.ok(lines.some((l) => l.includes("to collapse")));
  });

  it("foldDiff never folds a diff already under the limit", () => {
    const diff: DiffView = { path: "x", lines: [{ kind: "add", text: "one" }] };
    const folded = foldDiff(diff, { maxVisible: 40 });
    assert.equal(folded.hiddenCount, 0);
    assert.equal(folded.lines.length, 1);
  });
});

describe("T45.4: write on a new file is an all-additions diff with the real line count", () => {
  it("no 20-line cap — extractFullDiff returns every line", () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const diff = extractFullDiff("write", { path: "new.ts", content }, undefined)!;
    assert.equal(diff.lines.length, 500);
    assert.ok(diff.lines.every((l) => l.kind === "add"));
  });

  it("still folds for display like any other large diff", () => {
    const content = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    const diff = extractFullDiff("write", { path: "new.ts", content }, undefined)!;
    const lines = renderDiffLines(diff, { width: 80, theme: mono });
    assert.ok(lines.some((l) => l.includes("folded")));
  });
});

describe("T45.3: bash commands as first-class blocks", () => {
  it("! and !! are distinguishable on screen", () => {
    const sent = renderBashLines({ command: "ls", output: "a\nb", exitCode: 0, sendToModel: true }, { width: 80, theme: mono });
    const local = renderBashLines({ command: "ls", output: "a\nb", exitCode: 0, sendToModel: false }, { width: 80, theme: mono });
    assert.notEqual(sent[0], local[0]);
    assert.match(sent[0]!, /context/);
    assert.match(local[0]!, /local/);
  });

  it("a non-zero exit code is visible without expanding anything", () => {
    const lines = renderBashLines({ command: "false", output: "", exitCode: 1, sendToModel: true }, { width: 80, theme: mono });
    assert.ok(lines.some((l) => l.includes("exit 1")));
  });

  it("exit 0 is also always shown", () => {
    const lines = renderBashLines({ command: "true", output: "", exitCode: 0, sendToModel: true }, { width: 80, theme: mono });
    assert.ok(lines.some((l) => l.includes("exit 0")));
  });

  it("output lines are framed and indented under a rule", () => {
    const lines = renderBashLines({ command: "echo hi", output: "hi", exitCode: 0, sendToModel: true }, { width: 80, theme: mono });
    assert.ok(lines.some((l) => l.startsWith("  ⎿ hi")));
  });

  it("renders with colour under a truecolor theme with no crash", () => {
    const lines = renderBashLines({ command: "ls -la", output: "total 0", exitCode: 0, sendToModel: true }, { width: 80, theme: color });
    assert.ok(lines.length >= 2);
  });
});
