import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTheme } from "../theme/resolve.js";
import type { OutcomeView } from "../types.js";
import { renderScreenBlock, toScrollbackBlock, type ScreenBlock } from "./blocks.js";
import { visibleWidth } from "./frame.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

const OUTCOME: OutcomeView = { value: "success", source: "verification_command", verified: true };

function sample(): ScreenBlock[] {
  return [
    { id: "1", kind: "user", text: "fix the header" },
    { id: "2", kind: "thinking", text: "the header needs a right-aligned block" },
    { id: "3", kind: "speech", text: "done — the header now right-aligns the session id." },
    { id: "4", kind: "tool", tool: { name: "Edit", summary: "lykos/tui/screen/header.ts", state: "ok" } },
    { id: "5", kind: "diff", diff: { path: "header.ts", lines: [{ kind: "add", text: "+ new line" }] } },
    { id: "6", kind: "approval", approval: { kind: "write", summary: "header.ts", detail: "12 lines" } },
    { id: "7", kind: "system", text: "compacting…" },
    { id: "8", kind: "outcome", outcome: OUTCOME },
    { id: "9", kind: "read", path: "README.md" },
  ];
}

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

describe("T44.1: every block kind has its own structural treatment", () => {
  for (const width of [40, 60, 80, 120]) {
    it(`renders all eight block types at width ${width} with no crash and non-empty output`, () => {
      for (const block of sample()) {
        const lines = renderScreenBlock(block, { width, theme: color });
        assert.ok(lines.length > 0, `${block.kind} produced no lines`);
      }
    });
  }

  it("thinking opens with a rule and indents the body", () => {
    const lines = renderScreenBlock({ id: "t", kind: "thinking", text: "reasoning about the fix" }, { width: 80, theme: mono });
    assert.ok(lines[0]!.startsWith("│ Thinking"));
    for (const line of lines.slice(1)) assert.ok(line.startsWith("  "), `"${line}" is not indented`);
  });

  it("tool carries the ◆ marker", () => {
    const [line] = renderScreenBlock({ id: "x", kind: "tool", tool: { name: "Read", summary: "a.ts", state: "ok" } }, { width: 80, theme: mono });
    assert.ok(line!.startsWith("◆"));
  });
});

describe("T44.2: colour is never the only carrier — NO_COLOR strips escapes, structure survives", () => {
  it("a full session of all eight block types is still unambiguous with colour stripped", () => {
    const rendered = sample().map((b) => ({ kind: b.kind, lines: renderScreenBlock(b, { width: 80, theme: mono }) }));
    // No block's mono output contains an ANSI escape.
    for (const r of rendered) {
      for (const line of r.lines) assert.equal(ANSI.test(line), false, `${r.kind} leaked an escape under the mono theme`);
    }
    // Every kind's marker set is disjoint from every other kind's — the
    // structural distinction survives with zero colour, per T44.2's own
    // acceptance ("checks every block carries a non-colour marker").
    const markers: Record<string, string> = {
      user: ">",
      // Capitalised 2026-09-02 round three, item 5 ("thinking should be
      // Thinking instead") — it is a heading now, not a lowercase label.
      thinking: "Thinking",
      tool: "◆",
      diff: "└", // g.corner
      approval: "approval",
      system: "⚡", // g.bolt
      outcome: "✓",
      read: "read README.md",
    };
    for (const [kind, marker] of Object.entries(markers)) {
      const r = rendered.find((x) => x.kind === kind)!;
      assert.ok(r.lines.some((l) => l.includes(marker)), `${kind} lost its non-colour marker (${marker}) under NO_COLOR`);
    }
    // Speech is the one deliberately unmarked kind (T44.1: "No box, normal
    // tone, full width") — it must not accidentally collide with any other
    // kind's marker.
    const speech = rendered.find((x) => x.kind === "speech")!;
    for (const marker of Object.values(markers)) {
      assert.ok(!speech.lines.some((l) => l.includes(marker)), `speech collided with the "${marker}" marker`);
    }
  });
});

describe("T44.3: thinking is shown by default (this module has no collapse state of its own)", () => {
  it("renderScreenBlock never hides a thinking block — the collapse decision belongs to the caller", () => {
    const lines = renderScreenBlock({ id: "t", kind: "thinking", text: "some reasoning" }, { width: 80, theme: mono });
    assert.ok(lines.some((l) => l.includes("some reasoning")));
  });
});

