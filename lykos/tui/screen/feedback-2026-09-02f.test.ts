// The seventh 2026-09-02 UI feedback round — four numbered items, asserted
// in the maintainer's own order and named by their number, the same
// discipline as every round before this one.
//
// Items 1 and 3 are one rebinding seen from two sides: the plain arrows
// become an editing motion inside the current prompt (and finally respect
// soft word-wrap, closing the limitation round five wrote down), history
// recall moves to Ctrl+Up/Down, and the completion popup stops swallowing
// the modified form. Item 2 makes the one irreversible gesture cost two
// presses. Item 4 is about transcript ORDER — a decision and the output it
// produced belong next to each other.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ApprovalRequest } from "../../gate/approval.js";
import { RawApprovalGate } from "./approval-modal.js";
import { RawLineSource, type ComposerGeometry } from "./raw-line-source.js";
import { renderComposer, COMPOSER_PREFIX_WIDTH } from "./composer.js";
import { DoublePressExit, CTRL_C_EXIT_WINDOW_MS } from "../../session/interactive.js";
import { resolveTheme } from "../theme/resolve.js";

const theme = resolveTheme("mono", "none", "unicode");

function req(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return { kind: "bash", summary: "run command", detail: "npm install", ...overrides };
}

/**
 * A line source wired to the REAL composer renderer, so the visual row map
 * the arrows navigate is the one production actually paints rather than a
 * hand-written fixture that could drift from it.
 */
