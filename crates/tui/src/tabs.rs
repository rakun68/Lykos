//! The open session tabs, as OpenCode's `context/session-tabs-model.ts` at `4332e24` keeps them: opening appends,
//! closing moves to the right neighbour (else the left) and remembers the tab and its place (25 at most), reopening
//! puts it back there, next and previous wrap, and a tab whose session finished a turn while not shown is unread.
//! A tab is an engine-server session id. Closing a tab leaves its session running on the server.
use std::collections::BTreeSet;

pub const CLOSED: usize = 25;
pub const HISTORY: usize = 100;

#[derive(Debug, Default)]
pub struct Tabs {
    pub open: Vec<String>,
    closed: Vec<(String, usize)>,
    pub unread: BTreeSet<String>,
    /// The tabs shown, oldest first (100 at most), and the place in it back and forward move from.
    history: Vec<String>,
    at: usize,
}

impl Tabs {
    /// Opens `id` if it is not open; either way it becomes the one shown.
    pub fn open(&mut self, id: &str) {
        if !self.open.iter().any(|t| t == id) {
            self.open.push(id.to_string());
        }
        self.unread.remove(id);
        if self.history.get(self.at) != Some(&id.to_string()) {
            self.history.truncate(self.at + 1);
            self.history.push(id.to_string());
            if self.history.len() > HISTORY {
                self.history.remove(0);
            }
            self.at = self.history.len() - 1;
        }
    }

    /// `session.tab.history.back` and `forward`: the nearest tab shown before or after, still open.
    pub fn step_history(&mut self, back: bool) -> Option<String> {
        let mut i = self.at;
        loop {
            i = if back { i.checked_sub(1)? } else { i + 1 };
            let id = self.history.get(i)?.clone();
            if self.open.contains(&id) {
                self.at = i;
                self.unread.remove(&id);
                return Some(id);
            }
        }
    }

    /// Closes `id`; returns the tab shown next, if any is left.
    pub fn close(&mut self, id: &str) -> Option<String> {
        let at = self.open.iter().position(|t| t == id)?;
        self.open.remove(at);
        self.unread.remove(id);
        self.closed.retain(|(t, _)| t != id);
        self.closed.push((id.to_string(), at));
        if self.closed.len() > CLOSED {
            self.closed.remove(0);
        }
        self.open.get(at).or_else(|| at.checked_sub(1).and_then(|i| self.open.get(i))).cloned()
    }

    /// The last closed tab, back where it was.
    pub fn reopen(&mut self) -> Option<String> {
        let (id, at) = self.closed.pop()?;
        if !self.open.contains(&id) {
            self.open.insert(at.min(self.open.len()), id.clone());
        }
        Some(id)
    }

    /// The tab `step` places from `current`, wrapping; with `unread`, only unread tabs count.
    pub fn cycle(&self, current: Option<&str>, step: isize, unread: bool) -> Option<String> {
        let n = self.open.len() as isize;
        if n == 0 {
            return None;
        }
        let from = current.and_then(|c| self.open.iter().position(|t| t == c)).map_or(if step > 0 { -1 } else { n }, |i| i as isize);
        (1..=n).map(|k| (from + step.signum() * k).rem_euclid(n) as usize).map(|i| &self.open[i]).find(|t| !unread || self.unread.contains(*t)).cloned()
    }

    /// A turn ended in `id`: unread unless it is the one shown.
    pub fn finished(&mut self, id: &str, shown: Option<&str>) {
        if shown != Some(id) && self.open.iter().any(|t| t == id) {
            self.unread.insert(id.to_string());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tabs(ids: &[&str]) -> Tabs {
        let mut t = Tabs::default();
        for id in ids {
            t.open(id);
        }
        t
    }

    #[test]
    fn close_goes_right_then_left_and_reopen_restores_the_place() {
        let mut t = tabs(&["a", "b", "c"]);
        assert_eq!(t.close("b").as_deref(), Some("c"));
        assert_eq!(t.close("c").as_deref(), Some("a"));
        assert_eq!(t.reopen().as_deref(), Some("c"));
        assert_eq!(t.reopen().as_deref(), Some("b"));
        assert_eq!(t.open, ["a", "b", "c"]);
        assert_eq!(t.reopen(), None);
    }

    #[test]
    fn cycle_wraps_and_unread_skips_read_tabs() {
        let mut t = tabs(&["a", "b", "c"]);
        assert_eq!(t.cycle(Some("c"), 1, false).as_deref(), Some("a"));
        assert_eq!(t.cycle(Some("a"), -1, false).as_deref(), Some("c"));
        t.finished("c", Some("a"));
        t.finished("a", Some("a"));
        assert_eq!(t.cycle(Some("a"), 1, true).as_deref(), Some("c"));
        assert_eq!(t.cycle(Some("a"), -1, true).as_deref(), Some("c"));
        t.open("c");
        assert_eq!(t.cycle(Some("c"), 1, true), None);
    }

    #[test]
    fn history_goes_back_and_forward_over_closed_tabs() {
        let mut t = tabs(&["a", "b", "c"]);
        t.close("b");
        assert_eq!(t.step_history(true).as_deref(), Some("a"));
        assert_eq!(t.step_history(true), None);
        assert_eq!(t.step_history(false).as_deref(), Some("c"));
    }

    #[test]
    fn at_most_25_closed_are_remembered() {
        let mut t = Tabs::default();
        for i in 0..30 {
            t.open(&i.to_string());
            t.close(&i.to_string());
        }
        let mut n = 0;
        while t.reopen().is_some() {
            n += 1;
        }
        assert_eq!(n, CLOSED);
    }
}
