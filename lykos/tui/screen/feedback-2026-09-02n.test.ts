// The fourteenth 2026-09-02 UI feedback round, one item and no patience
// left for it: "pasting multiple lines text to prompt chat box still have
// lots of errors (adding random characters to the text, line breaking not
// correctly). This error has been here for so long. Find any way to fix it
// at all cost cause this is a really important feature."
//
// Four rounds have now touched paste, each finding a real bug and each
// leaving the feature broken, so this round went looking for every
// remaining way a pasted block can arrive wrong rather than for the next
// single cause. There are five, and they are independent — which is why
// fixing them one round at a time never produced a working paste:
//
//  1. **The 30 ms clock.** Rounds eleven and twelve resolved an Enter that
//     ends a read by asking whether the previous read was recent. The next
//     read of a big paste arrives after the screen has been repainted for
//     the one before it, which is routinely slower than 30 ms, so a paste
//     split at a line boundary submitted itself half-finished. Replaced by
//     holding the Enter until something decides it — the same discipline
//     the decoder already used for a lone ESC, and one with no timing
//     assumption in it at all.
//  2. **Split UTF-8.** `stdin-router.ts` called `chunk.toString("utf8")`
//     per chunk, so a multi-byte character straddling a read boundary
//     became two replacement glyphs. Only a paste is big enough to be
//     split, which is why this only ever showed up here.
//  3. **Split code points.** win32-input-mode's `Uc` field is one UTF-16
//     code unit, so a pasted emoji arrives as two records and decoded as
//     two lone surrogates.
//  4. **The repeat count.** The same protocol's `Rc` field says how many
//     identical keystrokes a record stands for, and it was ignored —
//     dropping characters out of the middle of a paste.
//  5. **Control bytes reaching the buffer.** Tabs and copied ANSI colour
//     sequences were stored in `EditorState.lines[]` and painted verbatim,
//     which hands the terminal instructions rather than text and corrupts
//     the frame around them.
//
// Items 2 and 5 are, between them, the whole of "random characters"; 1 is
// "line breaking not correctly"; 3 and 4 are both.
//
// **Second pass.** That fixed the characters and not the line breaks: "the
// pasting now only lacks end line ... just end up as one line only". The
// hold in item 1 was gated on the previous read being too big to have been
// typed, and at small read sizes that evidence does not exist yet — so the
// paste's first newline still submitted. Rather than reason about read
// sizes a sixth time, the round wrote a fuzz (`paste-fuzz.test.ts`) that
// cuts every encoding at every offset. It found three more bugs, all of
// them at the bottom of this file, and the gate is gone: every trailing
// Enter is held now, and `routeStdin()` measures whether a read arrived
// back-to-back with the last one so a stall mid-paste is never mistaken
// for a person stopping.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodePasteBody, KeyDecoder } from "./input.js";
import { RawLineSource } from "./raw-line-source.js";
import { BURST_IDLE_FLUSH_MS, DEFAULT_IDLE_FLUSH_MS, routeStdin, type RouterTimer, type StdinLike } from "./stdin-router.js";
import { LineEditor, sanitizePastedText } from "../editor.js";
import { inputLogPath, visibleBytes, writeInputLog } from "./input-log.js";

/** One win32-input-mode record: `CSI Vk;Sc;Uc;Kd;Cs;Rc _`, key-down, no modifiers. */
function win32(vk: number, uc: number, repeat = 1): string {
  return `\x1b[${vk};0;${uc};1;0;${repeat}_`;
}

/** The byte stream a Windows console in win32-input-mode produces for pasted text — one record per UTF-16 code unit, `Vk` 0 because no physical key produced it. */
function win32Paste(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out += unit === 10 ? win32(13, 13) : win32(0, unit);
  }
  return out;
}

