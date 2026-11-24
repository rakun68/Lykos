//! What the pickers remember across runs, as OpenCode keeps it at `4332e24`: the recent models (newest first, at
//! most 10) and the favorites (`model-preference.ts`), and the theme (`context/theme.tsx`, in its kv store).
//! The session list's pins (`dialog-session-list.tsx`, P5 #42) are ledger session ids. The transcript's toggles (P5 #44)
//! are what OpenCode keeps in its TUI config: `session.thinking`, `.scrollbar`, `.grouping`, `.verbosity`,
//! `diffs.wrap` and `animations`. Lykos keeps them in one file, `~/.lykos/tui/state.json`. What does not parse is skipped.
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::transcript::Verbosity;

pub const RECENT: usize = 10;

#[derive(Debug)]
pub struct Prefs {
    path: Option<PathBuf>,
    pub theme: Option<String>,
    /// `provider/id`, newest first.
    pub recent: Vec<String>,
    pub favorite: Vec<String>,
    /// Pinned sessions' ledger ids, newest pin first.
    pub pinned: Vec<String>,
    pub show_thinking: bool,
    pub scrollbar: bool,
    pub grouping: bool,
    pub verbosity: Verbosity,
    pub diff_wrap: bool,
    pub animations: bool,
    /// `session.sidebar`: "auto" shows the sidebar on a wide screen, "hide" only when toggled open.
    pub sidebar: bool,
}

impl Default for Prefs {
    fn default() -> Prefs {
        Prefs {
            path: None,
            theme: None,
            recent: Vec::new(),
            favorite: Vec::new(),
            pinned: Vec::new(),
            show_thinking: false,
            scrollbar: false,
            grouping: true,
            verbosity: Verbosity::Low,
            diff_wrap: true,
            animations: true,
            sidebar: true,
        }
    }
}

fn names(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

impl Prefs {
    pub fn load(path: Option<PathBuf>) -> Prefs {
        let v: Value = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let mut recent = names(&v["recent"]);
        recent.truncate(RECENT);
        let d = Prefs::default();
        Prefs {
            path,
            theme: v["theme"].as_str().map(str::to_string),
            recent,
            favorite: names(&v["favorite"]),
            pinned: names(&v["pinned"]),
            show_thinking: v["thinking"].as_str().map_or(d.show_thinking, |s| s == "show"),
            scrollbar: v["scrollbar"].as_bool().unwrap_or(d.scrollbar),
            grouping: v["grouping"].as_str().map_or(d.grouping, |s| s != "none"),
            verbosity: v["verbosity"].as_str().and_then(Verbosity::parse).unwrap_or(d.verbosity),
            diff_wrap: v["diffWrap"].as_str().map_or(d.diff_wrap, |s| s != "none"),
            animations: v["animations"].as_bool().unwrap_or(d.animations),
            sidebar: v["sidebar"].as_str().map_or(d.sidebar, |s| s != "hide"),
        }
    }

    /// `recentModels`: to the front, once, and at most ten.
    pub fn used(&mut self, model: &str) {
        self.recent.retain(|m| m != model);
        self.recent.insert(0, model.to_string());
        self.recent.truncate(RECENT);
        self.save();
    }

    /// `favoriteModels`: a new favorite goes to the front.
    pub fn toggle_favorite(&mut self, model: &str) {
        let had = self.favorite.iter().any(|m| m == model);
        self.favorite.retain(|m| m != model);
        if !had {
            self.favorite.insert(0, model.to_string());
        }
        self.save();
    }

    /// `session.pin.toggle`.
    pub fn toggle_pin(&mut self, id: &str) {
        let had = self.pinned.iter().any(|m| m == id);
        self.pinned.retain(|m| m != id);
        if !had {
            self.pinned.insert(0, id.to_string());
        }
        self.save();
    }

    pub fn set_theme(&mut self, name: &str) {
        self.theme = Some(name.to_string());
        self.save();
    }

    pub fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let v = json!({
            "theme": self.theme,
            "recent": self.recent,
            "favorite": self.favorite,
            "pinned": self.pinned,
            "thinking": if self.show_thinking { "show" } else { "hide" },
            "scrollbar": self.scrollbar,
            "grouping": if self.grouping { "auto" } else { "none" },
            "verbosity": self.verbosity.name(),
            "diffWrap": if self.diff_wrap { "word" } else { "none" },
            "animations": self.animations,
            "sidebar": if self.sidebar { "auto" } else { "hide" },
        });
        let _ = std::fs::write(path, format!("{v}\n"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recent_keeps_ten_newest_first_and_favorites_toggle() {
        let dir = std::env::temp_dir().join(format!("lykos-prefs-{}", std::process::id()));
        let path = dir.join("state.json");
        let mut p = Prefs::load(Some(path.clone()));
        for i in 0..12 {
            p.used(&format!("p/m{i}"));
        }
        p.used("p/m5");
        p.toggle_favorite("p/a");
        p.toggle_favorite("p/b");
        p.toggle_favorite("p/a");
        p.set_theme("rose-pine");
        p.toggle_pin("s1");
        p.verbosity = Verbosity::High;
        p.show_thinking = true;
        p.save();
        let again = Prefs::load(Some(path));
        assert_eq!((again.verbosity, again.show_thinking, again.grouping, again.animations), (Verbosity::High, true, true, true));
        assert_eq!(again.recent.len(), RECENT);
        assert_eq!(&again.recent[..3], ["p/m5", "p/m11", "p/m10"]);
        assert_eq!(again.favorite, ["p/b"]);
        assert_eq!(again.pinned, ["s1"]);
        assert_eq!(again.theme.as_deref(), Some("rose-pine"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
