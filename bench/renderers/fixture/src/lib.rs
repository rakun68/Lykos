//! The renderer benchmark's fixture screen (ticket #33): the same content and the same input handling for every
//! renderer, so only the drawing differs. A long transcript with a diff in it, in one large bordered box; a prompt
//! box being typed; a status line. `BENCH_STREAM=<frames>` streams tokens into the transcript and records each
//! frame's time (paint, diff and write) to `BENCH_OUT`, then exits.

use std::time::{Duration, Instant};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Text,
    User,
    Add,
    Del,
    Hunk,
    Code,
}

pub struct Fixture {
    pub lines: Vec<(String, Kind)>,
    pub prompt: String,
    pub status: String,
    width: usize,
}

const WORDS: &[&str] = &[
    "the", "engine", "streams", "tokens", "into", "a", "box", "while", "keys", "arrive", "and", "every", "frame",
    "is", "diffed", "against", "last", "one", "so", "only", "changed", "cells", "reach", "terminal",
];

impl Fixture {
    pub fn new(width: usize) -> Fixture {
        let mut lines = Vec::with_capacity(2200);
        let mut seed: u32 = 7;
        let mut next = move || {
            seed ^= seed << 13;
            seed ^= seed >> 17;
            seed ^= seed << 5;
            seed
        };
        for turn in 0..40 {
            lines.push((format!("> question {turn}: why is the frame time what it is?"), Kind::User));
            for _ in 0..40 {
                let n = 6 + (next() % 14) as usize;
                let line: Vec<&str> = (0..n).map(|_| WORDS[(next() as usize) % WORDS.len()]).collect();
                lines.push((line.join(" "), Kind::Text));
            }
            if turn % 4 == 0 {
                lines.push((format!("@@ -{},7 +{},9 @@ fn render()", turn * 10, turn * 10), Kind::Hunk));
                for i in 0..12 {
                    let kind = match i % 3 {
                        0 => Kind::Del,
                        1 => Kind::Add,
                        _ => Kind::Code,
                    };
                    let sign = match kind {
                        Kind::Del => '-',
                        Kind::Add => '+',
                        _ => ' ',
                    };
                    lines.push((format!("{sign}    let cell = buffer.get(x, y); // line {i}"), kind));
                }
            }
        }
        Fixture {
            lines,
            prompt: String::new(),
            status: "anthropic/claude-opus-5-5  ctx 41.2k/200k 21%  effort high  READY".to_string(),
            width,
        }
    }

    /// Lines that fit in `height` rows of the transcript box, newest last.
    pub fn visible(&self, height: usize) -> &[(String, Kind)] {
        let start = self.lines.len().saturating_sub(height);
        &self.lines[start..]
    }

    /// One streamed token, appended to the last line, which wraps at the box's inner width.
    pub fn stream(&mut self, i: usize) {
        let token = WORDS[i % WORDS.len()];
        let inner = self.width.saturating_sub(4).max(10);
        match self.lines.last_mut() {
            Some((line, Kind::Text)) if line.len() + token.len() + 1 <= inner => {
                line.push(' ');
                line.push_str(token);
            }
            _ => self.lines.push((token.to_string(), Kind::Text)),
        }
    }

    pub fn resize(&mut self, width: usize) {
        self.width = width;
    }
}

/// What the variant's main loop does with an input event.
pub enum Action {
    Redraw,
    Quit,
    None,
}

pub fn key(f: &mut Fixture, ev: crossterm_event::Event) -> Action {
    use crossterm_event::{Event, KeyCode, KeyEventKind, KeyModifiers};
    match ev {
        Event::Key(k) if k.kind != KeyEventKind::Release => match k.code {
            KeyCode::Esc => Action::Quit,
            KeyCode::Char('c') if k.modifiers.contains(KeyModifiers::CONTROL) => Action::Quit,
            KeyCode::Char(c) => {
                f.prompt.push(c);
                Action::Redraw
            }
            KeyCode::Backspace => {
                f.prompt.pop();
                Action::Redraw
            }
            KeyCode::Enter => {
                let text = std::mem::take(&mut f.prompt);
                f.lines.push((format!("> {text}"), Kind::User));
                Action::Redraw
            }
            _ => Action::None,
        },
        Event::Resize(w, _) => {
            f.resize(w as usize);
            Action::Redraw
        }
        Event::Paste(s) => {
            f.prompt.push_str(&s);
            Action::Redraw
        }
        _ => Action::None,
    }
}

/// `BENCH_STREAM` frames, each timed with `draw`; the times go to `BENCH_OUT` as microseconds, one per line.
pub fn stream_bench(f: &mut Fixture, mut draw: impl FnMut(&Fixture)) -> bool {
    let Some(frames) = std::env::var("BENCH_STREAM").ok().and_then(|v| v.parse::<usize>().ok()) else {
        return false;
    };
    let mut times = Vec::with_capacity(frames);
    for i in 0..frames {
        f.stream(i);
        let t = Instant::now();
        draw(f);
        times.push(t.elapsed().as_micros());
        std::thread::sleep(Duration::from_millis(1));
    }
    if let Ok(path) = std::env::var("BENCH_OUT") {
        let text: Vec<String> = times.iter().map(|t| t.to_string()).collect();
        let _ = std::fs::write(path, text.join("\n"));
    }
    true
}

pub use crossterm as crossterm_reexport;
pub mod crossterm_event {
    pub use crossterm::event::*;
}
