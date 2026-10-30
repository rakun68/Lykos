import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScreenPipeline } from "./pipeline.js";
import { resolveTheme } from "../theme/resolve.js";
import type { ViewModel } from "../types.js";

const mono = resolveTheme("mono", "none", "unicode");

function header() {
  return {
    product: "LYKOS",
    version: "0.0.1",
    model: "deepseek-v4-flash",
    cwd: "~/Workspace/Lykos",
    branch: "master",
    sessionId: "abc12345",
    executionShape: "standalone",
  };
}

function vm(): ViewModel {
  return {
    cost: { runUsd: 0.038, todayUsd: 0.41, capRunUsd: 0.5, capDayUsd: 2.0, onExceed: "stop" },
    tokens: { counters: { fresh: 42100, cacheRead: 38400, cacheWrite: 2100, output: 3800, reasoning: 0 }, hitRatio: 0.91, calls: 4 },
    context: { parent: null, delegate: { usedTokens: 12000, totalTokens: 64000, pct: 0.19 } },
    outcome: null,
    alerts: [],
    session: { id: "s1", brief: null, agent: null, model: null, phase: null, startedUtc: null, endedUtc: null, heartbeatUtc: null, elapsedSec: null, thinkingLevel: null },
    health: { toolSchemaTokens: null, toolCount: null, prefixChanged: false },
    children: [],
  };
}

class CapturingSink {
  writes: string[] = [];
  write(text: string): void {
    this.writes.push(text);
  }
  get all(): string {
    return this.writes.join("");
  }
}

