// Verify VT support rather than assuming it.
//
// The maintainer's primary environment is Windows 10 (19045). conpty in
// Windows Terminal and VS Code's integrated terminal handle VT sequences;
// legacy `conhost` may not, and `ENABLE_VIRTUAL_TERMINAL_PROCESSING` is not
// universally on. The task text is explicit that
// `process.platform === "win32"` is not an acceptable answer in either
// direction, so this file does not guess from the platform, from `TERM`, or
// from a table of terminal emulators that ship a marker environment
// variable.
//
// It asks the terminal. `\x1b[6n` is DSR-CPR (Device Status Report, cursor
// position report): a terminal that processes VT sequences answers on stdin
// with `\x1b[<row>;<col>R`, and one that does not answers with nothing at
// all — printing the raw bytes, which is itself the evidence, since the
// probe runs before the alternate buffer is entered and a stray `[6n` on
// screen is recoverable. A reply proves the whole stack (emulator, conpty,
// console mode flags) actually interprets CSI; no reply inside the timeout
// means the append-only renderer (T50.1) is the correct surface for this
// terminal, whatever it claims about itself.
//
// Run once at start and cached: the answer cannot change mid-process, and a
// second probe would cost another timeout on every terminal that fails.

import { stdoutWrite } from "../io-mode.js";

/** Which piece of evidence decided the answer. Recorded so `doctor` can report the reason, not just the verdict. */
export type VtProbeMethod =
  | "dsr" // the terminal answered \x1b[6n — the only positive answer
  | "forced" // LYKOS_VT=1/0
  | "term-dumb" // TERM=dumb, which is a declaration and is believed
  | "no-tty" // stdout or stdin is not a terminal; nothing to probe
  | "no-raw-mode" // a TTY that cannot be put in raw mode; a reply could not be read
  | "timeout"; // a TTY that was asked and said nothing

export interface VtProbeResult {
  supported: boolean;
  method: VtProbeMethod;
  /** Human-readable, for `doctor` and for the task's own notes. */
  detail: string;
  /** The raw reply, escapes made visible, when there was one. */
  reply?: string;
  elapsedMs?: number;
}

export interface VtProbeIo {
  stdoutIsTty: boolean;
  stdinIsTty: boolean;
  /** Bytes to the terminal. Must be the same stream `terminal.ts` writes to. */
  write(text: string): void;
  /** Returns false when raw mode is unavailable — a pipe, or a platform that cannot. */
  setRawMode(on: boolean): boolean;
  /** Subscribe to stdin data; the returned function unsubscribes and must also un-pause the stream if the probe resumed it. */
  onData(fn: (chunk: Buffer | string) => void): () => void;
  env: Record<string, string | undefined>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

const CPR_REPLY = /\x1b\[\d+;\d+R/;

/** The default timeout. Long enough for a real terminal over a slow ssh hop, short enough not to feel like a hang on a dumb one. */
export const VT_PROBE_TIMEOUT_MS = 250;

export function nodeVtProbeIo(): VtProbeIo {
  return {
    stdoutIsTty: Boolean(process.stdout.isTTY),
    stdinIsTty: Boolean(process.stdin.isTTY),
    // Through `stdoutWrite()` like every other writer (T32.2's scan is
    // mechanical and this is not a special case): a DSR request is bytes on
    // stdout, and in `mcp` mode those bytes are JSON-RPC corruption. The
    // guard throwing there is the correct outcome, since nothing should be
    // probing a terminal that does not exist.
    write: (text) => stdoutWrite(text),
    setRawMode: (on) => {
      if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return false;
      process.stdin.setRawMode(on);
      return true;
    },
    onData: (fn) => {
      const wasPaused = process.stdin.isPaused();
      process.stdin.on("data", fn);
      if (wasPaused) process.stdin.resume();
      return () => {
        process.stdin.off("data", fn);
        if (wasPaused) process.stdin.pause();
      };
    },
    env: process.env,
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms).unref(),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
}

function visible(text: string): string {
  return text.replace(/\x1b/g, "\\x1b");
}

/**
 * Probe once. `LYKOS_VT` is the escape hatch in both directions — `0` for a
 * terminal that answers the probe and then renders the result wrongly, `1`
 * for one that cannot answer (a pty with no readable stdin) but is known
 * good. Both are recorded as `forced` so a report never presents a
 * configured answer as a measured one.
 */
export async function probeVtSupport(io: VtProbeIo, timeoutMs = VT_PROBE_TIMEOUT_MS): Promise<VtProbeResult> {
  const forced = io.env.LYKOS_VT;
  if (forced === "0" || forced === "1") {
    return {
      supported: forced === "1",
      method: "forced",
      detail: `LYKOS_VT=${forced} — configured, not measured`,
    };
  }
  if (io.env.TERM === "dumb") {
    return { supported: false, method: "term-dumb", detail: "TERM=dumb — the terminal declares it has no VT support" };
  }
  if (!io.stdoutIsTty || !io.stdinIsTty) {
    return {
      supported: false,
      method: "no-tty",
      detail: `not a terminal (stdout tty=${io.stdoutIsTty}, stdin tty=${io.stdinIsTty}) — nothing to probe`,
    };
  }
  if (!io.setRawMode(true)) {
    return { supported: false, method: "no-raw-mode", detail: "stdin is a tty but raw mode is unavailable — a reply could not be read" };
  }

  const started = io.now();
  let buffered = "";
  let settle: ((r: VtProbeResult) => void) | undefined;
  const done = new Promise<VtProbeResult>((resolve) => {
    settle = resolve;
  });

  const unsubscribe = io.onData((chunk) => {
    buffered += typeof chunk === "string" ? chunk : chunk.toString("latin1");
    const match = CPR_REPLY.exec(buffered);
    if (match) {
      settle?.({
        supported: true,
        method: "dsr",
        // Escaped, never a literal ESC: this string is printed by `doctor`
        // and by the probe note, and a real CSI in it would be a second DSR
        // request issued by the act of reporting the first one.
        detail: "the terminal answered \\x1b[6n with a cursor position report",
        reply: visible(match[0]),
        elapsedMs: io.now() - started,
      });
    }
  });
  const timer = io.setTimer(() => {
    settle?.({
      supported: false,
      method: "timeout",
      detail: `no cursor position report within ${timeoutMs}ms${buffered ? ` (read ${JSON.stringify(visible(buffered))} instead)` : ""}`,
      elapsedMs: io.now() - started,
    });
  }, timeoutMs);

  io.write("\x1b[6n");
  try {
    return await done;
  } finally {
    io.clearTimer(timer);
    unsubscribe();
    io.setRawMode(false);
  }
}

let cached: VtProbeResult | undefined;

/** The once-at-start entry point. `resetVtSupportCache()` exists for tests only. */
export async function vtSupport(io: VtProbeIo = nodeVtProbeIo(), timeoutMs = VT_PROBE_TIMEOUT_MS): Promise<VtProbeResult> {
  if (!cached) cached = await probeVtSupport(io, timeoutMs);
  return cached;
}

export function resetVtSupportCache(): void {
  cached = undefined;
}
