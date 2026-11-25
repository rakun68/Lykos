//! The mouse over the popups: what is under the cursor is what the wheel scrolls, moving over a row selects it, and a
//! click is Enter on it. The view records where it drew each thing (`Hits`), and this reads it back.

use std::time::Instant;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers, MouseButton, MouseEvent, MouseEventKind};

use crate::app::{Action, App, Dialog, List};
use crate::theme;

/// A rectangle: x, y, width, height.
pub type Area = (u16, u16, u16, u16);

/// Where the last frame drew what the mouse can reach.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Hits {
    pub dialog: Option<Area>,
    /// Each body row of the dialog shown: its screen row and the item it belongs to.
    pub dialog_rows: Vec<(u16, usize)>,
    /// The first body line drawn.
    pub dialog_skip: usize,
    pub menu: Option<Area>,
    /// Each completion row: its screen row and the entry.
    pub menu_rows: Vec<(u16, usize)>,
    /// The request box in the prompt's place.
    pub request: Option<Area>,
    /// Each request option: its row, its columns and its index.
    pub request_options: Vec<(u16, u16, u16, usize)>,
}

fn inside(a: Area, m: &MouseEvent) -> bool {
    m.column >= a.0 && m.column < a.0 + a.2 && m.row >= a.1 && m.row < a.1 + a.3
}

