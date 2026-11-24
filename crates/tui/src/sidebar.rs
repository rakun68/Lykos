//! The session sidebar: OpenCode's `routes/session/sidebar.tsx` at `4332e24`, its sections from
//! `feature-plugins/sidebar/` and its place from `component/session-frame.tsx`. 42 columns on the raised background,
//! padded 1 row and 2 columns; the title, the sections a row apart, the working directory at the foot. It shows by
//! itself beside the session when the screen is wider than 120 columns, and over the session on a dimmed backdrop when
//! toggled open on a narrower one; `session.sidebar.toggle` hides it and remembers that (`session.sidebar` "hide").
//! A pane on the right (the diff viewer) takes its place.
//!
//! Sections: Context (`context.tsx`: tokens, % used, $ spent), Todo (`todo.tsx`: the `todo` tool's last list,
//! collapsible past two items) and Modified Files (a Lykos addition: each file the session's tools changed, with its
//! added and removed lines). MCP is left out: a Lykos session connects to no MCP server.
use std::cell::{Cell, RefCell};
use std::rc::Rc;

use crossterm::event::{MouseButton, MouseEvent, MouseEventKind};
use lykos_client::{Item, Session};
use lykos_term::{Buffer, Color, Style};
use unicode_width::UnicodeWidthStr;

use crate::app::App;
use crate::theme::{self, c, mix};

