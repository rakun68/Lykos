//! The diff viewer (P5 #46): OpenCode's `feature-plugins/system/diff-viewer.tsx` at `4332e24`. `/diff` opens it
//! on the workspace's changes (`vcs.diff`), docked beside the session when the screen is at least 108 columns wide
//! (`SESSION_PANEL_SPLIT_MIN_WIDTH`), else full screen. Each file is a card: a header with its path, ✓ once
//! reviewed and its counts, then its patch, split when the patch is at least 100 columns wide. A reviewed file
//! collapses to its header. The full layout shows a file list on the left, 30 to 40 columns wide.
use std::cell::{Cell, RefCell};
use std::collections::BTreeSet;
use std::rc::Rc;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lykos_client::{FileDiff, Item, WorkspaceDiff};
use lykos_term::{Buffer, Style};
use serde_json::json;
use unicode_width::UnicodeWidthStr;

use crate::app::{Action, App, Then};
use crate::diff;
use crate::theme::{self, c};

/// `DIFF_SOURCES`, in the order `diff.switch_source` steps through them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    /// Branch and local changes.
    Branch,
    /// Branch commits only.
    Committed,
    /// Local changes only.
    Working,
    /// What the session's latest turn wrote.
    Turn,
}

impl Source {
    pub fn label(self) -> &'static str {
        match self {
            Source::Branch => "All",
            Source::Committed => "Committed",
            Source::Working => "Uncommitted",
            Source::Turn => "Last turn",
        }
    }

    fn mode(self) -> &'static str {
        match self {
            Source::Branch => "branch",
            Source::Committed => "committed",
            Source::Working | Source::Turn => "working",
        }
    }

    fn next(self) -> Source {
        match self {
            Source::Branch => Source::Committed,
            Source::Committed => Source::Working,
            Source::Working => Source::Turn,
            Source::Turn => Source::Branch,
        }
    }
}

/// `SESSION_PANEL_SPLIT_MIN_WIDTH`: the session keeps 64 columns beside a pane of at least 44.
pub const DOCK_MIN_WIDTH: u16 = 64 + 44;
const MIN_SPLIT_WIDTH: usize = 100;
const TREE_MIN: u16 = 30;
const TREE_MAX: u16 = 40;
const INSET: u16 = 2;
/// The full layout keeps its file list while the patches stay as wide as the narrowest docked pane.
const FULL_LAYOUT_MIN_WIDTH: u16 = TREE_MIN + INSET * 2 + DOCK_MIN_WIDTH / 2;

/// One row of the viewer's body.
#[derive(Clone, Debug, PartialEq)]
pub enum Row {
    /// The space between two cards.
    Gap,
    /// A file's header, by its index in `files`.
    Head(usize),
    /// A row of a file's patch.
    Body(usize, diff::Row),
    /// A file with no patch to show.
    Empty(usize),
}

/// The body laid out: its rows, the row of each shown file's header and of each hunk, and each file's gutter.
#[derive(Debug, Default)]
pub struct Laid {
    pub rows: Vec<Row>,
    pub heads: Vec<(usize, usize)>,
    pub hunks: Vec<usize>,
    digits: Vec<usize>,
}

/// What the body depends on: the data, width, view, wrap, the files reviewed, the file `single` shows, the palette.
type Key = (u64, usize, bool, bool, u64, Option<usize>, usize);

pub struct Viewer {
    pub source: Source,
    /// `None` while loading.
    pub data: Option<Result<WorkspaceDiff, String>>,
    /// Bumped when `data` changes.
    generation: u64,
    pub scroll: usize,
    pub reviewed: BTreeSet<String>,
    reviewed_generation: u64,
    pub tree: bool,
    pub single: bool,
    /// The file `single` shows.
    pub selected: usize,
    /// `diff.toggle_view`'s choice; split by default where it fits.
    pub split: bool,
    pub fullscreen: bool,
    pub help: bool,
    /// The first `g` of `gg`.
    g: bool,
    /// The body's rows and its height, as last drawn.
    page: Cell<usize>,
    shown_rows: Cell<usize>,
    split_fits: Cell<bool>,
    /// The width, view and wrap the body was last laid out at.
    last: Cell<(usize, bool, bool)>,
    /// Where the viewer was last drawn: its first column and its width.
    area: Cell<(u16, u16)>,
    /// The layout, its first row and the screen's height as last drawn full screen: a scroll from there moves the
    /// rows in place (DECSTBM) and only the rows that came in are written.
    drawn: RefCell<Option<(Rc<Laid>, usize, u16)>>,
    laid: RefCell<Option<(Key, Rc<Laid>)>>,
}

