import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRACKETED_PASTE_DISABLE, BRACKETED_PASTE_ENABLE, KeyDecoder } from "./input.js";

describe("T46.1: KeyDecoder — printable characters and control codes", () => {
  it("decodes a plain ASCII run as one char event per character", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("abc"), [
      { type: "char", value: "a" },
      { type: "char", value: "b" },
      { type: "char", value: "c" },
    ]);
  });

  it("decodes a multi-byte UTF-8 character as one char event, not one per byte", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("é日"), [
      { type: "char", value: "é" },
      { type: "char", value: "日" },
    ]);
  });

  it("Enter is \\r or \\n — held until the idle gap says nothing followed it", () => {
    // Round fourteen: an Enter that ENDS a read is the one event a paste
    // and a keypress cannot be told apart by, so it waits for `flush()`
    // rather than being guessed. See the paste-detection note in input.ts.
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("\r"), []);
    assert.deepEqual(d.flush(), [{ type: "enter" }]);
    const e = new KeyDecoder();
    assert.deepEqual(e.feed("\n"), []);
    assert.deepEqual(e.flush(), [{ type: "enter" }]);
  });

  it("Backspace is 0x7f; 0x08 is Ctrl+Backspace (2026-09-02 item 7)", () => {
    assert.deepEqual(new KeyDecoder().feed("\x7f"), [{ type: "backspace" }]);
    assert.deepEqual(new KeyDecoder().feed("\x08"), [{ type: "backspace", ctrl: true }]);
  });

  it("Ctrl+Backspace also decodes from the Kitty and modifyOtherKeys encodings", () => {
    for (const bytes of ["\x1b[127;5u", "\x1b[8;5u", "\x1b[27;5;127~", "\x1b[27;5;8~"]) {
      assert.deepEqual(new KeyDecoder().feed(bytes), [{ type: "backspace", ctrl: true }], bytes);
    }
  });

  it("Shift+arrow and Ctrl+Shift+arrow carry their modifiers (2026-09-02 item 8)", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b[1;2C"), [{ type: "arrow", dir: "right", shift: true }]);
    assert.deepEqual(new KeyDecoder().feed("\x1b[1;2D"), [{ type: "arrow", dir: "left", shift: true }]);
    assert.deepEqual(new KeyDecoder().feed("\x1b[1;6D"), [{ type: "arrow", dir: "left", ctrl: true, shift: true }]);
  });

  it("Shift+Home / Ctrl+Home and Ctrl+Delete decode distinctly from their plain forms", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b[1;2H"), [{ type: "home", shift: true }]);
    assert.deepEqual(new KeyDecoder().feed("\x1b[1;5H"), [{ type: "home", ctrl: true }]);
    assert.deepEqual(new KeyDecoder().feed("\x1b[3;5~"), [{ type: "delete", ctrl: true }]);
    assert.deepEqual(new KeyDecoder().feed("\x1b[3~"), [{ type: "delete" }]);
  });

  it("Tab is 0x09 — held for the same reason Enter is", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("\t"), []);
    assert.deepEqual(d.flush(), [{ type: "tab" }]);
  });

  it("Ctrl+r / Ctrl+a / Ctrl+k / Ctrl+u / Ctrl+w decode as ctrl events, never as backspace/tab/enter", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("\x12"), [{ type: "ctrl", key: "r" }]);
    assert.deepEqual(d.feed("\x01"), [{ type: "ctrl", key: "a" }]);
    assert.deepEqual(d.feed("\x0b"), [{ type: "ctrl", key: "k" }]);
    assert.deepEqual(d.feed("\x15"), [{ type: "ctrl", key: "u" }]);
    assert.deepEqual(d.feed("\x17"), [{ type: "ctrl", key: "w" }]);
  });
});

describe("T46.1: KeyDecoder — escape sequences, including ambiguous prefixes", () => {
  it("arrow keys, Home/End, Delete, PgUp/PgDn", () => {
    const cases: Array<[string, unknown]> = [
      ["\x1b[A", { type: "arrow", dir: "up" }],
      ["\x1b[B", { type: "arrow", dir: "down" }],
      ["\x1b[C", { type: "arrow", dir: "right" }],
      ["\x1b[D", { type: "arrow", dir: "left" }],
      ["\x1b[H", { type: "home" }],
      ["\x1b[F", { type: "end" }],
      ["\x1b[3~", { type: "delete" }],
      ["\x1b[5~", { type: "pageUp" }],
      ["\x1b[6~", { type: "pageDown" }],
    ];
    for (const [bytes, expected] of cases) {
      assert.deepEqual(new KeyDecoder().feed(bytes), [expected], `decoding ${JSON.stringify(bytes)}`);
    }
  });

  it("Ctrl+Left/Right are distinct from plain Left/Right", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("\x1b[1;5D"), [{ type: "arrow", dir: "left", ctrl: true }]);
    assert.deepEqual(d.feed("\x1b[1;5C"), [{ type: "arrow", dir: "right", ctrl: true }]);
  });

  it("a sequence split across two feed() calls still decodes correctly", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("\x1b["), []); // ambiguous prefix — nothing yet
    assert.deepEqual(d.feed("A"), [{ type: "arrow", dir: "up" }]);
  });

  it("a lone ESC with nothing following stays pending until flush()", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("\x1b"), []);
    assert.equal(d.pending, "\x1b");
    assert.deepEqual(d.flush(), [{ type: "escape" }]);
    assert.equal(d.pending, "");
  });

  it("Alt+Enter decodes as enter with alt:true", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b\r"), [{ type: "enter", alt: true }]);
  });

  it("Shift+Enter decodes as enter with shift:true — Kitty keyboard protocol form (CSI 13;2u)", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b[13;2u"), [{ type: "enter", shift: true }]);
  });

  it("Shift+Enter decodes as enter with shift:true — xterm modifyOtherKeys form (CSI 27;2;13~)", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b[27;2;13~"), [{ type: "enter", shift: true }]);
  });

  it("an unrecognised CSI sequence degrades to an escape event without eating the following keystrokes", () => {
    const d = new KeyDecoder();
    const events = d.feed("\x1b[9x");
    assert.equal(events[0]!.type, "escape");
    // whatever follows an unrecognised sequence is still decoded, not swallowed
    assert.ok(events.length > 1);
  });
});