describe("round fourteen: a paste split across reads reassembles however slow the reads are", () => {
  it("a paste cut exactly at a line break survives an arbitrarily long gap between reads", () => {
    const d = new KeyDecoder();
    // Read one is a line of pasted text with no newline in it at all —
    // nothing position can rule on, but far more than a keystroke.
    d.feed("the first line of a pasted paragraph");
    // Read two is the newline that ended it, alone. This is the chunk that
    // submitted a half-finished paste in every round before this one.
    assert.deepEqual(d.feed("\r"), []);
    // Read three arrives whenever it arrives — a second later, a minute
    // later. The old 30 ms window is gone, and so is the submit it caused.
    // Its own trailing Enter is held in turn, so what comes out is the
    // paste up to that point.
    assert.deepEqual(d.feed("the second line"), [{ type: "paste", text: "\nthe second line" }]);
  });

  it("survives being cut into small pieces at every offset in the stream", () => {
    // Every read size, down to one byte at a time — which is what the
    // first pass at this round could not do, because it only held an Enter
    // after a read too big to have been typed and a one-byte read is never
    // that. A fuzz over sizes and idle-flush placements is what said so.
    const source = "one\ntwo\nthree\nand a longer tail to it";
    const stream = win32Paste(source);
    for (const size of [1, 2, 3, 5, 17, 23, 64, 199]) {
      const src = new RawLineSource();
      const submitted: string[] = [];
      void src.next().then((v) => {
        if (v !== null) submitted.push(v);
      });
      for (let i = 0; i < stream.length; i += size) src.feedBytes(stream.slice(i, i + size));
      src.flushPending();
      assert.deepEqual(src.editorState.lines, source.split("\n"), `cut every ${size} bytes`);
      assert.equal(submitted.length, 0, `a paste must never submit itself (cut every ${size} bytes)`);
    }
  });

  it("a paste whose LAST read is a bare newline still does not submit", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("one\ntwo"), [{ type: "paste", text: "one\ntwo" }]);
    // Held, like any Enter that ends a read — and `pasteInProgress` is
    // what decides it at the gap: position cannot see anything after this
    // newline, because there is nothing after it.
    assert.deepEqual(d.feed("\r"), []);
    assert.deepEqual(d.flush(), [{ type: "paste", text: "\n" }]);
    // The same gap ended the paste, so the NEXT Enter is a keypress.
    assert.deepEqual(d.feed("\r"), []);
    assert.deepEqual(d.flush(), [{ type: "enter" }]);
  });

  it("a typed Enter still submits, one idle gap later", () => {
    const src = new RawLineSource();
    const pending = src.next();
    for (const ch of "hello") src.feedBytes(ch);
    src.feedBytes("\r");
    // `routeStdin()` fires this 50 ms after the last byte and always has:
    // the same gap that has always resolved an ambiguous lone ESC. It is
    // the whole cost of never guessing about a newline again.
    src.flushPending();
    return pending.then((line) => assert.equal(line, "hello"));
  });
});

