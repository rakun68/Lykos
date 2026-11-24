//! The two screens, drawn into a cell buffer. Layout follows OpenCode's TUI at `4332e24`: the home screen
//! (`routes/home.tsx`), the session screen (`routes/session/index.tsx`), the prompt box (`component/prompt/index.tsx`)
//! and its metadata row (`component/prompt/metadata.tsx`). Differences are listed in #37's closing comment.
use std::rc::Rc;

use lykos_client::{Item, Session, SessionStatus};
use lykos_term::{Attr, Buffer, Cell, Scroll, Style};

use crate::app::{App, Dialog, Frame, Info, InputArea, Link, List, Row as ListRow};
use crate::editor::{Chip, Editor};
use crate::keymap;
use crate::menu::Menu;
use crate::theme::{self, c};
use crate::transcript::{self, Block, Row, SPINNER};
use crate::wrap::wrap;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};


/// One transcript row: where it starts, its text, its style, and an optional bar in the first column.
/// Draws the frame and returns where the cursor goes.
pub fn draw(app: &App, buf: &mut Buffer) -> Option<(u16, u16)> {
    let cursor = draw_screen(app, buf);
    theme::paint_base(buf);
    cursor
}

fn draw_screen(app: &App, buf: &mut Buffer) -> Option<(u16, u16)> {
    let (w, h) = (buf.width, buf.height);
    if w < 10 || h < 6 {
        buf.text(0, 0, w, "lykos", theme::text());
        return None;
    }
    let pad = pad(w);
    let cursor = match app.current() {
        None => home(app, buf, pad),
        Some(session) => session_screen(app, session, buf, pad),
    };
    crate::request::draw_expanded(app, buf);
    if app.dialog.is_some() {
        dialog(app, buf);
        return None;
    }
    cursor
}

/// The input's width at this screen width: what up and down move through.
pub fn input_cols(app: &App, w: u16) -> usize {
    let width = w.saturating_sub(2 * pad(w));
    input_width(if app.current().is_none() && !app.mini { width.min(75) } else { width })
}

/// `routes/home.tsx`: the logo and the prompt box centred, the prompt at most 75 columns wide.
fn home(app: &App, buf: &mut Buffer, pad: u16) -> Option<(u16, u16)> {
    let (w, h) = (buf.width, buf.height);
    app.frame.set(None);
    let width = (w - 2 * pad).min(75);
    let x = (w - width) / 2;
    let prompt = prompt_height(app, width, h);
    let logo: [&str; 3] = ["█   █ █ █ █ ███ ███", "█    █  ██  █ █ █▄▄", "███  █  █ █ ███ ▄▄█"];
    let block = logo.len() as u16 + 2 + prompt + 2;
    let top = h.saturating_sub(block + 1) / 2;
    for (i, line) in logo.iter().enumerate() {
        let lw = line.chars().count() as u16;
        buf.text((w.saturating_sub(lw)) / 2, top + i as u16, lw, line, Style::fg(c().accent));
    }
    let y = top + logo.len() as u16 + 2;
    let cursor = prompt_box(app, buf, x, y, width, h);
    if let Some(n) = &app.notice {
        buf.text(x + 1, y + prompt + 1, width.saturating_sub(1), n, Style::fg(c().love));
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
        buf.border(pad - 1, 0, inner_w + 2, box_h, Style::fg(c().overlay));
        tab_strip(app, session, buf, pad + 1, inner_w.saturating_sub(4));
        let bar = app.prefs.scrollbar;
        let text_w = inner_w.saturating_sub(2 + u16::from(bar));
        let opened = app.opened.get(&session.summary.id);
        let before = app.frame.get();
        // The last frame's layout lets go of the settled run, so the cache can grow it in place.
        app.laid.replace(None);
        let mut lay = transcript::layout(&app.layout_cache, session, app.look(), text_w as usize, app.tick, opened);
        // What is not the session's: its start, and the prompts waiting for the turn.
        let mut tail = Block { first: usize::MAX, ..Block::default() };
        if session.summary.status == SessionStatus::Starting {
            tail.rows.push(Row::plain(3, format!("{} starting the session", spinner(app)), theme::muted()));
        }
        for q in &app.queue {
            tail.rows.push(Row::plain(3, format!("queued: {}", first_line(q)), theme::muted()));
        }
        if !tail.rows.is_empty() {
            lay.push(tail);
        }
        let total = lay.total;
        let view_h = box_h.saturating_sub(2) as usize;
        let max_scroll = total.saturating_sub(view_h);
        // A jump (the timeline, the message keys): the message's first row at the top, an answer's with the row
        // above it (`message-navigation.ts`).
        if let Some(i) = app.jump.take() {
            if let Some(at) = lay.item_row(i) {
                let at = if matches!(session.items.get(i), Some(Item::Assistant(_))) { at.saturating_sub(1) } else { at };
                app.jumped.set(Some(total.saturating_sub(view_h + at).min(max_scroll)));
            }
        }
        let scroll = app.scroll_now().min(max_scroll);
        let start = total.saturating_sub(view_h + scroll);
        let x = pad + 1;
        let sel = app.selection.map(|s| s.ordered());
        for (i, r) in (start..total - scroll).enumerate() {
            let Some(row) = lay.row(r) else { continue };
            let y = 1 + i as u16;
            paint_row(buf, x, y, text_w, row);
            // A selection shows reversed.
            if let Some(((r0, c0), (r1, c1))) = sel.filter(|((r0, _), (r1, _))| (*r0..=*r1).contains(&r)) {
                let from = if r == r0 { c0 } else { 0 };
                let to = if r == r1 { c1 + 1 } else { text_w as usize };
                for col in from..to.min(text_w as usize) {
                    let mut cell = *buf.get(x + col as u16, y);
                    cell.style.attr = cell.style.attr.with(Attr::REVERSE);
                    if cell.ch == '\0' {
                        cell.ch = ' ';
                    }
                    buf.set(x + col as u16, y, cell);
                }
            }
        }
        // `session.toggle.scrollbar`: the thumb shows where the view is in the whole.
        if bar && total > view_h && view_h > 0 {
            let sx = x + text_w;
            let thumb = (view_h * view_h / total).max(1);
            let at = start * (view_h - thumb) / max_scroll.max(1);
            for i in 0..view_h {
                let on = (at..at + thumb).contains(&i);
                buf.set(sx, 1 + i as u16, Cell { ch: if on { '┃' } else { '│' }, style: Style::fg(if on { c().muted } else { c().overlay }) });
            }
        }
        let now = Frame { x, y: 1, width: text_w, height: view_h as u16, top: start };
        // Scrolled in the same box: the terminal moves the rows and writes only those that came in.
        if let Some(b) = before.filter(|b| Frame { top: start, ..*b } == now && b.top != start) {
            buf.scroll = Some(Scroll { top: now.y, rows: now.height, by: (start as i64 - b.top as i64).clamp(-(view_h as i64), view_h as i64) as i32 });
        }
        app.frame.set(Some(now));
        app.laid.replace(Some(Rc::new(lay)));
        if scroll > 0 {
            let label = " Jump to latest ↓ (ctrl+alt+g) ";
            let lw = label.chars().count() as u16;
            buf.text(pad + inner_w.saturating_sub(lw + 1), box_h - 1, lw, label, Style::fg(c().pine));
        }
    }
    prompt_box(app, buf, pad, prompt_y, inner_w, h)
}

