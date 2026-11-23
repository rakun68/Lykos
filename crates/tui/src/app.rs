//! What the TUI holds and how keys and server events change it. No terminal and no server here: a key or an
//! event goes in, and out come the requests to make (`Action`), which `main` sends. Behaviour follows OpenCode's
//! TUI at `4332e24` (`packages/tui/src`), read from source; each place says which file.
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use lykos_client::{Event, EventData, Session, SessionStatus, Store};

/// A request for the server, made by `main`.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Start,
    Prompt { session: String, text: String },
    Interrupt { session: String },
    Quit,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Link {
    Connecting,
    Ready,
    /// The events connection dropped; the client is reconnecting.
    Lost(String),
    Failed(String),
}

/// OpenCode `component/prompt/index.tsx` (`session.interrupt`): the first Esc arms, a second within 5 s interrupts.
pub const INTERRUPT_WINDOW: Duration = Duration::from_secs(5);

pub struct App {
    pub cwd: String,
    pub store: Store,
    pub session: Option<String>,
    pub input: String,
    /// The cursor, as a char index into `input`.
    pub cursor: usize,
    /// A prompt waiting for the connection or for its session to finish starting.
    pub queued: Option<String>,
    pub link: Link,
    /// The last thing that went wrong, shown until the next prompt.
    pub notice: Option<String>,
    /// Rows scrolled up from the bottom of the transcript; 0 follows the newest.
    pub scroll: usize,
    pub armed: Option<Instant>,
    pub tick: u64,
    starting: bool,
}

impl App {
    pub fn new(cwd: String) -> App {
        App {
            cwd,
            store: Store::default(),
            session: None,
            input: String::new(),
            cursor: 0,
            queued: None,
            link: Link::Connecting,
            notice: None,
            scroll: 0,
            armed: None,
            tick: 0,
            starting: false,
        }
    }

    pub fn current(&self) -> Option<&Session> {
        self.session.as_ref().and_then(|id| self.store.sessions.get(id))
    }

    pub fn status(&self) -> Option<SessionStatus> {
        self.current().map(|s| s.summary.status)
    }

    pub fn running(&self) -> bool {
        matches!(self.status(), Some(SessionStatus::Running | SessionStatus::Waiting)) || self.starting || (self.queued.is_some() && self.session.is_some())
    }

    /// Whether the screen changes with time alone: the spinner, or an armed interrupt that will lapse.
    pub fn animating(&self) -> bool {
        self.running() || self.armed.is_some() || self.link == Link::Connecting
    }

    /// Time passed: the spinner moves and an armed interrupt lapses.
    pub fn on_tick(&mut self, now: Instant) {
        self.tick = self.tick.wrapping_add(1);
        if self.armed.is_some_and(|at| now.duration_since(at) >= INTERRUPT_WINDOW) {
            self.armed = None;
        }
    }

    pub fn connected(&mut self) -> Vec<Action> {
        self.link = Link::Ready;
        self.flush()
    }

    /// `session.start` answered: this is the session the prompt goes to once it is idle.
    pub fn started(&mut self, id: String) -> Vec<Action> {
        self.starting = false;
        self.session = Some(id);
        self.flush()
    }

    pub fn failed(&mut self, message: String) {
        self.starting = false;
        if self.session.is_none() {
            // Nothing took the prompt: put it back, as the user typed it.
            if let Some(text) = self.queued.take() {
                if self.input.is_empty() {
                    self.input = text;
                    self.cursor = self.input.chars().count();
                }
            }
        }
        self.notice = Some(message);
    }

    pub fn on_event(&mut self, event: &Event) -> Vec<Action> {
        self.store.apply(event);
        if Some(&event.session) == self.session.as_ref() {
            if let EventData::SessionStatus { session } = &event.data {
                if session.status != SessionStatus::Running && session.status != SessionStatus::Waiting {
                    self.armed = None;
                }
            }
            return self.flush();
        }
        Vec::new()
    }

    /// Sends the queued prompt once there is a connection and an idle session for it, starting one if none.
    fn flush(&mut self) -> Vec<Action> {
        if self.queued.is_none() || self.link != Link::Ready {
            return Vec::new();
        }
        let Some(id) = self.session.clone() else {
            if self.starting {
                return Vec::new();
            }
            self.starting = true;
            return vec![Action::Start];
        };
        if self.status() != Some(SessionStatus::Idle) {
            return Vec::new();
        }
        let text = self.queued.take().unwrap_or_default();
        vec![Action::Prompt { session: id, text }]
    }

