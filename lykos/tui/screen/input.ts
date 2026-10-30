// The key decoder: raw bytes in, structured key events out.
//
// Raw mode means Lykos owns every keystroke (T46's own module doc) — there
// is no `readline` underneath doing this translation any more. `KeyDecoder`
// is stateful because a terminal can split one logical keypress across two
// reads (an escape sequence arriving in two `write()`s is common over a
// slow pty): unmatched bytes that could still be the prefix of a known
// sequence are held in an internal buffer rather than misread as their
// own key, and `flush()` — called by the caller after an idle gap with
// nothing more arriving — is what turns a truly lone ESC into an
// `escape` event instead of leaving it stuck forever.

export type ArrowDir = "up" | "down" | "left" | "right";

export type KeyEvent =
  | { type: "char"; value: string }
  /** Any of the three modifiers means "insert a newline" rather than "send" — `raw-line-source.ts` treats them identically, because a user who reaches for Ctrl+Enter and a user who reaches for Shift+Enter want the same thing. */
  | { type: "enter"; alt?: boolean; shift?: boolean; ctrl?: boolean }
  | { type: "tab"; shift?: boolean }
  /** `ctrl` is Ctrl+Backspace — delete the word behind the cursor, not the character (2026-09-02 UI feedback, item 7). */
  | { type: "backspace"; ctrl?: boolean }
  | { type: "delete"; ctrl?: boolean }
  | { type: "escape" }
  | { type: "arrow"; dir: ArrowDir; ctrl?: boolean; shift?: boolean; alt?: boolean }
  | { type: "home"; ctrl?: boolean; shift?: boolean }
  | { type: "end"; ctrl?: boolean; shift?: boolean }
  | { type: "pageUp" }
  | { type: "pageDown" }
  /** Ctrl+<letter>, e.g. { key: "r" } for Ctrl-R. Never produced for Ctrl-I (tab) or Ctrl-M (enter) — those have their own event types. `shift` is only ever set by a terminal speaking Kitty's or xterm's disambiguating protocol; without one, Ctrl+Shift+Z and Ctrl+Z are the same three bytes and this is undefined. */
  | { type: "ctrl"; key: string; shift?: boolean }
  /** Bracketed paste (`\x1b[200~ ... \x1b[201~`) — one event for the whole block, never one event per pasted keystroke. */
  | { type: "paste"; text: string }
  /**
   * SGR mouse wheel (`\x1b[<64;…M` / `\x1b[<65;…M`) — only decoded when
   * `ScreenTerminal` was entered with `{ mouse: true }`. Clicks and drags
   * are a separate `mouse` event below. `ctrl` is decoded from the SGR `Cb` byte's own modifier
   * bits (2026-09-02 UI feedback: Pi's Ctrl+scroll zooms the terminal's
   * own font, "like zoom in zoom out") — most terminals still perform
   * their own zoom on Ctrl+scroll even with mouse tracking active, but a
   * caller that scrolled the transcript on EVERY wheel notch regardless
   * of modifiers would visibly fight that: the transcript would jump at
   * the same moment the terminal is trying to zoom. `raw-line-source.ts`
   * uses this to skip its own scroll action when `ctrl` is set, leaving
   * the terminal's own gesture uncontested.
   */
  | { type: "wheel"; dir: "up" | "down"; ctrl?: boolean }
  /**
   * A button press, release, or motion-with-button-held, from the same SGR
   * report the wheel arrives on. Until 2026-09-02 these were decoded and
   * dropped ("this decoder scrolls, it does not click") — the UI feedback
   * asking for drag-select is what they are for: `raw-line-source.ts` maps
   * `row`/`col` back onto a composer buffer position, so a click places the
   * cursor, a drag extends the selection, and a double-click takes the word.
   *
   * `row`/`col` are 0-indexed frame coordinates; SGR reports them 1-indexed
   * and the conversion happens here so no caller has to remember it.
   */
  /** `move` is hover — motion with no button held, reported only while `?1003h` is set (round eleven, item 1). `button` is 3 (the SGR "no button" code) for those. */
  | { type: "mouse"; action: "down" | "up" | "drag" | "move"; button: number; row: number; col: number; ctrl?: boolean; shift?: boolean }
  | { type: "unknown"; bytes: string };

interface KnownSequence {
  bytes: string;
  event: KeyEvent;
}

