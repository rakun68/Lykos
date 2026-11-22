//! The fixture screen on Lykos's own renderer (`crates/term`).
use std::io::{self, BufWriter};

use crossterm::event;
use fixture::{Action, Fixture, Kind};
use lykos_term::{Buffer, Color, Style, Terminal, TerminalGuard};

fn style(kind: Kind) -> Style {
    match kind {
        Kind::Text => Style::default(),
        Kind::User => Style::fg(Color::Indexed(12)).bold(),
        Kind::Add => Style::fg(Color::Indexed(2)).on(Color::Rgb(16, 40, 16)),
        Kind::Del => Style::fg(Color::Indexed(1)).on(Color::Rgb(48, 16, 16)),
        Kind::Hunk => Style::fg(Color::Indexed(6)),
        Kind::Code => Style::fg(Color::Indexed(8)),
    }
}

fn paint(f: &Fixture, b: &mut Buffer) -> Option<(u16, u16)> {
    let (w, h) = (b.width, b.height);
    if h < 6 || w < 10 {
        return None;
    }
    let border = Style::fg(Color::Indexed(8));
    let chat_h = h - 4;
    b.border(0, 0, w, chat_h, border);
    for (i, (line, kind)) in f.visible((chat_h - 2) as usize).iter().enumerate() {
        b.text(2, 1 + i as u16, w - 4, line, style(*kind));
    }
    b.border(0, chat_h, w, 3, Style::fg(Color::Indexed(4)));
    let end = b.text(2, chat_h + 1, w - 4, &f.prompt, Style::default());
    b.text(1, h - 1, w - 2, &f.status, Style::fg(Color::Indexed(8)));
    Some((end, chat_h + 1))
}

fn main() -> io::Result<()> {
    let (w, h) = crossterm::terminal::size()?;
    let mut f = Fixture::new(w as usize);
    let _guard = TerminalGuard::enter()?;
    let mut term = Terminal::new(BufWriter::with_capacity(1 << 16, io::stdout()), w, h);
    term.draw(|b| paint(&f, b))?;
    if fixture::stream_bench(&mut f, |f| {
        let _ = term.draw(|b| paint(f, b));
    }) {
        return Ok(());
    }
    loop {
        let ev = event::read()?;
        if let event::Event::Resize(w, h) = ev {
            term.resize(w, h);
        }
        match fixture::key(&mut f, ev) {
            Action::Quit => return Ok(()),
            Action::Redraw => {
                term.draw(|b| paint(&f, b))?;
            }
            Action::None => {}
        }
    }
}