impl Viewer {
    fn new(source: Source) -> Self {
        Viewer {
            source,
            data: None,
            generation: 0,
            scroll: 0,
            reviewed: BTreeSet::new(),
            reviewed_generation: 0,
            tree: true,
            single: false,
            selected: 0,
            split: true,
            fullscreen: false,
            help: false,
            g: false,
            page: Cell::new(20),
            shown_rows: Cell::new(0),
            split_fits: Cell::new(true),
            last: Cell::new((80, false, false)),
            area: Cell::new((0, 0)),
            drawn: RefCell::new(None),
            laid: RefCell::new(None),
        }
    }

    pub fn files(&self) -> &[FileDiff] {
        match &self.data {
            Some(Ok(d)) => &d.files,
            _ => &[],
        }
    }

    /// `sourceDetail`: what the changes are against.
    fn detail(&self) -> Option<String> {
        match (&self.data, self.source) {
            (Some(Err(_)), Source::Turn) => Some("Diff unavailable".into()),
            (_, Source::Turn) => None,
            (_, Source::Working) => Some("vs HEAD".into()),
            (Some(Err(_)), _) => Some("Base or diff unavailable".into()),
            (None, _) => Some("Resolving diff…".into()),
            (Some(Ok(d)), _) => Some(d.branch.as_ref().map_or("Base not reported".into(), |b| format!("vs {b}"))),
        }
    }

    /// The file whose card the top row is in, or the one `single` shows.
    pub fn current(&self, laid: &Laid) -> Option<usize> {
        if self.single {
            return (!self.files().is_empty()).then_some(self.selected.min(self.files().len() - 1));
        }
        laid.heads.iter().rev().find(|(_, row)| *row <= self.scroll).or(laid.heads.first()).map(|(f, _)| *f)
    }

    /// The body laid out `width` columns wide, once per change to what it shows.
    pub fn laid(&self, width: usize, split: bool, wrap: bool) -> Rc<Laid> {
        let key = (self.generation, width, split, wrap, self.reviewed_generation, self.single.then_some(self.selected), c() as *const theme::Palette as usize);
        if let Some((k, l)) = self.laid.borrow().as_ref() {
            if *k == key {
                return l.clone();
            }
        }
        let files = self.files();
        let mut out = Laid { digits: vec![0; files.len()], ..Laid::default() };
        let shown: Vec<usize> = if self.single { files.len().checked_sub(1).map(|last| vec![self.selected.min(last)]).unwrap_or_default() } else { (0..files.len()).collect() };
        for (n, &i) in shown.iter().enumerate() {
            let f = &files[i];
            if n > 0 {
                out.rows.push(Row::Gap);
            }
            out.heads.push((i, out.rows.len()));
            out.rows.push(Row::Head(i));
            if self.reviewed.contains(&f.file) {
                continue;
            }
            let hunks = diff::parse(&f.patch);
            if hunks.is_empty() {
                out.rows.push(Row::Empty(i));
                continue;
            }
            let lay = diff::layout(&hunks, width, split, wrap);
            out.digits[i] = lay.digits;
            let at = out.rows.len();
            out.hunks.extend(lay.hunks.iter().map(|h| at + h));
            out.rows.extend(lay.rows.into_iter().map(|r| Row::Body(i, r)));
        }
        let l = Rc::new(out);
        *self.laid.borrow_mut() = Some((key, l.clone()));
        l
    }

    fn max_scroll(&self) -> usize {
        self.shown_rows.get().saturating_sub(self.page.get())
    }

    fn cached(&self) -> Option<Rc<Laid>> {
        self.laid.borrow().as_ref().map(|(_, l)| l.clone())
    }
}

/// The files the session's latest turn wrote or edited, by the paths its tools reported.
fn turn_paths(app: &App) -> Vec<String> {
    let Some(s) = app.current() else { return Vec::new() };
    let start = s.items.iter().rposition(|i| matches!(i, Item::User(_))).unwrap_or(0);
    s.items[start..]
        .iter()
        .filter_map(|i| match i {
            Item::Tool { diff: Some(d), .. } => Some(d.path.replace('\\', "/")),
            _ => None,
        })
        .collect()
}

