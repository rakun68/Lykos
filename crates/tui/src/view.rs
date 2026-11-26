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
use unicode_width::UnicodeWidthStr;


/// One transcript row: where it starts, its text, its style, and an optional bar in the first column.
/// Draws the frame and returns where the cursor goes.
pub fn draw(app: &App, buf: &mut Buffer) -> Option<(u16, u16)> {
    let cursor = draw_screen(app, buf);
    toasts(app, buf);
    theme::paint_base(buf);
    cursor
}

/// The widest a toast grows; a longer message wraps.
const TOAST_WIDTH: u16 = 48;

/// #58 item 5: short messages at the top right, over dialogs too, newest last, each wrapped to `TOAST_WIDTH`; each
/// goes after `TOAST_TIME`.
fn toasts(app: &App, buf: &mut Buffer) {
    use crate::app::ToastKind;
    let p = pad(buf.width);
    let room = buf.width.saturating_sub(2 * p).min(TOAST_WIDTH);
    let mut y = 1;
    for t in &app.toasts {
        if y >= buf.height || room < 8 {
            break;
        }
        let mark = match t.kind {
            ToastKind::Success => c().pine,
            ToastKind::Warning => c().gold,
            ToastKind::Error => c().love,
            ToastKind::Info => c().accent,
        };
        let lines = wrap(t.text.trim_end(), (room - 4) as usize);
        let tw = (lines.iter().map(|l| l.width()).max().unwrap_or(0) as u16 + 4).min(room);
        let x = buf.width - p - tw;
        let bg = Style::default().on(c().overlay);
        for l in &lines {
            if y >= buf.height {
                break;
            }
            buf.fill(x, y, tw, 1, bg);
            buf.set(x, y, Cell { ch: '┃', style: Style::fg(mark).on(c().overlay) });
            buf.text(x + 2, y, tw.saturating_sub(3), l, theme::text().on(c().overlay));
            y += 1;
        }
    }
}

/// From the start until the engine server's settings arrive, in place of the TUI: the logo, what it waits for, and
/// a bar of the steps done.
fn loading(app: &App, buf: &mut Buffer) {
    use crate::app::Link;
    let (w, h) = (buf.width, buf.height);
    let logo: [&str; 3] = ["█   █ █ █ █ ███ ███", "█    █  ██  █ █ █▄▄", "███  █  █ █ ███ ▄▄█"];
    let top = h.saturating_sub(8) / 2;
    for (i, l) in logo.iter().enumerate() {
        let lw = l.chars().count() as u16;
        buf.text(w.saturating_sub(lw) / 2, top + i as u16, lw, l, Style::fg(c().accent));
    }
    let (done, step, style) = match &app.link {
        Link::Connecting => (1, "Starting the engine server…".to_string(), theme::muted()),
        Link::Ready => (2, "Loading settings…".to_string(), theme::muted()),
        Link::Lost(m) | Link::Failed(m) => (1, m.clone(), Style::fg(c().love)),
    };
    let cells: String = (0..12).map(|i| if i < done * 4 { '▰' } else { '▱' }).collect();
    let centre = |s: &str| w.saturating_sub(s.width() as u16) / 2;
    buf.text(centre(&cells), top + 5, w, &cells, Style::fg(c().accent));
    let step: String = step.chars().take(w as usize).collect();
    buf.text(centre(&step), top + 7, w, &step, style);
}

fn draw_screen(app: &App, buf: &mut Buffer) -> Option<(u16, u16)> {
    let (w, h) = (buf.width, buf.height);
    app.tab_hits.borrow_mut().clear();
    *app.hits.borrow_mut() = crate::mouse::Hits::default();
    if w < 10 || h < 6 {
        buf.text(0, 0, w, "lykos", theme::text());
        return None;
    }
    if app.loading {
        loading(app, buf);
        return None;
    }
    let pad = pad(w);
    app.side.width.set(w);
    let docked = crate::diffview::dock_width(app, w).is_some();
    let sw = crate::diffview::session_width(app, w);
    // A request waiting takes the keys, so a full-screen viewer steps aside for it. A terminal pane on a narrow
    // screen covers the session too (P5 #48).
    let full = (app.diff.is_some() && !docked && app.request().is_none()) || sw == 0;
    let cursor = if full {
        None
    } else if sw < w {
        // Beside the docked viewer or the sidebar, the session draws at the width it leaves.
        let mut left = Buffer::new(sw, h);
        let cursor = match app.current() {
            None => home(app, &mut left, crate::view::pad(sw)),
            Some(session) => session_screen(app, session, &mut left, crate::view::pad(sw)),
        };
        for y in 0..h {
            for x in 0..sw {
                buf.set(x, y, *left.get(x, y));
            }
        }
        // The terminal scrolls whole rows: what then differs on the right is written again, so the hint holds.
        buf.scroll = left.scroll;
        // The viewer has the keys; a request's typed answer keeps its cursor.
        cursor.filter(|_| !docked || app.request().is_some())
    } else {
        match app.current() {
            None => home(app, buf, pad),
            Some(session) => session_screen(app, session, buf, pad),
        }
    };
    if app.diff.is_some() && (docked || full) {
        crate::diffview::draw(app, buf);
    } else {
        crate::sidebar::draw(app, buf);
    }
    let pane = crate::terminal::draw(app, buf);
    crate::request::draw_expanded(app, buf);
    if app.dialog.is_some() {
        dialog(app, buf);
        return None;
    }
    if app.terms.focused && app.terminal_shown() {
        return pane;
    }
    cursor
}