describe("user and thinking stay one tint or none — no empty slab rows", () => {
  it("a one-line user prompt is one userBg row, not a blank-content-blank slab", () => {
    const lines = renderScreenBlock({ id: "u", kind: "user", text: "hi" }, { width: 20, theme: color });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /\x1b\[48;2;/);
    assert.match(lines[0]!, /> /);
    assert.match(lines[0]!, /hi/);
  });

  it("thinking has no full-width background", () => {
    const lines = renderScreenBlock({ id: "t", kind: "thinking", text: "hmm" }, { width: 20, theme: color });
    assert.ok(lines.every((l) => !l.includes("\x1b[48;")));
  });

  it("renderRead's leading and trailing blank line carry the readBg escape under a colour theme", () => {
    const lines = renderScreenBlock({ id: "r", kind: "read", path: "a.ts" }, { width: 20, theme: color });
    assert.match(lines[0]!, /\x1b\[48;2;/);
    assert.match(lines.at(-1)!, /\x1b\[48;2;/);
  });

  it("under the mono theme a user row is the prompt and the text, with no escape and no blank slab", () => {
    const lines = renderScreenBlock({ id: "u", kind: "user", text: "hi" }, { width: 20, theme: mono });
    assert.deepEqual(lines, ["> hi"]);
  });
});

describe("2026-09-02: markdown-aware speech/thinking rendering", () => {
  it("renderScreenBlock('speech') styles **bold** and `code` spans", () => {
    const lines = renderScreenBlock({ id: "s", kind: "speech", text: "a **bold** word and `some code`" }, { width: 80, theme: color });
    const text = lines.join("");
    assert.match(text, /\x1b\[1m/, "bold escape missing");
    assert.doesNotMatch(text, /\*\*/, "bold markers should be consumed once styled");
    assert.doesNotMatch(text, /`/, "backticks should be consumed once styled");
  });

  it("renderScreenBlock('thinking') markdown-styles its body and does not paint a background slab", () => {
    const lines = renderScreenBlock({ id: "t", kind: "thinking", text: "this has **bold** text in it" }, { width: 40, theme: color });
    const bodyLine = lines.find((l) => l.includes("bold"))!;
    assert.match(bodyLine, /\x1b\[1m/);
    assert.doesNotMatch(bodyLine, /\x1b\[48;/);
    assert.ok(visibleWidth(bodyLine) < 40);
  });

  it("a numbered list in speech text gets a coloured marker", () => {
    const lines = renderScreenBlock({ id: "s", kind: "speech", text: "1. first\n2. second" }, { width: 80, theme: color });
    assert.match(lines[0]!, /\x1b\[38;2;\d+;\d+;\d+m1\. /);
  });
});

describe("T51.4: the resources panel — real boot-time context/skills/extensions counts", () => {
  it("lists context files with a token count when the diet is on", () => {
    const lines = renderScreenBlock(
      {
        id: "r",
        kind: "resources",
        resources: { contextEnabled: true, contextFiles: ["CLAUDE.md"], contextTokens: 2100, skills: ["no-ai-slop"], extensions: [] },
      },
      { width: 80, theme: mono },
    );
    const text = lines.join("\n");
    assert.match(text, /\[Context\]/);
    assert.match(text, /CLAUDE\.md/);
    assert.match(text, /2\.1k tokens/);
    assert.match(text, /\[Skills\]/);
    assert.match(text, /no-ai-slop/);
    assert.match(text, /\[Extensions\]/);
    assert.match(text, /none — standalone execution has no extension surface yet/);
  });

  it("says the diet is off, rather than showing zero files, when contextEnabled is false", () => {
    const lines = renderScreenBlock(
      { id: "r", kind: "resources", resources: { contextEnabled: false, contextFiles: [], contextTokens: 0, skills: [], extensions: [] } },
      { width: 80, theme: mono },
    );
    assert.match(lines.join("\n"), /LYKOS_PROMPT_DIET=0/);
  });
});

describe("toScrollbackBlock", () => {
  it("adapts a ScreenBlock into T43's ScrollbackBlock shape", () => {
    const sb = toScrollbackBlock({ id: "s", kind: "system", text: "compacted" }, mono);
    assert.equal(sb.id, "s");
    assert.ok(sb.render(80).some((l) => l.includes("compacted")));
  });
});
