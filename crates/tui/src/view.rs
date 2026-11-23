//! The two screens, drawn into a cell buffer. Layout follows OpenCode's TUI at `4332e24`: the home screen
//! (`routes/home.tsx`), the session screen (`routes/session/index.tsx`), the prompt box (`component/prompt/index.tsx`)
//! and its metadata row (`component/prompt/metadata.tsx`). Differences are listed in #37's closing comment.
use lykos_client::{Item, Session, SessionStatus, ToolState};
use lykos_term::{Attr, Buffer, Cell, Style};
use unicode_width::UnicodeWidthChar;

use crate::app::{App, Link};
use crate::theme::{self, ACCENT, GOLD, LOVE, MUTED, OVERLAY, PINE, SURFACE};
use crate::wrap::wrap;

const SPINNER: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/// One transcript row: where it starts, its text, its style, and an optional bar in the first column.
struct Row {
    indent: u16,
    text: String,
    style: Style,
    bar: Option<Style>,
    bg: Option<Style>,
}

impl Row {
    fn plain(indent: u16, text: String, style: Style) -> Row {
        Row { indent, text, style, bar: None, bg: None }
    }

    fn blank() -> Row {
        Row::plain(0, String::new(), Style::default())
    }
}

/// Draws the frame and returns where the cursor goes.
pub fn draw(app: &App, buf: &mut Buffer) -> Option<(u16, u16)> {
    let (w, h) = (buf.width, buf.height);
    if w < 10 || h < 6 {
        buf.text(0, 0, w, "lykos", theme::text());
        return None;
    }
    let pad: u16 = if w < 44 { 1 } else { 2 };
    match app.current() {
        None => home(app, buf, pad),
        Some(session) => session_screen(app, session, buf, pad),
    }
}

/// `routes/home.tsx`: the logo and the prompt box centred, the prompt at most 75 columns wide.
fn home(app: &App, buf: &mut Buffer, pad: u16) -> Option<(u16, u16)> {
    let (w, h) = (buf.width, buf.height);
    let width = (w - 2 * pad).min(75);
    let x = (w - width) / 2;
    let prompt = prompt_height(app, width, h);
    let logo: [&str; 3] = ["█   █ █ █ █ ███ ███", "█    █  ██  █ █ █▄▄", "███  █  █ █ ███ ▄▄█"];
    let block = logo.len() as u16 + 2 + prompt + 2;
    let top = h.saturating_sub(block + 1) / 2;
    for (i, line) in logo.iter().enumerate() {
        let lw = line.chars().count() as u16;
        buf.text((w.saturating_sub(lw)) / 2, top + i as u16, lw, line, Style::fg(ACCENT));
    }
    let y = top + logo.len() as u16 + 2;
    let cursor = prompt_box(app, buf, x, y, width, h);
    if let Some(n) = &app.notice {
        buf.text(x + 1, y + prompt + 1, width.saturating_sub(1), n, Style::fg(LOVE));
    }
    footer_line(app, buf, 0, h - 1, w, pad);
    cursor
}

