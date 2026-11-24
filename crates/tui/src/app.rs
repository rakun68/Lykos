//! What the TUI holds and how keys and server events change it. No terminal and no server here: a key or an
//! event goes in, and out come the requests to make (`Action`), which `main` sends. Behaviour follows OpenCode's
//! TUI at `4332e24` (`packages/tui/src`), read from source; each place says which file.
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};
use lykos_client::{Event, EventData, History as Past, HistoryRow, Item, Session, SessionOptions, SessionStatus, Store, Worktree};
use serde_json::{json, Value};

use crate::editor::{Chip, Editor};
use crate::history::History;
use crate::keymap::{self, Keymap};
use crate::menu::{self, Local, Menu, Pick, Trigger};
use crate::prefs::Prefs;
use crate::stash::Stash;
use crate::tabs::Tabs;
use crate::theme;
use crate::transcript::{self, Cache, GroupId, Layout, Look};

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
    /// Asks the session what the lists show (`session.options`); the answer comes back as `App::on_options`.
    Options { session: String },
    /// Any other request; its answer comes back as `App::on_reply` with `then` (P5 #42).
    Call { method: &'static str, params: Value, then: Then },
    /// Opens a terminal in the pane (P5 #48); `main` starts its shell, at the pane's size.
    NewTerminal,
    /// `terminal.suspend`: the TUI stops until the shell brings it back (not on Windows).
    Suspend,
    Quit,
}

/// What an answer to `Action::Call` is for.
#[derive(Clone, Debug, PartialEq)]
pub enum Then {
    /// `sessions.history`, for the session list.
    History,
    /// `sessions.history`, to go to the parent or a child of the session shown.
    Navigate(Nav),
    /// `session.start` or `session.move`: the session to show. A move names the tab it replaces.
    Started { replaces: Option<String> },
    /// A write whose answer is shown as it is.
    Notice(&'static str),
    /// An archive or rename from the session list: the list again.
    Refresh { all: bool },
    /// `session.export`.
    Exported,
    /// `worktree.list`.
    Worktrees,
    /// A worktree created or removed: the list again.
    WorktreesChanged,
    /// `vcs.diff`, for the diff viewer.
    Diff,
    /// A call whose answer shows nothing; a failure is the notice.
    Quiet,
    /// `session.job.logs`, for the output view of this job (P5 #48).
    JobLog(String),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Nav {
    Parent,
    /// The first child; then the next (1) or previous (-1) of the session's siblings.
    Child(isize),
    /// The session of the n-th `agent` call, by start order (the composer's Subagents tab, P5 #48).
    ChildAt(usize),
}

/// What a one-line input dialog is for.
#[derive(Clone, Debug, PartialEq)]
pub enum Purpose {
    Rename { id: String, cwd: String, all: Option<bool> },
    Worktree,
    Cd,
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
/// OpenCode `routes/session/index.tsx` `BACKGROUND_TOOL_HINT_DELAY`.
pub const BACKGROUND_HINT_DELAY: Duration = Duration::from_secs(3);
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
    /// OpenCode `command.palette.show`: every action, searched as typed.
    Palette { query: String, selected: usize },
    /// Every key, and the layer that set it.
    Help { scroll: usize },
    /// OpenCode's select dialogs for models, variants, agents, themes and providers.
    List { list: List, query: String, selected: usize },
    /// OpenCode's status, usage, MCP and debug dialogs.
    Info { info: Info },
    /// `dialog-session-list.tsx`: `confirm` is the row a first delete press armed.
    Sessions { query: String, selected: usize, all: bool, confirm: Option<String> },
    /// `dialog-timeline.tsx`: the session's prompts, newest first.
    Timeline { query: String, selected: usize },
    /// `dialog-workspaces.tsx`.
    Worktrees { selected: usize, confirm: Option<String> },
    /// A line typed: a session's new name, a worktree's name, a directory.
    Input { title: String, text: String, purpose: Purpose },
    /// `dialog-shell-output.tsx`: a background job's output, its last 64 KiB, following the end while `scroll` is 0
    /// (rows up from the end). `offset` is where the next read starts.
    Output { job: String, command: String, text: String, offset: Option<u64>, scroll: usize, error: Option<String> },
}

#[derive(Clone, Debug, PartialEq)]
pub enum List {
    /// `dialog-model.tsx`.
    Models,
    /// `dialog-variant.tsx`: Lykos's thinking effort.
    Efforts,
    /// `dialog-agent.tsx`: Lykos's primary specialists.
    Agents,
    /// `dialog-theme-list.tsx`: the theme open when the list opened comes back on Esc.
    Themes { initial: &'static str },
    /// `dialog-integration.tsx`: each provider and whether Lykos can reach it.
    Providers,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Info {
    Status,
    Usage,
    Mcp,
    Debug,
}

/// One row of a list.
#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    /// What choosing it sends or sets.
    pub value: String,
    pub title: String,
    pub detail: String,
    /// The heading it shows under; empty for none.
    pub group: String,
    /// In use now.
    pub current: bool,
    pub favorite: bool,
}

/// `model-options.tsx` `tokens`: 1M, 200K.
pub fn tokens(v: f64) -> String {
    if v >= 1_000_000.0 {
        let m = (v / 100_000.0).round() / 10.0;
        if m.fract() == 0.0 { format!("{m:.0}M") } else { format!("{m:.1}M") }
    } else if v >= 1000.0 {
        format!("{}K", (v / 1000.0).round())
    } else {
        format!("{v}")
    }
}

/// The old TUI's ctrl+r (`lykos/tui/screen/raw-line-source.ts`): entries starting with what was typed, newest first.
#[derive(Clone, Debug, PartialEq)]
pub struct Search {
    pub matches: Vec<String>,
    pub index: usize,
}

/// Where the transcript was last drawn: its area, and the layout row at its top.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Frame {
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
    pub top: usize,
}

/// A transcript selection: the layout row and column pressed, and where the mouse is now.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Selection {
    pub anchor: (usize, usize),
    pub head: (usize, usize),
    pub dragged: bool,
}

impl Selection {
    pub fn ordered(&self) -> ((usize, usize), (usize, usize)) {
        if self.anchor <= self.head {
            (self.anchor, self.head)
        } else {
            (self.head, self.anchor)
        }
    }
}

/// OpenCode's `terminal.copy` default: a selection is copied as the mouse lets go, except on Windows, where a right
/// click or ctrl+c copies it (`app.tsx`).
const COPY_ON_SELECT: bool = !cfg!(windows);

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
    pub keymap: Keymap,
    /// What the lists last showed for the session.
    pub options: Option<SessionOptions>,
    pub prefs: Prefs,
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
    /// The open session tabs (P5 #42).
    pub tabs: Tabs,
    /// The session list's rows, once `sessions.history` answered.
    pub past: Option<Past>,
    /// The worktrees dialog's rows, once `worktree.list` answered.
    pub worktrees: Option<Vec<Worktree>>,
    /// The transcript item the timeline jumps to, and the scroll the view found for it.
    pub jump: Cell<Option<usize>>,
    pub jumped: Cell<Option<usize>>,
    /// The transcript's kept blocks (P5 #44), the layout the last frame drew, and where.
    pub layout_cache: RefCell<Cache>,
    /// The approval or question prompt (P5 #46), and the diff an approval shows.
    pub req: crate::request::Ui,
    pub req_diff: RefCell<crate::request::Laid>,
    /// The diff viewer, while open.
    pub diff: Option<crate::diffview::Viewer>,
    /// The session sidebar's state (P5 #46).
    pub side: crate::sidebar::Side,
    pub laid: RefCell<Option<Rc<Layout>>>,
    pub frame: Cell<Option<Frame>>,
    /// Groups a click opened or closed, per session.
    pub opened: BTreeMap<String, BTreeMap<GroupId, bool>>,
    /// The message the message keys last went to.
    nav: Option<usize>,
    pub selection: Option<Selection>,
    /// `--mini`: the transcript goes into the terminal's scrollback (`mini.rs`).
    pub mini: bool,
    /// `-s`: the ledger session to resume once connected.
    pub resume: Option<String>,
    /// What the session has running, in the prompt box's place (P5 #48).
    pub composer: Option<crate::composer::Composer>,
    /// The terminal pane's terminals.
    pub terms: crate::terminal::Terms,
    /// The output view's last read: when, and whether its answer is still to come.
    pub poll: Option<(Instant, bool)>,
    /// Since when a shell call has held the turn, and whether the ctrl+b hint shows (after 3 s).
    fg_since: Option<Instant>,
    pub bg_hint: bool,
}

impl App {
    pub fn new(cwd: String) -> App {
        App {
            cwd,
            store: Store::default(),
            session: None,
            editor: Editor::default(),
            keymap: Keymap::default(),
            options: None,
            prefs: Prefs::default(),
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
            tabs: Tabs::default(),
            past: None,
            worktrees: None,
            jump: Cell::new(None),
            jumped: Cell::new(None),
            layout_cache: RefCell::new(Cache::default()),
            req: crate::request::Ui::default(),
            req_diff: RefCell::new(None),
            diff: None,
            side: crate::sidebar::Side::default(),
            laid: RefCell::new(None),
            frame: Cell::new(None),
            opened: BTreeMap::new(),
            nav: None,
            selection: None,
            mini: false,
            resume: None,
            composer: None,
            terms: crate::terminal::Terms::default(),
            poll: None,
            fg_since: None,
            bg_hint: false,
        }
    }

    /// What the transcript toggles set.
    pub fn look(&self) -> Look {
        let p = &self.prefs;
        Look { show_thinking: p.show_thinking, grouping: p.grouping, verbosity: p.verbosity, animations: p.animations }
    }

    /// A palette title, where OpenCode's says what the action will do (`routes/session/index.tsx`, `app.tsx`).
    pub fn title(&self, d: &keymap::Def) -> String {
        let p = &self.prefs;
        let pick = |on: bool, yes: &str, no: &str| if on { yes.to_string() } else { no.to_string() };
        match d.id {
            "session.toggle.thinking" => pick(p.show_thinking, "Collapse thinking", "Expand thinking"),
            "session.toggle.exploration_grouping" => pick(p.grouping, "Show tool calls individually", "Group related tool calls"),
            "session.verbosity.cycle" => {
                let name = p.verbosity.name();
                format!("Verbosity: {}{}", name[..1].to_uppercase(), &name[1..])
            }
            "app.toggle.animations" => pick(p.animations, "Disable animations", "Enable animations"),
            "app.toggle.diffwrap" => pick(p.diff_wrap, "Disable diff wrapping", "Enable diff wrapping"),
            "session.sidebar.toggle" => pick(crate::sidebar::place(self, self.side.width.get()).is_some(), "Hide sidebar", "Show sidebar"),
            "terminal.toggle" => pick(self.terminal_shown(), "Hide terminal pane", "Show terminal pane"),
            "terminal.title.toggle" => pick(p.terminal_title, "Disable terminal title", "Enable terminal title"),
            _ => d.title.to_string(),
        }
    }

    /// The prompts and answers the message keys move between, and the layout row each starts on.
    fn messages(&self, user_only: bool) -> Vec<(usize, usize)> {
        let (Some(s), Some(lay)) = (self.current(), self.laid.borrow().clone()) else { return Vec::new() };
        lay.blocks()
            .filter(|(_, b)| b.leaf)
            .filter_map(|(y, b)| match s.items.get(b.first)? {
                Item::User(t) | Item::Followup(t) if !t.trim().is_empty() => Some((b.first, y)),
                Item::Assistant(t) if !user_only && !t.trim().is_empty() => Some((b.first, y)),
                _ => None,
            })
            .collect()
    }

    /// `findMessageBoundary`: from the message last gone to, else from the top of the view.
    fn goto_message(&mut self, next: bool, user_only: bool) -> Vec<Action> {
        let msgs = self.messages(user_only);
        let top = self.frame.get().map_or(0, |f| f.top);
        let target = match self.nav.and_then(|n| msgs.iter().position(|(i, _)| *i == n)) {
            Some(k) if next => msgs.get(k + 1),
            Some(k) => k.checked_sub(1).and_then(|k| msgs.get(k)),
            None if next => msgs.iter().find(|(_, y)| *y > top),
            None => msgs.iter().rev().find(|(_, y)| *y < top),
        };
        if let Some(&(i, _)) = target {
            self.nav = Some(i);
            self.jump.set(Some(i));
        }
        Vec::new()
    }

    /// The transcript's own actions (P5 #44), as OpenCode's `routes/session/index.tsx` and `app.tsx` run them.
    fn run_view(&mut self, id: &str) -> Option<Vec<Action>> {
        let p = &mut self.prefs;
        match id {
            "session.message.next" => return Some(self.goto_message(true, false)),
            "session.message.previous" => return Some(self.goto_message(false, false)),
            "session.message.user.next" => return Some(self.goto_message(true, true)),
            "session.message.user.previous" => return Some(self.goto_message(false, true)),
            "session.messages_last_user" => {
                let last = self.current()?.items.iter().rposition(|it| matches!(it, Item::User(t) | Item::Followup(t) if !t.trim().is_empty()));
                if let Some(i) = last {
                    self.nav = Some(i);
                    self.jump.set(Some(i));
                }
                return Some(Vec::new());
            }
            "messages.copy" => {
                let last = self.current().and_then(|s| s.items.iter().rev().find_map(|it| if let Item::Assistant(t) = it { Some(t.trim().to_string()) } else { None }));
                return Some(match last {
                    None => {
                        self.notice = Some("No assistant messages found".into());
                        Vec::new()
                    }
                    Some(t) if t.is_empty() => {
                        self.notice = Some("No text content found in last assistant message".into());
                        Vec::new()
                    }
                    Some(t) => {
                        self.notice = Some("Message copied to clipboard!".into());
                        vec![Action::Copy(t)]
                    }
                });
            }
            "session.toggle.thinking" => p.show_thinking = !p.show_thinking,
            "session.toggle.scrollbar" => p.scrollbar = !p.scrollbar,
            "session.toggle.exploration_grouping" => p.grouping = !p.grouping,
            "session.verbosity.cycle" => p.verbosity = p.verbosity.next(),
            "app.toggle.animations" => p.animations = !p.animations,
            "app.toggle.diffwrap" => p.diff_wrap = !p.diff_wrap,
            "terminal.title.toggle" => p.terminal_title = !p.terminal_title,
            _ => return None,
        }
        self.prefs.save();
        Some(Vec::new())
    }

    /// The selected transcript text, by columns, each row's trailing spaces left off.
    fn selected_text(&self) -> String {
        let (Some(sel), Some(lay)) = (self.selection, self.laid.borrow().clone()) else { return String::new() };
        let ((r0, c0), (r1, c1)) = sel.ordered();
        let mut out = Vec::new();
        for r in r0..=r1 {
            let Some(row) = lay.row(r) else { continue };
            let (from, to) = (if r == r0 { c0 } else { 0 }, if r == r1 { c1 + 1 } else { usize::MAX });
            let mut line = String::new();
            let mut col = row.indent as usize;
            for ch in row.text.chars() {
                if col >= from && col < to {
                    line.push(ch);
                }
                col += unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
            }
            out.push(line.trim_end().to_string());
        }
        out.join("\n")
    }

    /// `Selection.copy`: the text to the clipboard; the selection stays.
    fn copy_selection(&mut self) -> Vec<Action> {
        let text = self.selected_text();
        if text.is_empty() {
            return Vec::new();
        }
        self.notice = Some("Copied to clipboard".into());
        vec![Action::Copy(text)]
    }