    pub fn on_paste(&mut self, text: &str) {
        for ch in text.replace("\r\n", "\n").replace('\r', "\n").chars() {
            self.insert(ch);
        }
    }

    pub fn on_scroll(&mut self, up: bool, rows: usize) {
        self.scroll = if up { self.scroll.saturating_add(rows) } else { self.scroll.saturating_sub(rows) };
    }

    /// Keys, as OpenCode binds them by default (`config/keybind.ts`).
    pub fn on_key(&mut self, key: KeyEvent, now: Instant, page: usize) -> Vec<Action> {
        if key.kind == KeyEventKind::Release {
            return Vec::new();
        }
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let alt = key.modifiers.contains(KeyModifiers::ALT);
        let shift = key.modifiers.contains(KeyModifiers::SHIFT);
        match key.code {
            // `prompt.clear` is ctrl+c and wins while there is text; `app.exit` is ctrl+c and ctrl+d.
            KeyCode::Char('c') if ctrl => {
                if self.input.is_empty() {
                    return vec![Action::Quit];
                }
                self.input.clear();
                self.cursor = 0;
            }
            KeyCode::Char('d') if ctrl && self.input.is_empty() => return vec![Action::Quit],
            // `input.newline`: shift+return, ctrl+return, alt+return, ctrl+j.
            KeyCode::Enter if ctrl || alt || shift => self.insert('\n'),
            KeyCode::Char('j') if ctrl => self.insert('\n'),
            // `input.submit`: return.
            KeyCode::Enter => return self.submit(),
            // `session.interrupt`: escape, twice.
            KeyCode::Esc => return self.escape(now),
            // `session.page.up` / `.down`: pageup, pagedown; `session.first` ctrl+g, `session.last` ctrl+alt+g.
            KeyCode::PageUp => self.on_scroll(true, page),
            KeyCode::PageDown => self.on_scroll(false, page),
            KeyCode::Char('g') if ctrl && alt => self.scroll = 0,
            KeyCode::Char('g') if ctrl => self.scroll = usize::MAX / 2,
            KeyCode::Backspace => {
                if self.cursor > 0 {
                    self.cursor -= 1;
                    let at = self.byte(self.cursor);
                    self.input.remove(at);
                }
            }
            KeyCode::Delete => {
                if self.cursor < self.input.chars().count() {
                    let at = self.byte(self.cursor);
                    self.input.remove(at);
                }
            }
            KeyCode::Left => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Right => self.cursor = (self.cursor + 1).min(self.input.chars().count()),
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.input.chars().count(),
            KeyCode::Char(ch) if !ctrl || alt => self.insert(ch),
            _ => {}
        }
        Vec::new()
    }

    fn escape(&mut self, now: Instant) -> Vec<Action> {
        let Some(id) = self.session.clone() else { return Vec::new() };
        if !matches!(self.status(), Some(SessionStatus::Running | SessionStatus::Waiting)) {
            return Vec::new();
        }
        if self.armed.is_some_and(|at| now.duration_since(at) < INTERRUPT_WINDOW) {
            self.armed = None;
            return vec![Action::Interrupt { session: id }];
        }
        self.armed = Some(now);
        Vec::new()
    }

    fn submit(&mut self) -> Vec<Action> {
        let text = self.input.trim().to_string();
        if text.is_empty() {
            return Vec::new();
        }
        if self.queued.is_some() {
            // One prompt waits at a time; a second stays in the box (the queue is #38).
            return Vec::new();
        }
        self.input.clear();
        self.cursor = 0;
        self.notice = None;
        self.scroll = 0;
        if let (Some(id), Some(SessionStatus::Idle | SessionStatus::Running | SessionStatus::Waiting)) = (self.session.clone(), self.status()) {
            if self.link == Link::Ready {
                return vec![Action::Prompt { session: id, text }];
            }
        }
        self.queued = Some(text);
        self.flush()
    }

    fn insert(&mut self, ch: char) {
        let at = self.byte(self.cursor);
        self.input.insert(at, ch);
        self.cursor += 1;
    }