describe("SGR mouse wheel — decoded, not leaked into the composer as arrow bytes", () => {
  it("Cb=64 (bit 0 clear) is wheel up, Cb=65 (bit 0 set) is wheel down", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b[<64;10;5M"), [{ type: "wheel", dir: "up" }]);
    assert.deepEqual(new KeyDecoder().feed("\x1b[<65;10;5M"), [{ type: "wheel", dir: "down" }]);
  });

  it("a press report (no bit 6) decodes to a mouse event with 0-indexed coordinates", () => {
    const events = new KeyDecoder().feed("\x1b[<0;10;5M");
    assert.deepEqual(events, [{ type: "mouse", action: "down", button: 0, col: 9, row: 4 }]);
  });

  it("bit 5 marks motion (a drag), and a trailing m marks the release", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b[<32;10;5M"), [{ type: "mouse", action: "drag", button: 0, col: 9, row: 4 }]);
    assert.deepEqual(new KeyDecoder().feed("\x1b[<0;10;5m"), [{ type: "mouse", action: "up", button: 0, col: 9, row: 4 }]);
  });

  it("a shift-click carries its modifier bit", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b[<4;3;2M"), [{ type: "mouse", action: "down", button: 0, col: 2, row: 1, shift: true }]);
  });

  it("a release report ('m' instead of 'M') still decodes, not left dangling", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b[<64;10;5m"), [{ type: "wheel", dir: "up" }]);
  });

  it("a report split across feed() calls still decodes correctly", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("\x1b[<64;1"), []);
    assert.deepEqual(d.feed("0;5M"), [{ type: "wheel", dir: "up" }]);
  });

  it("Ctrl+wheel decodes with ctrl:true (Cb's own modifier bit 16) — 2026-09-02, so a caller can leave the terminal's own zoom gesture uncontested", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b[<80;10;5M"), [{ type: "wheel", dir: "up", ctrl: true }]); // 64 (wheel up) + 16 (ctrl)
    assert.deepEqual(new KeyDecoder().feed("\x1b[<81;10;5M"), [{ type: "wheel", dir: "down", ctrl: true }]); // 65 (wheel down) + 16 (ctrl)
  });

  it("plain wheel (no modifier) never carries a ctrl field at all", () => {
    const [ev] = new KeyDecoder().feed("\x1b[<64;10;5M");
    assert.equal("ctrl" in ev!, false);
  });

  it("does not swallow keystrokes typed right after a wheel notch", () => {
    const events = new KeyDecoder().feed("\x1b[<64;10;5Mx");
    assert.deepEqual(events, [{ type: "wheel", dir: "up" }, { type: "char", value: "x" }]);
  });
});

describe("T46.1: bracketed paste — one event for the whole block", () => {
  it("a 40-line paste arrives as a single paste event, not one per line", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
    const d = new KeyDecoder();
    const events = d.feed(`${BRACKETED_PASTE_ENABLE_MARKER()}${text}${BRACKETED_PASTE_END_MARKER()}`);
    const pasteEvents = events.filter((e) => e.type === "paste");
    assert.equal(pasteEvents.length, 1);
    assert.equal((pasteEvents[0] as { text: string }).text, text);
  });

  it("a paste split across feed() calls still arrives as one event", () => {
    const text = "hello\nworld";
    const d = new KeyDecoder();
    assert.deepEqual(d.feed(`${BRACKETED_PASTE_ENABLE_MARKER()}hel`), []);
    const events = d.feed(`lo\nworld${BRACKETED_PASTE_END_MARKER()}`);
    assert.deepEqual(events, [{ type: "paste", text }]);
  });

  it("the enable/disable sequences are exported for the raw-mode entry/exit path", () => {
    assert.equal(BRACKETED_PASTE_ENABLE, "\x1b[?2004h");
    assert.equal(BRACKETED_PASTE_DISABLE, "\x1b[?2004l");
  });
});

function BRACKETED_PASTE_ENABLE_MARKER(): string {
  return "\x1b[200~";
}
function BRACKETED_PASTE_END_MARKER(): string {
  return "\x1b[201~";
}