/// One transcript row: its background, its bar in the first column, its text from its indent.
pub fn paint_row(buf: &mut Buffer, x: u16, y: u16, width: u16, row: &Row) {
    if let Some(bg) = row.bg {
        buf.fill(x, y, width, 1, bg);
    }
    if let Some(bar) = row.bar {
        buf.set(x, y, Cell { ch: '┃', style: bar });
    }
    let style = match row.bg {
        Some(bg) => Style { bg: bg.bg, ..row.style },
        None => row.style,
    };
    buf.text(x + row.indent, y, width.saturating_sub(row.indent), &row.text, style);
}

/// The screen's side padding at width `w`.
pub fn pad(w: u16) -> u16 {
    if w < 44 {
        1
    } else {
        2
    }
}

/// Mini mode's footer holds at most this many of the rows still changing.
const LIVE_ROWS: usize = 4;

/// Mini mode's footer height (`mini/footer.ts` `applyHeight`): the rows still changing, the completion list and the
/// prompt box; with a dialog open, two thirds of the screen.
pub fn mini_height(app: &App, w: u16, screen_h: u16, live: usize) -> u16 {
    if app.dialog.is_some() {
        return (screen_h * 2 / 3).max(12);
    }
    let menu = app.menu.as_ref().map_or(0, |m| m.entries.len()) as u16;
    live.min(LIVE_ROWS) as u16 + menu + prompt_height(app, w.saturating_sub(2 * pad(w)), screen_h)
}

/// Mini mode's footer: the rows still changing, then the prompt box and its footer line, on the terminal's own
/// background.
pub fn draw_mini(app: &App, buf: &mut Buffer, live: &[Row], screen_h: u16) -> Option<(u16, u16)> {
    app.frame.set(None);
    if app.dialog.is_some() {
        dialog(app, buf);
        return None;
    }
    let w = buf.width;
    let (pad, inner) = (pad(w), w.saturating_sub(2 * pad(w)));
    let live = &live[live.len().saturating_sub(LIVE_ROWS)..];
    for (i, row) in live.iter().enumerate() {
        paint_row(buf, pad, i as u16, inner, row);
    }
    let menu = app.menu.as_ref().map_or(0, |m| m.entries.len()) as u16;
    let y = live.len() as u16 + menu;
    let cursor = prompt_box(app, buf, pad, y, inner, screen_h);
    if app.current().is_none() {
        footer_line(app, buf, pad, y + prompt_height(app, inner, screen_h) - 1, inner, 0);
    }
    cursor
}