describe("round fourteen: every code point that goes in comes out", () => {
  it("rejoins a surrogate pair split across two win32 records", () => {
    const d = new KeyDecoder();
    // U+1F680 ROCKET, the way a Windows console reports it: two records.
    const events = d.feed(win32Paste("a🚀b\nc"));
    assert.deepEqual(events, [{ type: "paste", text: "a🚀b\nc" }]);
  });

  it("rejoins a surrogate pair split across two READS as well", () => {
    const d = new KeyDecoder();
    const rocket = win32Paste("🚀");
    // Cut between the two records, which is where a read boundary can land.
    const half = rocket.indexOf("_") + 1;
    assert.deepEqual(d.feed(rocket.slice(0, half)), []);
    assert.deepEqual(d.feed(rocket.slice(half) + win32Paste("\ny")), [{ type: "paste", text: "🚀\ny" }]);
  });

  it("honours the repeat count instead of dropping the characters it stands for", () => {
    const d = new KeyDecoder();
    // Four spaces of indentation, coalesced by the console into one record.
    const events = d.feed(win32(0, 32, 4) + win32Paste("x\ny"));
    assert.deepEqual(events, [{ type: "paste", text: "    x\ny" }]);
  });

  it("a repeat count of zero or empty still means one keystroke, never none", () => {
    assert.deepEqual(new KeyDecoder().feed("\x1b[0;0;97;1;0;0_"), [{ type: "char", value: "a" }]);
    assert.deepEqual(new KeyDecoder().feed("\x1b[0;0;97;1;0;_"), [{ type: "char", value: "a" }]);
  });

  it("a multi-byte character split across two stdin reads is not two replacement glyphs", () => {
    const listeners: ((chunk: Buffer | string) => void)[] = [];
    const stdin: StdinLike = {
      on: (_e, l) => void listeners.push(l),
      off: () => {},
    };
    const timer: RouterTimer = { setTimer: () => 0, clearTimer: () => {} };
    const src = new RawLineSource();
    void src.next();
    routeStdin({ stdin, primary: src, overlay: { isOpen: false, feedBytes: () => {}, flushPending: () => {} }, timer });

    const bytes = Buffer.from("héllo wörld");
    // Cut inside the two-byte é. `chunk.toString("utf8")` on each half
    // produced U+FFFD twice; the stateful decoder holds the first byte.
    listeners[0]!(bytes.subarray(0, 2));
    listeners[0]!(bytes.subarray(2));
    assert.equal(src.editorState.lines.join("\n"), "héllo wörld");
  });
});

describe("round fourteen: nothing a paste carries can reach the frame as an instruction", () => {
  it("strips the ANSI colour sequences that come with text copied out of a terminal", () => {
    assert.equal(sanitizePastedText("\x1b[31mred\x1b[0m and \x1b[1;32mgreen\x1b[m"), "red and green");
  });

  it("strips an OSC title sequence, terminator and all", () => {
    assert.equal(sanitizePastedText("\x1b]0;window title\x07after"), "after");
  });

  it("expands tabs rather than storing a byte the terminal will act on", () => {
    const ed = new LineEditor();
    ed.insertText("def f():\n\treturn 1");
    assert.deepEqual(ed.state.lines, ["def f():", "    return 1"]);
  });

  it("drops the remaining control bytes and keeps every printable one", () => {
    assert.equal(sanitizePastedText("a\x00b\x07c\x7fd\u0085e"), "abcde");
    assert.equal(sanitizePastedText("naïve — 日本語 🚀"), "naïve — 日本語 🚀");
  });

  it("a pasted tab reaches the editor as spaces even on the win32 path, and never triggers completion", () => {
    const src = new RawLineSource();
    void src.next();
    // A tab in the middle of a run is pasted by the same position rule an
    // Enter is: it had text after it. Before this round it arrived as a
    // Tab KEY, which either did nothing or accepted a completion — that
    // second outcome is literally "random characters added to the text".
    src.feedBytes(win32Paste("if x:\n\tpass\n"));
    src.flushPending();
    assert.deepEqual(src.editorState.lines, ["if x:", "    pass", ""]);
    assert.equal(src.completionActive, false);
  });
});

describe("round fourteen: a paste that straddles the idle gap is not thrown away", () => {
  it("keeps waiting for the rest of a bracketed paste instead of surfacing it as unknown", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("\x1b[200~half a p"), []);
    // The idle timer fires mid-paste on a slow link. This used to emit an
    // `unknown` event, which the caller drops on the floor — the paste
    // simply vanished, and the terminal's closing marker then arrived as
    // stray text.
    assert.deepEqual(d.flush(), []);
    assert.deepEqual(d.feed("aste\x1b[201~"), [{ type: "paste", text: "half a paste" }]);
  });

  it("still resolves a lone ESC, which is what flush() is for", () => {
    const d = new KeyDecoder();
    d.feed("\x1b");
    assert.deepEqual(d.flush(), [{ type: "escape" }]);
  });

  it("keeps waiting for the rest of a win32 record too", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed("\x1b[0;0;9"), []);
    assert.deepEqual(d.flush(), []);
    assert.deepEqual(d.feed("7;1;0;1_"), [{ type: "char", value: "a" }]);
  });
});

