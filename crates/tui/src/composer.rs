//! What a session has running, in the prompt box's place (P5 #48): OpenCode's composer at `4332e24`
//! (`routes/session/composer/index.tsx`, `tabs.ts`, `subagents-tab.tsx`, `shell-tab.tsx`, `scripts-tab.tsx`,
//! `terminals-tab.tsx`), the footer's live counts (`feature-plugins/prompt/footer.tsx`) and a background shell's
//! output (`component/dialog-shell-output.tsx`).
//!
//! Lykos's subagents run inside the turn (the `agent` tool), so the Subagents tab lists this session's `agent` calls
//! and interrupting one interrupts the turn. Its scripts are `eval` calls. Its shells are the session's background
//! jobs (`hub` and calls moved to the background with `session.background`).
use std::time::Instant;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lykos_client::{Item, JobLog, ToolState};
use serde_json::json;

use crate::app::{Action, App, Dialog, Nav, Then};
use crate::theme::{self, c};
use lykos_term::{Buffer, Cell, Style};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tab {
    Subagents,
    Shell,
    Scripts,
    Terminals,
}

impl Tab {
    fn label(self) -> &'static str {
        match self {
            Tab::Subagents => "Subagents",
            Tab::Shell => "Shell",
            Tab::Scripts => "Scripts",
            Tab::Terminals => "Terminals",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Composer {
    pub tab: Tab,
    pub selected: usize,
}

/// One row of a tab.
pub struct Entry {
    pub label: String,
    pub status: &'static str,
    /// A job's id, a subagent's index among the session's `agent` calls, or a terminal's index.
    pub key: String,
}

/// The most a tab shows at once (`maxHeight={5}`).
const ROWS: usize = 5;
/// `dialog-shell-output.tsx` `PAGE_BYTES`: the output kept, from its end.
pub const OUTPUT_BYTES: usize = 64 * 1024;
/// How often an open output view reads more.
const POLL_MS: u128 = 500;

/// `tabs.ts` `busyCounts`: running scripts, subagents and shells.
pub fn counts(app: &App) -> (usize, usize, usize) {
    let Some(s) = app.current() else { return (0, 0, 0) };
    let running = |name: &str| s.items.iter().filter(|it| matches!(it, Item::Tool { name: n, state: ToolState::Running, .. } if n == name)).count();
    (running("eval"), running("agent"), s.jobs.iter().filter(|j| j.status == "running").count())
}

/// `tabs.ts` `busyTab`: the first tab with something running, else Subagents.
pub fn busy_tab(app: &App) -> Tab {
    match counts(app) {
        (s, _, _) if s > 0 => Tab::Scripts,
        (_, a, _) if a > 0 => Tab::Subagents,
        (_, _, j) if j > 0 => Tab::Shell,
        _ => Tab::Subagents,
    }
}

/// `footer.tsx` `live`: `1 script · 2 subagents · 1 shell`.
pub fn live(app: &App) -> Option<String> {
    let (s, a, j) = counts(app);
    let label = |n: usize, noun: &str| (n > 0).then(|| format!("{n} {noun}{}", if n == 1 { "" } else { "s" }));
    let parts: Vec<String> = [label(s, "script"), label(a, "subagent"), label(j, "shell")].into_iter().flatten().collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// The tabs in their fixed order; Scripts only while one runs.
pub fn tabs(app: &App) -> Vec<Tab> {
    let mut out = vec![Tab::Subagents, Tab::Shell];
    if counts(app).0 > 0 {
        out.push(Tab::Scripts);
    }
    out.push(Tab::Terminals);
    out
}

pub fn entries(app: &App, tab: Tab) -> Vec<Entry> {
    let Some(s) = app.current() else { return Vec::new() };
    match tab {
        Tab::Subagents => s
            .items
            .iter()
            .filter_map(|it| match it {
                Item::Tool { name, summary, state, .. } if name == "agent" => Some((summary, state)),
                _ => None,
            })
            .enumerate()
            .map(|(i, (summary, state))| Entry { label: format!("agent: {}", first_line(summary)), status: if *state == ToolState::Running { "Running" } else { "" }, key: i.to_string() })
            .collect(),
        Tab::Shell => s.jobs.iter().filter(|j| j.status == "running").map(|j| Entry { label: first_line(&j.command).to_string(), status: "", key: j.id.clone() }).collect(),
        Tab::Scripts => s
            .items
            .iter()
            .filter_map(|it| match it {
                Item::Tool { name, summary, state: ToolState::Running, .. } if name == "eval" => Some(Entry { label: first_line(summary).to_string(), status: "", key: String::new() }),
                _ => None,
            })
            .collect(),
        Tab::Terminals => {
            let mut out: Vec<Entry> = app.terms.iter().enumerate().map(|(i, t)| Entry { label: t.title(), status: "", key: i.to_string() }).collect();
            out.push(Entry { label: "+ New terminal".into(), status: "", key: "new".into() });
            out
        }
    }
}

fn first_line(s: &str) -> &str {
    s.lines().next().unwrap_or("")
}

impl App {
    /// `session.child.first`: opens the composer on `tab`, or on the busiest tab; closes it when open.
    pub fn toggle_composer(&mut self, tab: Option<Tab>) -> Vec<Action> {
        if self.composer.is_some() && tab.is_none() {
            self.composer = None;
        } else {
            let tab = tab.unwrap_or_else(|| busy_tab(self));
            let selected = if tab == Tab::Terminals { self.terms.visible.unwrap_or(0) } else { 0 };
            self.composer = Some(Composer { tab, selected });
            self.terms.focused = false;
        }
        Vec::new()
    }

    /// The composer's keys (`index.tsx` and each tab's layer). `None` lets the key go on: the leader, and a key the
    /// composer does not take.
    pub fn composer_key(&mut self, key: &KeyEvent) -> Option<Vec<Action>> {
        let mut comp = self.composer.clone()?;
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        let list = tabs(self);
        if !list.contains(&comp.tab) {
            comp.tab = list[0];
            comp.selected = 0;
        }
        let rows = entries(self, comp.tab);
        let n = rows.len();
        let session = self.session.clone().unwrap_or_default();
        let mut out = Vec::new();
        match key.code {
            KeyCode::Esc => {
                self.composer = None;
                return Some(out);
            }
            KeyCode::Char('c') if ctrl => {
                self.composer = None;
                return Some(out);
            }
            KeyCode::Left | KeyCode::Right if !ctrl => {
                let i = list.iter().position(|t| *t == comp.tab).unwrap_or(0) as isize;
                let step = if key.code == KeyCode::Left { -1 } else { 1 };
                comp.tab = list[(i + step).rem_euclid(list.len() as isize) as usize];
                comp.selected = if comp.tab == Tab::Terminals { self.terms.visible.unwrap_or(0) } else { 0 };
            }
            // `composer.*.up`: past the first row, the composer closes.
            KeyCode::Up | KeyCode::Char('k') if !ctrl && (key.code == KeyCode::Up || comp.tab == Tab::Terminals) => {
                if comp.tab == Tab::Terminals {
                    comp.selected = (comp.selected + n - 1) % n.max(1);
                } else if comp.selected == 0 {
                    self.composer = None;
                    return Some(out);
                } else {
                    comp.selected -= 1;
                }
            }
            KeyCode::Down | KeyCode::Char('j') if !ctrl && (key.code == KeyCode::Down || comp.tab == Tab::Terminals) => {
                if n > 0 {
                    comp.selected = (comp.selected + 1) % n;
                }
            }
            KeyCode::Enter => {
                let Some(row) = rows.get(comp.selected) else { return Some(out) };
                match comp.tab {
                    // `composer.shell.select`: its output.
                    Tab::Shell => {
                        let command = self.current().and_then(|s| s.jobs.iter().find(|j| j.id == row.key)).map(|j| j.command.clone()).unwrap_or_default();
                        self.dialog = Some(Dialog::Output { job: row.key.clone(), command, text: String::new(), offset: None, scroll: 0, error: None });
                        self.poll = None;
                        out.extend(self.poll_output(Instant::now()));
                    }
                    // `composer.subagent.select`: its session.
                    Tab::Subagents => {
                        self.composer = None;
                        if self.ledger_id().is_some() {
                            out.push(self.history_call(false, Then::Navigate(Nav::ChildAt(row.key.parse().unwrap_or(0)))));
                        }
                        return Some(out);
                    }
                    Tab::Scripts => {}
                    // `composer.terminal.select`: shows it, or opens a new one.
                    Tab::Terminals => {
                        self.composer = None;
                        return Some(if row.key == "new" { self.open_terminal() } else { self.select_terminal(comp.selected) });
                    }
                }
            }
            // `composer.shell.kill`, `composer.subagent.interrupt`, `composer.script.cancel`.
            KeyCode::Char('d') if ctrl => match comp.tab {
                Tab::Shell => {
                    if let Some(row) = rows.get(comp.selected) {
                        out.push(Action::Call { method: "session.job.stop", params: json!({ "session": session, "jobId": row.key }), then: Then::Quiet });
                    }
                }
                Tab::Subagents | Tab::Scripts => {
                    if rows.get(comp.selected).is_some_and(|r| comp.tab == Tab::Scripts || r.status == "Running") {
                        out.push(Action::Interrupt { session });
                    }
                }
                Tab::Terminals => {}
            },
            _ if self.keymap.is_leader(key) => return None,
            KeyCode::Char(_) | KeyCode::Up | KeyCode::Down | KeyCode::Tab | KeyCode::Backspace => {}
            _ => return None,
        }
        if self.composer.is_some() {
            self.composer = Some(comp);
        }
        Some(out)
    }

    /// The shell output view reads what its job wrote since it last read, every half second while it is open.
    pub fn poll_output(&mut self, now: Instant) -> Vec<Action> {
        let Some(Dialog::Output { job, offset, .. }) = &self.dialog else { return Vec::new() };
        if self.poll.is_some_and(|(at, waiting)| waiting || now.duration_since(at).as_millis() < POLL_MS) {
            return Vec::new();
        }
        self.poll = Some((now, true));
        let session = self.session.clone().unwrap_or_default();
        let params = match offset {
            Some(o) => json!({ "session": session, "jobId": job, "offset": o }),
            None => json!({ "session": session, "jobId": job }),
        };
        vec![Action::Call { method: "session.job.logs", params, then: Then::JobLog(job.clone()) }]
    }

    /// `session.job.logs`' answer, for the output view if it still shows that job.
    pub fn on_job_log(&mut self, id: &str, result: Result<serde_json::Value, String>) {
        self.poll = self.poll.map(|(at, _)| (at, false));
        let Some(Dialog::Output { job, text, offset, error, .. }) = &mut self.dialog else { return };
        if job != id {
            return;
        }
        match result.and_then(|v| serde_json::from_value::<JobLog>(v).map_err(|e| e.to_string())) {
            Ok(log) => {
                text.push_str(&log.text.replace("\r\n", "\n").replace('\r', "\n"));
                if text.len() > OUTPUT_BYTES {
                    let mut cut = text.len() - OUTPUT_BYTES;
                    while !text.is_char_boundary(cut) {
                        cut += 1;
                    }
                    text.drain(..cut);
                }
                *offset = Some(log.next_offset);
                *error = None;
            }
            Err(e) => *error = Some(e),
        }
    }
}

/// The composer's height in the prompt box's place: a row of padding, the tabs, a gap, the rows, a gap, the hints,
/// a row of padding.
pub fn height(app: &App) -> u16 {
    let Some(comp) = &app.composer else { return 0 };
    let n = entries(app, comp.tab).len().clamp(1, ROWS);
    n as u16 + 6
}

/// `index.tsx`: a left border on a raised background, the tabs (the active one bold) and `esc` on the right, the
/// active tab's rows (the selected one on the accent), and the keys it takes.
pub fn draw(app: &App, buf: &mut Buffer, x: u16, y: u16, width: u16) {
    let Some(comp) = &app.composer else { return };
    let h = height(app);
    let raised = Style::default().on(c().surface);
    buf.fill(x, y, width, h, raised);
    for row in 0..h {
        buf.set(x, y + row, Cell { ch: '┃', style: Style::fg(c().overlay).on(c().surface) });
    }
    let (tx, tw) = (x + 3, width.saturating_sub(6));
    let list = tabs(app);
    let mut col = tx;
    for t in &list {
        let style = if *t == comp.tab { theme::text().on(c().surface).bold() } else { theme::muted().on(c().surface) };
        col = buf.text(col, y + 1, (tx + tw).saturating_sub(col), t.label(), style) + 2;
    }
    buf.text(tx + tw.saturating_sub(3), y + 1, 3, "esc", theme::muted().on(c().surface));
    let rows = entries(app, comp.tab);
    let first = (comp.selected + 1).saturating_sub(ROWS);
    if rows.is_empty() {
        let empty = match comp.tab {
            Tab::Subagents => " No subagents",
            Tab::Shell => " No shell commands",
            Tab::Scripts => " No scripts",
            Tab::Terminals => " No terminals",
        };
        buf.text(tx, y + 3, tw, empty, theme::muted().on(c().surface));
    }
    for (i, e) in rows.iter().enumerate().skip(first).take(ROWS) {
        let ry = y + 3 + (i - first) as u16;
        let on = i == comp.selected;
        let bg = if on { c().accent } else { c().surface };
        buf.fill(tx, ry, tw, 1, Style::default().on(bg));
        let fg = if on { Style::fg(c().surface).on(bg).bold() } else { theme::text().on(bg) };
        let sw = e.status.chars().count() as u16;
        buf.text(tx + 1, ry, tw.saturating_sub(sw + 3), &e.label, fg);
        if sw > 0 {
            buf.text(tx + tw - sw - 1, ry, sw, e.status, if on { fg } else { theme::muted().on(bg) });
        }
    }
    let selected = rows.get(comp.selected).is_some();
    let mut hints: Vec<(&str, String)> = Vec::new();
    match comp.tab {
        Tab::Shell if selected => {
            hints.push(("output", "enter".into()));
            hints.push(("kill", "ctrl+d".into()));
        }
        Tab::Subagents if rows.get(comp.selected).is_some_and(|r| r.status == "Running") => hints.push(("interrupt", "ctrl+d".into())),
        Tab::Scripts if selected => hints.push(("cancel", "ctrl+d".into())),
        _ => {}
    }
    if list.len() > 1 {
        hints.push(("tabs", "←/→".into()));
    }
    let hy = y + h - 2;
    let mut col = tx + 1;
    for (label, keys) in hints {
        col = buf.text(col, hy, (tx + tw).saturating_sub(col), label, theme::text().on(c().surface).bold());
        col = buf.text(col + 1, hy, (tx + tw).saturating_sub(col + 1), &keys, theme::muted().on(c().surface)) + 2;
    }
}
