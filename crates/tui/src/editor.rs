//! The prompt box's text editor (P5 #38, spec decision 6). Every OpenCode `input.*` action at `4332e24`
//! (`config/keybind.ts`), plus what the old TUI's editor (`lykos/tui/editor.ts`) does that OpenCode's lacks: a
//! selection that typing replaces, word-coalesced undo, a cut and copy register, and paste sanitizing.
//!
//! A large paste or an image is one character of the buffer, a chip from Unicode's private use plane that draws as
//! its label (OpenCode `pasteInputText`: `[Pasted ~N lines]` for 3 or more lines or over 150 characters). Editing
//! stays as fast with a 1 MB paste as with none, and submitting expands each chip.
use std::cell::RefCell;
use std::rc::Rc;

use unicode_width::UnicodeWidthChar;

/// Chip `i` is the character `CHIP_BASE + i`, in Supplementary Private Use Area-A, which no keyboard types.
const CHIP_BASE: u32 = 0xF0000;
const CHIP_MAX: u32 = 0xFFFFD;

/// The old editor's cap on steps. Each step is a whole-buffer snapshot, so the bytes are capped too: a 1 MB
/// prompt keeps 16 steps, not 200 MB.
const MAX_UNDO: usize = 200;
const MAX_UNDO_BYTES: usize = 16 << 20;
/// A pasted tab becomes this many spaces (`lykos/tui/editor.ts` `PASTE_TAB_WIDTH`).
const PASTE_TAB_WIDTH: usize = 4;

#[derive(Clone, Debug, PartialEq)]
pub enum Chip {
    Pasted { text: String, lines: usize },
    /// An image, sent as `@path` so the session attaches it as P22's `@path` does.
    Image { path: String, n: usize },
}

impl Chip {
    pub fn label(&self) -> String {
        match self {
            Chip::Pasted { lines, .. } => format!("[Pasted ~{lines} lines]"),
            Chip::Image { n, .. } => format!("[Image {n}]"),
        }
    }

