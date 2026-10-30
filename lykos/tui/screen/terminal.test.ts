import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetIoMode, setIoMode } from "../io-mode.js";
import {
  ENTER_SEQUENCES,
  HANDLED_SIGNALS,
  LEAVE_SEQUENCES,
  ScreenTerminal,
  type HandledSignal,
  type ScreenIo,
} from "./terminal.js";

/**
 * A recording ScreenIo. `process` is never touched — the whole point of
 * injecting it is that the acceptance loop can run the crash and signal
 * paths, which are the ones that actually fail, without the test process
 * having to survive them.
 */
function fakeIo(size = { columns: 200, rows: 60 }) {
  const written: string[] = [];
  const errors: string[] = [];
  const exits: number[] = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const resizeListeners: Array<() => void> = [];
  let raw = false;
  let rawSupported = true;
  let current = { ...size };
  const io: ScreenIo = {
    write: (t) => void written.push(t),
    writeError: (t) => void errors.push(t),
    setRawMode: (on) => {
      if (!rawSupported) return false;
      raw = on;
      return true;
    },
    size: () => ({ ...current }),
    onResize: (fn) => {
      resizeListeners.push(fn);
      return () => {
        const i = resizeListeners.indexOf(fn);
        if (i !== -1) resizeListeners.splice(i, 1);
      };
    },
    on: (event, fn) => {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    off: (event, fn) => {
      const list = listeners.get(event) ?? [];
      const i = list.indexOf(fn);
      if (i !== -1) list.splice(i, 1);
    },
    exit: (code) => void exits.push(code),
  };
  return {
    io,
    written,
    errors,
    exits,
    listeners,
    get raw() {
      return raw;
    },
    get listenerCount() {
      return [...listeners.values()].reduce((n, l) => n + l.length, 0);
    },
    set rawSupported(v: boolean) {
      rawSupported = v;
    },
    emit(event: string, ...args: unknown[]) {
      for (const fn of [...(listeners.get(event) ?? [])]) fn(...args);
    },
    resize(next: { columns: number; rows: number }) {
      current = { ...next };
      for (const fn of [...resizeListeners]) fn();
    },
  };
}

// Bracketed paste is unconditional (2026-09-02): the decoder has understood
// it since T46.1 and nothing was ever asking the terminal to send it, so a
// multi-line paste arrived as keystrokes and its first newline submitted.
const ENTER_BYTES = ENTER_SEQUENCES.altBuffer + ENTER_SEQUENCES.hideCursor + ENTER_SEQUENCES.bracketedPaste;
const LEAVE_BYTES = LEAVE_SEQUENCES.bracketedPaste + LEAVE_SEQUENCES.showCursor + LEAVE_SEQUENCES.altBuffer;

beforeEach(() => {
  resetIoMode();
  setIoMode("standalone");
});
afterEach(() => resetIoMode());

describe("T41.1: the terminal is owned and given back", () => {
  it("enter sets the alternate buffer, hides the cursor, and takes raw mode", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    term.enter();
    assert.equal(f.written.join(""), ENTER_BYTES);
    assert.equal(f.raw, true);
    assert.equal(term.isActive, true);
  });

  it("leave reverses every sequence, in the mirrored order, and releases raw mode", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    term.enter();
    f.written.length = 0;
    term.leave();
    assert.equal(f.written.join(""), LEAVE_BYTES);
    assert.equal(f.raw, false);
    assert.equal(term.isActive, false);
  });

  it("mouse tracking is opt-in and is turned off before the buffer is released", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false, mouse: true });
    term.enter();
    assert.equal(f.written.join(""), ENTER_SEQUENCES.altBuffer + ENTER_SEQUENCES.hideCursor + ENTER_SEQUENCES.mouse + ENTER_SEQUENCES.bracketedPaste);
    f.written.length = 0;
    term.leave();
    assert.equal(f.written.join(""), LEAVE_SEQUENCES.bracketedPaste + LEAVE_SEQUENCES.mouse + LEAVE_SEQUENCES.showCursor + LEAVE_SEQUENCES.altBuffer);
  });

  it("Kitty keyboard protocol is opt-in (Shift+Enter support) and is popped off before the buffer is released", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false, kittyKeyboard: true });
    term.enter();
    assert.equal(f.written.join(""), ENTER_SEQUENCES.altBuffer + ENTER_SEQUENCES.hideCursor + ENTER_SEQUENCES.kittyKeyboard + ENTER_SEQUENCES.bracketedPaste);
    f.written.length = 0;
    term.leave();
    assert.equal(f.written.join(""), LEAVE_SEQUENCES.bracketedPaste + LEAVE_SEQUENCES.kittyKeyboard + LEAVE_SEQUENCES.showCursor + LEAVE_SEQUENCES.altBuffer);
  });

  it("without the opt-in, no Kitty keyboard sequence is ever written", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    term.enter();
    term.leave();
    assert.ok(!f.written.join("").includes(ENTER_SEQUENCES.kittyKeyboard));
  });

  it("leave is idempotent — a second call emits nothing", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    term.enter();
    term.leave();
    f.written.length = 0;
    term.leave();
    term.leave();
    assert.equal(f.written.join(""), "");
    assert.equal(term.leaves, 1);
  });

  it("enter is idempotent — a second call does not re-enter the buffer", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    term.enter();
    f.written.length = 0;
    term.enter();
    assert.equal(f.written.join(""), "");
    assert.equal(term.enters, 1);
  });

  it("refuses to enter in mcp mode — escape sequences are bytes on the JSON-RPC stream (T32)", () => {
    resetIoMode();
    setIoMode("mcp");
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    assert.throws(() => term.enter(), /forbidden in mcp mode/);
    assert.equal(f.written.length, 0);
    assert.equal(f.raw, false);
  });

  it("refuses to enter in piped mode", () => {
    resetIoMode();
    setIoMode("piped");
    const term = new ScreenTerminal({ io: fakeIo().io, win32Input: false });
    assert.throws(() => term.enter(), /forbidden in piped mode/);
  });

  it("refuses to enter when raw mode is unavailable, rather than continuing half-owned", () => {
    const f = fakeIo();
    f.rawSupported = false;
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    assert.throws(() => term.enter(), /raw mode/);
    assert.equal(f.written.length, 0);
    assert.equal(term.isActive, false);
  });
});

