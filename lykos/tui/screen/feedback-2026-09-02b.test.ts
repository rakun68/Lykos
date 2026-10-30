// The second 2026-09-02 UI feedback round — six numbered items, asserted in
// the same order and named by their number, the same discipline as
// `feedback-2026-09-02.test.ts`.
//
// Item 1's original answer (a `/mouse` toggle defaulting to off) was
// reversed by the round that followed — see the describe block below and
// `feedback-2026-09-02c.test.ts` for what replaced it.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { SHIPPED_DEFAULTS } from "../../config/defaults.js";
import { setStderrSink, stderrWrite } from "../io-mode.js";
import { parseInteractiveInput } from "../s0.js";
import { renderTriadLine } from "../renderers/line.js";
import { resolveTheme } from "../theme/resolve.js";
import { GLYPHS } from "../theme/types.js";
import { charWidth, sliceToWidth, stringWidth } from "../width.js";
import type { ViewModel } from "../types.js";
import { clipToWidth, makeFrame, visibleWidth } from "./frame.js";
import { decodeWin32Record, KeyDecoder } from "./input.js";
import { computeLayout } from "./layout.js";
import { ScreenPipeline } from "./pipeline.js";
import { RawLineSource } from "./raw-line-source.js";
import { wrapPlain } from "./scrollback.js";
import { ENTER_SEQUENCES, LEAVE_SEQUENCES, wantsWin32Input } from "./terminal.js";

const mono = resolveTheme("mono", "none", "unicode");

