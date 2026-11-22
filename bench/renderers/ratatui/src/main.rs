//! The fixture screen on ratatui 0.30 with crossterm 0.29.
use std::io::{self, BufWriter, Write};

use crossterm::{event, execute, terminal};
use fixture::{Action, Fixture, Kind};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Layout, Position};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Paragraph};
use ratatui::{Frame, Terminal};

fn style(kind: Kind) -> Style {
    match kind {
        Kind::Text => Style::default(),
        Kind::User => Style::default().fg(Color::Indexed(12)).add_modifier(Modifier::BOLD),
        Kind::Add => Style::default().fg(Color::Indexed(2)).bg(Color::Rgb(16, 40, 16)),
        Kind::Del => Style::default().fg(Color::Indexed(1)).bg(Color::Rgb(48, 16, 16)),
        Kind::Hunk => Style::default().fg(Color::Indexed(6)),
        Kind::Code => Style::default().fg(Color::Indexed(8)),
    }
}

fn paint(f: &Fixture, frame: &mut Frame) {
    let area = frame.area();
    if area.height < 6 || area.width < 10 {
        return;
    }
    let [chat, prompt, status] = Layout::vertical([Constraint::Min(3), Constraint::Length(3), Constraint::Length(1)]).areas(area);
    let lines: Vec<Line> = f
        .visible(chat.height.saturating_sub(2) as usize)
        .iter()
        .map(|(l, k)| Line::from(Span::styled(l.as_str(), style(*k))))
        .collect();
    let block = Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(Style::default().fg(Color::Indexed(8))).padding(ratatui::widgets::Padding::horizontal(1));
    frame.render_widget(Paragraph::new(lines).block(block), chat);
    let pblock = Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(Style::default().fg(Color::Indexed(4))).padding(ratatui::widgets::Padding::horizontal(1));
    frame.render_widget(Paragraph::new(f.prompt.as_str()).block(pblock), prompt);
    frame.render_widget(Paragraph::new(Span::styled(format!(" {}", f.status), Style::default().fg(Color::Indexed(8)))), status);
    let w = unicode_width(&f.prompt);
    frame.set_cursor_position(Position::new((prompt.x + 2 + w).min(prompt.right().saturating_sub(2)), prompt.y + 1));
}

fn unicode_width(s: &str) -> u16 {
    ratatui::text::Line::from(s).width() as u16
}

fn main() -> io::Result<()> {
    let (w, _) = terminal::size()?;
    let mut f = Fixture::new(w as usize);
    terminal::enable_raw_mode()?;
    let mut out = io::stdout();
    execute!(out, terminal::EnterAlternateScreen, event::EnableBracketedPaste)?;
    let mut term = Terminal::new(CrosstermBackend::new(BufWriter::with_capacity(1 << 16, io::stdout())))?;
    term.draw(|frame| paint(&f, frame))?;
    let streamed = fixture::stream_bench(&mut f, |f| {
        let _ = term.draw(|frame| paint(f, frame));
    });
    if !streamed {
        loop {
            let ev = event::read()?;
            if let event::Event::Resize(..) = ev {
                term.autoresize()?;
            }
            match fixture::key(&mut f, ev) {
                Action::Quit => break,
                Action::Redraw => {
                    term.draw(|frame| paint(&f, frame))?;
                }
                Action::None => {}
            }
        }
    }
    drop(term);
    execute!(out, event::DisableBracketedPaste, terminal::LeaveAlternateScreen)?;
    terminal::disable_raw_mode()?;
    out.flush()
}