/// The box's top edge: the session's title, or with more than one tab open, every tab's (OpenCode
/// `component/session-tabs.tsx`): the one shown bold, an unread one marked.
fn tab_strip(app: &App, session: &Session, buf: &mut Buffer, x: u16, width: u16) {
    let title_of = |id: &str| app.store.sessions.get(id).and_then(|s| s.summary.title.clone()).unwrap_or_else(|| "New session".into());
    if app.tabs.open.len() < 2 {
        let title = session.summary.title.as_deref().unwrap_or("New session");
        buf.text(x, 0, width, &format!(" {} ", first_line(title)), theme::subtle().bold());
        return;
    }
    let mut at = x;
    let end = x + width;
    for (i, id) in app.tabs.open.iter().enumerate() {
        let shown = app.session.as_deref() == Some(id.as_str());
        let mark = if app.tabs.unread.contains(id) { "• " } else { "" };
        let title: String = first_line(&title_of(id)).chars().take(24).collect();
        let label = format!(" {mark}{} {title} ", i + 1);
        let style = if shown { Style::fg(c().accent).bold() } else { theme::subtle() };
        let lw = label.width() as u16;
        if at >= end {
            break;
        }
        buf.text(at, 0, end - at, &label, style);
        at += lw;
    }
}

/// A spinner frame, or `⋯` with animations off (`component/spinner.tsx`).
fn spinner(app: &App) -> char {
    if app.prefs.animations {
        SPINNER[(app.tick % 10) as usize]
    } else {
        '⋯'
    }
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}

/// The prompt box's height: input rows, a row of padding above and below, the metadata row, the bottom edge
/// and the footer.
fn prompt_height(app: &App, width: u16, screen_h: u16) -> u16 {
    if app.request().is_some() {
        return crate::request::height(app, width, screen_h);
    }
    let max = max_input_rows(screen_h);
    let rows = app.editor.layout(input_width(width)).len().max(1) as u16;
    rows.min(max) + 5
}

/// The input grows to a third of the screen, then scrolls.
fn max_input_rows(screen_h: u16) -> u16 {
    (screen_h / 3).max(1)
}

fn input_width(width: u16) -> usize {
    width.saturating_sub(5).max(1) as usize
}

/// `component/prompt/index.tsx`: a left bar in the accent colour on a raised background, the input with a row of
/// padding above, the metadata row, a half-block bottom edge, and the footer under it.
fn prompt_box(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16, screen_h: u16) -> Option<(u16, u16)> {
    if app.request().is_some() {
        app.input_area.set(None);
        return crate::request::draw(app, buf, x, y, width, screen_h);
    }
    let raised = Style::default().on(c().surface);
    let bar = Style::fg(if app.running() { c().gold } else { c().accent }).on(c().surface);
    let iw = input_width(width);
    let rows = app.editor.layout(iw);
    let (crow, ccol) = app.editor.locate(&rows, app.editor.cursor());
    let max = max_input_rows(screen_h) as usize;
    let shown = rows.len().min(max);
    // Keep the cursor's row in view when the input is taller than the box.
    let first = (crow + 1).saturating_sub(shown);
    let body = 1 + shown as u16 + 1;
    buf.fill(x, y, width, body, raised);
    for row in 0..body {
        buf.set(x, y + row, Cell { ch: '┃', style: bar });
    }
    let tx = x + 3;
    let ty = y + 1;
    let mut cursor = None;
    if app.editor.is_empty() {
        let hint = if app.current().is_some() { "Ask anything…" } else { "Ask anything… \"Fix a TODO in the codebase\"" };
        buf.text(tx, ty, width.saturating_sub(4), hint, Style::fg(c().muted).on(c().surface));
        cursor = Some((tx, ty));
    }
    let selection = app.editor.selection();
    for (i, row) in rows[first..first + shown].iter().enumerate() {
        input_row(&app.editor, buf, tx, ty + i as u16, iw as u16, *row, selection);
    }
    app.input_area.set(Some(InputArea { x: tx, y: ty, width: iw as u16, height: shown as u16, first }));
    if !app.editor.is_empty() {
        cursor = Some((tx + ccol as u16, ty + (crow - first) as u16));
    }
    if let Some(m) = &app.menu {
        completion(m, buf, x, y, width);
    }
    let meta_y = y + body;
    buf.fill(x, meta_y, width, 1, raised);
    buf.set(x, meta_y, Cell { ch: '┃', style: bar });
    metadata(app, buf, tx, meta_y, width.saturating_sub(4));
    // The bottom edge: `╹` under the bar, then `▀` in the box colour, so the box ends on a half cell.
    let edge_y = meta_y + 1;
    buf.set(x, edge_y, Cell { ch: '╹', style: Style::fg(if app.running() { c().gold } else { c().accent }) });
    for col in x + 1..x + width {
        buf.set(col, edge_y, Cell { ch: '▀', style: Style::fg(c().surface) });
    }
    if app.current().is_some() {
        footer_line(app, buf, x, edge_y + 1, width, 0);
    }
    cursor
}

/// One visual row of the input: a chip draws as its label, the selection on the overlay colour.
fn input_row(editor: &Editor, buf: &mut Buffer, x: u16, y: u16, max: u16, row: crate::editor::Row, selection: Option<(usize, usize)>) {
    let mut col = x;
    let end = x + max;
    let mut one = [0u8; 4];
    for (i, ch) in editor.text()[row.start..row.end].char_indices() {
        let at = row.start + i;
        let mut style = theme::text().on(c().surface);
        if selection.is_some_and(|(s, e)| at >= s && at < e) {
            style = style.on(c().overlay);
        }
        col = match editor.chip(ch) {
            Some(chip) => buf.text(col, y, end.saturating_sub(col), &chip.label(), Style { fg: c().accent, ..style }.bold()),
            None => buf.text(col, y, end.saturating_sub(col), ch.encode_utf8(&mut one), style),
        };
    }
}