/// `routes/session/index.tsx`: the transcript fills the screen above the prompt box, following the newest row.
fn session_screen(app: &App, session: &Session, buf: &mut Buffer, pad: u16) -> Option<(u16, u16)> {
    let (w, h) = (buf.width, buf.height);
    let inner_w = w - 2 * pad;
    let prompt = prompt_height(app, inner_w, h);
    let prompt_y = h.saturating_sub(prompt);
    // The chat in one large box (P5 decision 5): a border round the transcript, the title on its top edge.
    let box_h = prompt_y.saturating_sub(1);
    if box_h >= 3 {
        buf.border(pad - 1, 0, inner_w + 2, box_h, Style::fg(OVERLAY));
        let title = session.summary.title.as_deref().unwrap_or("New session");
        let title: String = format!(" {} ", first_line(title));
        buf.text(pad + 1, 0, inner_w.saturating_sub(4), &title, theme::subtle().bold());
        let rows = transcript(app, session, inner_w.saturating_sub(2));
        let view_h = box_h.saturating_sub(2) as usize;
        let max_scroll = rows.len().saturating_sub(view_h);
        let scroll = app.scroll.min(max_scroll);
        let start = rows.len().saturating_sub(view_h + scroll);
        for (i, row) in rows[start..rows.len() - scroll].iter().enumerate() {
            let y = 1 + i as u16;
            let x = pad + 1;
            if let Some(bg) = row.bg {
                buf.fill(x, y, inner_w.saturating_sub(2), 1, bg);
            }
            if let Some(bar) = row.bar {
                buf.set(x, y, Cell { ch: '┃', style: bar });
            }
            let style = match row.bg {
                Some(bg) => Style { bg: bg.bg, ..row.style },
                None => row.style,
            };
            buf.text(x + row.indent, y, inner_w.saturating_sub(2 + row.indent), &row.text, style);
        }
        if scroll > 0 {
            let label = " Jump to latest ↓ (end) ";
            let lw = label.chars().count() as u16;
            buf.text(pad + inner_w.saturating_sub(lw + 1), box_h - 1, lw, label, Style::fg(PINE));
        }
    }
    prompt_box(app, buf, pad, prompt_y, inner_w, h)
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}

/// The prompt box's height: input rows, a row of padding above and below, the metadata row, the bottom edge
/// and the footer.
fn prompt_height(app: &App, width: u16, screen_h: u16) -> u16 {
    let max = max_input_rows(screen_h);
    let rows = input_rows(&app.input, input_width(width)).len().max(1) as u16;
    rows.min(max) + 5 + request_rows(app)
}

/// The input grows to a third of the screen, then scrolls.
fn max_input_rows(screen_h: u16) -> u16 {
    (screen_h / 3).max(1)
}

fn input_width(width: u16) -> usize {
    width.saturating_sub(5).max(1) as usize
}

fn request_rows(app: &App) -> u16 {
    app.current().and_then(|s| s.requests.first()).map_or(0, |_| 3)
}

/// The input as rows, wrapped at characters so the cursor maps to one cell, and where the cursor is.
fn input_rows(input: &str, width: usize) -> Vec<String> {
    layout_input(input, width, usize::MAX).0
}

fn layout_input(input: &str, width: usize, cursor: usize) -> (Vec<String>, (usize, usize)) {
    let mut rows = vec![String::new()];
    let mut col = 0;
    let mut at = (0, 0);
    for (i, ch) in input.chars().enumerate() {
        if i == cursor {
            at = (rows.len() - 1, col);
        }
        if ch == '\n' {
            rows.push(String::new());
            col = 0;
            continue;
        }
        let cw = ch.width().unwrap_or(0);
        if col + cw > width {
            rows.push(String::new());
            col = 0;
        }
        rows.last_mut().unwrap().push(ch);
        col += cw;
    }
    if cursor >= input.chars().count() {
        if col >= width {
            rows.push(String::new());
            col = 0;
        }
        at = (rows.len() - 1, col);
    }
    (rows, at)
}

