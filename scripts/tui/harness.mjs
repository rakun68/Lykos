// Drives a terminal program in a real pty (ConPTY on Windows) and reads its screen through a headless xterm:
// what the TUI tests, the speed gate and the TUI-testing MCP server all stand on (P5, tickets #33, #34).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");

export const KEYS = {
  enter: "\r", esc: "\x1b", tab: "\t", "shift+tab": "\x1b[Z", backspace: "\x7f", delete: "\x1b[3~",
  up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F",
  pageup: "\x1b[5~", pagedown: "\x1b[6~", space: " ",
};

/** `ctrl+x`, `alt+x`, a name from KEYS, or the text itself. */
export function keyBytes(key) {
  const lower = key.toLowerCase();
  if (KEYS[lower] !== undefined) return KEYS[lower];
  const ctrl = /^ctrl\+([a-z])$/.exec(lower);
  if (ctrl) return String.fromCharCode(ctrl[1].charCodeAt(0) - 96);
  const alt = /^alt\+(.)$/.exec(key);
  if (alt) return `\x1b${alt[1]}`;
  return key;
}

export class TuiSession {
  constructor(command, args = [], { cols = 120, rows = 40, cwd = process.cwd(), env = {}, scrollback = 0, answerQueries = false } = {}) {
    this.cols = cols;
    this.rows = rows;
    this.term = new Terminal({ cols, rows, allowProposedApi: true, scrollback });
    this.exit = null;
    this.waiters = new Set();
    this.bytes = 0;
    this.spawnedAt = performance.now();
    this.proc = pty.spawn(command, args, { name: "xterm-256color", cols, rows, cwd, env: Object.fromEntries(Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined)) });
    this.proc.onData((data) => {
      this.bytes += data.length;
      // The callback runs once xterm has parsed the chunk, so a waiter sees the screen the chunk made.
      this.term.write(data, () => this.check());
    });
    // A real terminal answers a program's queries (device attributes, cursor position); some TUIs wait for the
    // answer before their first frame. Off by default: the existing tests ran without it.
    if (answerQueries) {
      this.term.onData((reply) => this.exit === null && this.proc.write(reply));
      // xterm-headless leaves the colour queries (OSC 10 and 11) unanswered; OpenTUI waits for them. Answer as a
      // dark terminal does: white on black.
      for (const [code, rgb] of [[10, "ffff/ffff/ffff"], [11, "0000/0000/0000"]]) {
        this.term.parser.registerOscHandler(code, (data) => {
          if (data === "?" && this.exit === null) this.proc.write(`\x1b]${code};rgb:${rgb}\x07`);
          return true;
        });
      }
    }
    this.proc.onExit((e) => {
      this.exit = e;
      this.check();
    });
  }

  get pid() {
    return this.proc.pid;
  }

  check() {
    for (const w of this.waiters) {
      if (w.test()) {
        this.waiters.delete(w);
        w.resolve(performance.now());
      }
    }
  }

  /** The visible screen as text, one line per row, trailing blanks trimmed. */
  screen() {
    const b = this.term.buffer.active;
    const out = [];
    for (let i = 0; i < this.rows; i++) out.push(b.getLine(b.viewportY + i)?.translateToString(true) ?? "");
    return out.join("\n").replace(/\s+$/, "");
  }

  /** The scrollback and the screen as text, oldest row first: what an inline program (`--mini`) printed. */
  all() {
    const b = this.term.buffer.active;
    const out = [];
    for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? "");
    return out.join("\n").replace(/\s+$/, "");
  }

  line(row) {
    const b = this.term.buffer.active;
    return b.getLine(b.viewportY + row)?.translateToString(true) ?? "";
  }

  cursor() {
    const b = this.term.buffer.active;
    return { x: b.cursorX, y: b.cursorY };
  }

  /** Resolves with the time the condition first held on a parsed screen; rejects after `timeout` ms. */
  waitFor(test, timeout = 10000) {
    const pred = typeof test === "string" ? () => this.screen().includes(test) : test instanceof RegExp ? () => test.test(this.screen()) : test;
    if (pred()) return Promise.resolve(performance.now());
    return new Promise((resolve, reject) => {
      const w = { test: pred, resolve };
      this.waiters.add(w);
      setTimeout(() => {
        if (this.waiters.delete(w)) reject(new Error(`timed out after ${timeout} ms waiting for ${String(test)}\n--- screen ---\n${this.screen()}`));
      }, timeout);
    });
  }

  /** Waits until no output has arrived for `quiet` ms. */
  async idle(quiet = 150, timeout = 10000) {
    const start = performance.now();
    let last = this.bytes;
    let since = performance.now();
    while (performance.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 20));
      if (this.bytes !== last) {
        last = this.bytes;
        since = performance.now();
      } else if (performance.now() - since >= quiet) return;
    }
  }

  write(bytes) {
    this.proc.write(bytes);
  }

  press(key, times = 1) {
    this.write(keyBytes(key).repeat(times));
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.proc.resize(cols, rows);
    this.term.resize(cols, rows);
  }

  async close() {
    if (this.exit) {
      // On Windows node-pty keeps its ConPTY pipes open after the child exits, and they hold the event loop.
      try {
        this.proc.kill();
      } catch {
        // Already released.
      }
      return this.exit;
    }
    try {
      this.proc.kill();
    } catch {
      // Already gone.
    }
    await Promise.race([new Promise((r) => this.proc.onExit(r)), new Promise((r) => setTimeout(r, 2000))]);
    return this.exit;
  }
}

/** CPU time (ms) and peak memory (bytes) of a live process, from the OS. */
export function processStats(pid) {
  if (process.platform === "win32") {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `$p = Get-Process -Id ${pid}; "$($p.TotalProcessorTime.TotalMilliseconds) $($p.PeakWorkingSet64) $($p.WorkingSet64)"`],
      { encoding: "utf8" },
    ).trim();
    const [cpu, peak, now] = out.split(/\s+/).map(Number);
    return { cpuMs: cpu, peakBytes: peak, rssBytes: now };
  }
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const ticks = Number(fields[11]) + Number(fields[12]);
  const status = readFileSync(`/proc/${pid}/status`, "utf8");
  const kb = (name) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(status)?.[1] ?? NaN) * 1024;
  const hz = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
  return { cpuMs: (ticks * 1000) / hz, peakBytes: kb("VmHWM"), rssBytes: kb("VmRSS") };
}

export function percentile(values, p) {
  const s = [...values].sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