/// The input's width at this screen width: what up and down move through.
pub fn input_cols(app: &App, w: u16) -> usize {
    let w = crate::diffview::session_width(app, w);
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
        // OpenCode: a new session's first prompt shows at once, as sent; the footer's spinner says it is starting.
        if session.summary.status == SessionStatus::Starting {
            if app.queue.is_empty() {
                let accent = Style::fg(c().accent);
                let mut spans = vec![transcript_span(format!("{} ", spinner(app)), accent)];
                spans.extend(transcript::shimmer("Starting the session...", app.tick, accent, c().text, app.prefs.animations));
                tail.rows.push(Row::rich(3, spans));
            }
            for q in &app.queue {
                transcript::prompt_rows(q, text_w as usize, true, &mut tail.rows);
            }
        } else {
            for q in &app.queue {
                tail.rows.push(Row::plain(3, format!("queued: {}", first_line(q)), theme::muted()));
            }
        }
        // `BackgroundToolHint` (P5 #48): a shell call has held the turn for 3 s.
        // It goes with the call: a tick may not come once nothing runs.
        if app.bg_hint && !session.foreground.is_empty() {
            let key = app.keymap.first("session.background");
            if !key.is_empty() {
                tail.rows.push(Row::plain(3, String::new(), theme::muted()));
                tail.rows.push(Row::plain(3, format!("Press {key} to move running work to the background"), theme::muted()));
            }
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
            paint_link_row(buf, x, y, text_w, row, app.hover.as_deref());
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
    paint_link_row(buf, x, y, width, row, None);
}

/// `paint_row`, with the link under the mouse shown reversed, every row of it.
fn paint_link_row(buf: &mut Buffer, x: u16, y: u16, width: u16, row: &Row, hover: Option<&str>) {
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
    if row.spans.is_empty() {
        buf.text(x + row.indent, y, width.saturating_sub(row.indent), &row.text, style);
        return;
    }
    let end = x + width;
    let mut col = x + row.indent;
    for span in &row.spans {
        let style = match (span.style.bg, row.bg) {
            (lykos_term::Color::Reset, Some(bg)) => Style { bg: bg.bg, ..span.style },
            _ => span.style,
        };
        let style = match (hover, span.link.as_deref()) {
            (Some(h), Some(l)) if h == l => Style { attr: style.attr.with(Attr::REVERSE), ..style },
            _ => style,
        };
        col = buf.text(col, y, end.saturating_sub(col), &span.text, style);
    }
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
    let menu = app.menu.as_ref().map_or(0, Menu::height) as u16;
    live.min(LIVE_ROWS) as u16 + menu + prompt_height(app, w.saturating_sub(2 * pad(w)), screen_h)
}

/// Mini mode's footer: the rows still changing, then the prompt box and its footer line, on the terminal's own
/// background.
pub fn draw_mini(app: &App, buf: &mut Buffer, live: &[Row], screen_h: u16) -> Option<(u16, u16)> {
    app.frame.set(None);
    if app.dialog.is_some() {
        dialog(app, buf);
        toasts(app, buf);
        return None;
    }
    let w = buf.width;
    let (pad, inner) = (pad(w), w.saturating_sub(2 * pad(w)));
    let live = &live[live.len().saturating_sub(LIVE_ROWS)..];
    for (i, row) in live.iter().enumerate() {
        paint_row(buf, pad, i as u16, inner, row);
    }
    let menu = app.menu.as_ref().map_or(0, Menu::height) as u16;
    let y = live.len() as u16 + menu;
    let cursor = prompt_box(app, buf, pad, y, inner, screen_h);
    if app.current().is_none() {
        footer_line(app, buf, pad, y + prompt_height(app, inner, screen_h) - 1, inner, 0);
    }
    toasts(app, buf);
    cursor
}

/// The box's top edge: the session's title, or with more than one tab open, every tab's (OpenCode
/// `component/session-tabs.tsx`): the one shown bold, an unread one marked.
/// A watched MCP or `lykos run` session's title carries its owner (P5 #51).
fn tab_strip(app: &App, session: &Session, buf: &mut Buffer, x: u16, width: u16) {
    let titled = |s: &Session| {
        let title = first_line(s.summary.title.as_deref().unwrap_or("New session")).to_string();
        match crate::app::owner_label(&s.summary.origin) {
            Some(owner) => format!("{owner} · {title}"),
            None => title,
        }
    };
    let title_of = |id: &str| app.store.sessions.get(id).map(titled).unwrap_or_else(|| "New session".into());
    if app.tabs.open.len() < 2 {
        buf.text(x, 0, width, &format!(" {} ", titled(session)), theme::subtle().bold());
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
        app.tab_hits.borrow_mut().push((at, (at + lw).min(end), id.clone()));
        at += lw;
    }
}

fn transcript_span(text: String, style: Style) -> crate::markdown::Span {
    crate::markdown::Span { text, style, link: None }
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
    // The composer takes the prompt box's place, above the footer (P5 #48).
    if app.composer.is_some() {
        return crate::composer::height(app) + u16::from(app.current().is_some());
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
    if app.composer.is_some() {
        app.input_area.set(None);
        crate::composer::draw(app, buf, x, y, width);
        if app.current().is_some() {
            footer_line(app, buf, x, y + crate::composer::height(app), width, 0);
        }
        return None;
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
        completion(app, m, buf, x, y, width);
    }
    let meta_y = y + body;
    buf.fill(x, meta_y, width, 1, raised);
    buf.set(x, meta_y, Cell { ch: '┃', style: bar });
    metadata(app, buf, tx, meta_y, width.saturating_sub(4));
    // The bottom edge: `▀` in the box colour, so the box ends on a half cell, its corner included.
    let edge_y = meta_y + 1;
    for col in x..x + width {
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
            style = style.on(c().selection);
        }
        col = match editor.chip(ch) {
            Some(chip) => buf.text(col, y, end.saturating_sub(col), &chip.label(), Style { fg: c().accent, ..style }.bold()),
            None => buf.text(col, y, end.saturating_sub(col), ch.encode_utf8(&mut one), style),
        };
    }
}

/// OpenCode `component/prompt/autocomplete.tsx`: the matches in a box over the prompt, the selected one raised; a
/// longer list scrolls in a window of `menu::LIMIT` with a count row under it.
fn completion(app: &App, m: &Menu, buf: &mut Buffer, x: u16, prompt_y: u16, width: u16) {
    let n = m.entries.len();
    let h = m.height() as u16;
    if prompt_y < h || n == 0 {
        return;
    }
    let top = prompt_y - h;
    let first = m.first();
    let shown = &m.entries[first..(first + crate::menu::LIMIT).min(n)];
    {
        let mut hits = app.hits.borrow_mut();
        hits.menu = Some((x, top, width, h));
        hits.menu_rows = (0..shown.len()).map(|i| (top + i as u16, first + i)).collect();
    }
    let label_w = shown.iter().map(|e| e.label.chars().count()).max().unwrap_or(0).min(width as usize / 2) as u16;
    for (i, e) in shown.iter().enumerate() {
        let y = top + i as u16;
        let on = first + i == m.selected;
        let bg = if on { c().accent } else { c().overlay };
        buf.fill(x, y, width, 1, Style::default().on(bg));
        buf.text(x + 1, y, label_w, &e.label, Style::fg(if on { c().surface } else { c().text }).on(bg));
        if !e.detail.is_empty() {
            buf.text(x + label_w + 3, y, width.saturating_sub(label_w + 4), first_line(&e.detail), Style::fg(if on { c().surface } else { c().muted }).on(bg));
        }
    }
    if n > shown.len() {
        let y = top + shown.len() as u16;
        let below = n - first - shown.len();
        let count = format!("↑ {first}  ↓ {below}");
        buf.fill(x, y, width, 1, Style::default().on(c().overlay));
        buf.text(x + 1, y, width.saturating_sub(2), &count, theme::muted().on(c().overlay));
    }
}

/// One dialog row: text on the left and, against the right edge, a key or a detail in a colour of its own.
struct Line {
    left: String,
    right: String,
    style: Style,
    right_style: Style,
    /// A group's heading: never selected.
    heading: bool,
    /// Pieces in their own colours, drawn in place of `left` and `right`.
    runs: Vec<(String, Style)>,
    /// A setting's value, drawn right after `left` in its own colour.
    value: Option<(String, Style)>,
    /// The second row of an item: selected with the row before it.
    with_prev: bool,
}

fn line(text: impl Into<String>, style: Style) -> Line {
    Line { left: text.into(), right: String::new(), style, right_style: style, heading: false, runs: Vec::new(), value: None, with_prev: false }
}

fn pair(left: impl Into<String>, right: impl Into<String>, style: Style, right_style: Style) -> Line {
    Line { left: left.into(), right: right.into(), style, right_style, heading: false, runs: Vec::new(), value: None, with_prev: false }
}

fn runs(runs: Vec<(String, Style)>) -> Line {
    Line { runs, ..line("", theme::text()) }
}

fn heading(text: &str) -> Line {
    Line { heading: true, ..line(text, Style::fg(c().accent).bold()) }
}

/// A key and, when a config layer set it, the layer.
fn keys_with_layer(keys: String, source: &str) -> String {
    if source == "default" {
        keys
    } else {
        format!("{keys} · {}", layer_name(source))
    }
}

/// A centred dialog over everything, as OpenCode's `DialogLayout`: the screen dimmed behind it, a title, a search
/// box where it takes a search, the body with a scroll bar when it is longer than the room, the keys it takes.
fn dialog(app: &App, buf: &mut Buffer) {
    let Some(d) = &app.dialog else { return };
    let (w, h) = (buf.width, buf.height);
    theme::dim(buf);
    let dw = w.saturating_sub(4).min(if matches!(d, Dialog::Aside { .. } | Dialog::Help { .. } | Dialog::Output { .. } | Dialog::Skills { .. }) { 100 } else { 72 });
    let inner = dw.saturating_sub(4) as usize;
    let searching = matches!(d, Dialog::Palette { .. } | Dialog::Skills { .. } | Dialog::List { .. } | Dialog::Sessions { .. } | Dialog::Timeline { .. } | Dialog::ModelPicker { .. });
    let search_h: u16 = if searching && h >= 14 { 3 } else { 0 };
    let room = h.saturating_sub(6 + search_h) as usize;
    let k = |id: &str| app.keymap.first(id);
    let close = format!("{} close", k("dialog.close"));
    let keyed = Style::fg(c().keybind);
    let mut scrolled = None;
    let mut search: Option<(&str, String)> = None;
    let (title, lines, selected, keys): (String, Vec<Line>, Option<usize>, String) = match d {
        Dialog::Queue { selected } => (
            "Queued prompts".into(),
            app.queue.iter().map(|q| line(first_line(q), theme::text())).collect(),
            Some(*selected),
            format!("{} steer · {} edit · {} delete · {close}", k("dialog.select.submit"), k("queued_prompt.undo"), k("queued_prompt.delete")),
        ),
        Dialog::Message { selected, .. } => (
            "Message actions".into(),
            crate::app::MESSAGE_ACTIONS.iter().map(|(t, d)| pair(*t, *d, theme::text(), theme::muted())).collect(),
            Some(*selected),
            format!("{} choose · {close}", k("dialog.select.submit")),
        ),
        Dialog::Stash { selected } => (
            "Stashed prompts".into(),
            app.stash.entries.iter().rev().map(|e| line(first_line(&e.text), theme::text())).collect(),
            Some(*selected),
            format!("{} restore · {} delete · {close}", k("dialog.select.submit"), k("stash.delete")),
        ),
        Dialog::Palette { query, selected } => {
            let rows = app.palette(query);
            let mut lines = Vec::new();
            let mut at = None;
            let mut group = "";
            for (i, r) in rows.iter().enumerate() {
                // Grouped while nothing is searched, a blank row between groups; a search ranks across them.
                if query.is_empty() && r.group != group {
                    if !lines.is_empty() {
                        lines.push(Line { heading: true, ..line("", theme::text()) });
                    }
                    lines.push(heading(r.group));
                    group = r.group;
                }
                if i == *selected {
                    at = Some(lines.len());
                }
                let mut l = pair(&r.title, keys_with_layer(r.keys.clone(), &r.source), theme::text(), keyed);
                if let Some(v) = &r.value {
                    l.left.push_str(": ");
                    l.value = Some((v.clone(), Style::fg(c().accent).bold()));
                }
                lines.push(l);
            }
            if lines.is_empty() {
                lines.push(line("No matching commands", theme::muted()));
            }
            search = Some(("Search commands", query.clone()));
            let on_setting = rows.get(*selected).is_some_and(|r| r.value.is_some());
            let run = if on_setting { "change · ←→ value" } else { "run" };
            ("Commands".into(), lines, at, format!("{} {run} · {close}", k("dialog.select.submit")))
        }
        Dialog::Skills { query, selected } => {
            // Two rows a skill: its name on the left, its description on the right over two rows, cut with an
            // ellipsis past them.
            let skills = app.skills(query);
            let nw = skills.iter().map(|s| s.name.width()).max().unwrap_or(0).min(inner / 3);
            let dw = inner.saturating_sub(nw + 3).max(8);
            let mut lines = Vec::new();
            let mut at = None;
            for (i, s) in skills.iter().enumerate() {
                if i == *selected {
                    at = Some(lines.len());
                }
                let text = s.description.split_whitespace().collect::<Vec<_>>().join(" ");
                let rows = wrap(&text, dw);
                let first = rows.first().cloned().unwrap_or_default();
                let second = match rows.len() {
                    0 | 1 => String::new(),
                    2 => rows[1].clone(),
                    _ => {
                        let mut s = ellipsis(&rows[1], dw - 1);
                        if !s.ends_with('…') {
                            s.push('…');
                        }
                        s
                    }
                };
                let name = ellipsis(&s.name, nw);
                let pad = nw - name.width() + 2;
                lines.push(runs(vec![(format!("{name}{}", " ".repeat(pad)), theme::text().bold()), (first, theme::muted())]));
                lines.push(Line { with_prev: true, ..runs(vec![(" ".repeat(nw + 2), theme::text()), (second, theme::muted())]) });
            }
            if lines.is_empty() {
                let empty = if app.skills_loading() {
                    "Loading skills…"
                } else if query.is_empty() {
                    "No skills in ~/.lykos/pi-host/skills, .lykos/skills, .pi/skills or .agents/skills"
                } else {
                    "No matching skills"
                };
                lines.push(line(empty, theme::muted()));
            }
            search = Some(("Search skills", query.clone()));
            ("Skills".into(), lines, at, format!("{} use · {close}", k("dialog.select.submit")))
        }
        Dialog::Accounts { provider, selected, confirm } => {
            let entry = app.providers.iter().flatten().find(|p| &p.name == provider);
            let mut lines = Vec::new();
            let mut at = None;
            match &app.accounts {
                None => lines.push(line("Loading accounts…", theme::muted())),
                Some(accounts) => {
                    for (i, a) in accounts.iter().enumerate() {
                        if i == *selected {
                            at = Some(lines.len());
                        }
                        let kind = if a.kind == "oauth" { "browser" } else { "API key" };
                        let right = if *confirm == Some(a.id) {
                            "d again to remove".to_string()
                        } else {
                            format!("{kind} · added {}", crate::app::utc_date((a.created_at / 1000.0) as i64))
                        };
                        let rs = if *confirm == Some(a.id) { Style::fg(c().love) } else { theme::muted() };
                        lines.push(pair(a.label.clone(), right, theme::text(), rs));
                    }
                    if accounts.is_empty() {
                        // Configured with no credential in the pool: an environment variable or a declared source.
                        let why = entry.map_or(String::new(), |p| p.reason.clone());
                        lines.push(Line { heading: true, ..line(format!("No stored credential: {why}"), theme::muted()) });
                    }
                    for (j, browser) in app.account_adds(provider).into_iter().enumerate() {
                        if *selected == accounts.len() + j {
                            at = Some(lines.len());
                        }
                        lines.push(line(if browser { "+ Sign in with a browser" } else { "+ Add an API key" }, Style::fg(c().accent)));
                    }
                }
            }
            (format!("{provider} accounts"), lines, at, format!("{} add · d remove · {} back", k("dialog.select.submit"), k("dialog.close")))
        }
        Dialog::ModelPicker { provider, query, selected, rename } => {
            // Two rows a model: a dot (shown or hidden) and its name, its effort on the right; its id under it.
            let models = app.picker_rows(provider, query);
            let mut lines = Vec::new();
            let mut at = None;
            let room_w = inner.saturating_sub(1);
            for (i, m) in models.iter().enumerate() {
                let pref = app.prefs.model(&format!("{provider}/{}", m.id));
                let on = i == *selected;
                if on {
                    at = Some(lines.len());
                }
                let (dot, dot_style) = if pref.is_some_and(|p| p.shown) { ("● ", Style::fg(c().accent)) } else { ("○ ", theme::subtle()) };
                let name = match (rename, on) {
                    (Some(t), true) => format!("{t}▏"),
                    _ => pref.filter(|p| !p.rename.is_empty()).map_or_else(|| m.name.clone(), |p| p.rename.clone()),
                };
                let effort = app.picker_effort(provider, m).map(|e| if on { format!("‹ {e} ›") } else { e }).unwrap_or_default();
                let name = ellipsis(&name, room_w.saturating_sub(effort.width() + 4));
                let pad = room_w.saturating_sub(2 + name.width() + effort.width());
                lines.push(runs(vec![(dot.into(), dot_style), (name, theme::text()), (" ".repeat(pad), theme::text()), (effort, Style::fg(c().accent))]));
                lines.push(Line { with_prev: true, ..runs(vec![("  ".into(), theme::text()), (ellipsis(&m.id, room_w.saturating_sub(2)), theme::muted())]) });
            }
            if lines.is_empty() {
                match &app.picker {
                    None => lines.push(line("Loading models…", theme::muted())),
                    Some(Err(e)) => lines.extend(wrap(e, inner.max(1)).into_iter().map(|l| line(l, Style::fg(c().love)))),
                    Some(Ok(_)) => lines.push(line(if query.is_empty() { "No models" } else { "No match" }, theme::muted())),
                }
            }
            search = Some(("Search models", query.clone()));
            let n = app.prefs.shown().filter(|(k, _)| k.strip_prefix(provider.as_str()).is_some_and(|r| r.starts_with('/'))).count();
            let keys = if rename.is_some() {
                format!("{} keep · {} cancel", k("dialog.select.submit"), k("dialog.close"))
            } else {
                format!("{} show/hide · ←→ effort · ctrl+r rename · {} back", k("dialog.select.submit"), k("dialog.close"))
            };
            (format!("{provider} models · {n} shown"), lines, at, keys)
        }
        Dialog::Provider(f) => {
            let key_only = f.provider.is_some();
            let mut lines = Vec::new();
            for (i, field) in f.fields().iter().enumerate() {
                let value = f.shown(*field);
                let focused = i == f.focus;
                let (shown, style) = if field.choice() {
                    (format!("‹ {value} ›"), Style::fg(c().accent).bold())
                } else if value.is_empty() {
                    (field.placeholder(key_only).to_string(), theme::subtle())
                } else {
                    (value, theme::text())
                };
                let caret = if focused && !field.choice() { "▏" } else { "" };
                let (shown, caret) = if focused && !field.choice() && f.shown(*field).is_empty() { (String::new(), format!("▏{shown}")) } else { (shown, caret.to_string()) };
                lines.push(runs(vec![(format!("{:<10}", field.label()), theme::muted()), (shown, style), (caret, theme::subtle())]));
            }
            if f.busy {
                lines.push(line("", theme::text()));
                lines.push(line("Saving…", theme::muted()));
            } else if let Some(e) = &f.error {
                lines.push(line("", theme::text()));
                lines.push(line(e.clone(), Style::fg(c().love)));
            }
            let keys = if key_only {
                format!("{} save · {close}", k("dialog.select.submit"))
            } else {
                format!("↑↓ field · ←→ choice · {} next, save on the last · {close}", k("dialog.select.submit"))
            };
            (f.title(), lines, Some(f.focus), keys)
        }
        Dialog::Help { scroll } => {
            let mut rows = vec![
                line(format!("Press {} to see all available actions and commands in any context.", k("command.palette.show")), theme::muted()),
                pair("Leader", format!("{} · {}", app.keymap.leader_label(), layer_name(app.keymap.source("leader"))), theme::text(), keyed),
            ];
            for g in keymap::GROUPS {
                rows.push(heading(g));
                for d in keymap::DEFS.iter().filter(|d| d.group == g) {
                    let keys = app.keymap.keys(d.id);
                    let keys = if keys.is_empty() { "none".to_string() } else { keys };
                    rows.push(pair(d.title, format!("{keys} · {}", layer_name(app.keymap.source(d.id))), theme::text(), keyed));
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
            (format!("Image {} of {}", index + 1, images.len()), vec![line(path, theme::text())], None, keys)
        }
        Dialog::List { list, query, selected } => {
            let (mut lines, at) = select_lines(&app.list_rows(list, query), *selected);
            let (name, empty, extra) = match list {
                List::Models => (
                    "Select model",
                    if app.providers.is_none() { "Loading providers…" } else { "No provider connected: /connect adds one" },
                    format!(" · {} favorite · {} providers", k("model.dialog.favorite"), k("model.dialog.provider")),
                ),
                List::Efforts => ("Select thinking effort", if app.offered().is_some() { "This model has no effort levels" } else { "Loading…" }, String::new()),
                List::Agents => ("Select specialist", if app.offered().is_some() { "No specialists" } else { "Loading…" }, String::new()),
                List::Themes { .. } => ("Themes", "No themes", String::new()),
                List::Providers => ("Connect a provider", if app.providers.is_none() { "Loading providers…" } else { "No providers" }, String::new()),
            };
            // A search that matches nothing says so, whatever the list.
            let empty = if query.is_empty() { empty } else { "No match" };
            if lines.is_empty() {
                lines.push(line(empty, theme::muted()));
            }
            search = Some(("Search", query.clone()));
            (name.into(), lines, at, format!("{} select{extra} · {close}", k("dialog.select.submit")))
        }
        Dialog::Info { info } => {
            // The label set apart from its value, as the palette sets an action apart from its keys.
            let row = |a: &str, b: String| pair(a, b, theme::muted(), theme::text());
            let unknown = || "unknown".to_string();
            let usage = app.current().and_then(|s| s.usage.clone()).unwrap_or_default();
            let no_mcp = vec![line("No MCP servers", theme::text()), line("A Lykos session connects to none; Lykos is one itself (lykos mcp).", theme::muted())];
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
                        row("Specialist", app.specialist_now().unwrap_or_else(unknown)),
                        row("Theme", theme::c().name.to_string()),
                    ];
                    // The context window as the prompt box shows it, with the tokens behind the percent.
                    let tokens = usage.context_tokens.map(|t| format!(" · {} tokens", group(t.round() as u64))).unwrap_or_default();
                    // Before the first answer: the bar from the system prompt and tools, estimated; with no reading at
                    // all, an empty bar.
                    let tokens = if tokens.is_empty() { usage.head_tokens.map(|t| format!(" · ~{} tokens before a message", group(t.round() as u64))).unwrap_or_default() } else { tokens };
                    let (cells, pct, colour) = context_bar(app).unwrap_or_else(|| (bar_cells(0.0), "0%".into(), c().accent));
                    rows.push(pair("Context", format!("{cells} {pct}{tokens}"), theme::muted(), Style::fg(colour)));
                    rows.extend(no_mcp);
                    ("Status".into(), rows, None, close.clone())
                }
                Info::Mcp => ("MCP servers".into(), no_mcp, None, close.clone()),
                Info::Usage => {
                    let t = &usage.tokens;
                    let mut rows = vec![
                        row("This session", usd(usage.run_usd)),
                        row("Today", usd(usage.today_usd)),
                        row("Calls", usage.calls.to_string()),
                        row("Cache hit", usage.cache_hit_ratio.map_or_else(unknown, |r| format!("{}%", (r * 100.0).round()))),
                        // P5 #53: the old footer's counters, each as the ledger counted it.
                        row("Fresh input", tokens(t.fresh)),
                        row("Cache read", tokens(t.cache_read)),
                        row("Cache write", tokens(t.cache_write)),
                        row("Output", tokens(t.output)),
                        row("Context", context_label(app).unwrap_or_else(unknown)),
                        row("Cache", usage.cache.as_ref().map_or_else(unknown, |c| format!("{} {} · {}", percent(c.pct), c.status, c.model))),
                        row(
                            "Outcome",
                            usage.outcome.as_ref().map_or_else(
                                || "not recorded".into(),
                                |o| match (&o.source, o.verified) {
                                    (Some(src), true) => format!("{} · verified by {src}", o.value),
                                    (Some(src), false) => format!("{} · unverified ({src})", o.value),
                                    (None, _) => format!("{} · unverified", o.value),
                                },
                            ),
                        ),
                    ];
                    for a in &usage.alerts {
                        let style = Style::fg(if a.severity == "danger" { c().love } else { c().gold });
                        rows.push(line(format!("⚠ {} · {}", a.id, a.message), style));
                        rows.push(line(format!("  {}", a.remedy), theme::muted()));
                    }
                    ("Usage".into(), rows, None, close.clone())
                }
                Info::Debug => (
                    "Debug  share this when reporting an issue".into(),
                    app.debug_rows().into_iter().map(|(a, b)| row(a, b)).collect(),
                    None,
                    format!("{} copy · {close}", k("debug.copy")),
                ),
            }
        }
        Dialog::Sessions { query, selected, all, confirm } => {
            let (mut lines, at) = select_lines(&app.session_rows(query, confirm.as_deref()), *selected);
            if lines.is_empty() {
                let empty = if app.past.is_none() {
                    "Loading sessions…"
                } else if query.is_empty() {
                    "No sessions"
                } else {
                    "No match"
                };
                lines.push(line(empty, theme::muted()));
            }
            let name = if *all { "Sessions  every project" } else { "Sessions" };
            search = Some(("Search sessions", query.clone()));
            let keys = format!(
                "{} open · {} delete · {} rename · {} pin · {} {} · {close}",
                k("dialog.select.submit"),
                k("session.delete"),
                k("session.list.rename"),
                k("session.pin.toggle"),
                k("session.list.all"),
                if *all { "this project" } else { "all projects" }
            );
            (name.into(), lines, at, keys)
        }
        Dialog::Timeline { query, selected } => {
            let (mut lines, at) = select_lines(&app.timeline_rows(query), *selected);
            if lines.is_empty() {
                lines.push(line(if query.is_empty() { "No prompts yet" } else { "No match" }, theme::muted()));
            }
            search = Some(("Search timeline", query.clone()));
            ("Timeline".into(), lines, at, format!("{} jump · {close}", k("dialog.select.submit")))
        }
        Dialog::Worktrees { selected, .. } => {
            let (mut lines, at) = select_lines(&app.worktree_rows(), *selected);
            if lines.is_empty() {
                lines.push(line(if app.worktrees.is_none() { "Loading worktrees…" } else { "No worktrees available" }, theme::muted()));
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
        Dialog::Context { data, scroll } => {
            scrolled = Some(*scroll);
            ("Context Usage".into(), context_lines(app, data.as_ref()), None, format!("↑↓ scroll · {close}"))
        }
        Dialog::Input { title, text, .. } => (title.clone(), vec![line(format!("{text}▏"), theme::text())], None, format!("{} confirm · {close}", k("dialog.select.submit"))),
        Dialog::Aside { title, answer, scroll } => {
            let (text, style) = match answer {
                Ok(a) => (a.as_str(), theme::text()),
                Err(e) => (e.as_str(), Style::fg(c().love)),
            };
            let all = wrap(text, inner.max(1));
            let start = (*scroll).min(all.len().saturating_sub(room));
            let shown = all.into_iter().skip(start).take(room).map(|l| line(l, style)).collect();
            (title.clone(), shown, None, format!("{} copy · ↑↓ scroll · {close}", k("aside.copy")))
        }
        // A sign-in: what it said, then its question with the answer typed so far, masked when it is a secret.
        Dialog::Login(l) => {
            let mut all: Vec<Line> = if l.lines.is_empty() && !l.failed { vec![line("Starting…", theme::muted())] } else { Vec::new() };
            let style = if l.failed { Style::fg(c().love) } else { theme::text() };
            all.extend(l.lines.iter().flat_map(|x| wrap(x, inner.max(1))).map(|x| line(x, style)));
            if let Some((prompt, secret)) = &l.ask {
                let shown = if *secret { "•".repeat(l.input.chars().count()) } else { l.input.clone() };
                all.push(line("", theme::text()));
                all.push(runs(vec![(format!("{prompt}: "), Style::fg(c().accent)), (format!("{shown}▏"), theme::text())]));
            }
            let end = all.len().saturating_sub(room);
            all.drain(..end);
            let keys = match (&l.ask, l.failed) {
                (Some(_), _) => format!("{} send · {} cancel", k("dialog.select.submit"), k("dialog.close")),
                (None, true) => close.clone(),
                (None, false) => format!("waiting for the browser · {} cancel", k("dialog.close")),
            };
            (format!("Sign in to {}", l.provider), all, None, keys)
        }
        // `dialog-shell-output.tsx`: the command as the title, the output's end, `Loading…` until the first read.
        Dialog::Output { command, text, offset, scroll, error, .. } => {
            let mut all: Vec<Line> = match (error, offset) {
                (Some(e), _) => vec![line(e.clone(), Style::fg(c().love))],
                (None, None) => vec![line("Loading…", theme::muted())],
                (None, Some(_)) if text.is_empty() => vec![line("No output", theme::muted())],
                (None, Some(_)) => text.trim_end_matches('\n').split('\n').flat_map(|l| wrap(l, inner.max(1))).map(|l| line(l, theme::text())).collect(),
            };
            let end = all.len().saturating_sub(room);
            let start = end.saturating_sub(*scroll);
            all.truncate(start + room);
            let shown = all.split_off(start);
            (format!("$ {}", first_line(command)), shown, None, format!("↑↓ scroll · {close}"))
        }
    };
    let search = search.filter(|_| search_h > 0);
    // A list longer than the dialog scrolls with its selection; the heading above the first row stays in view.
    // The selection stays in the middle, except near either end.
    let skip = scrolled.map_or_else(
        || {
            selected.map_or(0, |s| {
                let span = 1 + usize::from(lines.get(s + 1).is_some_and(|l| l.with_prev));
                // Where the mouse left it, while the selection is in view: the rows stay put under the cursor.
                match app.mouse_skip {
                    Some(p) if s >= p && s + span <= p + room && p <= lines.len().saturating_sub(room) => p,
                    _ => crate::menu::centered(s, span, lines.len(), room),
                }
            })
        },
        |s| s.min(lines.len().saturating_sub(room)),
    );
    let body = (lines.len().min(room) as u16).max(1);
    let dh = body + 4 + search_h;
    let (x, y) = ((w - dw) / 2, h.saturating_sub(dh) / 2);
    buf.fill(x, y, dw, dh, Style::default().on(c().surface));
    buf.text(x + 2, y + 1, dw.saturating_sub(4), &title, theme::text().on(c().surface).bold());
    let esc = k("dialog.close");
    let ew = esc.width() as u16;
    if ew + title.width() as u16 + 6 < dw {
        buf.text(x + dw - 2 - ew, y + 1, ew, &esc, theme::muted().on(c().surface));
    }
    // #58 item 6: the search in a box of its own, set apart from the list under it.
    if let Some((placeholder, query)) = &search {
        let caret = Cell { ch: '▏', style: Style::fg(c().accent).on(c().surface) };
        buf.border(x + 2, y + 2, dw.saturating_sub(4), 3, Style::fg(c().accent).on(c().surface));
        let tw = dw.saturating_sub(8);
        if query.is_empty() {
            buf.set(x + 4, y + 3, caret);
            buf.text(x + 5, y + 3, tw.saturating_sub(1), placeholder, theme::muted().on(c().surface));
        } else {
            let tail: Vec<char> = query.chars().rev().take(tw.saturating_sub(1) as usize).collect();
            let shown: String = tail.into_iter().rev().collect();
            let col = buf.text(x + 4, y + 3, tw, &shown, theme::text().on(c().surface));
            buf.set(col, y + 3, caret);
        }
    }
    let top = y + 2 + search_h;
    {
        // Each body row's item, for the mouse: a heading is none, a second row its first row's.
        let mut hits = app.hits.borrow_mut();
        hits.dialog = Some((x, y, dw, dh));
        hits.dialog_skip = skip;
        if selected.is_some() {
            let mut item = None;
            let mut next = 0;
            for (i, l) in lines.iter().enumerate() {
                if l.heading {
                    item = None;
                } else if !l.with_prev || item.is_none() {
                    item = Some(next);
                    next += 1;
                }
                if let (Some(n), true) = (item, (skip..skip + body as usize).contains(&i)) {
                    hits.dialog_rows.push((top + (i - skip) as u16, n));
                }
            }
        }
    }
    // #58 item 11: where the view is in a longer list.
    let bar = lines.len() > body as usize;
    let width = (inner as u16).saturating_sub(u16::from(bar));
    for (i, l) in lines.iter().enumerate().skip(skip).take(body as usize) {
        let ly = top + (i - skip) as u16;
        let on = selected == Some(i) || (l.with_prev && i > 0 && selected == Some(i - 1));
        // A group's heading on a band of its own, so groups stand apart.
        let band = l.heading && !l.left.is_empty();
        let (style, right_style) = if on {
            buf.fill(x + 1, ly, dw.saturating_sub(2 + u16::from(bar)), 1, Style::default().on(c().accent));
            (Style::fg(c().surface).on(c().accent), Style::fg(c().surface).on(c().accent))
        } else if band {
            buf.fill(x + 1, ly, dw.saturating_sub(2 + u16::from(bar)), 1, Style::default().on(c().overlay));
            (l.style.on(c().overlay), l.right_style.on(c().overlay))
        } else {
            (l.style.on(c().surface), l.right_style.on(c().surface))
        };
        if !l.runs.is_empty() {
            let mut col = x + 2;
            for (t, st) in &l.runs {
                let st = if on { style } else { st.on(c().surface) };
                col = buf.text(col, ly, (x + 2 + width).saturating_sub(col), t, st);
            }
            continue;
        }
        let rw = (l.right.width() as u16).min(width);
        let lw = if rw == 0 { width } else { width.saturating_sub(rw + 2) };
        let end = buf.text(x + 2, ly, lw, &l.left, style);
        if let Some((v, vs)) = &l.value {
            let vs = if on { style.bold() } else { vs.on(c().surface) };
            buf.text(end, ly, (x + 2 + lw).saturating_sub(end), v, vs);
        }
        if rw > 0 {
            buf.text(x + 2 + width - rw, ly, rw, &l.right, right_style);
        }
    }
    if bar {
        let (n, b) = (lines.len(), body as usize);
        let thumb = (b * b / n).max(1);
        let at = skip.min(n - b) * (b - thumb) / (n - b).max(1);
        let sx = x + dw - 2;
        for i in 0..b {
            let on = (at..at + thumb).contains(&i);
            buf.set(sx, top + i as u16, Cell { ch: if on { '┃' } else { '│' }, style: Style::fg(if on { c().accent } else { c().overlay }).on(c().surface) });
        }
    }
    // How many items are above and below the view, where the list scrolls; a heading or a second row is no item.
    let mut keys_w = dw.saturating_sub(4);
    if bar && scrolled.is_none() {
        let item = |l: &Line| !l.heading && !l.with_prev;
        let above = lines[..skip].iter().filter(|l| item(l)).count();
        let below = lines[(skip + body as usize).min(lines.len())..].iter().filter(|l| item(l)).count();
        let count = format!("↑ {above}  ↓ {below}");
        let cw = count.width() as u16;
        if cw + 8 < dw {
            buf.text(x + dw - 2 - cw, y + dh - 1, cw, &count, theme::muted().on(c().surface));
            keys_w = keys_w.saturating_sub(cw + 2);
        }
    }
    buf.text(x + 2, y + dh - 1, keys_w, &keys, theme::muted().on(c().surface));
}

/// A select dialog's rows (`dialog-select.tsx`): each category headed (a search shows none), the row in use
/// marked, a favorite or pinned one starred. Returns the lines and the selected row's line.
fn select_lines(rows: &[ListRow], selected: usize) -> (Vec<Line>, Option<usize>) {
    let mut lines = Vec::new();
    let mut at = None;
    let mut group = "";
    for (i, r) in rows.iter().enumerate() {
        if !r.group.is_empty() && r.group != group {
            lines.push(heading(&r.group));
        }
        group = &r.group;
        if i == selected {
            at = Some(lines.len());
        }
        let mark = if r.current { "● " } else { "  " };
        let right = if r.favorite { format!("{} *", r.detail) } else { r.detail.clone() };
        // The row in use (a configured provider, the model chosen) in the accent colour, to tell it apart.
        let title = if r.current { Style::fg(c().accent) } else { theme::text() };
        lines.push(pair(format!("{mark}{}", r.title), right, title, theme::muted()));
    }
    (lines, at)
}

/// A layer's name without its file, as a row has room for: `project`, `global`.
fn layer_name(source: &str) -> &str {
    source.split(" (").next().unwrap_or(source)
}

/// `component/prompt/metadata.tsx`: the specialist, the model's name, then the thinking effort in bold warning
/// colour; before a session answers, what a new one starts with. On the right, the context window's use as a bar.
fn metadata(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16) {
    let on = |st: Style| st.on(c().surface);
    let end = x + width;
    let bar = context_bar(app);
    let bw = bar.as_ref().map_or(0, |(b, p, _)| (b.chars().count() + 1 + p.width()) as u16);
    let room = if bw + 4 <= width { end - bw - 2 } else { end };
    let model = app.model_now().or_else(|| app.current().map(|s| s.summary.model.clone()).filter(|m| !m.is_empty()));
    let Some(model) = model else {
        buf.text(x, y, width, "lykos", on(theme::muted()));
        return;
    };
    let mut col = x;
    if let Some(sp) = app.specialist_now() {
        let mut name = sp.clone();
        if let Some(f) = name.get(..1) {
            name = f.to_uppercase() + &sp[1..];
        }
        col = buf.text(col, y, room.saturating_sub(col), &name, on(Style::fg(c().accent).bold()));
        col = buf.text(col, y, room.saturating_sub(col), " · ", on(theme::muted()));
    }
    col = buf.text(col, y, room.saturating_sub(col), &model_name(app, &model), on(theme::text()));
    if let Some(effort) = app.effort_now() {
        col = buf.text(col, y, room.saturating_sub(col), " · ", on(theme::muted()));
        buf.text(col, y, room.saturating_sub(col), &effort, on(Style::fg(c().gold).bold()));
    }
    if let Some((cells, label, colour)) = bar.filter(|_| room < end) {
        let bx = end - bw;
        let col = buf.text(bx, y, bw, &cells, on(Style::fg(colour)));
        buf.text(col + 1, y, end.saturating_sub(col + 1), &label, on(theme::muted()));
    }
}

/// A model's display name from the session's list, else its id without the provider.
fn model_name(app: &App, model: &str) -> String {
    let split = model.split_once('/');
    let found = app.options.as_ref().and_then(|o| o.models.iter().find(|m| split == Some((m.provider.as_str(), m.id.as_str())) || m.id == model));
    match found {
        Some(m) if !m.name.is_empty() => m.name.clone(),
        _ => model.rsplit('/').next().unwrap_or(model).to_string(),
    }
}

/// Cells in the context bar.
const CONTEXT_CELLS: usize = 10;

fn bar_cells(p: f64) -> String {
    let filled = ((p / 100.0) * CONTEXT_CELLS as f64).round() as usize;
    (0..CONTEXT_CELLS).map(|i| if i < filled { '▰' } else { '▱' }).collect()
}

/// Tokens as Claude Code's `/context` writes them: `4.9k`, `1m`.
fn short(t: f64) -> String {
    let (v, unit) = if t >= 1e6 {
        (t / 1e6, "m")
    } else if t >= 1e3 {
        (t / 1e3, "k")
    } else {
        return format!("{}", t.round() as u64);
    };
    format!("{v:.1}").trim_end_matches(".0").to_string() + unit
}

/// `/context`'s window, after Claude Code's: a grid where each cell is a hundredth of the window, coloured by what
/// fills it, the parts beside it, then what each part holds. The parts are estimates and the window says so.
fn context_lines(app: &App, data: Option<&lykos_client::ContextBreakdown>) -> Vec<Line> {
    let Some(d) = data else {
        let why = match (app.current(), app.status()) {
            (None, _) => "No conversation yet: send a message first",
            (Some(_), Some(SessionStatus::Idle)) => "Loading…",
            _ => "Shown once the session is idle",
        };
        return vec![line(why, theme::muted())];
    };
    let colours = [c().subtle, c().accent, c().gold, c().pine, c().love];
    let window = d.window.filter(|w| *w > 0.0);
    let used = d.measured.unwrap_or_else(|| d.parts.iter().map(|p| p.tokens).sum());
    let pct = |t: f64| window.map_or(String::new(), |w| format!(" ({:.1}%)", t / w * 100.0).replace(".0%", "%"));
    let mut cells: Vec<Style> = Vec::new();
    if let Some(w) = window {
        for (i, p) in d.parts.iter().enumerate() {
            let n = if p.tokens > 0.0 { (p.tokens / w * 100.0).round().max(1.0) as usize } else { 0 };
            cells.extend(std::iter::repeat_n(Style::fg(colours[i % colours.len()]), n));
        }
    }
    cells.truncate(100);
    let model = d.model.as_deref().map(|m| model_name(app, m)).unwrap_or_default();
    let mut legend: Vec<Vec<(String, Style)>> = vec![
        vec![(model, theme::text().bold())],
        vec![(format!("{}/{} tokens{}", short(used), window.map_or("?".into(), short), pct(used)), theme::muted())],
        vec![],
        vec![("Estimated usage by category".into(), theme::muted())],
    ];
    for (i, p) in d.parts.iter().enumerate() {
        legend.push(vec![("■ ".into(), Style::fg(colours[i % colours.len()])), (format!("{}: {} tokens{}", p.name, short(p.tokens), pct(p.tokens)), theme::text())]);
    }
    if let Some(w) = window {
        let free = (w - used).max(0.0);
        legend.push(vec![("□ ".into(), theme::muted()), (format!("Free space: {}{}", short(free), pct(free)), theme::text())]);
    }
    let mut out = Vec::new();
    for r in 0..10.max(legend.len()) {
        let mut row: Vec<(String, Style)> = Vec::new();
        if r < 10 {
            for col in 0..10 {
                row.push(match cells.get(r * 10 + col) {
                    Some(st) => ("■ ".into(), *st),
                    None => ("□ ".into(), Style::fg(c().overlay)),
                });
            }
        } else {
            row.push((" ".repeat(20), theme::text()));
        }
        row.push(("  ".into(), theme::text()));
        row.extend(legend.get(r).cloned().unwrap_or_default());
        out.push(runs(row));
    }
    for p in d.parts.iter().filter(|p| p.count.is_some()) {
        let n = p.count.unwrap_or(0);
        let noun = match p.name.as_str() {
            "Memory files" => "file",
            "Messages" => "message",
            "Skills" => "skill",
            _ => "tool",
        };
        out.push(line("", theme::text()));
        out.push(line(p.name.clone(), theme::text().bold()));
        out.push(line(format!("└ {n} {noun}{} · {} tokens", if n == 1 { "" } else { "s" }, short(p.tokens)), theme::muted()));
        for item in &p.items {
            out.push(line(format!("  {} · {} tokens", item.name, short(item.tokens)), theme::muted()));
        }
    }
    out.push(line("", theme::text()));
    out.push(line(
        if d.measured.is_some() { "The total is the model's count; each part is estimated at 4 characters a token." } else { "Estimated at 4 characters a token: the model has not answered yet." },
        theme::muted(),
    ));
    out
}

/// #58 item 14: the context window's use as filled cells, its percent, and a colour that warms as it fills.
/// Before the first answer, the system prompt and tools' estimate stands in for the reading.
fn context_bar(app: &App) -> Option<(String, String, lykos_term::Color)> {
    let u = app.current()?.usage.as_ref()?;
    let head = || Some(u.head_tokens? / u.context_window.filter(|w| *w > 0.0)? * 100.0);
    let p = u.context_percent.or_else(head)?.clamp(0.0, 100.0);
    let cells = bar_cells(p);
    let colour = if p > 90.0 {
        c().love
    } else if p > 70.0 {
        c().gold
    } else {
        c().accent
    };
    Some((cells, format!("{}%", p.round() as u64), colour))
}

/// The row under the prompt box: the spinner and `esc interrupt` while running, else the directory; on the right,
/// the context window's use.
pub(crate) fn footer_line(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16, pad: u16) {
    let x = x + pad;
    let width = width.saturating_sub(2 * pad);
    // `footer.tsx`'s live counts (P5 #48), ahead of the context's use.
    let live = crate::composer::live(app).map(|l| match app.keymap.first("session.child.first") {
        k if k.is_empty() => l,
        k => format!("{k} {l}"),
    });
    // The old footer's triad and context in two thirds of the row at most; the directory keeps the rest.
    let room = (width as usize * 2 / 3).saturating_sub(live.as_ref().map_or(0, |l| l.width() + 3));
    let right = match (live, usage_line(app, room)) {
        (Some(l), Some(c)) => Some(format!("{l} · {c}")),
        (l, c) => l.or(c),
    };
    let rw = right.as_ref().map_or(0, |r| r.width() as u16);
    let left_w = width.saturating_sub(rw + 2);
    match &app.link {
        Link::Connecting => {
            let s = format!("{} connecting to the engine server", spinner(app));
            buf.text(x + 1, y, left_w, &s, theme::muted());
        }
        Link::Failed(m) | Link::Lost(m) => {
            buf.text(x + 1, y, left_w, m, Style::fg(c().love));
        }
        Link::Ready if app.opening() => {
            let mut col = x + 1;
            for s in transcript::shimmer("Opening...", app.tick, Style::fg(c().accent), c().text, app.prefs.animations) {
                col = buf.text(col, y, left_w.saturating_sub(col - x - 1), &s.text, s.style);
            }
        }
        Link::Ready if app.running() => {
            let accent = Style::fg(c().accent);
            let mut col = buf.text(x + 1, y, left_w, &spinner(app).to_string(), accent);
            // The turn's word, as the transcript shows it.
            let turn = app.current().map_or(0, |s| crate::transcript::turn_of(&s.items, s.items.len().saturating_sub(1)));
            col += 1;
            for s in transcript::shimmer(&format!("{}...", crate::transcript::busy_word(turn)), app.tick, accent, c().text, app.prefs.animations) {
                col = buf.text(col, y, left_w.saturating_sub(col - x - 1), &s.text, s.style);
            }
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

/// `renderers/line.ts` `renderTriadLine` (P5 #53): fresh input, cache hit, cache write, output; the context; the
/// cache gauge; the run's cost; the top alert. Each number is the server's, only formatted. Segments drop whole,
/// widest layout first, until one fits `room`.
pub(crate) fn usage_line(app: &App, room: usize) -> Option<String> {
    let u = app.current()?.usage.as_ref()?;
    let t = &u.tokens;
    let hit = format!("⚡{}", percent(u.cache_hit_ratio));
    let triad = format!("↑{} {hit} ✎ {} ↓{}", tokens(t.fresh), tokens(t.cache_write), tokens(t.output));
    let ctx = context_label(app);
    let ctx_short = u.context_percent.map(|p| format!("{}% ctx", p.round() as u64));
    let cache = u.cache.as_ref().map(|c| format!("cache {} {}", percent(c.pct), c.status));
    let cost = Some(usd(u.run_usd));
    let badge = alert_badge(&u.alerts);
    let join = |parts: &[&Option<String>]| parts.iter().filter_map(|p| p.as_deref()).collect::<Vec<_>>().join(" · ");
    let (triad, hit) = (Some(triad), Some(hit));
    [
        join(&[&triad, &ctx, &cache, &cost, &badge]),
        join(&[&triad, &ctx, &cost, &badge]),
        join(&[&triad, &ctx_short, &cost, &badge]),
        join(&[&hit, &ctx_short, &cost, &badge]),
        join(&[&cost, &badge]),
    ]
    .into_iter()
    .find(|l| l.width() <= room)
}

/// `format.ts` `fmtPct`: a fraction as a whole percent, `?%` when unknown.
fn percent(fraction: Option<f64>) -> String {
    fraction.map_or_else(|| "?%".into(), |f| format!("{}%", (f * 100.0).round() as i64))
}

/// `format.ts` `fmtTokens`: `1.2k`, `3.40M`.
pub(crate) fn tokens(n: f64) -> String {
    match n.abs() {
        a if a >= 1_000_000.0 => format!("{:.2}M", n / 1_000_000.0),
        a if a >= 1_000.0 => format!("{:.1}k", n / 1_000.0),
        _ => format!("{}", n.round() as i64),
    }
}

/// `format.ts` `fmtUsd`: four places below a cent, three above; `$?` when unpriced, never `$0.00`.
pub(crate) fn usd(v: Option<f64>) -> String {
    match v {
        None => "$?".into(),
        Some(v) if v.is_nan() => "$?".into(),
        Some(v) if v.abs() < 0.01 => format!("${v:.4}"),
        Some(v) => format!("${v:.3}"),
    }
}

/// `line.ts` `alertBadge`: the most severe alert's id, and how many more.
fn alert_badge(alerts: &[lykos_client::Alert]) -> Option<String> {
    let rank = |s: &str| match s {
        "danger" => 2,
        "warn" => 1,
        _ => 0,
    };
    let top = alerts.iter().max_by_key(|a| rank(&a.severity))?;
    Some(match alerts.len() - 1 {
        0 => format!("⚠ {}", top.id),
        rest => format!("⚠ {} +{rest}", top.id),
    })
}

pub(crate) fn group(n: u64) -> String {
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
        let request = lykos_client::RequestData { request_id: "r1".into(), kind: kind.into(), title: title.into(), detail: detail.into(), body: None, patch: patch.map(Into::into), options, assumption: Some("go on".into()), secret: false };
        app.on_event(&Event { event: "x".into(), session: "s1".into(), seq: 6, data: EventData::Request { request } });
    }

    #[test]
    fn the_footer_shows_the_old_triad_and_drops_whole_segments_to_fit() {
        let mut app = app_with_session();
        let usage = UsageData {
            context_tokens: Some(12345.0),
            context_percent: Some(6.2),
            run_usd: Some(0.0384),
            cache_hit_ratio: Some(0.74),
            tokens: lykos_client::TokenCounters { fresh: 1200.0, cache_read: 3400.0, cache_write: 500.0, output: 230.0, reasoning: 0.0 },
            cache: Some(lykos_client::CacheGauge { model: "m".into(), pct: Some(0.74), status: "fresh".into() }),
            alerts: vec![
                lykos_client::Alert { id: "budget.run".into(), severity: "warn".into(), message: "near the cap".into(), remedy: "raise it".into() },
                lykos_client::Alert { id: "context.full".into(), severity: "danger".into(), message: "m".into(), remedy: "r".into() },
            ],
            outcome: Some(lykos_client::Outcome { value: "success".into(), source: Some("verification_command".into()), verified: true }),
            ..Default::default()
        };
        app.on_event(&Event { event: "x".into(), session: "s1".into(), seq: 6, data: EventData::Usage { usage } });
        assert_eq!(
            usage_line(&app, 200).as_deref(),
            Some("↑1.2k ⚡74% ✎ 500 ↓230 · 12,345 tokens · 6% used · cache 74% fresh · $0.038 · ⚠ context.full +1")
        );
        assert_eq!(usage_line(&app, 50).as_deref(), Some("⚡74% · 6% ctx · $0.038 · ⚠ context.full +1"));
        assert_eq!(usage_line(&app, 30).as_deref(), Some("$0.038 · ⚠ context.full +1"));
        assert_eq!(usage_line(&app, 5), None);
        app.dialog = Some(Dialog::Info { info: Info::Usage });
        let mut buf = Buffer::new(100, 40);
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("Cache write") && s.contains("500"), "{s}");
        assert!(s.contains("success · verified by verification_command"), "{s}");
        assert!(s.contains("⚠ budget.run · near the cap"), "{s}");
    }

    #[test]
    fn the_old_slash_commands_are_palette_actions_that_send_them() {
        let mut app = app_with_session();
        for (id, text) in [("lykos.mode", "/mode"), ("lykos.permissions", "/permissions"), ("lykos.output_style", "/output-style"), ("lykos.credential", "/credential")] {
            assert!(app.palette("").iter().any(|d| d.id == id), "{id} is in the palette");
            let actions = app.run(id, std::time::Instant::now(), 10);
            assert!(matches!(actions.as_deref(), Some([crate::app::Action::Prompt { text: t, .. }]) if t == text), "{id}: {actions:?}");
        }
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
        assert!(screen(&buf).contains("Loading providers…"), "{}", screen(&buf));
        let entry = lykos_client::ProviderEntry { name: "p".into(), login: "api_key".into(), oauth: None, api_key: None, configured: true, reason: String::new() };
        app.providers = Some(vec![entry]);
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("Select model") && s.contains("● Alpha") && s.contains("200K") && s.contains("Select models…"), "{s}");
        app.dialog = Some(Dialog::List { list: List::Models, query: "zzz".into(), selected: 0 });
        draw(&app, &mut buf);
        assert!(screen(&buf).contains("No match"), "a search that matches nothing says so");
        app.dialog = Some(Dialog::List { list: List::Models, query: String::new(), selected: 0 });
        assert_eq!(buf.get(0, 29).style.bg, lykos_term::Color::Reset, "a dark theme leaves the terminal's background");
        theme::set("rose-pine-dawn");
        draw(&app, &mut buf);
        assert_eq!(buf.get(0, 29).style.bg, c().base.unwrap(), "a light one paints it");
        theme::set("sky");
    }

    #[test]
    fn the_model_picker_draws_each_model_shown_or_hidden_with_its_id_and_effort() {
        let mut app = App::new("C:/work".into());
        app.connected();
        app.dialog = Some(Dialog::ModelPicker { provider: "p".into(), query: String::new(), selected: 0, rename: None });
        let mut buf = Buffer::new(100, 30);
        draw(&app, &mut buf);
        assert!(screen(&buf).contains("Loading models…"));
        app.picker = Some(Ok(serde_json::from_value(serde_json::json!([
            { "id": "a-1", "name": "Alpha", "reasoning": true, "contextWindow": null, "efforts": ["off", "high"], "listed": true },
            { "id": "b-2", "name": "Beta", "reasoning": false, "contextWindow": null, "efforts": ["off"], "listed": true }
        ]))
        .unwrap()));
        app.prefs.model_entry("p/b-2", "Beta", None, false).shown = true;
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("p models · 1 shown") && s.contains("○ Alpha") && s.contains("‹ auto ›") && s.contains("a-1") && s.contains("● Beta") && s.contains("b-2"), "{s}");
        app.dialog = Some(Dialog::ModelPicker { provider: "p".into(), query: "zzz".into(), selected: 0, rename: None });
        draw(&app, &mut buf);
        assert!(screen(&buf).contains("No match"));
        app.picker = Some(Err("the endpoint refused".into()));
        draw(&app, &mut buf);
        assert!(screen(&buf).contains("the endpoint refused"));
    }

    #[test]
    fn the_mouse_finds_the_row_drawn_under_it_in_a_list_of_two_rows_an_item() {
        use crossterm::event::{KeyModifiers, MouseEvent, MouseEventKind};
        let mut app = App::new("/w".into());
        app.connected();
        app.picker = Some(Ok(serde_json::from_value(serde_json::json!([
            { "id": "a-1", "name": "Alpha", "reasoning": false, "contextWindow": null, "efforts": ["off"], "listed": true },
            { "id": "b-2", "name": "Beta", "reasoning": false, "contextWindow": null, "efforts": ["off"], "listed": true }
        ]))
        .unwrap()));
        app.dialog = Some(Dialog::ModelPicker { provider: "p".into(), query: String::new(), selected: 0, rename: None });
        let mut buf = Buffer::new(100, 30);
        draw(&app, &mut buf);
        // Beta's name row and its id row under it are both Beta's.
        let s = screen(&buf);
        let beta = s.lines().position(|l| l.contains("Beta")).unwrap() as u16;
        let rows = app.hits.borrow().dialog_rows.clone();
        assert!(rows.contains(&(beta, 1)) && rows.contains(&(beta + 1, 1)), "{rows:?}");
        let x = app.hits.borrow().dialog.unwrap().0 + 3;
        app.on_mouse(MouseEvent { kind: MouseEventKind::Moved, column: x, row: beta + 1, modifiers: KeyModifiers::NONE }, std::time::Instant::now());
        assert!(matches!(app.dialog, Some(Dialog::ModelPicker { selected: 1, .. })));
    }

    #[test]
    fn the_palette_and_the_help_show_each_actions_keys_and_where_they_were_set() {
        let mut app = App::new("C:/work".into());
        app.connected();
        app.on_config(Ok(serde_json::json!({ "keybinds": { "input.undo": { "value": "alt+u", "source": "project (C:/w/.lykos/config.yaml)" } } })));
        app.dialog = Some(Dialog::Palette { query: "undo".into(), selected: 0 });
        let mut buf = Buffer::new(100, 30);
        assert_eq!(draw(&app, &mut buf), None, "no prompt cursor under a dialog");
        let s = screen(&buf);
        assert!(s.contains("Commands") && s.contains("undo▏") && s.contains("Undo in input") && s.contains("alt+u · project"), "{s}");
        app.dialog = Some(Dialog::Help { scroll: 0 });
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("Press ctrl+p to see all available actions"), "{s}");
        assert!(s.contains("Leader") && s.contains("ctrl+x · default"), "{s}");
        app.dialog = Some(Dialog::Help { scroll: 120 });
        draw(&app, &mut buf);
        assert!(screen(&buf).contains("Undo in input"), "scrolled to the input actions");
    }

    #[test]
    fn skills_show_the_name_left_and_two_rows_of_description_and_a_long_list_counts_what_is_hidden() {
        let mut app = app_with_session();
        let long = "word ".repeat(80);
        let commands: Vec<lykos_client::CommandInfo> = (0..30)
            .map(|i| lykos_client::CommandInfo { name: format!("/skill:s{i:02}"), description: if i == 0 { long.clone() } else { "short".into() }, source: "skill".into() })
            .collect();
        app.on_event(&Event { event: "commands".into(), session: "s1".into(), seq: 6, data: EventData::Commands { commands } });
        app.dialog = Some(Dialog::Skills { query: String::new(), selected: 0 });
        let mut buf = Buffer::new(120, 30);
        draw(&app, &mut buf);
        let s = screen(&buf);
        let rows: Vec<&str> = s.lines().filter(|l| l.contains("word")).collect();
        assert_eq!(rows.len(), 2, "two rows of description: {s}");
        assert!(rows[0].contains("/skill:s00") && rows[1].contains("word…"), "{s}");
        assert!(s.contains("↑ 0  ↓ "), "{s}");
        // The selection stays in the middle: twelve down, items are hidden above as well.
        app.dialog = Some(Dialog::Skills { query: String::new(), selected: 12 });
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("/skill:s12") && !s.contains("↑ 0 ") && !s.contains("below"), "{s}");
    }

    #[test]
    fn the_provider_popup_shows_every_field_with_the_key_masked() {
        let mut app = App::new("C:/work".into());
        app.connected();
        app.ask_custom();
        if let Some(Dialog::Provider(f)) = &mut app.dialog {
            f.name = "local".into();
            f.key = "secret".into();
        }
        let mut buf = Buffer::new(100, 30);
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("Add a custom provider") && s.contains("Base URL") && s.contains("‹ OpenAI Chat Completions ›"), "{s}");
        assert!(s.contains("••••••") && !s.contains("secret"), "{s}");
        theme::set("gruvbox-dark");
        assert_eq!(theme::c().pair, "gruvbox-light");
        theme::set("sky");
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
    fn the_home_screen_names_the_default_specialist_model_and_effort_and_a_toast_shows_over_it() {
        let mut app = App::new("C:/work".into());
        app.connected();
        app.on_config(Ok(serde_json::json!({ "keybinds": {}, "defaults": { "model": "deepseek/deepseek-v4-flash", "effort": "low", "specialist": "build" } })));
        app.toast(crate::app::ToastKind::Success, "Copied to clipboard".into());
        let mut buf = Buffer::new(100, 30);
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("Build · deepseek-v4-flash · low"), "{s}");
        assert!(s.lines().nth(1).is_some_and(|l| l.contains("┃ Copied to clipboard")), "{s}");
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
        let word = format!("{}...", crate::transcript::busy_word(1));
        assert!(s.contains(&format!("{word} esc interrupt")), "the turn's word beside the spinner: {s}");
        for want in ["Fix it", "On it.", "read src/main.rs", "claude-opus · high", "12,345 tokens · 6% used", "esc interrupt", "▰▱▱▱▱▱▱▱▱▱ 6%"] {
            assert!(s.contains(want), "missing {want:?} in\n{s}");
        }
        app.dialog = Some(Dialog::Info { info: Info::Status });
        draw(&app, &mut buf);
        let s = screen(&buf);
        assert!(s.contains("▰▱▱▱▱▱▱▱▱▱ 6% · 12,345 tokens"), "status shows the context bar\n{s}");
        // `/context`'s window: the grid, the parts beside it, then what each holds.
        let parts = vec![
            lykos_client::ContextPart { name: "System prompt".into(), tokens: 4000.0, ..Default::default() },
            lykos_client::ContextPart { name: "Memory files".into(), tokens: 300.0, count: Some(1), items: vec![lykos_client::ContextItem { name: "AGENTS.md".into(), tokens: 300.0 }] },
        ];
        let data = lykos_client::ContextBreakdown { model: Some("claude-opus".into()), window: Some(200000.0), measured: Some(12345.0), parts };
        app.dialog = Some(Dialog::Context { data: Some(data), scroll: 0 });
        let mut buf = Buffer::new(100, 40);
        draw(&app, &mut buf);
        let s = screen(&buf);
        for want in ["Context Usage", "■ □ □", "12.3k/200k tokens (6.2%)", "System prompt: 4k tokens (2%)", "Free space: 187.7k", "└ 1 file · 300 tokens", "AGENTS.md · 300 tokens"] {
            assert!(s.contains(want), "missing {want:?} in\n{s}");
        }
        // A toast sits at the top right and wraps.
        app.dialog = None;
        app.toast(crate::app::ToastKind::Info, "a message long enough that it has to wrap onto a second line of the toast".into());
        draw(&app, &mut buf);
        let s = screen(&buf);
        let row = s.lines().nth(1).unwrap();
        assert!(row.find("a message").unwrap() > 40, "on the right\n{s}");
        assert!(s.lines().nth(2).unwrap().contains("toast"), "wrapped\n{s}");
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

/// The text cut to `max` columns, with an ellipsis where it was cut.
fn ellipsis(text: &str, max: usize) -> String {
    if text.width() <= max {
        return text.to_string();
    }
    let mut out = String::new();
    let mut w = 1;
    for ch in text.chars() {
        let cw = unicode_width::UnicodeWidthChar::width(ch).unwrap_or(0);
        if w + cw > max {
            break;
        }
        w += cw;
        out.push(ch);
    }
    out.push('…');
    out
}