/// `component/prompt/index.tsx`: a left bar in the accent colour on a raised background, the input with a row of
/// padding above, the metadata row, a half-block bottom edge, and the footer under it.
fn prompt_box(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16, screen_h: u16) -> Option<(u16, u16)> {
    let raised = Style::default().on(SURFACE);
    let bar = Style::fg(if app.running() { GOLD } else { ACCENT }).on(SURFACE);
    let iw = input_width(width);
    let (rows, (crow, ccol)) = layout_input(&app.input, iw, app.cursor);
    let max = max_input_rows(screen_h) as usize;
    let shown = rows.len().min(max);
    // Keep the cursor's row in view when the input is taller than the box.
    let first = (crow + 1).saturating_sub(shown);
    let req = request_rows(app);
    let body = 1 + req + shown as u16 + 1;
    buf.fill(x, y, width, body, raised);
    for row in 0..body {
        buf.set(x, y + row, Cell { ch: '┃', style: bar });
    }
    let tx = x + 3;
    let mut ty = y + 1;
    if let Some(r) = app.current().and_then(|s| s.requests.first()) {
        let head = format!("{}: {}", r.title, first_line(&r.detail));
        buf.text(tx, ty, width.saturating_sub(4), &head, Style::fg(GOLD).on(SURFACE).bold());
        let opts: Vec<String> = r.options.iter().map(|o| format!("{} {}", o.value, o.label)).collect();
        buf.text(tx, ty + 1, width.saturating_sub(4), &opts.join("   "), theme::subtle().on(SURFACE));
        ty += req;
    }
    let mut cursor = None;
    if app.input.is_empty() {
        let hint = if app.current().is_some() { "Ask anything…" } else { "Ask anything… \"Fix a TODO in the codebase\"" };
        buf.text(tx, ty, width.saturating_sub(4), hint, Style::fg(MUTED).on(SURFACE));
        cursor = Some((tx, ty));
    }
    for (i, row) in rows[first..first + shown].iter().enumerate() {
        buf.text(tx, ty + i as u16, iw as u16, row, theme::text().on(SURFACE));
    }
    if !app.input.is_empty() {
        cursor = Some((tx + ccol as u16, ty + (crow - first) as u16));
    }
    let meta_y = y + body;
    buf.fill(x, meta_y, width, 1, raised);
    buf.set(x, meta_y, Cell { ch: '┃', style: bar });
    metadata(app, buf, tx, meta_y, width.saturating_sub(4));
    // The bottom edge: `╹` under the bar, then `▀` in the box colour, so the box ends on a half cell.
    let edge_y = meta_y + 1;
    buf.set(x, edge_y, Cell { ch: '╹', style: Style::fg(if app.running() { GOLD } else { ACCENT }) });
    for col in x + 1..x + width {
        buf.set(col, edge_y, Cell { ch: '▀', style: Style::fg(SURFACE) });
    }
    if app.current().is_some() {
        footer_line(app, buf, x, edge_y + 1, width, 0);
    }
    if app.current().and_then(|s| s.requests.first()).is_some() {
        return None;
    }
    cursor
}

/// `component/prompt/metadata.tsx`: model, then ` · ` and the thinking effort in bold warning colour.
fn metadata(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16) {
    let usage = app.current().and_then(|s| s.usage.as_ref());
    let model = usage.and_then(|u| u.model.clone()).or_else(|| app.current().map(|s| s.summary.model.clone())).filter(|m| !m.is_empty());
    let Some(model) = model else {
        buf.text(x, y, width, "lykos", theme::muted().on(SURFACE));
        return;
    };
    let mut col = buf.text(x, y, width, &model, theme::text().on(SURFACE));
    if let Some(effort) = usage.and_then(|u| u.effort.as_deref()).filter(|e| !e.is_empty()) {
        col = buf.text(col, y, (x + width).saturating_sub(col), " · ", theme::muted().on(SURFACE));
        buf.text(col, y, (x + width).saturating_sub(col), effort, Style::fg(GOLD).on(SURFACE).bold());
    }
}

