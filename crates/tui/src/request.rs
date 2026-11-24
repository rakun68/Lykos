//! The approval prompt and the question (P5 #46), as OpenCode's TUI at `4332e24` draws them:
//! `routes/session/permission.tsx` (`PermissionPrompt`, `SessionQuestion`) and `routes/session/form.tsx`
//! (`FormPrompt` with one field). Either takes the prompt box's place while the session's oldest request waits. The
//! answer goes back through `session.answer`, so the gate and the `ask` tool decide what it means, as they do with
//! the old TUI: `y`, `a`, `f` or `n` for an approval, an option's number or typed text for a question, and nothing
//! for the question's stated assumption.
use std::rc::Rc;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lykos_client::RequestData;
use lykos_term::{Buffer, Cell, Style};
use unicode_width::UnicodeWidthStr;

use crate::app::{Action, App};
use crate::diff;
use crate::theme::{self, c};
use crate::wrap::wrap;

/// Where the prompt for request `id` is: the option picked, full screen or not, typing an answer, the body's scroll,
/// and the prompt's text while an answer is typed in its place.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Ui {
    pub id: String,
    pub selected: usize,
    pub expanded: bool,
    pub editing: bool,
    pub scroll: usize,
    draft: Option<String>,
}

/// `SessionQuestion`'s height while it is not full screen.
const MAX_HEIGHT: u16 = 15;

/// The diff an approval shows, laid out once per request, width, view and wrap.
pub type Laid = Option<(String, usize, bool, bool, Rc<diff::Layout>)>;

fn approval(r: &RequestData) -> bool {
    r.kind == "approval"
}

/// The gate's kind, as the server writes the title: `bash: run ls`.
fn kind(r: &RequestData) -> &str {
    r.title.split(':').next().unwrap_or("")
}

impl App {
    /// The request the session waits on, if any.
    pub fn request(&self) -> Option<&RequestData> {
        self.current()?.requests.first()
    }

    /// The prompt state for the request shown, reset when another one comes.
    pub fn request_ui(&self) -> Ui {
        match self.request() {
            Some(r) if self.req.id == r.request_id => self.req.clone(),
            Some(r) => Ui { id: r.request_id.clone(), editing: !approval(r) && r.options.is_empty(), ..Ui::default() },
            None => Ui::default(),
        }
    }

    fn answer(&mut self, r: &RequestData, answer: String) -> Vec<Action> {
        if let Some(draft) = self.req.draft.take() {
            self.editor.set(&draft);
        } else if self.req.editing {
            self.editor.reset();
        }
        self.req = Ui::default();
        let Some(session) = self.session.clone() else { return Vec::new() };
        vec![Action::Answer { session, request_id: r.request_id.clone(), answer }]
    }