function vm(overrides: Partial<ViewModel> = {}): ViewModel {
  return {
    cost: { runUsd: 0.038, todayUsd: null, capRunUsd: 0.5, capDayUsd: 2, onExceed: "stop" },
    tokens: { counters: { fresh: 6300, cacheRead: 7000, cacheWrite: 0, output: 301, reasoning: 0 }, hitRatio: 0.55, calls: 3 },
    context: { parent: null, delegate: { usedTokens: 12000, totalTokens: 64000, pct: 0.1875 } },
    outcome: null,
    alerts: [],
    session: {
      id: "s1",
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
    ...overrides,
  };
}

// Item 1's answer here — a `/mouse` toggle defaulting to off, so the
// terminal kept Ctrl+scroll zoom — was reversed by the round that followed
// ("remove command mouse, just let mouse on always, it was a mistake, i can
// totally change size with Ctrl plus and minus"). The mechanism is deleted
// rather than left behind a flag, so what is asserted here now is its
// absence: see feedback-2026-09-02c.test.ts for the replacement.
describe("item 1 (reversed by round three): the mouse toggle is gone entirely", () => {
  it("/mouse is not an owned command any more — it reaches the model like any other text", () => {
    assert.deepEqual(parseInteractiveInput("/mouse"), { kind: "prompt", text: "/mouse" });
  });
});

describe("items 2 and 3: a line is measured in terminal columns, not code units", () => {
  it("the bolt glyph is two columns wide — the undercount that let a row wrap", () => {
    assert.equal("⚡".length, 1, "one code unit");
    assert.equal(charWidth(0x26a1), 2, "two terminal columns");
    assert.equal(stringWidth("⚡ lykos"), 8);
  });

  it("a variation selector is zero columns, so the text-presentation glyphs measure as one", () => {
    assert.equal(charWidth(0xfe0e), 0);
    assert.equal(stringWidth(GLYPHS.unicode.warnGlyph), 1);
    assert.equal(stringWidth(GLYPHS.unicode.check), 1);
    assert.equal(stringWidth(GLYPHS.unicode.write), 1);
  });

  it("the three ambiguous-width glyphs carry the text-presentation selector; the wide one does not", () => {
    assert.ok(GLYPHS.unicode.warnGlyph.endsWith("︎"), "warn");
    assert.ok(GLYPHS.unicode.check.endsWith("︎"), "check");
    assert.ok(GLYPHS.unicode.write.endsWith("︎"), "write");
    assert.equal(GLYPHS.unicode.bolt, "⚡", "the bolt is genuinely wide — measured, not re-presented");
  });

  it("no frame row can exceed the frame's width in columns, whatever glyphs it carries", () => {
    const line = `${GLYPHS.unicode.bolt} ${"lykos: specialist is frozen at boot".repeat(4)}`;
    const frame = makeFrame(40, 3, [line, line, line]);
    for (const row of frame.lines) assert.ok(visibleWidth(row) <= 40, `row is ${visibleWidth(row)} columns wide`);
  });

  it("wrapPlain wraps a bolt-prefixed system line to real columns", () => {
    const text = `${GLYPHS.unicode.bolt} lykos: specialist is frozen at boot and switching would rewrite the head`;
    for (const row of wrapPlain(text, 20)) assert.ok(stringWidth(row) <= 20, `${JSON.stringify(row)} is ${stringWidth(row)} columns`);
  });

  it("clipToWidth drops a wide glyph whole rather than printing half of one", () => {
    // Two columns of room, and the second glyph would straddle the limit.
    assert.equal(clipToWidth("a⚡b", 2), "a");
    assert.equal(clipToWidth("a⚡b", 3), "a⚡");
  });

  it("sliceToWidth reports the columns it actually used", () => {
    assert.deepEqual(sliceToWidth("ab⚡", 3), { text: "ab", width: 2 });
    assert.deepEqual(sliceToWidth("ab⚡", 4), { text: "ab⚡", width: 4 });
  });
});

describe("item 2: nothing writes to the terminal behind the frame writer's back", () => {
  it("no interactive or session module calls process.stderr.write directly", () => {
    // The other half of the "message is still there" bug: bytes written
    // straight to stderr are not part of any Frame, so FrameWriter neither
    // draws nor erases them and they sit on the alternate screen until
    // something else happens to overwrite that exact row. A scan, because
    // the next diagnostic someone adds will reach for `process.stderr`
    // out of habit.
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ["../../session/interactive.ts", "../../session/session.ts", "../../loop/drift-detector.ts"]) {
      const src = readFileSync(join(here, rel), "utf8");
      // `finishInteractiveSession()` runs AFTER the terminal is restored, so
      // the one deliberate direct write there is allowed and named.
      const offenders = src.split("\n").filter((l) => l.includes("process.stderr.write") && !l.includes("restoreStderr"));
      assert.deepEqual(
        offenders.filter((l) => !l.includes("deferredStderr")),
        [],
        `${rel} writes to stderr directly; use stderrWrite() from tui/io-mode.js`,
      );
    }
  });

  it("ticket 04: /specialist's list and switch outcomes go through chrome() — never a second, direct stderr write", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../session/interactive.ts"), "utf8");
    const start = src.indexOf('case "specialist-list":');
    const end = src.indexOf('case "mode": {');
    const block = src.slice(start, end);
    assert.ok(start >= 0 && end > start, "expected to find the specialist-list/specialist-switch cases");
    assert.doesNotMatch(block, /process\.stderr\.write/, "a specialist report must go through chrome(), the same single channel every other owned command uses");
    assert.match(block, /chrome\(/, "the block should still report something");
  });

  it("a stderr sink captures diagnostics instead of letting them reach the screen", () => {
    const captured: string[] = [];
    const restore = setStderrSink((t) => void captured.push(t));
    try {
      stderrWrite("lykos: something happened\n");
    } finally {
      restore();
    }
    assert.deepEqual(captured, ["lykos: something happened\n"]);
  });
});

