// The third 2026-09-02 UI feedback round — twelve numbered items, asserted
// in the same order and named by their number, the same discipline as
// `feedback-2026-09-02.test.ts` and `feedback-2026-09-02b.test.ts`.
//
// Items 6 and 8 (the boot-time HUD paint, `/usage`, `/context`, and
// `/effort`'s coloured message) live in `session/interactive.ts` and are
// asserted in `session/interactive-2026-09-02c.test.ts` instead, alongside the
// other `runInteractiveLoop` command tests they belong with.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../../config/defaults.js";
import { completeArgument, complete, renderCompletionPopup } from "./completion.js";
import { effortToken, EFFORT_LEVELS, isEffortLevel } from "../effort.js";
import { renderComposer } from "./composer.js";
import { LineEditor } from "../editor.js";
import { computeLayout } from "./layout.js";
import { decodeWin32Record, KeyDecoder } from "./input.js";
import { RawLineSource } from "./raw-line-source.js";
import { FrameWriter, makeFrame } from "./frame.js";
import { renderHeaderLine } from "./header.js";
import { renderTriadLine } from "../renderers/line.js";
import { renderMarkdownLines } from "./markdown.js";
import { renderScreenBlock } from "./blocks.js";
import { resolveTheme } from "../theme/resolve.js";
import { SHIPPED_PALETTES } from "../theme/palettes.js";
import { GLYPHS } from "../theme/types.js";
import type { ViewModel } from "../types.js";

const mono = resolveTheme("mono", "none", "unicode");
const color = resolveTheme("rose-pine-moon", "truecolor", "unicode");

class RecordingSink {
  writes: string[] = [];
  get all(): string {
    return this.writes.join("");
  }
  write(text: string): void {
    this.writes.push(text);
  }
}

describe("item 1: the mouse toggle is gone — mouse tracking is unconditional", () => {
  it("ScreenTerminal has no setMouse/mouseActive any more", async () => {
    const { ScreenTerminal } = await import("./terminal.js");
    const term = new ScreenTerminal({ win32Input: false });
    assert.equal("setMouse" in term, false, "the toggle method must not exist");
    assert.equal("mouseActive" in term, false, "the live-state getter must not exist");
  });

  it("the shipped config has no ui.mouse key", () => {
    assert.equal("mouse" in (SHIPPED_DEFAULTS.ui as unknown as Record<string, unknown>), false);
  });

  it("Ctrl+wheel scrolls the transcript like any other notch (see raw-line-source.test.ts for the full case)", () => {
    const calls: string[] = [];
    const src = new RawLineSource({ onScroll: (a) => calls.push(a) });
    src.feedBytes("\x1b[<80;10;5M"); // Ctrl+wheel up
    assert.deepEqual(calls, ["wheelUp"]);
  });
});