describe("T41.1 acceptance: fifty enter/leave cycles leave nothing behind", () => {
  it("emits exactly fifty enters and fifty leaves, and leaks no listeners", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    for (let i = 0; i < 50; i++) {
      term.enter();
      term.leave();
    }
    const bytes = f.written.join("");
    assert.equal(term.enters, 50);
    assert.equal(term.leaves, 50);
    // The exact byte stream, not a substring count: fifty repetitions of
    // enter-then-leave and nothing else at all.
    assert.equal(bytes, (ENTER_BYTES + LEAVE_BYTES).repeat(50));
    assert.equal(f.raw, false);
    assert.equal(f.listenerCount, 0, "exit-path listeners were left registered");
  });

  it("the same fifty cycles hold when each one exits through run() and through a throw", async () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) {
        await term.run(async () => undefined);
      } else {
        await assert.rejects(
          term.run(async () => {
            throw new Error(`boom ${i}`);
          }),
          /boom/,
        );
      }
    }
    assert.equal(f.written.join(""), (ENTER_BYTES + LEAVE_BYTES).repeat(50));
    assert.equal(f.raw, false);
    assert.equal(f.listenerCount, 0);
  });
});

describe("T41.1 acceptance: the exit paths that actually fail", () => {
  it("process.exit from anywhere still restores, via the exit listener", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    term.enter();
    f.written.length = 0;
    f.emit("exit", 0);
    assert.equal(f.written.join(""), LEAVE_BYTES);
    assert.equal(f.raw, false);
  });

  it("an uncaught exception restores the terminal FIRST and then prints the stack in the normal buffer", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    term.enter();
    f.written.length = 0;
    const err = new Error("mid-frame explosion");
    f.emit("uncaughtException", err);
    assert.equal(f.written.join(""), LEAVE_BYTES, "the restore must be the only thing written to stdout");
    assert.equal(f.raw, false);
    // Ordering is the property under test: the stack is on stderr, and it is
    // written after the alternate buffer was released, so it survives.
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0]!, /the terminal has been restored/);
    assert.match(f.errors[0]!, /mid-frame explosion/);
    assert.match(f.errors[0]!, /terminal\.test\.ts/, "the real stack, not just the message");
    assert.deepEqual(f.exits, [1]);
  });

  it("an unhandled rejection takes the same path", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    term.enter();
    f.written.length = 0;
    f.emit("unhandledRejection", new Error("rejected"));
    assert.equal(f.written.join(""), LEAVE_BYTES);
    assert.match(f.errors[0]!, /rejected/);
    assert.deepEqual(f.exits, [1]);
  });

  it("a non-Error thrown value is still reported rather than swallowed", () => {
    const f = fakeIo();
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    term.enter();
    f.emit("uncaughtException", "a bare string");
    assert.match(f.errors[0]!, /a bare string/);
  });

  for (const signal of HANDLED_SIGNALS) {
    it(`${signal} restores the terminal and exits 128+signo`, () => {
      const expected: Record<HandledSignal, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
      const f = fakeIo();
      const term = new ScreenTerminal({ io: f.io, win32Input: false });
      term.enter();
      f.written.length = 0;
      f.emit(signal);
      assert.equal(f.written.join(""), LEAVE_BYTES);
      assert.equal(f.raw, false);
      assert.deepEqual(f.exits, [expected[signal]]);
    });
  }

  it("onBeforeExit runs after the restore, and a throwing hook cannot break the terminal", () => {
    const f = fakeIo();
    const order: string[] = [];
    const term = new ScreenTerminal({
      io: {
        ...f.io,
        write: (t) => {
          order.push(`write:${JSON.stringify(t)}`);
          f.io.write(t);
        },
      },
      win32Input: false,
      onBeforeExit: (cause) => {
        order.push(`hook:${cause.kind}`);
        throw new Error("a failing cleanup hook");
      },
    });
    term.enter();
    order.length = 0;
    f.emit("SIGTERM");
    // leave() emits the bracketed-paste reset as its own write before the
    // cursor/buffer restore, so the ordering assertion is two writes now.
    assert.deepEqual(order, [
      `write:${JSON.stringify(LEAVE_SEQUENCES.bracketedPaste)}`,
      `write:${JSON.stringify(LEAVE_SEQUENCES.showCursor + LEAVE_SEQUENCES.altBuffer)}`,
      "hook:signal",
    ]);
    assert.deepEqual(f.exits, [143], "the throw was swallowed and the exit still happened");
  });
});

describe("T41.5: resize", () => {
  it("re-measures at the new size and unsubscribes cleanly", () => {
    const f = fakeIo({ columns: 200, rows: 60 });
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    const seen: Array<{ columns: number; rows: number }> = [];
    const off = term.onResize((size) => seen.push(size));
    f.resize({ columns: 40, rows: 10 });
    f.resize({ columns: 200, rows: 60 });
    off();
    f.resize({ columns: 80, rows: 24 });
    assert.deepEqual(seen, [
      { columns: 40, rows: 10 },
      { columns: 200, rows: 60 },
    ]);
  });

  it("size() reads the live terminal, not a value cached at construction", () => {
    const f = fakeIo({ columns: 200, rows: 60 });
    const term = new ScreenTerminal({ io: f.io, win32Input: false });
    assert.deepEqual(term.size(), { columns: 200, rows: 60 });
    f.resize({ columns: 40, rows: 10 });
    assert.deepEqual(term.size(), { columns: 40, rows: 10 });
  });
});