// The round's second pass, after the maintainer reported that the paste
// now arrived with no line breaks at all: "the pasting now only lacks end
// line ... just end up as one line only". Everything below is a bug the
// fuzz (`paste-fuzz.test.ts`) found and the round's own hand-written tests
// had missed, because each of them was written for the read size its fix
// imagined.

describe("round fourteen, second pass: what the fuzz found", () => {
  it("a read boundary inside an escape sequence does not turn the rest of it into typed characters", () => {
    const d = new KeyDecoder();
    // One win32 record, cut after its ESC. The idle timer fires in the gap.
    d.feed(win32Paste("a")); // establishes that this session speaks win32-input-mode
    d.flush();
    assert.deepEqual(d.feed("\x1b"), []);
    // Before: `flush()` resolved that lone ESC as the Escape KEY, cleared
    // the buffer, and the record's remaining bytes then decoded as the
    // literal text `0;0;13;1;0;1_`. In win32-input-mode the Escape key
    // arrives as a record of its own, so a bare ESC is never that key.
    assert.deepEqual(d.flush(), []);
    assert.deepEqual(d.feed("[0;0;98;1;0;1_"), [{ type: "char", value: "b" }]);
  });

  it("a CRLF split across two reads is still one line break, not two", () => {
    const d = new KeyDecoder();
    d.feed("one");
    assert.deepEqual(d.feed("\r"), []);
    assert.deepEqual(d.feed("\ntwo"), [{ type: "paste", text: "\ntwo" }]);
  });

  it("a stranded lone CR is still resolved by the idle gap, never stuck", () => {
    const d = new KeyDecoder();
    d.feed("done");
    d.feed("\r");
    assert.deepEqual(d.flush(), [{ type: "enter" }]);
  });

  it("a read that arrives back-to-back with the last one is what tells a stall from a keypress", () => {
    // Not contiguous: a person stopped, so the Enter they left behind is a
    // submit.
    const typed = new KeyDecoder();
    typed.feed("hello");
    typed.feed("\r", { contiguous: false });
    assert.deepEqual(typed.flush(), [{ type: "enter" }]);

    // Contiguous: the reads came in faster than a hand can produce them,
    // so the same trailing Enter is a pasted line break and the idle gap
    // resolves it as one rather than sending half a paste.
    const pasted = new KeyDecoder();
    pasted.feed("hello", { contiguous: true });
    pasted.feed("\r", { contiguous: true });
    assert.deepEqual(pasted.flush(), [{ type: "paste", text: "\n" }]);
  });

  it("the router measures that gap from the END of the previous read, and waits far longer after a burst", () => {
    const listeners: ((chunk: Buffer | string) => void)[] = [];
    const stdin: StdinLike = { on: (_e, l) => void listeners.push(l), off: () => {} };
    const delays: number[] = [];
    const timer: RouterTimer = {
      setTimer: (_fn, ms) => {
        delays.push(ms);
        return 0;
      },
      clearTimer: () => {},
    };
    const seen: Array<{ text: string; contiguous: boolean }> = [];
    const target = {
      feedBytes: (text: string, opts?: { contiguous?: boolean }) => void seen.push({ text, contiguous: opts?.contiguous === true }),
      flushPending: () => {},
    };
    let clock = 1_000;
    routeStdin({
      stdin,
      primary: target,
      overlay: { isOpen: false, feedBytes: () => {}, flushPending: () => {} },
      timer,
      now: () => clock,
    });

    listeners[0]!("a"); // first read: nothing to be contiguous with
    listeners[0]!("b"); // same millisecond — a burst
    clock += 500; // a person thinking, then typing
    listeners[0]!("c");

    assert.deepEqual(seen.map((s) => s.contiguous), [false, true, false]);
    // And the patience each read buys: a burst read is given far longer
    // before the stream is called idle than a typed one.
    assert.deepEqual(delays, [DEFAULT_IDLE_FLUSH_MS, BURST_IDLE_FLUSH_MS, DEFAULT_IDLE_FLUSH_MS]);
  });
});

