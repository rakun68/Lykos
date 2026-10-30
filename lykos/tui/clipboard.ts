// The system clipboard, for the composer's copy/cut/paste — 2026-09-02 UI
// feedback, item 8 ("many features with copying pasting… basically add
// everything that a normal editor have").
//
// Two directions, two completely different mechanisms, and the asymmetry
// is not an oversight:
//
//  - **Writing** goes through OSC 52, the terminal's own "set the
//    clipboard" escape sequence. It costs no subprocess, works over SSH
//    (the terminal at the near end is the one that owns the clipboard,
//    which is the correct end), and needs no platform detection. Windows
//    Terminal, iTerm2, kitty, WezTerm and xterm all implement it; a
//    terminal that does not simply ignores an unknown OSC, so this is safe
//    to emit blind — the same reasoning `terminal.ts` documents for the
//    Kitty keyboard protocol.
//  - **Reading** cannot go through OSC 52 in practice: the read form
//    (`OSC 52 ; c ; ?`) is disabled by default in essentially every
//    terminal because it lets any program that can write to a tty exfiltrate
//    whatever the user last copied, and the reply would have to be parsed
//    back out of the same stdin stream the key decoder owns. So a paste
//    shells out to the platform's own clipboard tool instead, synchronously
//    and with a short timeout, because a paste is a deliberate one-off
//    keystroke rather than anything on a hot path.
//
// `RawLineSource` never depends on either succeeding: it falls back to the
// editor's own in-process cut/copy register, so Ctrl-X then Ctrl-V works
// in a session where neither mechanism is available (a CI pty, a terminal
// with OSC 52 disabled, a Linux box with no xclip installed).

import { spawnSync } from "node:child_process";

/** OSC 52, `c` for the CLIPBOARD selection (not PRIMARY). BEL-terminated — more widely accepted than ST. */
export function osc52(text: string): string {
  return `\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`;
}

/**
 * Terminals cap how long an OSC they will accept; xterm's default
 * `maxStringParm` is 1024 bytes and several others sit near it. Past this
 * the sequence is silently dropped — and worse, a truncated one can leave
 * the terminal waiting for a terminator. Refuse to emit rather than
 * gamble; the caller's in-process register still holds the text.
 */
const MAX_OSC52_BYTES = 100_000;

export interface ClipboardWriter {
  write(text: string): void;
}

/**
 * Emits OSC 52 through the caller's sink. Returns false when the payload
 * is too large to send safely, so the caller can say so rather than
 * claiming a copy that never happened.
 */
export function copyToClipboard(text: string, sink: ClipboardWriter): boolean {
  if (text.length === 0) return false;
  const seq = osc52(text);
  if (Buffer.byteLength(seq, "utf8") > MAX_OSC52_BYTES) return false;
  sink.write(seq);
  return true;
}

interface ReadCommand {
  cmd: string;
  args: string[];
}

/** Platform paste commands, first match wins. Ordered by how likely each is to be present. */
function readCommands(platform: NodeJS.Platform): ReadCommand[] {
  if (platform === "win32") {
    return [{ cmd: "powershell", args: ["-NoSpecialist", "-NonInteractive", "-Command", "Get-Clipboard -Raw"] }];
  }
  if (platform === "darwin") return [{ cmd: "pbpaste", args: [] }];
  return [
    { cmd: "wl-paste", args: ["--no-newline"] },
    { cmd: "xclip", args: ["-selection", "clipboard", "-o"] },
    { cmd: "xsel", args: ["--clipboard", "--output"] },
  ];
}

/**
 * The system clipboard's current text, or null when no tool on this
 * platform could produce it. Never throws: a missing binary, a denied
 * spawn and a timeout are all "no clipboard," which the caller handles by
 * falling back to the editor's own register.
 *
 * Windows' `Get-Clipboard -Raw` appends a trailing newline of its own that
 * the clipboard does not contain; stripping exactly one trailing CRLF/LF
 * is the difference between pasting a word and pasting a word plus an
 * accidental line break into the composer.
 */
export function readClipboard(platform: NodeJS.Platform = process.platform): string | null {
  for (const { cmd, args } of readCommands(platform)) {
    try {
      const res = spawnSync(cmd, args, { encoding: "utf8", timeout: 2000, windowsHide: true });
      if (res.error || res.status !== 0 || typeof res.stdout !== "string") continue;
      return res.stdout.replace(/\r?\n$/, "");
    } catch {
      continue;
    }
  }
  return null;
}
