//! What the TUI holds and how keys and server events change it. No terminal and no server here: a key or an
//! event goes in, and out come the requests to make (`Action`), which `main` sends. Behaviour follows OpenCode's
//! TUI at `4332e24` (`packages/tui/src`), read from source; each place says which file.
use std::cell::Cell;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use lykos_client::{Event, EventData, Session, SessionStatus, Store};

use crate::editor::{Chip, Editor};
use crate::history::History;
use crate::menu::{self, Local, Menu, Pick, Trigger};
use crate::stash::Stash;

/// A request for the server, or for the terminal, made by `main`.
#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Start,
    /// A prompt; while a turn runs, a steer.
    Prompt { session: String, text: String },
    Interrupt { session: String },
    /// Answers the session's oldest waiting request (an approval or a question).
    Answer { session: String, request_id: String, answer: String },
    /// A side question, on a connection of its own so the turn's requests never wait on it.
    Aside { session: String, text: String },
    /// Lists the workspace's files for `@` completion.
    ListFiles,
    /// Puts text on the system clipboard (OSC 52).
    Copy(String),
    /// Opens the prompt in the external editor; its text comes back as `App::edited_externally`.
    Editor(String),
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
/// OpenCode `context/keymap.tsx`: the leader (ctrl+x) waits 2 s for its second key.
pub const LEADER_WINDOW: Duration = Duration::from_secs(2);
/// Two clicks this close are a double click.
const DOUBLE_CLICK: Duration = Duration::from_millis(400);

#[derive(Clone, Debug, PartialEq)]
pub enum Dialog {
    /// OpenCode `session.queued_prompts`.
    Queue { selected: usize },
    /// OpenCode `prompt.stash.list`, newest first.
    Stash { selected: usize },
    /// OpenCode `dialog-image-preview.tsx`: one image at a time, left and right move.
    Images { index: usize },
    /// OpenCode `feature-plugins/prompt/btw.tsx`'s answer dialog.
    Aside { question: String, answer: Result<String, String>, scroll: usize },
}

/// The old TUI's ctrl+r (`lykos/tui/screen/raw-line-source.ts`): entries starting with what was typed, newest first.
#[derive(Clone, Debug, PartialEq)]
pub struct Search {
    pub matches: Vec<String>,
    pub index: usize,
}

/// Where the input was last drawn, so the mouse can find a character.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct InputArea {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    /// The first visual row shown.
    pub first: usize,
}

pub struct App {
    pub cwd: String,
    pub store: Store,
    pub session: Option<String>,
    pub editor: Editor,
    pub history: History,
    pub stash: Stash,
    pub menu: Option<Menu>,
    /// The trigger Esc dismissed: the menu stays shut until the cursor leaves it.
    dismissed: Option<usize>,
    pub dialog: Option<Dialog>,
    pub search: Option<Search>,
    /// Prompts waiting for the turn to end (OpenCode `prompt.queue`), or for the connection or a session.
    pub queue: Vec<String>,
    pub link: Link,
    /// The last thing that went wrong, shown until the next prompt.
    pub notice: Option<String>,
    /// Rows scrolled up from the bottom of the transcript; 0 follows the newest.
    pub scroll: usize,
    pub armed: Option<Instant>,
    pub leader: Option<Instant>,
    /// Side questions waiting on an answer.
    pub asides: usize,
    /// The workspace's files, once listed; `Some(empty)` while listing.
    pub files: Option<Vec<String>>,
    /// The input's width in columns, as last drawn: what up and down move through.
    pub input_cols: usize,
    pub input_area: Cell<Option<InputArea>>,
    pub tick: u64,
    starting: bool,
    clicks: Option<(Instant, u16, u16, u8)>,
}

impl App {
    pub fn new(cwd: String) -> App {
        App {
            cwd,
            store: Store::default(),
            session: None,
            editor: Editor::default(),
            history: History::default(),
            stash: Stash::default(),
            menu: None,
            dismissed: None,
            dialog: None,
            search: None,
            queue: Vec::new(),
            link: Link::Connecting,
            notice: None,
            scroll: 0,
            armed: None,
            leader: None,
            asides: 0,
            files: None,
            input_cols: 80,
            input_area: Cell::new(None),
            tick: 0,
            starting: false,
            clicks: None,
        }
    }

    pub fn current(&self) -> Option<&Session> {
        self.session.as_ref().and_then(|id| self.store.sessions.get(id))
    }

    pub fn status(&self) -> Option<SessionStatus> {
        self.current().map(|s| s.summary.status)
    }

    pub fn running(&self) -> bool {
        matches!(self.status(), Some(SessionStatus::Running | SessionStatus::Waiting)) || self.starting || (!self.queue.is_empty() && self.session.is_some())
    }

    /// Whether the screen changes with time alone: a spinner, or an armed key that will lapse.
    pub fn animating(&self) -> bool {
        self.running() || self.armed.is_some() || self.leader.is_some() || self.asides > 0 || self.link == Link::Connecting
    }

