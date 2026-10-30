// The line editor.
//
// `createReadlineLineSource()` (session/interactive.ts) is configured
// `terminal: false`, which is why there is no prompt marker, no history,
// and no line editing today — Node's `readline` line-editing only exists
// in terminal mode, and terminal mode fights the alternate buffer for
// control of the screen. This is the module that replaces it: a small,
// dependency-free multi-line buffer with cursor movement by character and
// word, standard kill bindings, and no rendering of its own — the
// composer region (T42) draws whatever `LineEditor.state` currently says.
//
// Multi-line: a trailing `\` continuation stays supported by the existing
// `parseInteractiveInput()` protocol untouched, and this editor adds a
// REAL multi-line mode on top — Enter submits, Shift+Enter or Alt+Enter
// (or the literal `\` at end of line) inserts a newline. T46.2 originally
// refused to promise Shift+Enter at all, because a terminal in its default
// mode sends a bare CR for it; `input.ts` now recognises the two protocols
// (Kitty's `CSI 13;2u`, xterm's modifyOtherKeys `CSI 27;2;13~`) that DO
// report it distinguishably, and `terminal.ts` asks for both on entry, so
// the promise is conditional on the terminal rather than absent.
//
// 2026-09-02 UI feedback, item 8 (copy, paste, word selection, drag select,
// undo and redo, as a normal editor has) added three things this file did not have:
//
//  - **A selection.** An anchor plus the cursor. Every movement method
//    takes an `extend` flag: true starts (or grows) the selection, false
//    drops it. Typing, pasting, Backspace and Delete all replace a live
//    selection rather than ignoring it, which is the behaviour that makes
//    a selection feel real rather than decorative.
//  - **Undo/redo.** A bounded stack of whole-buffer snapshots. Snapshots
//    are cheap here (a prompt is tens of lines, not a file), so the
//    complexity of an operation log buys nothing. Consecutive typing
//    coalesces into one undo step up to a word boundary, so Ctrl-Z takes
//    back a word rather than a letter — the thing that makes undo usable.
//  - **A cut/copy register.** The editor owns the text; who puts it on the
//    system clipboard is the caller's problem (`tui/clipboard.ts`), because
//    that involves the terminal and this file involves nothing.

export interface Pos {
  row: number;
  col: number;
}

export interface Selection {
  /** Always the earlier of the two ends, in document order. */
  start: Pos;
  end: Pos;
}

export interface EditorState {
  lines: readonly string[];
  cursorRow: number;
  cursorCol: number;
  /** Null when nothing is selected. Normalised: `start` never comes after `end`. */
  selection: Selection | null;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /\w/.test(ch);
}

function comparePos(a: Pos, b: Pos): number {
  return a.row !== b.row ? a.row - b.row : a.col - b.col;
}

interface Snapshot {
  lines: string[];
  row: number;
  col: number;
}

/** Whole-buffer snapshots, so this caps undo steps, not bytes. 200 is far past what anyone Ctrl-Zs through in one prompt. */
const MAX_UNDO = 200;

/** How many columns a pasted tab becomes. Four, because that is what the composer's own continuation indent uses and what most pasted source is written against. */
const PASTE_TAB_WIDTH = 4;

/**
 * Everything that arrives on a paste and must not reach `EditorState.lines[]`
 * as-is. This is the second half of the "random characters" report
 * (2026-09-02 round eight item 1, round fourteen), and the half that has
 * nothing to do with how the bytes were decoded:
 *
 *  - **CR** is normalised into the line break it means. A `\r` left at the
 *    end of a line is a control byte the terminal OBEYS, snapping the
 *    cursor back to column 0 mid-row so whatever comes next overwrites what
 *    was just drawn.
 *  - **Tab** is expanded to spaces. `width.ts` gives a control character
 *    zero columns — correct for measuring, wrong for a tab, which the
 *    terminal advances to its next stop. Every column the frame computed
 *    after that point is off by the difference, and the row is painted
 *    over its neighbour.
 *  - **Escape sequences** are removed outright. Copying coloured output out
 *    of a terminal puts real `\x1b[…m` bytes on the clipboard; painting
 *    those into the composer hands the terminal commands rather than text,
 *    and re-colours or repositions arbitrary parts of the screen.
 *  - **Every other C0/C1 control** is dropped for the same reason: it is
 *    not text, it is an instruction to the terminal, and it can only ever
 *    corrupt the frame.
 *
 * Nothing printable is altered — a paste is otherwise inserted byte for
 * byte, including its indentation, which is why tabs become spaces rather
 * than disappearing.
 */
