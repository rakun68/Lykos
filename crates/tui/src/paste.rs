//! Pastes on Windows. crossterm reads Windows console input records, and ConPTY strips the terminal's bracketed
//! paste markers, so a paste arrives as one key event per character and each of its lines would submit. A paste
//! is told from typing by its speed: character keys already waiting in the input buffer when one is read came in
//! together, which no typist does. Such a run is one `Event::Paste`, with its returns as newlines. Elsewhere
//! crossterm parses the markers and this is not used.
use std::io;
use std::time::Duration;

use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};

/// The character a key event adds to a paste: a press with no modifier but shift (or AltGr, ctrl and alt).
pub fn plain(ev: &Event) -> Option<char> {
    let Event::Key(k) = ev else { return None };
    if k.kind == KeyEventKind::Release {
        return None;
    }
    let (ctrl, alt) = (k.modifiers.contains(KeyModifiers::CONTROL), k.modifiers.contains(KeyModifiers::ALT));
    if ctrl != alt {
        return None;
    }
    match k.code {
        KeyCode::Char(c) => Some(c),
        KeyCode::Enter if !ctrl => Some('\n'),
        KeyCode::Tab if !ctrl => Some('\t'),
        _ => None,
    }
}

fn is_release(ev: &Event) -> bool {
    matches!(ev, Event::Key(k) if k.kind == KeyEventKind::Release)
}

/// Once two keys came together, how long the next may take: ConPTY hands a large paste over in chunks.
const BURST_GAP: Duration = Duration::from_millis(15);

/// Folds `first` and the events behind it into a paste when two or more character keys came in together.
/// `next(keys)` gives the next event, given how many character keys came so far, or `None`.
pub fn gather(first: Event, mut next: impl FnMut(usize) -> io::Result<Option<Event>>) -> io::Result<Vec<Event>> {
    let Some(c) = plain(&first) else { return Ok(vec![first]) };
    let mut text = String::from(c);
    let mut keys = 1;
    let mut tail = None;
    while let Some(ev) = next(keys)? {
        if is_release(&ev) {
            continue;
        }
        match plain(&ev) {
            Some(c) => {
                text.push(c);
                keys += 1;
            }
            None => {
                tail = Some(ev);
                break;
            }
        }
    }
    let mut out = if keys == 1 { vec![first] } else { vec![Event::Paste(text)] };
    out.extend(tail);
    Ok(out)
}

/// Reads what is already waiting; inside a burst, what comes within `BURST_GAP`. A key typed alone waits for nothing.
pub fn waiting(keys: usize) -> io::Result<Option<Event>> {
    if crossterm::event::poll(if keys >= 2 { BURST_GAP } else { Duration::ZERO })? {
        crossterm::event::read().map(Some)
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEvent;

    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }

    fn release(code: KeyCode) -> Event {
        let mut k = KeyEvent::new(code, KeyModifiers::NONE);
        k.kind = KeyEventKind::Release;
        Event::Key(k)
    }

    fn run(events: Vec<Event>) -> Vec<Event> {
        let mut it = events.into_iter();
        let first = it.next().unwrap();
        gather(first, |_| Ok(it.next())).unwrap()
    }

    #[test]
    fn keys_that_came_together_are_one_paste_with_returns_as_newlines() {
        let got = run(vec![key(KeyCode::Char('a')), release(KeyCode::Char('a')), key(KeyCode::Enter), key(KeyCode::Char('b')), key(KeyCode::Esc)]);
        assert_eq!(got, vec![Event::Paste("a\nb".into()), key(KeyCode::Esc)]);
    }

    #[test]
    fn one_key_alone_and_control_keys_pass_through() {
        assert_eq!(run(vec![key(KeyCode::Char('a')), release(KeyCode::Char('a'))]), vec![key(KeyCode::Char('a'))]);
        assert_eq!(run(vec![key(KeyCode::Enter)]), vec![key(KeyCode::Enter)]);
        let ctrl_c = Event::Key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
        assert_eq!(run(vec![ctrl_c.clone(), key(KeyCode::Char('x'))]), vec![ctrl_c], "only the first is read here");
    }
}