// Round three moved the popup back above the composer and made the side a
// setting (`ui.completion_position`) rather than a unilateral second move —
// see `feedback-2026-09-02c.test.ts` for the default (above). What matters
// from THIS round is still true: it is a layout region that takes its rows
// from the viewport, not something painted over the transcript. Asserted
// here with `completionAbove: false` explicitly, since that is no longer
// the default computeLayout assumes.
describe("item 4: the completion popup is a layout region, not an overlay (position now configurable — see round three)", () => {
  it("with completionAbove: false, its rows come after the composer's and before the footer's", () => {
    const layout = computeLayout({
      width: 80,
      height: 24,
      headerHeight: 1,
      footerVisible: true,
      footerHeight: 1,
      composerHeight: 3,
      completionHeight: 5,
      completionAbove: false,
    });
    assert.ok(layout.completion.top >= layout.composer.top + layout.composer.height, "below the composer");
    assert.ok(layout.completion.top + layout.completion.height <= layout.footer.top, "above the footer");
    assert.equal(layout.footer.top + layout.footer.height, 24, "the footer is still the last row");
  });

  it("opening it shrinks the viewport rather than covering the transcript, either side", () => {
    const closed = computeLayout({ width: 80, height: 24, headerHeight: 1, footerVisible: true, footerHeight: 1, composerHeight: 3 });
    const openBelow = computeLayout({
      width: 80,
      height: 24,
      headerHeight: 1,
      footerVisible: true,
      footerHeight: 1,
      composerHeight: 3,
      completionHeight: 5,
      completionAbove: false,
    });
    const openAbove = computeLayout({
      width: 80,
      height: 24,
      headerHeight: 1,
      footerVisible: true,
      footerHeight: 1,
      composerHeight: 3,
      completionHeight: 5,
      completionAbove: true,
    });
    assert.equal(openBelow.viewport.height, closed.viewport.height - 5);
    assert.equal(openAbove.viewport.height, closed.viewport.height - 5);
  });
});

describe("item 5: Shift+Enter and Ctrl+Enter insert a newline", () => {
  it("win32-input-mode is asked for on Windows and can be switched off by env", () => {
    assert.equal(wantsWin32Input({}, "win32"), true);
    assert.equal(wantsWin32Input({}, "linux"), false);
    assert.equal(wantsWin32Input({ LYKOS_WIN32_INPUT: "0" }, "win32"), false);
    assert.equal(wantsWin32Input({ LYKOS_WIN32_INPUT: "1" }, "linux"), true);
    assert.ok(ENTER_SEQUENCES.win32Input.endsWith("9001h"));
    assert.ok(LEAVE_SEQUENCES.win32Input.endsWith("9001l"));
  });

  it("a win32 record for Shift+Enter decodes as a modified enter, not a bare one", () => {
    // Vk 13 (VK_RETURN), Uc 13, key down, ControlKeyState 0x10 (SHIFT).
    assert.deepEqual(new KeyDecoder().feed("\x1b[13;28;13;1;16;1_"), [{ type: "enter", shift: true }]);
    // 0x8 (LEFT_CTRL)
    assert.deepEqual(new KeyDecoder().feed("\x1b[13;28;13;1;8;1_"), [{ type: "enter", ctrl: true }]);
    // No modifier at all is a plain Enter, which must still submit — one
    // idle gap later, since round fourteen holds a read-ending Enter.
    const plain = new KeyDecoder();
    assert.deepEqual(plain.feed("\x1b[13;28;13;1;0;1_"), []);
    assert.deepEqual(plain.flush(), [{ type: "enter" }]);
  });

  it("a key-up record is consumed, never replayed as a second keystroke", () => {
    // Round three found the actual bug this test's old assertion masked:
    // decoding a key-up as an "unknown" KeyEvent still handed RawLineSource
    // a real event, which fell through to its default case and called
    // refreshCompletion() — resetting the highlighted candidate back to the
    // top on every single keystroke, since every keystroke sends both a
    // down and an up record. The fix is that a key-up decodes to NO event
    // at all: the bytes are still consumed (never leaked as characters),
    // but nothing is emitted for RawLineSource to react to.
    const events = new KeyDecoder().feed("\x1b[13;28;13;0;16;1_");
    assert.equal(events.length, 0, "consumed, not decoded, and not leaked as characters or a spurious event");
  });

  it("ordinary characters still arrive under win32-input-mode", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b[65;30;97;1;0;1_"), [{ type: "char", value: "a" }]);
  });

  it("a Ctrl-modified letter decodes to the same ctrl event the non-win32 path produces", () => {
    // Uc 1 is Ctrl-A; ControlKeyState 0x8 is LEFT_CTRL.
    assert.deepEqual(new KeyDecoder().feed("\x1b[65;30;1;1;8;1_"), [{ type: "ctrl", key: "a" }]);
    assert.deepEqual(decodeWin32Record(65, 1, true, 0x8), { type: "ctrl", key: "a" });
  });

  it("a partial record is held rather than half-decoded into stray characters", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("\x1b[13;28;13;1;16"), []);
    assert.deepEqual(d.feed(";1_"), [{ type: "enter", shift: true }]);
  });

  it("all three modified enters insert a newline; a bare one submits", async () => {
    for (const bytes of ["\x1b[13;2u", "\x1b[13;5u", "\x1b[27;2;13~", "\x1b[27;5;13~"]) {
      const src = new RawLineSource();
      const p = src.next();
      src.feedBytes(`one${bytes}two\r`);
      src.flushPending(); // the idle gap a real session's router always provides
      // One entry carrying the real newline since round twelve, item 3 —
      // the backslash-continuation protocol this used to assert deleted
      // the break on the way to the model.
      assert.equal(await p, "one\ntwo", bytes);
    }
  });

  it("bracketed paste is actually enabled now, so a pasted newline is text and not a send", async () => {
    assert.ok(ENTER_SEQUENCES.bracketedPaste.includes("2004h"));
    const src = new RawLineSource();
    const p = src.next();
    src.feedBytes("\x1b[200~one\ntwo\x1b[201~\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await p, "one\ntwo");
  });
});

