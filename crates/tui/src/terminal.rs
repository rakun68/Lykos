//! The terminal pane (P5 #48): OpenCode's `component/terminal-pane.tsx`, `context/session-terminals.tsx` and the
//! right pane of `component/session-frame.tsx` at `4332e24`, on a local pseudo-terminal (`pty.rs`, ConPTY on
//! Windows) whose output a vt100 parser keeps as a screen.
//!
//! OpenCode's terminals live on its server, one list per session, and survive the TUI. Lykos's live in the TUI, one
//! list for every session, and end with it.
use std::cell::Cell as Shared;
use std::io::{Read, Write};
use std::num::NonZeroU16;
use std::sync::Arc;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lykos_term::{Attr, Buffer, Cell, Color, Style};

use crate::app::App;
use crate::pty::Pty;
use crate::theme::{self, c};

/// Where a terminal's output goes: `Some(bytes)` as it comes, `None` once its shell has exited.
pub type Sink = Arc<dyn Fn(u64, Option<Vec<u8>>) + Send + Sync>;

/// `ui/layout.ts`: `SESSION_CONTENT_PREFERRED_WIDTH + SESSION_CONTENT_MIN_WIDTH`. Narrower, the pane takes the screen.
pub const SPLIT_MIN_WIDTH: u16 = 64 + 44;
const SCROLLBACK: usize = 1000;
/// The pane's header row: the terminal's title.
const HEADER: u16 = 1;

/// The title the shell sets (OSC 0 or 2).
#[derive(Default)]
pub struct Title(Option<String>);

impl vt100::Callbacks for Title {
    fn set_window_title(&mut self, _: &mut vt100::Screen, title: &[u8]) {
        self.0 = Some(String::from_utf8_lossy(title).into_owned());
    }
}

pub struct Term {
    pub id: u64,
    program: String,
    parser: vt100::Parser<Title>,
    /// Dropping it ends the shell.
    pty: Pty,
    size: (u16, u16),
}

/// The user's shell: PowerShell on Windows (a `$SHELL` there is an MSYS path ConPTY cannot start), else `$SHELL`,
/// else `/bin/sh`.
fn shell() -> String {
    if cfg!(windows) {
        return "powershell.exe".into();
    }
    std::env::var("SHELL").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "/bin/sh".into())
}

fn nz(n: u16) -> NonZeroU16 {
    NonZeroU16::new(n.max(1)).unwrap_or(NonZeroU16::MIN)
}

impl Term {
    /// Starts the shell in `cwd` on a pseudo-terminal of `cols` by `rows`. Two threads feed `sink`: one reads the
    /// output, one waits for the shell to exit (ConPTY keeps its output open after the shell is gone).
    pub fn spawn(id: u64, cwd: &str, cols: u16, rows: u16, sink: Sink) -> Result<Term, String> {
        let program = shell();
        let (pty, mut reader, waiter) = Pty::spawn(&program, cwd, cols, rows).map_err(|e| format!("{program}: {e}"))?;
        let out = sink.clone();
        std::thread::Builder::new()
            .name("lykos-pty-read".into())
            .spawn(move || {
                let mut buf = vec![0u8; 16 * 1024];
                while let Ok(n) = reader.read(&mut buf) {
                    if n == 0 {
                        return;
                    }
                    out(id, Some(buf[..n].to_vec()));
                }
            })
            .map_err(|e| e.to_string())?;
        std::thread::Builder::new()
            .name("lykos-pty-wait".into())
            .spawn(move || {
                waiter.wait();
                sink(id, None);
            })
            .map_err(|e| e.to_string())?;
        let parser = vt100::Parser::new_with_callbacks(nz(rows), nz(cols), SCROLLBACK, Title::default());
        Ok(Term { id, program, parser, pty, size: (cols, rows) })
    }

    /// `terminals-tab.tsx`: what the shell calls itself, else the shell's name.
    pub fn title(&self) -> String {
        if let Some(t) = self.parser.callbacks().0.as_ref().filter(|t| !t.trim().is_empty()) {
            return t.clone();
        }
        let name = self.program.rsplit(['/', '\\']).next().unwrap_or(&self.program);
        name.strip_suffix(".exe").unwrap_or(name).to_string()
    }

