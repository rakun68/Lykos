// A capture of what the terminal actually sends, off by default.
//
// This exists because six rounds of the paste bug were diagnosed by
// reasoning about how a terminal "probably" delivers a paste, and every
// one of those fixes was correct about the shape it imagined and wrong
// about the maintainer's machine. `paste-fuzz.test.ts` now covers every
// shape this codebase can model; if a paste still arrives wrong, the thing
// that is missing is not another inference, it is the bytes.
//
// Set `LYKOS_INPUT_LOG` to a file path and every read is appended as one
// JSON line: the raw bytes with escapes made visible, the events they
// decoded to, and what the composer held afterwards. Nothing is written
// when the variable is unset, and a failure to write is swallowed — a
// diagnostic must never be able to break the session it is diagnosing.
//
// It records keystrokes, so it is opt-in per run, never a default, and the
// file belongs to whoever asked for it.

import { appendFileSync } from "node:fs";

export interface InputLogEntry {
  /** `feed` for a read from stdin, `flush` for the idle-gap resolution that follows one. */
  kind: "feed" | "flush";
  /** The raw bytes, if any, with control characters escaped so the line stays one line. */
  bytes?: string;
  /** True when the router judged this read to have arrived back-to-back with the previous one. */
  contiguous?: boolean;
  /** The events the decoder produced, in order, as compact tags. */
  events: string[];
  /** What the composer's buffer held after they were applied. */
  lines: string[];
}

/** Control characters and non-ASCII made visible, so one entry is always one line and always readable. */
export function visibleBytes(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (ch === "\x1b") out += "\\e";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, "0")}`;
    else if (code > 0x7e) out += `\\u{${code.toString(16)}}`;
    else out += ch;
  }
  return out;
}

/** Whether capture is on. Read fresh each time so a caller can turn it on mid-process in a debugger. */
export function inputLogPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = env.LYKOS_INPUT_LOG;
  return path && path.length > 0 ? path : undefined;
}

/** Append one entry. Silent when capture is off, and silent about its own failures. */
export function writeInputLog(entry: InputLogEntry, env: NodeJS.ProcessEnv = process.env): void {
  const path = inputLogPath(env);
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, "utf8");
  } catch {
    // A diagnostic that can break the session is worse than no diagnostic.
  }
}