/** Longest-prefix-first so a modified arrow (`\x1b[1;5C`) is never shadowed by the plain one (`\x1b[C`) — they do not share a prefix here, but sorting keeps the property true if more entries are added. */
const KNOWN_SEQUENCES: KnownSequence[] = [
  { bytes: "\x1b[A", event: { type: "arrow", dir: "up" } },
  { bytes: "\x1bOA", event: { type: "arrow", dir: "up" } },
  { bytes: "\x1b[B", event: { type: "arrow", dir: "down" } },
  { bytes: "\x1bOB", event: { type: "arrow", dir: "down" } },
  { bytes: "\x1b[C", event: { type: "arrow", dir: "right" } },
  { bytes: "\x1bOC", event: { type: "arrow", dir: "right" } },
  { bytes: "\x1b[D", event: { type: "arrow", dir: "left" } },
  { bytes: "\x1bOD", event: { type: "arrow", dir: "left" } },
  { bytes: "\x1b[1;5A", event: { type: "arrow", dir: "up", ctrl: true } },
  { bytes: "\x1b[1;5B", event: { type: "arrow", dir: "down", ctrl: true } },
  { bytes: "\x1b[1;5C", event: { type: "arrow", dir: "right", ctrl: true } },
  { bytes: "\x1b[1;5D", event: { type: "arrow", dir: "left", ctrl: true } },
  // Alt+Left/Right are intentionally free editor gestures. T126 uses
  // Alt+Left as the browser back affordance.
  { bytes: "\x1b[1;3C", event: { type: "arrow", dir: "right", alt: true } },
  { bytes: "\x1b[1;3D", event: { type: "arrow", dir: "left", alt: true } },
  { bytes: "\x1b[1;2A", event: { type: "arrow", dir: "up", shift: true } },
  { bytes: "\x1b[1;2B", event: { type: "arrow", dir: "down", shift: true } },
  // Shift+arrow horizontally, and Ctrl+Shift+arrow — the two gestures that
  // select by character and by word (2026-09-02 UI feedback, item 8).
  // xterm's modifier encoding is 1 + (shift 1 | alt 2 | ctrl 4), so shift
  // is `;2`, ctrl is `;5` and ctrl+shift is `;6`.
  { bytes: "\x1b[1;2C", event: { type: "arrow", dir: "right", shift: true } },
  { bytes: "\x1b[1;2D", event: { type: "arrow", dir: "left", shift: true } },
  { bytes: "\x1b[1;6A", event: { type: "arrow", dir: "up", ctrl: true, shift: true } },
  { bytes: "\x1b[1;6B", event: { type: "arrow", dir: "down", ctrl: true, shift: true } },
  { bytes: "\x1b[1;6C", event: { type: "arrow", dir: "right", ctrl: true, shift: true } },
  { bytes: "\x1b[1;6D", event: { type: "arrow", dir: "left", ctrl: true, shift: true } },
  { bytes: "\x1b[H", event: { type: "home" } },
  { bytes: "\x1bOH", event: { type: "home" } },
  { bytes: "\x1b[1~", event: { type: "home" } },
  { bytes: "\x1b[1;2H", event: { type: "home", shift: true } },
  { bytes: "\x1b[1;5H", event: { type: "home", ctrl: true } },
  { bytes: "\x1b[F", event: { type: "end" } },
  { bytes: "\x1bOF", event: { type: "end" } },
  { bytes: "\x1b[4~", event: { type: "end" } },
  { bytes: "\x1b[1;2F", event: { type: "end", shift: true } },
  { bytes: "\x1b[1;5F", event: { type: "end", ctrl: true } },
  { bytes: "\x1b[3~", event: { type: "delete" } },
  { bytes: "\x1b[3;5~", event: { type: "delete", ctrl: true } },
  { bytes: "\x1b[5~", event: { type: "pageUp" } },
  { bytes: "\x1b[6~", event: { type: "pageDown" } },
  { bytes: "\x1b[Z", event: { type: "tab", shift: true } },
  // Ctrl+Backspace as reported by a terminal speaking one of the two
  // disambiguating protocols (item 7). The bare `\x08` byte most consoles
  // send for it is handled further down, in tryConsumeOne().
  { bytes: "\x1b[127;5u", event: { type: "backspace", ctrl: true } },
  { bytes: "\x1b[8;5u", event: { type: "backspace", ctrl: true } },
  { bytes: "\x1b[27;5;127~", event: { type: "backspace", ctrl: true } },
  { bytes: "\x1b[27;5;8~", event: { type: "backspace", ctrl: true } },
  // Ctrl+Shift+Z — redo, where the terminal can tell it apart from Ctrl+Z.
  // Ctrl+Y is the binding that works everywhere else.
  { bytes: "\x1b[122;6u", event: { type: "ctrl", key: "z", shift: true } },
  { bytes: "\x1b[90;6u", event: { type: "ctrl", key: "z", shift: true } },
  { bytes: "\x1b[27;6;122~", event: { type: "ctrl", key: "z", shift: true } },
  // T46.2 named "many terminals send a bare CR for Shift+Enter,
  // indistinguishable from plain Enter" as the reason Shift+Enter stayed
  // unsupported. That is still true of a terminal in its default mode —
  // but a terminal with the Kitty keyboard protocol's disambiguate flag
  // on (`terminal.ts`'s `ENTER_SEQUENCES.kittyKeyboard`, opt-in and
  // silently ignored by terminals that don't understand it) reports
  // Shift+Enter as `CSI 13 ; 2 u`; xterm's older `modifyOtherKeys` mode
  // reports the same keypress as `CSI 27 ; 2 ; 13 ~`. Recognising both
  // costs nothing on a terminal that never sends them — these bytes never
  // arrive from one that doesn't support either protocol.
  { bytes: "\x1b[13;2u", event: { type: "enter", shift: true } },
  { bytes: "\x1b[27;2;13~", event: { type: "enter", shift: true } },
  { bytes: "\x1b[13;3u", event: { type: "enter", alt: true } },
  { bytes: "\x1b[27;3;13~", event: { type: "enter", alt: true } },
  // Ctrl+Enter, asked for by name in the 2026-09-02 report alongside
  // Shift+Enter. Same two protocols, modifier 5.
  { bytes: "\x1b[13;5u", event: { type: "enter", ctrl: true } },
  { bytes: "\x1b[27;5;13~", event: { type: "enter", ctrl: true } },
];
KNOWN_SEQUENCES.sort((a, b) => b.bytes.length - a.bytes.length);

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Bracketed paste mode's enable/disable sequences — T46.1's own requirement, exported so a caller wires them at raw-mode entry/exit. */
export const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";
export const BRACKETED_PASTE_DISABLE = "\x1b[?2004l";
/**
 * Paste detection (2026-09-02 round eleven item 3, round twelve item 3,
 * and round fourteen: "pasting multiple lines text to prompt chat box
 * still have lots of errors ... this error has been here for so long").
 *
 * Bracketed paste — decoded above, enabled by `terminal.ts` since round
 * eight — is the protocol answer to "which newlines are text", and on a
 * Unix terminal it is the whole answer. It is NOT the answer on the
 * maintainer's machine: `ENTER_SEQUENCES.win32Input` asks Windows
 * consoles for win32-input-mode (`CSI ? 9001 h`), and a console in that
 * mode reports EVERY input — pasted text included — as a stream of
 * `CSI Vk;Sc;Uc;Kd;Cs;Rc _` key records with no `\x1b[200~` marker
 * anywhere in it. A pasted \r arrives as `VK_RETURN`, indistinguishable
 * from a real keypress, so the first line of the paste submitted and the
 * rest landed in the next prompt.
 *
 * What separates a pasted newline from a pressed one is not the encoding:
 * it is POSITION. Typing puts Enter at the END of what arrives — the
 * keypress is the last thing in its read, because the user is waiting for
 * the result. A paste puts text AFTER the newline. So a run of printable
 * characters, Tabs and bare Enters is folded into a single `paste` event
 * exactly when one of its Enters or Tabs has something following it.
 *
 * That rule is deliberately not a rate threshold, because a rate
 * threshold gets the SSH case wrong: a slow link batches a typed line and
 * its Enter into one read, which is byte-for-byte what a small paste
 * looks like, and treating it as one would mean a prompt that can never
 * be sent. Position survives batching — the typed Enter is still last.
 *
 * **Rounds eleven and twelve resolved the leftover ambiguity with a 30 ms
 * clock, and the clock is what was still broken.** A paste large enough
 * to be split across reads can be cut anywhere, including between a
 * line's text and its newline — leaving a chunk that is nothing but `\r`,
 * whose position says "typed". The clock covered that only while the next
 * read arrived within 30 ms of the last one, and the next read arrives
 * after this process has repainted the whole screen for the chunk before
 * it, which on a paste worth the name is routinely slower than that. One
 * late chunk and the paste submitted itself half-finished, which is
 * exactly the report.
 *
 * So the clock is gone. A bare Enter that ENDS a read is not decided when
 * it arrives: it is HELD (`held`), the same way an ambiguous lone ESC is
 * already held, and resolved by what happens next —
 *
 *  - more text arrives → it was pasted, and it rejoins the run as a
 *    newline;
 *  - `flush()` runs (the caller's idle gap, `DEFAULT_IDLE_FLUSH_MS`) →
 *    nothing followed it, so it was a keypress, and it submits.
 *
 * No timing assumption is left to violate, and — round fourteen's second
 * pass — no assumption about read SIZE either. The first pass held an
 * Enter only after a read too big to have been typed, on the theory that a
 * real read is thousands of bytes. A fuzz over every chunk size and every
 * idle-flush placement said otherwise: at small read sizes the first
 * newline of a paste arrives before that evidence exists, and each line
 * submits as its own prompt, leaving the composer holding the last one.
 * So every trailing Enter is held now. The cost is that a typed Enter
 * submits one idle gap later — 50 ms, imperceptible — and that a caller
 * driving `KeyDecoder` must call `flush()` for an Enter to mean submit at
 * all, which `routeStdin()` has always done on a timer.
 *
 * `pasteInProgress` carries the verdict across reads for the one case
 * holding cannot see — the paste whose LAST read is a bare newline — and
 * is cleared by the same `flush()` that ends the paste.
 *
 * A modified Enter (Shift/Ctrl/Alt, round eight's own feature) is never
 * part of a run at all, so the gesture that inserts a newline on purpose
 * is untouched by any of this.
 */