export function sanitizePastedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // CSI/OSC and the two-byte escapes, before the bare-control sweep —
    // otherwise stripping the ESC would leave its parameters as text.
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g, "")
    .replace(/\x1b[@-_]?[0-?]*[ -/]*[@-~]?/g, "")
    .replace(/\t/g, " ".repeat(PASTE_TAB_WIDTH))
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

/**
 * Consecutive edits of the same kind coalesce into one undo step; a
 * different kind always starts a new one. `word` is the boundary marker —
 * typing a space or newline ends the current run so Ctrl-Z stops there.
 */
type EditKind = "insert" | "delete" | "word" | "structural";

export class LineEditor {
  private lines: string[] = [""];
  private row = 0;
  private col = 0;
  private anchor: Pos | null = null;

  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastEditKind: EditKind | null = null;

  /** Cut/copy register — the in-process fallback for when the system clipboard is unreachable. */
  private register = "";

  get state(): EditorState {
    return { lines: [...this.lines], cursorRow: this.row, cursorCol: this.col, selection: this.selection };
  }

  /** The full buffer, lines joined with `\n` — what gets submitted. */
  get text(): string {
    return this.lines.join("\n");
  }

  get lineCount(): number {
    return this.lines.length;
  }

  get cursor(): Pos {
    return { row: this.row, col: this.col };
  }

  /** Normalised (start before end), or null when the anchor is unset or sits exactly on the cursor. */
  get selection(): Selection | null {
    if (!this.anchor) return null;
    const cursor = { row: this.row, col: this.col };
    if (comparePos(this.anchor, cursor) === 0) return null;
    return comparePos(this.anchor, cursor) < 0 ? { start: this.anchor, end: cursor } : { start: cursor, end: this.anchor };
  }

  get hasSelection(): boolean {
    return this.selection !== null;
  }

  reset(seed = ""): void {
    this.lines = seed.split("\n");
    this.row = this.lines.length - 1;
    this.col = this.lines[this.row]!.length;
    this.anchor = null;
    this.undoStack = [];
    this.redoStack = [];
    this.lastEditKind = null;
  }

  private line(): string {
    return this.lines[this.row]!;
  }

  // --- undo/redo ---

  private snapshot(): Snapshot {
    return { lines: [...this.lines], row: this.row, col: this.col };
  }

  /**
   * Called before every mutation. Pushes an undo entry unless this edit
   * continues a run of the same kind, and always clears the redo stack — a
   * new edit after an undo abandons the redone future, which is what every
   * editor does.
   */
  private beginEdit(kind: EditKind): void {
    this.redoStack = [];
    if (this.lastEditKind !== kind || kind === "structural" || kind === "word") {
      this.undoStack.push(this.snapshot());
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    }
    this.lastEditKind = kind === "word" ? null : kind;
  }