    /// A key while a request waits. `None` passes it on: a key with ctrl or alt (the palette, the tabs), and, while an
    /// answer is typed, the editing keys.
    pub fn request_key(&mut self, key: &KeyEvent) -> Option<Vec<Action>> {
        let r = self.request()?.clone();
        self.req = self.request_ui();
        let modified = key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER);
        if approval(&r) {
            if self.keymap.matches(key, false).contains(&"permission.prompt.fullscreen") {
                self.req.expanded = !self.req.expanded;
                return Some(Vec::new());
            }
            if modified {
                return None;
            }
            let n = r.options.len().max(1);
            let ui = &mut self.req;
            match key.code {
                KeyCode::Left | KeyCode::Char('h') => ui.selected = (ui.selected + n - 1) % n,
                KeyCode::Right | KeyCode::Char('l') => ui.selected = (ui.selected + 1) % n,
                KeyCode::Up => ui.scroll = ui.scroll.saturating_sub(1),
                KeyCode::Down => ui.scroll += 1,
                KeyCode::PageUp => ui.scroll = ui.scroll.saturating_sub(10),
                KeyCode::PageDown => ui.scroll += 10,
                KeyCode::Enter => {
                    let value = r.options.get(ui.selected).map(|o| o.value.clone()).unwrap_or_else(|| "n".into());
                    return Some(self.answer(&r, value));
                }
                // `SessionQuestion`'s dismiss: full screen closes first, then Esc rejects.
                KeyCode::Esc if ui.expanded => ui.expanded = false,
                KeyCode::Esc => return Some(self.answer(&r, "n".into())),
                // The gate's own letters, as the old TUI takes them.
                KeyCode::Char(ch) if r.options.iter().any(|o| o.value.chars().eq(std::iter::once(ch))) => return Some(self.answer(&r, ch.to_string())),
                KeyCode::Char(_) => {}
                _ => return None,
            }
            return Some(Vec::new());
        }
        let n = r.options.len();
        let textual = n == 0;
        if self.req.editing {
            match key.code {
                KeyCode::Enter if !key.modifiers.contains(KeyModifiers::SHIFT) && !modified => {
                    let text = self.editor.expanded().trim().to_string();
                    if text.is_empty() && !textual {
                        self.leave_editing();
                        return Some(Vec::new());
                    }
                    return Some(self.answer(&r, text));
                }
                KeyCode::Esc | KeyCode::Up if !textual && !modified => {
                    self.leave_editing();
                    return Some(Vec::new());
                }
                // Dismissed: the `ask` tool takes the question's assumption.
                KeyCode::Esc => return Some(self.answer(&r, String::new())),
                _ => return None,
            }
        }
        if modified {
            return None;
        }
        let total = n + 1;
        match key.code {
            KeyCode::Char(d @ '1'..='9') if (d as usize - '0' as usize) <= total => {
                let i = d as usize - '1' as usize;
                if i < n {
                    return Some(self.answer(&r, (i + 1).to_string()));
                }
                self.req.selected = n;
                self.start_editing();
            }
            KeyCode::Up | KeyCode::Char('k') => self.req.selected = (self.req.selected + total - 1) % total,
            KeyCode::Down | KeyCode::Char('j') => self.req.selected = (self.req.selected + 1) % total,
            KeyCode::Enter if self.req.selected < n => return Some(self.answer(&r, (self.req.selected + 1).to_string())),
            KeyCode::Enter => self.start_editing(),
            KeyCode::Esc => return Some(self.answer(&r, String::new())),
            // `FormPrompt`'s key interceptor: typing on "Type your own answer" starts the answer.
            KeyCode::Char(ch) if self.req.selected == n && !ch.is_control() && ch != ' ' => {
                self.start_editing();
                self.editor.insert_str(&ch.to_string());
            }
            KeyCode::Char(_) => {}
            _ => return None,
        }
        Some(Vec::new())
    }

    /// The prompt's text steps aside while an answer is typed in the editor.
    fn start_editing(&mut self) {
        self.req.editing = true;
        if self.req.draft.is_none() {
            self.req.draft = Some(self.editor.text().to_string());
            self.editor.reset();
        }
    }

    fn leave_editing(&mut self) {
        self.req.editing = false;
        if let Some(draft) = self.req.draft.take() {
            self.editor.set(&draft);
        }
    }
}

/// One row inside the box.
enum Line {
    Blank,
    Spans(u16, Vec<(String, Style)>),
    Diff(diff::Row),
}

fn spans(indent: u16, s: &[(&str, Style)]) -> Line {
    Line::Spans(indent, s.iter().map(|(t, st)| (t.to_string(), *st)).collect())
}

/// `permissionPresentation` for the gate's kinds: an icon and a title (none for a shell command), and the lines
/// under them.
fn presentation(app: &App, r: &RequestData) -> (Option<String>, Vec<String>) {
    let path = |p: &str| p.strip_prefix(app.current().map_or("", |s| s.summary.cwd.as_str())).map(|p| p.trim_start_matches(['/', '\\']).to_string()).filter(|p| !p.is_empty()).unwrap_or_else(|| p.to_string());
    match kind(r) {
        "bash" => (None, vec![format!("$ {}", r.detail)]),
        "write" => (Some(format!("← Write {}", path(&r.detail))), Vec::new()),
        "edit" => (Some(format!("← Edit {}", path(&r.detail))), Vec::new()),
        "read" => (Some(format!("→ Read {}", path(&r.detail))), vec![format!("Path: {}", path(&r.detail))]),
        _ => (Some(format!("⚙ {}", r.title)), vec![r.detail.clone()]),
    }
}