/** Longest known escape sequence, plus a little slack — past this, an unrecognised ESC-prefixed run is surfaced rather than buffered forever. */
const MAX_ESCAPE_WAIT = 16;

/**
 * SGR extended mouse reporting (`\x1b[?1006h`, set alongside `\x1b[?1000h` by
 * `terminal.ts`'s `ENTER_SEQUENCES.mouse`): `CSI < Cb ; Cx ; Cy M` (or a
 * trailing `m` on release — wheel notches are only ever reported as `M`).
 * `Cb`'s bit 6 (64) marks a wheel event; bit 5 (32) marks motion; bit 0
 * then picks the wheel direction — this is the X10/SGR encoding, not a
 * Lykos invention. Coordinates are ignored for a wheel notch (a
 * single-pane app has no second scroll target to disambiguate) and carried
 * through for a click or drag, which is exactly what needs them.
 */
/**
 * win32-input-mode (`terminal.ts`'s `ENTER_SEQUENCES.win32Input`), the one
 * protocol Windows Terminal and conhost actually implement:
 * `CSI Vk ; Sc ; Uc ; Kd ; Cs ; Rc _`. Every field may be empty, meaning
 * zero. This is what finally makes Shift+Enter and Ctrl+Enter reportable on
 * the maintainer's own machine — see that sequence's own doc for why
 * neither Kitty's protocol nor `modifyOtherKeys` could.
 */
