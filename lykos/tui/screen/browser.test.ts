import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { browserEntries, browserKey, openBrowser, renderBrowser, selectedRow, shortWhen, visibleRows, type BrowserSource } from "./browser.js";
import type { SessionListRow } from "../../session/listing.js";
import type { SessionPreview } from "../../session/preview.js";
import { resolveTheme } from "../theme/resolve.js";
import type { KeyEvent } from "./input.js";

const theme = resolveTheme("mono", "none", "unicode");
const NOW = new Date("2026-09-06T12:00:00.000Z");

function row(over: Partial<SessionListRow> = {}): SessionListRow {
  return {
    id: "01a06141-0b5b-7305-bc8c-0585a3eb56fa",
    taskId: null,
    taskBrief: null,
    brief: null,
    startedUtc: "2026-09-06T10:00:00.000Z",
    endedUtc: "2026-09-06T10:04:00.000Z",
    model: "deepseek-v4-flash",
    executionShape: "standalone",
    outcome: "success",
    outcomeSource: "verification_command",
    archiveState: "warm",
    captureMode: "live",
    resumable: true,
    notResumableReason: null,
    parentSessionId: null,
    resumedFrom: null,
    costUsd: 0.011,
    durationSeconds: 240,
    depth: 0,
    edge: null,
    ...over,
  };
}

function preview(over: Partial<SessionPreview> = {}): SessionPreview {
  return {
    name: "fix the exploration metric",
    nameIsDerived: true,
    firstMessageUtc: "2026-09-06T10:00:00.000Z",
    lastMessageUtc: "2026-09-06T10:04:00.000Z",
    turns: [
      { role: "you", text: "fix the exploration metric", tsUtc: "2026-09-06T10:00:00.000Z" },
      { role: "lykos", text: "classified bash commands by command word", tsUtc: "2026-09-06T10:04:00.000Z" },
    ],
    unavailable: null,
    ...over,
  };
}

function source(rows: SessionListRow[], p: SessionPreview = preview(), failures: { project: string; reason: string }[] = []): BrowserSource {
  return { load: () => ({ rows, failures }), preview: () => p };
}

function render(state: Parameters<typeof renderBrowser>[0], p: SessionPreview = preview(), width = 120, height = 24): string[] {
  return renderBrowser(state, { width, height, theme, now: NOW, preview: () => p });
}

const KEY = {
  esc: { type: "escape" } as KeyEvent,
  down: { type: "arrow", dir: "down" } as KeyEvent,
  up: { type: "arrow", dir: "up" } as KeyEvent,
  ctrl: (key: string): KeyEvent => ({ type: "ctrl", key }) as KeyEvent,
  right: { type: "arrow", dir: "right" } as KeyEvent,
  enter: { type: "enter" } as KeyEvent,
  pageDown: { type: "pageDown" } as KeyEvent,
  char: (value: string): KeyEvent => ({ type: "char", value }) as KeyEvent,
};