describe("T50.4 mechanism: ScreenPipeline — AgentSessionEvent-shaped input to a written frame diff", () => {
  it("pushing a block eventually paints a frame containing it", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    pipeline.pushBlock({ id: "1", kind: "speech", text: "hello from the model" });
    pipeline.flush();
    assert.match(sink.all, /hello from the model/);
    pipeline.stop();
  });

  it("many pushes inside one scheduler window coalesce into far fewer renders than pushes", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    for (let i = 0; i < 500; i++) pipeline.pushBlock({ id: `${i}`, kind: "speech", text: `chunk ${i}` });
    // 500 synchronous pushes complete in well under one 33ms (30Hz) window,
    // so the scheduler's rate limit coalesces almost all of them — the real
    // clock is used deliberately here (a fake one would leave the second,
    // scheduled render as a REAL pending setTimeout that stop() below must
    // actually cancel, which only the real clock's real clearTimeout does).
    assert.ok(pipeline.renders <= 2, `expected coalescing, got ${pipeline.renders} renders for 500 pushes`);
    pipeline.stop();
  });

  it("setViewModel makes the footer's numbers appear in the next painted frame", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    pipeline.setViewModel(vm());
    pipeline.flush();
    assert.match(sink.all, /\$0\.038/);
    pipeline.stop();
  });

  it("resize forces a full redraw rather than a stale diff", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    pipeline.pushBlock({ id: "1", kind: "speech", text: "hi" });
    pipeline.flush();
    const before = pipeline.diffWrites;
    pipeline.resize(80, 20);
    pipeline.pushBlock({ id: "2", kind: "speech", text: "again" });
    pipeline.flush();
    // A resize resets the writer, so the render right after it is a full
    // redraw, not counted as a diff write.
    assert.equal(pipeline.diffWrites, before);
  });

  it("stop() disarms the scheduler — a push after stop() never paints", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    pipeline.stop();
    pipeline.pushBlock({ id: "1", kind: "speech", text: "should never appear" });
    pipeline.flush();
    assert.doesNotMatch(sink.all, /should never appear/);
  });

  it("scrollback bounds hold: pushing more than the cap still paints the tail correctly", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 10, theme: mono, header: header(), sink, maxScrollbackLines: 50 });
    for (let i = 0; i < 200; i++) pipeline.pushBlock({ id: `${i}`, kind: "speech", text: `line ${i}` });
    pipeline.flush();
    assert.match(sink.all, /line 199/);
    pipeline.stop();
  });

  it("updateBlock mutates an existing block in place — streaming text stays one paragraph, not one line per delta", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    pipeline.pushBlock({ id: "assistant-1", kind: "speech", text: "Hel" });
    pipeline.updateBlock("assistant-1", { id: "assistant-1", kind: "speech", text: "Hello world" });
    pipeline.pushBlock({ id: "2", kind: "speech", text: "a second, separate block" });
    // Force a full redraw so the last write is the complete current frame,
    // not a diff — the only way to read "current state" back out of an
    // accumulating sink rather than a log of everything ever written.
    pipeline.resize(100, 24);
    pipeline.flush();
    // paint() writes the frame, then paintCursor() writes a trailing
    // cursor escape — the frame itself is the second-to-last write.
    const finalFrame = sink.writes.at(-2)!;
    assert.match(finalFrame, /Hello world/);
    assert.match(finalFrame, /a second, separate block/);
    // "Hello world" appears once — not once as the update AND once as a
    // leftover "Hel" line still sitting above it.
    assert.equal((finalFrame.match(/Hello world/g) ?? []).length, 1);
    assert.equal((finalFrame.match(/a second, separate block/g) ?? []).length, 1);
    pipeline.stop();
  });

  it("updateBlock on an id that was never pushed returns false and paints nothing new", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    const ok = pipeline.updateBlock("missing", { id: "missing", kind: "speech", text: "ghost" });
    assert.equal(ok, false);
    pipeline.flush();
    assert.doesNotMatch(sink.all, /ghost/);
    pipeline.stop();
  });

  it("an approval is a block in the transcript, not an overlay over it (2026-09-02 item 11)", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    pipeline.pushBlock({ id: "1", kind: "speech", text: "normal frame content" });
    pipeline.pushBlock({
      id: "approval-0",
      kind: "approval",
      approval: { kind: "bash", summary: "run command", detail: "ls -la" },
    });
    pipeline.flush();
    // Both are on screen: the conversation above the prompt is exactly what
    // the overlay used to blank, and exactly what someone needs to decide.
    assert.match(sink.all, /normal frame content/);
    assert.match(sink.all, /run command/);

    // Answering it mutates the same block rather than clearing anything.
    assert.equal(
      pipeline.updateBlock("approval-0", {
        id: "approval-0",
        kind: "approval",
        approval: { kind: "bash", summary: "run command", detail: "ls -la", decision: "deny" },
      }),
      true,
    );
    pipeline.flush();
    assert.match(sink.all, /denied/);
    pipeline.stop();
  });

  it("composerTopRow() reflects the current layout, including footer/composer height changes", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    const oneLine = pipeline.composerTopRow();
    pipeline.setComposerLines(["> line one", "  line two"]);
    const twoLines = pipeline.composerTopRow();
    assert.equal(twoLines, oneLine - 1, "a taller composer starts one row higher");
    pipeline.stop();
  });

  it("setCursor shows and positions the real cursor; null hides it again", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    pipeline.setCursor({ row: 20, col: 5 });
    pipeline.flush();
    assert.match(sink.all, /\x1b\[21;6H\x1b\[\?25h/);

    pipeline.setCursor(null);
    pipeline.flush();
    assert.match(sink.all, /\x1b\[\?25l/);
    pipeline.stop();
  });

  it("pageUp moves the viewport off the tail; pageDown returns it", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 10, theme: mono, header: header(), sink });
    for (let i = 0; i < 40; i++) pipeline.pushBlock({ id: `${i}`, kind: "speech", text: `line ${i}` });
    pipeline.flush();
    assert.match(sink.all, /line 39/, "following the tail shows the newest line");

    const beforePageUp = sink.writes.length;
    pipeline.pageUp();
    pipeline.flush();
    const pageUpDiff = sink.writes.slice(beforePageUp).join("");
    assert.ok(pageUpDiff.length > 0, "pageUp produced a repaint");
    assert.doesNotMatch(pageUpDiff, /line 39/, "the newest line scrolls out of view");

    const beforePageDown = sink.writes.length;
    pipeline.pageDown();
    pipeline.flush();
    const pageDownDiff = sink.writes.slice(beforePageDown).join("");
    assert.match(pageDownDiff, /line 39/, "pageDown returns to the tail");
    pipeline.stop();
  });

  it("scrollUp/scrollDown move by exactly the requested line count", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 10, theme: mono, header: header(), sink });
    // `system` rather than `speech` since round thirteen, item 3: a
    // finished answer now renders its own click-to-copy hint row, so a
    // speech block is three rows tall and the arithmetic this test is
    // actually about (N lines of scroll move exactly N lines) needs a
    // one-row block kind to stay legible.
    for (let i = 0; i < 40; i++) pipeline.pushBlock({ id: `${i}`, kind: "system", text: `line ${i}` });
    pipeline.flush();

    const beforeUp = sink.writes.length;
    pipeline.scrollUp(3);
    pipeline.flush();
    const upDiff = sink.writes.slice(beforeUp).join("");
    assert.match(upDiff, /line 36/, "3 lines up moves the newest visible line from 39 to 36");

    const beforeDown = sink.writes.length;
    pipeline.scrollDown(3);
    pipeline.flush();
    const downDiff = sink.writes.slice(beforeDown).join("");
    assert.match(downDiff, /line 39/, "scrolling back down by the same amount re-arms the tail");
    pipeline.stop();
  });

  it("setCompletionPopup composites the popup lines onto the frame; null hides it again", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    pipeline.setCompletionPopup(["/copy", "/compact"]);
    pipeline.flush();
    assert.match(sink.all, /\/copy/);
    assert.match(sink.all, /\/compact/);

    const beforeHide = sink.writes.length;
    pipeline.setCompletionPopup(null);
    pipeline.flush();
    const hideDiff = sink.writes.slice(beforeHide).join("");
    assert.doesNotMatch(hideDiff, /\/copy/, "hiding the popup repaints those rows without it");
    pipeline.stop();
  });

  it("setStatus composites the status line onto the frame, just above the composer; null hides it again", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    pipeline.setStatus("Working...");
    pipeline.flush();
    assert.match(sink.all, /Working\.\.\./);

    const beforeHide = sink.writes.length;
    pipeline.setStatus(null);
    pipeline.flush();
    const hideDiff = sink.writes.slice(beforeHide).join("");
    assert.doesNotMatch(hideDiff, /Working\.\.\./, "hiding the status line repaints that row without it");
    pipeline.stop();
  });

  it("2026-09-02 item 4: the popup and the status line coexist, each in its own region", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    pipeline.setStatus("Working...");
    pipeline.setCompletionPopup(["/copy"]);
    pipeline.flush();
    // They used to fight for one composited row and the popup won, hiding
    // the spinner. Both are laid out now: the status above the composer,
    // the popup below it.
    assert.match(sink.all, /\/copy/);
    assert.match(sink.all, /Working\.\.\./);
    pipeline.stop();
  });

  it("2026-09-02 item 4: the popup is a layout region that takes its rows from the viewport, never the composer's own space", () => {
    // Default position is above the composer as of round three
    // (2026-09-02: "bring it back to above chat box"). With the popup
    // between the viewport and the composer, opening it shrinks only the
    // viewport — the composer and footer both stay pinned to the same
    // distance from the bottom of the screen regardless of the popup's
    // height, so the composer does not move at all.
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    pipeline.setComposerLines(["----", "> /co", "----"]);
    pipeline.flush();
    const composerTop = pipeline.composerTopRow();
    pipeline.setCompletionPopup(["/copy", "/compact"]);
    pipeline.flush();
    assert.equal(pipeline.composerTopRow(), composerTop);
    pipeline.stop();
  });

  it("2026-09-02 (round three) item 4: with completion_position: below, the popup sits under the composer instead, and the composer does not move", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink, completionAbove: false });
    pipeline.setComposerLines(["----", "> /co", "----"]);
    pipeline.flush();
    const composerTop = pipeline.composerTopRow();
    pipeline.setCompletionPopup(["/copy", "/compact"]);
    pipeline.flush();
    // With the popup below, it and the footer share the space taken from
    // the viewport, and the composer — pinned to a fixed distance above the
    // footer's own fixed distance from the bottom — moves UP instead.
    assert.equal(pipeline.composerTopRow(), composerTop - 2);
    pipeline.stop();
  });
});

