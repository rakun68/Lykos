//! What the pickers remember across runs, as OpenCode keeps it at `4332e24`: the recent models (newest first, at
//! most 10) and the favorites (`model-preference.ts`), and the theme (`context/theme.tsx`, in its kv store).
//! Lykos keeps the three in one file, `~/.lykos/tui/state.json`. What does not parse is skipped.
use std::path::PathBuf;

use serde_json::{json, Value};

pub const RECENT: usize = 10;

#[derive(Debug, Default)]
pub struct Prefs {
    path: Option<PathBuf>,
    pub theme: Option<String>,
    /// `provider/id`, newest first.
    pub recent: Vec<String>,
    pub favorite: Vec<String>,
}

fn names(v: &Value) -> Vec<String> {
    v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_string)).collect()).unwrap_or_default()
}

impl Prefs {
    pub fn load(path: Option<PathBuf>) -> Prefs {
        let v: Value = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let mut recent = names(&v["recent"]);
        recent.truncate(RECENT);
        Prefs { path, theme: v["theme"].as_str().map(str::to_string), recent, favorite: names(&v["favorite"]) }
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

    pub fn set_theme(&mut self, name: &str) {
        self.theme = Some(name.to_string());
        self.save();
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let v = json!({ "theme": self.theme, "recent": self.recent, "favorite": self.favorite });
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
        let again = Prefs::load(Some(path));
        assert_eq!(again.recent.len(), RECENT);
        assert_eq!(&again.recent[..3], ["p/m5", "p/m11", "p/m10"]);
        assert_eq!(again.favorite, ["p/b"]);
        assert_eq!(again.theme.as_deref(), Some("rose-pine"));
        let _ = std::fs::remove_dir_all(dir);
    }
}
