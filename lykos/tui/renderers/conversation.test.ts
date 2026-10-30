import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { resolveTheme } from "../theme/resolve.js";
import type { OutcomeView, ViewModel } from "../types.js";
import {
  extractDiff,
  parseUnifiedDiff,
  renderApprovalBlock,
  renderOutcomeLine,
  renderS0,
  type ConversationView,
} from "./conversation.js";
import { GLYPHS } from "../theme/types.js";

// The unicode glyph set carries a trailing VS15 on the three glyphs that
// have an emoji presentation (theme/types.ts's TEXT_PRESENTATION) — assert
// against the glyph set rather than a literal, so a presentation change is
// a one-line edit there and not a test rewrite here.
const WARN = GLYPHS.unicode.warnGlyph;
const CHECK = GLYPHS.unicode.check;
const WRITE = GLYPHS.unicode.write;

const mono = resolveTheme("mono", "none", "unicode");
const ascii = resolveTheme("mono", "none", "ascii");

function vm(overrides: Partial<ViewModel> = {}): ViewModel {
  return {
    cost: { runUsd: 0.038, todayUsd: 0.41, capRunUsd: 0.5, capDayUsd: 2.0, onExceed: "stop" },
    tokens: {
      counters: { fresh: 42100, cacheRead: 38400, cacheWrite: 2100, output: 3800, reasoning: 0 },
      hitRatio: 0.91,
      calls: 4,
    },
    context: { parent: null, delegate: { usedTokens: 12000, totalTokens: 64000, pct: 0.19 } },
    outcome: null,
    alerts: [],
    session: {
      id: null,
      brief: null,
      agent: null,
      model: null,
      phase: null,
      startedUtc: null,
      endedUtc: null,
      heartbeatUtc: null,
      elapsedSec: null,
      thinkingLevel: null,
    },
    health: { toolSchemaTokens: null, toolCount: null, prefixChanged: false },
    children: [],
    ...overrides,
  };
}

function view(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    blocks: [
      { kind: "header", header: { model: "deepseek-v4-flash", sessionId: "abcd1234ef", cwd: "/work" } },
      { kind: "user", text: "fix the parser" },
      { kind: "assistant", text: "I'll edit it." },
      {
        kind: "tool",
        tool: {
          name: "edit",
          summary: "src/parse.ts",
          state: "ok",
          diff: {
            path: "src/parse.ts",
            lines: [
              { kind: "del", text: "return x" },
              { kind: "add", text: "return x.trim()" },
            ],
          },
        },
      },
      { kind: "hud" },
    ],
    hud: vm(),
    toolsCollapsed: false,
    thinkingCollapsed: true,
    ...overrides,
  };
}