/// The diff of a write or an edit, laid out for `width`.
fn diff_layout(app: &App, r: &RequestData, width: usize) -> Option<Rc<diff::Layout>> {
    let patch = r.patch.as_deref()?;
    let (split, wrap) = (width > 120, app.prefs.diff_wrap);
    let mut laid = app.req_diff.borrow_mut();
    if let Some((id, w, s, wr, lay)) = laid.as_ref() {
        if *id == r.request_id && *w == width && *s == split && *wr == wrap {
            return Some(lay.clone());
        }
    }
    let lay = Rc::new(diff::layout(&diff::parse(patch), width, split, wrap));
    *laid = Some((r.request_id.clone(), width, split, wrap, lay.clone()));
    Some(lay)
}

/// The box's rows above its actions, `width` columns of text wide: the header, then the body.
fn content(app: &App, r: &RequestData, ui: &Ui, width: usize) -> (Vec<Line>, Vec<Line>, usize) {
    let raised = |s: Style| s.on(c().surface);
    let text = raised(theme::text());
    let muted = raised(theme::muted());
    let mut head = vec![Line::Blank];
    let mut body = Vec::new();
    let mut digits = 0;
    if approval(r) {
        head.push(spans(1, &[("△", raised(Style::fg(c().gold))), (" Permission required", text)]));
        let (title, lines) = presentation(app, r);
        if let Some(t) = title {
            head.push(spans(3, &[(&t, text)]));
        }
        head.push(Line::Blank);
        if let Some(note) = r.options.get(ui.selected).and_then(|o| o.note.as_deref()) {
            body.extend(wrap(note, width.saturating_sub(1)).into_iter().map(|l| Line::Spans(1, vec![(l, muted)])));
        } else {
            let style = if kind(r) == "bash" { text } else { muted };
            for l in lines {
                body.extend(wrap(&l, width.saturating_sub(1)).into_iter().map(|l| Line::Spans(1, vec![(l, style)])));
            }
            if let Some(lay) = diff_layout(app, r, width) {
                digits = lay.digits;
                body.extend(lay.rows.iter().cloned().map(Line::Diff));
            }
            for l in r.body.iter().flat_map(|b| b.lines()) {
                body.extend(wrap(l, width.saturating_sub(1)).into_iter().map(|l| Line::Spans(1, vec![(l, muted)])));
            }
        }
    } else {
        head.push(spans(1, &[("Question", muted)]));
        head.push(Line::Blank);
        for l in wrap(&r.title, width.saturating_sub(1)) {
            head.push(Line::Spans(1, vec![(l, text)]));
        }
        head.push(Line::Blank);
        let focused = raised(Style::fg(c().accent));
        for (i, o) in r.options.iter().enumerate() {
            let on = ui.selected == i;
            body.push(Line::Spans(1, vec![(format!("{}. ", i + 1), if on { focused } else { muted }), (o.label.clone(), if on { focused } else { text })]));
        }
        if !r.options.is_empty() {
            let on = ui.selected == r.options.len();
            let label = if ui.editing { String::new() } else { "Type your own answer".to_string() };
            body.push(Line::Spans(1, vec![(format!("{}. ", r.options.len() + 1), if on { focused } else { muted }), (label, if on { focused } else { text })]));
        }
        if let Some(a) = r.assumption.as_deref().filter(|a| !a.is_empty()) {
            body.push(Line::Blank);
            for l in wrap(&format!("If nobody answers: {a}"), width.saturating_sub(1)) {
                body.push(Line::Spans(1, vec![(l, muted)]));
            }
        }
    }
    (head, body, digits)
}

/// The rows under the box: the options and the key hints (`SessionQuestion`), or only the hints (`FormPrompt`).
fn actions_height(app: &App, r: &RequestData, width: u16) -> u16 {
    if !approval(r) {
        2
    } else if one_row(app, r, width) {
        3
    } else {
        4
    }
}