impl App {
    fn diff_cwd(&self) -> String {
        self.current().map_or_else(|| self.cwd.clone(), |s| s.summary.cwd.clone())
    }

    fn diff_call(&self, source: Source) -> Action {
        Action::Call { method: "vcs.diff", params: json!({ "cwd": self.diff_cwd(), "mode": source.mode() }), then: Then::Diff }
    }

    /// `diff.open`: opens the viewer, or closes it when open.
    pub fn open_diff(&mut self) -> Vec<Action> {
        if self.diff.take().is_some() {
            return Vec::new();
        }
        let source = Source::Branch;
        self.diff = Some(Viewer::new(source));
        vec![self.diff_call(source)]
    }

    /// `vcs.diff`'s answer.
    pub fn on_diff(&mut self, result: Result<serde_json::Value, String>) {
        let paths = turn_paths(self);
        let Some(v) = self.diff.as_mut() else { return };
        let mut data = result.and_then(|v| serde_json::from_value::<WorkspaceDiff>(v).map_err(|e| e.to_string()));
        if v.source == Source::Turn {
            if let Ok(d) = &mut data {
                d.files.retain(|f| paths.iter().any(|p| p == &f.file || p.ends_with(&format!("/{}", f.file))));
            }
        }
        v.data = Some(data);
        v.generation += 1;
        v.scroll = 0;
        v.selected = 0;
    }

    /// The wheel over the viewer scrolls it.
    pub fn diff_mouse(&mut self, m: &crossterm::event::MouseEvent) -> bool {
        let Some(v) = self.diff.as_mut() else { return false };
        let (x, w) = v.area.get();
        if m.column < x || m.column >= x + w {
            return false;
        }
        v.scroll = if m.kind == crossterm::event::MouseEventKind::ScrollUp { v.scroll.saturating_sub(3) } else { (v.scroll + 3).min(v.max_scroll()) };
        true
    }

    /// A key while the viewer is open: it takes every key but ctrl+c.
    pub fn diff_key(&mut self, key: &KeyEvent) -> Option<Vec<Action>> {
        let ids = self.keymap.matches(key, false);
        let v = self.diff.as_mut()?;
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('c') {
            return None;
        }
        if v.help {
            v.help = false;
            return Some(Vec::new());
        }
        let g = std::mem::take(&mut v.g);
        if key.code == KeyCode::Char('g') && key.modifiers.difference(KeyModifiers::SHIFT).is_empty() {
            if g {
                v.scroll = 0;
            } else {
                v.g = true;
            }
            return Some(Vec::new());
        }
        let page = v.page.get().max(1);
        let laid = v.cached().unwrap_or_default();
        let Some(id) = ids.iter().find(|id| id.starts_with("diff.")) else {
            // The palette and the other ctrl and alt keys still work over it.
            return if key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) { None } else { Some(Vec::new()) };
        };
        match *id {
            "diff.close" => self.diff = None,
            "diff.down" => v.scroll += 1,
            "diff.up" => v.scroll = v.scroll.saturating_sub(1),
            "diff.page.down" => v.scroll += page,
            "diff.page.up" => v.scroll = v.scroll.saturating_sub(page),
            "diff.half_page.down" => v.scroll += page / 2,
            "diff.half_page.up" => v.scroll = v.scroll.saturating_sub(page / 2),
            "diff.first" => v.scroll = 0,
            "diff.last" => v.scroll = v.max_scroll(),
            "diff.next_hunk" => {
                if let Some(&h) = laid.hunks.iter().find(|&&h| h > v.scroll) {
                    v.scroll = h;
                }
            }
            "diff.previous_hunk" => {
                if let Some(&h) = laid.hunks.iter().rev().find(|&&h| h < v.scroll) {
                    v.scroll = h;
                }
            }
            "diff.next_file" | "diff.previous_file" => {
                let step: isize = if *id == "diff.next_file" { 1 } else { -1 };
                if v.single {
                    let n = v.files().len();
                    if n > 0 {
                        v.selected = (v.selected as isize + step).clamp(0, n as isize - 1) as usize;
                        v.scroll = 0;
                    }
                } else if let Some(cur) = v.current(&laid) {
                    let at = laid.heads.iter().position(|(f, _)| *f == cur).unwrap_or(0) as isize;
                    // Back from inside a card goes to its own header first.
                    let at = if step < 0 && laid.heads.get(at as usize).is_some_and(|(_, row)| *row < v.scroll) { at + 1 } else { at };
                    if let Some((_, row)) = laid.heads.get((at + step).max(0) as usize) {
                        v.scroll = *row;
                    }
                }
            }
            "diff.toggle_file_tree" => v.tree = !v.tree,
            "diff.single_patch" => {
                let cur = v.current(&laid).unwrap_or(0);
                v.single = !v.single;
                v.selected = cur;
                v.scroll = 0;
                if !v.single {
                    // Back to every file, on the one it showed.
                    v.scroll = laid_head_row(v, cur);
                }
            }
            "diff.switch_source" => {
                v.source = v.source.next();
                v.data = None;
                v.generation += 1;
                let source = v.source;
                return Some(vec![self.diff_call(source)]);
            }
            "diff.toggle_view" => {
                if v.split_fits.get() {
                    v.split = !v.split;
                }
            }
            "diff.toggle_fullscreen" => v.fullscreen = !v.fullscreen,
            "diff.mark_reviewed" => {
                let Some(cur) = v.current(&laid) else { return Some(Vec::new()) };
                let file = v.files()[cur].file.clone();
                let now = !v.reviewed.remove(&file);
                if now {
                    v.reviewed.insert(file);
                }
                v.reviewed_generation += 1;
                if v.single && now {
                    v.selected = (cur + 1).min(v.files().len() - 1);
                    v.scroll = 0;
                } else if !v.single {
                    v.scroll = laid_head_row(v, cur);
                }
            }
            "diff.help" => v.help = true,
            _ => {}
        }
        if let Some(v) = self.diff.as_mut() {
            v.scroll = v.scroll.min(v.max_scroll());
        }
        Some(Vec::new())
    }
}