    /// The shell's output. A cursor position request (`ESC[6n`, which ConPTY sends first and waits on) is answered
    /// as a terminal would.
    pub fn output(&mut self, bytes: &[u8]) {
        let mut rest = bytes;
        while let Some(at) = rest.windows(4).position(|w| w == b"\x1b[6n") {
            self.parser.process(&rest[..at]);
            let (row, col) = self.parser.screen().cursor_position();
            self.write(format!("\x1b[{};{}R", row + 1, col + 1).as_bytes());
            rest = &rest[at + 4..];
        }
        self.parser.process(rest);
    }

    pub fn write(&mut self, bytes: &[u8]) {
        let _ = self.pty.writer.write_all(bytes);
        let _ = self.pty.writer.flush();
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        if self.size == (cols, rows) || cols == 0 || rows == 0 {
            return;
        }
        self.size = (cols, rows);
        self.parser.set_size(nz(rows), nz(cols));
        self.pty.resize(cols, rows);
    }

    pub fn key(&mut self, key: &KeyEvent) {
        let bytes = encode(key, self.parser.screen().application_cursor());
        if !bytes.is_empty() {
            self.write(&bytes);
        }
    }

    pub fn paste(&mut self, text: &str) {
        if self.parser.screen().bracketed_paste() {
            self.write(format!("\x1b[200~{text}\x1b[201~").as_bytes());
        } else {
            self.write(text.as_bytes());
        }
    }

    /// The screen at (x, y); returns the cursor's place unless the shell hid it.
    pub fn draw(&self, buf: &mut Buffer, x: u16, y: u16, width: u16, height: u16) -> Option<(u16, u16)> {
        let screen = self.parser.screen();
        for row in 0..height.min(self.size.1) {
            for col in 0..width.min(self.size.0) {
                let Some(cell) = screen.cell(row, col) else { continue };
                let ch = if cell.is_wide_continuation() { '\0' } else { cell.contents().chars().next().unwrap_or(' ') };
                let mut attr = Attr::NONE;
                for (on, a) in [(cell.bold(), Attr::BOLD), (cell.dim(), Attr::DIM), (cell.italic(), Attr::ITALIC), (cell.underline(), Attr::UNDERLINE), (cell.inverse(), Attr::REVERSE)] {
                    if on {
                        attr = attr.with(a);
                    }
                }
                buf.set(x + col, y + row, Cell { ch, style: Style { fg: color(cell.fgcolor()), bg: color(cell.bgcolor()), attr } });
            }
        }
        let (row, col) = screen.cursor_position();
        (!screen.hide_cursor() && row < height && col < width).then_some((x + col, y + row))
    }
}

fn color(c: vt100::Color) -> Color {
    match c {
        vt100::Color::Default => Color::Reset,
        vt100::Color::Idx(i) => Color::Indexed(i),
        vt100::Color::Rgb(r, g, b) => Color::Rgb(r, g, b),
    }
}

/// A key as an xterm sends it.
pub fn encode(key: &KeyEvent, app_cursor: bool) -> Vec<u8> {
    let m = key.modifiers;
    let (ctrl, alt, shift) = (m.contains(KeyModifiers::CONTROL), m.contains(KeyModifiers::ALT), m.contains(KeyModifiers::SHIFT));
    // xterm's modifier parameter: 1 + shift + 2 alt + 4 ctrl.
    let param = 1 + u8::from(shift) + 2 * u8::from(alt) + 4 * u8::from(ctrl);
    let csi = |end: char| -> Vec<u8> {
        if param > 1 {
            format!("\x1b[1;{param}{end}").into_bytes()
        } else if app_cursor && "ABCDHF".contains(end) {
            format!("\x1bO{end}").into_bytes()
        } else {
            format!("\x1b[{end}").into_bytes()
        }
    };
    let tilde = |n: u8| -> Vec<u8> { if param > 1 { format!("\x1b[{n};{param}~").into_bytes() } else { format!("\x1b[{n}~").into_bytes() } };
    let mut out = match key.code {
        KeyCode::Char(ch) if ctrl => {
            let b = match ch.to_ascii_lowercase() {
                c @ 'a'..='z' => c as u8 - b'a' + 1,
                '@' | ' ' | '2' => 0,
                '[' | '3' => 0x1b,
                '\\' | '4' => 0x1c,
                ']' | '5' => 0x1d,
                '^' | '6' => 0x1e,
                '_' | '-' | '7' => 0x1f,
                '8' | '?' => 0x7f,
                _ => return Vec::new(),
            };
            vec![b]
        }
        KeyCode::Char(ch) => ch.to_string().into_bytes(),
        KeyCode::Enter => vec![b'\r'],
        KeyCode::Tab => vec![b'\t'],
        KeyCode::BackTab => return b"\x1b[Z".to_vec(),
        KeyCode::Backspace => vec![if ctrl { 0x08 } else { 0x7f }],
        KeyCode::Esc => vec![0x1b],
        KeyCode::Up => return csi('A'),
        KeyCode::Down => return csi('B'),
        KeyCode::Right => return csi('C'),
        KeyCode::Left => return csi('D'),
        KeyCode::Home => return csi('H'),
        KeyCode::End => return csi('F'),
        KeyCode::Insert => return tilde(2),
        KeyCode::Delete => return tilde(3),
        KeyCode::PageUp => return tilde(5),
        KeyCode::PageDown => return tilde(6),
        KeyCode::F(n @ 1..=4) => return if param > 1 { format!("\x1b[1;{param}{}", (b'O' + n) as char).into_bytes() } else { vec![0x1b, b'O', b'O' + n] },
        KeyCode::F(n @ 5..=12) => return tilde([15, 17, 18, 19, 20, 21, 23, 24][(n - 5) as usize]),
        _ => return Vec::new(),
    };
    if alt {
        out.insert(0, 0x1b);
    }
    out
}