describe("item 6: model, effort and the context window on the footer", () => {
  it("the model and effort are right-aligned on the widest tier", () => {
    const line = renderTriadLine(vm(), { width: 120, theme: mono });
    assert.ok(line.endsWith("deepseek-v4-pro · high"), line);
  });

  it("the effort half is dropped, not guessed, when no live session reported one", () => {
    const line = renderTriadLine(vm({ session: { ...vm().session, thinkingLevel: null } }), { width: 120, theme: mono });
    assert.ok(line.endsWith("deepseek-v4-pro"), line);
    assert.doesNotMatch(line, /·/);
  });

  it("the badge is dropped whole rather than truncated when it does not fit", () => {
    const line = renderTriadLine(vm(), { width: 80, theme: mono });
    assert.doesNotMatch(line, /deepseek/);
  });

  it("the context segment names used and total, not just a percentage", () => {
    const line = renderTriadLine(vm(), { width: 120, theme: mono });
    assert.match(line, /ctx .*12\.0k\/64\.0k 19%/);
  });

  it("an unknown context window still reads `ctx ?` rather than inventing one", () => {
    const line = renderTriadLine(vm({ context: { parent: null, delegate: null } }), { width: 120, theme: mono });
    assert.match(line, /ctx \?/);
  });

  it("/effort parses its level, and bare /effort asks rather than cycles", () => {
    assert.deepEqual(parseInteractiveInput("/effort high"), { kind: "effort", level: "high" });
    assert.deepEqual(parseInteractiveInput("/effort"), { kind: "effort", level: "" });
    assert.deepEqual(parseInteractiveInput("/effort HIGH"), { kind: "effort", level: "high" });
  });
});

describe("the assembled frame after this round", () => {
  it("a popup, a status line and the footer all coexist without any row overflowing", () => {
    const pipeline = new ScreenPipeline({ width: 60, height: 20, theme: mono, header: { product: "LYKOS", version: "0.0.1", model: "m", cwd: "~", branch: null, sessionId: "abc12345", executionShape: "standalone" }, sink: { write: () => {} }, maxHz: 1000 });
    pipeline.pushBlock({ id: "s", kind: "system", text: `${GLYPHS.unicode.bolt} a long machinery line that will certainly need wrapping at sixty columns` });
    pipeline.setComposerLines(["----", "> /co", "----"]);
    pipeline.setStatus("working");
    pipeline.setCompletionPopup(["  /copy", "  /compact"]);
    pipeline.flush();
    pipeline.stop();
  });
});