/// Whether the decisions and the hints fit on one row (`SessionQuestion` stacks them when narrow).
fn one_row(app: &App, r: &RequestData, width: u16) -> bool {
    let options: usize = r.options.iter().map(|o| o.label.width() + 3).sum();
    let hints = app.keymap.first("permission.prompt.fullscreen").width() + " fullscreen  ⇆ select  enter confirm".width();
    width >= 80 && 3 + options + 1 + hints + 3 <= width as usize
}

/// The editor rows a typed answer takes, at most 6 (`FormPrompt`'s `maxHeight`).
fn editor_rows(app: &App, ui: &Ui, width: usize) -> usize {
    if ui.editing {
        app.editor.layout(width).len().clamp(1, 6)
    } else {
        0
    }
}

fn inner_width(width: u16) -> usize {
    width.saturating_sub(5) as usize
}

/// The box's height while it is not full screen, its footer line under it included.
pub fn height(app: &App, width: u16, screen_h: u16) -> u16 {
    let Some(r) = app.request() else { return 0 };
    let ui = app.request_ui();
    let (head, body, _) = content(app, r, &ui, inner_width(width));
    let edit = editor_rows(app, &ui, inner_width(width).saturating_sub(4));
    // A typed answer to a question with options takes the place of its "Type your own answer" row.
    let edit = if !r.options.is_empty() && edit > 0 { edit - 1 } else { edit };
    let rows = head.len() + body.len() + edit + 1 + actions_height(app, r, width) as usize;
    (rows as u16).min(MAX_HEIGHT).min(screen_h.saturating_sub(4).max(6)) + 1
}

/// Draws the box at `x`, `y`, `width` wide and `h` high (its footer line under it), and returns where the cursor
/// goes when an answer is typed.
fn draw_box(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16, h: u16) -> Option<(u16, u16)> {
    let r = app.request()?;
    let ui = app.request_ui();
    let iw = inner_width(width);
    let (head, body, digits) = content(app, r, &ui, iw);
    let acts = actions_height(app, r, width);
    let surface = Style::default().on(c().surface);
    let bar = Style::fg(c().accent);
    let body_h = h.saturating_sub(acts) as usize;
    buf.fill(x, y, width, body_h as u16, surface);
    for row in 0..h {
        buf.set(x, y + row, Cell { ch: '┃', style: if (row as usize) < body_h { bar.on(c().surface) } else { bar } });
    }
    let tx = x + 2;
    let mut at = y;
    let paint = |buf: &mut Buffer, line: &Line, y: u16| match line {
        Line::Blank => {}
        Line::Spans(indent, s) => {
            let mut col = tx + indent;
            for (t, st) in s {
                col = buf.text(col, y, (tx + iw as u16).saturating_sub(col), t, *st);
            }
        }
        Line::Diff(d) => diff::paint(buf, tx + 1, y, iw.saturating_sub(1) as u16, digits, d),
    };
    for line in head.iter().take(body_h) {
        paint(buf, line, at);
        at += 1;
    }
    // The body scrolls in what is left, a row of padding under it.
    let room = (y as usize + body_h).saturating_sub(at as usize + 1);
    let edit = editor_rows(app, &ui, iw.saturating_sub(4));
    let mut cursor = None;
    if !approval(r) && ui.editing {
        // A typed answer, under the options (or alone, for a question without any), on the editor's rows.
        let ex = tx + 1 + if r.options.is_empty() { 0 } else { (r.options.len() + 1).to_string().len() as u16 + 2 };
        let keep = if r.options.is_empty() { body.len() } else { r.options.len() + 1 };
        let lines: Vec<&Line> = body.iter().take(keep).collect();
        for line in lines.iter().take(room) {
            paint(buf, line, at);
            at += 1;
        }
        let ey = if r.options.is_empty() { at } else { at - 1 };
        let ew = (tx + iw as u16).saturating_sub(ex) as usize;
        let rows = app.editor.layout(ew.max(1));
        let (crow, ccol) = app.editor.locate(&rows, app.editor.cursor());
        let first = (crow + 1).saturating_sub(edit);
        let style = Style::fg(c().accent).on(c().surface);
        if app.editor.is_empty() {
            let hint = if r.options.is_empty() { "Type your answer" } else { "Type your own answer" };
            buf.text(ex, ey, ew as u16, hint, Style::fg(c().muted).on(c().surface));
        }
        for (i, row) in rows.iter().skip(first).take(edit).enumerate() {
            let text = &app.editor.text()[row.start..row.end];
            let shown = if r.secret { "•".repeat(text.chars().count()) } else { text.to_string() };
            buf.text(ex, ey + i as u16, ew as u16, &shown, style);
        }
        cursor = Some((ex + ccol as u16, ey + (crow - first) as u16));
        at = ey + edit as u16;
        for line in body.iter().skip(keep) {
            if at as usize >= y as usize + body_h - 1 {
                break;
            }
            paint(buf, line, at);
            at += 1;
        }
    } else {
        let max = body.len().saturating_sub(room);
        let scroll = ui.scroll.min(max);
        for line in body.iter().skip(scroll).take(room) {
            paint(buf, line, at);
            at += 1;
        }
    }
    actions(app, r, &ui, buf, x, y + body_h as u16, width);
    cursor
}