/// `ui/layout.ts`'s `SESSION_SIDEBAR_WIDTH`.
pub const WIDTH: u16 = 42;
/// `session-frame.tsx`'s `wide`: the screen is wider than this.
const WIDE: u16 = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Pending,
    Doing,
    Done,
    Dropped,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Todo {
    pub status: Status,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Changed {
    pub path: String,
    pub added: usize,
    pub removed: usize,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Content {
    pub todos: Vec<Todo>,
    pub files: Vec<Changed>,
}

/// The session, its item count and its finished tools: what the content is read from.
type Key = (String, usize, u64);

#[derive(Default)]
pub struct Side {
    /// `sidebarOpen`: opened by the toggle, so it shows on a narrow screen too.
    pub open: bool,
    /// The Todo section folded (OpenCode keeps its `view.open` in the plugin's store).
    pub todo_closed: bool,
    pub scroll: usize,
    /// The screen's width as last drawn: what the toggle and Esc decide by.
    pub width: Cell<u16>,
    /// Where it was drawn (x, width), and the Todo header's row.
    pub area: Cell<Option<(u16, u16)>>,
    pub todo_row: Cell<Option<u16>>,
    /// The furthest it scrolls, as last drawn.
    max: Cell<usize>,
    cache: RefCell<Option<(Key, Rc<Content>)>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Place {
    Beside,
    Over,
}

/// Where the sidebar shows at width `w`, if it does.
pub fn place(app: &App, w: u16) -> Option<Place> {
    if app.mini || app.diff.is_some() {
        return None;
    }
    app.current()?;
    let wide = w > WIDE;
    if app.side.open {
        return Some(if wide { Place::Beside } else { Place::Over });
    }
    (app.prefs.sidebar && wide).then_some(Place::Beside)
}

/// The width it takes from the session.
pub fn beside(app: &App, w: u16) -> u16 {
    if place(app, w) == Some(Place::Beside) {
        WIDTH
    } else {
        0
    }
}

/// The `todo` tool's list as it renders it (`lykos/tools/task-list.ts` `renderTaskList`): a `task list` line, then
/// `id [m] text`, with `  (verify: …)` and a verdict after a text that has them.
pub fn parse_todos(text: &str) -> Vec<Todo> {
    let mut lines = text.lines().skip_while(|l| !l.starts_with("task list"));
    lines.next();
    lines
        .filter_map(|l| {
            let (_, rest) = l.split_once(' ')?;
            let status = match rest.get(..3)? {
                "[ ]" => Status::Pending,
                "[>]" => Status::Doing,
                "[x]" => Status::Done,
                "[-]" => Status::Dropped,
                _ => return None,
            };
            let text = rest[3..].trim_start();
            let text = text.split("  (verify: ").next().unwrap_or(text);
            Some(Todo { status, text: text.trim_end().to_string() })
        })
        .collect()
}

fn relative(path: &str, cwd: &str) -> String {
    let path = path.replace('\\', "/");
    let cwd = cwd.replace('\\', "/");
    let cwd = cwd.trim_end_matches('/');
    match path.strip_prefix(cwd).and_then(|p| p.strip_prefix('/')) {
        Some(rest) if !cwd.is_empty() => rest.to_string(),
        _ => path,
    }
}

fn read(s: &Session) -> Content {
    // `util/todo.ts` `sessionTodos`: the latest finished list.
    let todos = s
        .items
        .iter()
        .rev()
        .find_map(|it| match it {
            Item::Tool { name, preview: Some(p), .. } if name == "todo" && p.contains("task list") => Some(parse_todos(p)),
            _ => None,
        })
        .unwrap_or_default();
    let mut files: Vec<Changed> = Vec::new();
    for it in &s.items {
        let Item::Tool { diff: Some(d), .. } = it else { continue };
        let path = relative(&d.path, &s.summary.cwd);
        let (a, r) = d.lines.iter().fold((0, 0), |(a, r), l| match l.kind.as_str() {
            "add" => (a + 1, r),
            "del" => (a, r + 1),
            _ => (a, r),
        });
        match files.iter_mut().find(|f| f.path == path) {
            Some(f) => {
                f.added += a;
                f.removed += r;
            }
            None => files.push(Changed { path, added: a, removed: r }),
        }
    }
    Content { todos, files }
}

/// What the sections show, read again only when the session's items or finished tools change.
pub fn content(app: &App, s: &Session) -> Rc<Content> {
    let key = (s.summary.id.clone(), s.items.len(), s.tool_ends);
    if let Some((k, c)) = &*app.side.cache.borrow() {
        if *k == key {
            return c.clone();
        }
    }
    let c = Rc::new(read(s));
    *app.side.cache.borrow_mut() = Some((key, c.clone()));
    c
}

/// One row: spans from the left, spans flush right.
#[derive(Default)]
struct Row {
    left: Vec<(String, Style)>,
    right: Vec<(String, Style)>,
    todo_head: bool,
}

fn row(text: impl Into<String>, style: Style) -> Row {
    Row { left: vec![(text.into(), style)], ..Row::default() }
}

/// The text cut from the left to `max` columns, as `FilePath` cuts a long path.
fn cut_left(text: &str, max: usize) -> String {
    if text.width() <= max {
        return text.to_string();
    }
    let mut out: Vec<char> = Vec::new();
    let mut w = 1;
    for ch in text.chars().rev() {
        let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if w + cw > max {
            break;
        }
        w += cw;
        out.push(ch);
    }
    std::iter::once('…').chain(out.into_iter().rev()).collect()
}

fn rows(app: &App, s: &Session, width: usize, bg: Color) -> Vec<Row> {
    let p = c();
    let (text, muted) = (Style::fg(p.text).on(bg), Style::fg(p.muted).on(bg));
    let mut out: Vec<Row> = Vec::new();
    let gap = |out: &mut Vec<Row>| {
        if !out.is_empty() {
            out.push(Row::default());
        }
    };
    // Context: shown once there are tokens or a cost.
    let u = s.usage.as_ref();
    let tokens = u.and_then(|u| u.context_tokens);
    let cost = u.and_then(|u| u.run_usd).filter(|c| *c > 0.0);
    if tokens.is_some() || cost.is_some() {
        out.push(row("Context", text.bold()));
        if let Some(t) = tokens {
            out.push(row(format!("{} tokens", crate::view::group(t.round() as u64)), muted));
            if let Some(pc) = u.and_then(|u| u.context_percent) {
                out.push(row(format!("{}% used", pc.round() as u64), muted));
            }
        }
        if let Some(c) = cost {
            out.push(row(format!("${c:.2} spent"), muted));
        }
    }
    let content = content(app, s);
    if !content.todos.is_empty() {
        gap(&mut out);
        let many = content.todos.len() > 2;
        let mut head = Row { todo_head: true, ..Row::default() };
        if many {
            head.left.push((if app.side.todo_closed { "▶ " } else { "▼ " }.into(), text));
        }
        head.left.push(("Todo".into(), text.bold()));
        if many && app.side.todo_closed {
            let open = content.todos.iter().filter(|t| matches!(t.status, Status::Pending | Status::Doing)).count();
            head.left.push((format!(" ({open} remaining)"), muted));
        }
        out.push(head);
        if !many || !app.side.todo_closed {
            for t in &content.todos {
                // `component/todo-item.tsx` and `util/todo.ts` `todoMarker`.
                let (mark, style) = match t.status {
                    Status::Pending => ("[ ] ", muted),
                    Status::Doing => ("[•] ", Style::fg(p.gold).on(bg)),
                    Status::Done => ("[✓] ", muted),
                    Status::Dropped => ("[-] ", muted.dim()),
                };
                for (i, piece) in crate::wrap::wrap(&t.text, width.saturating_sub(4)).into_iter().enumerate() {
                    out.push(Row { left: vec![(if i == 0 { mark } else { "    " }.into(), style), (piece, style)], ..Row::default() });
                }
            }
        }
    }
    if !content.files.is_empty() {
        gap(&mut out);
        out.push(row("Modified Files", text.bold()));
        for f in &content.files {
            let counts = [(format!("+{}", f.added), Style::fg(p.pine).on(bg)), (format!(" -{}", f.removed), Style::fg(p.love).on(bg))];
            let room = width.saturating_sub(counts.iter().map(|(s, _)| s.width()).sum::<usize>() + 1);
            out.push(Row { left: vec![(cut_left(&f.path, room), muted)], right: counts.to_vec(), todo_head: false });
        }
    }
    out
}

/// The working directory with the home directory as `~`.
fn location(cwd: &str) -> String {
    static HOME: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    let home = HOME.get_or_init(|| std::env::var("HOME").or_else(|_| std::env::var("USERPROFILE")).ok().map(|h| h.replace('\\', "/")));
    let cwd = cwd.replace('\\', "/");
    match home.as_deref().and_then(|h| cwd.strip_prefix(h)) {
        Some(rest) if rest.is_empty() || rest.starts_with('/') => format!("~{rest}"),
        _ => cwd,
    }
}

/// Draws the sidebar where it shows: beside the session, or over it on a dimmed backdrop.
pub fn draw(app: &App, buf: &mut Buffer) {
    let (w, h) = (buf.width, buf.height);
    app.side.area.set(None);
    app.side.todo_row.set(None);
    let (Some(at), Some(s)) = (place(app, w), app.current()) else { return };
    if at == Place::Over {
        // `RGBA.fromInts(0, 0, 0, 70)` over the session.
        for cell in buf.cells.iter_mut() {
            let darker = |col: Color| match col {
                Color::Rgb(..) => mix(col, Color::Rgb(0, 0, 0), 0.27),
                other => other,
            };
            cell.style = Style { fg: darker(cell.style.fg), bg: darker(cell.style.bg), attr: cell.style.attr.with(lykos_term::Attr::DIM) };
        }
    }
    let sw = WIDTH.min(w);
    let x = w - sw;
    app.side.area.set(Some((x, sw)));
    let bg = c().surface;
    buf.fill(x, 0, sw, h, Style::default().on(bg));
    if h < 6 || sw < 8 {
        return;
    }
    let (left, inner) = (x + 2, sw - 4);
    let title = s.summary.title.as_deref().unwrap_or("New session");
    buf.text(left, 1, inner.saturating_sub(2), title, Style::fg(c().text).on(bg).bold());
    // The scroll box: below the title and its padding, above the footer and its padding.
    let (top, bottom) = (3u16, h.saturating_sub(3));
    let shown = bottom.saturating_sub(top) as usize;
    let text_w = inner.saturating_sub(1) as usize;
    let all = rows(app, s, text_w, bg);
    let max = all.len().saturating_sub(shown);
    app.side.max.set(max);
    let scroll = app.side.scroll.min(max);
    for (i, r) in all.iter().skip(scroll).take(shown).enumerate() {
        let y = top + i as u16;
        if r.todo_head {
            app.side.todo_row.set(Some(y));
        }
        let mut col = left;
        for (t, st) in &r.left {
            col = buf.text(col, y, (left + text_w as u16).saturating_sub(col), t, *st);
        }
        let rw: usize = r.right.iter().map(|(t, _)| t.width()).sum();
        let mut col = (left + text_w as u16).saturating_sub(rw as u16);
        for (t, st) in &r.right {
            col = buf.text(col, y, (left + text_w as u16).saturating_sub(col), t, *st);
        }
    }
    if max > 0 && shown > 0 {
        // The scroll bar in the content's reserved right column.
        let thumb = (shown * shown / all.len()).max(1);
        let at = scroll * (shown - thumb) / max;
        for i in 0..shown {
            let on = i >= at && i < at + thumb;
            buf.text(left + inner - 1, top + i as u16, 1, if on { "┃" } else { " " }, Style::fg(c().muted).on(bg));
        }
    }
    let path = location(&s.summary.cwd);
    buf.text(left, h - 2, inner, &cut_left(&path, (inner as usize).min(38)), theme::muted().on(bg));
}

impl App {
    /// `session-frame.tsx` `toggleSidebar`: hide what shows, and remember it; show what does not, over a narrow
    /// screen too, closing the pane in its place.
    pub fn toggle_sidebar(&mut self) {
        let visible = place(self, self.side.width.get()).is_some();
        self.prefs.sidebar = !visible;
        self.side.open = !visible;
        if !visible {
            self.diff = None;
        }
        self.prefs.save();
    }

    /// Esc over a narrow screen closes the sidebar drawn over the session.
    pub fn sidebar_esc(&mut self) -> bool {
        if place(self, self.side.width.get()) != Some(Place::Over) {
            return false;
        }
        self.side.open = false;
        true
    }

    /// The wheel over the sidebar scrolls it; a click on Todo's header folds the list.
    pub fn sidebar_mouse(&mut self, m: &MouseEvent) -> bool {
        let Some((x, w)) = self.side.area.get() else { return false };
        if m.column < x || m.column >= x + w {
            return false;
        }
        match m.kind {
            MouseEventKind::ScrollUp => self.side.scroll = self.side.scroll.min(self.side.max.get()).saturating_sub(3),
            MouseEventKind::ScrollDown => self.side.scroll = (self.side.scroll + 3).min(self.side.max.get()),
            MouseEventKind::Down(MouseButton::Left) if self.side.todo_row.get() == Some(m.row) => {
                let many = self.current().is_some_and(|s| content(self, s).todos.len() > 2);
                if many {
                    self.side.todo_closed = !self.side.todo_closed;
                }
            }
            _ => {}
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use lykos_client::{DiffData, DiffLine, Event, EventData, UsageData};
    use std::time::Instant;

    const LIST: &str = "task list (2 open of 4):\nt1 [x] read the code  (verify: npm test)  verified\nt2 [>] write the sidebar\nt3 [ ] test it\nt4 [-] drop this";

    fn session() -> App {
        let mut app = App::new(r"C:\w".into());
        app.connected();
        app.started("s1".into());
        let ev = |seq, data| Event { event: "x".into(), session: "s1".into(), seq, data };
        let line = |kind: &str| DiffLine { kind: kind.into(), text: String::new() };
        let summary = lykos_client::SessionSummary {
            id: "s1".into(),
            cwd: r"C:\w".into(),
            status: lykos_client::SessionStatus::Idle,
            model: "m1".into(),
            title: None,
            started_at: "2026-11-24T00:00:00Z".into(),
            origin: "tui".into(),
            ledger_session_id: None,
        };
        let events = [
            EventData::SessionStatus { session: summary },
            EventData::MessageUser { text: "go".into() },
            EventData::ToolStart { tool_id: "t1".into(), name: "todo".into(), summary: String::new(), args: serde_json::Value::Null },
            EventData::ToolEnd { tool_id: "t1".into(), name: "todo".into(), ok: true, preview: Some(LIST.into()), diff: None },
            EventData::ToolStart { tool_id: "t2".into(), name: "edit".into(), summary: String::new(), args: serde_json::Value::Null },
            EventData::ToolEnd { tool_id: "t2".into(), name: "edit".into(), ok: true, preview: None, diff: Some(DiffData { path: r"C:\w\src\a.rs".into(), lines: vec![line("add"), line("add"), line("del"), line("ctx")] }) },
            EventData::Usage { usage: UsageData { context_tokens: Some(12345.0), context_percent: Some(6.2), run_usd: Some(0.5), ..Default::default() } },
        ];
        for (i, data) in events.into_iter().enumerate() {
            app.on_event(&ev(i as u64 + 1, data));
        }
        app
    }

    fn screen(app: &App, w: u16, h: u16) -> String {
        let mut buf = Buffer::new(w, h);
        crate::view::draw(app, &mut buf);
        (0..h).map(|y| (0..w).map(|x| buf.get(x, y).ch).filter(|c| *c != '\0').collect::<String>() + "\n").collect()
    }

    #[test]
    fn the_todo_tools_list_parses() {
        let t = parse_todos(LIST);
        assert_eq!(t.iter().map(|t| t.status).collect::<Vec<_>>(), [Status::Done, Status::Doing, Status::Pending, Status::Dropped]);
        assert_eq!(t[0].text, "read the code");
        assert!(parse_todos("task list: empty").is_empty());
    }

    #[test]
    fn a_wide_screen_shows_it_beside_the_session() {
        let app = session();
        let s = screen(&app, 160, 30);
        for want in ["New session", "Context", "12,345 tokens", "6% used", "$0.50 spent", "▼ Todo", "[•] write the sidebar", "[✓] read the code", "Modified Files", "src/a.rs", "+2 -1", "C:/w"] {
            assert!(s.contains(want), "{want}: {s}");
        }
        assert_eq!(crate::diffview::session_width(&app, 160), 118);
        assert!(!screen(&app, 120, 30).contains("Modified Files"), "120 columns is not wide");
    }

    #[test]
    fn the_toggle_hides_it_and_shows_it_over_a_narrow_screen() {
        let mut app = session();
        screen(&app, 160, 30);
        app.toggle_sidebar();
        assert!(!app.prefs.sidebar, "remembered as hidden");
        assert!(!screen(&app, 160, 30).contains("Modified Files"));
        screen(&app, 100, 30);
        app.toggle_sidebar();
        assert_eq!(place(&app, 100), Some(Place::Over));
        assert!(screen(&app, 100, 30).contains("Modified Files"));
        assert_eq!(crate::diffview::session_width(&app, 100), 100, "over the session, not beside it");
        app.on_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), Instant::now(), 10);
        assert_eq!(place(&app, 100), None, "esc closes it");
    }

    #[test]
    fn a_click_on_todo_folds_a_long_list_and_the_diff_viewer_takes_its_place() {
        let mut app = session();
        screen(&app, 160, 30);
        let row = app.side.todo_row.get().unwrap();
        let click = MouseEvent { kind: MouseEventKind::Down(MouseButton::Left), column: 150, row, modifiers: KeyModifiers::NONE };
        app.on_mouse(click, Instant::now());
        let s = screen(&app, 160, 30);
        assert!(s.contains("▶ Todo (2 remaining)") && !s.contains("write the sidebar"), "{s}");
        app.open_diff();
        assert_eq!(place(&app, 160), None);
    }
}
