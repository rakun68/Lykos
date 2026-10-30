import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { routeStdin, type RouterTimer, type StdinLike, type StdinRoutable, type RoutableOverlay } from "./stdin-router.js";

class FakeStdin implements StdinLike {
  private listeners: Array<(chunk: Buffer | string) => void> = [];
  on(_event: "data", listener: (chunk: Buffer | string) => void): void {
    this.listeners.push(listener);
  }
  off(_event: "data", listener: (chunk: Buffer | string) => void): void {
    this.listeners = this.listeners.filter((l) => l !== listener);
  }
  emit(chunk: string): void {
    for (const l of [...this.listeners]) l(chunk);
  }
  get listenerCount(): number {
    return this.listeners.length;
  }
}

class FakeTimer implements RouterTimer {
  pending: Array<{ id: number; fn: () => void }> = [];
  private nextId = 1;
  cleared = new Set<number>();
  setTimer(fn: () => void, _ms: number): unknown {
    const id = this.nextId++;
    this.pending.push({ id, fn });
    return id;
  }
  clearTimer(handle: unknown): void {
    this.cleared.add(handle as number);
  }
  /** Fire every still-pending, not-cleared timer, in order. */
  fireAll(): void {
    const due = this.pending.filter((t) => !this.cleared.has(t.id));
    this.pending = [];
    for (const t of due) if (!this.cleared.has(t.id)) t.fn();
  }
}

class RecordingRoutable implements StdinRoutable {
  fed: string[] = [];
  flushed = 0;
  feedBytes(chunk: string): void {
    this.fed.push(chunk);
  }
  flushPending(): void {
    this.flushed += 1;
  }
}

class RecordingOverlay extends RecordingRoutable implements RoutableOverlay {
  isOpen = false;
}

describe("stdin-router: routes bytes to whichever consumer is active", () => {
  it("routes to primary when the overlay is closed", () => {
    const stdin = new FakeStdin();
    const primary = new RecordingRoutable();
    const overlay = new RecordingOverlay();
    const stop = routeStdin({ stdin, primary, overlay, timer: new FakeTimer() });
    stdin.emit("hello");
    assert.deepEqual(primary.fed, ["hello"]);
    assert.deepEqual(overlay.fed, []);
    stop();
  });

  it("routes to the overlay while it is open", () => {
    const stdin = new FakeStdin();
    const primary = new RecordingRoutable();
    const overlay = new RecordingOverlay();
    overlay.isOpen = true;
    const stop = routeStdin({ stdin, primary, overlay, timer: new FakeTimer() });
    stdin.emit("y");
    assert.deepEqual(overlay.fed, ["y"]);
    assert.deepEqual(primary.fed, []);
    stop();
  });

  it("switches targets between chunks as isOpen changes — e.g. an approval opening mid-session", () => {
    const stdin = new FakeStdin();
    const primary = new RecordingRoutable();
    const overlay = new RecordingOverlay();
    const stop = routeStdin({ stdin, primary, overlay, timer: new FakeTimer() });
    stdin.emit("prompt\r");
    overlay.isOpen = true; // the submitted line triggered an approval request
    stdin.emit("y");
    assert.deepEqual(primary.fed, ["prompt\r"]);
    assert.deepEqual(overlay.fed, ["y"]);
    stop();
  });

  it("the idle timer flushes the currently-active target after a gap with nothing more arriving", () => {
    const stdin = new FakeStdin();
    const primary = new RecordingRoutable();
    const overlay = new RecordingOverlay();
    const timer = new FakeTimer();
    const stop = routeStdin({ stdin, primary, overlay, timer });
    stdin.emit("\x1b"); // a lone, possibly-ambiguous ESC
    timer.fireAll();
    assert.equal(primary.flushed, 1);
    stop();
  });

  it("a new chunk cancels the previous idle timer rather than double-flushing", () => {
    const stdin = new FakeStdin();
    const primary = new RecordingRoutable();
    const overlay = new RecordingOverlay();
    const timer = new FakeTimer();
    const stop = routeStdin({ stdin, primary, overlay, timer });
    stdin.emit("\x1b");
    stdin.emit("[A"); // completes the sequence before the idle timer would have fired
    timer.fireAll();
    assert.equal(primary.flushed, 1, "only the final, still-pending timer should fire");
    stop();
  });

  it("stop() unsubscribes from stdin and cancels any pending idle timer", () => {
    const stdin = new FakeStdin();
    const primary = new RecordingRoutable();
    const overlay = new RecordingOverlay();
    const timer = new FakeTimer();
    const stop = routeStdin({ stdin, primary, overlay, timer });
    assert.equal(stdin.listenerCount, 1);
    stdin.emit("x");
    stop();
    assert.equal(stdin.listenerCount, 0);
    timer.fireAll();
    assert.equal(primary.flushed, 0, "a cancelled timer must not fire after stop()");
  });

  it("accepts real Buffer chunks, not only strings", () => {
    const stdin = new FakeStdin();
    const primary = new RecordingRoutable();
    const overlay = new RecordingOverlay();
    const stop = routeStdin({ stdin, primary, overlay, timer: new FakeTimer() });
    stdin.emit(Buffer.from("buf-chunk", "utf8") as unknown as string);
    assert.deepEqual(primary.fed, ["buf-chunk"]);
    stop();
  });
});
