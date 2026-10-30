// T41.1 / T41.5 (docs/17-phase35-terminal-ui-tasks.md) — own the terminal,
// and give it back.
//
// This is the task where a mistake is worst, and the failure is not a bad
// frame: it is the user's shell. A terminal left in raw mode with a hidden
// cursor and the alternate buffer still active does not echo, does not
// respond to Ctrl-C, and shows no prompt — the user has to type `reset`
// blind, or close the window. Every other bug in this phase is a cosmetic
// annoyance next to that, which is why restoration is structured as a
// guarantee rather than a code path:
//
//  - **One place emits the sequences, in one order, reversed on the way
//    out.** `ENTER_SEQUENCES` and `LEAVE_SEQUENCES` below are literal
//    mirrors, and nothing else in the package writes a mode-setting escape.
//  - **`leave()` is idempotent.** Several exit paths can fire for one exit
//    (a SIGINT handler, then `process.on("exit")`), and a second restore
//    that re-emits the alternate-buffer reset would drop the user out of a
//    buffer they are already in.
//  - **Every exit path is registered, including the ones that are not
//    exits.** `uncaughtException` and `unhandledRejection` are the paths
//    that actually fail in practice: a normal return is easy to get right
//    and a crash mid-frame is the one nobody tests. Here the crash restores
//    the terminal first and *then* prints the stack, so the stack lands in
//    the normal buffer where it survives the app closing.
//  - **The handlers are removed on the way out.** Otherwise fifty
//    enter/leave cycles in one process (T41's acceptance loop) leak fifty
//    sets of listeners and Node starts warning about it.
//
// T32's stdout ownership is not relaxed here. Escape sequences are bytes:
// they go through `stdoutWrite()`, and `enter()` refuses outright in `mcp`
// and `piped` mode rather than trusting a caller to have checked.

import { getIoMode, stdoutWrite } from "../io-mode.js";