/// The row under the prompt box: the spinner and `esc interrupt` while running, else the directory; on the right,
/// the context window's use.
fn footer_line(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16, pad: u16) {
    let x = x + pad;
    let width = width.saturating_sub(2 * pad);
    let right = context_label(app);
    let rw = right.as_ref().map_or(0, |r| r.chars().count() as u16);
    let left_w = width.saturating_sub(rw + 2);
    match &app.link {
        Link::Connecting => {
            let s = format!("{} connecting to the engine server", SPINNER[(app.tick % 10) as usize]);
            buf.text(x + 1, y, left_w, &s, theme::muted());
        }
        Link::Failed(m) | Link::Lost(m) => {
            buf.text(x + 1, y, left_w, m, Style::fg(LOVE));
        }
        Link::Ready if app.running() => {
            let mut col = buf.text(x + 1, y, left_w, &SPINNER[(app.tick % 10) as usize].to_string(), Style::fg(ACCENT));
            col = buf.text(col + 1, y, left_w, "esc", if app.armed.is_some() { Style::fg(GOLD) } else { theme::text() });
            let rest = if app.armed.is_some() { " again to interrupt" } else { " interrupt" };
            buf.text(col, y, left_w, rest, if app.armed.is_some() { Style::fg(GOLD) } else { theme::muted() });
        }
        Link::Ready => {
            buf.text(x + 1, y, left_w, &app.cwd, theme::muted());
        }
    }
    if let Some(r) = right.filter(|_| rw + 2 <= width) {
        buf.text(x + width - rw, y, rw, &r, theme::muted());
    }
}

/// `feature-plugins/sidebar/context.tsx`'s two facts, `N tokens` and `P% used`, on one line.
fn context_label(app: &App) -> Option<String> {
    let u = app.current()?.usage.as_ref()?;
    let tokens = u.context_tokens?;
    let mut s = format!("{} tokens", group(tokens.round() as u64));
    if let Some(p) = u.context_percent {
        s.push_str(&format!(" · {}% used", p.round() as u64));
    }
    Some(s)
}