/// The open terminals, the one the pane shows, and whether the pane has the keys.
#[derive(Default)]
pub struct Terms {
    pub list: Vec<Term>,
    pub visible: Option<usize>,
    pub focused: bool,
    next: u64,
    /// Where the pane was last drawn: x, y, width, height.
    pub area: Shared<Option<(u16, u16, u16, u16)>>,
}

impl Terms {
    pub fn is_empty(&self) -> bool {
        self.list.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &Term> {
        self.list.iter()
    }

    pub fn next_id(&mut self) -> u64 {
        self.next += 1;
        self.next
    }

    /// A new terminal, shown and focused (`newTerminal` selects it).
    pub fn add(&mut self, t: Term) {
        self.list.push(t);
        self.visible = Some(self.list.len() - 1);
        self.focused = true;
    }

    pub fn shown(&mut self) -> Option<&mut Term> {
        self.list.get_mut(self.visible?)
    }

    pub fn output(&mut self, id: u64, bytes: &[u8]) {
        if let Some(t) = self.list.iter_mut().find(|t| t.id == id) {
            t.output(bytes);
        }
    }

    /// Its shell exited: the terminal goes, and the pane with it if it showed it (`refresh` drops a selection that
    /// is gone).
    pub fn exited(&mut self, id: u64) {
        let Some(i) = self.list.iter().position(|t| t.id == id) else { return };
        self.list.remove(i);
        self.visible = match self.visible {
            Some(v) if v == i => None,
            Some(v) if v > i => Some(v - 1),
            v => v,
        };
        if self.visible.is_none() {
            self.focused = false;
        }
    }
}

/// The pane's place, x and width, while it shows: beside the session from `SPLIT_MIN_WIDTH` (half the screen,
/// `clampSessionPaneWidth`'s default), else over it. The diff viewer and a sidebar opened by hand take the right
/// pane first (`session-frame.tsx`: the sidebar wins only when it was opened explicitly).
pub fn pane(app: &App, w: u16) -> Option<(u16, u16)> {
    if app.mini || app.diff.is_some() || app.side.open {
        return None;
    }
    app.terms.list.get(app.terms.visible?)?;
    Some(if w >= SPLIT_MIN_WIDTH { (w - w / 2, w / 2) } else { (0, w) })
}

/// The pseudo-terminal's size in a pane of this width on a screen this tall: a separator column when docked, and
/// the header row.
pub fn content_size(x: u16, width: u16, h: u16) -> (u16, u16) {
    (width.saturating_sub(u16::from(x > 0)).max(1), h.saturating_sub(HEADER).max(1))
}

/// The size a new terminal starts at on this screen.
pub fn size_for(w: u16, h: u16) -> (u16, u16) {
    if w >= SPLIT_MIN_WIDTH {
        content_size(w - w / 2, w / 2, h)
    } else {
        content_size(0, w, h)
    }
}

/// The pane: a separator, a header with the title, and the screen. Returns the cursor while the pane has the keys.
pub fn draw(app: &App, buf: &mut Buffer) -> Option<(u16, u16)> {
    let (w, h) = (buf.width, buf.height);
    app.terms.area.set(None);
    let (x, width) = pane(app, w)?;
    let t = app.terms.list.get(app.terms.visible?)?;
    buf.fill(x, 0, width, h, Style::default());
    let cx = x + u16::from(x > 0);
    if x > 0 {
        for y in 0..h {
            buf.set(x, y, Cell { ch: '│', style: Style::fg(c().overlay) });
        }
    }
    let (cols, rows) = content_size(x, width, h);
    let focused = app.terms.focused;
    let title = t.title();
    let style = if focused { theme::text().bold() } else { theme::muted() };
    let end = buf.text(cx + 1, 0, cols.saturating_sub(2), &title, style);
    if !focused {
        let hint = format!("  {} focus", app.keymap.first("pane.focus.right"));
        buf.text(end, 0, (cx + cols).saturating_sub(end), &hint, theme::muted());
    }
    app.terms.area.set(Some((x, 0, width, h)));
    let cursor = t.draw(buf, cx, HEADER, cols, rows);
    cursor.filter(|_| focused)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode, m: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, m)
    }

    #[test]
    fn keys_are_sent_as_xterm_sends_them() {
        assert_eq!(encode(&key(KeyCode::Char('a'), KeyModifiers::NONE), false), b"a");
        assert_eq!(encode(&key(KeyCode::Char('c'), KeyModifiers::CONTROL), false), vec![3]);
        assert_eq!(encode(&key(KeyCode::Char('b'), KeyModifiers::ALT), false), b"\x1bb");
        assert_eq!(encode(&key(KeyCode::Up, KeyModifiers::NONE), false), b"\x1b[A");
        assert_eq!(encode(&key(KeyCode::Up, KeyModifiers::NONE), true), b"\x1bOA");
        assert_eq!(encode(&key(KeyCode::Right, KeyModifiers::CONTROL), true), b"\x1b[1;5C");
        assert_eq!(encode(&key(KeyCode::Delete, KeyModifiers::NONE), false), b"\x1b[3~");
        assert_eq!(encode(&key(KeyCode::Enter, KeyModifiers::NONE), false), b"\r");
        assert_eq!(encode(&key(KeyCode::F(5), KeyModifiers::NONE), false), b"\x1b[15~");
    }

    #[test]
    fn the_pane_docks_at_half_the_width_and_covers_a_narrow_screen() {
        assert_eq!(size_for(120, 40), (59, 39));
        assert_eq!(size_for(80, 30), (80, 29));
    }

    #[test]
    fn a_shell_runs_in_the_pane_and_its_exit_removes_it() {
        let (tx, rx) = std::sync::mpsc::channel::<(u64, Option<Vec<u8>>)>();
        let tx = std::sync::Mutex::new(tx);
        let sink: Sink = Arc::new(move |id, data| {
            let _ = tx.lock().map(|t| t.send((id, data)));
        });
        let dir = std::env::temp_dir();
        let mut terms = Terms::default();
        let id = terms.next_id();
        let t = Term::spawn(id, &dir.display().to_string(), 80, 24, sink).expect("a shell starts");
        terms.add(t);
        assert_eq!(terms.visible, Some(0));
        assert!(terms.focused);
        terms.shown().unwrap().write(b"echo lykos-pane-$((40+2))\r");
        let end = std::time::Instant::now() + std::time::Duration::from_secs(20);
        let mut seen = String::new();
        // PowerShell does not expand `$((…))`; it echoes `lykos-pane-` either way.
        while !seen.contains("lykos-pane-") && std::time::Instant::now() < end {
            if let Ok((id, Some(bytes))) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                terms.output(id, &bytes);
                seen = terms.list[0].parser.screen().contents();
            }
        }
        assert!(seen.contains("lykos-pane-"), "{seen}");
        terms.shown().unwrap().write(b"exit\r");
        let mut gone = false;
        while !gone && std::time::Instant::now() < end {
            if let Ok((id, None)) = rx.recv_timeout(std::time::Duration::from_millis(200)) {
                terms.exited(id);
                gone = true;
            }
        }
        assert!(gone, "the shell's exit is reported");
        assert!(terms.is_empty());
        assert_eq!(terms.visible, None);
        assert!(!terms.focused);
    }
}