describe("the header back affordance is clickable (T114)", () => {
  it("resolves a click on the affordance to openBrowser", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: { ...header(), back: true }, sink });
    // Row 0 is the header; column 0 is the affordance's first column.
    assert.deepEqual(pipeline.actionAt(0, 0), { kind: "openBrowser" });
    assert.deepEqual(pipeline.actionAt(0, 3), { kind: "openBrowser" });
  });

  it("leaves the rest of the header inert rather than swallowing the click", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: { ...header(), back: true }, sink });
    assert.equal(pipeline.actionAt(0, 60), null, "clicking the model name must do nothing");
  });

  it("has no target at all when the header draws no affordance", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 100, height: 24, theme: mono, header: header(), sink });
    assert.equal(pipeline.actionAt(0, 0), null);
  });
});

describe("full view (T114)", () => {
  it("paints the lines it is given instead of the session, and gives the screen back on null", () => {
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 40, height: 8, theme: mono, header: header(), sink });
    pipeline.pushBlock({ id: "b1", kind: "system", text: "a line of transcript" });
    pipeline.flush();
    sink.writes.length = 0;

    pipeline.setFullView(["SESSION BROWSER", "row one", "row two"]);
    pipeline.flush();
    assert.ok(pipeline.hasFullView);
    assert.ok(sink.all.includes("SESSION BROWSER"));
    assert.ok(!sink.all.includes("a line of transcript"), "the session must not show through its own replacement");

    sink.writes.length = 0;
    pipeline.setFullView(null);
    pipeline.flush();
    assert.equal(pipeline.hasFullView, false);
    assert.ok(sink.all.includes("a line of transcript"), "closing the view restores the session");
  });

  it("repaints on a SECOND open, which is the bug the first cut had", () => {
    // The browser used to render into a scrollback block keyed by a fixed
    // id. On a second open the block already existed, so it re-rendered in
    // place far up the transcript while still owning the keyboard, and the
    // session looked dead. A full view cannot do that: setting it always
    // puts it on screen.
    const sink = new CapturingSink();
    const pipeline = new ScreenPipeline({ width: 40, height: 8, theme: mono, header: header(), sink });
    for (let i = 0; i < 200; i++) pipeline.pushBlock({ id: `b${i}`, kind: "system", text: `line ${i}` });
    pipeline.flush();

    for (const pass of ["first", "second"]) {
      pipeline.setFullView([`BROWSER ${pass}`]);
      pipeline.flush();
      assert.ok(sink.all.includes(`BROWSER ${pass}`), `${pass} open did not reach the screen`);
      sink.writes.length = 0;
      pipeline.setFullView(null);
      pipeline.flush();
      sink.writes.length = 0;
    }
  });
});