function sourceWithComposer(opts: { width?: number; maxBodyRows?: number; history?: string[]; completionRoot?: string } = {}): RawLineSource {
  const width = opts.width ?? 24;
  let src: RawLineSource;
  const geometry = (): ComposerGeometry => {
    const composer = renderComposer(src.editorState, theme, width, null, opts.maxBodyRows);
    return {
      firstBufferRow: 1,
      prefixWidth: COMPOSER_PREFIX_WIDTH,
      rowCount: composer.lines.length - 2,
      rowMap: composer.rowMap,
      rowOffset: composer.windowStart,
    };
  };
  src = new RawLineSource({
    composerGeometry: geometry,
    ...(opts.history ? { history: opts.history } : {}),
    ...(opts.completionRoot ? { completionRoot: opts.completionRoot } : {}),
  });
  return src;
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const CTRL_UP = "\x1b[1;5A";
const CTRL_DOWN = "\x1b[1;5B";
const SHIFT_UP = "\x1b[1;2A";

describe("item 1: the arrows edit the current prompt; Ctrl+arrows recall history", () => {
  it("Up moves by VISUAL row inside one soft-wrapped logical line — the limitation round five named is closed", () => {
    // 22 columns of body per visual row at width 24.
    const src = sourceWithComposer({ width: 24 });
    src.feedBytes("x".repeat(60));
    const before = src.editorState;
    assert.equal(before.cursorRow, 0);
    assert.equal(before.cursorCol, 60);

    src.feedBytes(UP);
    const after = src.editorState;
    assert.equal(after.cursorRow, 0, "still the same LOGICAL row — the wrap is display-only");
    assert.ok(after.cursorCol < 60 && after.cursorCol > 0, `expected a column on the previous visual row, got ${after.cursorCol}`);
    assert.equal(after.lines.join(""), "x".repeat(60), "the buffer is never touched by a cursor move");
  });

  it("Down returns to where Up came from — the two are inverses across a wrap", () => {
    const src = sourceWithComposer({ width: 24 });
    src.feedBytes("x".repeat(60));
    const start = src.editorState.cursorCol;
    src.feedBytes(UP);
    const middle = src.editorState.cursorCol;
    assert.notEqual(middle, start);
    src.feedBytes(DOWN);
    assert.equal(src.editorState.cursorCol, start);
  });

  it("at the top visual row, Up goes to the very start of the buffer", () => {
    const src = sourceWithComposer({ width: 24 });
    src.feedBytes("x".repeat(60));
    for (let i = 0; i < 10; i++) src.feedBytes(UP);
    assert.equal(src.editorState.cursorRow, 0);
    assert.equal(src.editorState.cursorCol, 0);
  });

  it("at the last visual row, Down goes to the very end of the buffer", () => {
    const src = sourceWithComposer({ width: 24 });
    src.feedBytes("x".repeat(60));
    src.feedBytes("\x1b[H"); // Home, back to the start of the line
    for (let i = 0; i < 10; i++) src.feedBytes(DOWN);
    assert.equal(src.editorState.cursorRow, src.editorState.lines.length - 1);
    assert.equal(src.editorState.cursorCol, 60);
  });

  it("a multi-line buffer (Shift+Enter) moves between its logical rows the ordinary way", () => {
    const src = sourceWithComposer({ width: 60 });
    src.feedBytes("first");
    src.feedBytes("\x1b\r"); // Alt+Enter — a newline, not a submit
    src.flushPending(); // the idle gap a real session's router always provides
    src.feedBytes("second");
    assert.equal(src.editorState.cursorRow, 1);
    src.feedBytes(UP);
    assert.equal(src.editorState.cursorRow, 0);
    src.feedBytes(DOWN);
    assert.equal(src.editorState.cursorRow, 1);
  });

  it("neither arrow recalls history any more, however many times it is pressed at an edge", () => {
    const src = sourceWithComposer({ width: 60, history: ["an older prompt"] });
    src.feedBytes("draft");
    for (let i = 0; i < 5; i++) src.feedBytes(UP);
    assert.equal(src.editorState.lines.join("\n"), "draft");
    for (let i = 0; i < 5; i++) src.feedBytes(DOWN);
    assert.equal(src.editorState.lines.join("\n"), "draft");
  });

  it("Ctrl+Up/Down is history, and it works from anywhere in the buffer rather than only at its edge", () => {
    const src = sourceWithComposer({ width: 60, history: ["older", "newer"] });
    src.feedBytes("draft");
    src.feedBytes("\x1b[H"); // cursor at the START, which the old binding needed for recall to fire
    src.feedBytes(CTRL_UP);
    assert.equal(src.editorState.lines.join("\n"), "newer");
    src.feedBytes(CTRL_UP);
    assert.equal(src.editorState.lines.join("\n"), "older");
    src.feedBytes(CTRL_DOWN);
    assert.equal(src.editorState.lines.join("\n"), "newer");
    src.feedBytes(CTRL_DOWN);
    assert.equal(src.editorState.lines.join("\n"), "draft", "coming back down past the newest entry restores the draft");
  });

  it("Shift+Up still extends a selection rather than recalling or jumping", () => {
    const src = sourceWithComposer({ width: 24 });
    src.feedBytes("x".repeat(60));
    src.feedBytes(SHIFT_UP);
    assert.ok(src.editorState.selection, "Shift+Up selects from the cursor to the visual row above");
  });

  it("with no composer geometry at all, the arrows still edit rather than recall — the fallback is a logical move, not the old binding", () => {
    const src = new RawLineSource({ history: ["older"] });
    src.feedBytes("draft");
    src.feedBytes(UP);
    assert.equal(src.editorState.lines.join("\n"), "draft");
    assert.equal(src.editorState.cursorCol, 0);
  });

  it("the visible window follows the cursor as the arrows walk it up a capped composer", () => {
    const src = sourceWithComposer({ width: 24, maxBodyRows: 3 });
    src.feedBytes("x".repeat(200));
    const rendered = () => renderComposer(src.editorState, theme, 24, null, 3);
    const atEnd = rendered();
    assert.ok(atEnd.hiddenAbove > 0);
    for (let i = 0; i < 4; i++) src.feedBytes(UP);
    const scrolled = rendered();
    assert.ok(scrolled.hiddenAbove < atEnd.hiddenAbove, "walking up scrolled the window with the cursor");
    assert.ok(scrolled.cursorRow >= 1 && scrolled.cursorRow <= scrolled.lines.length - 2, "the caret stayed inside the window");
  });
});

describe("item 3: the completion popup owns the plain arrows only", () => {
  it("a plain arrow moves the highlighted candidate, as before", () => {
    const seen: number[] = [];
    const src = new RawLineSource({ completionRoot: "/project", onCompletionChange: (_c, selected) => seen.push(selected) });
    src.feedBytes("/co");
    assert.equal(src.completionActive, true);
    src.feedBytes(DOWN);
    assert.equal(seen[seen.length - 1], 1);
  });

  it("Ctrl+arrow passes THROUGH an open popup and recalls history", () => {
    const src = new RawLineSource({ completionRoot: "/project", history: ["an older prompt"] });
    src.feedBytes("/co");
    assert.equal(src.completionActive, true, "precondition: the popup is open");
    src.feedBytes(CTRL_UP);
    assert.equal(src.editorState.lines.join("\n"), "an older prompt", "the popup must not swallow the modified arrow");
  });

  it("Ctrl+arrow-down also passes through, so the recall can be walked back", () => {
    const src = new RawLineSource({ completionRoot: "/project", history: ["older", "newer"] });
    src.feedBytes("/co");
    src.feedBytes(CTRL_UP);
    src.feedBytes(CTRL_UP);
    assert.equal(src.editorState.lines.join("\n"), "older");
    src.feedBytes(CTRL_DOWN);
    assert.equal(src.editorState.lines.join("\n"), "newer");
  });
});

describe("item 2: ending the session takes two Ctrl-C presses inside three seconds", () => {
  function clock(): { now: () => number; advance: (ms: number) => void } {
    let t = 5_000;
    return { now: () => t, advance: (ms: number) => void (t += ms) };
  }

  it("one press arms and does not exit; a second inside the window does", () => {
    const c = clock();
    const arm = new DoublePressExit(c.now);
    assert.equal(arm.press(), false, "the first press never ends the session");
    assert.equal(arm.isArmed, true);
    c.advance(CTRL_C_EXIT_WINDOW_MS - 1);
    assert.equal(arm.press(), true);
    assert.equal(arm.isArmed, false, "the arm is spent, not left standing for a third press");
  });

  it("a second press AFTER the window re-arms instead of exiting", () => {
    const c = clock();
    const arm = new DoublePressExit(c.now);
    arm.press();
    c.advance(CTRL_C_EXIT_WINDOW_MS + 1);
    assert.equal(arm.press(), false, "too late to count as a double press");
    assert.equal(arm.isArmed, true, "but it arms afresh, so the NEXT press can exit");
    assert.equal(arm.press(), true);
  });

  it("the window is exactly three seconds, which is what was asked for", () => {
    assert.equal(CTRL_C_EXIT_WINDOW_MS, 3000);
    const c = clock();
    const arm = new DoublePressExit(c.now);
    arm.press();
    c.advance(CTRL_C_EXIT_WINDOW_MS);
    assert.equal(arm.press(), true, "exactly at the boundary still counts");
  });

  it("reset() disarms — a Ctrl-C consumed as something else must not leave the next one primed to exit", () => {
    const c = clock();
    const arm = new DoublePressExit(c.now);
    arm.press();
    arm.reset();
    assert.equal(arm.isArmed, false);
    assert.equal(arm.press(), false, "the next press is a first press again");
  });
});

describe("item 4: the approved command's output lands before the next approval prompt", () => {
  interface Rendered {
    id: string;
    decision?: string;
    queued?: number;
  }

  function gateWith(opts: { advanceTimeoutMs?: number } = {}): { gate: RawApprovalGate; rendered: Rendered[] } {
    const rendered: Rendered[] = [];
    const gate = new RawApprovalGate({
      deferAdvance: true,
      ...(opts.advanceTimeoutMs !== undefined ? { advanceTimeoutMs: opts.advanceTimeoutMs } : {}),
      onRender: (id, view) =>
        rendered.push({
          id,
          ...(view.decision !== undefined ? { decision: view.decision } : {}),
          ...(view.queued !== undefined ? { queued: view.queued } : {}),
        }),
    });
    return { gate, rendered };
  }

  it("deciding the visible prompt does NOT immediately push the next one", async () => {
    const { gate, rendered } = gateWith({ advanceTimeoutMs: 60_000 });
    const pA = gate.request(req({ detail: "cmd-a" }));
    void gate.request(req({ detail: "cmd-b" }));
    const beforeDecision = rendered.length;

    gate.feedBytes("y");
    assert.equal(await pA, "allow");
    assert.equal(gate.isOpen, false, "the gap is what leaves room for the command's own output");
    assert.equal(rendered.length, beforeDecision + 1, "only the decided block was repainted");
    assert.equal(rendered.at(-1)!.decision, "allow");
  });

  it("the decided block keeps saying how many are still waiting, so the gap never reads as a swallowed queue", async () => {
    const { gate, rendered } = gateWith({ advanceTimeoutMs: 60_000 });
    const pA = gate.request(req());
    void gate.request(req());
    void gate.request(req());
    gate.feedBytes("y");
    await pA;
    assert.equal(rendered.at(-1)!.queued, 2);
  });

  it("advance() is what promotes the next prompt — the caller calls it once the output is on screen", async () => {
    const { gate, rendered } = gateWith({ advanceTimeoutMs: 60_000 });
    const pA = gate.request(req({ detail: "cmd-a" }));
    const pB = gate.request(req({ detail: "cmd-b" }));
    gate.feedBytes("y");
    await pA;

    gate.advance();
    assert.equal(gate.isOpen, true, "the second prompt is showing now, after the first command's output");
    const promoted = rendered.at(-1)!;
    assert.equal(promoted.decision, undefined, "it is a fresh, undecided prompt");
    assert.notEqual(promoted.id, rendered[0]!.id);

    gate.feedBytes("n");
    assert.equal(await pB, "deny");
  });

  it("advance() with nothing waiting is a no-op, so a caller can wire it to a broad signal", () => {
    const { gate, rendered } = gateWith();
    gate.advance();
    assert.equal(rendered.length, 0);
    void gate.request(req());
    const after = rendered.length;
    gate.advance();
    assert.equal(rendered.length, after, "a tool finishing while a prompt is merely OPEN changes nothing");
    assert.equal(gate.isOpen, true);
  });

  it("the watchdog promotes anyway if advance() never comes — a missed signal is a pause, never a hung turn", async () => {
    const { gate } = gateWith({ advanceTimeoutMs: 5 });
    const pA = gate.request(req());
    const pB = gate.request(req());
    gate.feedBytes("y");
    await pA;
    assert.equal(gate.isOpen, false, "held back, for now");

    await new Promise((r) => setTimeout(r, 40));
    assert.equal(gate.isOpen, true, "the queue always moves eventually, told or not");
    gate.feedBytes("n");
    assert.equal(await pB, "deny");
  });

  it("a request arriving during the gap waits its turn rather than jumping the queue", async () => {
    const { gate } = gateWith({ advanceTimeoutMs: 60_000 });
    const pA = gate.request(req({ detail: "cmd-a" }));
    const pB = gate.request(req({ detail: "cmd-b" }));
    gate.feedBytes("y");
    await pA;

    const decisions: string[] = [];
    const pC = gate.request(req({ detail: "cmd-c" }));
    void pB.then((d) => decisions.push(`b:${d}`));
    void pC.then((d) => decisions.push(`c:${d}`));
    assert.equal(gate.isOpen, false, "a new request does not sneak past the deferral either");

    gate.advance();
    gate.feedBytes("n");
    await pB;
    gate.advance();
    gate.feedBytes("y");
    await pC;
    assert.deepEqual(decisions, ["b:deny", "c:allow"], "FIFO across the gap");
  });

  it("without deferAdvance the old behaviour is exactly unchanged — every other caller and test still gets it", async () => {
    const gate = new RawApprovalGate({ onRender: () => {} });
    const pA = gate.request(req());
    void gate.request(req());
    gate.feedBytes("y");
    await pA;
    assert.equal(gate.isOpen, true, "the next prompt is promoted the moment the previous one is decided");
  });

  it("cancelling during the gap denies everything still queued rather than leaving it for the watchdog", async () => {
    // The gate is deliberately not open during the gap, so stdin is back
    // with the composer and a Ctrl-C typed there reaches `RawLineSource`'s
    // `onInterrupt` — which `session/interactive.ts` wires to `close()` for
    // exactly this reason. Without it, a request the user has already
    // cancelled would surface as a prompt when the watchdog fired, seconds
    // after the turn it belonged to was abandoned.
    const { gate } = gateWith({ advanceTimeoutMs: 60_000 });
    const pA = gate.request(req());
    const pB = gate.request(req());
    const pC = gate.request(req());
    gate.feedBytes("y");
    assert.equal(await pA, "allow");
    assert.equal(gate.isOpen, false, "precondition: mid-gap, so the keystroke would not have reached the gate");

    gate.close();
    assert.deepEqual(await Promise.all([pB, pC]), ["deny", "deny"]);
    assert.equal(gate.isOpen, false);

    // And the watchdog it disarmed cannot resurrect them afterwards.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(gate.isOpen, false);
  });
});
