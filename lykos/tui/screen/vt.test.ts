import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { probeVtSupport, resetVtSupportCache, vtSupport, type VtProbeIo } from "./vt.js";

/**
 * A fake terminal. `reply` is what it sends back when the probe writes
 * `\x1b[6n` — `null` for a terminal that says nothing, which is the case
 * legacy conhost is expected to take.
 */
function fakeIo(opts: {
  reply?: string | null;
  stdoutIsTty?: boolean;
  stdinIsTty?: boolean;
  rawSupported?: boolean;
  env?: Record<string, string | undefined>;
  /** Split the reply across this many chunks, to prove the probe buffers. */
  chunks?: number;
}) {
  const written: string[] = [];
  const rawCalls: boolean[] = [];
  let listener: ((chunk: Buffer | string) => void) | undefined;
  let unsubscribed = 0;
  let t = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  const io: VtProbeIo = {
    stdoutIsTty: opts.stdoutIsTty ?? true,
    stdinIsTty: opts.stdinIsTty ?? true,
    write: (text) => {
      written.push(text);
      const reply = opts.reply;
      if (text === "\x1b[6n" && reply != null && listener) {
        const n = opts.chunks ?? 1;
        const size = Math.ceil(reply.length / n);
        for (let i = 0; i < reply.length; i += size) listener(reply.slice(i, i + size));
      }
    },
    setRawMode: (on) => {
      if (opts.rawSupported === false) return false;
      rawCalls.push(on);
      return true;
    },
    onData: (fn) => {
      listener = fn;
      return () => {
        listener = undefined;
        unsubscribed += 1;
      };
    },
    env: opts.env ?? {},
    now: () => t,
    setTimer: (fn, ms) => {
      timers.push({ at: t + ms, fn });
      return timers.length - 1;
    },
    clearTimer: () => undefined,
  };
  return {
    io,
    written,
    rawCalls,
    get unsubscribed() {
      return unsubscribed;
    },
    /** Fire every timer whose deadline has passed — the "terminal said nothing" path. */
    timeout() {
      t += 1_000;
      for (const timer of timers.splice(0)) timer.fn();
    },
  };
}

afterEach(() => resetVtSupportCache());

describe("T41.2: VT support is probed, not guessed", () => {
  it("a cursor position report is the positive answer", async () => {
    const f = fakeIo({ reply: "\x1b[24;80R" });
    const result = await probeVtSupport(f.io);
    assert.equal(result.supported, true);
    assert.equal(result.method, "dsr");
    assert.equal(result.reply, "\\x1b[24;80R");
    assert.deepEqual(f.written, ["\x1b[6n"]);
  });

  it("a reply split across chunks is still recognised", async () => {
    const f = fakeIo({ reply: "\x1b[24;80R", chunks: 4 });
    const result = await probeVtSupport(f.io);
    assert.equal(result.supported, true);
    assert.equal(result.method, "dsr");
  });

  it("a reply buried in other keystrokes is still recognised", async () => {
    const f = fakeIo({ reply: "abc\x1b[7;13Rdef" });
    const result = await probeVtSupport(f.io);
    assert.equal(result.supported, true);
    assert.equal(result.reply, "\\x1b[7;13R");
  });

  it("silence within the timeout is the negative answer, and says what it read instead", async () => {
    const f = fakeIo({ reply: null });
    const promise = probeVtSupport(f.io, 250);
    f.timeout();
    const result = await promise;
    assert.equal(result.supported, false);
    assert.equal(result.method, "timeout");
    assert.match(result.detail, /no cursor position report within 250ms/);
  });

  it("raw mode is released and stdin is unsubscribed on both answers", async () => {
    const good = fakeIo({ reply: "\x1b[1;1R" });
    await probeVtSupport(good.io);
    assert.deepEqual(good.rawCalls, [true, false]);
    assert.equal(good.unsubscribed, 1);

    const bad = fakeIo({ reply: null });
    const promise = probeVtSupport(bad.io, 10);
    bad.timeout();
    await promise;
    assert.deepEqual(bad.rawCalls, [true, false]);
    assert.equal(bad.unsubscribed, 1);
  });

  it("TERM=dumb is believed without a probe", async () => {
    const f = fakeIo({ reply: "\x1b[1;1R", env: { TERM: "dumb" } });
    const result = await probeVtSupport(f.io);
    assert.equal(result.supported, false);
    assert.equal(result.method, "term-dumb");
    assert.deepEqual(f.written, [], "a declared answer costs no probe");
  });

  it("a non-tty on either stream is unprobeable and reports which", async () => {
    const noOut = await probeVtSupport(fakeIo({ stdoutIsTty: false }).io);
    assert.equal(noOut.method, "no-tty");
    assert.match(noOut.detail, /stdout tty=false/);
    const noIn = await probeVtSupport(fakeIo({ stdinIsTty: false }).io);
    assert.equal(noIn.method, "no-tty");
    assert.match(noIn.detail, /stdin tty=false/);
  });

  it("a tty with no raw mode cannot be probed and says so", async () => {
    const result = await probeVtSupport(fakeIo({ rawSupported: false }).io);
    assert.equal(result.supported, false);
    assert.equal(result.method, "no-raw-mode");
  });

  it("LYKOS_VT overrides in both directions, and is never reported as measured", async () => {
    const off = await probeVtSupport(fakeIo({ reply: "\x1b[1;1R", env: { LYKOS_VT: "0" } }).io);
    assert.equal(off.supported, false);
    assert.equal(off.method, "forced");
    assert.match(off.detail, /configured, not measured/);

    const on = await probeVtSupport(fakeIo({ reply: null, env: { LYKOS_VT: "1" } }).io);
    assert.equal(on.supported, true);
    assert.equal(on.method, "forced");
  });

  it("the platform is never consulted — a win32 host with a VT terminal answers yes", async () => {
    // The guard T41.2 names explicitly: no `process.platform === "win32"`
    // shortcut in either direction. A Windows host that answers the probe is
    // supported; one that does not is not; the platform is not evidence.
    const result = await probeVtSupport(fakeIo({ reply: "\x1b[30;120R", env: { TERM: "xterm-256color" } }).io);
    assert.equal(result.supported, true);
  });
});

describe("T41.2: probed once at start", () => {
  it("vtSupport() caches — a second call costs no second timeout", async () => {
    const f = fakeIo({ reply: "\x1b[2;2R" });
    const first = await vtSupport(f.io);
    const second = await vtSupport(f.io);
    assert.equal(first, second, "the same object, not a re-probe");
    assert.deepEqual(f.written, ["\x1b[6n"]);
  });
});