  /** Ctrl-Z. Returns false when there is nothing left to undo. */
  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.redoStack.push(this.snapshot());
    this.restore(prev);
    return true;
  }

  /** Ctrl-Y (and Ctrl-Shift-Z where the terminal reports it). Returns false when there is nothing to redo. */
  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push(this.snapshot());
    this.restore(next);
    return true;
  }

  private restore(s: Snapshot): void {
    this.lines = [...s.lines];
    this.row = Math.min(s.row, this.lines.length - 1);
    this.col = Math.min(s.col, this.lines[this.row]!.length);
    this.anchor = null;
    this.lastEditKind = null;
  }

  // --- selection ---

  /** Ctrl-A: the whole buffer. */
  selectAll(): void {
    this.anchor = { row: 0, col: 0 };
    this.row = this.lines.length - 1;
    this.col = this.line().length;
  }

  clearSelection(): void {
    this.anchor = null;
  }

  /** The word under the cursor — what a double-click selects. */
  selectWordAtCursor(): void {
    const l = this.line();
    let start = this.col;
    let end = this.col;
    if (isWordChar(l[end])) {
      while (start > 0 && isWordChar(l[start - 1])) start -= 1;
      while (end < l.length && isWordChar(l[end])) end += 1;
    } else {
      // Not on a word: take the run of non-word characters instead, so a
      // double-click on punctuation or whitespace still selects something.
      while (start > 0 && !isWordChar(l[start - 1])) start -= 1;
      while (end < l.length && !isWordChar(l[end])) end += 1;
    }
    this.anchor = { row: this.row, col: start };
    this.col = end;
  }

  selectedText(): string {
    const sel = this.selection;
    if (!sel) return "";
    if (sel.start.row === sel.end.row) return this.lines[sel.start.row]!.slice(sel.start.col, sel.end.col);
    const parts = [this.lines[sel.start.row]!.slice(sel.start.col)];
    for (let r = sel.start.row + 1; r < sel.end.row; r++) parts.push(this.lines[r]!);
    parts.push(this.lines[sel.end.row]!.slice(0, sel.end.col));
    return parts.join("\n");
  }

  /** Removes the selection and leaves the cursor where it started. Returns false when nothing was selected. */
  deleteSelection(): boolean {
    const sel = this.selection;
    if (!sel) return false;
    this.beginEdit("structural");
    this.applyDeleteSelection(sel);
    return true;
  }

  /** The mutation without the undo bookkeeping — for callers that already opened an edit (insert-over-selection). */
  private applyDeleteSelection(sel: Selection): void {
    const head = this.lines[sel.start.row]!.slice(0, sel.start.col);
    const tail = this.lines[sel.end.row]!.slice(sel.end.col);
    this.lines.splice(sel.start.row, sel.end.row - sel.start.row + 1, head + tail);
    this.row = sel.start.row;
    this.col = sel.start.col;
    this.anchor = null;
  }

  // --- clipboard register ---

  /** Ctrl-C with a selection: the selected text, left in place. Empty (and the register untouched) when nothing is selected. */
  copy(): string {
    const text = this.selectedText();
    if (text.length > 0) this.register = text;
    return text;
  }

  /** Ctrl-X: the selected text, removed. Empty when nothing is selected. */
  cut(): string {
    const text = this.selectedText();
    if (text.length === 0) return "";
    this.register = text;
    this.deleteSelection();
    return text;
  }

  /** Ctrl-V with no reachable system clipboard — pastes whatever was last cut or copied in-process. */
  get clipboardRegister(): string {
    return this.register;
  }

  // --- insertion ---

  insertChar(ch: string): void {
    // A space closes the current typing run, so one Ctrl-Z takes back a
    // word rather than a letter.
    this.beginEdit(/\s/.test(ch) ? "word" : "insert");
    const sel = this.selection;
    if (sel) this.applyDeleteSelection(sel);
    const l = this.line();
    this.lines[this.row] = l.slice(0, this.col) + ch + l.slice(this.col);
    this.col += ch.length;
    this.anchor = null;
  }

  /**
   * Bracketed paste and Ctrl-V: split on newlines into real line breaks,
   * one insert, not N keystrokes.
   *
   * Line endings are normalised to `\n` FIRST (2026-09-02 round eight,
   * item 1: "pasting some text that have end line in it got some unwanted
   * error, some random characters appear in the text"). Splitting on bare
   * `\n` left a `\r` sitting at the end of every line whenever the source
   * used CRLF — which both paste paths can hand in: `clipboard.ts`'s
   * Windows reader is literally `Get-Clipboard -Raw`, and a terminal's own
   * bracketed paste forwards whatever bytes were on the clipboard
   * unmodified. That stray `\r` then lived in `EditorState.lines[]` and
   * was painted as-is — a raw carriage return the terminal obeys by
   * snapping the cursor back to column 0 mid-line, which overwrites part
   * of what was just drawn with whatever comes after it. That is the
   * "random characters" report: not corrupted text, a control byte
   * fighting the renderer for the same row.
   *
   * Round fourteen generalised that one normalisation into
   * `sanitizePastedText()`, because `\r` was never the only control byte a
   * clipboard can carry — see that function for the rest of them.
   */
  insertText(text: string): void {
    this.beginEdit("structural");
    const sel = this.selection;
    if (sel) this.applyDeleteSelection(sel);
    const parts = sanitizePastedText(text).split("\n");
    const l = this.line();
    if (parts.length === 1) {
      this.lines[this.row] = l.slice(0, this.col) + parts[0] + l.slice(this.col);
      this.col += parts[0]!.length;
      this.anchor = null;
      return;
    }
    const before = l.slice(0, this.col);
    const after = l.slice(this.col);
    const newLines = [before + parts[0], ...parts.slice(1, -1), parts[parts.length - 1] + after];
    this.lines.splice(this.row, 1, ...newLines);
    this.row += parts.length - 1;
    this.col = parts[parts.length - 1]!.length;
    this.anchor = null;
  }

  /** A literal newline in the buffer — Shift+Enter, Alt+Enter, or a `\`-continued line. */
  newline(): void {
    this.beginEdit("structural");
    const sel = this.selection;
    if (sel) this.applyDeleteSelection(sel);
    const l = this.line();
    const before = l.slice(0, this.col);
    const after = l.slice(this.col);
    this.lines.splice(this.row, 1, before, after);
    this.row += 1;
    this.col = 0;
    this.anchor = null;
  }

  // --- deletion ---

  backspace(): void {
    if (this.deleteSelection()) return;
    this.beginEdit("delete");
    if (this.col > 0) {
      const l = this.line();
      this.lines[this.row] = l.slice(0, this.col - 1) + l.slice(this.col);
      this.col -= 1;
      return;
    }
    if (this.row === 0) return;
    const prev = this.lines[this.row - 1]!;
    const joinAt = prev.length;
    this.lines.splice(this.row - 1, 2, prev + this.line());
    this.row -= 1;
    this.col = joinAt;
  }

  deleteForward(): void {
    if (this.deleteSelection()) return;
    this.beginEdit("delete");
    const l = this.line();
    if (this.col < l.length) {
      this.lines[this.row] = l.slice(0, this.col) + l.slice(this.col + 1);
      return;
    }
    if (this.row === this.lines.length - 1) return;
    const next = this.lines[this.row + 1]!;
    this.lines.splice(this.row, 2, l + next);
  }

  // --- movement. `extend` grows the selection instead of dropping it. ---

  private beforeMove(extend: boolean): void {
    if (extend) {
      if (!this.anchor) this.anchor = { row: this.row, col: this.col };
    } else {
      this.anchor = null;
    }
    this.lastEditKind = null;
  }

  /**
   * A plain (non-extending) Left with an active selection collapses to the
   * selection's START rather than moving one character left from wherever
   * the live cursor happens to sit (2026-09-02 UI feedback, round five,
   * item 3: "when I select a text and press left arrow, I should be at
   * right before the first character of the selected text, like a real
   * editor would do"). `this.col`/`this.row` track the cursor end of a
   * selection, not necessarily its left edge — dragging right-to-left
   * makes the anchor the RIGHT edge — so a plain one-column move from the
   * cursor would leave the caret one character short of, or past, the
   * selection's actual start depending on drag direction; jumping straight
   * to `selection.start` is correct either way.
   */
  moveLeft(extend = false): void {
    if (!extend) {
      const sel = this.selection;
      if (sel) {
        this.anchor = null;
        this.row = sel.start.row;
        this.col = sel.start.col;
        this.lastEditKind = null;
        return;
      }
    }
    this.beforeMove(extend);
    if (this.col > 0) {
      this.col -= 1;
      return;
    }
    if (this.row > 0) {
      this.row -= 1;
      this.col = this.line().length;
    }
  }

  /** The mirror of `moveLeft()`'s selection-collapse: Right lands right after the selection's LAST character. */
  moveRight(extend = false): void {
    if (!extend) {
      const sel = this.selection;
      if (sel) {
        this.anchor = null;
        this.row = sel.end.row;
        this.col = sel.end.col;
        this.lastEditKind = null;
        return;
      }
    }
    this.beforeMove(extend);
    if (this.col < this.line().length) {
      this.col += 1;
      return;
    }
    if (this.row < this.lines.length - 1) {
      this.row += 1;
      this.col = 0;
    }
  }

  /** Returns false at the top row — the caller (RawLineSource) falls through to history recall when this returns false. */
  moveUp(extend = false): boolean {
    if (this.row === 0) return false;
    this.beforeMove(extend);
    this.row -= 1;
    this.col = Math.min(this.col, this.line().length);
    return true;
  }

  /** Returns false at the bottom row — same fall-through contract as moveUp(). */
  moveDown(extend = false): boolean {
    if (this.row === this.lines.length - 1) return false;
    this.beforeMove(extend);
    this.row += 1;
    this.col = Math.min(this.col, this.line().length);
    return true;
  }

  home(extend = false): void {
    this.beforeMove(extend);
    this.col = 0;
  }

  end(extend = false): void {
    this.beforeMove(extend);
    this.col = this.line().length;
  }

  moveWordLeft(extend = false): void {
    this.beforeMove(extend);
    if (this.col === 0) {
      if (this.row > 0) {
        this.row -= 1;
        this.col = this.line().length;
      }
      return;
    }
    this.moveWordLeftInLine();
  }

  moveWordRight(extend = false): void {
    this.beforeMove(extend);
    if (this.col === this.line().length) {
      if (this.row < this.lines.length - 1) {
        this.row += 1;
        this.col = 0;
      }
      return;
    }
    this.moveWordRightInLine();
  }

  /** Mouse click / drag: put the cursor at an exact buffer position, clamped into the buffer. */
  moveTo(row: number, col: number, extend = false): void {
    this.beforeMove(extend);
    this.row = Math.max(0, Math.min(Math.floor(row), this.lines.length - 1));
    this.col = Math.max(0, Math.min(Math.floor(col), this.line().length));
  }

  // --- kill bindings ---

  /** Ctrl-K: delete from the cursor to the end of the current line. */
  killToEnd(): void {
    this.beginEdit("structural");
    const l = this.line();
    this.lines[this.row] = l.slice(0, this.col);
    this.anchor = null;
  }

  /** Ctrl-U: delete from the start of the current line to the cursor. */
  killLine(): void {
    this.beginEdit("structural");
    const l = this.line();
    this.lines[this.row] = l.slice(this.col);
    this.col = 0;
    this.anchor = null;
  }

  /** T47: replace `[startCol, endCol)` on the current row with `text` and place the cursor at the end of it — how tab completion swaps a partial command/path for a chosen candidate. Never crosses rows: completion only ever looks at one line (`completion.ts`'s `complete()` contract). */
  replaceRange(startCol: number, endCol: number, text: string): void {
    this.beginEdit("structural");
    const l = this.line();
    this.lines[this.row] = l.slice(0, startCol) + text + l.slice(endCol);
    this.col = startCol + text.length;
    this.anchor = null;
  }

  /**
   * Ctrl-W and Ctrl+Backspace: delete the word before the cursor — "a
   * connected component of characters, like what we can do in normal
   * editors" (2026-09-02 UI feedback, item 7). At column 0 it joins with
   * the previous line, the way Backspace does, rather than doing nothing.
   */
  deleteWordBackward(): void {
    if (this.deleteSelection()) return;
    this.anchor = null;
    if (this.col === 0) {
      this.backspace();
      return;
    }
    this.beginEdit("structural");
    const before = this.col;
    this.moveWordLeftInLine();
    const after = this.col;
    const l = this.line();
    this.lines[this.row] = l.slice(0, after) + l.slice(before);
  }

  /** Ctrl+Delete: the same, forward. */
  deleteWordForward(): void {
    if (this.deleteSelection()) return;
    this.anchor = null;
    if (this.col === this.line().length) {
      this.deleteForward();
      return;
    }
    this.beginEdit("structural");
    const before = this.col;
    this.moveWordRightInLine();
    const after = this.col;
    const l = this.line();
    this.lines[this.row] = l.slice(0, before) + l.slice(after);
    this.col = before;
  }

  /** Word motion within the current line only — the shared core of moveWordLeft() and deleteWordBackward(). Never touches the anchor or the undo stack. */
  private moveWordLeftInLine(): void {
    const l = this.line();
    let c = this.col;
    while (c > 0 && !isWordChar(l[c - 1])) c -= 1;
    while (c > 0 && isWordChar(l[c - 1])) c -= 1;
    this.col = c;
  }

  private moveWordRightInLine(): void {
    const l = this.line();
    let c = this.col;
    const len = l.length;
    while (c < len && !isWordChar(l[c])) c += 1;
    while (c < len && isWordChar(l[c])) c += 1;
    this.col = c;
  }
}