/// `SessionQuestion`'s options and hints, or `FormPrompt`'s hints, on the terminal's own background.
fn actions(app: &App, r: &RequestData, ui: &Ui, buf: &mut Buffer, x: u16, y: u16, width: u16) {
    let key = theme::text();
    let word = theme::muted();
    let hints: Vec<(String, &str)> = if approval(r) {
        let full = app.keymap.first("permission.prompt.fullscreen");
        let mut h = vec![(full, if ui.expanded { "minimize" } else { "fullscreen" })];
        if r.options.len() > 1 {
            h.push(("⇆".into(), "select"));
        }
        h.push(("enter".into(), "confirm"));
        h
    } else {
        let mut h = Vec::new();
        if !ui.editing && !r.options.is_empty() {
            h.push(("↑↓".into(), "select"));
        }
        h.push(("enter".into(), "submit"));
        h.push(("esc".into(), if ui.editing && !r.options.is_empty() { "close" } else { "dismiss" }));
        h
    };
    let hint_w: usize = hints.iter().map(|(k, w)| k.width() + 1 + w.width()).sum::<usize>() + 2 * hints.len().saturating_sub(1);
    let draw_hints = |buf: &mut Buffer, hx: u16, hy: u16| {
        let mut col = hx;
        for (k, w) in &hints {
            col = buf.text(col, hy, width, k, key) + 1;
            col = buf.text(col, hy, width, w, word) + 2;
        }
    };
    if !approval(r) {
        draw_hints(buf, x + 3, y);
        return;
    }
    let mut col = x + 3;
    for (i, o) in r.options.iter().enumerate() {
        let on = ui.selected == i;
        let style = if on { Style::fg(c().surface).on(c().accent) } else { Style::fg(c().text).on(c().overlay) };
        let label = format!(" {} ", o.label);
        col = buf.text(col, y + 1, (x + width).saturating_sub(col), &label, style) + 1;
    }
    if !one_row(app, r, width) {
        draw_hints(buf, x + 3, y + 2);
    } else {
        draw_hints(buf, (x + width).saturating_sub(hint_w as u16 + 3).max(col + 1), y + 1);
    }
}

/// The box in the prompt's place, then the footer line.
pub fn draw(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16, screen_h: u16) -> Option<(u16, u16)> {
    let h = height(app, width, screen_h).saturating_sub(1);
    let ui = app.request_ui();
    let cursor = if ui.expanded { None } else { draw_box(app, buf, x, y, width, h) };
    if ui.expanded {
        // Full screen draws it over everything; this place keeps its rows.
        buf.fill(x, y, width, h, Style::default());
    }
    crate::view::footer_line(app, buf, x, y + h, width, 0);
    cursor
}

/// `SessionQuestion` full screen: from the top row to the one above the last, two columns in from each side.
pub fn draw_expanded(app: &App, buf: &mut Buffer) {
    if app.request().is_none() || !app.request_ui().expanded {
        return;
    }
    let (w, h) = (buf.width, buf.height);
    buf.fill(0, 0, w, h - 1, Style::default());
    draw_box(app, buf, 2, 0, w.saturating_sub(4), h - 1);
}
