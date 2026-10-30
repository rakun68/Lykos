import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BrowserOverlay } from "./browser-overlay.js";
import { routeStdin, type RoutableOverlay, type StdinRoutable } from "./stdin-router.js";
import type { SessionListRow } from "../../session/listing.js";
import type { BrowserState } from "./browser.js";

function row(over: Partial<SessionListRow> = {}): SessionListRow {
  return {
    id: "01a06141",
    taskId: null,
    taskBrief: null,
    brief: "a session",
    startedUtc: "2026-09-06T10:00:00.000Z",
    endedUtc: "2026-09-06T10:04:00.000Z",
    model: "deepseek-v4-flash",
    executionShape: "standalone",
    outcome: null,
    outcomeSource: null,
    archiveState: null,
    captureMode: "live",
    resumable: true,
    notResumableReason: null,
    parentSessionId: null,
    resumedFrom: null,
    costUsd: null,
    durationSeconds: null,
    depth: 0,
    edge: null,
    ...over,
  };
}

function overlay(rows: SessionListRow[] = [row()]) {
  const events: string[] = [];
  const renders: BrowserState[] = [];
  let loads = 0;
  const o = new BrowserOverlay({
    source: {
      load: () => {
        loads += 1;
        return { rows, failures: [] };
      },
      preview: () => ({
        name: "a session",
        nameIsDerived: true,
        firstMessageUtc: "2026-09-06T10:00:00.000Z",
        lastMessageUtc: "2026-09-06T10:04:00.000Z",
        turns: [],
        unavailable: null,
      }),
    },
    onRender: (state) => {
      renders.push(state);
      events.push("render");
    },
    onClose: () => events.push("close"),
    onSelect: (r) => events.push(`select:${r.id}`),
  });
  return { o, events, renders, loads: () => loads };
}

describe("BrowserOverlay (T114)", () => {
  it("is closed until opened, and takes no stdin while closed", () => {
    const { o, events } = overlay();
    assert.equal(o.isOpen, false);
    o.feedBytes("j");
    assert.deepEqual(events, [], "a keystroke delivered while closed must do nothing at all");
  });

  it("renders on open and closes on escape", () => {
    const { o, events } = overlay();
    o.open(24);
    assert.equal(o.isOpen, true);
    o.feedBytes("");
    o.flushPending(); // a lone ESC resolves on the idle flush, as everywhere else
    assert.equal(o.isOpen, false);
    assert.deepEqual(events, ["render", "close"]);
  });

  it("toggles: the same gesture opens and closes", () => {
    const { o } = overlay();
    o.toggle(24);
    assert.equal(o.isOpen, true);
    o.toggle(24);
    assert.equal(o.isOpen, false);
  });

  it("re-reads the rows on every open, so a session that just ended is there", () => {
    const { o, loads } = overlay();
    o.open(24);
    o.close();
    o.open(24);
    assert.equal(loads(), 2);
  });

  it("closes before handing the selection out", () => {
    const { o, events } = overlay([row({ id: "chosen" })]);
    o.open(24);
    o.feedBytes("\r");
    // A bare CR is held by the decoder until it knows it is not the start of
    // CRLF — the same idle flush `stdin-router.ts` performs in production.
    o.flushPending();
    assert.equal(o.isOpen, false, "stdin must be back with the composer before onSelect runs");
    assert.deepEqual(events, ["render", "close", "select:chosen"]);
  });

  it("stays open on a row that cannot be resumed", () => {
    const { o, events } = overlay([row({ resumable: false, notResumableReason: "capture_mode is NULL" })]);
    o.open(24);
    o.feedBytes("\r");
    o.flushPending();
    assert.equal(o.isOpen, true);
    assert.deepEqual(events, ["render", "render"], "a refusal re-renders with the reason, it does not close");
  });
});

describe("stdin routing with two overlays (T114)", () => {
  class Recorder implements StdinRoutable {
    readonly got: string[] = [];
    feedBytes(chunk: string): void {
      this.got.push(chunk);
    }
    flushPending(): void {}
  }
  class FakeOverlay extends Recorder implements RoutableOverlay {
    isOpen = false;
  }
  class FakeStdin {
    private listener: ((chunk: Buffer | string) => void) | null = null;
    on(_e: "data", l: (chunk: Buffer | string) => void): void {
      this.listener = l;
    }
    off(): void {
      this.listener = null;
    }
    send(text: string): void {
      this.listener?.(text);
    }
  }

  it("gives bytes to the first OPEN overlay, in the order they were passed", () => {
    const stdin = new FakeStdin();
    const primary = new Recorder();
    const gate = new FakeOverlay();
    const browser = new FakeOverlay();
    const stop = routeStdin({ stdin, primary, overlay: [gate, browser] });

    stdin.send("a");
    assert.deepEqual(primary.got, ["a"], "nothing open — the composer gets it");

    browser.isOpen = true;
    stdin.send("b");
    assert.deepEqual(browser.got, ["b"]);

    // An approval raised while the browser is up wins, because it is first.
    gate.isOpen = true;
    stdin.send("y");
    assert.deepEqual(gate.got, ["y"]);
    assert.deepEqual(browser.got, ["b"], "the browser must not also see the approval keystroke");

    stop();
  });

  it("still accepts a single overlay, unchanged", () => {
    const stdin = new FakeStdin();
    const primary = new Recorder();
    const gate = new FakeOverlay();
    const stop = routeStdin({ stdin, primary, overlay: gate });
    gate.isOpen = true;
    stdin.send("x");
    assert.deepEqual(gate.got, ["x"]);
    stop();
  });
});