describe("session browser view (T114)", () => {
  it("fills exactly the height it is given, so it can own the frame", () => {
    const many = Array.from({ length: 200 }, (_, i) => row({ id: `s${i}` }));
    for (const height of [10, 24, 51]) {
      const lines = render(openBrowser(source(many)), preview(), 120, height);
      assert.equal(lines.length, height, `height ${height} produced ${lines.length} lines`);
    }
  });

  it("puts the list on the left and what was said on the right", () => {
    const lines = render(openBrowser(source([row()])));
    const body = lines.slice(3, -1);
    const withDivider = body.filter((l) => l.includes("│"));
    assert.ok(withDivider.length > 0, "every body row should carry the pane divider");

    const joined = lines.join("\n");
    assert.ok(joined.includes("fix the exploration metric"), "the name belongs in the list");
    assert.ok(joined.includes("classified bash commands"), "the reply belongs in the preview pane");
  });

  it("shows when the session started and when its last message landed", () => {
    const lines = render(openBrowser(source([row()])));
    const joined = lines.join("\n");
    // 10:00 UTC and 10:04 UTC, rendered in local time — assert on the
    // formatter's own answer rather than on a hard-coded clock.
    assert.ok(joined.includes(shortWhen("2026-09-06T10:00:00.000Z", NOW)), "start time missing");
    assert.ok(joined.includes(shortWhen("2026-09-06T10:04:00.000Z", NOW)), "last-message time missing");
  });

  it("prefers a human's name over the derived one", () => {
    const lines = render(openBrowser(source([row({ brief: "the real name" })])), preview({ name: "the real name", nameIsDerived: false }));
    assert.ok(lines.join("\n").includes("the real name"));
  });

  it("falls back to the short id when there is no name at all", () => {
    const lines = render(openBrowser(source([row({ id: "abcdef1234" })])), preview({ name: null }));
    assert.ok(lines.join("\n").includes("abcdef12"));
  });

  it("says so when a session has no transcript instead of showing an empty pane", () => {
    const lines = render(
      openBrowser(source([row()])),
      preview({ turns: [], unavailable: "no transcript on disk — this session predates live capture" }),
    );
    assert.ok(lines.join("\n").includes("predates live capture"));
  });

  it("moves the cursor and resets the preview scroll with it", () => {
    const state = openBrowser(source([row({ id: "a" }), row({ id: "b" })]));
    // Entry 0 is the lifecycle heading these two sit under (item 10), so
    // the browser opens on entry 1 and Down lands on entry 2.
    assert.equal(selectedRow(state, NOW)?.id, "a");
    const scrolled = browserKey(state, KEY.pageDown, 24).state;
    assert.ok(scrolled.previewScroll > 0);
    const moved = browserKey(scrolled, KEY.down, 24).state;
    assert.equal(selectedRow(moved, NOW)?.id, "b");
    assert.equal(moved.previewScroll, 0, "a different session must start at the top of its own conversation");
  });

  it("scrolls the preview without moving the selection", () => {
    const state = openBrowser(source([row({ id: "a" }), row({ id: "b" })]));
    const after = browserKey(state, KEY.right, 24).state;
    assert.equal(after.previewScroll, 1);
    assert.equal(selectedRow(after, NOW)?.id, "a");
  });

  it("filters as you type and counts what is shown", () => {
    const state = openBrowser(source([row({ id: "aaa", brief: "alpha work" }), row({ id: "bbb", brief: "beta work" })]));
    const typed = browserKey(state, KEY.char("alph"), 24).state;
    assert.equal(visibleRows(typed).length, 1);
    assert.ok(render(typed)[0]?.includes("1/2"));
  });

  it("closes on escape and selects on enter", () => {
    const state = openBrowser(source([row({ id: "first" }), row({ id: "second" })]));
    assert.deepEqual(browserKey(state, KEY.esc, 24).action, { kind: "close" });

    const moved = browserKey(state, KEY.down, 24).state;
    const chosen = browserKey(moved, KEY.enter, 24);
    assert.equal(chosen.action.kind === "select" ? chosen.action.row.id : null, "second");
  });

  it("stays open and shows the verbatim reason when a row cannot be resumed", () => {
    const state = openBrowser(source([row({ resumable: false, notResumableReason: "capture_mode is NULL — no conversation was recorded" })]));
    const { state: next, action } = browserKey(state, KEY.enter, 24);
    assert.deepEqual(action, { kind: "none" });
    assert.ok(render(next).join("\n").includes("capture_mode is NULL"));
  });

  it("reports a ledger it could not read rather than quietly showing fewer sessions", () => {
    const state = openBrowser(source([row()], preview(), [{ project: "other-repo", reason: "database is locked" }]));
    const joined = render(state).join("\n");
    assert.ok(joined.includes("other-repo") && joined.includes("database is locked"));
  });

  // -------------------------------------------------------------------
  // 2026-09-07, the maintainer's second round of feedback (items 3, 7, 10).
  // -------------------------------------------------------------------

  it("groups by lifecycle in the stated order: Empty, Running, Open, Closed", () => {
    const state = openBrowser(
      source([
        row({ id: "done", endedUtc: "2026-09-06T10:04:00.000Z" }),
        row({ id: "fresh", endedUtc: null, callCount: 0 }),
        row({ id: "live", endedUtc: null, callCount: 2, isCurrent: true, isRunning: true }),
        row({ id: "idle", endedUtc: null, callCount: 2 }),
      ]),
    );
    const headings = browserEntries(state, NOW)
      .filter((entry) => entry.kind === "heading")
      .map((entry) => (entry.kind === "heading" ? entry.state : ""));
    assert.deepEqual(headings, ["empty", "running", "open", "closed"]);
  });

  it("folds a group with Enter on its heading and unfolds it again", () => {
    const state = openBrowser(source([row({ id: "a" }), row({ id: "b" })]));
    const onHeading = browserKey(state, KEY.up, 24).state;
    assert.equal(onHeading.cursor, 0);
    const folded = browserKey(onHeading, KEY.enter, 24).state;
    assert.equal(browserEntries(folded, NOW).length, 1, "only the heading is left when the group is folded");
    const unfolded = browserKey(folded, KEY.enter, 24).state;
    assert.equal(browserEntries(unfolded, NOW).length, 3);
  });

  it("marks the session you are in and refuses to resume it", () => {
    const state = openBrowser(source([row({ id: "mine", endedUtc: null, callCount: 1, isCurrent: true, isRunning: false })]));
    const drawn = render(state).join(String.fromCharCode(10));
    assert.ok(drawn.includes("this session"), drawn);
    assert.ok(drawn.includes("Open"), "an idle session with a conversation in it is Open");
    const { action, state: after } = browserKey(state, KEY.enter, 24);
    assert.deepEqual(action, { kind: "none" });
    assert.ok(after.notice?.includes("the session you are in"), after.notice ?? "");
  });

  it("Ctrl-X closes a session, and says how to stop a running one instead", () => {
    const closable = openBrowser(source([row({ id: "idle", endedUtc: null, callCount: 2 })]));
    const closed = browserKey(closable, KEY.ctrl("x"), 24);
    assert.equal(closed.action.kind === "closeSession" ? closed.action.row.id : null, "idle");

    const running = openBrowser(source([row({ id: "busy", endedUtc: null, callCount: 2, isRunning: true })]));
    const refused = browserKey(running, KEY.ctrl("x"), 24);
    assert.deepEqual(refused.action, { kind: "none" });
    assert.ok(refused.state.notice?.includes("stop"), refused.state.notice ?? "");
  });

  it("names Ctrl-X in the hint, so the key is discoverable without the docs", () => {
    const drawn = render(openBrowser(source([row()])));
    assert.ok(drawn[drawn.length - 1]?.includes("Ctrl-X to close"), drawn[drawn.length - 1]);
    // Item 8's other half: the hint is the LAST row of the frame, and it
    // reads as a sentence.
    assert.ok(drawn[drawn.length - 1]?.includes("pgup/pgdn to scroll"));
  });

  it("deletes only on a second Ctrl-K, and never the session you are in", () => {
    const state = openBrowser(source([row({ id: "old" })]));
    const armed = browserKey(state, KEY.ctrl("k"), 24, 1000);
    assert.deepEqual(armed.action, { kind: "none" });
    assert.ok(armed.state.notice?.includes("again"), armed.state.notice ?? "");
    const gone = browserKey(armed.state, KEY.ctrl("k"), 24, 1500);
    assert.equal(gone.action.kind === "delete" ? gone.action.row.id : null, "old");

    const mine = openBrowser(source([row({ id: "mine", isCurrent: true, endedUtc: null, callCount: 1 })]));
    const refused = browserKey(mine, KEY.ctrl("k"), 24, 1000);
    assert.deepEqual(refused.action, { kind: "none" });
    assert.ok(refused.state.notice?.includes("cannot be deleted"), refused.state.notice ?? "");
  });

  it("is readable with nothing recorded yet", () => {
    const lines = render(openBrowser(source([])));
    assert.equal(lines.length, 24);
    assert.ok(lines.join("\n").includes("nothing recorded yet"));
  });
});
