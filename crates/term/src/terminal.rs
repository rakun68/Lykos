use std::io::{self, Write};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::buffer::{Attr, Buffer, Cell, Color, Scroll, Style};

/// The screen: the frame on it, and the bytes of the next one. One `write` per frame.
///
/// Inline (OpenCode's split footer, `mini/runtime.lifecycle.ts`): the frame is a footer on the screen's bottom
/// rows, and rows printed above it scroll up into the terminal's own scrollback, where they stay.
pub struct Terminal<W: Write> {
    out: W,
    front: Buffer,
    back: Buffer,
    bytes: Vec<u8>,
    /// The first frame, and the one after a resize, repaints every cell.
    full: bool,
    cursor: Option<(u16, u16)>,
    /// Inline: the screen's height, and the first row not yet printed on. The footer sits right under the printed
    /// rows until they reach the bottom; from then on it keeps to the bottom rows and printing scrolls.
    screen_h: Option<u16>,
    top: u16,
    /// What goes out ahead of the next frame: rows printed above the footer, a footer that moved.
    pending: Vec<u8>,
}

impl<W: Write> Terminal<W> {
    pub fn new(out: W, width: u16, height: u16) -> Terminal<W> {
        Terminal {
            out,
            front: Buffer::new(width, height),
            back: Buffer::new(width, height),
            bytes: Vec::with_capacity(64 * 1024),
            full: true,
            cursor: None,
            screen_h: None,
            top: 0,
            pending: Vec::new(),
        }
    }

    /// A footer `footer` rows tall on a screen `height` rows tall, from row `row` (the cursor's) down; the rows
    /// above are the shell's.
    pub fn inline(out: W, width: u16, height: u16, row: u16, footer: u16) -> Terminal<W> {
        let footer = footer.clamp(1, height.saturating_sub(1).max(1));
        let mut t = Terminal::new(out, width, footer);
        t.screen_h = Some(height);
        t.top = row.min(height - 1);
        t.make_room(footer);
        t
    }

    /// Scrolls up what is on screen until `rows` fit from `top` down.
    fn make_room(&mut self, rows: u16) {
        let h = self.screen_h.unwrap_or(rows);
        let over = (self.top + rows).saturating_sub(h);
        if over > 0 {
            push_move(&mut self.pending, 0, h - 1);
            self.pending.extend_from_slice(&b"\n".repeat(over as usize));
            self.top -= over;
        }
    }

    /// The frame's size; inline, the footer's.
    pub fn size(&self) -> (u16, u16) {
        (self.back.width, self.back.height)
    }

    /// The screen's size.
    pub fn screen(&self) -> (u16, u16) {
        (self.back.width, self.screen_h.unwrap_or(self.back.height))
    }

    fn origin(&self) -> u16 {
        if self.screen_h.is_some() {
            self.top
        } else {
            0
        }
    }

    pub fn resize(&mut self, width: u16, height: u16) {
        let Some(_) = self.screen_h else {
            self.front = Buffer::new(width, height);
            self.back = Buffer::new(width, height);
            self.full = true;
            return;
        };
        // The terminal reflowed what was on screen: the footer is cleared from where it now starts and drawn anew.
        self.screen_h = Some(height);
        let footer = self.back.height.min(height.saturating_sub(1).max(1));
        self.front = Buffer::new(width, footer);
        self.back = Buffer::new(width, footer);
        self.top = self.top.min(height - footer);
        push_move(&mut self.pending, 0, self.top);
        self.pending.extend_from_slice(b"\x1b[J");
        self.full = true;
    }

    /// Inline: the footer's height. Taller, the rows above scroll up when it would not fit; shorter, it gives the
    /// rows back to what is printed next.
    pub fn set_footer(&mut self, rows: u16) {
        let Some(h) = self.screen_h else { return };
        let rows = rows.clamp(1, h.saturating_sub(1).max(1));
        if rows == self.back.height {
            return;
        }
        push_move(&mut self.pending, 0, self.top);
        self.pending.extend_from_slice(b"\x1b[J");
        self.make_room(rows);
        let w = self.back.width;
        self.front = Buffer::new(w, rows);
        self.back = Buffer::new(w, rows);
        self.full = true;
    }

