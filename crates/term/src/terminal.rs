use std::io::{self, Write};

use crate::buffer::{Attr, Buffer, Cell, Color, Style};

/// The screen: the frame on it, and the bytes of the next one. One `write` per frame.
pub struct Terminal<W: Write> {
    out: W,
    front: Buffer,
    back: Buffer,
    bytes: Vec<u8>,
    /// The first frame, and the one after a resize, repaints every cell.
    full: bool,
    cursor: Option<(u16, u16)>,
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
        }
    }

    pub fn size(&self) -> (u16, u16) {
        (self.back.width, self.back.height)
    }

    pub fn resize(&mut self, width: u16, height: u16) {
        self.front = Buffer::new(width, height);
        self.back = Buffer::new(width, height);
        self.full = true;
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
        if self.full {
            self.bytes.extend_from_slice(b"\x1b[0m\x1b[2J");
        }
        let changed = diff(&self.front, &self.back, self.full, &mut self.bytes);
        if !changed && cursor == self.cursor && !self.full {
            return Ok(0);
        }
        if let Some((x, y)) = cursor {
            push_move(&mut self.bytes, x, y);
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

/// Append the escapes that turn `front` into `back`. Moves the cursor only where a run of changes breaks,
/// and sets attributes only where they differ from the cell before. Returns whether any cell changed.
fn diff(front: &Buffer, back: &Buffer, full: bool, out: &mut Vec<u8>) -> bool {
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
        for x in 0..w {
            let cell = &b_row[x];
            if cell.ch == '\0' {
                continue;
            }
            let wide = x + 1 < w && b_row[x + 1].ch == '\0';
            if !full && *cell == f_row[x] && !(wide && b_row[x + 1] != f_row[x + 1]) {
                continue;
            }
            changed = true;
            let x16 = x as u16;
            if at != Some((x16, y)) {
                push_move(out, x16, y);
            }
            if style != Some(cell.style) {
                push_style(out, cell.style);
                style = Some(cell.style);
            }
            push_char(out, cell);
            at = Some((x16 + if wide { 2 } else { 1 }, y));
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

impl TerminalGuard {
    pub fn enter() -> io::Result<TerminalGuard> {
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
    fn a_one_cell_change_writes_one_move_and_one_cell() {
        let mut t = Terminal::new(Vec::new(), 10, 2);
        hello(&mut t, "hello");
        t.writer().clear();
        hello(&mut t, "hallo");
        let s = String::from_utf8(t.writer().clone()).unwrap();
        assert_eq!(s, "\x1b[?2026h\x1b[?25l\x1b[1;2H\x1b[0ma\x1b[0m\x1b[?2026l");
    }
}
