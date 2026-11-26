//! Stashed prompts, as OpenCode's `prompt/stash.tsx` at `4332e24` keeps them: one JSON object per line,
//! `{"prompt":{"text":...},"timestamp":<ms>}`, at most 50, oldest dropped first. Lykos keeps the file at
//! `~/.lykos/tui/prompt-stash.jsonl`. A line that does not parse is skipped.
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

pub const MAX: usize = 50;

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub text: String,
    pub timestamp: u64,
}

#[derive(Debug, Default)]
pub struct Stash {
    path: Option<PathBuf>,
    pub entries: Vec<Entry>,
}

impl Stash {
    pub fn load(path: Option<PathBuf>) -> Stash {
        let text = path.as_ref().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default();
        let mut entries: Vec<Entry> = text
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter_map(|v| Some(Entry { text: v["prompt"]["text"].as_str()?.to_string(), timestamp: v["timestamp"].as_u64()? }))
            .collect();
        let skip = entries.len().saturating_sub(MAX);
        entries.drain(..skip);
        Stash { path, entries }
    }

    pub fn push(&mut self, text: &str) {
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
        self.entries.push(Entry { text: text.to_string(), timestamp });
        if self.entries.len() > MAX {
            self.entries.remove(0);
        }
        self.save();
    }

    /// The newest entry, taken out.
    pub fn pop(&mut self) -> Option<Entry> {
        let e = self.entries.pop()?;
        self.save();
        Some(e)
    }

    /// Entry `i`, taken out.
    pub fn take(&mut self, i: usize) -> Option<Entry> {
        if i >= self.entries.len() {
            return None;
        }
        let e = self.entries.remove(i);
        self.save();
        Some(e)
    }

    fn save(&self) {
        let Some(path) = &self.path else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let text: String = self.entries.iter().map(|e| format!("{}\n", json!({ "prompt": { "text": e.text }, "timestamp": e.timestamp }))).collect();
        let _ = std::fs::write(path, text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_pop_take_and_persist() {
        let dir = std::env::temp_dir().join(format!("lykos-stash-{}", std::process::id()));
        let path = dir.join("prompt-stash.jsonl");
        let _ = std::fs::remove_dir_all(&dir);
        let mut s = Stash::load(Some(path.clone()));
        for i in 0..MAX + 2 {
            s.push(&format!("p{i}"));
        }
        assert_eq!(s.entries.len(), MAX);
        assert_eq!(s.entries[0].text, "p2");
        assert_eq!(s.pop().unwrap().text, format!("p{}", MAX + 1));
        assert_eq!(s.take(0).unwrap().text, "p2");
        let mut text = std::fs::read_to_string(&path).unwrap();
        text.push_str("garbage\n");
        std::fs::write(&path, text).unwrap();
        let again = Stash::load(Some(path));
        assert_eq!(again.entries.len(), MAX - 2, "a bad line is skipped");
        assert_eq!(again.entries[0].text, "p3");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