    /// Inline: `rows` go above the footer, into the scrollback, once. They go out with the next frame.
    pub fn print_above(&mut self, rows: &Buffer) {
        let Some(h) = self.screen_h else { return };
        let footer = self.back.height;
        if rows.height == 0 || footer >= h {
            return;
        }
        push_move(&mut self.pending, 0, self.top);
        self.pending.extend_from_slice(b"\x1b[J");
        let mut y = 0;
        while y < rows.height {
            // Into the free rows under the last printed one; with none left, scroll up as many as fit above the
            // footer and write them in the gap.
            let free = h - footer - self.top;
            let n = (rows.height - y).min(if free > 0 { free } else { h - footer });
            self.top += n;
            self.make_room(footer);
            for i in 0..n {
                push_move(&mut self.pending, 0, self.top - n + i);
                push_row(&mut self.pending, rows, y + i);
            }
            y += n;
        }
        self.full = true;
    }

    /// Inline: clears the footer and leaves the cursor where it started, so what is printed next follows the rows
    /// printed above it.
    pub fn leave(&mut self) -> io::Result<()> {
        if self.screen_h.is_none() {
            return Ok(());
        }
        let mut bytes = std::mem::take(&mut self.pending);
        push_move(&mut bytes, 0, self.origin());
        bytes.extend_from_slice(b"\x1b[0m\x1b[J\x1b[?25h");
        self.out.write_all(&bytes)?;
        self.out.flush()
    }

    /// Repaint every cell on the next frame.
    pub fn invalidate(&mut self) {
        self.full = true;
    }

    /// Draw a frame: `paint` fills a cleared buffer and returns where the cursor goes (`None` hides it).
    /// Returns the number of bytes written; 0 when the frame equals the one on screen.
    pub fn draw(&mut self, paint: impl FnOnce(&mut Buffer) -> Option<(u16, u16)>) -> io::Result<usize> {
        self.back.clear();
        let cursor = paint(&mut self.back);
        self.bytes.clear();
        self.bytes.extend_from_slice(b"\x1b[?2026h\x1b[?25l");
        let origin = self.origin();
        if self.screen_h.is_some() {
            self.bytes.append(&mut self.pending);
            if self.full {
                push_move(&mut self.bytes, 0, origin);
                self.bytes.extend_from_slice(b"\x1b[0m\x1b[J");
            }
        } else if self.full {
            self.bytes.extend_from_slice(b"\x1b[0m\x1b[2J");
        }
        if let Some(s) = self.back.scroll.filter(|_| !self.full) {
            scroll(&mut self.front, s, origin, &mut self.bytes);
        }
        let changed = diff(&self.front, &self.back, self.full, origin, &mut self.bytes);
        if !changed && cursor == self.cursor && !self.full {
            return Ok(0);
        }
        if let Some((x, y)) = cursor {
            push_move(&mut self.bytes, x, y + origin);
            self.bytes.extend_from_slice(b"\x1b[?25h");
        }
        self.bytes.extend_from_slice(b"\x1b[?2026l");
        self.out.write_all(&self.bytes)?;
        self.out.flush()?;
        std::mem::swap(&mut self.front, &mut self.back);
        self.full = false;
        self.cursor = cursor;
        Ok(self.bytes.len())
    }

    pub fn writer(&mut self) -> &mut W {
        &mut self.out
    }
}