    fn expand(&self) -> String {
        match self {
            Chip::Pasted { text, .. } => text.clone(),
            Chip::Image { path, .. } => format!("@{path}"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Kind {
    Insert,
    Delete,
    Structural,
}

#[derive(Clone, Debug)]
struct Snap {
    text: String,
    cursor: usize,
}

/// A layout and what it was made for: the text's revision and the width.
type Laid = (u64, usize, Rc<Vec<Row>>);

/// One visual row of the input: a byte range of the buffer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Row {
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Default)]
pub struct Editor {
    text: String,
    cursor: usize,
    anchor: Option<usize>,
    /// The visual column up and down keep while they cross shorter rows.
    goal: Option<usize>,
    undo: Vec<Snap>,
    redo: Vec<Snap>,
    last: Option<Kind>,
    chips: Vec<Chip>,
    /// What cut and copy took: the in-process clipboard (the system one is the terminal's).
    pub register: String,
    /// Bumped by every change to the text: the layout below is reused until it moves.
    rev: u64,
    /// The last layout, by revision and width. A frame asks for it several times, and a long paste is slow to wrap.
    laid: RefCell<Option<Laid>>,
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// What the old editor's `sanitizePastedText` does: CR to LF, escape sequences out, tabs to spaces, other controls out.
pub fn sanitize(text: &str) -> String {
    let text = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(text.len());
    let mut it = text.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '\x1b' => match it.peek() {
                // OSC: up to BEL or ST.
                Some(']') => {
                    it.next();
                    while let Some(c) = it.next() {
                        if c == '\x07' || (c == '\x1b' && it.peek() == Some(&'\\')) {
                            if c == '\x1b' {
                                it.next();
                            }
                            break;
                        }
                    }
                }
                // CSI: parameters, intermediates, one final byte.
                Some('[') => {
                    it.next();
                    while let Some(&c) = it.peek() {
                        it.next();
                        if ('@'..='~').contains(&c) {
                            break;
                        }
                    }
                }
                Some(&c) if ('@'..='_').contains(&c) => {
                    it.next();
                }
                _ => {}
            },
            '\t' => out.push_str(&" ".repeat(PASTE_TAB_WIDTH)),
            '\n' => out.push('\n'),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

impl Editor {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn cursor(&self) -> usize {
        self.cursor
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn chip(&self, c: char) -> Option<&Chip> {
        let n = c as u32;
        if (CHIP_BASE..=CHIP_MAX).contains(&n) {
            self.chips.get((n - CHIP_BASE) as usize)
        } else {
            None
        }
    }

    /// The images in the buffer now, in order.
    pub fn images(&self) -> Vec<&Chip> {
        self.text.chars().filter_map(|c| self.chip(c)).filter(|c| matches!(c, Chip::Image { .. })).collect()
    }

    /// A character's display width; a chip is its label's.
    pub fn width_of(&self, c: char) -> usize {
        match self.chip(c) {
            Some(chip) => chip.label().chars().map(|c| c.width().unwrap_or(0)).sum(),
            None => c.width().unwrap_or(0),
        }
    }

    /// The selection as a byte range, start before end; none while the anchor is unset or on the cursor.
    pub fn selection(&self) -> Option<(usize, usize)> {
        let a = self.anchor?;
        if a == self.cursor {
            return None;
        }
        Some((a.min(self.cursor), a.max(self.cursor)))
    }

    /// The text as submitted: every chip expanded.
    pub fn expanded(&self) -> String {
        self.expand_range(0, self.text.len())
    }

    fn expand_range(&self, start: usize, end: usize) -> String {
        let mut out = String::with_capacity(end - start);
        for c in self.text[start..end].chars() {
            match self.chip(c) {
                Some(chip) => out.push_str(&chip.expand()),
                None => out.push(c),
            }
        }
        out
    }

    /// Replaces the whole buffer (history recall, a stash pop, the external editor), as one undo step.
    pub fn set(&mut self, text: &str) {
        self.record(Kind::Structural);
        self.text = text.to_string();
        self.cursor = self.text.len();
        self.anchor = None;
        self.goal = None;
    }

    /// Replaces a byte range with `with`, as one undo step: a completion.
    pub fn replace(&mut self, start: usize, end: usize, with: &str) {
        self.record(Kind::Structural);
        let (start, end) = (self.floor(start), self.floor(end.max(start)));
        self.text.replace_range(start..end, with);
        self.cursor = start + with.len();
        self.anchor = None;
        self.settle();
    }

    /// Empties the buffer and its history: what a submit does.
    pub fn reset(&mut self) {
        let register = std::mem::take(&mut self.register);
        *self = Editor { register, ..Editor::default() };
    }

    fn record(&mut self, kind: Kind) {
        self.rev += 1;
        if self.last != Some(kind) || kind == Kind::Structural {
            self.undo.push(Snap { text: self.text.clone(), cursor: self.cursor });
            let mut bytes: usize = self.undo.iter().map(|s| s.text.len()).sum();
            while self.undo.len() > 1 && (self.undo.len() > MAX_UNDO || bytes > MAX_UNDO_BYTES) {
                bytes -= self.undo.remove(0).text.len();
            }
        }
        self.last = Some(kind);
        self.redo.clear();
    }

    /// Ends a run of typing, so the next keystroke starts a new undo step.
    fn settle(&mut self) {
        self.last = None;
        self.goal = None;
    }

    pub fn undo(&mut self) -> bool {
        let Some(s) = self.undo.pop() else { return false };
        self.rev += 1;
        self.redo.push(Snap { text: std::mem::replace(&mut self.text, s.text), cursor: self.cursor });
        self.cursor = s.cursor.min(self.text.len());
        self.anchor = None;
        self.settle();
        true
    }

    pub fn redo(&mut self) -> bool {
        let Some(s) = self.redo.pop() else { return false };
        self.rev += 1;
        self.undo.push(Snap { text: std::mem::replace(&mut self.text, s.text), cursor: self.cursor });
        self.cursor = s.cursor.min(self.text.len());
        self.anchor = None;
        self.settle();
        true
    }

    fn delete_range(&mut self, start: usize, end: usize) {
        self.text.replace_range(start..end, "");
        self.cursor = start;
        self.anchor = None;
        self.goal = None;
    }

    /// Deletes the selection, if any; true when it did.
    fn take_selection(&mut self) -> bool {
        match self.selection() {
            Some((s, e)) => {
                self.delete_range(s, e);
                true
            }
            None => {
                self.anchor = None;
                false
            }
        }
    }

    pub fn insert_char(&mut self, c: char) {
        if c.is_control() && c != '\n' {
            return;
        }
        // A space or a newline ends the word being typed: undo takes back a word, not a letter.
        let kind = if c.is_whitespace() { Kind::Structural } else { Kind::Insert };
        self.record(kind);
        self.take_selection();
        self.text.insert(self.cursor, c);
        self.cursor += c.len_utf8();
        if kind == Kind::Structural {
            self.last = None;
        }
        self.goal = None;
    }

    pub fn newline(&mut self) {
        self.insert_char('\n');
    }

    pub fn insert_str(&mut self, s: &str) {
        self.record(Kind::Structural);
        self.take_selection();
        self.text.insert_str(self.cursor, s);
        self.cursor += s.len();
        self.settle();
    }

    fn add_chip(&mut self, chip: Chip) -> bool {
        let n = CHIP_BASE + self.chips.len() as u32;
        let Some(c) = char::from_u32(n).filter(|_| n <= CHIP_MAX) else { return false };
        self.chips.push(chip);
        self.insert_str(&c.to_string());
        true
    }

    /// A bracketed paste: sanitized, and a chip when it is 3 lines or more, or over 150 characters.
    pub fn paste(&mut self, raw: &str) {
        let clean = sanitize(raw);
        let body = clean.trim();
        let lines = body.matches('\n').count() + 1;
        // OpenCode `pasteInputText`: pasting the text of the chip just before the cursor again expands it.
        let before = self.text[..self.cursor].chars().next_back();
        if before.and_then(|c| self.chip(c)).is_some_and(|c| matches!(c, Chip::Pasted { text, .. } if text == body)) && self.expand_chip_at_cursor() {
            return;
        }
        if (lines >= 3 || body.chars().count() > 150) && self.add_chip(Chip::Pasted { text: body.to_string(), lines }) {
            return;
        }
        self.insert_str(&clean);
    }

    /// A paste as its text, however long: Ctrl+Shift+V.
    pub fn paste_text(&mut self, raw: &str) {
        self.insert_str(&sanitize(raw));
    }

    /// Takes back `c` when it is just before the cursor, with nothing selected: a key that was a paste's start.
    pub fn take_before(&mut self, c: char) -> bool {
        if self.anchor.is_some() || !self.text[..self.cursor].ends_with(c) {
            return false;
        }
        let at = self.cursor - c.len_utf8();
        self.record(Kind::Structural);
        self.delete_range(at, self.cursor);
        true
    }

    pub fn attach_image(&mut self, path: &str) {
        let n = self.chips.iter().filter(|c| matches!(c, Chip::Image { .. })).count() + 1;
        if self.add_chip(Chip::Image { path: path.to_string(), n }) {
            self.insert_char(' ');
        }
    }

    /// Turns the chip under or just before the cursor back into its text (OpenCode `expandPastedText`).
    pub fn expand_chip_at_cursor(&mut self) -> bool {
        let before = self.text[..self.cursor].chars().next_back();
        let at = self.text[self.cursor..].chars().next();
        let (start, c) = match (at.filter(|c| self.chip(*c).is_some()), before.filter(|c| self.chip(*c).is_some())) {
            (Some(c), _) => (self.cursor, c),
            (None, Some(c)) => (self.cursor - c.len_utf8(), c),
            _ => return false,
        };
        let Some(Chip::Pasted { text, .. }) = self.chip(c).cloned() else { return false };
        self.record(Kind::Structural);
        self.text.replace_range(start..start + c.len_utf8(), &text);
        self.cursor = start + text.len();
        self.anchor = None;
        self.settle();
        true
    }

    // --- Deleting: `input.backspace`, `input.delete`, `input.delete.*`.

    pub fn backspace(&mut self) {
        self.record(Kind::Delete);
        if self.take_selection() {
            return;
        }
        if let Some(c) = self.text[..self.cursor].chars().next_back() {
            let start = self.cursor - c.len_utf8();
            self.delete_range(start, self.cursor);
        }
    }

    pub fn delete(&mut self) {
        self.record(Kind::Delete);
        if self.take_selection() {
            return;
        }
        if let Some(c) = self.text[self.cursor..].chars().next() {
            let end = self.cursor + c.len_utf8();
            self.delete_range(self.cursor, end);
        }
    }

    pub fn delete_word_backward(&mut self) {
        self.record(Kind::Structural);
        if self.take_selection() {
            return;
        }
        let start = self.word_backward_from(self.cursor);
        self.delete_range(start, self.cursor);
    }

    pub fn delete_word_forward(&mut self) {
        self.record(Kind::Structural);
        if self.take_selection() {
            return;
        }
        let end = self.word_forward_from(self.cursor);
        self.delete_range(self.cursor, end);
    }

    /// `input.delete.line`: the logical line and its newline.
    pub fn delete_line(&mut self) {
        self.record(Kind::Structural);
        let (s, e) = (self.line_start(self.cursor), self.line_end(self.cursor));
        let (s, e) = if e < self.text.len() { (s, e + 1) } else if s > 0 { (s - 1, e) } else { (s, e) };
        self.delete_range(s, e);
    }

    /// `input.delete.to.line.end` (ctrl+k): to the line's end, or the newline itself when already there.
    pub fn delete_to_line_end(&mut self) {
        self.record(Kind::Structural);
        if self.take_selection() {
            return;
        }
        let e = self.line_end(self.cursor);
        let e = if e == self.cursor && e < self.text.len() { e + 1 } else { e };
        let to = self.cursor;
        self.register = self.text[to..e].to_string();
        self.delete_range(to, e);
    }

    /// `input.delete.to.line.start` (ctrl+u).
    pub fn delete_to_line_start(&mut self) {
        self.record(Kind::Structural);
        if self.take_selection() {
            return;
        }
        let s = self.line_start(self.cursor);
        self.register = self.text[s..self.cursor].to_string();
        self.delete_range(s, self.cursor);
    }

    // --- Clipboard: the old editor's register.

    pub fn copy(&mut self) -> Option<String> {
        let (s, e) = self.selection()?;
        self.register = self.expand_range(s, e);
        Some(self.register.clone())
    }

    pub fn cut(&mut self) -> Option<String> {
        let out = self.copy()?;
        self.record(Kind::Structural);
        self.take_selection();
        Some(out)
    }

    // --- Moving and selecting. `extend` starts or grows the selection; without it a move drops it.

    fn move_to(&mut self, to: usize, extend: bool) {
        if extend {
            self.anchor.get_or_insert(self.cursor);
        } else {
            self.anchor = None;
        }
        self.cursor = to.min(self.text.len());
        self.last = None;
    }

    pub fn left(&mut self, extend: bool) {
        self.goal = None;
        if !extend {
            if let Some((s, _)) = self.selection() {
                return self.move_to(s, false);
            }
        }
        let to = self.text[..self.cursor].chars().next_back().map_or(self.cursor, |c| self.cursor - c.len_utf8());
        self.move_to(to, extend);
    }

    pub fn right(&mut self, extend: bool) {
        self.goal = None;
        if !extend {
            if let Some((_, e)) = self.selection() {
                return self.move_to(e, false);
            }
        }
        let to = self.text[self.cursor..].chars().next().map_or(self.cursor, |c| self.cursor + c.len_utf8());
        self.move_to(to, extend);
    }

    fn word_forward_from(&self, from: usize) -> usize {
        let mut i = from;
        let mut it = self.text[from..].chars().peekable();
        while let Some(&c) = it.peek() {
            if is_word(c) {
                break;
            }
            i += c.len_utf8();
            it.next();
        }
        while let Some(&c) = it.peek() {
            if !is_word(c) {
                break;
            }
            i += c.len_utf8();
            it.next();
        }
        i
    }

    fn word_backward_from(&self, from: usize) -> usize {
        let mut i = from;
        let mut it = self.text[..from].chars().rev().peekable();
        while let Some(&c) = it.peek() {
            if is_word(c) {
                break;
            }
            i -= c.len_utf8();
            it.next();
        }
        while let Some(&c) = it.peek() {
            if !is_word(c) {
                break;
            }
            i -= c.len_utf8();
            it.next();
        }
        i
    }

    pub fn word_forward(&mut self, extend: bool) {
        self.goal = None;
        let to = self.word_forward_from(self.cursor);
        self.move_to(to, extend);
    }

    pub fn word_backward(&mut self, extend: bool) {
        self.goal = None;
        let to = self.word_backward_from(self.cursor);
        self.move_to(to, extend);
    }

    fn line_start(&self, at: usize) -> usize {
        self.text[..at].rfind('\n').map_or(0, |i| i + 1)
    }

    fn line_end(&self, at: usize) -> usize {
        self.text[at..].find('\n').map_or(self.text.len(), |i| at + i)
    }

    pub fn line_home(&mut self, extend: bool) {
        self.goal = None;
        let to = self.line_start(self.cursor);
        self.move_to(to, extend);
    }

    pub fn line_end_(&mut self, extend: bool) {
        self.goal = None;
        let to = self.line_end(self.cursor);
        self.move_to(to, extend);
    }

    pub fn buffer_home(&mut self, extend: bool) {
        self.goal = None;
        self.move_to(0, extend);
    }

    pub fn buffer_end(&mut self, extend: bool) {
        self.goal = None;
        let to = self.text.len();
        self.move_to(to, extend);
    }

    pub fn select_all(&mut self) {
        self.anchor = Some(0);
        self.cursor = self.text.len();
        self.goal = None;
        self.last = None;
    }

    /// Selects the word under `at` (a double click).
    pub fn select_word(&mut self, at: usize) {
        let at = self.floor(at);
        let start = self.text[..at].char_indices().rev().take_while(|(_, c)| is_word(*c)).last().map_or(at, |(i, _)| i);
        let end = self.text[at..].char_indices().take_while(|(_, c)| is_word(*c)).last().map_or(at, |(i, c)| at + i + c.len_utf8());
        self.anchor = Some(start);
        self.cursor = end;
        self.goal = None;
    }

    /// Puts the cursor at a byte offset (a click), or extends the selection to it (a drag).
    pub fn click(&mut self, at: usize, extend: bool) {
        let at = self.floor(at);
        self.goal = None;
        self.move_to(at, extend);
    }

    fn floor(&self, mut at: usize) -> usize {
        at = at.min(self.text.len());
        while !self.text.is_char_boundary(at) {
            at -= 1;
        }
        at
    }

    // --- Visual rows: wrapping at `width` columns, a chip never split.

    pub fn layout(&self, width: usize) -> Rc<Vec<Row>> {
        let width = width.max(1);
        if let Some((rev, w, rows)) = self.laid.borrow().as_ref() {
            if *rev == self.rev && *w == width {
                return rows.clone();
            }
        }
        let rows = Rc::new(self.wrap(width));
        *self.laid.borrow_mut() = Some((self.rev, width, rows.clone()));
        rows
    }

    fn wrap(&self, width: usize) -> Vec<Row> {
        let mut rows = Vec::new();
        let mut start = 0;
        let mut col = 0;
        for (i, c) in self.text.char_indices() {
            if c == '\n' {
                rows.push(Row { start, end: i });
                start = i + 1;
                col = 0;
                continue;
            }
            let w = self.width_of(c);
            if col + w > width && col > 0 {
                rows.push(Row { start, end: i });
                start = i;
                col = 0;
            }
            col += w;
        }
        rows.push(Row { start, end: self.text.len() });
        rows
    }

    fn cols(&self, from: usize, to: usize) -> usize {
        self.text[from..to].chars().map(|c| self.width_of(c)).sum()
    }

    /// The visual (row, column) of a byte offset. An offset on a wrap point belongs to the row it starts.
    pub fn locate(&self, rows: &[Row], at: usize) -> (usize, usize) {
        let row = rows.iter().rposition(|r| r.start <= at).unwrap_or(0);
        (row, self.cols(rows[row].start, at.min(rows[row].end)))
    }

    /// The byte offset nearest to visual column `col` on `row`.
    pub fn offset_at(&self, rows: &[Row], row: usize, col: usize) -> usize {
        let r = rows[row.min(rows.len() - 1)];
        let mut used = 0;
        for (i, c) in self.text[r.start..r.end].char_indices() {
            let w = self.width_of(c);
            if used + w > col {
                return r.start + i;
            }
            used += w;
        }
        r.end
    }

    /// `input.move.up`: one visual row up. False at the top row, where the caller recalls history instead.
    pub fn up(&mut self, width: usize, extend: bool) -> bool {
        self.vertical(width, extend, -1)
    }

    pub fn down(&mut self, width: usize, extend: bool) -> bool {
        self.vertical(width, extend, 1)
    }

    fn vertical(&mut self, width: usize, extend: bool, dir: i32) -> bool {
        let rows = self.layout(width);
        let (row, col) = self.locate(&rows, self.cursor);
        let goal = *self.goal.get_or_insert(col);
        let target = row as i64 + dir as i64;
        if target < 0 || target >= rows.len() as i64 {
            return false;
        }
        let to = self.offset_at(&rows, target as usize, goal);
        let keep = self.goal;
        self.move_to(to, extend);
        self.goal = keep;
        true
    }

    /// `input.visual.line.home` / `.end`: the ends of the visual row.
    pub fn visual_home(&mut self, width: usize, extend: bool) {
        let rows = self.layout(width);
        let (row, _) = self.locate(&rows, self.cursor);
        self.goal = None;
        self.move_to(rows[row].start, extend);
    }

    /// On a row that wraps, the end is before its last character: the offset after it starts the next row.
    pub fn visual_end(&mut self, width: usize, extend: bool) {
        let rows = self.layout(width);
        let (row, _) = self.locate(&rows, self.cursor);
        self.goal = None;
        let r = rows[row];
        let soft = row + 1 < rows.len() && rows[row + 1].start == r.end;
        let to = if soft { self.text[r.start..r.end].chars().next_back().map_or(r.end, |c| r.end - c.len_utf8()) } else { r.end };
        self.move_to(to, extend);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn typed(s: &str) -> Editor {
        let mut e = Editor::default();
        for c in s.chars() {
            e.insert_char(c);
        }
        e
    }

    #[test]
    fn words_move_and_delete_by_word() {
        let mut e = typed("hello big world");
        e.word_backward(false);
        assert_eq!(&e.text()[e.cursor()..], "world");
        e.word_backward(false);
        e.word_forward(false);
        assert_eq!(&e.text()[..e.cursor()], "hello big");
        e.buffer_end(false);
        e.delete_word_backward();
        assert_eq!(e.text(), "hello big ");
        e.buffer_home(false);
        e.delete_word_forward();
        assert_eq!(e.text(), " big ");
    }

    #[test]
    fn line_actions_work_on_logical_lines() {
        let mut e = typed("one\ntwo three\nfour");
        e.up(80, false);
        e.line_home(false);
        e.word_forward(false);
        e.delete_to_line_end();
        assert_eq!(e.text(), "one\ntwo\nfour");
        assert_eq!(e.register, " three");
        e.delete_to_line_start();
        assert_eq!(e.text(), "one\n\nfour");
        e.delete_line();
        assert_eq!(e.text(), "one\nfour");
        e.line_end_(false);
        e.delete_to_line_end();
        assert_eq!(e.text(), "one\nfour", "at the buffer's end nothing is left to join");
    }

    #[test]
    fn typing_replaces_a_selection_and_undo_takes_back_a_word() {
        let mut e = typed("hello world");
        e.word_backward(true);
        e.insert_char('X');
        assert_eq!(e.text(), "hello X");
        let mut e = typed("one two three");
        e.undo();
        assert_eq!(e.text(), "one two ");
        e.undo();
        assert_eq!(e.text(), "one two");
        e.redo();
        assert_eq!(e.text(), "one two ");
    }

    #[test]
    fn select_all_copy_cut_and_shift_moves() {
        let mut e = typed("abc def");
        e.select_all();
        assert_eq!(e.copy().as_deref(), Some("abc def"));
        e.buffer_home(false);
        e.right(true);
        e.right(true);
        assert_eq!(e.cut().as_deref(), Some("ab"));
        assert_eq!(e.text(), "c def");
        e.insert_str(&e.register.clone());
        assert_eq!(e.text(), "abc def");
    }

    #[test]
    fn up_and_down_move_by_visual_row_and_report_the_edges() {
        let mut e = typed("abcdefghij");
        // Width 4: rows abcd / efgh / ij; the cursor is at the end, row 2 column 2.
        assert!(e.up(4, false));
        assert_eq!(&e.text()[..e.cursor()], "abcdef");
        assert!(e.up(4, false));
        assert!(!e.up(4, false), "the top row: history takes over");
        e.visual_end(4, false);
        assert_eq!(&e.text()[..e.cursor()], "abc", "a wrapped row ends before its last character");
        e.visual_home(4, false);
        assert_eq!(e.cursor(), 0);
    }

    #[test]
    fn a_large_paste_is_one_chip_that_expands_on_submit() {
        let mut e = typed("see ");
        let big = "line\n".repeat(200_000);
        e.paste(&big);
        assert_eq!(e.text().chars().count(), 5, "four typed characters and one chip");
        assert_eq!(e.width_of(e.text().chars().last().unwrap()), "[Pasted ~200000 lines]".len());
        assert_eq!(e.expanded(), format!("see {}", big.trim()));
        e.backspace();
        assert_eq!(e.text(), "see ", "a chip deletes as one character");
        for _ in 0..50 {
            e.insert_str(&big);
        }
        let sizes: Vec<usize> = e.undo.iter().map(|s| s.text.len()).collect();
        assert!(sizes[..sizes.len() - 1].iter().sum::<usize>() <= MAX_UNDO_BYTES, "undo is capped by bytes, newest step aside: {sizes:?}");
        e.set("see ");
        e.paste("short");
        assert_eq!(e.text(), "see short");
    }

    #[test]
    fn a_chip_expands_back_into_its_text_in_place() {
        let mut e = Editor::default();
        e.paste("a\nb\nc");
        assert!(e.expand_chip_at_cursor());
        assert_eq!(e.text(), "a\nb\nc");
        let mut e = Editor::default();
        e.paste("a\nb\nc");
        e.paste("a\nb\nc");
        assert_eq!(e.text(), "a\nb\nc", "the same paste again expands the chip");
    }

    #[test]
    fn images_are_sent_as_at_paths() {
        let mut e = typed("look ");
        e.attach_image("shots/a.png");
        e.insert_str("and ");
        e.attach_image("b.jpg");
        assert_eq!(e.expanded(), "look @shots/a.png and @b.jpg ");
        assert_eq!(e.images().len(), 2);
    }

    #[test]
    fn a_paste_loses_escapes_and_controls_and_keeps_its_indentation() {
        assert_eq!(sanitize("a\r\n\tb\x1b[31mred\x1b[0m\x07\x1b]0;title\x07"), "a\n    bred");
    }

    #[test]
    fn select_word_and_click() {
        let mut e = typed("foo bar_baz qux");
        e.select_word(6);
        assert_eq!(e.copy().as_deref(), Some("bar_baz"));
        e.click(1, false);
        e.click(3, true);
        assert_eq!(e.copy().as_deref(), Some("oo"));
    }

    #[test]
    fn wide_characters_and_chips_wrap_whole() {
        let mut e = typed("漢字漢");
        let rows = e.layout(4);
        assert_eq!(rows.len(), 2);
        e.paste(&"x".repeat(200));
        let rows = e.layout(10);
        let last = rows.last().unwrap();
        assert_eq!(e.text()[last.start..last.end].chars().count(), 1, "the chip is on a row of its own");
    }
}