    /// Time passed: the spinner moves and an armed interrupt or leader lapses.
    pub fn on_tick(&mut self, now: Instant) {
        self.tick = self.tick.wrapping_add(1);
        if self.armed.is_some_and(|at| now.duration_since(at) >= INTERRUPT_WINDOW) {
            self.armed = None;
        }
        if self.leader.is_some_and(|at| now.duration_since(at) >= LEADER_WINDOW) {
            self.leader = None;
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

    /// A request failed. `prompt` is the text of a `session.prompt` that did not go through.
    pub fn failed(&mut self, message: String, prompt: Option<String>) {
        self.starting = false;
        // Nothing took the prompt: put it back, as the user typed it, ahead of anything typed since.
        let lost = prompt.or_else(|| if self.session.is_none() && !self.queue.is_empty() { Some(self.queue.drain(..).collect::<Vec<_>>().join("\n")) } else { None });
        if let Some(text) = lost {
            let now = self.editor.text().to_string();
            self.editor.set(&if now.is_empty() { text } else { format!("{text}\n{now}") });
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
            let mut out = self.flush();
            if matches!(event.data, EventData::Commands { .. }) && self.menu.as_ref().is_some_and(|m| m.trigger == Trigger::Slash) {
                out.extend(self.refresh_menu());
            }
            return out;
        }
        Vec::new()
    }

    pub fn on_files(&mut self, files: Vec<String>) -> Vec<Action> {
        self.files = Some(files);
        self.refresh_menu()
    }

    pub fn on_aside(&mut self, question: String, answer: Result<String, String>) {
        self.asides = self.asides.saturating_sub(1);
        self.dialog = Some(Dialog::Aside { question, answer, scroll: 0 });
    }

    /// The external editor closed; `None` when it failed.
    pub fn edited_externally(&mut self, text: Option<String>, error: Option<String>) {
        if let Some(t) = text {
            let t = t.trim_end_matches(['\n', '\r']).to_string();
            if t != self.editor.expanded() {
                self.editor.set(&t);
            }
        }
        if let Some(e) = error {
            self.notice = Some(e);
        }
    }

    /// Sends the first queued prompt once there is a connection and an idle session for it, starting one if none.
    fn flush(&mut self) -> Vec<Action> {
        if self.queue.is_empty() || self.link != Link::Ready {
            return Vec::new();
        }
        // A session that closed (its child exited) takes no more prompts: the next one starts a new session.
        if self.status() == Some(SessionStatus::Closed) {
            self.session = None;
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
        let text = self.queue.remove(0);
        vec![Action::Prompt { session: id, text }]
    }

    pub fn on_paste(&mut self, text: &str) -> Vec<Action> {
        if self.dialog.is_some() {
            return Vec::new();
        }
        self.search = None;
        self.editor.paste(text);
        self.refresh_menu()
    }

    pub fn on_scroll(&mut self, up: bool, rows: usize) {
        if let Some(Dialog::Aside { scroll, .. }) = &mut self.dialog {
            *scroll = if up { scroll.saturating_sub(rows) } else { scroll.saturating_add(rows) };
            return;
        }
        self.scroll = if up { self.scroll.saturating_add(rows) } else { self.scroll.saturating_sub(rows) };
    }

    /// The old TUI's mouse in the prompt box: a click puts the cursor, a drag selects, a double click selects a
    /// word and a triple click the whole prompt. The wheel scrolls the transcript.
    pub fn on_mouse(&mut self, m: MouseEvent, now: Instant) {
        match m.kind {
            MouseEventKind::ScrollUp => return self.on_scroll(true, 3),
            MouseEventKind::ScrollDown => return self.on_scroll(false, 3),
            _ => {}
        }
        let Some(area) = self.input_area.get() else { return };
        let inside = m.column >= area.x && m.column < area.x + area.width && m.row >= area.y && m.row < area.y + area.height;
        let rows = self.editor.layout(area.width as usize);
        let row = area.first + m.row.saturating_sub(area.y).min(area.height.saturating_sub(1)) as usize;
        let at = self.editor.offset_at(&rows, row, m.column.saturating_sub(area.x) as usize);
        match m.kind {
            MouseEventKind::Down(MouseButton::Left) if inside => {
                let n = match self.clicks {
                    Some((t, x, y, n)) if now.duration_since(t) < DOUBLE_CLICK && x == m.column && y == m.row => n % 3 + 1,
                    _ => 1,
                };
                self.clicks = Some((now, m.column, m.row, n));
                match n {
                    2 => self.editor.select_word(at),
                    3 => self.editor.select_all(),
                    _ => {
                        self.editor.click(at, false);
                        // OpenCode: a click on a pasted chip expands it.
                        let under = self.editor.text()[self.editor.cursor()..].chars().next();
                        if under.and_then(|c| self.editor.chip(c)).is_some_and(|c| matches!(c, Chip::Pasted { .. })) {
                            self.editor.expand_chip_at_cursor();
                        }
                    }
                }
                self.search = None;
                self.menu = None;
            }
            MouseEventKind::Drag(MouseButton::Left) if self.clicks.is_some() => self.editor.click(at, true),
            _ => {}
        }
    }

    /// Keys, as OpenCode binds them by default (`config/keybind.ts`), then the old TUI's that do not collide.
    pub fn on_key(&mut self, key: KeyEvent, now: Instant, page: usize) -> Vec<Action> {
        if key.kind == KeyEventKind::Release {
            return Vec::new();
        }
        if let Some(at) = self.leader.take() {
            if now.duration_since(at) < LEADER_WINDOW {
                return self.leader_key(&key);
            }
        }
        if self.dialog.is_some() {
            return self.dialog_key(&key, page);
        }
        if self.search.is_some() {
            if let Some(out) = self.search_key(&key) {
                return out;
            }
        }
        let m = key.modifiers;
        let (ctrl, alt, shift, sup) = (m.contains(KeyModifiers::CONTROL), m.contains(KeyModifiers::ALT), m.contains(KeyModifiers::SHIFT), m.contains(KeyModifiers::SUPER));
        if let Some(answer) = self.answer_key(&key, ctrl || alt) {
            return answer;
        }
        if self.menu.is_some() {
            if let Some(out) = self.menu_key(&key, ctrl) {
                return out;
            }
        }
        // A letter with a modifier is matched in lower case: terminals differ on what shift does to it.
        let code = match key.code {
            KeyCode::Char(c) if ctrl || alt || sup => KeyCode::Char(c.to_ascii_lowercase()),
            c => c,
        };
        let w = self.input_cols.max(1);
        let e = &mut self.editor;
        match code {
            // The old TUI's cut, with a selection; otherwise OpenCode's leader.
            KeyCode::Char('x') if ctrl && !alt && e.selection().is_some() => {
                if let Some(text) = e.cut() {
                    return vec![Action::Copy(text)];
                }
            }
            KeyCode::Char('x') if ctrl && !alt => {
                self.leader = Some(now);
                return Vec::new();
            }
            // `prompt.clear` is ctrl+c and wins while there is text; `app.exit` is ctrl+c and ctrl+d. With a
            // selection, the old TUI's copy.
            KeyCode::Char('c') if ctrl && !alt => {
                if let Some(text) = e.copy() {
                    let at = e.cursor();
                    e.click(at, false);
                    return vec![Action::Copy(text)];
                }
                if e.is_empty() {
                    return vec![Action::Quit];
                }
                e.set("");
                self.history.reset();
            }
            KeyCode::Char('d') if ctrl && shift => e.delete_line(),
            KeyCode::Char('d') if ctrl && !alt => {
                if e.is_empty() {
                    return vec![Action::Quit];
                }
                e.delete();
            }
            // `input.newline`: shift+return, ctrl+return, alt+return, ctrl+j.
            KeyCode::Enter if ctrl || alt || shift => e.newline(),
            KeyCode::Char('j') if ctrl && !alt => e.newline(),
            KeyCode::Enter => return self.submit(),
            KeyCode::Esc => return self.escape(now),
            // `session.page.up` / `.down`; `session.first` ctrl+g, `session.last` ctrl+alt+g.
            KeyCode::PageUp => self.on_scroll(true, page),
            KeyCode::PageDown => self.on_scroll(false, page),
            KeyCode::Char('g') if ctrl && alt => self.scroll = 0,
            KeyCode::Char('g') if ctrl => self.scroll = usize::MAX / 2,
            KeyCode::Char('r') if ctrl && !alt => self.start_search(),
            // The old TUI's history keys: ctrl+up and ctrl+down recall from anywhere in the prompt.
            KeyCode::Up if ctrl => self.recall(-1),
            KeyCode::Down if ctrl => self.recall(1),
            KeyCode::Up if shift => {
                e.up(w, true);
            }
            KeyCode::Down if shift => {
                e.down(w, true);
            }
            KeyCode::Up => self.history_move(-1),
            KeyCode::Down => self.history_move(1),
            KeyCode::Left if alt || ctrl => e.word_backward(shift),
            KeyCode::Right if alt || ctrl => e.word_forward(shift),
            KeyCode::Left => e.left(shift),
            KeyCode::Right => e.right(shift),
            KeyCode::Char('b') if ctrl && !alt => e.left(false),
            KeyCode::Char('f') if ctrl && !alt => e.right(false),
            KeyCode::Char('b') if alt && !ctrl => e.word_backward(shift),
            KeyCode::Char('f') if alt && !ctrl => e.word_forward(shift),
            KeyCode::Home if shift => e.buffer_home(true),
            KeyCode::End if shift => e.buffer_end(true),
            // The old TUI's Home and End: OpenCode binds them to the transcript, which PageUp and ctrl+g also move.
            KeyCode::Home => e.line_home(false),
            KeyCode::End => e.line_end_(false),
            KeyCode::Char('a') if ctrl && !alt => e.line_home(shift),
            KeyCode::Char('e') if ctrl && !alt => e.line_end_(shift),
            KeyCode::Char('a') if alt && !ctrl => e.visual_home(w, shift),
            KeyCode::Char('e') if alt && !ctrl => e.visual_end(w, shift),
            KeyCode::Char('a') if sup => e.select_all(),
            KeyCode::Char('k') if ctrl && !alt => e.delete_to_line_end(),
            KeyCode::Char('u') if ctrl && !alt => e.delete_to_line_start(),
            // ctrl+backspace arrives as ctrl+h in many terminals.
            KeyCode::Backspace if ctrl || alt => e.delete_word_backward(),
            KeyCode::Char('w' | 'h') if ctrl && !alt => e.delete_word_backward(),
            KeyCode::Backspace => e.backspace(),
            KeyCode::Delete if ctrl || alt => e.delete_word_forward(),
            KeyCode::Char('d') if alt && !ctrl => e.delete_word_forward(),
            KeyCode::Delete => e.delete(),
            // `input.undo` ctrl+- and super+z, `input.redo` ctrl+. and super+shift+z; the old TUI's ctrl+z, ctrl+y
            // and ctrl+shift+z.
            KeyCode::Char('z') if (ctrl || sup) && shift => {
                e.redo();
            }
            KeyCode::Char('-' | '_' | 'z') if (ctrl || sup) && !alt => {
                e.undo();
            }
            KeyCode::Char('.' | 'y') if ctrl && !alt => {
                e.redo();
            }
            // The old TUI's ctrl+v when the terminal sends the key, not a paste: the register.
            KeyCode::Char('v') if ctrl && !alt => {
                let r = e.register.clone();
                e.insert_str(&r);
            }
            // AltGr arrives as ctrl+alt.
            KeyCode::Char(ch) if !sup && ctrl == alt => {
                e.insert_char(if let KeyCode::Char(original) = key.code { original } else { ch });
            }
            _ => {}
        }
        self.refresh_menu()
    }

    fn leader_key(&mut self, key: &KeyEvent) -> Vec<Action> {
        match key.code {
            // `prompt.queue`: <leader>return.
            KeyCode::Enter => self.submit_queued(),
            // `prompt.editor`: <leader>e.
            KeyCode::Char('e') => self.run_local(Local::Editor),
            // `prompt.images.view`: <leader>i.
            KeyCode::Char('i') => self.run_local(Local::Images),
            // `session.queued_prompts`: <leader>q.
            KeyCode::Char('q') => self.run_local(Local::Queue),
            _ => Vec::new(),
        }
    }

    fn dialog_key(&mut self, key: &KeyEvent, page: usize) -> Vec<Action> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let Some(dialog) = self.dialog.clone() else { return Vec::new() };
        if key.code == KeyCode::Esc {
            self.dialog = None;
            return Vec::new();
        }
        let step = |sel: usize, n: usize, up: bool| if n == 0 { 0 } else if up { (sel + n - 1) % n } else { (sel + 1) % n };
        match dialog {
            Dialog::Queue { selected } => {
                let n = self.queue.len();
                match key.code {
                    KeyCode::Up => self.dialog = Some(Dialog::Queue { selected: step(selected, n, true) }),
                    KeyCode::Down => self.dialog = Some(Dialog::Queue { selected: step(selected, n, false) }),
                    // Steers the turn with it now.
                    KeyCode::Enter => {
                        let text = self.queue.remove(selected);
                        self.close_if_empty(n - 1, selected);
                        return match (self.session.clone(), self.link == Link::Ready) {
                            (Some(session), true) => vec![Action::Prompt { session, text }],
                            _ => {
                                self.queue.insert(0, text);
                                Vec::new()
                            }
                        };
                    }
                    // `queued_prompt.undo` ctrl+u: back into the prompt box.
                    KeyCode::Char('u') if ctrl => {
                        let text = self.queue.remove(selected);
                        self.editor.set(&text);
                        self.dialog = None;
                    }
                    // `queued_prompt.delete` ctrl+d.
                    KeyCode::Char('d') if ctrl => {
                        self.queue.remove(selected);
                        self.close_if_empty(n - 1, selected);
                    }
                    KeyCode::Delete => {
                        self.queue.remove(selected);
                        self.close_if_empty(n - 1, selected);
                    }
                    _ => {}
                }
            }
            Dialog::Stash { selected } => {
                let n = self.stash.entries.len();
                // Shown newest first.
                let index = n.saturating_sub(1 + selected);
                match key.code {
                    KeyCode::Up => self.dialog = Some(Dialog::Stash { selected: step(selected, n, true) }),
                    KeyCode::Down => self.dialog = Some(Dialog::Stash { selected: step(selected, n, false) }),
                    KeyCode::Enter => {
                        if let Some(e) = self.stash.take(index) {
                            self.editor.set(&e.text);
                        }
                        self.dialog = None;
                    }
                    // `stash.delete` ctrl+d.
                    KeyCode::Char('d') if ctrl => {
                        self.stash.take(index);
                        self.close_if_empty(n - 1, selected);
                    }
                    KeyCode::Delete => {
                        self.stash.take(index);
                        self.close_if_empty(n - 1, selected);
                    }
                    _ => {}
                }
            }
            Dialog::Images { index } => {
                let n = self.editor.images().len();
                match key.code {
                    KeyCode::Left | KeyCode::Up => self.dialog = Some(Dialog::Images { index: step(index, n, true) }),
                    KeyCode::Right | KeyCode::Down => self.dialog = Some(Dialog::Images { index: step(index, n, false) }),
                    KeyCode::Enter => self.dialog = None,
                    _ => {}
                }
            }
            Dialog::Aside { answer, .. } => match key.code {
                // btw.tsx: `c` copies the answer.
                KeyCode::Char('c') if !ctrl => {
                    if let Ok(text) = answer {
                        self.notice = Some("copied the answer".into());
                        return vec![Action::Copy(text)];
                    }
                }
                KeyCode::Enter | KeyCode::Char('q') => self.dialog = None,
                KeyCode::Up | KeyCode::Char('k') => self.on_scroll(true, 1),
                KeyCode::Down | KeyCode::Char('j') => self.on_scroll(false, 1),
                KeyCode::PageUp => self.on_scroll(true, page),
                KeyCode::PageDown => self.on_scroll(false, page),
                _ => {}
            },
        }
        Vec::new()
    }

    /// After removing item `removed` from a list now `n` long: close the dialog when empty, else keep the
    /// selection in range.
    fn close_if_empty(&mut self, n: usize, removed: usize) {
        if n == 0 {
            self.dialog = None;
            return;
        }
        let sel = removed.min(n - 1);
        match &mut self.dialog {
            Some(Dialog::Queue { selected }) | Some(Dialog::Stash { selected }) => *selected = sel,
            _ => {}
        }
    }

    fn start_search(&mut self) {
        let matches = self.history.search(self.editor.text());
        if let Some(first) = matches.first() {
            self.editor.set(first);
        }
        self.search = Some(Search { matches, index: 0 });
    }

    /// `None` when the key is not the search's: it ends the search and is dropped, as the old TUI does.
    fn search_key(&mut self, key: &KeyEvent) -> Option<Vec<Action>> {
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let s = self.search.as_mut()?;
        match key.code {
            KeyCode::Char('r') if ctrl => {
                if !s.matches.is_empty() {
                    s.index = (s.index + 1) % s.matches.len();
                    let text = s.matches[s.index].clone();
                    self.editor.set(&text);
                }
                Some(Vec::new())
            }
            KeyCode::Enter if key.modifiers.is_empty() => {
                self.search = None;
                Some(self.submit())
            }
            _ => {
                self.search = None;
                Some(Vec::new())
            }
        }
    }

    fn menu_key(&mut self, key: &KeyEvent, ctrl: bool) -> Option<Vec<Action>> {
        let m = self.menu.as_mut()?;
        let n = m.entries.len().max(1);
        match key.code {
            // `prompt.autocomplete.prev` up, ctrl+p; `.next` down, ctrl+n.
            KeyCode::Up => m.selected = (m.selected + n - 1) % n,
            KeyCode::Char('p') if ctrl => m.selected = (m.selected + n - 1) % n,
            KeyCode::Down => m.selected = (m.selected + 1) % n,
            KeyCode::Char('n') if ctrl => m.selected = (m.selected + 1) % n,
            // `.hide` escape.
            KeyCode::Esc => {
                self.dismissed = Some(m.at);
                self.menu = None;
            }
            // `.select` return runs a command of the prompt's own; `.complete` tab only inserts.
            KeyCode::Enter if key.modifiers.is_empty() => return Some(self.pick(true)),
            KeyCode::Tab => return Some(self.pick(false)),
            _ => return None,
        }
        Some(Vec::new())
    }

    fn pick(&mut self, run: bool) -> Vec<Action> {
        let Some(m) = self.menu.take() else { return Vec::new() };
        let Some(entry) = m.entries.get(m.selected).cloned() else { return Vec::new() };
        let cursor = self.editor.cursor();
        match entry.pick {
            Pick::Local(local) if run && local != Local::Btw => {
                self.editor.replace(m.at, cursor, "");
                return self.run_local(local);
            }
            Pick::Local(_) | Pick::Command(_) => self.editor.replace(m.at, cursor, &format!("{} ", entry.label)),
            // OpenCode `autocomplete.tsx` `insertPart`: `@path` and a space; an image becomes an attachment.
            Pick::File(path) => {
                if menu::is_image(&path) {
                    self.editor.replace(m.at, cursor, "");
                    self.editor.attach_image(&path);
                } else {
                    self.editor.replace(m.at, cursor, &format!("@{path} "));
                }
            }
        }
        self.refresh_menu()
    }

    /// Opens, moves or shuts the completion menu for where the cursor is now.
    fn refresh_menu(&mut self) -> Vec<Action> {
        let Some((trigger, at, query)) = menu::trigger(self.editor.text(), self.editor.cursor()).map(|(t, a, q)| (t, a, q.to_string())) else {
            self.menu = None;
            self.dismissed = None;
            return Vec::new();
        };
        if self.dismissed == Some(at) {
            self.menu = None;
            return Vec::new();
        }
        self.dismissed = None;
        let mut out = Vec::new();
        let entries = match trigger {
            Trigger::Slash => menu::commands(&query, self.current().map_or(&[][..], |s| &s.commands)),
            Trigger::At => {
                if self.files.is_none() {
                    self.files = Some(Vec::new());
                    out.push(Action::ListFiles);
                }
                menu::files(&query, self.files.as_deref().unwrap_or(&[]))
            }
        };
        self.menu = (!entries.is_empty()).then_some(Menu { trigger, at, entries, selected: 0 });
        out
    }

    fn run_local(&mut self, local: Local) -> Vec<Action> {
        match local {
            // `prompt.stash`.
            Local::Stash => {
                let text = self.editor.expanded().trim().to_string();
                if text.is_empty() {
                    self.notice = Some("nothing to stash".into());
                } else {
                    self.stash.push(&text);
                    self.editor.reset();
                    self.history.reset();
                }
            }
            Local::StashPop => match self.stash.pop() {
                Some(e) => self.editor.set(&e.text),
                None => self.notice = Some("no stashed prompts".into()),
            },
            Local::StashList if self.stash.entries.is_empty() => self.notice = Some("no stashed prompts".into()),
            Local::StashList => self.dialog = Some(Dialog::Stash { selected: 0 }),
            Local::Queue if self.queue.is_empty() => self.notice = Some("no queued prompts".into()),
            Local::Queue => self.dialog = Some(Dialog::Queue { selected: 0 }),
            Local::Images if self.editor.images().is_empty() => self.notice = Some("no images attached".into()),
            Local::Images => self.dialog = Some(Dialog::Images { index: 0 }),
            Local::Editor => return vec![Action::Editor(self.editor.expanded())],
            Local::Btw => self.notice = Some("/btw needs a question".into()),
        }
        Vec::new()
    }

    /// OpenCode `component/prompt/index.tsx`: up first moves through the input's rows; on the top row it goes to
    /// the start; only from the start does it recall the previous prompt. Down mirrors it at the end.
    fn history_move(&mut self, direction: isize) {
        let w = self.input_cols.max(1);
        let moved = if direction < 0 { self.editor.up(w, false) } else { self.editor.down(w, false) };
        if moved {
            return;
        }
        let edge = if direction < 0 { 0 } else { self.editor.text().len() };
        if self.editor.cursor() != edge {
            if direction < 0 {
                self.editor.buffer_home(false);
            } else {
                self.editor.buffer_end(false);
            }
            return;
        }
        self.recall(direction);
    }

    fn recall(&mut self, direction: isize) {
        if let Some(text) = self.history.step(direction, self.editor.text()) {
            self.editor.set(&text);
            if direction < 0 {
                self.editor.buffer_home(false);
            }
        }
    }

    /// While the session waits on a request: an option's key (its value, when one character) picks it with the
    /// prompt empty, and Enter sends what is typed, or the first option when nothing is. The dialogs are #46.
    fn answer_key(&mut self, key: &KeyEvent, modified: bool) -> Option<Vec<Action>> {
        let id = self.session.clone()?;
        let request = self.current()?.requests.first()?.clone();
        let answer = match key.code {
            KeyCode::Char(ch) if !modified && self.editor.is_empty() => request.options.iter().find(|o| o.value.chars().eq(std::iter::once(ch)))?.value.clone(),
            KeyCode::Enter if !modified => {
                let typed = self.editor.expanded().trim().to_string();
                if typed.is_empty() {
                    request.options.first()?.value.clone()
                } else {
                    typed
                }
            }
            _ => return None,
        };
        self.editor.reset();
        Some(vec![Action::Answer { session: id, request_id: request.request_id, answer }])
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

    /// Takes the prompt out of the box, recording it in history. `None` when there is nothing to send.
    fn take_prompt(&mut self) -> Option<String> {
        let text = self.editor.expanded().trim().to_string();
        if text.is_empty() {
            return None;
        }
        self.history.append(&text);
        self.editor.reset();
        self.menu = None;
        self.notice = None;
        self.scroll = 0;
        Some(text)
    }

    /// Enter: a command of the prompt's own runs; otherwise the prompt goes now, steering a running turn.
    fn submit(&mut self) -> Vec<Action> {
        let typed = self.editor.expanded();
        let trimmed = typed.trim();
        if let Some(local) = menu::local(trimmed).filter(|l| *l != Local::Btw) {
            self.editor.reset();
            return self.run_local(local);
        }
        if trimmed == "/btw" || trimmed.starts_with("/btw ") || trimmed.starts_with("/btw\n") {
            return self.ask_aside();
        }
        let Some(text) = self.take_prompt() else { return Vec::new() };
        if self.status() == Some(SessionStatus::Closed) {
            self.session = None;
        }
        if let (Some(id), Some(SessionStatus::Idle | SessionStatus::Running | SessionStatus::Waiting)) = (self.session.clone(), self.status()) {
            if self.link == Link::Ready {
                return vec![Action::Prompt { session: id, text }];
            }
        }
        self.queue.push(text);
        self.flush()
    }

    /// <leader>return: the prompt waits for the turn to end, then goes as the next one.
    fn submit_queued(&mut self) -> Vec<Action> {
        let Some(text) = self.take_prompt() else { return Vec::new() };
        self.queue.push(text);
        self.flush()
    }

    /// btw.tsx: a session must be open; the question is what follows `/btw`.
    fn ask_aside(&mut self) -> Vec<Action> {
        let question = self.editor.expanded().trim()["/btw".len()..].trim().to_string();
        if question.is_empty() {
            return self.run_local(Local::Btw);
        }
        let Some(session) = self.session.clone().filter(|_| matches!(self.status(), Some(s) if s != SessionStatus::Starting && s != SessionStatus::Closed)) else {
            self.notice = Some("Open a session first".into());
            return Vec::new();
        };
        self.history.append(&format!("/btw {question}"));
        self.editor.reset();
        self.menu = None;
        self.asides += 1;
        vec![Action::Aside { session, text: question }]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lykos_client::{CommandInfo, SessionSummary};

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn ctrl(ch: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(ch), KeyModifiers::CONTROL)
    }

    fn press(app: &mut App, k: KeyEvent) -> Vec<Action> {
        app.on_key(k, Instant::now(), 10)
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
        for ch in text.chars() {
            press(app, key(KeyCode::Char(ch)));
        }
    }

    fn idle() -> App {
        let mut app = App::new("/w".into());
        app.connected();
        app.started("s1".into());
        status(&mut app, 1, SessionStatus::Idle);
        app
    }

    #[test]
    fn the_first_prompt_starts_a_session_and_waits_for_it_to_be_idle() {
        let mut app = App::new("/w".into());
        typed(&mut app, "hello");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![], "not connected yet: queued");
        assert_eq!(app.connected(), vec![Action::Start]);
        assert_eq!(app.started("s1".into()), vec![], "starting: still queued");
        assert_eq!(status(&mut app, 1, SessionStatus::Starting), vec![]);
        assert_eq!(status(&mut app, 2, SessionStatus::Idle), vec![Action::Prompt { session: "s1".into(), text: "hello".into() }]);
        assert!(app.queue.is_empty());
    }

    #[test]
    fn esc_twice_within_the_window_interrupts_and_once_only_arms() {
        let mut app = idle();
        status(&mut app, 2, SessionStatus::Running);
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
        let mut app = idle();
        assert_eq!(press(&mut app, key(KeyCode::Esc)), vec![]);
        assert!(app.armed.is_none());
    }

    #[test]
    fn ctrl_c_copies_a_selection_clears_the_prompt_then_quits() {
        let mut app = App::new("/w".into());
        typed(&mut app, "abc");
        press(&mut app, KeyEvent::new(KeyCode::Left, KeyModifiers::SHIFT));
        assert_eq!(press(&mut app, ctrl('c')), vec![Action::Copy("c".into())]);
        assert_eq!(press(&mut app, ctrl('c')), vec![]);
        assert_eq!(app.editor.text(), "");
        assert_eq!(press(&mut app, ctrl('c')), vec![Action::Quit]);
    }

    #[test]
    fn editing_keys_follow_opencode() {
        let mut app = App::new("/w".into());
        typed(&mut app, "aé漢");
        press(&mut app, key(KeyCode::Left));
        press(&mut app, key(KeyCode::Backspace));
        assert_eq!(app.editor.text(), "a漢");
        press(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT));
        assert_eq!(app.editor.text(), "a\n漢");
        press(&mut app, ctrl('a'));
        press(&mut app, ctrl('k'));
        assert_eq!(app.editor.text(), "a\n", "ctrl+a is the line's start, ctrl+k deletes to its end");
        press(&mut app, ctrl('z'));
        assert_eq!(app.editor.text(), "a\n漢", "the old TUI's ctrl+z undoes");
        press(&mut app, ctrl('y'));
        assert_eq!(app.editor.text(), "a\n");
        typed(&mut app, "one two");
        press(&mut app, ctrl('w'));
        assert_eq!(app.editor.text(), "a\none ");
        press(&mut app, KeyEvent::new(KeyCode::Char('A'), KeyModifiers::CONTROL | KeyModifiers::SHIFT));
        assert_eq!(app.editor.copy().as_deref(), Some("one "), "ctrl+shift+a selects to the line's start");
    }

    #[test]
    fn altgr_types() {
        let mut app = App::new("/w".into());
        press(&mut app, KeyEvent::new(KeyCode::Char('@'), KeyModifiers::CONTROL | KeyModifiers::ALT));
        assert_eq!(app.editor.text(), "@");
    }

    #[test]
    fn a_failed_start_puts_the_prompt_back() {
        let mut app = App::new("/w".into());
        app.connected();
        typed(&mut app, "hi");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![Action::Start]);
        app.failed("untrusted workspace: /w".into(), None);
        assert_eq!(app.editor.text(), "hi");
        assert!(app.queue.is_empty());
        assert_eq!(app.notice.as_deref(), Some("untrusted workspace: /w"));
    }