/// Scrolls the screen's rows `s.top..s.top + s.rows` by `s.by` inside a scroll region (DECSTBM, then SU or SD),
/// and `front` with them: the rows that came in are blank, as the terminal leaves them.
fn scroll(front: &mut Buffer, s: Scroll, origin: u16, out: &mut Vec<u8>) {
    let n = s.by.unsigned_abs() as usize;
    let (top, rows, w) = (s.top as usize, s.rows as usize, front.width as usize);
    if n == 0 || n >= rows || top + rows > front.height as usize {
        return;
    }
    out.extend_from_slice(b"\x1b[0m\x1b[");
    push_num(out, (top + origin as usize + 1) as u32);
    out.push(b';');
    push_num(out, (top + rows + origin as usize) as u32);
    out.extend_from_slice(b"r\x1b[");
    push_num(out, n as u32);
    out.push(if s.by > 0 { b'S' } else { b'T' });
    out.extend_from_slice(b"\x1b[r");
    let region = &mut front.cells[top * w..(top + rows) * w];
    if s.by > 0 {
        region.rotate_left(n * w);
        region[(rows - n) * w..].fill(Cell::default());
    } else {
        region.rotate_right(n * w);
        region[..n * w].fill(Cell::default());
    }
}

/// One row of `rows`, every cell, as `diff` writes a changed one, then the attributes reset.
fn push_row(out: &mut Vec<u8>, rows: &Buffer, y: u16) {
    let w = rows.width as usize;
    let mut style: Option<Style> = None;
    for cell in &rows.cells[y as usize * w..(y as usize + 1) * w] {
        if cell.ch == '\0' {
            continue;
        }
        if style != Some(cell.style) {
            push_style(out, cell.style);
            style = Some(cell.style);
        }
        push_char(out, cell);
    }
    out.extend_from_slice(b"\x1b[0m");
}

/// Append the escapes that turn `front` into `back`, drawn from screen row `origin`. Moves the cursor only where a
/// run of changes breaks, and sets attributes only where they differ from the cell before. Returns whether any
/// cell changed.
fn diff(front: &Buffer, back: &Buffer, full: bool, origin: u16, out: &mut Vec<u8>) -> bool {
    let mut changed = false;
    let mut style: Option<Style> = None;
    let mut at: Option<(u16, u16)> = None;
    let w = back.width as usize;
    for y in 0..back.height {
        let row = y as usize * w;
        let (b_row, f_row) = (&back.cells[row..row + w], &front.cells[row..row + w]);
        if !full && b_row == f_row {
            continue;
        }
        let mut x = 0;
        while x < w {
            let cell = &b_row[x];
            if cell.ch == '\0' {
                x += 1;
                continue;
            }
            let wide = x + 1 < w && b_row[x + 1].ch == '\0';
            if !full && *cell == f_row[x] && !(wide && b_row[x + 1] != f_row[x + 1]) {
                x += 1;
                continue;
            }
            changed = true;
            let x16 = x as u16;
            if at != Some((x16, y)) {
                push_move(out, x16, y + origin);
            }
            if style != Some(cell.style) {
                push_style(out, cell.style);
                style = Some(cell.style);
            }
            push_char(out, cell);
            at = Some((x16 + if wide { 2 } else { 1 }, y));
            x += 1;
        }
    }
    if changed {
        out.extend_from_slice(b"\x1b[0m");
    }
    changed
}

fn push_char(out: &mut Vec<u8>, cell: &Cell) {
    let mut buf = [0u8; 4];
    out.extend_from_slice(cell.ch.encode_utf8(&mut buf).as_bytes());
}