/** Set on the way in, in this order. */
export const ENTER_SEQUENCES = {
  altBuffer: "\x1b[?1049h",
  hideCursor: "\x1b[?25l",
  /**
   * X10 mouse tracking, plus button-event (drag) tracking, plus SGR
   * extended coordinates — SGR because X10's coordinate encoding breaks
   * past column 223, and `?1002h` because without it the terminal reports
   * presses and releases but never the motion between them, which is
   * precisely what a drag-select is (2026-09-02 UI feedback, item 8).
   *
   * `?1003h` — any-event tracking, i.e. motion with NO button held — was
   * added in round eleven (item 1: "make buttons highlight when mouse
   * hover around it"). Round nine explicitly declined it, on the grounds
   * that it "reports the pointer position continuously for every movement
   * across the WHOLE terminal" for a feature the request itself hedged;
   * round eleven asked for it outright, so the traffic is now a cost the
   * maintainer has chosen rather than one spent on their behalf. It is
   * bounded at both ends: the reports are fixed-size SGR sequences read by
   * the same parser a click already goes through, and
   * `ScreenPipeline.setHover()` only marks the frame dirty when the
   * pointer moves between two DIFFERENT clickable regions — sweeping the
   * mouse across ordinary transcript rows repaints nothing at all.
   */
  mouse: "\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h",
  /**
   * Kitty keyboard protocol, "disambiguate escape codes" flag only (bit 1)
   * — pushed onto the terminal's own mode stack (`>`), never replacing
   * whatever the shell had before. This is what makes Shift+Enter arrive
   * as `CSI 13;2u` (input.ts's new KNOWN_SEQUENCES entry) instead of the
   * bare CR that's indistinguishable from plain Enter. A terminal that
   * doesn't implement the protocol (most Windows consoles, older xterm)
   * ignores an unrecognised private CSI sequence — this is safe to
   * blind-send, the same assumption every other TUI that adopts the
   * protocol relies on, and `LEAVE_SEQUENCES.kittyKeyboard` pops it back
   * off so the shell's own key reporting is unchanged after `leave()`.
   *
   * `CSI > 4 ; 2 m` is xterm's older `modifyOtherKeys` at level 2, sent
   * alongside it for the terminals that implement that and not Kitty's
   * protocol (Windows Terminal and current xterm among them). The two
   * report the same keypress differently — `CSI 13;2u` versus
   * `CSI 27;2;13~` — which is why `input.ts` knows both encodings for
   * every modified key it cares about. Asking for both is what makes
   * Shift+Enter and Ctrl+Backspace work on more than one host; a terminal
   * that implements neither ignores both, unchanged from before.
   */
  kittyKeyboard: "\x1b[>1u\x1b[>4;2m",
  /**
   * Bracketed paste. `input.ts` has decoded `\x1b[200~ … \x1b[201~` since
   * T46.1 and exported the enable/disable pair "so a caller wires them at
   * raw-mode entry/exit" — and then no caller ever did, which meant a
   * multi-line paste arrived as ordinary keystrokes and its first newline
   * SUBMITTED the prompt. Found while chasing the 2026-09-02 Shift+Enter
   * report, since it is the same question from the other side: which
   * newlines mean "send" and which mean "text".
   */
  bracketedPaste: "\x1b[?2004h",
  /**
   * win32-input-mode, and the reason item 5 ("Shift Enter or Ctrl Enter
   * still does not end line, ADD THIS RIGHT NOW AT ALL COST") is fixable at
   * all on this maintainer's machine.
   *
   * Neither of the two protocols already requested above is implemented by
   * Windows Terminal or conhost: Kitty's `CSI > 1 u` and xterm's
   * `modifyOtherKeys` are both ignored there, which is why Shift+Enter kept
   * arriving as a bare CR indistinguishable from Enter no matter what was
   * added last round. What Windows consoles DO implement is their own
   * extension — `CSI ? 9001 h` — after which every key arrives as
   * `CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`, carrying the virtual-key code and
   * the full control-key state. Shift+Enter and Ctrl+Enter are then exactly
   * as distinguishable as they are in a GUI application.
   *
   * Pi solves the same problem with a native prebuilt addon that reads
   * `GetAsyncKeyState(VK_SHIFT)` and rewrites a bare CR (read out of
   * `node_modules` while chasing this). Lykos may not add a runtime
   * dependency — Phase 3.5's rule, and a `.node` binary is a much larger
   * commitment than a dependency anyway — and does not need to: this is
   * eight bytes of escape sequence for the same answer.
   *
   * Only sent on win32. Elsewhere it is a private CSI no terminal claims,
   * and sending it would be harmless but pointless; restricting it keeps
   * the blast radius of a decoding mistake to the one platform that needs
   * it. `LYKOS_WIN32_INPUT=0` turns it off for a session where it misfires.
   */
  win32Input: "\x1b[?9001h",
} as const;

/** Reversed on the way out, in this order — the exact mirror of ENTER_SEQUENCES. */
export const LEAVE_SEQUENCES = {
  win32Input: "\x1b[?9001l",
  bracketedPaste: "\x1b[?2004l",
  kittyKeyboard: "\x1b[>4;0m\x1b[<u",
  mouse: "\x1b[?1006l\x1b[?1003l\x1b[?1002l\x1b[?1000l",
  showCursor: "\x1b[?25h",
  altBuffer: "\x1b[?1049l",
} as const;

/**
 * Whether this process should ask for win32-input-mode: a Windows console,
 * unless the escape hatch says otherwise. Exported so the key decoder can
 * be told the same thing without a second copy of the rule.
 */
export function wantsWin32Input(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (env.LYKOS_WIN32_INPUT === "0") return false;
  if (env.LYKOS_WIN32_INPUT === "1") return true;
  return platform === "win32";
}

/** The signals a full-screen app must restore on. SIGHUP included: closing the terminal window is a normal way to end a session. */
export const HANDLED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
export type HandledSignal = (typeof HANDLED_SIGNALS)[number];

/**
 * 128 + signo, the shell convention, so the exit status after a killed
 * session says what killed it rather than a Lykos-invented number.
 */
const SIGNAL_EXIT_CODE: Record<HandledSignal, number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

export interface ScreenIo {
  write(text: string): void;
  writeError(text: string): void;
  /** Returns false when raw mode is unavailable; `enter()` treats that as fatal rather than continuing half-owned. */
  setRawMode(on: boolean): boolean;
  size(): { columns: number; rows: number };
  /** Returns an unsubscribe. */
  onResize(fn: () => void): () => void;
  on(event: string, fn: (...args: unknown[]) => void): void;
  off(event: string, fn: (...args: unknown[]) => void): void;
  exit(code: number): void;
}