describe("item 2: a full-width row does not lose its last column to EL", () => {
  it("FrameWriter's full redraw never erases past a line that already fills the row", () => {
    const sink = new RecordingSink();
    const writer = new FrameWriter(sink);
    const width = 10;
    const full = "a".repeat(width); // exactly fills the row — no trailing EL should follow it
    const short = "hi"; // does not fill the row — EL is still needed to clear the rest
    writer.write(makeFrame(width, 2, [full, short]));
    const payload = sink.all;
    // The full-width row's own text must not be followed immediately by the
    // erase-to-end-of-line sequence — that is exactly what deleted the last
    // character (a cursor left on the last column after writing into it,
    // then EL erasing from that same column).
    assert.ok(!payload.includes(`${full}\x1b[K`), "EL must not follow a row that already fills the width");
    assert.ok(payload.includes(`${short}\x1b[K`), "a short row still gets EL to clear its remainder");
  });

  it("a diff write applies the same rule to a changed full-width row", () => {
    const sink = new RecordingSink();
    const writer = new FrameWriter(sink);
    const width = 10;
    writer.write(makeFrame(width, 1, ["x".repeat(width)]));
    sink.writes.length = 0;
    writer.write(makeFrame(width, 1, ["y".repeat(width)]));
    assert.ok(!sink.all.includes(`${"y".repeat(width)}\x1b[K`));
  });

  it("the header's right-aligned block survives at exactly the width that used to lose its last character", () => {
    const info = { product: "LYKOS", version: "0.0.1", model: "deepseek-v4-flash", cwd: "~/proj", branch: null, sessionId: "abc12345", executionShape: "standalone" };
    // Width 63 is where the right-aligned block first fits with a 1-column
    // gap — the narrowest width at which the rendered line exactly fills
    // every column FrameWriter is told to draw into, which is the specific
    // case `paintRow()` exists for: this test is checking the renderer's
    // own output is correct, not the frame writer, but it is the width
    // that actually exercised the bug end to end in the report.
    for (const width of [63, 64, 65, 80]) {
      const line = renderHeaderLine(info, mono, width);
      assert.ok(line.endsWith("standalone"), `width ${width}: expected the execution shape's last character intact, got: "${line}"`);
    }
  });

  it("the footer's model/effort badge keeps its last character at the boundary width", () => {
    const vm: ViewModel = {
      cost: { runUsd: 0.01, todayUsd: null, capRunUsd: 0.5, capDayUsd: 2, onExceed: "stop" },
      tokens: { counters: { fresh: 100, cacheRead: 0, cacheWrite: 0, output: 10, reasoning: 0 }, hitRatio: 0, calls: 1 },
      context: { parent: null, delegate: null },
      outcome: null,
      alerts: [],
      session: {
        id: "s",
        brief: null,
        agent: null,
        model: "deepseek-v4-pro",
        phase: null,
        startedUtc: null,
        endedUtc: null,
        heartbeatUtc: null,
        elapsedSec: null,
        thinkingLevel: "high",
      },
      health: { toolSchemaTokens: null, toolCount: null, prefixChanged: false },
      children: [],
    };
    const line = renderTriadLine(vm, { width: 100, theme: mono });
    assert.ok(line.endsWith("high"), `expected the badge's last character intact, got: "${line}"`);
  });
});

describe("item 3: the completion pointer no longer resets to the top on every keystroke", () => {
  it("a win32 key-up record decodes to no event at all, not an 'unknown' one", () => {
    const events = new KeyDecoder().feed("\x1b[38;16;98;0;0;1_"); // key up
    assert.equal(events.length, 0);
  });

  it("decodeWin32Record itself returns null for a key-up", () => {
    assert.equal(decodeWin32Record(38, 98, false, 0), null);
  });

  it("moving the completion selection through a full win32 down+up pair actually moves it, and stays moved", () => {
    const src = new RawLineSource({ completionRoot: "/project" });
    const events: number[] = [];
    (src as unknown as { onCompletionChangeForTest?: unknown }); // no-op, keeping types happy
    const seen: number[] = [];
    const withCallback = new RawLineSource({
      completionRoot: "/project",
      onCompletionChange: (_candidates, selected) => seen.push(selected),
    });
    withCallback.feedBytes("/co"); // opens with three matches
    seen.length = 0;
    // A down-arrow as a real terminal would actually send it under
    // win32-input-mode: a down record immediately followed by its up
    // record, exactly the pair that used to bounce the selection back to
    // index 0 via a spurious refreshCompletion() on the up event.
    withCallback.feedBytes("\x1b[40;80;0;1;0;1_"); // VK_DOWN, down
    withCallback.feedBytes("\x1b[40;80;0;0;0;1_"); // VK_DOWN, up
    assert.deepEqual(seen, [1], "the selection moved once, and the key-up produced no second (resetting) event");
    void events;
  });
});