fn push_num(out: &mut Vec<u8>, n: u32) {
    let mut buf = [0u8; 10];
    let mut i = buf.len();
    let mut n = n;
    loop {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    out.extend_from_slice(&buf[i..]);
}

fn push_move(out: &mut Vec<u8>, x: u16, y: u16) {
    out.extend_from_slice(b"\x1b[");
    push_num(out, y as u32 + 1);
    out.push(b';');
    push_num(out, x as u32 + 1);
    out.push(b'H');
}

fn push_color(out: &mut Vec<u8>, color: Color, base: u32) {
    match color {
        Color::Reset => push_num(out, base + 9),
        Color::Indexed(i) => {
            push_num(out, base + 8);
            out.extend_from_slice(b";5;");
            push_num(out, i as u32);
        }
        Color::Rgb(r, g, b) => {
            push_num(out, base + 8);
            out.extend_from_slice(b";2;");
            push_num(out, r as u32);
            out.push(b';');
            push_num(out, g as u32);
            out.push(b';');
            push_num(out, b as u32);
        }
    }
}

fn push_style(out: &mut Vec<u8>, style: Style) {
    out.extend_from_slice(b"\x1b[0");
    for (attr, code) in [(Attr::BOLD, 1), (Attr::DIM, 2), (Attr::ITALIC, 3), (Attr::UNDERLINE, 4), (Attr::REVERSE, 7)] {
        if style.attr.has(attr) {
            out.push(b';');
            push_num(out, code);
        }
    }
    if style.fg != Color::Reset {
        out.push(b';');
        push_color(out, style.fg, 30);
    }
    if style.bg != Color::Reset {
        out.push(b';');
        push_color(out, style.bg, 40);
    }
    out.push(b'm');
}

/// Raw mode and the alternate screen for as long as it lives; restored on drop, and on panic.
pub struct TerminalGuard;

/// Inline: no alternate screen and no mouse, so the terminal keeps its own scrollback and selection.
static INLINE: AtomicBool = AtomicBool::new(false);

impl TerminalGuard {
    pub fn enter() -> io::Result<TerminalGuard> {
        TerminalGuard::start()
    }

    /// Raw mode and bracketed paste on the screen as it is, for a [`Terminal::inline`] footer.
    pub fn enter_inline() -> io::Result<TerminalGuard> {
        INLINE.store(true, Ordering::SeqCst);
        TerminalGuard::start()
    }

    fn start() -> io::Result<TerminalGuard> {
        resume()?;
        let hook = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            restore();
            hook(info);
        }));
        Ok(TerminalGuard)
    }
}

/// Raw mode, the alternate screen, bracketed paste and the mouse: what `enter` turns on, and `resume` turns back
/// on after `suspend` (the external editor runs in between).
pub fn resume() -> io::Result<()> {
    crossterm::terminal::enable_raw_mode()?;
    if INLINE.load(Ordering::SeqCst) {
        return crossterm::execute!(io::stdout(), crossterm::event::EnableBracketedPaste);
    }
    // Through crossterm, so Windows turns on its VT processing; every frame after is raw bytes.
    crossterm::execute!(
        io::stdout(),
        crossterm::terminal::EnterAlternateScreen,
        crossterm::event::EnableBracketedPaste,
        crossterm::event::EnableMouseCapture
    )
}

/// The terminal as it was before `enter`, while the guard still lives.
pub fn suspend() {
    restore();
}