/// The row of file `f`'s header once the body is laid out again, at the width it was last drawn.
fn laid_head_row(v: &Viewer, f: usize) -> usize {
    let (width, split, wrap) = v.last.get();
    v.laid(width, split, wrap).heads.iter().find(|(i, _)| *i == f).map_or(0, |(_, row)| *row)
}

/// Where the viewer goes at this screen width: `Some(width)` docked on the right, `None` full screen.
pub fn dock_width(app: &App, w: u16) -> Option<u16> {
    let v = app.diff.as_ref()?;
    (!v.fullscreen && w >= DOCK_MIN_WIDTH).then(|| (w / 2).max(44))
}

/// The session's width beside the viewer.
pub fn session_width(app: &App, w: u16) -> u16 {
    match dock_width(app, w) {
        Some(d) => w - d,
        None => w,
    }
}

/// Draws the viewer over the screen, or in its docked place.
pub fn draw(app: &App, buf: &mut Buffer) {
    let Some(v) = app.diff.as_ref() else { return };
    let (w, h) = (buf.width, buf.height);
    let (x, width, docked) = match dock_width(app, w) {
        Some(d) => (w - d, d, true),
        None => (0, w, false),
    };
    v.area.set((x, width));
    let surface = if docked { Style::default().on(c().surface) } else { Style::default() };
    // Full screen draws on the cleared frame; docked, on the raised surface.
    if docked {
        buf.fill(x, 0, width, h, surface);
    }
    let compact = docked || width < FULL_LAYOUT_MIN_WIDTH;
    let files = v.files();
    let tree = !compact && v.tree && !files.is_empty();
    let tree_w = if tree { (width / 4).clamp(TREE_MIN, TREE_MAX) } else { 0 };
    let inset = if compact { 0 } else { INSET };
    // The header: the source, what it is against, and the files reviewed.
    let hy = u16::from(docked);
    let bg = surface.bg;
    let on = |s: Style| if docked { s.on(c().surface) } else { s };
    let mut col = buf.text(x + 2, hy, width.saturating_sub(4), v.source.label(), on(Style::fg(c().accent).bold()));
    if let Some(d) = v.detail() {
        col = buf.text(col, hy, (x + width).saturating_sub(col + 8), &format!(" · {d}"), on(theme::muted()));
    }
    let _ = col;
    let count = format!("{}/{}", files.iter().filter(|f| v.reviewed.contains(&f.file)).count(), files.len());
    buf.text((x + width).saturating_sub(count.width() as u16 + 2), hy, count.width() as u16, &count, on(theme::muted()));
    let top = hy + 1;
    let footer = u16::from(compact);
    let body_h = h.saturating_sub(top + footer) as usize;
    v.page.set(body_h);
    if compact {
        let close = app.keymap.first("diff.close");
        let help = app.keymap.first("diff.help");
        buf.text(x + 2, h - 1, width.saturating_sub(4), &format!("{help} more shortcuts · {close} close"), on(theme::muted()));
    }
    let message = match &v.data {
        None => Some(("Loading diff…".to_string(), theme::muted())),
        Some(Err(e)) => Some((format!("Could not load diff: {e}"), Style::fg(c().love))),
        Some(Ok(_)) if files.is_empty() => Some(("No changes to show".to_string(), theme::muted())),
        _ => None,
    };
    if let Some((text, style)) = message {
        buf.text(x + 2, top + 1, width.saturating_sub(4), &text, on(style));
        v.shown_rows.set(0);
        if v.help {
            help(app, buf, x, width);
        }
        return;
    }
    let laid_x = x + tree_w + inset;
    let pane = (width - tree_w).saturating_sub(2 * inset) as usize;
    let fits = pane >= MIN_SPLIT_WIDTH;
    v.split_fits.set(fits);
    v.last.set((pane, fits && v.split, app.prefs.diff_wrap));
    let laid = v.laid(pane, fits && v.split, app.prefs.diff_wrap);
    v.shown_rows.set(laid.rows.len());
    let scroll = v.scroll.min(laid.rows.len().saturating_sub(body_h));
    let before = v.drawn.replace(if docked || v.help { None } else { Some((laid.clone(), scroll, h)) });
    if let Some((prev, at, ph)) = before.filter(|(prev, at, ph)| !docked && !v.help && Rc::ptr_eq(prev, &laid) && *ph == h && *at != scroll) {
        let _ = (prev, ph);
        let by = scroll as i64 - at as i64;
        if by.unsigned_abs() < body_h as u64 {
            buf.scroll = Some(lykos_term::Scroll { top, rows: body_h as u16, by: by as i32 });
        }
    }
    let current = v.current(&laid);
    if tree {
        // The file list: each file's path, ✓ once reviewed, and its counts; the current one raised.
        for (i, f) in files.iter().enumerate().take(body_h) {
            let y = top + i as u16;
            let here = current == Some(i);
            let style = if here { Style::default().on(c().overlay) } else { Style::default() };
            buf.fill(x, y, tree_w, 1, style);
            let counts = format!("+{} -{}", f.additions, f.deletions);
            let mark = if v.reviewed.contains(&f.file) { "✓ " } else { "  " };
            let path_w = tree_w.saturating_sub(counts.width() as u16 + 4);
            let c0 = buf.text(x + 1, y, 2, mark, Style::fg(c().pine).on(style.bg));
            buf.text(c0, y, path_w.saturating_sub(2), &f.file, Style::fg(if v.reviewed.contains(&f.file) { c().muted } else { c().text }).on(style.bg));
            let cx = x + tree_w - 1 - counts.width() as u16;
            let after = buf.text(cx, y, 20, &format!("+{}", f.additions), Style::fg(c().pine).on(style.bg));
            buf.text(after + 1, y, 20, &format!("-{}", f.deletions), Style::fg(c().love).on(style.bg));
        }
    }
    for (r, row) in laid.rows.iter().enumerate().skip(scroll).take(body_h) {
        paint_row(v, files, &laid, buf, laid_x, top + (r - scroll) as u16, pane as u16, row);
    }
    let _ = bg;
    if v.help {
        help(app, buf, x, width);
    }
}

