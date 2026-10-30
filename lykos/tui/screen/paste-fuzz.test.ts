// The paste fuzz — round fourteen's second pass, and the reason there was
// one.
//
// Five rounds of this bug were diagnosed by reasoning about how a terminal
// "probably" delivers a paste, and five rounds shipped a fix that looked
// right and left paste broken. The thing every one of them had in common
// is that the example in the fix's own test was the shape the fix was
// written for: one read, or two reads cut where the author imagined.
//
// This file does not reason. It takes a known pasted string, encodes it
// the way each protocol Lykos can actually meet would, cuts the byte
// stream at every offset from one byte upward, optionally stalls in the
// middle, and asserts that what lands in the composer is character-for-
// character what was pasted and that nothing was submitted on the way.
// The first run of it found three bugs that had survived the round's own
// hand-written tests — a lost line break at every small read size, a
// destroyed escape sequence whose remaining bytes became literal digits in
// the prompt, and a pasted tab that reached the tab completer.
//
// The physical model matters and is asserted here rather than assumed: a
// read that arrives back-to-back with the previous one is `contiguous`
// (what `routeStdin()` measures), and an idle flush only ever happens
// after silence — so the read AFTER a flush is never contiguous. Keeping
// those two consistent is what makes a failure here mean something.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RawLineSource } from "./raw-line-source.js";

const down = (vk: number, uc: number): string => `\x1b[${vk};0;${uc};1;0;1_`;
const up = (vk: number, uc: number): string => `\x1b[${vk};0;${uc};0;0;1_`;

/** What a Windows console in win32-input-mode sends for pasted text: one record per UTF-16 code unit, and optionally the key-up edge of each. */
function win32Paste(text: string, withUp: boolean): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    const [vk, uc] = unit === 10 ? [13, 13] : [0, unit];
    out += down(vk, uc);
    if (withUp) out += up(vk, uc);
  }
  return out;
}

/**
 * What Windows Terminal actually sends, captured from the maintainer's
 * machine on 2026-09-02 (`LYKOS_INPUT_LOG`): bracketed paste markers around
 * a payload that mixes PLAIN printable text with win32-input-mode records —
 * one down-and-up pair per line break. Six rounds of this bug were spent
 * because every one of them assumed a paste was one or the other.
 */
function bracketedWithRecords(source: string): string {
  const body = source
    .split("\n")
    .join(`${down(13, 13)}${up(13, 13)}`);
  return `\x1b[200~${body}\x1b[201~`;
}

/** Every byte stream a paste of `source` can arrive as, across the protocols Lykos supports. */
function encodings(source: string): Record<string, string> {
  return {
    bracketedWithRecords: bracketedWithRecords(source),
    win32: win32Paste(source, false),
    win32WithUp: win32Paste(source, true),
    plainLF: source,
    plainCR: source.replace(/\n/g, "\r"),
    plainCRLF: source.replace(/\n/g, "\r\n"),
    bracketedCR: `\x1b[200~${source.replace(/\n/g, "\r")}\x1b[201~`,
  };
}

/** What the composer should hold afterwards: the source, with tabs expanded the way `sanitizePastedText()` expands them. */
function expected(source: string): string[] {
  return source.replace(/\t/g, "    ").split("\n");
}

interface Run {
  lines: string[];
  submitted: string[];
}

/** Feed `stream` to a fresh composer in `size`-byte reads, stalling every `flushEvery` reads (0 for never), and report what landed. */
function feedInPieces(stream: string, size: number, flushEvery: number): Run {
  const src = new RawLineSource();
  const submitted: string[] = [];
  const pump = (): void => {
    void src.next().then((line) => {
      if (line !== null) {
        submitted.push(line);
        pump();
      }
    });
  };
  pump();

  let reads = 0;
  let first = true;
  let stalled = false;
  for (let i = 0; i < stream.length; i += size) {
    // A stall is silence, and silence is what breaks a burst: the read
    // after a flush cannot be contiguous with the read before it.
    src.feedBytes(stream.slice(i, i + size), { contiguous: !first && !stalled });
    first = false;
    stalled = false;
    if (flushEvery > 0 && ++reads % flushEvery === 0) {
      src.flushPending();
      stalled = true;
    }
  }
  src.flushPending();
  return { lines: [...src.editorState.lines], submitted };
}

const SOURCES = [
  "one\ntwo\nthree",
  "a\nb",
  "the first line\nthe second one\n",
  "x\n\ny",
  "def f():\n\treturn 1\n",
  "emoji \u{1F680} and text\nsecond line",
  "trailing spaces   \n   leading spaces",
];

const SIZES = [1, 2, 3, 5, 7, 11, 16, 17, 31, 64, 128, 4096];

describe("paste fuzz: a paste survives every read boundary", () => {
  for (const source of SOURCES) {
    it(`${JSON.stringify(source)} — every encoding, every read size`, () => {
      for (const [protocol, stream] of Object.entries(encodings(source))) {
        for (const size of SIZES) {
          const { lines, submitted } = feedInPieces(stream, size, 0);
          const where = `${protocol}, ${size}-byte reads`;
          assert.deepEqual(lines, expected(source), where);
          assert.equal(submitted.length, 0, `a paste must never submit itself (${where})`);
        }
      }
    });
  }
});

/**
 * Feed `stream` in `size`-byte reads, pausing every `stallEvery` reads for
 * longer than a burst but less than `BURST_IDLE_FLUSH_MS` — the terminal
 * hesitating mid-paste. No flush fires (the router's timer has not come
 * round yet); what changes is that the read after the pause is no longer
 * contiguous with the one before it.
 */
function feedWithStalls(stream: string, size: number, stallEvery: number): Run {
  const src = new RawLineSource();
  const submitted: string[] = [];
  const pump = (): void => {
    void src.next().then((line) => {
      if (line !== null) {
        submitted.push(line);
        pump();
      }
    });
  };
  pump();

  let reads = 0;
  let first = true;
  let stalled = false;
  for (let i = 0; i < stream.length; i += size) {
    src.feedBytes(stream.slice(i, i + size), { contiguous: !first && !stalled });
    first = false;
    stalled = stallEvery > 0 && ++reads % stallEvery === 0;
  }
  src.flushPending();
  return { lines: [...src.editorState.lines], submitted };
}

describe("paste fuzz: a paste survives the terminal hesitating in the middle of it", () => {
  // The case round eleven's 30 ms window was built for and could not cover:
  // a terminal that pauses mid-paste for longer than a person's keystroke
  // gap. `routeStdin()` answers it by giving a read that arrived mid-burst
  // a much longer patience before it calls the stream idle
  // (`BURST_IDLE_FLUSH_MS`), so the pause modelled here is one the flush
  // timer does not fire in — which is every pause up to a second and a
  // half. A pause LONGER than that is named in DECISIONS.md as the one
  // shape still capable of splitting a paste, rather than pretended away.
  for (const stallEvery of [1, 2, 3, 5]) {
    it(`hesitating every ${stallEvery} reads still leaves the whole paste in the composer`, () => {
      for (const source of SOURCES) {
        for (const [protocol, stream] of Object.entries(encodings(source))) {
          for (const size of SIZES) {
            const where = `${protocol}, ${size}-byte reads, hesitating every ${stallEvery}`;
            const { lines, submitted } = feedWithStalls(stream, size, stallEvery);
            assert.deepEqual(lines, expected(source), where);
            assert.equal(submitted.length, 0, `a paste must never submit itself (${where})`);
          }
        }
      }
    });
  }
});