describe("round fourteen: the input capture that ended the guessing", () => {
  it("writes nothing at all unless LYKOS_INPUT_LOG names a file", () => {
    assert.equal(inputLogPath({}), undefined);
    assert.equal(inputLogPath({ LYKOS_INPUT_LOG: "" }), undefined);
    assert.equal(inputLogPath({ LYKOS_INPUT_LOG: "/tmp/keys.jsonl" }), "/tmp/keys.jsonl");
    // The writer is a no-op with capture off, and must not throw.
    writeInputLog({ kind: "feed", events: [], lines: [] }, {});
  });

  it("makes a control byte readable rather than writing it into the log verbatim", () => {
    assert.equal(visibleBytes("\x1b[0;0;13;1;0;1_"), "\\e[0;0;13;1;0;1_");
    assert.equal(visibleBytes("a\rb\nc\td"), "a\\rb\\nc\\td");
    assert.equal(visibleBytes("\u{1F680}"), "\\u{1f680}");
  });
});

// The fourth pass, and the end of the guessing. `LYKOS_INPUT_LOG` captured
// what the maintainer's terminal actually sends, and the answer was a
// shape six rounds of inference had ruled out: Windows Terminal DOES send
// bracketed paste while win32-input-mode is on, and inside the markers it
// mixes plain text with win32 key records — one for each line break.
//
// The bytes below are copied from that capture verbatim.

/** One line of `paste-capture.jsonl`, unescaped back into the bytes the terminal sent. */
const CAPTURED_PASTE =
  "\x1b[200~and\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_" +
  "or\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_" +
  "hi\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_" +
  "kkk\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_" +
  "ttt\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_" +
  "haha\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_hello\x1b[201~";

describe("round fourteen, fourth pass: the bytes the terminal actually sends", () => {
  it("decodes the captured paste into the six lines that were pasted", () => {
    const d = new KeyDecoder();
    assert.deepEqual(d.feed(CAPTURED_PASTE), [{ type: "paste", text: "and\nor\nhi\nkkk\nttt\nhaha\nhello" }]);
  });

  it("puts them in the composer as six lines, with no clipboard involved at all", () => {
    const src = new RawLineSource(); // no readClipboard: the decoder alone must be right
    void src.next();
    src.feedBytes(CAPTURED_PASTE);
    src.flushPending();
    assert.deepEqual(src.editorState.lines, ["and", "or", "hi", "kkk", "ttt", "haha", "hello"]);
  });

  it("survives the capture's own read boundaries — and any other", () => {
    for (const size of [1, 2, 3, 7, 16, 33, 64, CAPTURED_PASTE.length]) {
      const src = new RawLineSource();
      void src.next();
      for (let i = 0; i < CAPTURED_PASTE.length; i += size) {
        src.feedBytes(CAPTURED_PASTE.slice(i, i + size), { contiguous: i > 0 });
      }
      src.flushPending();
      assert.deepEqual(src.editorState.lines, ["and", "or", "hi", "kkk", "ttt", "haha", "hello"], `${size}-byte reads`);
    }
  });

  it("decodes a payload's tabs and repeat counts too, and drops its key-up records", () => {
    assert.equal(decodePasteBody("a\x1b[9;0;9;1;0;1_b"), "a\tb");
    assert.equal(decodePasteBody("\x1b[0;0;32;1;0;4_x"), "    x");
    assert.equal(decodePasteBody("a\x1b[65;0;97;0;0;1_b"), "ab");
  });

  it("rejoins a surrogate pair sent as two records inside a payload", () => {
    // U+1F680 as a Windows console reports it: one record per code unit.
    assert.equal(decodePasteBody("\x1b[0;0;55357;1;0;1_\x1b[0;0;56960;1;0;1_"), "\u{1F680}");
  });

  it("leaves a payload with no records in it exactly as it was", () => {
    assert.equal(decodePasteBody("plain\rtext\r\nhere"), "plain\rtext\r\nhere");
  });
});