/// One row of the body, `pane` columns wide at `x`, `y`.
#[allow(clippy::too_many_arguments)]
fn paint_row(v: &Viewer, files: &[FileDiff], laid: &Laid, buf: &mut Buffer, x: u16, y: u16, pane: u16, row: &Row) {
    match row {
        Row::Gap => {}
        Row::Head(i) => {
            let f = &files[*i];
            let reviewed = v.reviewed.contains(&f.file);
            let card = Style::default().on(if reviewed { c().overlay } else { c().surface });
            buf.fill(x, y, pane, 1, card);
            let counts_w = (f.additions.to_string().len() + f.deletions.to_string().len() + 3) as u16 + if reviewed { 2 } else { 0 };
            buf.text(x + 1, y, pane.saturating_sub(counts_w + 3), &f.file, Style::fg(if reviewed { c().muted } else { c().text }).on(card.bg).bold());
            let mut cx = (x + pane).saturating_sub(counts_w + 1);
            if reviewed {
                cx = buf.text(cx, y, 2, "✓ ", Style::fg(c().pine).on(card.bg));
            }
            cx = buf.text(cx, y, 12, &format!("+{}", f.additions), Style::fg(if reviewed { c().muted } else { c().pine }).on(card.bg));
            buf.text(cx + 1, y, 12, &format!("-{}", f.deletions), Style::fg(if reviewed { c().muted } else { c().love }).on(card.bg));
        }
        Row::Body(i, r) => diff::paint(buf, x, y, pane, laid.digits[*i], r),
        Row::Empty(_) => {
            buf.fill(x, y, pane, 1, Style::default().on(c().surface));
            buf.text(x + 2, y, pane, "Binary file or too large to show", theme::muted().on(c().surface));
        }
    }
}