    #[test]
    fn a_failed_prompt_puts_its_text_back_ahead_of_what_was_typed_since() {
        let mut app = idle();
        typed(&mut app, "first");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![Action::Prompt { session: "s1".into(), text: "first".into() }]);
        typed(&mut app, "second");
        app.failed("Closed".into(), Some("first".into()));
        assert_eq!(app.editor.text(), "first\nsecond");
    }

    #[test]
    fn a_prompt_after_the_session_closed_starts_a_new_one() {
        let mut app = idle();
        status(&mut app, 2, SessionStatus::Closed);
        typed(&mut app, "again");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![Action::Start]);
        assert!(app.session.is_none());
        assert_eq!(app.started("s2".into()), vec![]);
    }

    #[test]
    fn an_option_key_or_enter_answers_a_waiting_request() {
        let mut app = idle();
        status(&mut app, 2, SessionStatus::Waiting);
        let request = lykos_client::RequestData {
            request_id: "r1".into(),
            kind: "question".into(),
            title: "which?".into(),
            detail: String::new(),
            body: None,
            options: vec![lykos_client::RequestOption { value: "1".into(), label: "a".into() }, lykos_client::RequestOption { value: "2".into(), label: "b".into() }],
            assumption: None,
        };
        app.on_event(&Event { event: "request".into(), session: "s1".into(), seq: 3, data: EventData::Request { request } });
        let answer = |a: &str| vec![Action::Answer { session: "s1".into(), request_id: "r1".into(), answer: a.into() }];
        assert_eq!(press(&mut app, key(KeyCode::Char('2'))), answer("2"));
        assert_eq!(press(&mut app, key(KeyCode::Enter)), answer("1"), "enter with nothing typed: the first option");
        typed(&mut app, "x");
        assert_eq!(app.editor.text(), "x", "a key that is no option types");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), answer("x"));
    }

    #[test]
    fn enter_steers_and_leader_return_queues_until_the_turn_ends() {
        let mut app = idle();
        status(&mut app, 2, SessionStatus::Running);
        typed(&mut app, "steer");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![Action::Prompt { session: "s1".into(), text: "steer".into() }]);
        typed(&mut app, "later");
        press(&mut app, ctrl('x'));
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![]);
        typed(&mut app, "after");
        press(&mut app, ctrl('x'));
        press(&mut app, key(KeyCode::Enter));
        assert_eq!(app.queue, ["later", "after"]);
        assert_eq!(status(&mut app, 3, SessionStatus::Idle), vec![Action::Prompt { session: "s1".into(), text: "later".into() }]);
        // The queue dialog: ctrl+u puts one back in the box.
        press(&mut app, ctrl('x'));
        press(&mut app, key(KeyCode::Char('q')));
        assert_eq!(app.dialog, Some(Dialog::Queue { selected: 0 }));
        press(&mut app, ctrl('u'));
        assert_eq!(app.editor.text(), "after");
        assert!(app.queue.is_empty() && app.dialog.is_none());
    }

    #[test]
    fn the_leader_lapses() {
        let mut app = App::new("/w".into());
        let t = Instant::now();
        app.on_key(ctrl('x'), t, 10);
        app.on_key(key(KeyCode::Char('e')), t + LEADER_WINDOW, 10);
        assert_eq!(app.editor.text(), "e", "past 2 s the key types");
    }

    #[test]
    fn up_moves_rows_then_to_the_start_then_recalls() {
        let mut app = idle();
        for p in ["one", "two"] {
            typed(&mut app, p);
            press(&mut app, key(KeyCode::Enter));
        }
        typed(&mut app, "ab");
        press(&mut app, KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT));
        typed(&mut app, "cd");
        press(&mut app, key(KeyCode::Up));
        assert_eq!(app.editor.cursor(), 2, "first up: the row above");
        press(&mut app, key(KeyCode::Up));
        assert_eq!(app.editor.cursor(), 0, "then the start");
        press(&mut app, key(KeyCode::Up));
        assert_eq!(app.editor.text(), "two");
        press(&mut app, key(KeyCode::Up));
        assert_eq!(app.editor.text(), "one");
        press(&mut app, key(KeyCode::Down));
        press(&mut app, key(KeyCode::Down));
        assert_eq!(app.editor.text(), "two");
        press(&mut app, key(KeyCode::Down));
        assert_eq!(app.editor.text(), "ab\ncd", "the draft comes back");
        // ctrl+r: prefix search, newest first; ctrl+r again cycles; another key ends it.
        app.editor.set("o");
        press(&mut app, ctrl('r'));
        assert_eq!(app.editor.text(), "one");
        press(&mut app, key(KeyCode::Right));
        assert!(app.search.is_none());
    }

    #[test]
    fn slash_completes_commands_and_runs_the_prompts_own() {
        let mut app = idle();
        let commands = vec![CommandInfo { name: "/skill:tdd".into(), description: "tests first".into(), source: "skill".into() }];
        app.on_event(&Event { event: "commands".into(), session: "s1".into(), seq: 2, data: EventData::Commands { commands } });
        typed(&mut app, "/td");
        let m = app.menu.as_ref().expect("the menu opens");
        assert_eq!(m.entries[0].label, "/skill:tdd");
        press(&mut app, key(KeyCode::Tab));
        assert_eq!(app.editor.text(), "/skill:tdd ");
        assert!(app.menu.is_none());
        app.editor.reset();
        typed(&mut app, "keep me");
        press(&mut app, ctrl('a'));
        typed(&mut app, "/stash");
        assert_eq!(app.menu.as_ref().unwrap().entries[0].label, "/stash");
        press(&mut app, key(KeyCode::Enter));
        assert_eq!(app.stash.entries[0].text, "keep me");
        assert!(app.editor.is_empty());
        typed(&mut app, "/stash pop");
        press(&mut app, key(KeyCode::Esc));
        assert!(app.menu.is_none(), "esc hides it");
        press(&mut app, key(KeyCode::Enter));
        assert_eq!(app.editor.text(), "keep me", "a typed /stash pop runs on enter");
    }

    #[test]
    fn at_lists_files_once_and_an_image_becomes_an_attachment() {
        let mut app = idle();
        typed(&mut app, "see @");
        assert_eq!(press(&mut app, key(KeyCode::Char('s'))), vec![], "listed once");
        assert_eq!(app.files, Some(vec![]));
        app.on_files(vec!["src/main.rs".into(), "shot.png".into()]);
        assert_eq!(app.menu.as_ref().unwrap().entries.len(), 2);
        typed(&mut app, "rc");
        press(&mut app, key(KeyCode::Enter));
        assert_eq!(app.editor.expanded(), "see @src/main.rs ");
        typed(&mut app, "@shot");
        press(&mut app, key(KeyCode::Enter));
        assert_eq!(app.editor.images().len(), 1);
        assert_eq!(app.editor.expanded(), "see @src/main.rs @shot.png ");
    }

    #[test]
    fn btw_asks_aside_and_shows_the_answer() {
        let mut app = App::new("/w".into());
        typed(&mut app, "/btw why?");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![]);
        assert_eq!(app.notice.as_deref(), Some("Open a session first"));
        let mut app = idle();
        typed(&mut app, "/btw why?");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![Action::Aside { session: "s1".into(), text: "why?".into() }]);
        assert_eq!(app.asides, 1);
        assert!(app.animating(), "the footer spins while it waits");
        app.on_aside("why?".into(), Ok("because".into()));
        assert_eq!(press(&mut app, key(KeyCode::Char('c'))), vec![Action::Copy("because".into())]);
        press(&mut app, key(KeyCode::Esc));
        assert!(app.dialog.is_none());
    }

    #[test]
    fn a_click_places_the_cursor_and_a_double_click_selects_a_word() {
        let mut app = App::new("/w".into());
        typed(&mut app, "foo bar");
        app.input_area.set(Some(InputArea { x: 10, y: 5, width: 40, height: 1, first: 0 }));
        let t = Instant::now();
        let click = |col| MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: col, row: 5, modifiers: KeyModifiers::NONE };
        app.on_mouse(click(11), t);
        assert_eq!(app.editor.cursor(), 1);
        app.on_mouse(click(15), t + Duration::from_secs(1));
        app.on_mouse(click(15), t + Duration::from_millis(1100));
        assert_eq!(app.editor.copy().as_deref(), Some("bar"));
    }
}