    /// `handleSelectionKey`: with a selection, ctrl+c copies it where a release did not; esc clears it, as does any
    /// other key, which then goes on. Returns the key's actions when the selection took it.
    fn selection_key(&mut self, key: &KeyEvent) -> Option<Vec<Action>> {
        self.selection?;
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            if !COPY_ON_SELECT {
                let out = self.copy_selection();
                if !out.is_empty() {
                    return Some(out);
                }
            }
            self.selection = None;
            return None;
        }
        let had = !self.selected_text().is_empty();
        self.selection = None;
        (key.code == KeyCode::Esc && had).then(Vec::new)
    }

    /// The transcript under the mouse: a click on a group's line opens or closes it, a drag selects.
    fn transcript_mouse(&mut self, m: &MouseEvent) -> Option<Vec<Action>> {
        let f = self.frame.get()?;
        let inside = m.column >= f.x && m.column < f.x + f.width && m.row >= f.y && m.row < f.y + f.height;
        let at = |m: &MouseEvent| (f.top + m.row.clamp(f.y, f.y + f.height.saturating_sub(1)).saturating_sub(f.y) as usize, m.column.saturating_sub(f.x).min(f.width.saturating_sub(1)) as usize);
        match m.kind {
            MouseEventKind::Down(MouseButton::Left) if inside => {
                self.selection = Some(Selection { anchor: at(m), head: at(m), dragged: false });
                self.clicks = None;
                Some(Vec::new())
            }
            MouseEventKind::Drag(MouseButton::Left) => {
                let sel = self.selection.as_mut()?;
                sel.head = at(m);
                sel.dragged = true;
                Some(Vec::new())
            }
            MouseEventKind::Up(MouseButton::Left) => {
                let sel = self.selection?;
                if !sel.dragged {
                    self.selection = None;
                    let head = self.laid.borrow().as_ref().and_then(|l| l.head_at(sel.anchor.0));
                    if let (Some(id), Some(sid)) = (head, self.session.clone()) {
                        let open = self.opened.get(&sid).and_then(|o| o.get(&id).copied()).unwrap_or_else(|| transcript::default_open(self.look(), id.1));
                        self.opened.entry(sid).or_default().insert(id, !open);
                    }
                    return Some(Vec::new());
                }
                Some(if COPY_ON_SELECT { self.copy_selection() } else { Vec::new() })
            }
            MouseEventKind::Down(MouseButton::Right) if !COPY_ON_SELECT && self.selection.is_some() => Some(self.copy_selection()),
            _ => None,
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
        self.running() || self.armed.is_some() || self.leader.is_some() || self.asides > 0 || self.link == Link::Connecting || matches!(self.dialog, Some(Dialog::Output { .. }))
            || self.current().is_some_and(|s| !s.foreground.is_empty())
    }

    /// Time passed: the spinner moves, an armed interrupt or leader lapses, the ctrl+b hint comes up and the output
    /// view reads more.
    pub fn on_tick(&mut self, now: Instant) -> Vec<Action> {
        self.tick = self.tick.wrapping_add(1);
        // `BackgroundToolHint`: 3 s after a shell call began holding the turn.
        let holding = self.current().is_some_and(|s| !s.foreground.is_empty());
        self.fg_since = if holding { Some(self.fg_since.unwrap_or(now)) } else { None };
        self.bg_hint = self.fg_since.is_some_and(|at| now.duration_since(at) >= BACKGROUND_HINT_DELAY);
        if self.armed.is_some_and(|at| now.duration_since(at) >= INTERRUPT_WINDOW) {
            self.armed = None;
        }
        if self.leader.is_some_and(|at| now.duration_since(at) >= LEADER_WINDOW) {
            self.leader = None;
        }
        self.poll_output(now)
    }

    pub fn connected(&mut self) -> Vec<Action> {
        self.link = Link::Ready;
        let mut out = self.flush();
        if let Some(id) = self.resume.take() {
            out.extend(self.open_session(&id, None));
        }
        out
    }

    /// `session.start` answered: this is the session the prompt goes to once it is idle.
    pub fn started(&mut self, id: String) -> Vec<Action> {
        self.starting = false;
        self.tabs.open(&id);
        self.session = Some(id);
        self.scroll = 0;
        self.flush()
    }

    /// Shows another open session: its tab, its transcript from the newest row, and its lists.
    fn activate(&mut self, id: String) -> Vec<Action> {
        if self.session.as_ref() == Some(&id) {
            return Vec::new();
        }
        self.tabs.open(&id);
        self.session = Some(id);
        self.scroll = 0;
        self.options = None;
        self.armed = None;
        self.live().map(|session| vec![Action::Options { session }]).unwrap_or_default()
    }

    fn show(&mut self, id: Option<String>) -> Vec<Action> {
        match id {
            Some(id) => self.activate(id),
            None => Vec::new(),
        }
    }

    /// The scroll in effect: where the timeline jumped, until a key or the wheel moves it.
    pub fn scroll_now(&self) -> usize {
        self.jumped.get().unwrap_or(self.scroll)
    }

    fn settle(&mut self) {
        if let Some(s) = self.jumped.take() {
            self.scroll = s;
        }
    }

    /// Whether the terminal pane shows (P5 #48).
    pub fn terminal_shown(&self) -> bool {
        crate::terminal::pane(self, self.side.width.get()).is_some()
    }

    /// `terminal.toggle`: hides the pane when it shows; else shows the last terminal, or opens one.
    fn toggle_terminal(&mut self) -> Vec<Action> {
        if self.terminal_shown() {
            self.terms.visible = None;
            self.terms.focused = false;
            return Vec::new();
        }
        if self.terms.is_empty() {
            return self.open_terminal();
        }
        self.select_terminal(self.terms.list.len() - 1)
    }

    /// `session.terminal`: a new terminal, shown and focused once its shell starts.
    pub(crate) fn open_terminal(&mut self) -> Vec<Action> {
        vec![Action::NewTerminal]
    }

    /// Shows the i-th terminal and gives it the keys. A sidebar opened by hand gives the right pane up.
    pub(crate) fn select_terminal(&mut self, i: usize) -> Vec<Action> {
        if i < self.terms.list.len() {
            self.terms.visible = Some(i);
            self.terms.focused = true;
            self.side.open = false;
            self.composer = None;
        }
        Vec::new()
    }

    /// The terminal title (`app.tsx`): `Lykos` on the home screen and for an untitled session, else
    /// `Lykos | <title>`, cut to 37 characters and `…` past 40.
    pub fn window_title(&self) -> String {
        match self.current().and_then(|s| s.summary.title.clone()).filter(|t| !t.trim().is_empty()) {
            None => "Lykos".into(),
            Some(t) if t.chars().count() > 40 => format!("Lykos | {}…", t.chars().take(37).collect::<String>()),
            Some(t) => format!("Lykos | {t}"),
        }
    }

    pub(crate) fn ledger_id(&self) -> Option<String> {
        self.current().and_then(|s| s.summary.ledger_session_id.clone())
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
        if matches!(event.data, EventData::TurnEnd) {
            self.tabs.finished(&event.session, self.session.as_deref());
        }
        if Some(&event.session) == self.session.as_ref() {
            // An undone prompt comes back to be edited (P5 #42).
            // An undone prompt comes back ahead of anything typed since; an empty one (a redo) leaves the box alone.
            if let EventData::PromptSet { text } = &event.data {
                if text.is_empty() {
                    return Vec::new();
                }
                let now = self.editor.text().to_string();
                self.editor.set(&if now.is_empty() { text.clone() } else { format!("{text}\n{now}") });
                return self.refresh_menu();
            }
            if let EventData::SessionStatus { session } = &event.data {
                if session.status != SessionStatus::Running && session.status != SessionStatus::Waiting {
                    self.armed = None;
                }
            }
            let mut out = self.flush();
            if matches!(event.data, EventData::Commands { .. }) {
                if self.menu.as_ref().is_some_and(|m| m.trigger == Trigger::Slash) {
                    out.extend(self.refresh_menu());
                }
                out.push(Action::Options { session: event.session.clone() });
            }
            return out;
        }
        Vec::new()
    }

    pub fn on_files(&mut self, files: Vec<String>) -> Vec<Action> {
        self.files = Some(files);
        self.refresh_menu()
    }

    /// The config layers' key bindings (`config.keybinds`). What cannot be read is shown, and the rest applies.
    pub fn on_keybinds(&mut self, result: Result<serde_json::Value, String>) {
        let problems = match result {
            Ok(v) => self.keymap.apply(&v["keybinds"]),
            Err(e) => vec![format!("key bindings: {e}")],
        };
        if !problems.is_empty() {
            self.notice = Some(problems.join("; "));
        }
    }

    pub fn on_aside(&mut self, question: String, answer: Result<String, String>) {
        self.asides = self.asides.saturating_sub(1);
        self.dialog = Some(Dialog::Aside { question, answer, scroll: 0 });
    }

    /// `session.options`' answer: what the lists show.
    pub fn on_options(&mut self, result: Result<SessionOptions, String>) {
        match result {
            Ok(o) => self.options = Some(o),
            Err(e) => self.notice = Some(format!("the lists: {e}")),
        }
    }

    /// The model in use: the status line's, else what the lists last said.
    pub fn model_now(&self) -> Option<String> {
        let usage = self.current().and_then(|s| s.usage.as_ref()).and_then(|u| u.model.clone());
        usage.or_else(|| self.options.as_ref().map(|o| o.model.clone())).filter(|m| !m.is_empty())
    }

    pub fn effort_now(&self) -> Option<String> {
        let usage = self.current().and_then(|s| s.usage.as_ref()).and_then(|u| u.effort.clone());
        usage.or_else(|| self.options.as_ref().and_then(|o| o.effort.clone())).filter(|e| !e.is_empty())
    }

    /// A live session to send a command to, and a refresh of the lists for it.
    fn live(&self) -> Option<String> {
        self.session.clone().filter(|_| self.link == Link::Ready && matches!(self.status(), Some(s) if s != SessionStatus::Starting && s != SessionStatus::Closed))
    }

    /// Opens a list on the row in use, and asks the session for fresh lists.
    fn open_list(&mut self, list: List) -> Vec<Action> {
        let selected = self.list_rows(&list, "").iter().position(|r| r.current).unwrap_or(0);
        let refresh = !matches!(list, List::Themes { .. });
        self.dialog = Some(Dialog::List { list, query: String::new(), selected });
        match self.live() {
            Some(session) if refresh => vec![Action::Options { session }],
            _ => Vec::new(),
        }
    }

    /// A session command a list runs, sent as if typed: it takes effect on the next request.
    fn command(&mut self, text: String) -> Vec<Action> {
        match self.live() {
            Some(session) => vec![Action::Prompt { session, text }],
            None => {
                self.notice = Some("Open a session first".into());
                Vec::new()
            }
        }
    }

    /// The rows of a list for its query, in the order shown.
    pub fn list_rows(&self, list: &List, query: &str) -> Vec<Row> {
        let row = |value: String, title: String, detail: String, group: &str, current: bool, favorite: bool| Row { value, title, detail, group: group.to_string(), current, favorite };
        let o = self.options.as_ref();
        let rows: Vec<Row> = match list {
            // `dialog-model.tsx`: Favorites, then Recent, then each provider's models; a search ranks them all,
            // favorites first.
            List::Models => {
                let now = self.model_now();
                let models = o.map(|o| o.models.as_slice()).unwrap_or_default();
                let make = |m: &lykos_client::ModelOption, group: &str| {
                    let key = format!("{}/{}", m.provider, m.id);
                    let mut detail = m.provider.clone();
                    if let Some(c) = m.context_window {
                        detail.push_str(&format!(" · {}", tokens(c)));
                    }
                    if m.reasoning {
                        detail.push_str(" · Reasoning");
                    }
                    let fav = self.prefs.favorite.contains(&key);
                    row(key.clone(), m.name.clone(), detail, group, now.as_deref() == Some(key.as_str()), fav)
                };
                let find = |key: &str| models.iter().find(|m| format!("{}/{}", m.provider, m.id) == key);
                if query.is_empty() {
                    let mut out: Vec<Row> = self.prefs.favorite.iter().filter_map(|k| find(k)).map(|m| make(m, "Favorites")).collect();
                    out.extend(self.prefs.recent.iter().filter(|k| !self.prefs.favorite.contains(k)).filter_map(|k| find(k)).map(|m| make(m, "Recent")));
                    let shown: Vec<String> = out.iter().map(|r| r.value.clone()).collect();
                    let mut rest: Vec<&lykos_client::ModelOption> = models.iter().filter(|m| !shown.contains(&format!("{}/{}", m.provider, m.id))).collect();
                    rest.sort_by(|a, b| a.provider.cmp(&b.provider));
                    out.extend(rest.into_iter().map(|m| make(m, &m.provider)));
                    out
                } else {
                    let mut scored: Vec<(bool, u32, Row)> = models
                        .iter()
                        .filter_map(|m| {
                            let s = [menu::score(query, &m.name), menu::score(query, &m.provider), menu::score(query, &m.id)];
                            s.iter().any(Option::is_some).then(|| {
                                let r = make(m, "");
                                (r.favorite, s.iter().flatten().sum(), r)
                            })
                        })
                        .collect();
                    scored.sort_by_key(|(f, s, _)| (std::cmp::Reverse(*f), std::cmp::Reverse(*s)));
                    return scored.into_iter().map(|(_, _, r)| r).collect();
                }
            }
            List::Efforts => {
                let now = self.effort_now();
                o.map(|o| o.efforts.clone()).unwrap_or_default().into_iter().map(|e| row(e.clone(), e.clone(), String::new(), "", now.as_deref() == Some(e.as_str()), false)).collect()
            }
            List::Agents => o
                .map(|o| o.specialists.iter().map(|s| row(s.name.clone(), s.name.clone(), s.description.clone(), "", s.name == o.specialist, false)).collect())
                .unwrap_or_default(),
            List::Themes { initial } => theme::PALETTES.iter().map(|p| row(p.name.into(), p.name.into(), if p.light() { "light".into() } else { "dark".into() }, "", p.name == *initial, false)).collect(),
            List::Providers => o
                .map(|o| o.providers.iter().map(|p| row(p.name.clone(), p.name.clone(), format!("{} · {}", p.reach, p.reason), "", false, false)).collect())
                .unwrap_or_default(),
        };
        if query.is_empty() || matches!(list, List::Models) {
            return rows;
        }
        let mut scored: Vec<(u32, Row)> = rows.into_iter().filter_map(|r| Some((menu::score(query, &r.title)? * 2 + menu::score(query, &r.detail).unwrap_or(0), r))).collect();
        scored.sort_by_key(|(s, _)| std::cmp::Reverse(*s));
        scored.into_iter().map(|(_, r)| r).collect()
    }

    fn list_key(&mut self, key: &KeyEvent, ids: &[&str], list: List, mut query: String, mut selected: usize, page: usize) -> Vec<Action> {
        let has = |id: &str| ids.contains(&id);
        let rows = self.list_rows(&list, &query);
        let n = rows.len();
        let chosen = rows.get(selected).cloned();
        if has("dialog.close") {
            if let List::Themes { initial } = list {
                theme::set(initial);
            }
            self.dialog = None;
            return Vec::new();
        }
        if has("dialog.select.submit") {
            let Some(r) = chosen else { return Vec::new() };
            self.dialog = None;
            return match list {
                List::Models => {
                    self.prefs.used(&r.value);
                    self.command(format!("/model {}", r.value))
                }
                List::Efforts => self.command(format!("/effort {}", r.value)),
                List::Agents => self.switch_specialist(r.value),
                List::Themes { .. } => {
                    theme::set(&r.value);
                    self.prefs.set_theme(&r.value);
                    Vec::new()
                }
                List::Providers => self.connect(&r.value),
            };
        }
        if let List::Models = list {
            if has("model.dialog.favorite") {
                if let Some(r) = chosen {
                    self.prefs.toggle_favorite(&r.value);
                }
                return Vec::new();
            }
            if has("model.dialog.provider") {
                return self.open_list(List::Providers);
            }
            if has("model.dialog.usage") {
                self.dialog = Some(Dialog::Info { info: Info::Usage });
                return Vec::new();
            }
        }
        let before = (query.clone(), selected);
        select(key, ids, Some(&mut query), &mut selected, n, page);
        // `dialog-theme-list.tsx`: the theme under the cursor shows at once; with an empty query, the first again.
        if let List::Themes { initial } = list {
            if (query.clone(), selected) != before {
                let rows = self.list_rows(&list, &query);
                theme::set(rows.get(selected).map_or(initial, |r| r.value.as_str()));
            }
        }
        self.dialog = Some(Dialog::List { list, query, selected });
        Vec::new()
    }

    /// `dialog-session-list.tsx`: root sessions, not archived; Pinned, then by day ("Today", else the date), newest
    /// first. A search ranks the titles. Lykos groups by the UTC day the session started.
    pub fn session_rows(&self, query: &str, confirm: Option<&str>) -> Vec<Row> {
        let Some(past) = &self.past else { return Vec::new() };
        let me = self.ledger_id();
        let today = today_utc();
        let delete = self.keymap.first("session.delete");
        let make = |r: &HistoryRow, group: String| {
            let title = if confirm == Some(r.id.as_str()) { format!("Press {delete} again to confirm") } else { r.title.clone().unwrap_or_else(|| "Untitled session".into()) };
            let time = r.started_utc.get(11..16).unwrap_or_default().to_string();
            let mut detail = match &r.project_name {
                Some(p) => format!("{p} · {time}"),
                None => time,
            };
            // P5 #51: an MCP or `lykos run` session that runs now, named by its owner.
            if let Some(d) = past.delegated.get(&r.id) {
                detail = format!("{} {} · {detail}", owner_label(&d.owner).unwrap_or(d.owner.as_str()), d.state);
            }
            Row { value: r.id.clone(), title, detail, group, current: me.as_deref() == Some(r.id.as_str()), favorite: self.prefs.pinned.contains(&r.id) }
        };
        let roots = past.rows.iter().filter(|r| r.parent_session_id.is_none() && !r.archived);
        if !query.is_empty() {
            let mut scored: Vec<(u32, Row)> = roots.filter_map(|r| Some((menu::score(query, r.title.as_deref().unwrap_or_default())?, make(r, String::new())))).collect();
            scored.sort_by_key(|(s, _)| std::cmp::Reverse(*s));
            return scored.into_iter().map(|(_, r)| r).collect();
        }
        let roots: Vec<&HistoryRow> = roots.collect();
        let mut out: Vec<Row> = self.prefs.pinned.iter().filter_map(|p| roots.iter().find(|r| &r.id == p)).map(|r| make(r, "Pinned".into())).collect();
        for r in roots.iter().filter(|r| !self.prefs.pinned.contains(&r.id)) {
            let day = r.started_utc.get(..10).unwrap_or_default();
            out.push(make(r, if day == today { "Today".into() } else { day.to_string() }));
        }
        out
    }

    /// `dialog-timeline.tsx`: the session's prompts, newest first; the value is the transcript item.
    pub fn timeline_rows(&self, query: &str) -> Vec<Row> {
        let Some(s) = self.current() else { return Vec::new() };
        let rows = s.items.iter().enumerate().rev().filter_map(|(i, it)| match it {
            Item::User(t) => Some(Row { value: i.to_string(), title: t.lines().next().unwrap_or_default().to_string(), detail: String::new(), group: String::new(), current: false, favorite: false }),
            _ => None,
        });
        if query.is_empty() {
            return rows.collect();
        }
        let mut scored: Vec<(u32, Row)> = rows.filter_map(|r| Some((menu::score(query, &r.title)?, r))).collect();
        scored.sort_by_key(|(s, _)| std::cmp::Reverse(*s));
        scored.into_iter().map(|(_, r)| r).collect()
    }

    /// `dialog-workspaces.tsx`: the project's worktrees, the one the session runs in marked.
    pub fn worktree_rows(&self) -> Vec<Row> {
        let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
        let cwd = norm(self.current().map_or(self.cwd.as_str(), |s| s.summary.cwd.as_str()));
        self.worktrees
            .iter()
            .flatten()
            .map(|w| {
                let mut detail = w.branch.clone().unwrap_or_else(|| "detached".into());
                if w.main {
                    detail.push_str(" · main checkout");
                }
                if w.sessions {
                    detail.push_str(" · in use");
                }
                Row { value: w.path.clone(), title: w.path.clone(), detail, group: String::new(), current: norm(&w.path) == cwd, favorite: false }
            })
            .collect()
    }

    pub(crate) fn history_call(&self, all: bool, then: Then) -> Action {
        Action::Call { method: "sessions.history", params: json!({ "cwd": self.cwd, "all": all }), then }
    }

    fn worktrees_call(&self) -> Action {
        Action::Call { method: "worktree.list", params: json!({ "cwd": self.cwd }), then: Then::Worktrees }
    }

    fn open_sessions(&mut self, all: bool) -> Vec<Action> {
        self.past = None;
        self.dialog = Some(Dialog::Sessions { query: String::new(), selected: 0, all, confirm: None });
        vec![self.history_call(all, Then::History)]
    }

    fn open_worktrees(&mut self) -> Vec<Action> {
        self.worktrees = None;
        self.dialog = Some(Dialog::Worktrees { selected: 0, confirm: None });
        vec![self.worktrees_call()]
    }

    /// A session of the list: its tab when it runs here, watched when an MCP server or `lykos run` runs it (P5
    /// #51), else resumed (`session.start` with `resume`).
    fn open_session(&mut self, id: &str, cwd: Option<String>) -> Vec<Action> {
        // One start at a time: a second press before the first answers would resume the session twice.
        if self.starting {
            return Vec::new();
        }
        let live = self.past.as_ref().and_then(|p| p.live.get(id)).cloned();
        if let Some(sid) = live.filter(|sid| self.store.sessions.get(sid).is_some_and(|s| s.summary.status != SessionStatus::Closed)) {
            return self.activate(sid);
        }
        self.starting = true;
        let cwd = cwd.unwrap_or_else(|| self.cwd.clone());
        if self.past.as_ref().is_some_and(|p| p.delegated.contains_key(id)) {
            return vec![Action::Call { method: "session.watch", params: json!({ "cwd": cwd, "id": id }), then: Then::Started { replaces: None } }];
        }
        vec![Action::Call { method: "session.start", params: json!({ "cwd": cwd, "origin": "tui", "resume": id }), then: Then::Started { replaces: None } }]
    }

    /// An answer to `Action::Call`.
    pub fn on_reply(&mut self, then: Then, result: Result<Value, String>) -> Vec<Action> {
        let v = match result {
            Ok(v) => v,
            Err(e) => {
                if then == Then::Diff {
                    self.on_diff(Err(e));
                    return Vec::new();
                }
                if let Then::JobLog(id) = &then {
                    self.on_job_log(id, Err(e));
                    return Vec::new();
                }
                if matches!(then, Then::Started { .. }) {
                    self.starting = false;
                }
                self.notice = Some(e);
                // The list already left out what was archived: a failure shows it again.
                if let Then::Refresh { all } = then {
                    return vec![self.history_call(all, Then::History)];
                }
                return Vec::new();
            }
        };
        match then {
            Then::History => match serde_json::from_value::<Past>(v) {
                Ok(p) => self.past = Some(p),
                Err(e) => self.notice = Some(format!("the session list: {e}")),
            },
            Then::Navigate(nav) => {
                self.past = serde_json::from_value(v).ok();
                return self.navigate(nav);
            }
            Then::Started { replaces } => {
                if let Some(old) = replaces {
                    self.tabs.close(&old);
                }
                return self.started(v["id"].as_str().unwrap_or_default().to_string());
            }
            Then::Notice(text) => self.notice = Some(text.into()),
            Then::Refresh { all } => return vec![self.history_call(all, Then::History)],
            Then::Exported => self.notice = Some(format!("Exported to {}", v["path"].as_str().unwrap_or_default())),
            Then::Worktrees => match serde_json::from_value(v) {
                Ok(w) => self.worktrees = Some(w),
                Err(e) => self.notice = Some(format!("the worktrees: {e}")),
            },
            Then::WorktreesChanged => return vec![self.worktrees_call()],
            Then::Diff => self.on_diff(Ok(v)),
            Then::Quiet => {}
            Then::JobLog(id) => self.on_job_log(&id, Ok(v)),
        }
        Vec::new()
    }

    /// `session.parent` and `session.child.*`: the ledger's parent and child sessions.
    fn navigate(&mut self, nav: Nav) -> Vec<Action> {
        let (Some(me), Some(past)) = (self.ledger_id(), self.past.clone()) else { return Vec::new() };
        let row = |id: &str| past.rows.iter().find(|r| r.id == id).cloned();
        let target = match nav {
            Nav::Parent => row(&me).and_then(|r| r.parent_session_id),
            Nav::Child(0) => past.rows.iter().find(|r| r.parent_session_id.as_deref() == Some(me.as_str())).map(|r| r.id.clone()),
            Nav::ChildAt(n) => {
                let mut children: Vec<&HistoryRow> = past.rows.iter().filter(|r| r.parent_session_id.as_deref() == Some(me.as_str())).collect();
                children.sort_by(|a, b| a.started_utc.cmp(&b.started_utc));
                children.get(n).map(|r| r.id.clone())
            }
            Nav::Child(step) => {
                let parent = row(&me).and_then(|r| r.parent_session_id);
                let siblings: Vec<&HistoryRow> = past.rows.iter().filter(|r| parent.is_some() && r.parent_session_id == parent).collect();
                siblings.iter().position(|r| r.id == me).map(|i| siblings[(i as isize + step).rem_euclid(siblings.len() as isize) as usize].id.clone())
            }
        };
        match target {
            Some(id) => {
                let cwd = row(&id).and_then(|r| r.project_path);
                self.open_session(&id, cwd)
            }
            None => {
                self.notice = Some(if nav == Nav::Parent { "This session has no parent" } else { "No child sessions" }.into());
                Vec::new()
            }
        }
    }

    /// `session.copy`: the transcript as Markdown.
    fn transcript_text(&self) -> String {
        let Some(s) = self.current() else { return String::new() };
        let mut out = Vec::new();
        for it in &s.items {
            match it {
                Item::User(t) | Item::Followup(t) => out.push(format!("## User\n\n{t}")),
                Item::Assistant(t) => out.push(format!("## Assistant\n\n{}", t.trim_end())),
                Item::Tool { name, summary, .. } => out.push(format!("**Tool: {name}** {summary}")),
                Item::Thinking(_) | Item::System(_) => {}
            }
        }
        out.join("\n\n") + "\n"
    }

    /// The session actions (P5 #42), as OpenCode's `app.tsx` and `routes/session/index.tsx` run them.
    fn run_session(&mut self, id: &str) -> Option<Vec<Action>> {
        if let Some(out) = self.run_view(id) {
            return Some(out);
        }
        if id == "diff.open" {
            return Some(self.open_diff());
        }
        if id == "session.sidebar.toggle" {
            self.toggle_sidebar();
            return Some(Vec::new());
        }
        let current = self.session.clone();
        let out = match id {
            // OpenCode opens the home screen; the next prompt starts the session.
            "session.new" => {
                self.session = None;
                self.scroll = 0;
                Vec::new()
            }
            "session.list" => self.open_sessions(false),
            "open.menu" => self.open_sessions(true),
            "session.tab.next" => self.show(self.tabs.cycle(current.as_deref(), 1, false)),
            "session.tab.previous" => self.show(self.tabs.cycle(current.as_deref(), -1, false)),
            "session.tab.next_unread" => self.show(self.tabs.cycle(current.as_deref(), 1, true)),
            "session.tab.previous_unread" => self.show(self.tabs.cycle(current.as_deref(), -1, true)),
            "session.tab.history.back" => {
                let back = self.tabs.step_history(true);
                self.show(back)
            }
            "session.tab.history.forward" => {
                let forward = self.tabs.step_history(false);
                self.show(forward)
            }
            "session.tab.close" => {
                let Some(id) = current else { return Some(Vec::new()) };
                let next = self.tabs.close(&id);
                self.session = None;
                self.show(next)
            }
            "session.tab.reopen" => {
                let next = self.tabs.reopen();
                self.show(next)
            }
            "session.timeline" => {
                if self.timeline_rows("").is_empty() {
                    self.notice = Some("No messages yet".into());
                } else {
                    self.dialog = Some(Dialog::Timeline { query: String::new(), selected: 0 });
                }
                Vec::new()
            }
            "session.rename" => match self.ledger_id() {
                Some(id) => {
                    let text = self.current().and_then(|s| s.summary.title.clone()).unwrap_or_default();
                    self.dialog = Some(Dialog::Input { title: "Rename session".into(), text, purpose: Purpose::Rename { id, cwd: self.cwd.clone(), all: None } });
                    Vec::new()
                }
                None => self.need_session(),
            },
            "session.fork" => self.command("/fork".into()),
            "session.compact" => self.command("/compact".into()),
            "session.undo" => self.command("/undo".into()),
            "session.redo" => self.command("/redo".into()),
            "session.copy" => {
                if self.current().is_none() {
                    return Some(self.need_session());
                }
                self.notice = Some("Copied to clipboard".into());
                vec![Action::Copy(self.transcript_text())]
            }
            "session.copy.id" => match self.ledger_id() {
                Some(id) => {
                    self.notice = Some("Session ID copied to clipboard!".into());
                    vec![Action::Copy(id)]
                }
                None => self.need_session(),
            },
            // P22's Markdown, as `lykos export` writes it, to a file in the workspace named after the session.
            "session.export" => match self.ledger_id() {
                Some(id) => {
                    let file = format!("session-{id}.md");
                    vec![Action::Call { method: "session.export", params: json!({ "cwd": self.cwd, "ledgerSessionId": id, "file": file }), then: Then::Exported }]
                }
                None => self.need_session(),
            },
            "session.move" => self.open_worktrees(),
            "session.cd" => match self.live() {
                Some(_) => {
                    let text = self.current().map(|s| s.summary.cwd.clone()).unwrap_or_default();
                    self.dialog = Some(Dialog::Input { title: "Change working directory".into(), text, purpose: Purpose::Cd });
                    Vec::new()
                }
                None => self.need_session(),
            },
            // OpenCode's `down`: the composer, from the end of the prompt and outside a history browse; elsewhere the
            // key moves in the prompt.
            "session.child.first" => {
                let at_end = self.editor.cursor() == self.editor.text().len();
                if self.composer.is_none() && (!at_end || self.history.browsing() || self.current().is_none()) {
                    return None;
                }
                self.toggle_composer(None)
            }
            // `session.background`: only while a shell call holds the turn; else ctrl+b moves left in the prompt.
            "session.background" => {
                let session = current.clone()?;
                if self.current().is_none_or(|s| s.foreground.is_empty()) {
                    return None;
                }
                vec![Action::Call { method: "session.background", params: json!({ "session": session }), then: Then::Quiet }]
            }
            "session.terminal" => vec![Action::NewTerminal],
            "session.parent" | "session.child.next" | "session.child.previous" => {
                if self.ledger_id().is_none() {
                    return Some(self.need_session());
                }
                let nav = match id {
                    "session.parent" => Nav::Parent,
                    "session.child.next" => Nav::Child(1),
                    _ => Nav::Child(-1),
                };
                vec![self.history_call(false, Then::Navigate(nav))]
            }
            _ => {
                let n: usize = id.strip_prefix("session.tab.select.")?.parse().ok()?;
                let tab = self.tabs.open.get(n.checked_sub(1)?).cloned();
                self.show(tab)
            }
        };
        Some(out)
    }

    fn need_session(&mut self) -> Vec<Action> {
        self.notice = Some("Open a session first".into());
        Vec::new()
    }

    /// The session list's keys: open, delete (archive) on a second press, rename, pin, every project. The dialog's
    /// four fields come in as they are.
    #[allow(clippy::too_many_arguments)]
    fn sessions_key(&mut self, key: &KeyEvent, ids: &[&str], mut query: String, mut selected: usize, mut all: bool, confirm: Option<String>, page: usize) -> Vec<Action> {
        let has = |id: &str| ids.contains(&id);
        let rows = self.session_rows(&query, confirm.as_deref());
        let chosen = rows.get(selected).cloned();
        let cwd_of = |app: &App, id: &str| app.past.as_ref().and_then(|p| p.rows.iter().find(|r| r.id == id)).and_then(|r| r.project_path.clone());
        if has("dialog.close") {
            self.dialog = None;
            return Vec::new();
        }
        if has("dialog.select.submit") {
            let Some(r) = chosen else { return Vec::new() };
            self.dialog = None;
            let cwd = cwd_of(self, &r.value);
            return self.open_session(&r.value, cwd);
        }
        if has("session.delete") {
            let Some(r) = chosen else { return Vec::new() };
            if confirm.as_deref() != Some(r.value.as_str()) {
                self.dialog = Some(Dialog::Sessions { query, selected, all, confirm: Some(r.value) });
                return Vec::new();
            }
            // Nothing is deleted: the session is archived, and stays in `lykos session --all`.
            let cwd = cwd_of(self, &r.value).unwrap_or_else(|| self.cwd.clone());
            if let Some(p) = self.past.as_mut() {
                p.rows.retain(|x| x.id != r.value);
            }
            self.dialog = Some(Dialog::Sessions { query, selected: selected.min(rows.len().saturating_sub(2)), all, confirm: None });
            return vec![Action::Call { method: "session.archive", params: json!({ "cwd": cwd, "ledgerSessionId": r.value }), then: Then::Refresh { all } }];
        }
        if has("session.list.rename") {
            let Some(r) = chosen else { return Vec::new() };
            let cwd = cwd_of(self, &r.value).unwrap_or_else(|| self.cwd.clone());
            let text = self.past.as_ref().and_then(|p| p.rows.iter().find(|x| x.id == r.value)).and_then(|x| x.title.clone()).unwrap_or_default();
            self.dialog = Some(Dialog::Input { title: "Rename session".into(), text, purpose: Purpose::Rename { id: r.value, cwd, all: Some(all) } });
            return Vec::new();
        }
        if has("session.pin.toggle") {
            if let Some(r) = chosen {
                self.prefs.toggle_pin(&r.value);
            }
            self.dialog = Some(Dialog::Sessions { query, selected, all, confirm: None });
            return Vec::new();
        }
        if has("session.list.all") {
            all = !all;
            self.past = None;
            self.dialog = Some(Dialog::Sessions { query, selected: 0, all, confirm: None });
            return vec![self.history_call(all, Then::History)];
        }
        select(key, ids, Some(&mut query), &mut selected, rows.len(), page);
        self.dialog = Some(Dialog::Sessions { query, selected, all, confirm: None });
        Vec::new()
    }

    fn timeline_key(&mut self, key: &KeyEvent, ids: &[&str], mut query: String, mut selected: usize, page: usize) -> Vec<Action> {
        let rows = self.timeline_rows(&query);
        if ids.contains(&"dialog.close") {
            self.dialog = None;
        } else if ids.contains(&"dialog.select.submit") {
            self.dialog = None;
            if let Some(i) = rows.get(selected).and_then(|r| r.value.parse().ok()) {
                self.jumped.set(None);
                self.jump.set(Some(i));
            }
        } else {
            select(key, ids, Some(&mut query), &mut selected, rows.len(), page);
            self.dialog = Some(Dialog::Timeline { query, selected });
        }
        Vec::new()
    }

    /// The worktrees dialog's keys: move the session (enter too), new, delete on a second press, refresh.
    fn worktrees_key(&mut self, key: &KeyEvent, ids: &[&str], mut selected: usize, confirm: Option<String>, page: usize) -> Vec<Action> {
        let has = |id: &str| ids.contains(&id);
        let rows = self.worktree_rows();
        let chosen = rows.get(selected).cloned();
        if has("dialog.close") {
            self.dialog = None;
            return Vec::new();
        }
        if has("dialog.select.submit") || has("dialog.move_session.move") {
            let Some(r) = chosen else { return Vec::new() };
            let Some(session) = self.live() else { return self.need_session() };
            self.dialog = None;
            if r.current {
                return Vec::new();
            }
            return vec![Action::Call { method: "session.move", params: json!({ "session": session, "cwd": r.value }), then: Then::Started { replaces: Some(session) } }];
        }
        if has("dialog.move_session.new") {
            self.dialog = Some(Dialog::Input { title: "New worktree".into(), text: String::new(), purpose: Purpose::Worktree });
            return Vec::new();
        }
        if has("dialog.move_session.delete") {
            let Some(r) = chosen else { return Vec::new() };
            if r.detail.contains("main checkout") {
                self.notice = Some("The project's own checkout is not removed from here".into());
                return Vec::new();
            }
            if confirm.as_deref() != Some(r.value.as_str()) {
                self.notice = Some(format!("Press {} again to remove {}; its branch and commits stay", self.keymap.first("dialog.move_session.delete"), r.value));
                self.dialog = Some(Dialog::Worktrees { selected, confirm: Some(r.value) });
                return Vec::new();
            }
            self.dialog = Some(Dialog::Worktrees { selected: 0, confirm: None });
            return vec![Action::Call { method: "worktree.remove", params: json!({ "cwd": self.cwd, "path": r.value }), then: Then::WorktreesChanged }];
        }
        if has("dialog.move_session.refresh") {
            self.dialog = Some(Dialog::Worktrees { selected, confirm: None });
            return vec![self.worktrees_call()];
        }
        select(key, ids, None, &mut selected, rows.len(), page);
        self.dialog = Some(Dialog::Worktrees { selected, confirm: None });
        Vec::new()
    }

    fn input_key(&mut self, key: &KeyEvent, ids: &[&str], title: String, mut text: String, purpose: Purpose) -> Vec<Action> {
        if ids.contains(&"dialog.close") {
            self.dialog = match purpose {
                Purpose::Worktree => Some(Dialog::Worktrees { selected: 0, confirm: None }),
                _ => None,
            };
            return Vec::new();
        }
        if ids.contains(&"dialog.select.submit") {
            let value = text.trim().to_string();
            if value.is_empty() {
                return Vec::new();
            }
            self.dialog = None;
            return match purpose {
                Purpose::Rename { id, cwd, all } => {
                    let then = match all {
                        Some(all) => {
                            self.dialog = Some(Dialog::Sessions { query: String::new(), selected: 0, all, confirm: None });
                            Then::Refresh { all }
                        }
                        None => Then::Notice("Session renamed"),
                    };
                    vec![Action::Call { method: "session.rename", params: json!({ "cwd": cwd, "ledgerSessionId": id, "title": value }), then }]
                }
                Purpose::Worktree => {
                    self.dialog = Some(Dialog::Worktrees { selected: 0, confirm: None });
                    vec![Action::Call { method: "worktree.create", params: json!({ "cwd": self.cwd, "name": value }), then: Then::WorktreesChanged }]
                }
                Purpose::Cd => match self.live() {
                    Some(session) => vec![Action::Call { method: "session.move", params: json!({ "session": session, "cwd": value }), then: Then::Started { replaces: Some(session) } }],
                    None => self.need_session(),
                },
            };
        }
        if key.code == KeyCode::Backspace {
            text.pop();
        } else if let KeyCode::Char(c) = key.code {
            if !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) {
                text.push(c);
            }
        }
        self.dialog = Some(Dialog::Input { title, text, purpose });
        Vec::new()
    }

    fn switch_specialist(&mut self, name: String) -> Vec<Action> {
        let out = self.command(format!("/specialist {name}"));
        if let (false, Some(o)) = (out.is_empty(), self.options.as_mut()) {
            o.specialist = name;
        }
        out
    }

    /// `/login` signs in to an OAuth provider from here; an API key is typed in a terminal, where it is not shown.
    fn connect(&mut self, name: &str) -> Vec<Action> {
        let oauth = self.options.as_ref().and_then(|o| o.providers.iter().find(|p| p.name == name)).is_some_and(|p| p.auth.contains("oauth"));
        if oauth {
            return self.command(format!("/login {name}"));
        }
        self.notice = Some(format!("{name} takes an API key: run `lykos login {name} --api-key` in a terminal"));
        Vec::new()
    }

    /// `local.tsx` `model.cycle` and `cycleFavorite`: the next model of the list after the one in use, wrapping.
    fn cycle_model(&mut self, favorites: bool, direction: isize) -> Vec<Action> {
        let known: Vec<String> = self.options.as_ref().map(|o| o.models.iter().map(|m| format!("{}/{}", m.provider, m.id)).collect()).unwrap_or_default();
        let list: Vec<String> = if favorites { &self.prefs.favorite } else { &self.prefs.recent }.iter().filter(|m| known.contains(m)).cloned().collect();
        if list.is_empty() {
            if favorites {
                self.notice = Some("Add a favorite model to use this shortcut".into());
            }
            return Vec::new();
        }
        let n = list.len() as isize;
        let next = match self.model_now().and_then(|m| list.iter().position(|x| *x == m)) {
            Some(i) => (i as isize + direction).rem_euclid(n),
            None if direction > 0 => 0,
            None => n - 1,
        };
        let model = list[next as usize].clone();
        if favorites {
            self.prefs.used(&model);
        }
        self.command(format!("/model {model}"))
    }

    /// `variant.cycle`: the next effort level, wrapping (Lykos has no "default" level to return to).
    fn cycle_effort(&mut self) -> Vec<Action> {
        let efforts = self.options.as_ref().map(|o| o.efforts.clone()).unwrap_or_default();
        if efforts.is_empty() {
            self.notice = Some(if self.options.is_some() { "this model has no effort levels" } else { "Open a session first" }.into());
            return Vec::new();
        }
        let next = match self.effort_now().and_then(|e| efforts.iter().position(|x| *x == e)) {
            Some(i) => (i + 1) % efforts.len(),
            None => 0,
        };
        if let Some(o) = self.options.as_mut() {
            o.effort = Some(efforts[next].clone());
        }
        self.command(format!("/effort {}", efforts[next]))
    }

    /// `agent.cycle`: the old TUI's Shift+Tab, through the primary specialists.
    fn cycle_specialist(&mut self, direction: isize) -> Vec<Action> {
        let Some(o) = self.options.as_ref() else {
            self.notice = Some("Open a session first".into());
            return Vec::new();
        };
        let names: Vec<String> = o.specialists.iter().map(|s| s.name.clone()).collect();
        if names.is_empty() {
            return Vec::new();
        }
        let n = names.len() as isize;
        let next = match names.iter().position(|x| *x == o.specialist) {
            Some(i) => (i as isize + direction).rem_euclid(n),
            None => 0,
        };
        self.switch_specialist(names[next as usize].clone())
    }

    /// `theme.switch_mode`: the light or dark palette paired with this one.
    fn switch_mode(&mut self) {
        let pair = theme::c().pair;
        if theme::set(pair) {
            self.prefs.set_theme(pair);
        }
    }

    /// The debug dialog's rows (`dialog-debug.tsx`), as copied.
    pub fn debug_rows(&self) -> Vec<(&'static str, String)> {
        let terminal = ["TERM_PROGRAM", "WT_SESSION", "TERM"].iter().find_map(|v| std::env::var(v).ok().filter(|s| !s.is_empty()).map(|s| if *v == "WT_SESSION" { "Windows Terminal".to_string() } else { s }));
        vec![
            ("Version", format!("lykos-tui {}", env!("CARGO_PKG_VERSION"))),
            ("OS", format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)),
            ("Terminal", terminal.unwrap_or_else(|| "unknown".into())),
            ("Session ID", self.current().and_then(|s| s.summary.ledger_session_id.clone()).unwrap_or_else(|| "n/a".into())),
            ("Model", self.model_now().unwrap_or_else(|| "n/a".into())),
        ]
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
        if let Some(dialog) = &mut self.dialog {
            // A paste into a dialog's search or text field types its text there, on one line. A dialog that answers
            // keys (a prompt, a confirmation) takes none of it, so a paste never answers one. On Windows, keys that
            // arrive together are read as a paste (`paste.rs`), so this is also fast typing into a search.
            let line: String = text.chars().map(|c| if c.is_whitespace() { ' ' } else { c }).filter(|c| !c.is_control()).collect();
            match dialog {
                Dialog::Palette { query, selected }
                | Dialog::List { query, selected, .. }
                | Dialog::Timeline { query, selected }
                | Dialog::Sessions { query, selected, confirm: None, .. } => {
                    query.push_str(&line);
                    *selected = 0;
                }
                Dialog::Input { text, .. } => text.push_str(&line),
                _ => {}
            }
            return Vec::new();
        }
        if self.terms.focused && self.terminal_shown() {
            if let Some(t) = self.terms.shown() {
                t.paste(text);
            }
            return Vec::new();
        }
        self.search = None;
        self.editor.paste(text);
        self.refresh_menu()
    }

    pub fn on_scroll(&mut self, up: bool, rows: usize) {
        self.settle();
        if let Some(Dialog::Aside { scroll, .. }) = &mut self.dialog {
            *scroll = if up { scroll.saturating_sub(rows) } else { scroll.saturating_add(rows) };
            return;
        }
        // The output view counts from its end.
        if let Some(Dialog::Output { scroll, .. }) = &mut self.dialog {
            *scroll = if up { scroll.saturating_add(rows) } else { scroll.saturating_sub(rows) };
            return;
        }
        self.scroll = if up { self.scroll.saturating_add(rows) } else { self.scroll.saturating_sub(rows) };
        self.nav = None;
    }

    /// The old TUI's mouse in the prompt box: a click puts the cursor, a drag selects, a double click selects a
    /// word and a triple click the whole prompt. The wheel scrolls the transcript.
    pub fn on_mouse(&mut self, m: MouseEvent, now: Instant) -> Vec<Action> {
        // A click in the terminal pane gives it the keys; a click elsewhere gives them back.
        if let (MouseEventKind::Down(_), None) = (m.kind, &self.dialog) {
            if let Some((x, y, w, h)) = self.terms.area.get() {
                let inside = m.column >= x && m.column < x + w && m.row >= y && m.row < y + h;
                self.terms.focused = inside;
                if inside {
                    self.composer = None;
                    return Vec::new();
                }
            }
        }
        if self.terms.area.get().is_some_and(|(x, y, w, h)| m.column >= x && m.column < x + w && m.row >= y && m.row < y + h) {
            return Vec::new();
        }
        match m.kind {
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown if self.diff_mouse(&m) => return Vec::new(),
            _ if self.dialog.is_none() && self.sidebar_mouse(&m) => return Vec::new(),
            MouseEventKind::ScrollUp => {
                self.on_scroll(true, 3);
                return Vec::new();
            }
            MouseEventKind::ScrollDown => {
                self.on_scroll(false, 3);
                return Vec::new();
            }
            _ => {}
        }
        if self.dialog.is_none() {
            if let Some(out) = self.transcript_mouse(&m) {
                return out;
            }
        }
        let Some(area) = self.input_area.get() else { return Vec::new() };
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
        Vec::new()
    }

    /// Keys, as OpenCode binds them by default (`config/keybind.ts`), then the old TUI's that do not collide.
    pub fn on_key(&mut self, key: KeyEvent, now: Instant, page: usize) -> Vec<Action> {
        if key.kind == KeyEventKind::Release {
            return Vec::new();
        }
        self.settle();
        if let Some(out) = self.selection_key(&key) {
            return out;
        }
        if let Some(at) = self.leader.take() {
            if now.duration_since(at) < LEADER_WINDOW {
                for id in self.keymap.matches(&key, true) {
                    if let Some(out) = self.run(id, now, page) {
                        return out;
                    }
                }
                return Vec::new();
            }
        }
        if self.dialog.is_some() {
            return self.dialog_key(&key, now, page);
        }
        // A focused terminal takes every key but the leader (`terminal-pane.tsx`).
        if self.terms.focused && self.terminal_shown() {
            if self.keymap.is_leader(&key) {
                self.leader = Some(now);
            } else if let Some(t) = self.terms.shown() {
                t.key(&key);
            }
            return Vec::new();
        }
        if self.search.is_some() {
            if let Some(out) = self.search_key(&key) {
                return out;
            }
        }
        let m = key.modifiers;
        let (ctrl, alt, sup) = (m.contains(KeyModifiers::CONTROL), m.contains(KeyModifiers::ALT), m.contains(KeyModifiers::SUPER));
        if key.code == KeyCode::Esc && self.sidebar_esc() {
            return Vec::new();
        }
        if let Some(answer) = self.request_key(&key) {
            return answer;
        }
        if self.composer.is_some() {
            if let Some(out) = self.composer_key(&key) {
                return out;
            }
        }
        if self.diff.is_some() {
            if let Some(out) = self.diff_key(&key) {
                return out;
            }
        }
        if self.menu.is_some() {
            if let Some(out) = self.menu_key(&key) {
                return out;
            }
        }
        for id in self.keymap.matches(&key, false) {
            if let Some(out) = self.run(id, now, page) {
                return out;
            }
        }
        if self.keymap.is_leader(&key) {
            self.leader = Some(now);
            return Vec::new();
        }
        // A character no binding took is typed; AltGr arrives as ctrl+alt.
        if let KeyCode::Char(ch) = key.code {
            if !sup && ctrl == alt {
                self.editor.insert_char(ch);
            }
        }
        self.refresh_menu()
    }

    /// Runs an action (`keymap::DEFS`) where it applies; `None` where it does not, so the key's next action is tried.
    /// The comments name OpenCode's actions where Lykos's differ.
    pub(crate) fn run(&mut self, id: &str, now: Instant, page: usize) -> Option<Vec<Action>> {
        if let Some(out) = self.run_view(id) {
            return Some(out);
        }
        if id.starts_with("session.") || id == "open.menu" || id == "diff.open" {
            if let Some(out) = self.run_session(id) {
                return Some(out);
            }
        }
        let w = self.input_cols.max(1);
        let e = &mut self.editor;
        match id {
            "terminal.toggle" => return Some(self.toggle_terminal()),
            // `terminal.select`: the composer's Terminals tab.
            "terminal.select" => return Some(self.toggle_composer(Some(crate::composer::Tab::Terminals))),
            "terminal.close" => {
                if !self.terminal_shown() {
                    return None;
                }
                self.terms.visible = None;
                self.terms.focused = false;
                return Some(Vec::new());
            }
            // `pane.focus.left` is off while the pane covers the screen.
            "pane.focus.left" => {
                let (x, _) = crate::terminal::pane(self, self.side.width.get())?;
                if x == 0 {
                    return None;
                }
                self.terms.focused = false;
                return Some(Vec::new());
            }
            "pane.focus.right" => {
                crate::terminal::pane(self, self.side.width.get())?;
                self.terms.focused = true;
                self.composer = None;
                return Some(Vec::new());
            }
            // `app.tsx`: off where the platform cannot suspend (`config/index.tsx` unbinds it on Windows).
            "terminal.suspend" => return (!cfg!(windows)).then(|| vec![Action::Suspend]),
            // OpenCode `command-palette.tsx`.
            "command.palette.show" => {
                self.dialog = Some(Dialog::Palette { query: String::new(), selected: 0 });
                return Some(Vec::new());
            }
            "help.show" => {
                self.dialog = Some(Dialog::Help { scroll: 0 });
                return Some(Vec::new());
            }
            // The old TUI's copy and cut, with a selection.
            "prompt.copy" => {
                let text = e.copy()?;
                let at = e.cursor();
                e.click(at, false);
                return Some(vec![Action::Copy(text)]);
            }
            "prompt.cut" => {
                e.selection()?;
                let text = e.cut()?;
                let mut out = vec![Action::Copy(text)];
                out.extend(self.refresh_menu());
                return Some(out);
            }
            // `prompt.clear` wins while there is text; `app.exit` only on an empty prompt.
            "prompt.clear" => {
                if e.is_empty() {
                    return None;
                }
                e.set("");
                self.history.reset();
            }
            "app.exit" => return e.is_empty().then(|| vec![Action::Quit]),
            "session.interrupt" => return Some(self.escape(now)),
            "session.page.up" => self.on_scroll(true, page),
            "session.page.down" => self.on_scroll(false, page),
            "session.line.up" => self.on_scroll(true, 1),
            "session.line.down" => self.on_scroll(false, 1),
            "session.half.page.up" => self.on_scroll(true, (page / 2).max(1)),
            "session.half.page.down" => self.on_scroll(false, (page / 2).max(1)),
            "session.first" => {
                self.scroll = usize::MAX / 2;
                self.nav = None;
            }
            "session.last" => {
                self.scroll = 0;
                self.nav = None;
            }
            "session.queued_prompts" => return Some(self.run_local(Local::Queue)),
            // The question is typed after it.
            "session.aside" => {
                if !e.text().starts_with("/btw ") {
                    e.replace(0, 0, "/btw ");
                }
            }
            "model.list" => return Some(self.open_list(List::Models)),
            "model.cycle_recent" => return Some(self.cycle_model(false, 1)),
            "model.cycle_recent_reverse" => return Some(self.cycle_model(false, -1)),
            "model.cycle_favorite" => return Some(self.cycle_model(true, 1)),
            "model.cycle_favorite_reverse" => return Some(self.cycle_model(true, -1)),
            "variant.cycle" => return Some(self.cycle_effort()),
            "variant.list" => return Some(self.open_list(List::Efforts)),
            "agent.list" => return Some(self.open_list(List::Agents)),
            "agent.cycle" => return Some(self.cycle_specialist(1)),
            "agent.cycle.reverse" => return Some(self.cycle_specialist(-1)),
            "provider.connect" => return Some(self.open_list(List::Providers)),
            "lykos.mode" => return Some(self.command("/mode".into())),
            "lykos.permissions" => return Some(self.command("/permissions".into())),
            "lykos.output_style" => return Some(self.command("/output-style".into())),
            "lykos.credential" => return Some(self.command("/credential".into())),
            "theme.switch" => return Some(self.open_list(List::Themes { initial: theme::c().name })),
            "theme.switch_mode" => self.switch_mode(),
            "usage.show" => self.dialog = Some(Dialog::Info { info: Info::Usage }),
            "mcp.list" => self.dialog = Some(Dialog::Info { info: Info::Mcp }),
            "lykos.status" => self.dialog = Some(Dialog::Info { info: Info::Status }),
            "lykos.debug" => self.dialog = Some(Dialog::Info { info: Info::Debug }),
            "prompt.queue" => return Some(self.submit_queued()),
            "prompt.editor" => return Some(self.run_local(Local::Editor)),
            "prompt.images.view" => return Some(self.run_local(Local::Images)),
            "prompt.stash" => return Some(self.run_local(Local::Stash)),
            "prompt.stash.pop" => return Some(self.run_local(Local::StashPop)),
            "prompt.stash.list" => return Some(self.run_local(Local::StashList)),
            // The old TUI's ctrl+v when the terminal sends the key, not a paste: the register.
            "prompt.paste" => {
                let r = e.register.clone();
                e.insert_str(&r);
            }
            // The old TUI's history keys: from anywhere in the prompt.
            "prompt.history.previous" => self.recall(-1),
            "prompt.history.next" => self.recall(1),
            "prompt.history.search" => self.start_search(),
            "input.submit" => return Some(self.submit()),
            "input.newline" => e.newline(),
            "input.move.left" => e.left(false),
            "input.move.right" => e.right(false),
            // Up and down move through the rows, then recall history (OpenCode's `prompt.history.*` share them).
            "input.move.up" => self.history_move(-1),
            "input.move.down" => self.history_move(1),
            "input.select.left" => e.left(true),
            "input.select.right" => e.right(true),
            "input.select.up" => {
                e.up(w, true);
            }
            "input.select.down" => {
                e.down(w, true);
            }
            "input.line.home" => e.line_home(false),
            "input.line.end" => e.line_end_(false),
            "input.select.line.home" => e.line_home(true),
            "input.select.line.end" => e.line_end_(true),
            "input.visual.line.home" => e.visual_home(w, false),
            "input.visual.line.end" => e.visual_end(w, false),
            "input.select.visual.line.home" => e.visual_home(w, true),
            "input.select.visual.line.end" => e.visual_end(w, true),
            "input.buffer.home" => e.buffer_home(false),
            "input.buffer.end" => e.buffer_end(false),
            "input.select.buffer.home" => e.buffer_home(true),
            "input.select.buffer.end" => e.buffer_end(true),
            "input.delete.line" => e.delete_line(),
            "input.delete.to.line.end" => e.delete_to_line_end(),
            "input.delete.to.line.start" => e.delete_to_line_start(),
            "input.backspace" => e.backspace(),
            "input.delete" => e.delete(),
            "input.undo" => {
                e.undo();
            }
            "input.redo" => {
                e.redo();
            }
            "input.word.forward" => e.word_forward(false),
            "input.word.backward" => e.word_backward(false),
            "input.select.word.forward" => e.word_forward(true),
            "input.select.word.backward" => e.word_backward(true),
            "input.delete.word.forward" => e.delete_word_forward(),
            "input.delete.word.backward" => e.delete_word_backward(),
            "input.select.all" => e.select_all(),
            // A list's or a dialog's own: not here.
            _ => return None,
        }
        Some(self.refresh_menu())
    }

    fn dialog_key(&mut self, key: &KeyEvent, now: Instant, page: usize) -> Vec<Action> {
        let Some(dialog) = self.dialog.clone() else { return Vec::new() };
        let ids = self.keymap.matches(key, false);
        let has = |id: &str| ids.contains(&id);
        if let Dialog::Palette { query, selected } = dialog {
            return self.palette_key(key, &ids, query, selected, now, page);
        }
        match dialog {
            Dialog::List { list, query, selected } => return self.list_key(key, &ids, list, query, selected, page),
            Dialog::Sessions { query, selected, all, confirm } => return self.sessions_key(key, &ids, query, selected, all, confirm, page),
            Dialog::Timeline { query, selected } => return self.timeline_key(key, &ids, query, selected, page),
            Dialog::Worktrees { selected, confirm } => return self.worktrees_key(key, &ids, selected, confirm, page),
            Dialog::Input { title, text, purpose } => return self.input_key(key, &ids, title, text, purpose),
            _ => {}
        }
        if has("dialog.close") {
            self.dialog = None;
            return Vec::new();
        }
        let step = |sel: usize, n: usize, up: bool| if n == 0 { 0 } else if up { (sel + n - 1) % n } else { (sel + 1) % n };
        let (prev, next) = (has("dialog.select.prev"), has("dialog.select.next"));
        match dialog {
            Dialog::Palette { .. } | Dialog::List { .. } | Dialog::Sessions { .. } | Dialog::Timeline { .. } | Dialog::Worktrees { .. } | Dialog::Input { .. } => {}
            Dialog::Output { .. } => {
                if has("dialog.select.submit") {
                    self.dialog = None;
                } else if prev {
                    self.on_scroll(true, 1);
                } else if next {
                    self.on_scroll(false, 1);
                } else if has("dialog.select.page_up") {
                    self.on_scroll(true, page);
                } else if has("dialog.select.page_down") {
                    self.on_scroll(false, page);
                } else if has("dialog.select.end") {
                    self.on_scroll(false, usize::MAX);
                }
            }
            Dialog::Info { info } => {
                if info == Info::Debug && has("debug.copy") {
                    let text = self.debug_rows().iter().map(|(k, v)| format!("{k}: {v}")).collect::<Vec<_>>().join("\n");
                    self.notice = Some("Debug info copied to clipboard".into());
                    return vec![Action::Copy(text)];
                }
                if has("dialog.select.submit") {
                    self.dialog = None;
                }
            }
            Dialog::Help { scroll } => {
                let scroll = if prev {
                    scroll.saturating_sub(1)
                } else if next {
                    scroll + 1
                } else if has("dialog.select.page_up") {
                    scroll.saturating_sub(page)
                } else if has("dialog.select.page_down") {
                    scroll + page
                } else if has("dialog.select.home") {
                    0
                } else if has("dialog.select.submit") {
                    self.dialog = None;
                    return Vec::new();
                } else {
                    scroll
                };
                self.dialog = Some(Dialog::Help { scroll: scroll.min(self.help_rows().saturating_sub(1)) });
            }
            Dialog::Queue { selected } => {
                let n = self.queue.len();
                if prev || next {
                    self.dialog = Some(Dialog::Queue { selected: step(selected, n, prev) });
                } else if has("dialog.select.submit") {
                    // Steers the turn with it now.
                    let text = self.queue.remove(selected);
                    self.close_if_empty(n - 1, selected);
                    return match (self.session.clone(), self.link == Link::Ready) {
                        (Some(session), true) => vec![Action::Prompt { session, text }],
                        _ => {
                            self.queue.insert(0, text);
                            Vec::new()
                        }
                    };
                } else if has("queued_prompt.undo") {
                    // Back into the prompt box.
                    let text = self.queue.remove(selected);
                    self.editor.set(&text);
                    self.dialog = None;
                } else if has("queued_prompt.delete") {
                    self.queue.remove(selected);
                    self.close_if_empty(n - 1, selected);
                }
            }
            Dialog::Stash { selected } => {
                let n = self.stash.entries.len();
                // Shown newest first.
                let index = n.saturating_sub(1 + selected);
                if prev || next {
                    self.dialog = Some(Dialog::Stash { selected: step(selected, n, prev) });
                } else if has("dialog.select.submit") {
                    if let Some(e) = self.stash.take(index) {
                        self.editor.set(&e.text);
                    }
                    self.dialog = None;
                } else if has("stash.delete") {
                    self.stash.take(index);
                    self.close_if_empty(n - 1, selected);
                }
            }
            Dialog::Images { index } => {
                let n = self.editor.images().len();
                // `dialog-image-preview.tsx`: left and right too.
                if prev || key.code == KeyCode::Left {
                    self.dialog = Some(Dialog::Images { index: step(index, n, true) });
                } else if next || key.code == KeyCode::Right {
                    self.dialog = Some(Dialog::Images { index: step(index, n, false) });
                } else if has("dialog.select.submit") {
                    self.dialog = None;
                }
            }
            Dialog::Aside { answer, .. } => {
                if has("aside.copy") {
                    // btw.tsx: `c` copies the answer.
                    if let Ok(text) = answer {
                        self.notice = Some("copied the answer".into());
                        return vec![Action::Copy(text)];
                    }
                } else if has("dialog.select.submit") {
                    self.dialog = None;
                } else if prev {
                    self.on_scroll(true, 1);
                } else if next {
                    self.on_scroll(false, 1);
                } else if has("dialog.select.page_up") {
                    self.on_scroll(true, page);
                } else if has("dialog.select.page_down") {
                    self.on_scroll(false, page);
                }
            }
        }
        Vec::new()
    }

    /// The palette's rows for its query: every action that runs from anywhere, ranked as OpenCode's
    /// `dialog-select.tsx` does (the title counts twice the group and the name).
    pub fn palette(&self, query: &str) -> Vec<&'static keymap::Def> {
        // `command-palette.tsx` leaves the palette's own action out.
        let defs = keymap::DEFS.iter().filter(|d| keymap::in_palette(d.group) && d.id != "command.palette.show");
        if query.is_empty() {
            let mut all: Vec<&keymap::Def> = defs.collect();
            all.sort_by_key(|d| keymap::GROUPS.iter().position(|g| *g == d.group));
            return all;
        }
        let mut scored: Vec<(u32, &keymap::Def)> = defs
            .filter_map(|d| {
                let parts = [menu::score(query, d.title).map(|s| s * 2), menu::score(query, d.group), menu::score(query, d.id)];
                parts.iter().any(Option::is_some).then(|| (parts.iter().flatten().sum(), d))
            })
            .collect();
        scored.sort_by_key(|(s, _)| std::cmp::Reverse(*s));
        scored.into_iter().map(|(_, d)| d).collect()
    }

    fn palette_key(&mut self, key: &KeyEvent, ids: &[&str], mut query: String, selected: usize, now: Instant, page: usize) -> Vec<Action> {
        let has = |id: &str| ids.contains(&id);
        let n = self.palette(&query).len();
        let mut selected = selected;
        if has("dialog.close") {
            self.dialog = None;
            return Vec::new();
        } else if has("dialog.select.submit") {
            let Some(id) = self.palette(&query).get(selected).map(|d| d.id) else { return Vec::new() };
            self.dialog = None;
            // From the palette an action runs whatever the prompt holds.
            return match id {
                "app.exit" => vec![Action::Quit],
                _ => self.run(id, now, page).unwrap_or_default(),
            };
        } else if has("dialog.select.prev") {
            selected = if n == 0 { 0 } else { (selected + n - 1) % n };
        } else if has("dialog.select.next") {
            selected = if n == 0 { 0 } else { (selected + 1) % n };
        } else if has("dialog.select.page_up") {
            selected = selected.saturating_sub(page);
        } else if has("dialog.select.page_down") {
            selected = (selected + page).min(n.saturating_sub(1));
        } else if key.code == KeyCode::Backspace {
            query.pop();
            selected = 0;
        } else if let KeyCode::Char(c) = key.code {
            if !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) {
                query.push(c);
                selected = 0;
            }
        }
        self.dialog = Some(Dialog::Palette { query, selected });
        Vec::new()
    }

    /// How many rows the help lists: a heading per group and a row per action, the leader first.
    pub fn help_rows(&self) -> usize {
        1 + keymap::GROUPS.len() + keymap::DEFS.len()
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
        let ids = self.keymap.matches(key, false);
        let s = self.search.as_mut()?;
        if ids.contains(&"prompt.history.search") {
            if !s.matches.is_empty() {
                s.index = (s.index + 1) % s.matches.len();
                let text = s.matches[s.index].clone();
                self.editor.set(&text);
            }
            return Some(Vec::new());
        }
        self.search = None;
        Some(if ids.contains(&"input.submit") { self.submit() } else { Vec::new() })
    }

    fn menu_key(&mut self, key: &KeyEvent) -> Option<Vec<Action>> {
        let ids = self.keymap.matches(key, false);
        let m = self.menu.as_mut()?;
        let n = m.entries.len().max(1);
        let id = ids.into_iter().find(|id| id.starts_with("prompt.autocomplete."))?;
        match id {
            "prompt.autocomplete.prev" => m.selected = (m.selected + n - 1) % n,
            "prompt.autocomplete.next" => m.selected = (m.selected + 1) % n,
            "prompt.autocomplete.hide" => {
                self.dismissed = Some(m.at);
                self.menu = None;
            }
            // `.select` runs a command of the prompt's own; `.complete` only inserts.
            "prompt.autocomplete.select" => return Some(self.pick(true)),
            _ => return Some(self.pick(false)),
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
            Local::Help => self.dialog = Some(Dialog::Help { scroll: 0 }),
            Local::Models => return self.open_list(List::Models),
            Local::Effort => return self.open_list(List::Efforts),
            Local::Agents => return self.open_list(List::Agents),
            Local::Themes => return self.open_list(List::Themes { initial: theme::c().name }),
            Local::Connect => return self.open_list(List::Providers),
            Local::Status => self.dialog = Some(Dialog::Info { info: Info::Status }),
            Local::Mcps => self.dialog = Some(Dialog::Info { info: Info::Mcp }),
            Local::Debug => self.dialog = Some(Dialog::Info { info: Info::Debug }),
            Local::Run(id) => return self.run_session(id).unwrap_or_default(),
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
        if let Some(local) = menu::local(trimmed).filter(|l| *l != Local::Btw).or_else(|| menu::bare(trimmed)) {
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

/// A list dialog's movement and search keys: up and down wrap, pages stop at the ends, and typing (with `query`)
/// searches from the top.
fn select(key: &KeyEvent, ids: &[&str], query: Option<&mut String>, selected: &mut usize, n: usize, page: usize) {
    let has = |id: &str| ids.contains(&id);
    if has("dialog.select.prev") {
        *selected = if n == 0 { 0 } else { (*selected + n - 1) % n };
    } else if has("dialog.select.next") {
        *selected = if n == 0 { 0 } else { (*selected + 1) % n };
    } else if has("dialog.select.page_up") {
        *selected = selected.saturating_sub(page);
    } else if has("dialog.select.page_down") {
        *selected = (*selected + page).min(n.saturating_sub(1));
    } else if let Some(query) = query {
        if key.code == KeyCode::Backspace {
            query.pop();
            *selected = 0;
        } else if let KeyCode::Char(c) = key.code {
            if !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) {
                query.push(c);
                *selected = 0;
            }
        }
    }
}

/// Today's UTC date as `YYYY-MM-DD` (Howard Hinnant's `civil_from_days`).
/// How the session list and the tab name a delegated session's owner (P5 #51): `MCP` or `lykos run`.
pub(crate) fn owner_label(origin: &str) -> Option<&'static str> {
    match origin {
        "mcp" => Some("MCP"),
        "run" => Some("lykos run"),
        _ => None,
    }
}

fn today_utc() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()) as i64;
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
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
        // The old TUI's ctrl+z undoes on Windows; elsewhere it suspends, as OpenCode's does.
        press(&mut app, if cfg!(windows) { ctrl('z') } else { ctrl('-') });
        assert_eq!(app.editor.text(), "a\n漢", "undo");
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

    fn request(app: &mut App, seq: u64, kind: &str, title: &str, options: &[(&str, &str)]) {
        let options = options.iter().map(|(v, l)| lykos_client::RequestOption { value: (*v).into(), label: (*l).into(), note: None }).collect();
        let request = lykos_client::RequestData { request_id: format!("r{seq}"), kind: kind.into(), title: title.into(), detail: "ls".into(), body: None, patch: None, options, assumption: None };
        app.on_event(&Event { event: "request".into(), session: "s1".into(), seq, data: EventData::Request { request } });
    }

    fn answer(id: &str, a: &str) -> Vec<Action> {
        vec![Action::Answer { session: "s1".into(), request_id: id.into(), answer: a.into() }]
    }

    #[test]
    fn a_question_answers_by_number_by_row_or_by_typing() {
        let mut app = idle();
        status(&mut app, 2, SessionStatus::Waiting);
        typed(&mut app, "draft");
        request(&mut app, 3, "question", "which?", &[("1", "a"), ("2", "b")]);
        assert_eq!(press(&mut app, key(KeyCode::Char('2'))), answer("r3", "2"));
        assert_eq!(press(&mut app, key(KeyCode::Char('x'))), vec![], "a letter on an option row does nothing");
        press(&mut app, key(KeyCode::Down));
        assert_eq!(press(&mut app, key(KeyCode::Enter)), answer("r3", "2"), "enter picks the row moved to");
        press(&mut app, key(KeyCode::Up));
        assert_eq!(app.req.selected, 2, "up from the first row wraps to \"Type your own answer\"");
        typed(&mut app, "mine");
        assert!(app.req.editing);
        assert_eq!(app.editor.text(), "mine", "the draft prompt steps aside while the answer is typed");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), answer("r3", "mine"));
        assert_eq!(app.editor.text(), "draft", "and comes back once it is sent");
        press(&mut app, key(KeyCode::Char('3')));
        assert!(app.req.editing, "the custom row's number starts typing");
        press(&mut app, key(KeyCode::Esc));
        assert!(!app.req.editing);
        assert_eq!(app.editor.text(), "draft");
        assert_eq!(press(&mut app, key(KeyCode::Esc)), answer("r3", ""), "dismissed: the question's assumption");
    }

    #[test]
    fn a_free_text_question_takes_what_is_typed() {
        let mut app = idle();
        status(&mut app, 2, SessionStatus::Waiting);
        request(&mut app, 3, "question", "why?", &[]);
        typed(&mut app, "because");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), answer("r3", "because"));
        assert_eq!(press(&mut app, key(KeyCode::Esc)), answer("r3", ""));
    }

    #[test]
    fn an_approval_moves_confirms_rejects_and_goes_full_screen() {
        let mut app = idle();
        status(&mut app, 2, SessionStatus::Waiting);
        request(&mut app, 3, "approval", "bash: run ls", &[("y", "Allow once"), ("a", "Always"), ("f", "Folder"), ("n", "Deny")]);
        assert_eq!(press(&mut app, key(KeyCode::Enter)), answer("r3", "y"));
        press(&mut app, key(KeyCode::Right));
        press(&mut app, key(KeyCode::Char('l')));
        assert_eq!(press(&mut app, key(KeyCode::Enter)), answer("r3", "f"));
        press(&mut app, key(KeyCode::Left));
        assert_eq!(app.req.selected, 3, "left from the first option wraps");
        assert_eq!(press(&mut app, key(KeyCode::Char('a'))), answer("r3", "a"), "the gate's letters answer directly");
        assert_eq!(press(&mut app, key(KeyCode::Char('z'))), vec![], "any other letter does nothing");
        assert_eq!(app.editor.text(), "");
        press(&mut app, ctrl('f'));
        assert!(app.req.expanded);
        assert_eq!(press(&mut app, key(KeyCode::Esc)), vec![], "esc leaves full screen first");
        assert!(!app.req.expanded);
        assert_eq!(press(&mut app, key(KeyCode::Esc)), answer("r3", "n"));
    }

    #[test]
    fn the_prompt_starts_over_for_the_next_request() {
        let mut app = idle();
        status(&mut app, 2, SessionStatus::Waiting);
        request(&mut app, 3, "approval", "bash: run ls", &[("y", "Allow once"), ("n", "Deny")]);
        press(&mut app, key(KeyCode::Right));
        assert_eq!(app.request_ui().selected, 1);
        app.store.sessions.get_mut("s1").unwrap().requests.clear();
        request(&mut app, 4, "approval", "bash: run pwd", &[("y", "Allow once"), ("n", "Deny")]);
        assert_eq!(app.request_ui().selected, 0);
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
    fn a_paste_into_a_dialog_types_into_its_search_and_never_answers_a_prompt() {
        let mut app = idle();
        press(&mut app, ctrl('p'));
        app.on_paste("sel\nall");
        assert!(matches!(&app.dialog, Some(Dialog::Palette { query, selected: 0 }) if query == "sel all"));
        app.dialog = Some(Dialog::Worktrees { selected: 0, confirm: Some("w".into()) });
        app.on_paste("y");
        assert_eq!(app.dialog, Some(Dialog::Worktrees { selected: 0, confirm: Some("w".into()) }), "a confirmation takes no paste");
        app.dialog = Some(Dialog::Sessions { query: String::new(), selected: 0, all: false, confirm: Some("s".into()) });
        app.on_paste("y");
        assert!(matches!(&app.dialog, Some(Dialog::Sessions { query, .. }) if query.is_empty()));
    }

    #[test]
    fn ctrl_p_lists_every_action_search_narrows_and_enter_runs_it() {
        let mut app = idle();
        typed(&mut app, "hello");
        press(&mut app, ctrl('p'));
        assert_eq!(app.dialog, Some(Dialog::Palette { query: String::new(), selected: 0 }));
        let all = app.palette("");
        assert!(all.iter().any(|d| d.id == "input.select.all") && all.iter().all(|d| d.id != "command.palette.show" && keymap::in_palette(d.group)));
        typed(&mut app, "selall");
        let Some(Dialog::Palette { query, .. }) = &app.dialog else { panic!("still open") };
        assert_eq!(app.palette(query)[0].id, "input.select.all");
        assert!(app.palette(query).len() < all.len());
        press(&mut app, key(KeyCode::Backspace));
        assert!(matches!(&app.dialog, Some(Dialog::Palette { query, .. }) if query == "selal"));
        press(&mut app, key(KeyCode::Char('l')));
        press(&mut app, key(KeyCode::Enter));
        assert_eq!(app.dialog, None);
        assert_eq!(app.editor.selection(), Some((0, 5)), "select all ran");
        assert_eq!(app.editor.text(), "hello", "what was typed in the palette stayed out of the prompt");
    }

    #[test]
    fn the_palette_runs_exit_whatever_the_prompt_holds() {
        let mut app = idle();
        typed(&mut app, "draft");
        press(&mut app, ctrl('p'));
        typed(&mut app, "exit the");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![Action::Quit]);
    }

    #[test]
    fn a_config_layer_rebinds_unbinds_and_the_help_says_where() {
        let mut app = idle();
        app.on_keybinds(Ok(serde_json::json!({ "keybinds": {
            "input.submit": { "value": "ctrl+s", "source": "project (C:/w/.lykos/config.yaml)" },
            "app.exit": { "value": false, "source": "global (C:/u/.lykos/config.yaml)" },
            "leader": { "value": "ctrl+q", "source": "global (C:/u/.lykos/config.yaml)" },
            "prompt.editor": { "value": ["<leader>e", "f4"], "source": "project (C:/w/.lykos/config.yaml)" },
        }})));
        assert_eq!(app.notice, None);
        typed(&mut app, "hi");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![], "return no longer submits");
        assert_eq!(press(&mut app, ctrl('s')), vec![Action::Prompt { session: "s1".into(), text: "hi".into() }]);
        assert_eq!(press(&mut app, ctrl('c')), vec![], "exit unbound: ctrl+c on an empty prompt does nothing");
        assert_eq!(press(&mut app, key(KeyCode::F(4))), vec![Action::Editor(String::new())]);
        press(&mut app, ctrl('q'));
        assert_eq!(press(&mut app, key(KeyCode::Char('e'))), vec![Action::Editor(String::new())], "the new leader");
        press(&mut app, ctrl('x'));
        assert_eq!(press(&mut app, key(KeyCode::Char('e'))), vec![], "ctrl+x is no longer the leader");
        assert_eq!(app.keymap.keys("prompt.editor"), "ctrl+q e, f4");
        assert_eq!(app.keymap.source("input.submit"), "project (C:/w/.lykos/config.yaml)");
        app.on_keybinds(Ok(serde_json::json!({ "keybinds": { "nope": { "value": "ctrl+q", "source": "project (p)" } } })));
        assert_eq!(app.notice.as_deref(), Some("unknown keybind nope (project (p))"));
        app.run_local(Local::Help);
        assert_eq!(app.dialog, Some(Dialog::Help { scroll: 0 }));
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

    fn with_options() -> App {
        let mut app = idle();
        let out = app.on_event(&Event { event: "commands".into(), session: "s1".into(), seq: 2, data: EventData::Commands { commands: Vec::new() } });
        assert!(out.contains(&Action::Options { session: "s1".into() }), "a booted session's lists are asked for");
        let o: SessionOptions = serde_json::from_value(serde_json::json!({
            "model": "p/a",
            "models": [
                { "provider": "p", "id": "a", "name": "Alpha", "contextWindow": 200000, "reasoning": true },
                { "provider": "p", "id": "b", "name": "Beta", "contextWindow": null, "reasoning": false },
                { "provider": "q", "id": "c", "name": "Gamma", "contextWindow": 1000000, "reasoning": false }
            ],
            "effort": "medium",
            "efforts": ["off", "low", "medium", "high"],
            "specialist": "build",
            "specialists": [{ "name": "build", "description": "writes" }, { "name": "plan", "description": "reads" }],
            "providers": [{ "name": "anthropic", "auth": "oauth_subscription", "reach": "reachable", "reason": "a stored credential" }, { "name": "openai", "auth": "api_key", "reach": "unreachable", "reason": "no key" }]
        }))
        .unwrap();
        app.on_options(Ok(o));
        app
    }

    fn sent(out: &[Action]) -> Vec<String> {
        out.iter().filter_map(|a| if let Action::Prompt { text, .. } = a { Some(text.clone()) } else { None }).collect()
    }

    #[test]
    fn the_model_list_groups_favorites_and_recent_searches_and_sends_the_choice() {
        let mut app = with_options();
        app.prefs.recent = vec!["q/c".into()];
        app.prefs.favorite = vec!["p/b".into()];
        press(&mut app, ctrl('x'));
        let out = press(&mut app, key(KeyCode::Char('m')));
        assert_eq!(out, [Action::Options { session: "s1".into() }], "opening it refreshes the lists");
        let rows = app.list_rows(&List::Models, "");
        assert_eq!(rows.iter().map(|r| (r.value.as_str(), r.group.as_str())).collect::<Vec<_>>(), [("p/b", "Favorites"), ("q/c", "Recent"), ("p/a", "p")]);
        assert!(matches!(app.dialog, Some(Dialog::List { selected: 2, .. })), "on the model in use");
        assert_eq!(rows[1].detail, "q · 1M");
        typed(&mut app, "gam");
        assert_eq!(app.list_rows(&List::Models, "gam")[0].value, "q/c");
        let out = press(&mut app, key(KeyCode::Enter));
        assert_eq!(sent(&out), ["/model q/c"]);
        assert_eq!(app.prefs.recent[0], "q/c");
        assert!(app.dialog.is_none());
        // ctrl+f in the list: the favorite goes.
        press(&mut app, ctrl('x'));
        press(&mut app, key(KeyCode::Char('m')));
        press(&mut app, key(KeyCode::Home));
        app.dialog = Some(Dialog::List { list: List::Models, query: String::new(), selected: 0 });
        press(&mut app, ctrl('f'));
        assert!(app.prefs.favorite.is_empty());
    }

    #[test]
    fn ctrl_t_cycles_effort_shift_tab_the_specialist_and_f2_the_recent_models() {
        let mut app = with_options();
        assert_eq!(sent(&press(&mut app, ctrl('t'))), ["/effort high"]);
        assert_eq!(sent(&press(&mut app, ctrl('t'))), ["/effort off"], "past the last, the first");
        assert_eq!(sent(&press(&mut app, KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT))), ["/specialist plan"]);
        assert_eq!(sent(&press(&mut app, KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT))), ["/specialist build"]);
        assert!(press(&mut app, key(KeyCode::F(2))).is_empty(), "no recent models, nothing to cycle");
        app.prefs.recent = vec!["p/a".into(), "q/c".into(), "gone/x".into()];
        assert_eq!(sent(&press(&mut app, key(KeyCode::F(2)))), ["/model q/c"], "a model no longer listed is skipped");
        app.run("model.cycle_favorite", Instant::now(), 10);
        assert_eq!(app.notice.as_deref(), Some("Add a favorite model to use this shortcut"));
    }

    #[test]
    fn bare_session_commands_open_their_list_and_with_an_argument_go_to_the_session() {
        let mut app = with_options();
        typed(&mut app, "/effort");
        app.menu = None;
        press(&mut app, key(KeyCode::Enter));
        assert!(matches!(app.dialog, Some(Dialog::List { list: List::Efforts, selected: 2, .. })));
        press(&mut app, key(KeyCode::Esc));
        typed(&mut app, "/effort low");
        app.menu = None;
        assert_eq!(sent(&press(&mut app, key(KeyCode::Enter))), ["/effort low"]);
        // A provider with a browser sign-in signs in from here; an API key is typed in a terminal.
        assert_eq!(sent(&app.connect("anthropic")), ["/login anthropic"]);
        assert!(app.connect("openai").is_empty());
        assert!(app.notice.as_deref().unwrap().contains("lykos login openai --api-key"));
    }

    #[test]
    fn the_theme_list_previews_restores_on_escape_and_mode_switches_to_the_pair() {
        let mut app = idle();
        theme::set("sky");
        app.run("theme.switch", Instant::now(), 10);
        press(&mut app, key(KeyCode::Up));
        assert_ne!(theme::c().name, "sky", "the theme under the cursor shows");
        press(&mut app, key(KeyCode::Esc));
        assert_eq!(theme::c().name, "sky", "esc puts it back");
        app.run("theme.switch", Instant::now(), 10);
        typed(&mut app, "latte");
        assert_eq!(theme::c().name, "catppuccin-latte");
        press(&mut app, key(KeyCode::Enter));
        assert_eq!(app.prefs.theme.as_deref(), Some("catppuccin-latte"));
        app.run("theme.switch_mode", Instant::now(), 10);
        assert_eq!(theme::c().name, "catppuccin-mocha");
    }

    fn session_event(app: &mut App, id: &str, seq: u64, status: SessionStatus, ledger: &str, title: &str) -> Vec<Action> {
        let summary = SessionSummary {
            id: id.into(),
            cwd: "/w".into(),
            status,
            model: "m1".into(),
            title: Some(title.into()),
            started_at: "2026-11-23T00:00:00Z".into(),
            origin: "tui".into(),
            ledger_session_id: Some(ledger.into()),
        };
        app.on_event(&Event { event: "session.status".into(), session: id.into(), seq, data: EventData::SessionStatus { session: summary } })
    }

    fn event(app: &mut App, id: &str, seq: u64, data: EventData) -> Vec<Action> {
        app.on_event(&Event { event: String::new(), session: id.into(), seq, data })
    }

    fn calls(out: &[Action]) -> Vec<(&'static str, Value)> {
        out.iter().filter_map(|a| if let Action::Call { method, params, .. } = a { Some((*method, params.clone())) } else { None }).collect()
    }

    fn two_tabs() -> App {
        let mut app = App::new("/w".into());
        app.connected();
        app.started("s1".into());
        session_event(&mut app, "s1", 1, SessionStatus::Idle, "L1", "first");
        app.started("s2".into());
        session_event(&mut app, "s2", 1, SessionStatus::Idle, "L2", "second");
        app
    }

    #[test]
    fn tabs_cycle_close_to_the_neighbour_reopen_and_mark_a_finished_turn_unread() {
        let mut app = two_tabs();
        assert_eq!(app.tabs.open, ["s1", "s2"]);
        assert_eq!(app.session.as_deref(), Some("s2"));
        event(&mut app, "s1", 2, EventData::TurnEnd);
        assert!(app.tabs.unread.contains("s1"), "a turn that ended out of sight is unread");
        let out = press(&mut app, KeyEvent::new(KeyCode::Up, KeyModifiers::ALT));
        assert_eq!(app.session.as_deref(), Some("s1"));
        assert_eq!(out, vec![Action::Options { session: "s1".into() }], "the lists are asked for the tab shown");
        assert!(app.tabs.unread.is_empty());
        press(&mut app, ctrl('x'));
        press(&mut app, key(KeyCode::Char('w')));
        assert_eq!(app.tabs.open, ["s2"]);
        assert_eq!(app.session.as_deref(), Some("s2"));
        press(&mut app, KeyEvent::new(KeyCode::Char('t'), KeyModifiers::CONTROL | KeyModifiers::SHIFT));
        assert_eq!(app.tabs.open, ["s1", "s2"], "reopened where it was");
        assert_eq!(app.session.as_deref(), Some("s1"));
        press(&mut app, ctrl('x'));
        press(&mut app, key(KeyCode::Char('2')));
        assert_eq!(app.session.as_deref(), Some("s2"));
        // A new session: the home screen, and the next prompt starts one.
        press(&mut app, ctrl('x'));
        press(&mut app, key(KeyCode::Char('n')));
        assert!(app.session.is_none());
        typed(&mut app, "hi");
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![Action::Start]);
    }

    #[test]
    fn undo_redo_fork_and_compact_run_the_sessions_commands_and_an_undone_prompt_comes_back() {
        let mut app = idle();
        for (k, cmd) in [('u', "/undo"), ('r', "/redo"), ('c', "/compact")] {
            press(&mut app, ctrl('x'));
            assert_eq!(sent(&press(&mut app, key(KeyCode::Char(k)))), [cmd]);
        }
        assert_eq!(sent(&app.run("session.fork", Instant::now(), 10).unwrap()), ["/fork"]);
        typed(&mut app, "draft");
        event(&mut app, "s1", 2, EventData::PromptSet { text: "do it again".into() });
        assert_eq!(app.editor.text(), "do it again\ndraft", "the undone prompt goes ahead of the draft");
        event(&mut app, "s1", 3, EventData::PromptSet { text: String::new() });
        assert_eq!(app.editor.text(), "do it again\ndraft", "a redo's empty text leaves the box alone");
    }

    #[test]
    fn a_delegated_session_lists_with_its_owner_and_opens_as_a_watch() {
        let mut app = two_tabs();
        press(&mut app, ctrl('x'));
        press(&mut app, key(KeyCode::Char('l')));
        let today = format!("{}T09:30:00Z", today_utc());
        app.on_reply(Then::History, Ok(json!({
            "rows": [{ "id": "D1", "title": null, "startedUtc": today, "endedUtc": null, "model": null, "parentSessionId": null, "archived": false, "resumable": false, "projectPath": null, "projectName": null }],
            "live": {},
            "delegated": { "D1": { "owner": "mcp", "state": "running", "startedAt": today, "specialist": "general" } }
        })));
        assert_eq!(app.session_rows("", None)[0].detail, "MCP running · 09:30");
        let out = press(&mut app, key(KeyCode::Enter));
        assert_eq!(calls(&out), [("session.watch", json!({ "cwd": "/w", "id": "D1" }))], "watched, not resumed: its owner keeps it");
        assert_eq!(owner_label("run"), Some("lykos run"));
        assert_eq!(owner_label("tui"), None);
    }

    #[test]
    fn the_session_list_groups_pins_resumes_renames_and_archives_on_a_second_press() {
        let mut app = two_tabs();
        press(&mut app, ctrl('x'));
        let out = press(&mut app, key(KeyCode::Char('l')));
        assert_eq!(calls(&out), [("sessions.history", json!({ "cwd": "/w", "all": false }))]);
        let today = format!("{}T09:30:00Z", today_utc());
        let history = json!({
            "rows": [
                { "id": "L2", "title": "second", "startedUtc": today, "endedUtc": null, "model": null, "parentSessionId": null, "archived": false, "resumable": true, "projectPath": null, "projectName": null },
                { "id": "L1", "title": "first", "startedUtc": "2026-01-02T08:00:00Z", "endedUtc": null, "model": null, "parentSessionId": null, "archived": false, "resumable": true, "projectPath": null, "projectName": null },
                { "id": "L0", "title": "old", "startedUtc": "2026-01-01T08:00:00Z", "endedUtc": "2026-01-01T09:00:00Z", "model": null, "parentSessionId": null, "archived": false, "resumable": true, "projectPath": null, "projectName": null },
                { "id": "C1", "title": "a subagent", "startedUtc": "2026-01-01T08:10:00Z", "endedUtc": null, "model": null, "parentSessionId": "L0", "archived": false, "resumable": false, "projectPath": null, "projectName": null }
            ],
            "live": { "L1": "s1", "L2": "s2" }
        });
        app.on_reply(Then::History, Ok(history));
        let rows = app.session_rows("", None);
        let groups: Vec<(&str, &str)> = rows.iter().map(|r| (r.value.as_str(), r.group.as_str())).collect();
        assert_eq!(groups, [("L2", "Today"), ("L1", "2026-01-02"), ("L0", "2026-01-01")], "root sessions only, by day");
        assert!(rows[0].current, "the session shown is marked");
        // Pin the third: it moves to the top under Pinned.
        press(&mut app, key(KeyCode::Down));
        press(&mut app, key(KeyCode::Down));
        press(&mut app, ctrl('f'));
        assert_eq!(app.session_rows("", None)[0].group, "Pinned");
        assert_eq!(app.session_rows("", None)[0].value, "L0");
        // A live session is its tab; one that is not is resumed. The selection stayed on the third row: L1.
        press(&mut app, key(KeyCode::Enter));
        assert_eq!(app.session.as_deref(), Some("s1"));
        press(&mut app, ctrl('x'));
        press(&mut app, key(KeyCode::Char('l')));
        app.on_reply(Then::History, Ok(json!({ "rows": [{ "id": "L0", "title": "old", "startedUtc": "2026-01-01T08:00:00Z", "endedUtc": null, "model": null, "parentSessionId": null, "archived": false, "resumable": true, "projectPath": "/p", "projectName": null }], "live": {} })));
        let out = press(&mut app, key(KeyCode::Enter));
        assert_eq!(calls(&out), [("session.start", json!({ "cwd": "/p", "origin": "tui", "resume": "L0" }))]);
        assert_eq!(app.on_reply(Then::Started { replaces: None }, Ok(json!({ "id": "s3" }))), vec![]);
        assert_eq!(app.tabs.open, ["s1", "s2", "s3"]);
        // Delete arms on the first press and archives on the second.
        press(&mut app, ctrl('x'));
        press(&mut app, key(KeyCode::Char('l')));
        app.on_reply(Then::History, Ok(json!({ "rows": [{ "id": "L0", "title": "old", "startedUtc": "2026-01-01T08:00:00Z", "endedUtc": null, "model": null, "parentSessionId": null, "archived": false, "resumable": true, "projectPath": null, "projectName": null }], "live": {} })));
        assert!(calls(&press(&mut app, ctrl('d'))).is_empty());
        assert!(app.session_rows("", Some("L0"))[0].title.starts_with("Press ctrl+d again"));
        let out = press(&mut app, ctrl('d'));
        assert_eq!(calls(&out), [("session.archive", json!({ "cwd": "/w", "ledgerSessionId": "L0" }))]);
        let out = app.on_reply(Then::Refresh { all: false }, Err("no ledger".into()));
        assert_eq!(calls(&out), [("sessions.history", json!({ "cwd": "/w", "all": false }))], "a failed archive reloads the list");
        // Rename from the list.
        app.on_reply(Then::History, Ok(json!({ "rows": [{ "id": "L0", "title": "old", "startedUtc": "2026-01-01T08:00:00Z", "endedUtc": null, "model": null, "parentSessionId": null, "archived": false, "resumable": true, "projectPath": null, "projectName": null }], "live": {} })));
        press(&mut app, ctrl('r'));
        typed(&mut app, "er");
        let out = press(&mut app, key(KeyCode::Enter));
        assert_eq!(calls(&out), [("session.rename", json!({ "cwd": "/w", "ledgerSessionId": "L0", "title": "older" }))]);
    }

    /// A session of `n` prompts and answers, drawn once at 80x20 so the message keys have a layout.
    fn conversation(n: usize) -> App {
        let mut app = idle();
        let mut seq = 2;
        for i in 0..n {
            event(&mut app, "s1", seq, EventData::MessageUser { text: format!("prompt {i}") });
            event(&mut app, "s1", seq + 1, EventData::MessageDelta { text: format!("answer {i}") });
            event(&mut app, "s1", seq + 2, EventData::MessageEnd);
            seq += 3;
        }
        draw(&app);
        app
    }

    fn draw(app: &App) -> lykos_term::Buffer {
        let mut buf = lykos_term::Buffer::new(80, 20);
        crate::view::draw(app, &mut buf);
        buf
    }

    #[test]
    fn the_message_keys_step_from_the_view_then_from_the_message_gone_to() {
        let mut app = conversation(10);
        let now = Instant::now();
        // From the bottom, the previous message is the last one starting above the view's top.
        app.run("session.message.previous", now, 10);
        let first = app.jump.get().expect("a jump");
        assert!(matches!(app.current().unwrap().items[first], Item::User(_) | Item::Assistant(_)));
        draw(&app);
        app.run("session.message.previous", now, 10);
        assert_eq!(app.jump.get(), Some(first - 1), "the next step is from the message gone to");
        app.run("session.message.user.previous", now, 10);
        let user = app.jump.get().unwrap();
        assert!(matches!(app.current().unwrap().items[user], Item::User(_)) && user < first - 1);
        app.run("session.message.user.next", now, 10);
        assert_eq!(app.jump.get(), Some(user + 2));
        app.run("session.messages_last_user", now, 10);
        assert_eq!(app.jump.get(), Some(18), "prompt 9");
        app.on_scroll(true, 3);
        assert_eq!(app.nav, None, "scrolling forgets the message gone to");
    }

    #[test]
    fn copy_takes_the_last_answer_and_says_when_there_is_none() {
        let mut app = idle();
        let now = Instant::now();
        assert_eq!(app.run("messages.copy", now, 10).unwrap(), Vec::new());
        assert_eq!(app.notice.as_deref(), Some("No assistant messages found"));
        event(&mut app, "s1", 2, EventData::MessageUser { text: "hi".into() });
        event(&mut app, "s1", 3, EventData::MessageDelta { text: "  hello  ".into() });
        assert_eq!(app.run("messages.copy", now, 10).unwrap(), vec![Action::Copy("hello".into())]);
        assert_eq!(app.notice.as_deref(), Some("Message copied to clipboard!"));
        assert!(crate::menu::LOCAL.iter().any(|(l, name, _)| *name == "/copy" && *l == Local::Run("messages.copy")));
    }

    #[test]
    fn the_toggles_flip_and_their_titles_say_what_they_will_do() {
        let mut app = idle();
        let def = |id: &str| keymap::DEFS.iter().find(|d| d.id == id).unwrap();
        let now = Instant::now();
        assert_eq!(app.title(def("session.verbosity.cycle")), "Verbosity: Low");
        app.run("session.verbosity.cycle", now, 10);
        assert_eq!(app.title(def("session.verbosity.cycle")), "Verbosity: Medium");
        assert_eq!(app.title(def("session.toggle.thinking")), "Expand thinking");
        app.run("session.toggle.thinking", now, 10);
        assert_eq!((app.prefs.show_thinking, app.title(def("session.toggle.thinking"))), (true, "Collapse thinking".to_string()));
        app.run("session.toggle.exploration_grouping", now, 10);
        assert_eq!(app.title(def("session.toggle.exploration_grouping")), "Group related tool calls");
        app.run("app.toggle.animations", now, 10);
        assert_eq!(app.title(def("app.toggle.animations")), "Enable animations");
        app.run("session.toggle.scrollbar", now, 10);
        assert!(app.prefs.scrollbar);
        let s: String = draw(&app).cells.iter().map(|c| c.ch).collect();
        assert!(s.contains('│'), "the scrollbar draws");
    }

    #[test]
    fn a_click_opens_a_group_and_a_drag_selects_and_copies() {
        let mut app = idle();
        event(&mut app, "s1", 2, EventData::MessageUser { text: "go".into() });
        event(&mut app, "s1", 3, EventData::ToolStart { tool_id: "t1".into(), name: "bash".into(), summary: "ls".into(), args: Value::Null });
        event(&mut app, "s1", 4, EventData::ToolEnd { tool_id: "t1".into(), name: "bash".into(), ok: true, preview: None, diff: None });
        event(&mut app, "s1", 5, EventData::MessageDelta { text: "done here".into() });
        draw(&app);
        let f = app.frame.get().unwrap();
        let lay = app.laid.borrow().clone().unwrap();
        let head = (0..lay.total).find(|r| lay.head_at(*r).is_some()).expect("the activity's line");
        let at = |r: usize, col: u16| (f.x + col, f.y + (r - f.top) as u16);
        let mouse = |kind, (column, row): (u16, u16)| MouseEvent { kind, column, row, modifiers: KeyModifiers::NONE };
        let (x, y) = at(head, 2);
        app.on_mouse(mouse(MouseEventKind::Down(MouseButton::Left), (x, y)), Instant::now());
        app.on_mouse(mouse(MouseEventKind::Up(MouseButton::Left), (x, y)), Instant::now());
        assert_eq!(app.opened["s1"].values().copied().collect::<Vec<_>>(), [true], "the click opened it");
        let s: String = draw(&app).cells.iter().map(|c| c.ch).collect();
        assert!(s.contains("$ bash ls"), "its tool shows {s}");
        // Select "done" on the answer's row.
        let lay = app.laid.borrow().clone().unwrap();
        let f = app.frame.get().unwrap();
        let row = (0..lay.total).find(|r| lay.row(*r).is_some_and(|x| x.text.contains("done here"))).unwrap();
        let indent = lay.row(row).unwrap().indent;
        let at = |col: u16| (f.x + indent + col, f.y + (row - f.top) as u16);
        app.on_mouse(mouse(MouseEventKind::Down(MouseButton::Left), at(0)), Instant::now());
        app.on_mouse(mouse(MouseEventKind::Drag(MouseButton::Left), at(3)), Instant::now());
        let up = app.on_mouse(mouse(MouseEventKind::Up(MouseButton::Left), at(3)), Instant::now());
        if COPY_ON_SELECT {
            assert_eq!(up, vec![Action::Copy("done".into())]);
        } else {
            assert_eq!(up, Vec::new(), "on Windows the release keeps the selection");
            assert_eq!(press(&mut app, ctrl('c')), vec![Action::Copy("done".into())]);
            assert!(app.selection.is_some(), "ctrl+c copies and keeps the selection");
            assert_eq!(app.on_mouse(mouse(MouseEventKind::Down(MouseButton::Right), at(0)), Instant::now()), vec![Action::Copy("done".into())]);
        }
        assert_eq!(app.notice.as_deref(), Some("Copied to clipboard"));
        assert_eq!(press(&mut app, key(KeyCode::Esc)), Vec::new());
        assert_eq!(app.selection, None, "esc clears it");
        assert!(app.editor.text().is_empty());
    }

    #[test]
    fn the_timeline_jumps_to_a_prompt_and_copy_export_and_the_worktrees_ask_the_server() {
        let mut app = idle();
        event(&mut app, "s1", 2, EventData::MessageUser { text: "first prompt".into() });
        event(&mut app, "s1", 3, EventData::MessageDelta { text: "answer".into() });
        event(&mut app, "s1", 4, EventData::MessageUser { text: "second prompt".into() });
        press(&mut app, ctrl('x'));
        press(&mut app, key(KeyCode::Char('g')));
        let titles: Vec<String> = app.timeline_rows("").into_iter().map(|r| r.title).collect();
        assert_eq!(titles, ["second prompt", "first prompt"], "newest first");
        press(&mut app, key(KeyCode::Down));
        press(&mut app, key(KeyCode::Enter));
        assert_eq!(app.jump.get(), Some(0), "the first prompt's item");
        let out = app.run("session.copy", Instant::now(), 10).unwrap();
        assert!(matches!(&out[..], [Action::Copy(t)] if t.starts_with("## User\n\nfirst prompt") && t.contains("## Assistant\n\nanswer")));
        session_event(&mut app, "s1", 5, SessionStatus::Idle, "L9", "t");
        assert_eq!(app.run("session.copy.id", Instant::now(), 10).unwrap(), vec![Action::Copy("L9".into())]);
        assert_eq!(app.notice.as_deref(), Some("Session ID copied to clipboard!"));
        press(&mut app, ctrl('x'));
        let out = press(&mut app, key(KeyCode::Char('x')));
        assert_eq!(calls(&out), [("session.export", json!({ "cwd": "/w", "ledgerSessionId": "L9", "file": "session-L9.md" }))]);
        let out = app.run("session.move", Instant::now(), 10).unwrap();
        assert_eq!(calls(&out), [("worktree.list", json!({ "cwd": "/w" }))]);
        app.on_reply(Then::Worktrees, Ok(json!([{ "path": "/w", "branch": "main", "head": "abc", "main": true, "sessions": true }, { "path": "/t/one", "branch": "lykos/one", "head": "def", "main": false }])));
        press(&mut app, key(KeyCode::Down));
        let out = press(&mut app, key(KeyCode::Enter));
        assert_eq!(calls(&out), [("session.move", json!({ "session": "s1", "cwd": "/t/one" }))]);
        assert_eq!(app.on_reply(Then::Started { replaces: Some("s1".into()) }, Ok(json!({ "id": "s5" }))), vec![]);
        assert_eq!(app.tabs.open, ["s5"], "the moved session replaces its tab");
    }

    fn jobs(app: &mut App, seq: u64, running: &[&str], foreground: &[&str]) {
        let jobs = running
            .iter()
            .map(|id| lykos_client::JobInfo { id: id.to_string(), command: format!("run {id}"), status: "running".into(), started_at: "2026-11-24T00:00:00Z".into(), exit_code: None })
            .collect();
        let foreground = foreground.iter().map(|id| lykos_client::ForegroundInfo { id: id.to_string(), command: "sleep".into() }).collect();
        event(app, "s1", seq, EventData::Jobs { jobs, foreground });
    }

    fn working() -> App {
        let mut app = App::new("/w".into());
        app.connected();
        app.started("s1".into());
        session_event(&mut app, "s1", 1, SessionStatus::Running, "L1", "first");
        app
    }

    #[test]
    fn down_opens_the_composer_on_the_busy_tab_and_a_shell_shows_its_output_and_is_killed() {
        let mut app = working();
        jobs(&mut app, 2, &["job-1"], &[]);
        assert_eq!(crate::composer::live(&app).as_deref(), Some("1 shell"));
        typed(&mut app, "ab");
        press(&mut app, key(KeyCode::Left));
        press(&mut app, key(KeyCode::Down));
        assert!(app.composer.is_none(), "down away from the end of the prompt moves in it");
        press(&mut app, key(KeyCode::Down));
        let comp = app.composer.clone().expect("down at the end opens the composer");
        assert_eq!(comp.tab, crate::composer::Tab::Shell);
        let out = press(&mut app, key(KeyCode::Enter));
        assert_eq!(calls(&out), [("session.job.logs", json!({ "session": "s1", "jobId": "job-1" }))]);
        assert!(matches!(&app.dialog, Some(Dialog::Output { job, .. }) if job == "job-1"));
        app.on_reply(Then::JobLog("job-1".into()), Ok(json!({ "text": "one
two
", "nextOffset": 9, "size": 9 })));
        assert!(matches!(&app.dialog, Some(Dialog::Output { text, offset: Some(9), .. }) if text == "one
two
"));
        let later = Instant::now() + Duration::from_millis(600);
        assert_eq!(calls(&app.on_tick(later)), [("session.job.logs", json!({ "session": "s1", "jobId": "job-1", "offset": 9 }))]);
        assert!(app.on_tick(later + Duration::from_millis(600)).is_empty(), "one read at a time");
        press(&mut app, key(KeyCode::Esc));
        assert!(app.dialog.is_none());
        let out = press(&mut app, ctrl('d'));
        assert_eq!(calls(&out), [("session.job.stop", json!({ "session": "s1", "jobId": "job-1" }))]);
        press(&mut app, key(KeyCode::Esc));
        assert!(app.composer.is_none());
        assert_eq!(app.editor.text(), "ab", "the prompt is untouched");
    }

    #[test]
    fn ctrl_b_moves_a_shell_call_to_the_background_only_while_one_holds_the_turn() {
        let mut app = working();
        typed(&mut app, "ab");
        assert!(calls(&press(&mut app, ctrl('b'))).is_empty());
        assert_eq!(app.editor.cursor(), 1, "ctrl+b moves left without a shell call");
        jobs(&mut app, 2, &[], &["fg-1"]);
        let now = Instant::now();
        app.on_tick(now);
        assert!(!app.bg_hint);
        app.on_tick(now + BACKGROUND_HINT_DELAY);
        assert!(app.bg_hint, "the hint shows after 3 s");
        assert_eq!(calls(&press(&mut app, ctrl('b'))), [("session.background", json!({ "session": "s1" }))]);
        jobs(&mut app, 3, &["job-2"], &[]);
        app.on_tick(now + BACKGROUND_HINT_DELAY * 2);
        assert!(!app.bg_hint);
    }

    #[test]
    fn the_terminal_title_names_the_session_and_cuts_a_long_one() {
        let mut app = App::new("/w".into());
        assert_eq!(app.window_title(), "Lykos");
        app.connected();
        app.started("s1".into());
        session_event(&mut app, "s1", 1, SessionStatus::Idle, "L1", "fix the build");
        assert_eq!(app.window_title(), "Lykos | fix the build");
        session_event(&mut app, "s1", 2, SessionStatus::Idle, "L1", &"x".repeat(41));
        assert_eq!(app.window_title(), format!("Lykos | {}…", "x".repeat(37)));
        let on = app.prefs.terminal_title;
        app.run("terminal.title.toggle", Instant::now(), 10);
        assert_eq!(app.prefs.terminal_title, !on);
    }

    #[test]
    fn the_terminal_keys_open_select_and_close_the_pane() {
        let mut app = working();
        app.side.width.set(120);
        assert_eq!(app.run("terminal.toggle", Instant::now(), 10), Some(vec![Action::NewTerminal]), "no terminal yet: a new one");
        assert_eq!(app.run("terminal.close", Instant::now(), 10), None, "nothing to close");
        app.run("terminal.select", Instant::now(), 10);
        assert_eq!(app.composer.as_ref().map(|c| c.tab), Some(crate::composer::Tab::Terminals));
        let rows = crate::composer::entries(&app, crate::composer::Tab::Terminals);
        assert_eq!(rows.iter().map(|r| r.label.as_str()).collect::<Vec<_>>(), ["+ New terminal"]);
        assert_eq!(press(&mut app, key(KeyCode::Enter)), vec![Action::NewTerminal]);
        assert!(app.composer.is_none());
        if !cfg!(windows) {
            assert_eq!(app.run("terminal.suspend", Instant::now(), 10), Some(vec![Action::Suspend]));
        } else {
            assert_eq!(app.run("terminal.suspend", Instant::now(), 10), None, "no suspend on Windows");
        }
    }
}