fn press(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

impl App {
    /// The mouse over a popup, the completion or a request; `None` when none of them is under it.
    pub fn popup_mouse(&mut self, m: &MouseEvent, now: Instant) -> Option<Vec<Action>> {
        let hits = self.hits.borrow().clone();
        let wheel = match m.kind {
            MouseEventKind::ScrollUp => Some(true),
            MouseEventKind::ScrollDown => Some(false),
            _ => None,
        };
        let click = matches!(m.kind, MouseEventKind::Down(MouseButton::Left));
        let hover = matches!(m.kind, MouseEventKind::Moved);
        if self.dialog.is_some() {
            let Some(area) = hits.dialog else { return Some(Vec::new()) };
            if !inside(area, m) {
                // Outside: the wheel scrolls the chat; a click closes a list or a page, never a form being filled.
                if let Some(up) = wheel {
                    self.scroll_chat(up, 3);
                }
                let form = matches!(self.dialog, Some(Dialog::Provider(_) | Dialog::Login(_) | Dialog::Input { .. }));
                if click && !form {
                    return Some(self.dialog_press(press(KeyCode::Esc), now));
                }
                return Some(Vec::new());
            }
            let row = hits.dialog_rows.iter().find(|(y, _)| *y == m.row).map(|r| r.1);
            if let Some(up) = wheel {
                if !self.step_selected(up) {
                    self.on_scroll(up, 3);
                }
                self.mouse_skip = None;
                return Some(Vec::new());
            }
            let Some(item) = row else { return Some(Vec::new()) };
            if hover || click {
                self.mouse_skip = Some(hits.dialog_skip);
                self.set_selected(item);
            }
            if click && !matches!(self.dialog, Some(Dialog::Provider(_))) {
                return Some(self.dialog_press(press(KeyCode::Enter), now));
            }
            return Some(Vec::new());
        }
        if let (Some(area), Some(menu)) = (hits.menu, self.menu.as_mut()) {
            if inside(area, m) {
                let n = menu.entries.len();
                if let Some(up) = wheel {
                    menu.pinned = None;
                    menu.selected = if up { menu.selected.saturating_sub(1) } else { (menu.selected + 1).min(n.saturating_sub(1)) };
                    return Some(Vec::new());
                }
                if let Some(&(_, i)) = hits.menu_rows.iter().find(|(y, _)| *y == m.row) {
                    if hover || click {
                        menu.pinned = Some(menu.first());
                        menu.selected = i;
                    }
                    if click {
                        return Some(self.pick());
                    }
                }
                return Some(Vec::new());
            }
        }
        if hits.request.is_some_and(|a| inside(a, m)) {
            if let Some(up) = wheel {
                self.req = self.request_ui();
                self.req.scroll = if up { self.req.scroll.saturating_sub(1) } else { self.req.scroll + 1 };
                return Some(Vec::new());
            }
            let hit = hits.request_options.iter().find(|(y, x0, x1, _)| *y == m.row && (*x0..*x1).contains(&m.column)).map(|o| o.3);
            if let Some(i) = hit {
                if hover || click {
                    self.req = self.request_ui();
                    self.req.selected = i;
                }
                if click {
                    return Some(self.request_key(&press(KeyCode::Enter)).unwrap_or_default());
                }
            }
            return Some(Vec::new());
        }
        None
    }

    /// A key the mouse stands for, as the open dialog takes it.
    fn dialog_press(&mut self, key: KeyEvent, now: Instant) -> Vec<Action> {
        self.on_key(key, now, 10)
    }

    /// The wheel over a list moves its selection, at its ends no further; `false` for a dialog that only scrolls.
    fn step_selected(&mut self, up: bool) -> bool {
        let Some(current) = self.selected_item() else { return false };
        self.set_selected(if up { current.saturating_sub(1) } else { current + 1 });
        true
    }

    /// How many items the open list has.
    fn item_count(&self) -> usize {
        match &self.dialog {
            Some(Dialog::List { list, query, .. }) => self.list_rows(list, query).len(),
            Some(Dialog::Palette { query, .. }) => self.palette(query).len(),
            Some(Dialog::Skills { query, .. }) => self.skills(query).len(),
            Some(Dialog::Sessions { query, confirm, .. }) => self.session_rows(query, confirm.as_deref()).len(),
            Some(Dialog::Timeline { query, .. }) => self.timeline_rows(query).len(),
            Some(Dialog::Worktrees { .. }) => self.worktree_rows().len(),
            Some(Dialog::ModelPicker { provider, query, .. }) => self.picker_rows(provider, query).len(),
            Some(Dialog::Accounts { provider, .. }) => self.accounts.as_ref().map_or(0, Vec::len) + self.account_adds(provider).len(),
            Some(Dialog::Queue { .. }) => self.queue.len(),
            Some(Dialog::Stash { .. }) => self.stash.entries.len(),
            Some(Dialog::Provider(f)) => f.fields().len(),
            _ => 0,
        }
    }

    fn selected_item(&self) -> Option<usize> {
        match &self.dialog {
            Some(
                Dialog::Queue { selected }
                | Dialog::Stash { selected }
                | Dialog::Palette { selected, .. }
                | Dialog::Skills { selected, .. }
                | Dialog::List { selected, .. }
                | Dialog::Sessions { selected, .. }
                | Dialog::Timeline { selected, .. }
                | Dialog::Worktrees { selected, .. }
                | Dialog::Accounts { selected, .. }
                | Dialog::ModelPicker { selected, .. },
            ) => Some(*selected),
            Some(Dialog::Provider(f)) => Some(f.focus),
            _ => None,
        }
    }

    /// Selects item `item` of the open dialog; a theme under the cursor shows at once, as with the keys.
    pub fn set_selected(&mut self, item: usize) {
        let count = self.item_count();
        if item >= count {
            return;
        }
        let mut theme_row = None;
        match &mut self.dialog {
            Some(
                Dialog::Queue { selected }
                | Dialog::Stash { selected }
                | Dialog::Palette { selected, .. }
                | Dialog::Skills { selected, .. }
                | Dialog::Sessions { selected, .. }
                | Dialog::Timeline { selected, .. }
                | Dialog::Worktrees { selected, .. }
                | Dialog::Accounts { selected, .. }
                | Dialog::ModelPicker { selected, .. },
            ) => *selected = item,
            Some(Dialog::List { list, query, selected }) => {
                *selected = item;
                if matches!(list, List::Themes { .. }) {
                    theme_row = Some((list.clone(), query.clone()));
                }
            }
            Some(Dialog::Provider(f)) => f.focus = item,
            _ => {}
        }
        if let Some((list, query)) = theme_row {
            if let Some(r) = self.list_rows(&list, &query).get(item) {
                theme::set(&r.value);
            }
        }
    }
}