/// `DiffViewerHelpDialog`: the viewer's keys, by group.
fn help(app: &App, buf: &mut Buffer, x: u16, width: u16) {
    let k = |ids: &[&str]| ids.iter().map(|id| app.keymap.first(id)).collect::<Vec<_>>().join(" / ");
    let rows: Vec<(String, &str)> = vec![
        (k(&["diff.next_file"]), "Next file"),
        (k(&["diff.previous_file"]), "Previous file"),
        (k(&["diff.mark_reviewed"]), if app.diff.as_ref().is_some_and(|v| v.single) { "Review + next / reopen" } else { "Review + collapse / reopen" }),
        (k(&["diff.next_hunk", "diff.previous_hunk"]), "Next / previous change"),
        (k(&["diff.down", "diff.up"]), "Down / up"),
        (k(&["diff.half_page.down", "diff.half_page.up"]), "Half page down / up"),
        (k(&["diff.page.down", "diff.page.up"]), "Page down / up"),
        (format!("gg / {}", app.keymap.first("diff.last")), "First / last"),
        (k(&["diff.toggle_view"]), "Split / unified"),
        (k(&["diff.single_patch"]), "All files / single file"),
        (k(&["diff.toggle_file_tree"]), "Show / hide file list"),
        (k(&["diff.switch_source"]), "Switch diff source"),
        (k(&["diff.toggle_fullscreen"]), "Full screen / docked"),
        (k(&["diff.close"]), "Close diff viewer"),
    ];
    let bw = 44.min(width.saturating_sub(2));
    let bh = rows.len() as u16 + 4;
    let bx = x + (width.saturating_sub(bw)) / 2;
    let by = (buf.height.saturating_sub(bh)) / 2;
    let style = Style::default().on(c().overlay);
    buf.fill(bx, by, bw, bh, style);
    buf.text(bx + 2, by + 1, bw - 4, "Diff viewer shortcuts", theme::text().on(c().overlay).bold());
    for (i, (keys, label)) in rows.iter().enumerate() {
        let y = by + 3 + i as u16;
        buf.text(bx + 2, y, 17, keys, theme::text().on(c().overlay));
        buf.text(bx + 20, y, bw.saturating_sub(22), label, theme::muted().on(c().overlay));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::{KeyEvent, KeyModifiers};
    use std::time::Instant;

    fn patch(name: &str, lines: usize) -> String {
        let mut p = format!("diff --git a/{name} b/{name}\n--- a/{name}\n+++ b/{name}\n@@ -1,{lines} +1,{lines} @@\n");
        for i in 0..lines {
            p.push_str(&format!("-old {i}\n+new {i}\n"));
        }
        p
    }

    fn file(name: &str, lines: usize) -> serde_json::Value {
        json!({ "file": name, "status": "modified", "additions": lines, "deletions": lines, "patch": patch(name, lines) })
    }

    fn open(files: Vec<serde_json::Value>) -> App {
        let mut app = App::new("/w".into());
        app.connected();
        let out = app.open_diff();
        assert_eq!(out, vec![Action::Call { method: "vcs.diff", params: json!({ "cwd": "/w", "mode": "branch" }), then: Then::Diff }]);
        app.on_reply(Then::Diff, Ok(json!({ "base": "abc", "branch": "main", "files": files })));
        app
    }

    fn screen(app: &App, w: u16, h: u16) -> String {
        let mut buf = Buffer::new(w, h);
        crate::view::draw(app, &mut buf);
        (0..h).map(|y| (0..w).map(|x| buf.get(x, y).ch).filter(|c| *c != '\0').collect::<String>() + "\n").collect()
    }

    fn press(app: &mut App, code: KeyCode) -> Vec<Action> {
        app.on_key(KeyEvent::new(code, KeyModifiers::NONE), Instant::now(), 10)
    }

    #[test]
    fn it_opens_on_the_branch_and_shows_each_file_as_a_card() {
        let app = open(vec![file("a.rs", 2), file("b.rs", 1)]);
        let s = screen(&app, 80, 24);
        assert!(s.contains("All · vs main") && s.contains("0/2"), "{s}");
        assert!(s.contains("a.rs") && s.contains("+2") && s.contains("-2") && s.contains("old 0") && s.contains("new 1"), "{s}");
        assert!(s.contains("more shortcuts"), "narrow: the compact layout's footer: {s}");
    }

    #[test]
    fn keys_move_by_file_and_hunk_and_mark_files_reviewed() {
        let mut app = open(vec![file("a.rs", 30), file("b.rs", 30), file("c.rs", 30)]);
        screen(&app, 80, 24);
        press(&mut app, KeyCode::Char('n'));
        let v = app.diff.as_ref().unwrap();
        let laid = v.cached().unwrap();
        assert_eq!(v.scroll, laid.heads[1].1, "n: the next file's header");
        assert_eq!(v.current(&laid), Some(1));
        press(&mut app, KeyCode::Char('m'));
        screen(&app, 80, 24);
        let v = app.diff.as_ref().unwrap();
        assert!(v.reviewed.contains("b.rs"));
        let laid = v.cached().unwrap();
        assert_eq!(v.scroll, laid.heads[1].1, "it stays on the card it collapsed");
        assert_eq!(laid.heads[2].1, laid.heads[1].1 + 2, "a reviewed card is only its header");
        assert!(screen(&app, 80, 24).contains("1/3"));
        press(&mut app, KeyCode::Char('p'));
        assert_eq!(app.diff.as_ref().unwrap().scroll, 0);
        press(&mut app, KeyCode::Char(']'));
        press(&mut app, KeyCode::Char(']'));
        let v = app.diff.as_ref().unwrap();
        assert_eq!(v.scroll, v.cached().unwrap().hunks[1], "]: the next hunk");
        app.on_key(KeyEvent::new(KeyCode::Char('G'), KeyModifiers::SHIFT), Instant::now(), 10);
        let v = app.diff.as_ref().unwrap();
        assert_eq!(v.scroll, v.max_scroll());
        press(&mut app, KeyCode::Char('g'));
        press(&mut app, KeyCode::Char('g'));
        assert_eq!(app.diff.as_ref().unwrap().scroll, 0, "gg: the start");
        press(&mut app, KeyCode::Char('j'));
        assert_eq!(app.diff.as_ref().unwrap().scroll, 1);
    }

    #[test]
    fn single_patch_shows_one_file_and_review_moves_on() {
        let mut app = open(vec![file("a.rs", 3), file("b.rs", 3)]);
        screen(&app, 80, 24);
        press(&mut app, KeyCode::Char('s'));
        let s = screen(&app, 80, 24);
        assert!(s.contains("a.rs") && !s.contains("b.rs"), "{s}");
        press(&mut app, KeyCode::Char('m'));
        let s = screen(&app, 80, 24);
        assert!(s.contains("b.rs") && !s.contains("a.rs"), "review + next: {s}");
        assert_eq!(app.diff.as_ref().unwrap().selected, 1);
    }

    #[test]
    fn the_view_source_tree_and_full_screen_toggle_and_esc_closes() {
        let mut app = open(vec![file("a.rs", 3)]);
        // Docked at 160 columns: 80 for the viewer, too narrow to split.
        screen(&app, 160, 30);
        assert_eq!(dock_width(&app, 160), Some(80));
        assert!(!app.diff.as_ref().unwrap().split_fits.get());
        press(&mut app, KeyCode::Char('f'));
        assert_eq!(dock_width(&app, 160), None, "full screen");
        let s = screen(&app, 160, 30);
        assert_eq!(s.matches("a.rs").count(), 2, "the file list and the card: {s}");
        let v = app.diff.as_ref().unwrap();
        assert!(v.split_fits.get(), "full screen, the patch is wide enough to split");
        assert!(matches!(v.cached().unwrap().rows[1], Row::Body(_, diff::Row::Header(_))));
        assert!(matches!(v.cached().unwrap().rows[2], Row::Body(_, diff::Row::Split(..))));
        press(&mut app, KeyCode::Char('v'));
        screen(&app, 160, 30);
        assert!(matches!(app.diff.as_ref().unwrap().cached().unwrap().rows[2], Row::Body(_, diff::Row::Unified(_))));
        press(&mut app, KeyCode::Char('b'));
        assert_eq!(screen(&app, 160, 30).matches("a.rs").count(), 1, "the file list hidden");
        let out = press(&mut app, KeyCode::Char('d'));
        assert_eq!(out, vec![Action::Call { method: "vcs.diff", params: json!({ "cwd": "/w", "mode": "committed" }), then: Then::Diff }]);
        assert!(screen(&app, 160, 30).contains("Loading diff…"));
        app.on_reply(Then::Diff, Ok(json!({ "files": [] })));
        assert!(screen(&app, 160, 30).contains("No changes to show"));
        press(&mut app, KeyCode::Char('?'));
        assert!(screen(&app, 160, 30).contains("Diff viewer shortcuts"));
        press(&mut app, KeyCode::Char('x'));
        press(&mut app, KeyCode::Esc);
        assert!(app.diff.is_none());
    }

    #[test]
    fn last_turn_keeps_the_files_the_turn_wrote() {
        let mut app = App::new("/w".into());
        app.connected();
        app.started("s1".into());
        let ev = |seq, data| lykos_client::Event { event: "x".into(), session: "s1".into(), seq, data };
        let summary = lykos_client::SessionSummary { id: "s1".into(), cwd: "C:/w".into(), status: lykos_client::SessionStatus::Idle, model: "m".into(), title: None, started_at: "x".into(), origin: "tui".into(), ledger_session_id: None };
        app.on_event(&ev(1, lykos_client::EventData::SessionStatus { session: summary }));
        app.on_event(&ev(2, lykos_client::EventData::MessageUser { text: "go".into() }));
        app.on_event(&ev(3, lykos_client::EventData::ToolStart { tool_id: "t1".into(), name: "edit".into(), summary: "b.rs".into(), args: serde_json::Value::Null }));
        app.on_event(&ev(4, lykos_client::EventData::ToolEnd { tool_id: "t1".into(), name: "edit".into(), ok: true, preview: None, diff: Some(lykos_client::DiffData { path: "C:\\w\\src\\b.rs".into(), lines: Vec::new() }) }));
        app.open_diff();
        for _ in 0..3 {
            press(&mut app, KeyCode::Char('d'));
        }
        assert_eq!(app.diff.as_ref().unwrap().source, Source::Turn);
        app.on_reply(Then::Diff, Ok(json!({ "base": "HEAD", "files": [file("src/a.rs", 1), file("src/b.rs", 1)] })));
        assert_eq!(app.diff.as_ref().unwrap().files().iter().map(|f| f.file.as_str()).collect::<Vec<_>>(), ["src/b.rs"]);
    }

    #[test]
    fn a_five_thousand_line_diff_lays_out_once_and_scrolling_reuses_it() {
        let mut app = open(vec![file("big.rs", 2500)]);
        screen(&app, 120, 40);
        let first = app.diff.as_ref().unwrap().cached().unwrap();
        assert!(first.rows.len() > 5000);
        for _ in 0..50 {
            press(&mut app, KeyCode::PageDown);
            screen(&app, 120, 40);
        }
        assert!(Rc::ptr_eq(&first, &app.diff.as_ref().unwrap().cached().unwrap()), "scrolling reuses the layout");
    }
}