/// OpenCode `component/prompt/autocomplete.tsx`: the matches in a box over the prompt, the selected one raised.
fn completion(m: &Menu, buf: &mut Buffer, x: u16, prompt_y: u16, width: u16) {
    let n = m.entries.len() as u16;
    if prompt_y < n || n == 0 {
        return;
    }
    let top = prompt_y - n;
    let label_w = m.entries.iter().map(|e| e.label.chars().count()).max().unwrap_or(0).min(width as usize / 2) as u16;
    for (i, e) in m.entries.iter().enumerate() {
        let y = top + i as u16;
        let on = i == m.selected;
        let bg = if on { c().accent } else { c().overlay };
        buf.fill(x, y, width, 1, Style::default().on(bg));
        buf.text(x + 1, y, label_w, &e.label, Style::fg(if on { c().surface } else { c().text }).on(bg));
        if !e.detail.is_empty() {
            buf.text(x + label_w + 3, y, width.saturating_sub(label_w + 4), first_line(&e.detail), Style::fg(if on { c().surface } else { c().muted }).on(bg));
        }
    }
}

/// A centred dialog over everything, as OpenCode's `DialogLayout`: a title, the body, the keys it takes.
fn dialog(app: &App, buf: &mut Buffer) {
    let Some(d) = &app.dialog else { return };
    let (w, h) = (buf.width, buf.height);
    let dw = w.saturating_sub(4).min(if matches!(d, Dialog::Aside { .. } | Dialog::Help { .. }) { 100 } else { 72 });
    let inner = dw.saturating_sub(4) as usize;
    let room = h.saturating_sub(6) as usize;
    let k = |id: &str| app.keymap.first(id);
    let close = format!("{} close", k("dialog.close"));
    let mut scrolled = None;
    let (title, lines, selected, keys): (String, Vec<(String, Style)>, Option<usize>, String) = match d {
        Dialog::Queue { selected } => (
            "Queued prompts".into(),
            app.queue.iter().map(|q| (first_line(q).to_string(), theme::text())).collect(),
            Some(*selected),
            format!("{} steer · {} edit · {} delete · {close}", k("dialog.select.submit"), k("queued_prompt.undo"), k("queued_prompt.delete")),
        ),
        Dialog::Stash { selected } => (
            "Stashed prompts".into(),
            app.stash.entries.iter().rev().map(|e| (first_line(&e.text).to_string(), theme::text())).collect(),
            Some(*selected),
            format!("{} restore · {} delete · {close}", k("dialog.select.submit"), k("stash.delete")),
        ),
        Dialog::Palette { query, selected } => {
            let rows = app
                .palette(query)
                .into_iter()
                .map(|d| {
                    let source = app.keymap.source(d.id);
                    let right = if source == "default" { app.keymap.keys(d.id) } else { format!("{} · {}", app.keymap.keys(d.id), layer_name(source)) };
                    (columns(&app.title(d), &right, inner), theme::text())
                })
                .collect();
            let title = if query.is_empty() { "Commands  type to search".to_string() } else { format!("Commands  {query}") };
            (title, rows, Some(*selected), format!("{} run · {close}", k("dialog.select.submit")))
        }
        Dialog::Help { scroll } => {
            let mut rows = vec![
                (format!("Press {} to see all available actions and commands in any context.", k("command.palette.show")), theme::muted()),
                (columns("Leader", &format!("{} · {}", app.keymap.leader_label(), layer_name(app.keymap.source("leader"))), inner), theme::text()),
            ];
            for g in keymap::GROUPS {
                rows.push((g.to_string(), theme::text().bold()));
                for d in keymap::DEFS.iter().filter(|d| d.group == g) {
                    let keys = app.keymap.keys(d.id);
                    let keys = if keys.is_empty() { "none".to_string() } else { keys };
                    rows.push((columns(d.title, &format!("{keys} · {}", layer_name(app.keymap.source(d.id))), inner), theme::text()));
                }
            }
            scrolled = Some(*scroll);
            ("Help".into(), rows, None, format!("↑↓ scroll · {close}"))
        }
        Dialog::Images { index } => {
            let images = app.editor.images();
            let path = match images.get(*index) {
                Some(Chip::Image { path, .. }) => path.clone(),
                _ => String::new(),
            };
            let keys = if images.len() > 1 { format!("← previous · next → · {close}") } else { close.clone() };
            (format!("Image {} of {}", index + 1, images.len()), vec![(path, theme::text())], None, keys)
        }
        Dialog::List { list, query, selected } => {
            let (mut lines, at) = select_lines(&app.list_rows(list, query), *selected, inner);
            let (name, empty, extra) = match list {
                List::Models => ("Select model", "No models: open a session first, or connect a provider", format!(" · {} favorite · {} providers", k("model.dialog.favorite"), k("model.dialog.provider"))),
                List::Efforts => ("Select thinking effort", "This model has no effort levels, or no session is open", String::new()),
                List::Agents => ("Select specialist", "No specialists: open a session first", String::new()),
                List::Themes { .. } => ("Themes", "", String::new()),
                List::Providers => ("Connect a provider", "No providers: open a session first", String::new()),
            };
            if lines.is_empty() {
                lines.push((empty.to_string(), theme::muted()));
            }
            let title = if query.is_empty() { format!("{name}  type to search") } else { format!("{name}  {query}") };
            (title, lines, at, format!("{} select{extra} · {close}", k("dialog.select.submit")))
        }
        Dialog::Info { info } => {
            let row = |a: &str, b: String| (columns(a, &b, inner), theme::text());
            let unknown = || "unknown".to_string();
            let usage = app.current().and_then(|s| s.usage.clone()).unwrap_or_default();
            let usd = |v: Option<f64>| v.map_or_else(unknown, |v| format!("${v:.2}"));
            let no_mcp = vec![
                ("No MCP servers".to_string(), theme::text()),
                ("A Lykos session connects to none; Lykos is one itself (lykos mcp).".to_string(), theme::muted()),
            ];
            match info {
                Info::Status => {
                    let link = match &app.link {
                        Link::Ready => "connected".to_string(),
                        Link::Connecting => "connecting".to_string(),
                        Link::Lost(m) | Link::Failed(m) => m.clone(),
                    };
                    let mut rows = vec![
                        row("Engine server", link),
                        row("Session", app.current().map_or_else(|| "none".into(), |s| format!("{:?}", s.summary.status).to_lowercase())),
                        row("Model", app.model_now().unwrap_or_else(unknown)),
                        row("Effort", app.effort_now().unwrap_or_else(|| "none".into())),
                        row("Specialist", app.options.as_ref().map_or_else(unknown, |o| o.specialist.clone())),
                        row("Theme", theme::c().name.to_string()),
                    ];
                    rows.extend(no_mcp);
                    ("Status".into(), rows, None, close.clone())
                }
                Info::Mcp => ("MCP servers".into(), no_mcp, None, close.clone()),
                Info::Usage => (
                    "Usage".into(),
                    vec![
                        row("This session", usd(usage.run_usd)),
                        row("Today", usd(usage.today_usd)),
                        row("Calls", usage.calls.to_string()),
                        row("Cache hit", usage.cache_hit_ratio.map_or_else(unknown, |r| format!("{}%", (r * 100.0).round()))),
                        row("Context", context_label(app).unwrap_or_else(unknown)),
                    ],
                    None,
                    close.clone(),
                ),
                Info::Debug => (
                    "Debug  share this when reporting an issue".into(),
                    app.debug_rows().into_iter().map(|(a, b)| row(a, b)).collect(),
                    None,
                    format!("{} copy · {close}", k("debug.copy")),
                ),
            }
        }
        Dialog::Sessions { query, selected, all, confirm } => {
            let (mut lines, at) = select_lines(&app.session_rows(query, confirm.as_deref()), *selected, inner);
            if lines.is_empty() {
                lines.push((if app.past.is_none() { "Loading sessions…" } else { "No sessions" }.to_string(), theme::muted()));
            }
            let name = if *all { "Sessions  every project" } else { "Sessions" };
            let title = if query.is_empty() { format!("{name}  Search sessions") } else { format!("{name}  {query}") };
            let keys = format!(
                "{} open · {} delete · {} rename · {} pin · {} {} · {close}",
                k("dialog.select.submit"),
                k("session.delete"),
                k("session.list.rename"),
                k("session.pin.toggle"),
                k("session.list.all"),
                if *all { "this project" } else { "all projects" }
            );
            (title, lines, at, keys)
        }
        Dialog::Timeline { query, selected } => {
            let (lines, at) = select_lines(&app.timeline_rows(query), *selected, inner);
            let title = if query.is_empty() { "Timeline  Search timeline".to_string() } else { format!("Timeline  {query}") };
            (title, lines, at, format!("{} jump · {close}", k("dialog.select.submit")))
        }
        Dialog::Worktrees { selected, .. } => {
            let (mut lines, at) = select_lines(&app.worktree_rows(), *selected, inner);
            if lines.is_empty() {
                lines.push((if app.worktrees.is_none() { "Loading worktrees…" } else { "No worktrees available" }.to_string(), theme::muted()));
            }
            let keys = format!(
                "{} move · {} new · {} delete · {} refresh · {close}",
                k("dialog.select.submit"),
                k("dialog.move_session.new"),
                k("dialog.move_session.delete"),
                k("dialog.move_session.refresh")
            );
            ("Worktrees".into(), lines, at, keys)
        }
        Dialog::Input { title, text, .. } => (title.clone(), vec![(format!("{text}▏"), theme::text())], None, format!("{} confirm · {close}", k("dialog.select.submit"))),
        Dialog::Aside { question, answer, scroll } => {
            let (text, style) = match answer {
                Ok(a) => (a.as_str(), theme::text()),
                Err(e) => (e.as_str(), Style::fg(c().love)),
            };
            let all = wrap(text, inner.max(1));
            let start = (*scroll).min(all.len().saturating_sub(room));
            let shown = all.into_iter().skip(start).take(room).map(|l| (l, style)).collect();
            (format!("/btw {}", first_line(question)), shown, None, format!("{} copy · ↑↓ scroll · {close}", k("aside.copy")))
        }
    };
    // A list longer than the dialog scrolls with its selection.
    let skip = scrolled.map_or_else(|| selected.map_or(0, |s| (s + 1).saturating_sub(room)), |s| s.min(lines.len().saturating_sub(room)));
    let body = (lines.len().min(room) as u16).max(1);
    let dh = body + 4;
    let (x, y) = ((w - dw) / 2, h.saturating_sub(dh) / 2);
    buf.fill(x, y, dw, dh, Style::default().on(c().surface));
    buf.text(x + 2, y + 1, dw.saturating_sub(4), &title, theme::text().on(c().surface).bold());
    for (i, (line, style)) in lines.iter().enumerate().skip(skip).take(body as usize) {
        let ly = y + 2 + (i - skip) as u16;
        if selected == Some(i) {
            buf.fill(x + 1, ly, dw.saturating_sub(2), 1, Style::default().on(c().accent));
            buf.text(x + 2, ly, inner as u16, line, Style::fg(c().surface).on(c().accent));
        } else {
            buf.text(x + 2, ly, inner as u16, line, style.on(c().surface));
        }
    }
    buf.text(x + 2, y + dh - 1, dw.saturating_sub(4), &keys, theme::muted().on(c().surface));
}