fn restore() {
    let mut out = io::stdout();
    let _ = out.write_all(b"\x1b[0m\x1b[?25h");
    if INLINE.load(Ordering::SeqCst) {
        let _ = crossterm::execute!(out, crossterm::event::DisableBracketedPaste);
        let _ = crossterm::terminal::disable_raw_mode();
        return;
    }
    let _ = crossterm::execute!(
        out,
        crossterm::event::DisableMouseCapture,
        crossterm::event::DisableBracketedPaste,
        crossterm::terminal::LeaveAlternateScreen
    );
    let _ = crossterm::terminal::disable_raw_mode();
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        restore();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(t: &mut Terminal<Vec<u8>>, s: &str) -> usize {
        t.draw(|b| {
            b.text(0, 0, 10, s, Style::default());
            None
        })
        .unwrap()
    }

    #[test]
    fn an_unchanged_frame_writes_nothing() {
        let mut t = Terminal::new(Vec::new(), 10, 2);
        assert!(hello(&mut t, "hello") > 0);
        assert_eq!(hello(&mut t, "hello"), 0);
    }

    #[test]
    fn inline_the_footer_draws_on_the_bottom_rows_and_printed_rows_scroll_up_above_it() {
        // The shell's prompt was on row 2 of 5: the footer goes under it, and nothing scrolls yet.
        let mut t = Terminal::inline(Vec::new(), 4, 5, 1, 2);
        hello(&mut t, "ab");
        let s = String::from_utf8(std::mem::take(t.writer())).unwrap();
        assert!(s.starts_with("\x1b[?2026h\x1b[?25l\x1b[2;1H\x1b[0m\x1b[J"), "{s:?}");
        assert!(s.contains("\x1b[2;1H\x1b[0mab"), "{s:?}");
        let mut rows = Buffer::new(4, 2);
        rows.text(0, 0, 4, "one", Style::default());
        rows.text(0, 1, 4, "two", Style::default());
        t.print_above(&rows);
        hello(&mut t, "ab");
        let s = String::from_utf8(std::mem::take(t.writer())).unwrap();
        // Two free rows: the footer clears, the rows go where it was, and it moves down under them.
        assert!(s.starts_with("\x1b[?2026h\x1b[?25l\x1b[2;1H\x1b[J\x1b[2;1H\x1b[0mone \x1b[0m\x1b[3;1H\x1b[0mtwo \x1b[0m"), "{s:?}");
        assert!(s.contains("\x1b[4;1H\x1b[0mab"), "the footer is on the bottom rows now: {s:?}");
        t.print_above(&rows);
        hello(&mut t, "ab");
        let s = String::from_utf8(std::mem::take(t.writer())).unwrap();
        // None free: scroll two at the bottom, write them in the gap.
        assert!(s.starts_with("\x1b[?2026h\x1b[?25l\x1b[4;1H\x1b[J\x1b[5;1H\n\n\x1b[2;1H\x1b[0mone \x1b[0m\x1b[3;1H\x1b[0mtwo \x1b[0m"), "{s:?}");
        // More rows than fit above the footer go up in turns.
        t.print_above(&Buffer::new(4, 7));
        assert_eq!(String::from_utf8_lossy(&t.pending).matches("\x1b[5;1H").count(), 3, "3 + 3 + 1");
        hello(&mut t, "ab");
        t.writer().clear();
        t.set_footer(3);
        hello(&mut t, "ab");
        assert!(String::from_utf8(std::mem::take(t.writer())).unwrap().contains("\x1b[3;1H\x1b[0mab"), "a taller footer starts higher");
        t.set_footer(1);
        hello(&mut t, "ab");
        assert!(String::from_utf8(std::mem::take(t.writer())).unwrap().contains("\x1b[3;1H\x1b[0mab"), "a shorter one stays under the rows");
    }

    #[test]
    fn a_scroll_hint_moves_the_rows_in_place_and_writes_only_the_new_one() {
        let lines = ["a", "b", "c", "d"];
        let mut t = Terminal::new(Vec::new(), 4, 4);
        let frame = |t: &mut Terminal<Vec<u8>>, from: usize, by: Option<i32>| {
            t.draw(|b| {
                for y in 0..3 {
                    b.text(0, y, 4, lines[from + y as usize], Style::default());
                }
                b.scroll = by.map(|by| Scroll { top: 0, rows: 3, by });
                None
            })
            .unwrap();
            String::from_utf8(std::mem::take(t.writer())).unwrap()
        };
        frame(&mut t, 0, None);
        let s = frame(&mut t, 1, Some(1));
        assert_eq!(s, "\x1b[?2026h\x1b[?25l\x1b[0m\x1b[1;3r\x1b[1S\x1b[r\x1b[3;1H\x1b[0md\x1b[0m\x1b[?2026l", "{s:?}");
        let s = frame(&mut t, 0, Some(-1));
        assert!(s.contains("\x1b[1T") && s.contains("\x1b[1;1H\x1b[0ma") && !s.contains('b'), "{s:?}");
    }

    #[test]
    fn a_one_cell_change_writes_one_move_and_one_cell() {
        let mut t = Terminal::new(Vec::new(), 10, 2);
        hello(&mut t, "hello");
        t.writer().clear();
        hello(&mut t, "hallo");
        let s = String::from_utf8(t.writer().clone()).unwrap();
        assert_eq!(s, "\x1b[?2026h\x1b[?25l\x1b[1;2H\x1b[0ma\x1b[0m\x1b[?2026l");
    }
}