describe("renderS0 — T4 acceptance re-run for S0", () => {
  it("renders correctly at 40, 60, 80, and 120 columns — no wrap, no half-printed number", () => {
    for (const width of [40, 60, 80, 120]) {
      const v = view();
      const { text, viewModel } = renderS0(v, { width, theme: mono });
      assert.equal(viewModel, v.hud);
      for (const line of text.split("\n")) {
        const stripped = line.replace(/\x1b\[[0-9;]*m/g, "");
        // HUD and labels may be shorter than width; they must not wrap by containing \n already split.
        assert.ok(stripped.length <= width + 8, `line longer than expected at ${width}: ${stripped}`);
      }
      assert.match(text, /\$0\.038/);
      assert.doesNotMatch(text, /\$0\.03…/);
      assert.doesNotMatch(text, /\$0\.03\.\.\./);
    }
  });

  it("specialists ticket 04: the header shows the active specialist, and omits the segment entirely when none is selected", () => {
    const withSpecialist = view({
      blocks: [{ kind: "header", header: { model: "deepseek-v4-flash", sessionId: "abcd1234ef", cwd: "/work", specialist: "deliberate" } }],
    });
    const { text } = renderS0(withSpecialist, { width: 100, theme: mono });
    assert.match(text, /specialist:deliberate/);

    const withoutSpecialist = view({
      blocks: [{ kind: "header", header: { model: "deepseek-v4-flash", sessionId: "abcd1234ef", cwd: "/work" } }],
    });
    const { text: text2 } = renderS0(withoutSpecialist, { width: 100, theme: mono });
    assert.doesNotMatch(text2, /specialist:/);
  });

  it("emits no colour and no unicode under ascii / NO_COLOR / TERM=dumb (mono+ascii theme)", () => {
    const { text } = renderS0(view(), { width: 80, theme: ascii });
    assert.doesNotMatch(text, /\x1b\[/);
    for (const g of ["█", "░", "↑", "↓", "⚡", "✎", "│", "◆", "✓", "⚠", "…", "\uFE0E"]) {
      assert.ok(!text.includes(g), `ascii theme leaked "${g}"`);
    }
  });

  it("shows cost, tokens, and context by default, with cache read and write separate", () => {
    const { text } = renderS0(view(), { width: 100, theme: mono });
    assert.match(text, /\$0\.038/);
    assert.match(text, /⚡91%/);
    assert.match(text, /↑42\.1k/);
    assert.match(text, new RegExp(`${WRITE} 2\\.1k`));
    assert.match(text, /↓3\.8k/);
    assert.match(text, /ctx /);
  });

  it("never renders an avoided figure on the S0 surface", () => {
    const { text } = renderS0(view(), { width: 120, theme: mono });
    assert.doesNotMatch(text, /avoided/i);
    assert.doesNotMatch(text, /~\$/);
  });

  it("renders agent_claim success distinctly from a verified one", () => {
    const unverified: OutcomeView = { value: "success", source: "agent_claim", verified: false };
    const verified: OutcomeView = { value: "success", source: "verification_command", verified: true };
    const u = renderOutcomeLine(unverified, mono);
    const v = renderOutcomeLine(verified, mono);
    assert.match(u, /unverified/);
    assert.match(v, new RegExp(`${CHECK} success`));
    assert.notEqual(u, v);
  });

  it("--json is the ViewModel the triad line drew", () => {
    const hud = vm();
    const { text, viewModel } = renderS0(view({ hud }), { width: 80, theme: mono });
    assert.equal(viewModel, hud);
    assert.match(text, /\$0\.038/);
    assert.equal(viewModel?.tokens.counters.cacheRead, 38400);
    assert.equal(viewModel?.tokens.counters.cacheWrite, 2100);
  });
});

describe("renderS0 — conversation blocks", () => {
  it("renders an edit diff with + and - lines", () => {
    const { text } = renderS0(view(), { width: 80, theme: mono });
    assert.match(text, /src\/parse\.ts/);
    assert.match(text, /-return x$/m);
    assert.match(text, /\+return x\.trim\(\)$/m);
  });

  it("renders the approval prompt as a first-class block", () => {
    const block = renderApprovalBlock(
      { kind: "write", summary: "write 12 bytes", detail: "/work/a.txt" },
      mono,
    );
    assert.match(block, /approval/);
    assert.match(block, /write 12 bytes/);
    assert.match(block, /\[y\] once/);
    assert.match(block, /\[n\] deny/);
    assert.match(block, /\[a\] always/);
  });

  it("extractDiff reads edits[].oldText/newText from the edit tool", () => {
    const diff = extractDiff(
      "edit",
      { path: "a.ts", edits: [{ oldText: "foo", newText: "bar" }] },
      undefined,
    );
    assert.ok(diff);
    assert.equal(diff.path, "a.ts");
    assert.deepEqual(
      diff.lines.map((l) => l.kind),
      ["del", "add"],
    );
  });

  it("extractDiff parses a unified patch on the result", () => {
    const diff = extractDiff("edit", { path: "a.ts" }, { diff: "@@ -1 +1 @@\n-old\n+new\n" });
    assert.ok(diff);
    assert.equal(diff.lines.filter((l) => l.kind === "add").length, 1);
    assert.equal(diff.lines.filter((l) => l.kind === "del").length, 1);
  });

  it("parseUnifiedDiff ignores file headers", () => {
    const d = parseUnifiedDiff("a.ts", "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n");
    assert.equal(d.lines.filter((l) => l.kind === "hunk").length, 1);
    assert.ok(!d.lines.some((l) => l.text.includes("+++")));
  });
});

describe("T37.3 renderer core stays under ~400 lines", () => {
  it("conversation.ts is under 400 lines", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "conversation.ts"), "utf8");
    const n = src.split("\n").length;
    assert.ok(n < 400, `conversation.ts is ${n} lines; T37.3 budget is ~400`);
  });
});