/// A select dialog's rows (`dialog-select.tsx`): each category headed (a search shows none), the row in use
/// marked, a favorite or pinned one starred. Returns the lines and the selected row's line.
fn select_lines(rows: &[ListRow], selected: usize, inner: usize) -> (Vec<(String, Style)>, Option<usize>) {
    let mut lines = Vec::new();
    let mut at = None;
    let mut group = "";
    for (i, r) in rows.iter().enumerate() {
        if !r.group.is_empty() && r.group != group {
            lines.push((r.group.clone(), theme::text().bold()));
        }
        group = &r.group;
        if i == selected {
            at = Some(lines.len());
        }
        let mark = if r.current { "● " } else { "  " };
        let right = if r.favorite { format!("{} *", r.detail) } else { r.detail.clone() };
        lines.push((columns(&format!("{mark}{}", r.title), &right, inner), theme::text()));
    }
    (lines, at)
}

/// `left`, then `right` against the right edge of `width` columns; `left` is cut short to make room.
fn columns(left: &str, right: &str, width: usize) -> String {
    let rw = right.width();
    let lw = width.saturating_sub(rw + 2);
    let mut out = String::new();
    let mut used = 0;
    for ch in left.chars() {
        let cw = ch.width().unwrap_or(0);
        if used + cw > lw {
            break;
        }
        out.push(ch);
        used += cw;
    }
    out.push_str(&" ".repeat(width.saturating_sub(used + rw)));
    out.push_str(right);
    out
}