const WIN32_INPUT = /^\x1b\[(\d*);(\d*);(\d*);(\d*);(\d*);(\d*)_/;
/** The same record, unanchored and global — for finding them INSIDE a bracketed paste's payload. See `decodePasteBody`. */
const WIN32_INPUT_G = /\x1b\[(\d*);(\d*);(\d*);(\d*);(\d*);(\d*)_/g;
/** Six semicolon-separated fields plus the introducer — comfortably past this and it is not a win32 record. */
const MAX_WIN32_WAIT = 40;

/** Windows `ControlKeyState` bits, from the console API. Left/right variants are folded together: nothing here cares which Ctrl was pressed. */
const WIN32_RIGHT_ALT = 0x0001;
const WIN32_LEFT_ALT = 0x0002;
const WIN32_RIGHT_CTRL = 0x0004;
const WIN32_LEFT_CTRL = 0x0008;
const WIN32_SHIFT = 0x0010;

/** Virtual-key codes for the keys that need one; anything else is decoded from its `Uc` character. */
const VK_BACK = 8;
const VK_TAB = 9;
const VK_RETURN = 13;
const VK_ESCAPE = 27;
const VK_PRIOR = 33;
const VK_NEXT = 34;
const VK_END = 35;
const VK_HOME = 36;
const VK_LEFT = 37;
const VK_UP = 38;
const VK_RIGHT = 39;
const VK_DOWN = 40;
const VK_DELETE = 46;

const SGR_MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)[Mm]/;
/** A little longer than MAX_ESCAPE_WAIT — three semicolon-delimited coordinates can run past 16 bytes on a large terminal. */
const MAX_MOUSE_WAIT = 24;

/**
 * One win32-input-mode record to a `KeyEvent`, or null for a record that
 * carries no key at all.
 *
 * Key-UP records are dropped: the console reports both edges, and an
 * editor that acted on releases would apply every keystroke twice. A
 * modifier pressed on its own (`Uc` 0 with no mapped virtual key) is also
 * nothing on its own — the modifier arrives again in `Cs` on the record for
 * the key it modifies, which is the only place it matters.
 */
export function decodeWin32Record(vk: number, uc: number, keyDown: boolean, controlKeys: number): KeyEvent | null {
  if (!keyDown) return null;
  const shift = (controlKeys & WIN32_SHIFT) !== 0;
  const ctrl = (controlKeys & (WIN32_LEFT_CTRL | WIN32_RIGHT_CTRL)) !== 0;
  const alt = (controlKeys & (WIN32_LEFT_ALT | WIN32_RIGHT_ALT)) !== 0;

  switch (vk) {
    case VK_RETURN:
      // The whole point of the protocol, for Lykos's purposes.
      return { type: "enter", ...(alt ? { alt: true } : {}), ...(shift ? { shift: true } : {}), ...(ctrl ? { ctrl: true } : {}) };
    case VK_BACK:
      return { type: "backspace", ...(ctrl ? { ctrl: true } : {}) };
    case VK_TAB:
      return { type: "tab", ...(shift ? { shift: true } : {}) };
    case VK_ESCAPE:
      return { type: "escape" };
    case VK_LEFT:
      return { type: "arrow", dir: "left", ...(ctrl ? { ctrl: true } : {}), ...(shift ? { shift: true } : {}), ...(alt ? { alt: true } : {}) };
    case VK_RIGHT:
      return { type: "arrow", dir: "right", ...(ctrl ? { ctrl: true } : {}), ...(shift ? { shift: true } : {}), ...(alt ? { alt: true } : {}) };
    case VK_UP:
      return { type: "arrow", dir: "up", ...(ctrl ? { ctrl: true } : {}), ...(shift ? { shift: true } : {}) };
    case VK_DOWN:
      return { type: "arrow", dir: "down", ...(ctrl ? { ctrl: true } : {}), ...(shift ? { shift: true } : {}) };
    case VK_HOME:
      return { type: "home", ...(ctrl ? { ctrl: true } : {}), ...(shift ? { shift: true } : {}) };
    case VK_END:
      return { type: "end", ...(ctrl ? { ctrl: true } : {}), ...(shift ? { shift: true } : {}) };
    case VK_DELETE:
      return { type: "delete", ...(ctrl ? { ctrl: true } : {}) };
    case VK_PRIOR:
      return { type: "pageUp" };
    case VK_NEXT:
      return { type: "pageDown" };
    default:
      break;
  }
  if (uc === 0) return null;
  // A record whose VIRTUAL KEY is 0 but whose `Uc` is a control character
  // is a SYNTHESIZED keystroke, not a pressed key — which is exactly what
  // a Windows console produces for pasted text: one record per pasted
  // character, `Vk` 0 because no physical key produced it. The switch
  // above only recognises a carriage return by `VK_RETURN`, so a pasted
  // newline arriving this way fell through to `uc < 32` and was DROPPED
  // ENTIRELY — every line of the paste ran into the one before it with no
  // break at all. That is 2026-09-02 round twelve, item 3, and it is a
  // different bug from round eleven's (which was about a pasted newline
  // being obeyed as Enter, not about it vanishing); both had to be wrong
  // for paste on this platform to be as broken as it was.
  if (uc === 13 || uc === 10) {
    return { type: "enter", ...(alt ? { alt: true } : {}), ...(shift ? { shift: true } : {}), ...(ctrl ? { ctrl: true } : {}) };
  }
  if (uc === 9) return { type: "tab", ...(shift ? { shift: true } : {}) };
  // A Ctrl-modified letter arrives as its control code in `Uc` (Ctrl-A is
  // 1), the same byte a non-win32 terminal would have sent — decode it the
  // same way so `handleCtrl` sees one shape whichever protocol is active.
  if (uc >= 1 && uc <= 26 && ctrl) {
    return { type: "ctrl", key: String.fromCharCode(96 + uc), ...(shift ? { shift: true } : {}) };
  }
  if (uc < 32) return null;
  return { type: "char", value: String.fromCodePoint(uc) };
}

/**
 * **The actual cause of six rounds of the paste bug**, found on 2026-09-02
 * by capturing what the maintainer's terminal really sends
 * (`LYKOS_INPUT_LOG`) instead of reasoning about it a seventh time. The
 * bytes for pasting six lines were:
 *
 * ```text
 * \e[200~and\e[13;28;13;1;0;1_\e[13;28;13;0;0;1_or\e[13;28;13;1;0;1_…hello\e[201~
 * ```
 *
 * Windows Terminal **does** send bracketed paste — every round since the
 * eleventh has assumed it does not, because win32-input-mode is on — and
 * inside the markers it sends the printable text PLAIN while encoding each
 * line break as a win32-input-mode key record: `VK_RETURN` down, then its
 * key-up. Nobody had considered a payload that mixes the two, so the
 * bracketed branch took the whole span as literal text. Those record bytes
 * then reached the composer, which is what "random characters" was; once
 * round fourteen's sanitiser started stripping escape sequences out of
 * pasted text they stopped being visible and started being DELETED — and
 * with them every line break, which is exactly "they just end up in one
 * single line".
 *
 * So a bracketed paste's payload is decoded rather than taken literally:
 * every win32 record inside it becomes the text it stands for (a newline,
 * a tab, a character), a key-up record becomes nothing, and everything
 * else passes through untouched for `sanitizePastedText()` to deal with.
 * A surrogate pair split across two records needs no special handling
 * here — the two halves land next to each other in the string and are the
 * character they encode.
 */
export function decodePasteBody(raw: string): string {
  if (!raw.includes("\x1b")) return raw;
  WIN32_INPUT_G.lastIndex = 0;
  return raw.replace(WIN32_INPUT_G, (_match, vk: string, _sc: string, uc: string, kd: string, cs: string, rc: string) => {
    const num = (s: string | undefined): number => (s === undefined || s === "" ? 0 : Number(s));
    const event = decodeWin32Record(num(vk), num(uc), num(kd) !== 0, num(cs));
    if (!event) return ""; // a key-up, or a modifier on its own: no text
    const text = event.type === "enter" ? "\n" : event.type === "tab" ? "\t" : event.type === "char" ? event.value : "";
    return text.repeat(Math.min(Math.max(num(rc), 1), 1024));
  });
}

export interface FeedOptions {
  /**
   * This read arrived back-to-back with the one before it — measured from
   * the moment the previous `feed()` RETURNED, so the caller's own
   * rendering time is excluded rather than mistaken for a pause. Nothing a
   * hand can do produces two reads that close together; a paste being
   * delivered does it every time. Only the caller that owns the stream can
   * know this, which is why it is a parameter and not a clock in here.
   */
  contiguous?: boolean;
}

export class KeyDecoder {
  private buf = "";
  /**
   * A bare Enter or Tab that a read ENDED on, whose meaning the next thing
   * to arrive decides — see the paste-detection note above. Both keys mean
   * something when pressed (submit, complete) and are ordinary text when
   * pasted, and a read boundary can fall on either.
   */
  private held: KeyEvent | null = null;
  /** True from the first folded paste run until the idle `flush()` that ends it: a bare newline arriving inside that window is text, not a keypress. */
  private pasteInProgress = false;
  /**
   * Set by the caller when a read arrived back-to-back with the one
   * before it — see `FeedOptions.contiguous`. The decoder cannot measure
   * this itself: it would have to time its own caller's rendering, and
   * that is exactly the mistake the 30 ms window made.
   */
  private inBurst = false;
  /** Has this session ever decoded a win32-input-mode record? See `isStillArriving` — it changes what a lone ESC can mean. */
  private sawWin32Record = false;
  /**
   * A UTF-16 high surrogate waiting for its partner. win32-input-mode's
   * `Uc` field carries one CODE UNIT, so a pasted emoji — or any astral
   * character — arrives as two records, and decoding each on its own
   * produced two LONE surrogates: a pair of replacement glyphs in the
   * composer and a pair of broken bytes in whatever the model was then
   * sent. That is part of the "random characters appear in the text"
   * report, and it cannot happen on any other protocol, because no other
   * protocol splits a code point across two events.
   */
  private highSurrogate: string | null = null;

  /** Feed one chunk of raw input; returns every complete key event it produced. Incomplete trailing bytes stay buffered for the next feed() or flush(). */
  feed(chunk: string, opts: FeedOptions = {}): KeyEvent[] {
    // Assigned, never accumulated: what matters is whether THIS read came
    // in back-to-back, because this is the read whose trailing Enter may
    // have to be judged. A single fast pair of reads earlier in the
    // session must not still be vouching for a keypress a minute later.
    this.inBurst = opts.contiguous === true;
    this.buf += chunk;
    const events: KeyEvent[] = [];
    for (;;) {
      const consumed = this.tryConsumeOne();
      if (!consumed) break;
      // A consumed span with no event is a real outcome, not a failure:
      // win32-input-mode reports both edges of every keystroke, and a
      // key-UP record carries no key. See `tryConsumeOne`'s win32 branch.
      //
      // `repeat` is that protocol's `Rc` field: one record can stand for
      // several identical keystrokes. Ignoring it silently DELETED
      // characters from the middle of a paste wherever the console chose
      // to coalesce a repeated one — runs of spaces, which is to say
      // indentation, most of all.
      if (consumed.event) {
        for (let i = 0; i < (consumed.repeat ?? 1); i++) events.push(consumed.event);
      }
      this.buf = this.buf.slice(consumed.length);
    }
    return this.classify(this.joinSurrogates(events));
  }

  /** Adjacent high/low surrogate `char` events rejoined into the one character they encode; a pair split across two chunks is carried in `highSurrogate`. */
  private joinSurrogates(events: KeyEvent[]): KeyEvent[] {
    const isHigh = (ev: KeyEvent): boolean =>
      ev.type === "char" && ev.value.length === 1 && ev.value.charCodeAt(0) >= 0xd800 && ev.value.charCodeAt(0) <= 0xdbff;
    const isLow = (ev: KeyEvent): boolean =>
      ev.type === "char" && ev.value.length === 1 && ev.value.charCodeAt(0) >= 0xdc00 && ev.value.charCodeAt(0) <= 0xdfff;
    if (this.highSurrogate === null && !events.some(isHigh)) return events;

    const out: KeyEvent[] = [];
    for (const ev of events) {
      if (this.highSurrogate !== null) {
        const high = this.highSurrogate;
        this.highSurrogate = null;
        if (isLow(ev)) {
          out.push({ type: "char", value: high + (ev as { type: "char"; value: string }).value });
          continue;
        }
        // A high surrogate with no partner is not a character at all.
        // Dropping it is the only honest option: emitting it would paint a
        // replacement glyph and send a broken code unit to the model.
      }
      if (isHigh(ev)) {
        this.highSurrogate = (ev as { type: "char"; value: string }).value;
        continue;
      }
      out.push(ev);
    }
    return out;
  }

  /**
   * One chunk's events, with any pasted run folded into a single `paste`
   * event and any ambiguous trailing Enter held — see the paste-detection
   * note above for why bracketed paste does not cover the case and why
   * this no longer consults a clock.
   */
  private classify(events: KeyEvent[]): KeyEvent[] {
    const out: KeyEvent[] = [];

    /** Text a paste can be made of. A modified Enter is deliberately excluded — that gesture inserts a newline on purpose and must survive intact. */
    const isRunMember = (ev: KeyEvent): boolean =>
      ev.type === "char" || ev.type === "tab" || (ev.type === "enter" && !ev.alt && !ev.shift && !ev.ctrl);
    /** The two run members that MEAN something when typed, and are therefore the ones position has to adjudicate. */
    const isAmbiguous = (ev: KeyEvent): boolean => ev.type === "enter" || ev.type === "tab";
    const asText = (ev: KeyEvent): string => (ev.type === "char" ? ev.value : ev.type === "tab" ? "\t" : "\n");

    let incoming = events;
    if (this.held !== null) {
      // Nothing at all arrived in this chunk (a lone key-up record, say):
      // that is not evidence either way, so keep holding.
      if (incoming.length === 0) return out;
      if (isRunMember(incoming[0]!)) {
        // Something followed the held Enter, which is the definition of a
        // pasted newline. It rejoins the run, where its position — first,
        // with text after it — classifies the whole run as a paste.
        incoming = [this.held, ...incoming];
      } else {
        // A key that is not text followed it: an arrow, a mouse report.
        // Nobody pastes those, so the Enter was pressed.
        out.push(this.held);
      }
      this.held = null;
    }
    if (incoming.length === 0) return out;

    let run: KeyEvent[] = [];
    const closeRun = (isFinal: boolean): void => {
      if (run.length === 0) return;
      const firstAmbiguous = run.findIndex(isAmbiguous);
      let pasted = this.pasteInProgress || (firstAmbiguous !== -1 && firstAmbiguous < run.length - 1);
      if (!pasted && isFinal && isAmbiguous(run[run.length - 1]!)) {
        // The genuinely undecidable events in the stream: an Enter or a Tab
        // that a read ENDS on. Hold it. Tab is here for the same reason
        // Enter is — a read boundary can fall on a pasted tab, and the
        // "pressed" reading of one is to open the completer, which is how
        // a pasted tab used to vanish from the middle of an indented line.
        this.held = run[run.length - 1]!;
        run = run.slice(0, -1);
        if (run.length === 0) return;
        // A run that was ambiguous only BECAUSE of that key is now plain
        // text — but it is still mid-paste if anything else said so.
        pasted = this.pasteInProgress;
      }
      if (pasted) {
        this.pasteInProgress = true;
        out.push({ type: "paste", text: run.map(asText).join("") });
      } else {
        out.push(...run);
      }
      run = [];
    };

    for (const ev of incoming) {
      if (isRunMember(ev)) {
        run.push(ev);
        continue;
      }
      closeRun(false);
      out.push(ev);
    }
    closeRun(true);
    return out;
  }

  /**
   * Nothing more is coming right now (an idle gap after the last feed()) —
   * resolve whatever is left rather than hold it hostage. This is what
   * turns a held Enter back into a keypress, and it is the ONLY thing that
   * ends a paste.
   *
   * **Unless the gap fell inside a burst.** A terminal can stall mid-paste
   * for longer than the caller's idle timer, and this used to resolve the
   * stall by submitting: the held Enter became a keypress, the prompt went
   * with only the lines so far, and the rest of the paste landed in the
   * next one. `inBurst` — set by the caller when a read arrived
   * back-to-back with the one before it, which no human hand can produce —
   * says the silence is a stall rather than a person stopping, so a held
   * Enter resolves as the pasted newline it is and a half-decoded escape
   * sequence is kept rather than destroyed.
   */
  flush(): KeyEvent[] {
    const out: KeyEvent[] = [];
    const mid = this.pasteInProgress || this.inBurst;
    if (this.held !== null) {
      out.push(mid ? { type: "paste", text: "\n" } : this.held);
      this.held = null;
    }
    this.pasteInProgress = false;
    // `highSurrogate` deliberately survives: half a code point is a
    // partial character, not a failed one, and an idle gap can fall
    // between the two records that carry it exactly as it can fall inside
    // an escape sequence. Dropping it here turned a pasted emoji into one
    // replacement glyph whenever the paste stalled in the middle of it.
    if (this.buf.length === 0) {
      this.inBurst = false;
      return out;
    }
    // A `\r` that `tryConsumeOne` held back waiting for a possible `\n`
    // (the split-CRLF case). This is the one place it can be resolved, and
    // it resolves the same way any other trailing Enter does.
    if (this.buf === "\r") {
      this.buf = "";
      out.push(mid ? { type: "paste", text: "\n" } : { type: "enter" });
      this.inBurst = false;
      return out;
    }
    if (mid) return out;
    this.inBurst = false;
    // Bytes that are still ARRIVING are not an unknown sequence. A
    // bracketed paste big enough to straddle an idle gap used to be
    // surfaced here as `unknown` and then dropped by the caller's default
    // case — the paste simply vanished. Keep waiting instead; the only
    // thing lost is that a truly stuck partial sequence stays buffered
    // until the next key resolves or replaces it.
    if (this.isStillArriving(this.buf)) return out;
    const bytes = this.buf;
    this.buf = "";
    if (bytes === "\x1b") out.push({ type: "escape" });
    else out.push({ type: "unknown", bytes });
    return out;
  }

  /**
   * A sequence that is still ARRIVING rather than one that failed to
   * decode. Both a bracketed paste and a win32-input-mode record can span
   * an idle gap, and destroying one at the gap is not a harmless loss:
   * `flush()` used to emit `\x1b[` as `unknown` (dropped by the caller)
   * and then decode `0;0;13;1;0;1_` — the REST of that record — as literal
   * characters. That is a pasted line break deleted and a line of digits
   * typed into the composer in its place, which is both halves of the
   * paste report at once, and it needs only a read boundary to land inside
   * a record and the next read to be a moment late.
   *
   * A bare ESC deliberately does not qualify — resolving that is what
   * `flush()` is for — but `\x1b[` with nothing after it does: no key
   * produces those two bytes alone, so they are always the front of
   * something longer.
   */
  private isStillArriving(buf: string): boolean {
    // Once this session has decoded a single win32-input-mode record, a
    // lone ESC can no longer be the Escape KEY: in that mode the Escape key
    // arrives as `CSI 27;…;27;1;0;1_` like everything else, so a trailing
    // `\x1b` is always the front of a record whose remaining bytes have not
    // arrived yet. Resolving it as an Escape keypress cleared the buffer,
    // and the rest of that record — `0;0;13;1;0;1_` — then decoded as
    // literal characters: a deleted line break and a line of digits in its
    // place, from nothing worse than a read boundary landing on an ESC.
    if (this.sawWin32Record && buf === "\x1b") return true;
    if (buf.startsWith(PASTE_START)) return true;
    if (buf.length >= 2 && PASTE_START.startsWith(buf)) return true;
    // A CSI introducer plus only parameter bytes: no final byte has
    // arrived, so this cannot be a complete sequence yet. `\x1bO` (SS3) and
    // `\x1b[<` (SGR mouse) are the other two introducers that are always
    // followed by more.
    if (/^\x1b\[[\d;<?]*$/.test(buf)) return true;
    return buf === "\x1bO";
  }

  get pending(): string {
    return this.buf;
  }

  private tryConsumeOne(): { event: KeyEvent | null; length: number; repeat?: number } | null {
    const buf = this.buf;
    if (buf.length === 0) return null;

    if (PASTE_START.startsWith(buf) && buf.length < PASTE_START.length) return null; // waiting for the rest of the paste-start marker
    if (buf.startsWith(PASTE_START)) {
      const end = buf.indexOf(PASTE_END, PASTE_START.length);
      if (end === -1) return buf.length > 1_000_000 ? { event: { type: "unknown", bytes: buf }, length: buf.length } : null;
      // Decoded, not taken literally: the payload can carry win32-input-mode
      // records among its plain text, and on Windows Terminal that is where
      // every line break lives. See `decodePasteBody`.
      return { event: { type: "paste", text: decodePasteBody(buf.slice(PASTE_START.length, end)) }, length: end + PASTE_END.length };
    }

    if (buf[0] === "\x1b") {
      if (buf.startsWith("\x1b[<")) {
        const m = SGR_MOUSE.exec(buf);
        if (m) {
          const cb = Number(m[1]);
          // xterm mouse-protocol modifier bits, added onto Cb regardless
          // of button/wheel encoding: shift=4, meta/alt=8, ctrl=16.
          const shift = (cb & 4) !== 0;
          const ctrl = (cb & 16) !== 0;
          if ((cb & 64) !== 0) {
            return { event: { type: "wheel", dir: (cb & 1) === 1 ? "down" : "up", ...(ctrl ? { ctrl: true } : {}) }, length: m[0].length };
          }
          // Bit 5 (32) marks a motion report, which only arrives at all
          // when `?1002h` is set; the terminating byte says press (`M`)
          // versus release (`m`).
          const motion = (cb & 32) !== 0;
          const released = m[0].endsWith("m");
          // Button bits 0b11 mean "no button" in the SGR encoding, so
          // motion carrying them is the pointer moving on its own — hover,
          // not a drag. Only reported at all once `?1003h` is set, which
          // `terminal.ts` began doing in round eleven for the hover
          // highlight; before that this branch could only ever see a drag.
          const hovering = motion && (cb & 3) === 3;
          const action = hovering ? "move" : motion ? "drag" : released ? "up" : "down";
          return {
            event: {
              type: "mouse",
              action,
              button: cb & 3,
              col: Math.max(0, Number(m[2]) - 1),
              row: Math.max(0, Number(m[3]) - 1),
              ...(ctrl ? { ctrl: true } : {}),
              ...(shift ? { shift: true } : {}),
            },
            length: m[0].length,
          };
        }
        if (buf.length < MAX_MOUSE_WAIT) return null;
      }
      // win32-input-mode records are checked BEFORE the known-sequence
      // table: `CSI 13;2;13;1;16;1_` shares its opening bytes with nothing
      // in that table, but a partial one must be waited for rather than
      // half-matched against a shorter entry.
      const win32 = WIN32_INPUT.exec(buf);
      if (win32) {
        const num = (s: string | undefined) => (s === undefined || s === "" ? 0 : Number(s));
        const event = decodeWin32Record(num(win32[1]), num(win32[3]), num(win32[4]) !== 0, num(win32[5]));
        // A record that decodes to nothing (a key-up, a lone modifier) is
        // still CONSUMED — leaking its bytes into the composer as stray
        // characters is precisely what this branch exists to prevent — but
        // it produces NO event, rather than an `unknown` one.
        //
        // 2026-09-02 UI feedback item 3, "wherever i move the pointer, it
        // always point back to position 1": every keystroke on Windows
        // arrives as a down record AND an up record. The up record used to
        // surface as `unknown`, which fell through `RawLineSource`'s switch
        // to its default case and then ran `refreshCompletion()` — and that
        // function resets the highlighted candidate to the top match by
        // design. So every Up/Down that moved the selection was immediately
        // followed by its own key-up putting it back on the first row.
        // `Rc` — how many identical keystrokes this one record stands for.
        // Zero and empty both mean one; the cap is there so a malformed
        // record cannot wedge the process building an unbounded array.
        this.sawWin32Record = true;
        const repeat = Math.min(Math.max(num(win32[6]), 1), 1024);
        return { event, length: win32[0].length, repeat };
      }
      if (/^\x1b\[[\d;]*$/.test(buf) && buf.length < MAX_WIN32_WAIT) return null;

      for (const known of KNOWN_SEQUENCES) {
        if (buf.startsWith(known.bytes)) return { event: known.event, length: known.bytes.length };
      }
      // Could this still become a known sequence with more bytes? Wait rather than guess.
      const isPrefixOfKnown = KNOWN_SEQUENCES.some((k) => k.bytes.startsWith(buf));
      if (isPrefixOfKnown && buf.length < MAX_ESCAPE_WAIT) return null;

      // Alt+<key>: ESC immediately followed by exactly one non-CSI/SS3-introducer byte.
      // Ambiguous with a bare Escape keypress followed by fast unrelated typing — most
      // terminals send Alt+key as one atomic write with no gap, which is what this
      // relies on; ESC-then-later-typing arrives as separate feed() calls and is
      // decoded as two independent events instead. (Same class of ambiguity T46.2
      // documents for Shift+Enter — verify on the real host before promising it.)
      if (buf.length >= 2 && buf[1] !== "[" && buf[1] !== "O") {
        const rest = buf[1]!;
        if (rest === "\r" || rest === "\n") return { event: { type: "enter", alt: true }, length: 2 };
        return { event: { type: "char", value: rest }, length: 2 };
      }
      // A CSI/SS3 intro that never resolved into anything recognised — surface the
      // ESC alone so the rest gets a chance to decode as its own key(s) next pass.
      return { event: { type: "escape" }, length: 1 };
    }

    // CRLF is ONE Enter, not two. Nobody's keyboard sends both bytes for
    // one keypress — a CRLF pair only ever arrives from pasted text that
    // was authored on Windows, and decoding it as two enters turned every
    // pasted line break into a blank line (2026-09-02 round eleven, item
    // 3). A trailing lone `\r` — the whole buffer, nothing after it — now
    // WAITS for its possible `\n` rather than deciding immediately, which
    // is what a read boundary falling between the two bytes needs. That
    // used to cost a keypress-latency argument ("Enter must never lag a
    // keypress behind"); it costs nothing now, because a trailing Enter is
    // held for the idle gap regardless. `flush()` resolves a stranded `\r`,
    // so it can never be stuck.
    if (buf === "\r") return null;
    if (buf.startsWith("\r\n")) return { event: { type: "enter" }, length: 2 };
    if (buf[0] === "\r" || buf[0] === "\n") return { event: { type: "enter" }, length: 1 };
    // The convention every terminal follows: plain Backspace sends DEL
    // (0x7f), Ctrl+Backspace sends BS (0x08). Windows Terminal, iTerm2,
    // GNOME Terminal and xterm all do this, which is why item 7's
    // "Ctrl+Backspace deletes a connected component of characters" needs
    // no protocol negotiation on most hosts — only the mapping below.
    // The cost is that Ctrl-H, historically an alias for Backspace, now
    // deletes a word instead of a character; that is the same trade every
    // editor with this binding makes, and Backspace itself is unaffected.
    if (buf[0] === "\x7f") return { event: { type: "backspace" }, length: 1 };
    if (buf[0] === "\x08") return { event: { type: "backspace", ctrl: true }, length: 1 };
    if (buf[0] === "\t") return { event: { type: "tab" }, length: 1 };

    const code = buf.codePointAt(0)!;
    if (code >= 1 && code <= 26 && code !== 9 && code !== 13) {
      return { event: { type: "ctrl", key: String.fromCharCode(96 + code) }, length: 1 };
    }
    const ch = String.fromCodePoint(code);
    return { event: { type: "char", value: ch }, length: ch.length };
  }
}