/**
 * 80x24 is the fallback, not a guess at the real size: a redirected or
 * detached stdout reports nothing, and the fallback ladder (T50.1) will have
 * sent that caller to the append-only renderer anyway.
 */
export const FALLBACK_SIZE = { columns: 80, rows: 24 } as const;

export function nodeScreenIo(): ScreenIo {
  return {
    write: (text) => stdoutWrite(text),
    writeError: (text) => void process.stderr.write(text),
    setRawMode: (on) => {
      if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return false;
      process.stdin.setRawMode(on);
      return true;
    },
    size: () => ({
      columns: process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : FALLBACK_SIZE.columns,
      rows: process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : FALLBACK_SIZE.rows,
    }),
    onResize: (fn) => {
      process.stdout.on("resize", fn);
      return () => void process.stdout.off("resize", fn);
    },
    on: (event, fn) => void process.on(event as never, fn as never),
    off: (event, fn) => void process.off(event as never, fn as never),
    exit: (code) => process.exit(code),
  };
}

export type ExitCause = { kind: "signal"; signal: HandledSignal } | { kind: "crash"; error: unknown };

export interface ScreenTerminalOpts {
  io?: ScreenIo;
  /**
   * T43.3's mouse wheel, plus click-to-position and drag-select. Off unless
   * asked for: mouse tracking turns every click into bytes on stdin, which a
   * session that does not read them renders as garbage. The full-screen
   * surface always asks for it.
   *
   * It was briefly a live-toggleable setting (`/mouse`, 2026-09-02) on the
   * theory that holding the mouse is what cost the terminal its Ctrl+scroll
   * zoom. It does — but the maintainer's answer was "it was a mistake, i can
   * totally change size with Ctrl plus and minus", so the toggle, its config
   * key and its command are gone rather than left behind as a flag nobody
   * needs. Ctrl +/- resizes the font on every terminal Lykos targets and
   * never involves the mouse at all.
   */
  mouse?: boolean;
  /** Shift+Enter support (2026-09-01 UI feedback). Off unless asked for, same caution as `mouse` — see `ENTER_SEQUENCES.kittyKeyboard`'s doc for why blind-sending it is safe regardless. */
  kittyKeyboard?: boolean;
  /** win32-input-mode. Defaults to `wantsWin32Input()` — on a Windows console, off everywhere else. An explicit value is for tests, which must not depend on the platform they run on. */
  win32Input?: boolean;
  /**
   * Called after the terminal is restored and before the process exits, on a
   * crash or a signal. For flushing a transcript — not for rendering, since
   * the screen is gone by then. Must not throw; a throw is swallowed,
   * because a failing cleanup hook may not become the reason the terminal
   * stays broken.
   */
  onBeforeExit?: (cause: ExitCause) => void;
}

export class ScreenTerminal {
  private readonly io: ScreenIo;
  private readonly mouse: boolean;
  private readonly kittyKeyboard: boolean;
  private readonly win32Input: boolean;
  private readonly onBeforeExit: ScreenTerminalOpts["onBeforeExit"];
  private entered = false;
  private teardown: Array<() => void> = [];
  /** Counted so the acceptance loop can assert fifty cycles produced fifty enters and fifty leaves and nothing else. */
  enters = 0;
  leaves = 0;

  constructor(opts: ScreenTerminalOpts = {}) {
    this.io = opts.io ?? nodeScreenIo();
    this.mouse = opts.mouse ?? false;
    this.kittyKeyboard = opts.kittyKeyboard ?? false;
    this.win32Input = opts.win32Input ?? wantsWin32Input();
    this.onBeforeExit = opts.onBeforeExit;
  }

  get isActive(): boolean {
    return this.entered;
  }

  size(): { columns: number; rows: number } {
    return this.io.size();
  }