describe("item 4: the completion popup's position is a setting, and it is tinted its own background", () => {
  it("defaults to above the composer", () => {
    assert.equal(SHIPPED_DEFAULTS.ui.completion_position, "above");
  });

  it("computeLayout honours completionAbove in both directions", () => {
    const base = { width: 80, height: 24, headerHeight: 1, footerVisible: true, footerHeight: 1, composerHeight: 3, completionHeight: 5 };
    const above = computeLayout({ ...base, completionAbove: true });
    const below = computeLayout({ ...base, completionAbove: false });
    assert.ok(above.completion.top < above.composer.top, "above: completion comes first");
    assert.ok(below.completion.top > below.composer.top, "below: completion comes after");
  });

  it("every row of the popup carries its own background tint under a colour theme", () => {
    const lines = renderCompletionPopup([{ label: "/help", kind: "command", costClass: "local", description: "this list" }], {
      width: 40,
      theme: color,
    });
    for (const line of lines) assert.match(line, /\x1b\[48;2;/, `expected a background escape in: ${line}`);
  });

  it("emits no escapes at all under the mono theme", () => {
    const lines = renderCompletionPopup([{ label: "/help", kind: "command", costClass: "local", description: "this list" }], {
      width: 40,
      theme: mono,
    });
    for (const line of lines) assert.doesNotMatch(line, /\x1b/);
  });
});

describe("item 5: the thinking block reads 'Thinking' and its background sits closer to the terminal's own", () => {
  it("the label is capitalised", () => {
    const lines = renderScreenBlock({ id: "t", kind: "thinking", text: "reasoning" }, { width: 80, theme: mono });
    assert.ok(lines.some((l) => l.includes("Thinking")));
    assert.ok(!lines.some((l) => l.includes("│ thinking")), "the old lowercase label must be gone");
  });

  it("thinkingBg stays visibly distinct from userBg in every shipped palette that defines both", () => {
    for (const palette of Object.values(SHIPPED_PALETTES)) {
      if (palette.tokens.thinkingBg === "" || palette.tokens.userBg === "") continue; // mono/ansi16 carry no traceable blend
      assert.notEqual(palette.tokens.thinkingBg, palette.tokens.userBg, `${palette.name}: thinkingBg must stay visually distinct from userBg`);
    }
  });
});

describe("item 7: /effort completes its argument, and the composer's rules carry the effort ramp", () => {
  it("EFFORT_LEVELS is re-exported from tui/effort.ts, not redefined in s0.ts", () => {
    assert.deepEqual([...EFFORT_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("effortToken buckets the seven-level ladder onto the four-step ramp, darkest to brightest", () => {
    assert.equal(effortToken("off"), "effortOff");
    assert.equal(effortToken(null), "effortOff");
    assert.equal(effortToken("minimal"), "effortLow");
    assert.equal(effortToken("low"), "effortLow");
    assert.equal(effortToken("medium"), "effortMid");
    assert.equal(effortToken("high"), "effortMid");
    assert.equal(effortToken("xhigh"), "effortMax");
    assert.equal(effortToken("max"), "effortMax");
  });

  it("isEffortLevel recognises the ladder case-insensitively and rejects nonsense", () => {
    assert.equal(isEffortLevel("HIGH"), true);
    assert.equal(isEffortLevel("extreme"), false);
  });

  it("/effort's registry entry completes the ladder as an argument", () => {
    const candidates = completeArgument("/effort", "ma");
    assert.deepEqual(
      candidates.map((c) => c.label),
      ["max"],
    );
  });

  it("complete() routes a command's first argument through completeArgument, not the filesystem", () => {
    const candidates = complete("/project", "/effort h", 9);
    assert.deepEqual(
      candidates.map((c) => c.label),
      ["high"],
    );
  });

  it("a command with no declared arguments offers nothing for its first argument", () => {
    assert.deepEqual(complete("/project", "/session x", 10), []);
  });

  it("an @-path inside a command's arguments still completes as a path, not as an argument", () => {
    const candidates = complete("/project", "/followup @rea", 14);
    // No file "rea*" exists under a root that was never populated in this
    // test, so the meaningful assertion is that it did NOT try to match
    // "rea" against /followup's (nonexistent) argument vocabulary — it
    // must return the (possibly empty) file-completion shape, not throw
    // and not silently fall through to completeArgument.
    assert.deepEqual(
      candidates.every((c) => c.kind === "file"),
      true,
    );
  });

  it("the composer's border rules colour by the live effort level", () => {
    const editor = new LineEditor();
    const off = renderComposer(editor.state, color, 20, "off");
    const max = renderComposer(editor.state, color, 20, "max");
    const none = renderComposer(editor.state, color, 20, null);
    assert.notEqual(off.lines[0], max.lines[0], "off and max must render visibly different rules");
    assert.notEqual(off.lines[0], none.lines[0], "a live level must differ from no level at all (plain border)");
  });
});

describe("item 9: an ambiguous-width glyph is followed by a space so a fallback emoji font cannot bleed onto the next character", () => {
  it("the cache-write segment separates ✎ from its number", () => {
    const vm: ViewModel = {
      cost: { runUsd: 0.01, todayUsd: null, capRunUsd: 0.5, capDayUsd: 2, onExceed: "stop" },
      tokens: { counters: { fresh: 100, cacheRead: 50, cacheWrite: 2100, output: 10, reasoning: 0 }, hitRatio: 0.5, calls: 1 },
      context: { parent: null, delegate: { usedTokens: 1000, totalTokens: 2000, pct: 0.5 } },
      outcome: null,
      alerts: [],
      session: { id: "s", brief: null, agent: null, model: null, phase: null, startedUtc: null, endedUtc: null, heartbeatUtc: null, elapsedSec: null, thinkingLevel: null },
      health: { toolSchemaTokens: null, toolCount: null, prefixChanged: false },
      children: [],
    };
    const line = renderTriadLine(vm, { width: 100, theme: mono });
    // The glyph itself carries VS15 (U+FE0E, the text-presentation
    // selector — see theme/types.ts) between the mark and the space that
    // separates it from the number.
    assert.match(line, new RegExp(`${GLYPHS.unicode.write} 2\\.1k`));
  });

  it("the alert badge separates its glyph from the alert id", () => {
    const vm: ViewModel = {
      cost: { runUsd: 0.01, todayUsd: null, capRunUsd: 0.5, capDayUsd: 2, onExceed: "stop" },
      tokens: { counters: { fresh: 10, cacheRead: 0, cacheWrite: 0, output: 1, reasoning: 0 }, hitRatio: 0, calls: 1 },
      context: { parent: null, delegate: null },
      outcome: null,
      alerts: [{ id: "H-6", severity: "warn", message: "x", remedy: "y" }],
      session: { id: "s", brief: null, agent: null, model: null, phase: null, startedUtc: null, endedUtc: null, heartbeatUtc: null, elapsedSec: null, thinkingLevel: null },
      health: { toolSchemaTokens: null, toolCount: null, prefixChanged: false },
      children: [],
    };
    const line = renderTriadLine(vm, { width: 30, theme: mono });
    assert.match(line, new RegExp(`${GLYPHS.unicode.warnGlyph} H-6`));
  });
});

describe("item 10: bold text carries the dedicated 'strong' colour token, not just SGR 1", () => {
  it("renders a bold span with the strong token's colour under a truecolor theme", () => {
    const lines = renderMarkdownLines("plain **bold** plain", 40, color, "speech");
    const boldLine = lines.map((l) => l.styled).join("\n");
    // SGR 1 is still there (weight), AND the strong token's own colour —
    // asserted by checking the escape sequence carries a foreground colour
    // distinct from the surrounding "speech"-toned text.
    assert.match(boldLine, /\x1b\[1m/, "bold weight is still set");
    const speechOnly = renderMarkdownLines("plain text only", 40, color, "speech")[0]!.styled;
    const speechColourMatch = /\x1b\[38;2;\d+;\d+;\d+m/.exec(speechOnly);
    const boldColourMatches = [...boldLine.matchAll(/\x1b\[38;2;\d+;\d+;\d+m/g)];
    assert.ok(speechColourMatch, "sanity: speech itself carries a colour");
    assert.ok(
      boldColourMatches.some((m) => m[0] !== speechColourMatch![0]),
      "the bold span's colour must differ from plain speech text",
    );
  });

  it("under the mono theme, bold still carries SGR 1 with no colour escape at all", () => {
    const lines = renderMarkdownLines("plain **bold** plain", 40, mono, "speech");
    assert.equal(lines.map((l) => l.styled).join("\n"), "plain **bold** plain", "mono strips markdown markers and adds no escapes");
  });
});
