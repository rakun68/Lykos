//! The two screens, drawn into a cell buffer. Layout follows OpenCode's TUI at `4332e24`: the home screen
//! (`routes/home.tsx`), the session screen (`routes/session/index.tsx`), the prompt box (`component/prompt/index.tsx`)
//! and its metadata row (`component/prompt/metadata.tsx`). Differences are listed in #37's closing comment.
use lykos_client::{Item, Session, SessionStatus, ToolState};
use lykos_term::{Attr, Buffer, Cell, Style};

use crate::app::{App, Dialog, InputArea, Link};
use crate::editor::{Chip, Editor};
use crate::keymap;
use crate::menu::Menu;
use crate::theme::{self, ACCENT, GOLD, LOVE, MUTED, OVERLAY, PINE, SURFACE};
use crate::wrap::wrap;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

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
    let cursor = match app.current() {
        None => home(app, buf, pad),
        Some(session) => session_screen(app, session, buf, pad),
    };
    if app.dialog.is_some() {
        dialog(app, buf);
        return None;
    }
    cursor
}

/// The input's width at this screen width: what up and down move through.
pub fn input_cols(app: &App, w: u16) -> usize {
    let pad: u16 = if w < 44 { 1 } else { 2 };
    let width = w.saturating_sub(2 * pad);
    input_width(if app.current().is_none() { width.min(75) } else { width })
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
            let label = " Jump to latest ↓ (ctrl+alt+g) ";
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
    let rows = app.editor.layout(input_width(width)).len().max(1) as u16;
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

/// `component/prompt/index.tsx`: a left bar in the accent colour on a raised background, the input with a row of
/// padding above, the metadata row, a half-block bottom edge, and the footer under it.
fn prompt_box(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16, screen_h: u16) -> Option<(u16, u16)> {
    let raised = Style::default().on(SURFACE);
    let bar = Style::fg(if app.running() { GOLD } else { ACCENT }).on(SURFACE);
    let iw = input_width(width);
    let rows = app.editor.layout(iw);
    let (crow, ccol) = app.editor.locate(&rows, app.editor.cursor());
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
    if app.editor.is_empty() {
        let hint = if app.current().is_some() { "Ask anything…" } else { "Ask anything… \"Fix a TODO in the codebase\"" };
        buf.text(tx, ty, width.saturating_sub(4), hint, Style::fg(MUTED).on(SURFACE));
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

/// One visual row of the input: a chip draws as its label, the selection on the overlay colour.
fn input_row(editor: &Editor, buf: &mut Buffer, x: u16, y: u16, max: u16, row: crate::editor::Row, selection: Option<(usize, usize)>) {
    let mut col = x;
    let end = x + max;
    let mut one = [0u8; 4];
    for (i, ch) in editor.text()[row.start..row.end].char_indices() {
        let at = row.start + i;
        let mut style = theme::text().on(SURFACE);
        if selection.is_some_and(|(s, e)| at >= s && at < e) {
            style = style.on(OVERLAY);
        }
        col = match editor.chip(ch) {
            Some(chip) => buf.text(col, y, end.saturating_sub(col), &chip.label(), Style { fg: ACCENT, ..style }.bold()),
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
        let bg = if on { ACCENT } else { OVERLAY };
        buf.fill(x, y, width, 1, Style::default().on(bg));
        buf.text(x + 1, y, label_w, &e.label, Style::fg(if on { SURFACE } else { theme::TEXT }).on(bg));
        if !e.detail.is_empty() {
            buf.text(x + label_w + 3, y, width.saturating_sub(label_w + 4), first_line(&e.detail), Style::fg(if on { SURFACE } else { MUTED }).on(bg));
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
                    (columns(d.title, &right, inner), theme::text())
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
        Dialog::Aside { question, answer, scroll } => {
            let (text, style) = match answer {
                Ok(a) => (a.as_str(), theme::text()),
                Err(e) => (e.as_str(), Style::fg(LOVE)),
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
    buf.fill(x, y, dw, dh, Style::default().on(SURFACE));
    buf.text(x + 2, y + 1, dw.saturating_sub(4), &title, theme::text().on(SURFACE).bold());
    for (i, (line, style)) in lines.iter().enumerate().skip(skip).take(body as usize) {
        let ly = y + 2 + (i - skip) as u16;
        if selected == Some(i) {
            buf.fill(x + 1, ly, dw.saturating_sub(2), 1, Style::default().on(ACCENT));
            buf.text(x + 2, ly, inner as u16, line, Style::fg(SURFACE).on(ACCENT));
        } else {
            buf.text(x + 2, ly, inner as u16, line, style.on(SURFACE));
        }
    }
    buf.text(x + 2, y + dh - 1, dw.saturating_sub(4), &keys, theme::muted().on(SURFACE));
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
            let (text, style) = if app.leader.is_some() {
                ("ctrl+x  enter queue · e editor · i images · q queued".to_string(), Style::fg(GOLD))
            } else if app.search.is_some() {
                ("history search · ctrl+r older · enter send · any key keeps it".to_string(), Style::fg(GOLD))
            } else if let Some(n) = &app.notice {
                (n.clone(), Style::fg(LOVE))
            } else {
                (app.cwd.clone(), theme::muted())
            };
            buf.text(x + 1, y, left_w, &text, style);
        }
    }
    // btw.tsx's footer slot: `/btw` and a spinner while an aside waits.
    if app.asides > 0 && app.link == Link::Ready {
        let label = format!("{} /btw", SPINNER[(app.tick % 10) as usize]);
        let lw = label.chars().count() as u16;
        if lw + rw + 4 <= width {
            buf.text(x + width - rw - lw - 3, y, lw, &label, Style::fg(ACCENT));
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
    for q in &app.queue {
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
        app.dialog = Some(Dialog::Help { scroll: 40 });
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
        let mut run = |app: &mut App, frame: &mut dyn FnMut(&App)| {
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
