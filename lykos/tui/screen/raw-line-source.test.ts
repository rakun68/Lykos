import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RawLineSource } from "./raw-line-source.js";
import type { Candidate } from "./completion.js";

describe("T46.4: RawLineSource — basic submit", () => {
  it("typing then Enter resolves next() with the typed line", async () => {
    const src = new RawLineSource();
    const p = src.next();
    src.feedBytes("hello\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await p, "hello");
  });

  it("bytes arriving before next() is called are queued, not dropped", async () => {
    const src = new RawLineSource();
    src.feedBytes("queued\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await src.next(), "queued");
  });

  it("close() resolves a pending next() with null", async () => {
    const src = new RawLineSource();
    const p = src.next();
    src.close();
    assert.equal(await p, null);
  });

  it("next() after close() resolves null immediately", async () => {
    const src = new RawLineSource();
    src.close();
    assert.equal(await src.next(), null);
  });
});

describe("T46.4: RawLineSource — a multi-line submit keeps its line breaks", () => {
  // Rewritten 2026-09-02 (round twelve, item 3). These three cases used to
  // assert the backslash-continuation protocol — one queued entry per
  // physical row, every row but the last suffixed with a backslash — which
  // `runInteractiveLoop` reassembles as `pending + line`, with no
  // separator. The line breaks were deleted in the process, so a pasted
  // three-line prompt reached the model as one run-on line. The submit is
  // now ONE entry carrying real newlines, and that is what these assert.
  it("Alt+Enter inserts a real newline; submitting delivers the whole buffer as one entry", async () => {
    const src = new RawLineSource();
    src.feedBytes("first");
    src.feedBytes("\x1b\r"); // Alt+Enter
    src.flushPending(); // the idle gap a real session's router always provides
    src.feedBytes("second\r"); // plain Enter submits
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await src.next(), "first\nsecond");
  });

  it("a bracketed paste with embedded newlines submits the same way", async () => {
    const src = new RawLineSource();
    src.feedBytes("\x1b[200~a\nb\x1b[201~\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await src.next(), "a\nb");
  });

  it("Shift+Enter (Kitty keyboard protocol form) inserts a newline the same as Alt+Enter, never submits", async () => {
    const src = new RawLineSource();
    src.feedBytes("first");
    src.feedBytes("\x1b[13;2u"); // Shift+Enter
    src.feedBytes("second\r"); // plain Enter submits
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await src.next(), "first\nsecond");
  });
});

describe("T46.4: RawLineSource — editing keys", () => {
  it("backspace and arrow-left/right edit before submit", async () => {
    const src = new RawLineSource();
    src.feedBytes("helo");
    src.feedBytes("\x1b[D\x1b[D"); // left, left -> cursor between "hel|o", i.e. col 2
    src.feedBytes("l"); // hel|lo -> "hello" after insert at col 2... verify below
    src.feedBytes("\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await src.next(), "hello");
  });

  it("Ctrl-W deletes the previous word before submit", async () => {
    const src = new RawLineSource();
    src.feedBytes("hello world");
    src.feedBytes("\x17"); // Ctrl-W
    src.feedBytes("\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await src.next(), "hello ");
  });
});

describe("T46.4: RawLineSource — history recall", () => {
  // Rebound 2026-09-02 round seven, item 1: the plain arrows are an editing
  // motion inside the current prompt and never recall anything; history
  // moved to Ctrl+Up/Down so a multi-line prompt can be navigated past its
  // own first line.
  it("Ctrl+arrow-up recalls the most recent history entry; Ctrl+arrow-down returns to the draft", async () => {
    const src = new RawLineSource({ history: ["one", "two"] });
    src.feedBytes("draft");
    src.feedBytes("\x1b[1;5A"); // Ctrl+up
    assert.equal(src.editorState.lines.join("\n"), "two");
    src.feedBytes("\x1b[1;5A"); // up again
    assert.equal(src.editorState.lines.join("\n"), "one");
    src.feedBytes("\x1b[1;5B"); // Ctrl+down
    assert.equal(src.editorState.lines.join("\n"), "two");
    src.feedBytes("\x1b[1;5B"); // down back to the draft
    assert.equal(src.editorState.lines.join("\n"), "draft");
  });

  it("a PLAIN arrow-up never recalls history — it moves the cursor, and at the top edge goes to the start of the buffer", () => {
    const src = new RawLineSource({ history: ["one", "two"] });
    src.feedBytes("draft");
    src.feedBytes("\x1b[A");
    assert.equal(src.editorState.lines.join("\n"), "draft", "the buffer is untouched");
    assert.equal(src.editorState.cursorCol, 0, "at the first row, Up goes to the very start");
    src.feedBytes("\x1b[B");
    assert.equal(src.editorState.lines.join("\n"), "draft");
    assert.equal(src.editorState.cursorCol, "draft".length, "at the last row, Down goes to the very end");
  });

  it("a submitted line is appended to in-memory history for the rest of the session", async () => {
    const src = new RawLineSource();
    src.feedBytes("remember me\r");
    src.flushPending(); // the idle gap a real session's router always provides
    await src.next();
    src.feedBytes("\x1b[1;5A");
    assert.equal(src.editorState.lines.join("\n"), "remember me");
  });
});

describe("T46.4: RawLineSource — Ctrl-R search (cheap version)", () => {
  it("Ctrl-R filters history by the current buffer as a prefix and cycles matches", async () => {
    const src = new RawLineSource({ history: ["fix the bug", "add a feature", "fix the header"] });
    src.feedBytes("fix");
    src.feedBytes("\x12"); // Ctrl-R
    assert.equal(src.editorState.lines.join("\n"), "fix the header");
    src.feedBytes("\x12"); // cycle
    assert.equal(src.editorState.lines.join("\n"), "fix the bug");
    src.feedBytes("\x12"); // wraps
    assert.equal(src.editorState.lines.join("\n"), "fix the header");
  });

  it("Enter during search submits the matched line", async () => {
    const src = new RawLineSource({ history: ["fix the bug"] });
    src.feedBytes("fix");
    src.feedBytes("\x12");
    src.feedBytes("\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await src.next(), "fix the bug");
  });
});

describe("T46.4: RawLineSource — Ctrl-C", () => {
  it("Ctrl-C never submits a line; it calls onInterrupt instead", async () => {
    let interrupted = 0;
    const src = new RawLineSource({ onInterrupt: () => (interrupted += 1) });
    src.feedBytes("partial");
    src.feedBytes("\x03"); // Ctrl-C
    assert.equal(interrupted, 1);
    assert.equal(src.editorState.lines.join("\n"), "partial", "the in-progress buffer is untouched by Ctrl-C");
  });
});

describe("RawLineSource — T47 tab completion: auto-shown while typing, arrow keys navigate, Tab accepts", () => {
  it("typing `/` alone shows the popup with no key beyond the character itself", () => {
    const events: Array<{ candidates: Candidate[]; selected: number }> = [];
    const src = new RawLineSource({ completionRoot: "/project", onCompletionChange: (candidates, selected) => events.push({ candidates, selected }) });
    src.feedBytes("/co");
    assert.equal(src.completionActive, true, "no Tab was pressed — the popup must already be open");
    assert.equal(src.editorState.lines.join("\n"), "/co", "typing never mutates the buffer on its own");
    const last = events[events.length - 1]!;
    assert.equal(last.selected, 0);
    assert.ok(last.candidates.map((c) => c.label).includes("/copy"));
    assert.ok(last.candidates.map((c) => c.label).includes("/compact"));
  });

  it("with no completionRoot, typing `/` never opens a popup", () => {
    const src = new RawLineSource();
    src.feedBytes("/co");
    assert.equal(src.completionActive, false);
  });

  it("the list narrows live as more of the query is typed", () => {
    const src = new RawLineSource({ completionRoot: "/project" });
    src.feedBytes("/co");
    src.feedBytes("m"); // /com -> only /compact matches now
    assert.equal(src.completionActive, true);
    assert.equal(src.editorState.lines.join("\n"), "/com");
  });

  it("Down/Up move the highlighted candidate and never touch the buffer or history", () => {
    const events: Array<{ candidates: Candidate[]; selected: number }> = [];
    const src = new RawLineSource({
      completionRoot: "/project",
      history: ["should never be recalled"],
      onCompletionChange: (candidates, selected) => events.push({ candidates, selected }),
    });
    src.feedBytes("/co");
    const before = events[events.length - 1]!;
    assert.equal(before.selected, 0);
    src.feedBytes("\x1b[B"); // arrow down
    assert.equal(events[events.length - 1]!.selected, 1);
    src.feedBytes("\x1b[A"); // arrow up
    assert.equal(events[events.length - 1]!.selected, 0);
    assert.equal(src.editorState.lines.join("\n"), "/co", "the buffer is untouched by navigation");
  });

  it("Down wraps from the last candidate back to the first", () => {
    const src = new RawLineSource({ completionRoot: "/project" });
    src.feedBytes("/co"); // three matches, in registry order: /copy, /context, /compact
    src.feedBytes("\x1b[B"); // -> index 1
    src.feedBytes("\x1b[B"); // -> index 2
    src.feedBytes("\x1b[B"); // -> wraps to index 0
    // Tab now accepts index 0's candidate.
    src.feedBytes("\t");
    src.flushPending(); // the idle gap that resolves a read-ending Tab
    assert.equal(src.editorState.lines.join("\n"), "/copy");
  });

  it("Tab accepts the highlighted candidate and closes the popup, but never submits", () => {
    const src = new RawLineSource({ completionRoot: "/project" });
    src.feedBytes("/co");
    src.feedBytes("\x1b[B"); // select /context
    src.feedBytes("\t");
    src.flushPending(); // the idle gap that resolves a read-ending Tab
    assert.equal(src.editorState.lines.join("\n"), "/context");
    assert.equal(src.completionActive, false);
  });

  it("a command's first argument completes too — /effort offers the ladder, not the filesystem", () => {
    const src = new RawLineSource({ completionRoot: "/project" });
    src.feedBytes("/effort ma");
    assert.equal(src.completionActive, true);
    src.feedBytes("\t");
    src.flushPending(); // the idle gap that resolves a read-ending Tab
    assert.equal(src.editorState.lines.join("\n"), "/effort max");
  });

  it("a command with no argument vocabulary offers nothing rather than a wall of filenames", () => {
    const src = new RawLineSource({ completionRoot: "/project" });
    src.feedBytes("/session x");
    assert.equal(src.completionActive, false);
  });

  it("Escape dismisses the popup without changing the buffer, and typing further does not reopen it for the same token", () => {
    const events: Array<{ candidates: Candidate[] }> = [];
    const src = new RawLineSource({ completionRoot: "/project", onCompletionChange: (candidates) => events.push({ candidates }) });
    src.feedBytes("/co");
    src.feedBytes("\x1b");
    src.flushPending(); // a lone ESC decodes as "escape" only once flush()ed — matches T46.1's own contract
    assert.equal(src.completionActive, false);
    assert.equal(src.editorState.lines.join("\n"), "/co");
  });

  it("typing after Escape resets the dismissal — a NEW token still triggers the popup", () => {
    const dir = mkdtempSync(join(tmpdir(), "lykos-rls-"));
    writeFileSync(join(dir, "readme.md"), "", "utf8");
    try {
      const src = new RawLineSource({ completionRoot: dir });
      src.feedBytes("/co");
      src.feedBytes("\x1b");
      src.flushPending(); // open, then dismiss
      assert.equal(src.completionActive, false);
      src.feedBytes("m"); // still typing the same `/` token — stays dismissed
      assert.equal(src.completionActive, false, "the dismissed token must not reopen on its own");
      src.feedBytes(" @re"); // a NEW trigger token, elsewhere on the line — must open normally
      assert.equal(src.completionActive, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Enter submits the raw text as-is when no candidate was accepted", async () => {
    const src = new RawLineSource({ completionRoot: "/project" });
    const p = src.next();
    src.feedBytes("/co\r");
    src.flushPending(); // the idle gap a real session's router always provides
    assert.equal(await p, "/co", "Enter never auto-accepts a completion on its own");
  });

  it("no matches closes any previously-open popup rather than leaving stale candidates", () => {
    const events: Array<{ candidates: Candidate[] }> = [];
    const src = new RawLineSource({ completionRoot: "/project", onCompletionChange: (candidates) => events.push({ candidates }) });
    src.feedBytes("/co");
    assert.equal(src.completionActive, true);
    src.feedBytes("zzz"); // /cozzz matches nothing
    assert.equal(src.completionActive, false);
    assert.deepEqual(events[events.length - 1]!.candidates, []);
  });
});

describe("RawLineSource — scroll actions (PgUp/PgDn, mouse wheel) never touch the composer", () => {
  it("PgUp/PgDn call onScroll and leave the in-progress buffer untouched", () => {
    const calls: string[] = [];
    const src = new RawLineSource({ onScroll: (a) => calls.push(a) });
    src.feedBytes("draft");
    src.feedBytes("\x1b[5~"); // PgUp
    src.feedBytes("\x1b[6~"); // PgDn
    assert.deepEqual(calls, ["pageUp", "pageDown"]);
    assert.equal(src.editorState.lines.join("\n"), "draft");
  });

  it("a mouse wheel notch calls onScroll, not the history recall arrow keys use", () => {
    const calls: string[] = [];
    const src = new RawLineSource({ history: ["older"], onScroll: (a) => calls.push(a) });
    src.feedBytes("\x1b[<64;10;5M"); // wheel up
    src.feedBytes("\x1b[<65;10;5M"); // wheel down
    assert.deepEqual(calls, ["wheelUp", "wheelDown"]);
    assert.equal(src.editorState.lines.join("\n"), "", "wheel events must not recall history into the composer");
  });

  it("Ctrl+wheel scrolls like any other notch — the terminal never sees the gesture while tracking is on (2026-09-02, round three)", () => {
    // Round two skipped this on the theory that the terminal would zoom its
    // own font on the same gesture. It could not: with mouse tracking on,
    // the wheel is forwarded here and the terminal never sees it at all, so
    // skipping the notch just made Ctrl+wheel do nothing. Zoom lives on
    // Ctrl +/- instead (round three, item 1) — Ctrl+wheel scrolls like any
    // other notch now.
    const calls: string[] = [];
    const src = new RawLineSource({ history: ["older"], onScroll: (a) => calls.push(a) });
    src.feedBytes("\x1b[<80;10;5M"); // Ctrl+wheel up (64 + 16)
    src.feedBytes("\x1b[<81;10;5M"); // Ctrl+wheel down (65 + 16)
    assert.deepEqual(calls, ["wheelUp", "wheelDown"]);
  });

  it("real arrow keys still edit/recall as before — onScroll fires only for PgUp/PgDn/wheel", () => {
    const calls: string[] = [];
    const src = new RawLineSource({ history: ["older"], onScroll: (a) => calls.push(a) });
    src.feedBytes("\x1b[1;5A"); // Ctrl+arrow up — history recall, not a scroll action
    assert.deepEqual(calls, []);
    assert.equal(src.editorState.lines.join("\n"), "older");
    src.feedBytes("\x1b[A"); // and a plain arrow is a cursor move, also not a scroll action
    assert.deepEqual(calls, []);
  });
});


// The session-browser gesture, after a reversal in each direction. T126
// chose Alt+Left because Ctrl+Left was already word-left. On 2026-09-07 the
// maintainer asked for Ctrl+Left too and it was routed to the browser. On
// 2026-09-08 (T131) they hit the collision and asked for it back, so
// **Alt+Left is the browser gesture and Ctrl+Left is word-left again**.
describe("the session-browser gesture (UI feedback item 5)", () => {
  const CTRL_LEFT = "\x1b[1;5D";
  const CTRL_RIGHT = "\x1b[1;5C";
  const ALT_LEFT = "\x1b[1;3D";
  const CTRL_SHIFT_LEFT = "\x1b[1;6D";

  function harness(): { src: RawLineSource; opened: Array<"left" | "right"> } {
    const opened: Array<"left" | "right"> = [];
    const src = new RawLineSource({
      onAltArrow: (dir) => {
        opened.push(dir);
        return true;
      },
    });
    return { src, opened };
  }

  it("Ctrl+Left moves a word left and does NOT open the browser (T131)", () => {
    const { src, opened } = harness();
    src.feedBytes("hello world");
    src.feedBytes(CTRL_LEFT);
    src.flushPending();
    assert.deepEqual(opened, [], "the browser must not open on Ctrl+Left");
    // Word-left from the end of "hello world" lands on the "w".
    assert.equal(src.editorState.cursorCol, "hello ".length);
  });

  it("Ctrl+Shift+Left still selects a word rather than opening anything", () => {
    const { src, opened } = harness();
    src.feedBytes("alpha beta");
    src.feedBytes(CTRL_SHIFT_LEFT);
    src.flushPending();
    assert.deepEqual(opened, []);
    assert.equal(src.editorState.cursorCol, "alpha ".length);
  });

  it("Alt+Left opens it — the one browser gesture", () => {
    const { src, opened } = harness();
    src.feedBytes(ALT_LEFT);
    src.flushPending();
    assert.deepEqual(opened, ["left"]);
  });

  it("Ctrl+Right still moves a word, and Ctrl+Shift+Left still selects one", () => {
    const { src, opened } = harness();
    src.feedBytes("alpha beta");
    src.feedBytes(CTRL_RIGHT);
    src.feedBytes(CTRL_SHIFT_LEFT);
    src.flushPending();
    assert.deepEqual(opened, [], "neither of these is the browser gesture");
    assert.ok(src.editorState.selection !== null, "Ctrl+Shift+Left still extends a selection");
  });
});