    fn byte(&self, chars: usize) -> usize {
        self.input.char_indices().nth(chars).map_or(self.input.len(), |(i, _)| i)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lykos_client::SessionSummary;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(ch: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(ch), KeyModifiers::CONTROL)
    }

    fn status(app: &mut App, seq: u64, status: SessionStatus) -> Vec<Action> {
        let summary = SessionSummary {
            id: "s1".into(),
            cwd: "/w".into(),
            status,
            model: "m1".into(),
            title: None,
            started_at: "2026-11-23T00:00:00Z".into(),
            origin: "tui".into(),
            ledger_session_id: None,
        };
        app.on_event(&Event { event: "session.status".into(), session: "s1".into(), seq, data: EventData::SessionStatus { session: summary } })
    }

    fn typed(app: &mut App, text: &str) {
        let now = Instant::now();
        for ch in text.chars() {
            app.on_key(key(KeyCode::Char(ch)), now, 10);
        }
    }

    #[test]
    fn the_first_prompt_starts_a_session_and_waits_for_it_to_be_idle() {
        let mut app = App::new("/w".into());
        typed(&mut app, "hello");
        assert_eq!(app.on_key(key(KeyCode::Enter), Instant::now(), 10), vec![], "not connected yet: queued");
        assert_eq!(app.connected(), vec![Action::Start]);
        assert_eq!(app.started("s1".into()), vec![], "starting: still queued");
        assert_eq!(status(&mut app, 1, SessionStatus::Starting), vec![]);
        assert_eq!(status(&mut app, 2, SessionStatus::Idle), vec![Action::Prompt { session: "s1".into(), text: "hello".into() }]);
        assert!(app.queued.is_none());
    }

    #[test]
    fn esc_twice_within_the_window_interrupts_and_once_only_arms() {
        let mut app = App::new("/w".into());
        app.connected();
        app.started("s1".into());
        status(&mut app, 1, SessionStatus::Running);
        let t = Instant::now();
        assert_eq!(app.on_key(key(KeyCode::Esc), t, 10), vec![]);
        assert!(app.armed.is_some());
        app.on_tick(t + INTERRUPT_WINDOW);
        assert!(app.armed.is_none(), "the arm lapses after 5 s");
        app.on_key(key(KeyCode::Esc), t + INTERRUPT_WINDOW, 10);
        let again = app.on_key(key(KeyCode::Esc), t + INTERRUPT_WINDOW + Duration::from_secs(1), 10);
        assert_eq!(again, vec![Action::Interrupt { session: "s1".into() }]);
    }

    #[test]
    fn esc_does_nothing_when_nothing_runs() {
        let mut app = App::new("/w".into());
        app.connected();
        app.started("s1".into());
        status(&mut app, 1, SessionStatus::Idle);
        assert_eq!(app.on_key(key(KeyCode::Esc), Instant::now(), 10), vec![]);
        assert!(app.armed.is_none());
    }

    #[test]
    fn ctrl_c_clears_the_prompt_then_quits() {
        let mut app = App::new("/w".into());
        typed(&mut app, "abc");
        assert_eq!(app.on_key(ctrl('c'), Instant::now(), 10), vec![]);
        assert_eq!(app.input, "");
        assert_eq!(app.on_key(ctrl('c'), Instant::now(), 10), vec![Action::Quit]);
    }

    #[test]
    fn editing_moves_by_characters_not_bytes() {
        let mut app = App::new("/w".into());
        typed(&mut app, "aé漢");
        let now = Instant::now();
        app.on_key(key(KeyCode::Left), now, 10);
        app.on_key(key(KeyCode::Backspace), now, 10);
        assert_eq!(app.input, "a漢");
        app.on_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT), now, 10);
        assert_eq!(app.input, "a\n漢");
    }

    #[test]
    fn a_failed_start_puts_the_prompt_back() {
        let mut app = App::new("/w".into());
        app.connected();
        typed(&mut app, "hi");
        assert_eq!(app.on_key(key(KeyCode::Enter), Instant::now(), 10), vec![Action::Start]);
        app.failed("untrusted workspace: /w".into());
        assert_eq!(app.input, "hi");
        assert!(app.queued.is_none());
        assert_eq!(app.notice.as_deref(), Some("untrusted workspace: /w"));
    }
}
