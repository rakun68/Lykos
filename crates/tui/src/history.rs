//! Prompt history. Kept where the old TUI keeps it, `<workspace>/.lykos/history.json` (`lykos/tui/history.ts`):
//! a JSON array of strings, oldest first, capped at 500, rewritten whole on every append. A missing or corrupt
//! file is empty history. Moving through it follows OpenCode's `prompt/history.tsx` at `4332e24`: the draft is kept
//! while browsing and comes back past the newest entry, and an edited entry stops the browse.
use std::path::PathBuf;

pub const CAP: usize = 500;

#[derive(Debug, Default)]
pub struct History {
    path: Option<PathBuf>,
    pub entries: Vec<String>,
    /// 0 is the draft; -1 the newest entry, and so on.
    index: isize,
    draft: Option<String>,
}

impl History {
    /// `None` keeps it in memory only (tests).
    pub fn load(path: Option<PathBuf>) -> History {
        let entries = path
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .and_then(|t| serde_json::from_str::<Vec<serde_json::Value>>(&t).ok())
            .map(|v| v.into_iter().filter_map(|e| e.as_str().map(str::to_string)).collect::<Vec<_>>())
            .unwrap_or_default();
        let skip = entries.len().saturating_sub(CAP);
        History { path, entries: entries[skip..].to_vec(), index: 0, draft: None }
    }

    /// Moving through the entries (not on the draft).
    pub fn browsing(&self) -> bool {
        self.index < 0
    }

    pub fn reset(&mut self) {
        self.index = 0;
        self.draft = None;
    }

    /// Records a submitted prompt, unless it repeats the last one. A failed write loses recall, never work.
    pub fn append(&mut self, entry: &str) {
        self.reset();
        if entry.trim().is_empty() || self.entries.last().is_some_and(|l| l == entry) {
            return;
        }
        // Another TUI on this workspace may have added since: append to what is on disk now.
        if let Some(path) = &self.path {
            self.entries = History::load(Some(path.clone())).entries;
        }
        self.entries.push(entry.to_string());
        if self.entries.len() > CAP {
            self.entries.drain(..self.entries.len() - CAP);
        }
        if let Some(path) = &self.path {
            if let Some(dir) = path.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            if let Ok(text) = serde_json::to_string(&self.entries) {
                let _ = std::fs::write(path, text);
            }
        }
    }

    /// One step older (-1) or newer (1), given the text in the box now. `None` when there is nowhere to go, or the
    /// shown entry was edited.
    pub fn step(&mut self, direction: isize, current: &str) -> Option<String> {
        let next = self.index + direction;
        if next < -(self.entries.len() as isize) || next > 0 {
            return None;
        }
        if self.index < 0 && !current.is_empty() && self.at(self.index) != Some(current) {
            return None;
        }
        if self.index == 0 {
            self.draft = Some(current.to_string());
        }
        self.index = next;
        if next == 0 {
            return Some(self.draft.take().unwrap_or_default());
        }
        self.at(next).map(str::to_string)
    }

    fn at(&self, index: isize) -> Option<&str> {
        let i = self.entries.len() as isize + index;
        (i >= 0).then(|| self.entries.get(i as usize).map(String::as_str)).flatten()
    }

    /// The old TUI's ctrl+r: entries that start with `prefix`, newest first.
    pub fn search(&self, prefix: &str) -> Vec<String> {
        self.entries.iter().rev().filter(|e| e.starts_with(prefix)).cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn up_walks_back_and_down_brings_the_draft_back() {
        let mut h = History::load(None);
        h.append("one");
        h.append("two");
        h.append("two");
        assert_eq!(h.entries, ["one", "two"], "a repeat is not recorded");
        assert_eq!(h.step(-1, "draft").as_deref(), Some("two"));
        assert_eq!(h.step(-1, "two").as_deref(), Some("one"));
        assert_eq!(h.step(-1, "one"), None, "the oldest");
        assert_eq!(h.step(1, "one").as_deref(), Some("two"));
        assert_eq!(h.step(1, "two").as_deref(), Some("draft"));
        assert_eq!(h.step(1, "draft"), None);
    }

    #[test]
    fn an_edited_entry_stops_the_browse() {
        let mut h = History::load(None);
        h.append("one");
        h.append("two");
        h.step(-1, "");
        assert_eq!(h.step(-1, "two!"), None);
    }

    #[test]
    fn persists_capped_and_reads_the_old_tuis_file() {
        let dir = std::env::temp_dir().join(format!("lykos-history-{}", std::process::id()));
        let path = dir.join(".lykos").join("history.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let old: Vec<String> = (0..CAP + 5).map(|i| format!("p{i}")).collect();
        std::fs::write(&path, serde_json::to_string(&old).unwrap()).unwrap();
        let mut h = History::load(Some(path.clone()));
        assert_eq!(h.entries.len(), CAP);
        assert_eq!(h.entries[0], "p5");
        h.append("new");
        let back: Vec<String> = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(back.len(), CAP);
        assert_eq!(back.last().unwrap(), "new");
        assert_eq!(h.search("p50"), ["p504", "p503", "p502", "p501", "p500", "p50"]);
        std::fs::write(&path, "not json").unwrap();
        assert!(History::load(Some(path)).entries.is_empty(), "a corrupt file is empty history");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