fn group(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// The transcript as rows, oldest first.
fn transcript(app: &App, session: &Session, width: u16) -> Vec<Row> {
    let w = width as usize;
    let mut rows = Vec::new();
    let user_bg = Style::default().on(SURFACE);
    for item in &session.items {
        match item {
            // A user message: a bar in the accent colour on a raised background, padded a row above and below.
            Item::User(text) | Item::Followup(text) => {
                let bar = Style::fg(if matches!(item, Item::User(_)) { ACCENT } else { MUTED }).on(SURFACE);
                rows.push(Row { indent: 0, text: String::new(), style: theme::text(), bar: Some(bar), bg: Some(user_bg) });
                for line in wrap(text, w.saturating_sub(3)) {
                    rows.push(Row { indent: 2, text: line, style: theme::text(), bar: Some(bar), bg: Some(user_bg) });
                }
                rows.push(Row { indent: 0, text: String::new(), style: theme::text(), bar: Some(bar), bg: Some(user_bg) });
                rows.push(Row::blank());
            }
            Item::Assistant(text) => {
                for line in wrap(text.trim_end(), w.saturating_sub(3)) {
                    rows.push(Row::plain(3, line, theme::text()));
                }
                rows.push(Row::blank());
            }
            Item::Thinking(text) => {
                let style = Style { fg: MUTED, attr: Attr::ITALIC, ..Style::default() };
                for line in wrap(&format!("Thinking: {}", text.trim()), w.saturating_sub(3)) {
                    rows.push(Row::plain(3, line, style));
                }
                rows.push(Row::blank());
            }
            Item::Tool { name, summary, state, .. } => {
                let (icon, style) = match state {
                    ToolState::Running => (SPINNER[(app.tick % 10) as usize], Style::fg(ACCENT)),
                    ToolState::Ok => (tool_icon(name), theme::muted()),
                    ToolState::Error => ('✗', Style::fg(LOVE)),
                };
                let label = format!("{icon} {name} {summary}");
                for line in wrap(&label, w.saturating_sub(3)) {
                    rows.push(Row::plain(3, line, style));
                }
            }
            Item::System(text) => {
                for line in wrap(text, w.saturating_sub(3)) {
                    rows.push(Row::plain(3, line, theme::muted()));
                }
            }
        }
    }
    if session.summary.status == SessionStatus::Starting {
        rows.push(Row::plain(3, format!("{} starting the session", SPINNER[(app.tick % 10) as usize]), theme::muted()));
    }
    if let Some(q) = &app.queued {
        rows.push(Row::plain(3, format!("queued: {}", first_line(q)), theme::muted()));
    }
    rows
}

/// `routes/session/index.tsx`'s inline tool icons: `→` reads, `←` writes, `✱` searches, `%` the web, `$` a shell.
fn tool_icon(name: &str) -> char {
    match name {
        "read" | "ls" => '→',
        "write" | "edit" | "ast_edit" => '←',
        "grep" | "find" | "glob" | "search" | "ast_grep" => '✱',
        "web_fetch" | "web_search" => '%',
        "bash" | "powershell" => '$',
        _ => '⚙',
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lykos_client::{Event, EventData, SessionSummary, UsageData};

    fn screen(buf: &Buffer) -> String {
        let mut s = String::new();
        for y in 0..buf.height {
            for x in 0..buf.width {
                let ch = buf.get(x, y).ch;
                if ch != '\0' {
                    s.push(ch);
                }
            }
            s.push('\n');
        }
        s
    }

    fn app_with_session() -> App {
        let mut app = App::new("C:/work".into());
        app.connected();
        app.started("s1".into());
        let summary = SessionSummary {
            id: "s1".into(),
            cwd: "C:/work".into(),
            status: SessionStatus::Running,
            model: "anthropic/claude".into(),
            title: Some("Fix it".into()),
            started_at: "x".into(),
            origin: "tui".into(),
            ledger_session_id: None,
        };
        let events = [
            EventData::SessionStatus { session: summary },
            EventData::MessageUser { text: "Fix it".into() },
            EventData::MessageDelta { text: "On it.".into() },
            EventData::ToolStart { tool_id: "t1".into(), name: "read".into(), summary: "src/main.rs".into(), args: serde_json::Value::Null },
            EventData::Usage {
                usage: UsageData { model: Some("claude-opus".into()), effort: Some("high".into()), context_tokens: Some(12345.0), context_window: Some(200000.0), context_percent: Some(6.2), ..Default::default() },
            },
        ];
        for (i, data) in events.into_iter().enumerate() {
            app.on_event(&Event { event: "x".into(), session: "s1".into(), seq: i as u64 + 1, data });
        }
        app
    }

    #[test]
    fn the_home_screen_has_the_prompt_box_and_the_directory() {
        let mut app = App::new("C:/work".into());
        app.connected();
        let mut buf = Buffer::new(100, 30);
        let cursor = draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("Ask anything"), "{s}");
        assert!(s.contains("C:/work"), "{s}");
        assert!(cursor.is_some());
    }

    #[test]
    fn the_session_screen_shows_model_effort_context_and_the_turn() {
        let app = app_with_session();
        let mut buf = Buffer::new(100, 30);
        draw(&app, &mut buf);
        let s = screen(&buf);
        for want in ["Fix it", "On it.", "read src/main.rs", "claude-opus · high", "12,345 tokens · 6% used", "esc interrupt"] {
            assert!(s.contains(want), "missing {want:?} in\n{s}");
        }
    }

    #[test]
    fn typed_text_and_the_cursor_land_in_the_box() {
        let mut app = app_with_session();
        app.on_paste("hello");
        let mut buf = Buffer::new(60, 20);
        let (cx, cy) = draw(&app, &mut buf).unwrap();
        assert!(screen(&buf).contains("hello"));
        assert_eq!(buf.get(cx - 1, cy).ch, 'o');
    }

    #[test]
    fn a_tiny_terminal_draws_without_panicking() {
        let mut busy = app_with_session();
        busy.on_paste(&"long words in the prompt ".repeat(20));
        for app in [&app_with_session(), &busy, &App::new("C:/work".into())] {
            for w in 1..60 {
                for h in 1..20 {
                    let mut buf = Buffer::new(w, h);
                    draw(app, &mut buf);
                }
            }
        }
    }

    #[test]
    fn groups_thousands() {
        assert_eq!(group(0), "0");
        assert_eq!(group(1234567), "1,234,567");
    }
}