  /**
   * T41.5. The caller re-measures and re-renders; `FrameWriter` turns the
   * dimension change into a full redraw by itself, so a resize cannot leave
   * stale cells even if the caller forgets to reset it. Lykos cannot prevent
   * a resize and does not pretend to.
   */
  onResize(fn: (size: { columns: number; rows: number }) => void): () => void {
    return this.io.onResize(() => fn(this.io.size()));
  }

  enter(): void {
    if (this.entered) return;
    const mode = getIoMode();
    if (mode !== "standalone") {
      throw new Error(
        `lykos: the full-screen surface is forbidden in ${mode} mode — stdout belongs to the transport ` +
          "(CLAUDE.md, T32); the append-only renderer is the surface for this shape (T50.1)",
      );
    }
    if (!this.io.setRawMode(true)) {
      throw new Error(
        "lykos: cannot enter the full-screen surface — stdin is not a terminal that supports raw mode (T50.1 falls back)",
      );
    }
    this.io.write(ENTER_SEQUENCES.altBuffer + ENTER_SEQUENCES.hideCursor);
    if (this.mouse) this.io.write(ENTER_SEQUENCES.mouse);
    if (this.kittyKeyboard) this.io.write(ENTER_SEQUENCES.kittyKeyboard);
    this.io.write(ENTER_SEQUENCES.bracketedPaste);
    if (this.win32Input) this.io.write(ENTER_SEQUENCES.win32Input);
    this.entered = true;
    this.enters += 1;
    this.registerExitPaths();
  }

  /** Idempotent. Safe from a signal handler, from `process.on("exit")`, and from a `finally`. */
  leave(): void {
    if (!this.entered) return;
    this.entered = false;
    this.leaves += 1;
    for (const undo of this.teardown.splice(0)) {
      try {
        undo();
      } catch {
        // A failing listener removal may not stop the sequences below.
      }
    }
    if (this.win32Input) this.io.write(LEAVE_SEQUENCES.win32Input);
    this.io.write(LEAVE_SEQUENCES.bracketedPaste);
    if (this.kittyKeyboard) this.io.write(LEAVE_SEQUENCES.kittyKeyboard);
    if (this.mouse) this.io.write(LEAVE_SEQUENCES.mouse);
    this.io.write(LEAVE_SEQUENCES.showCursor + LEAVE_SEQUENCES.altBuffer);
    this.io.setRawMode(false);
  }

  /** `enter()`, run `body`, `leave()` — including when `body` throws, which is the case the acceptance test cares about. */
  async run<T>(body: () => Promise<T>): Promise<T> {
    this.enter();
    try {
      return await body();
    } finally {
      this.leave();
    }
  }

  private registerExitPaths(): void {
    const onExit = () => this.leave();
    const onCrash = (err: unknown) => {
      this.leave();
      this.safeBeforeExit({ kind: "crash", error: err });
      // Printed AFTER the restore, so it lands in the normal buffer and is
      // still on screen once the app is gone. A stack written into the
      // alternate buffer disappears with it, which is how a full-screen app
      // turns a crash into "it just closed".
      this.io.writeError(`\nlykos: unhandled error — the terminal has been restored\n${stackOf(err)}\n`);
      this.io.exit(1);
    };
    const signalHandlers = HANDLED_SIGNALS.map((signal) => {
      const fn = () => {
        this.leave();
        this.safeBeforeExit({ kind: "signal", signal });
        this.io.exit(SIGNAL_EXIT_CODE[signal]);
      };
      this.io.on(signal, fn);
      return { signal, fn };
    });
    this.io.on("exit", onExit);
    this.io.on("uncaughtException", onCrash as (...args: unknown[]) => void);
    this.io.on("unhandledRejection", onCrash as (...args: unknown[]) => void);
    this.teardown.push(() => {
      this.io.off("exit", onExit);
      this.io.off("uncaughtException", onCrash as (...args: unknown[]) => void);
      this.io.off("unhandledRejection", onCrash as (...args: unknown[]) => void);
      for (const { signal, fn } of signalHandlers) this.io.off(signal, fn);
    });
  }

  private safeBeforeExit(cause: ExitCause): void {
    try {
      this.onBeforeExit?.(cause);
    } catch {
      // See onBeforeExit's contract: a failing hook does not get to be the
      // reason the process dies with a broken terminal.
    }
  }
}

function stackOf(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}