/// A layer's name without its file, as a row has room for: `project`, `global`.
fn layer_name(source: &str) -> &str {
    source.split(" (").next().unwrap_or(source)
}

/// `component/prompt/metadata.tsx`: model, then ` · ` and the thinking effort in bold warning colour.
fn metadata(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16) {
    let usage = app.current().and_then(|s| s.usage.as_ref());
    let model = usage.and_then(|u| u.model.clone()).or_else(|| app.current().map(|s| s.summary.model.clone())).filter(|m| !m.is_empty());
    let Some(model) = model else {
        buf.text(x, y, width, "lykos", theme::muted().on(c().surface));
        return;
    };
    let mut col = buf.text(x, y, width, &model, theme::text().on(c().surface));
    if let Some(effort) = usage.and_then(|u| u.effort.as_deref()).filter(|e| !e.is_empty()) {
        col = buf.text(col, y, (x + width).saturating_sub(col), " · ", theme::muted().on(c().surface));
        buf.text(col, y, (x + width).saturating_sub(col), effort, Style::fg(c().gold).on(c().surface).bold());
    }
}

/// The row under the prompt box: the spinner and `esc interrupt` while running, else the directory; on the right,
/// the context window's use.
pub(crate) fn footer_line(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16, pad: u16) {
    let x = x + pad;
    let width = width.saturating_sub(2 * pad);
    let right = context_label(app);
    let rw = right.as_ref().map_or(0, |r| r.chars().count() as u16);
    let left_w = width.saturating_sub(rw + 2);
    match &app.link {
        Link::Connecting => {
            let s = format!("{} connecting to the engine server", spinner(app));
            buf.text(x + 1, y, left_w, &s, theme::muted());
        }
        Link::Failed(m) | Link::Lost(m) => {
            buf.text(x + 1, y, left_w, m, Style::fg(c().love));
        }
        Link::Ready if app.running() => {
            let mut col = buf.text(x + 1, y, left_w, &spinner(app).to_string(), Style::fg(c().accent));
            col = buf.text(col + 1, y, left_w, "esc", if app.armed.is_some() { Style::fg(c().gold) } else { theme::text() });
            let rest = if app.armed.is_some() { " again to interrupt" } else { " interrupt" };
            buf.text(col, y, left_w, rest, if app.armed.is_some() { Style::fg(c().gold) } else { theme::muted() });
        }
        Link::Ready => {
            let (text, style) = if app.leader.is_some() {
                ("ctrl+x  enter queue · e editor · i images · q queued".to_string(), Style::fg(c().gold))
            } else if app.search.is_some() {
                ("history search · ctrl+r older · enter send · any key keeps it".to_string(), Style::fg(c().gold))
            } else if let Some(n) = &app.notice {
                (n.clone(), Style::fg(c().love))
            } else {
                (app.cwd.clone(), theme::muted())
            };
            buf.text(x + 1, y, left_w, &text, style);
        }
    }
    // btw.tsx's footer slot: `/btw` and a spinner while an aside waits.
    if app.asides > 0 && app.link == Link::Ready {
        let label = format!("{} /btw", spinner(app));
        let lw = label.chars().count() as u16;
        if lw + rw + 4 <= width {
            buf.text(x + width - rw - lw - 3, y, lw, &label, Style::fg(c().accent));
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

    fn with_request(app: &mut App, kind: &str, title: &str, detail: &str, patch: Option<&str>, options: &[(&str, &str, Option<&str>)]) {
        let options = options.iter().map(|(v, l, n)| lykos_client::RequestOption { value: (*v).into(), label: (*l).into(), note: n.map(Into::into) }).collect();
        let request = lykos_client::RequestData { request_id: "r1".into(), kind: kind.into(), title: title.into(), detail: detail.into(), body: None, patch: patch.map(Into::into), options, assumption: Some("go on".into()) };
        app.on_event(&Event { event: "x".into(), session: "s1".into(), seq: 6, data: EventData::Request { request } });
    }

    #[test]
    fn an_edit_approval_shows_its_diff_options_and_hints() {
        let mut app = app_with_session();
        let patch = "--- C:/work/a.rs
+++ C:/work/a.rs
@@ -1,2 +1,2 @@
 fn a() {}
-old
+new
";
        with_request(&mut app, "approval", "edit: C:/work/a.rs", "C:/work/a.rs", Some(patch), &[("y", "Allow once", None), ("a", "Always allow edit this session", Some("This will allow every edit for the rest of this session.")), ("n", "Deny", None)]);
        let mut buf = Buffer::new(100, 30);
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("△ Permission required"), "{s}");
        assert!(s.contains("← Edit a.rs"), "the path relative to the workspace: {s}");
        assert!(s.contains("-old") || s.contains("- old") || s.contains("old"), "{s}");
        assert!(s.contains("new"), "{s}");
        assert!(s.contains(" Allow once ") && s.contains(" Deny "), "{s}");
        assert!(s.contains("ctrl+f fullscreen") && s.contains("enter confirm"), "{s}");
        app.on_key(crossterm::event::KeyEvent::from(crossterm::event::KeyCode::Right), std::time::Instant::now(), 10);
        let mut buf = Buffer::new(100, 30);
        draw(&app, &mut buf);
        assert!(screen(&buf).contains("This will allow every edit for the rest of this session."), "a picked decision's note replaces the diff");
        app.on_key(crossterm::event::KeyEvent::new(crossterm::event::KeyCode::Char('f'), crossterm::event::KeyModifiers::CONTROL), std::time::Instant::now(), 10);
        let mut buf = Buffer::new(100, 30);
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert_eq!(s.lines().next().map(|l| l.contains("┃")), Some(true), "full screen starts on the top row: {s}");
        assert!(s.contains("ctrl+f minimize"), "{s}");
    }

    #[test]
    fn a_question_lists_its_options_the_custom_row_and_the_assumption() {
        let mut app = app_with_session();
        with_request(&mut app, "question", "Which one?", "", None, &[("1", "Red", None), ("2", "Blue", None)]);
        let mut buf = Buffer::new(80, 30);
        draw(&app, &mut buf);
        let s = screen(&buf);
        for want in ["Which one?", "1. Red", "2. Blue", "3. Type your own answer", "If nobody answers: go on", "↑↓ select", "enter submit", "esc dismiss"] {
            assert!(s.contains(want), "{want}: {s}");
        }
    }

    #[test]
    fn the_model_list_marks_the_model_in_use_and_a_light_theme_paints_the_background() {
        let mut app = App::new("C:/work".into());
        app.connected();
        app.options = Some(
            serde_json::from_value(serde_json::json!({
                "model": "p/a", "effort": null, "efforts": [], "specialist": "build", "specialists": [], "providers": [],
                "models": [{ "provider": "p", "id": "a", "name": "Alpha", "contextWindow": 200000, "reasoning": true }]
            }))
            .unwrap(),
        );
        app.dialog = Some(Dialog::List { list: List::Models, query: String::new(), selected: 0 });
        let mut buf = Buffer::new(100, 30);
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("Select model") && s.contains("● Alpha") && s.contains("p · 200K · Reasoning"), "{s}");
        assert_eq!(buf.get(0, 29).style.bg, lykos_term::Color::Reset, "a dark theme leaves the terminal's background");
        theme::set("rose-pine-dawn");
        draw(&app, &mut buf);
        assert_eq!(buf.get(0, 29).style.bg, c().base.unwrap(), "a light one paints it");
        theme::set("sky");
    }

    #[test]
    fn the_palette_and_the_help_show_each_actions_keys_and_where_they_were_set() {
        let mut app = App::new("C:/work".into());
        app.connected();
        app.on_keybinds(Ok(serde_json::json!({ "keybinds": { "input.undo": { "value": "alt+u", "source": "project (C:/w/.lykos/config.yaml)" } } })));
        app.dialog = Some(Dialog::Palette { query: "undo".into(), selected: 0 });
        let mut buf = Buffer::new(100, 30);
        assert_eq!(draw(&app, &mut buf), None, "no prompt cursor under a dialog");
        let s = screen(&buf);
        assert!(s.contains("Commands  undo") && s.contains("Undo in input") && s.contains("alt+u · project"), "{s}");
        app.dialog = Some(Dialog::Help { scroll: 0 });
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("Press ctrl+p to see all available actions"), "{s}");
        assert!(s.contains("Leader") && s.contains("ctrl+x · default"), "{s}");
        app.dialog = Some(Dialog::Help { scroll: 105 });
        draw(&app, &mut buf);
        assert!(screen(&buf).contains("Undo in input"), "scrolled to the input actions");
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
        let mut app = app_with_session();
        let mut buf = Buffer::new(100, 30);
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("Running read…"), "low verbosity folds the tool into its activity
{s}");
        app.prefs.verbosity = crate::transcript::Verbosity::High;
        draw(&app, &mut buf);
        let s = screen(&buf);
        for want in ["Fix it", "On it.", "read src/main.rs", "claude-opus · high", "12,345 tokens · 6% used", "esc interrupt"] {
            assert!(s.contains(want), "missing {want:?} in\n{s}");
        }
    }

    #[test]
    fn typed_text_and_the_cursor_land_in_the_box() {
        let mut app = app_with_session();
        app.editor.insert_str("hello");
        let mut buf = Buffer::new(60, 20);
        let (cx, cy) = draw(&app, &mut buf).unwrap();
        assert!(screen(&buf).contains("hello"));
        assert_eq!(buf.get(cx - 1, cy).ch, 'o');
    }

    #[test]
    fn a_tiny_terminal_draws_without_panicking() {
        let mut busy = app_with_session();
        busy.editor.insert_str(&"long words in the prompt ".repeat(20));
        for app in [&app_with_session(), &busy, &App::new("C:/work".into())] {
            for w in 1..60 {
                for h in 1..20 {
                    let mut buf = Buffer::new(w, h);
                    draw(app, &mut buf);
                }
            }
        }
    }

    /// #38's 1 MB paste, in-process: each keystroke's handling, paint, diff and write, with the paste as a chip and
    /// then expanded into the buffer. A measurement, not a check: it prints.
    #[test]
    #[ignore = "a measurement: cargo test --release -p lykos-tui -- --ignored --nocapture one_megabyte"]
    fn one_megabyte_paste_then_typing() {
        use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        use std::time::Instant;
        let line = "0123456789 the quick brown fox jumps over the lazy dog 0123456789
";
        let big = line.repeat((1 << 20) / line.len() + 1)[..1 << 20].to_string();
        let mut app = App::new("C:/work".into());
        app.connected();
        let mut term = lykos_term::Terminal::new(Vec::<u8>::new(), 120, 40);
        let mut frame = |app: &App| {
            term.draw(|b| draw(app, b)).unwrap();
            term.writer().clear();
        };
        let report = |name: &str, mut t: Vec<u128>| {
            t.sort();
            println!("{name}: p50 {} us, p95 {} us, max {} us (n={})", t[t.len() / 2], t[t.len() * 95 / 100], t[t.len() - 1], t.len());
        };
        let keys = [KeyCode::Char('a'), KeyCode::Char('b'), KeyCode::Left, KeyCode::Backspace, KeyCode::Up, KeyCode::Down, KeyCode::Right];
        let run = |app: &mut App, frame: &mut dyn FnMut(&App)| {
            let mut out = Vec::new();
            for i in 0..210 {
                let t = Instant::now();
                app.input_cols = input_cols(app, 120);
                app.on_key(KeyEvent::new(keys[i % keys.len()], KeyModifiers::NONE), Instant::now(), 10);
                frame(app);
                out.push(t.elapsed().as_micros());
            }
            out
        };
        let t = Instant::now();
        app.on_paste(&big);
        frame(&app);
        println!("paste to chip on screen: {} us", t.elapsed().as_micros());
        let chip = run(&mut app, &mut frame);
        report("keystroke with the chip", chip);
        app.editor.set("");
        app.on_paste(&big);
        let t = Instant::now();
        app.on_paste(&big);
        frame(&app);
        assert!(app.editor.text().len() > 1 << 19, "expanded");
        println!("expanding it: {} us", t.elapsed().as_micros());
        let text = run(&mut app, &mut frame);
        report("keystroke with 1 MB of text", text);
    }

    #[test]
    fn groups_thousands() {
        assert_eq!(group(0), "0");
        assert_eq!(group(1234567), "1,234,567");
    }
}
