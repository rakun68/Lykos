//! Completion for `/` commands and `@` files, as OpenCode's `component/prompt/autocomplete.tsx` at `4332e24` does
//! it: `/` at the start of the prompt completes commands, `@` after a space (or at the start) completes files, the
//! query is what follows up to the cursor, results are fuzzy with a prefix match scoring double, and ten show.
use lykos_client::CommandInfo;

pub const LIMIT: usize = 10;

/// What the prompt runs itself, before the session's own commands.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Local {
    Btw,
    Editor,
    Images,
    Queue,
    Stash,
    StashList,
    StashPop,
}

pub const LOCAL: [(Local, &str, &str); 7] = [
    (Local::Btw, "/btw", "Ask a side question; the answer stays out of the conversation"),
    (Local::Editor, "/editor", "Open the prompt in your editor"),
    (Local::Images, "/images", "View the images attached to the prompt"),
    (Local::Queue, "/queue", "Manage queued prompts"),
    (Local::Stash, "/stash", "Stash the prompt"),
    (Local::StashList, "/stash list", "List stashed prompts"),
    (Local::StashPop, "/stash pop", "Pop the last stashed prompt"),
];

pub fn local(name: &str) -> Option<Local> {
    LOCAL.iter().find(|(_, n, _)| *n == name).map(|(l, _, _)| *l)
}

#[derive(Clone, Debug, PartialEq)]
pub enum Pick {
    Local(Local),
    /// A session command, inserted as typed.
    Command(String),
    File(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub label: String,
    pub detail: String,
    pub pick: Pick,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Trigger {
    Slash,
    At,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Menu {
    pub trigger: Trigger,
    /// The byte offset of the `/` or `@`.
    pub at: usize,
    pub entries: Vec<Entry>,
    pub selected: usize,
}

/// Which completion the cursor is in, if any: the trigger, its offset, and the query.
pub fn trigger(text: &str, cursor: usize) -> Option<(Trigger, usize, &str)> {
    let before = &text[..cursor];
    if let Some(q) = before.strip_prefix('/') {
        if !q.contains(char::is_whitespace) || local(before).is_some() || LOCAL.iter().any(|(_, n, _)| n.starts_with(before)) {
            return Some((Trigger::Slash, 0, q));
        }
    }
    let at = before.rfind(|c: char| c == '@' || c.is_whitespace())?;
    if !before[at..].starts_with('@') {
        return None;
    }
    if at > 0 && !before[..at].ends_with(char::is_whitespace) {
        return None;
    }
    Some((Trigger::At, at, &before[at + 1..]))
}

/// A subsequence match, case-insensitive; higher is better. Consecutive letters and an early start score more,
/// and a prefix match doubles the score.
pub fn score(query: &str, candidate: &str) -> Option<u32> {
    if query.is_empty() {
        return Some(1);
    }
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let c: Vec<char> = candidate.to_lowercase().chars().collect();
    let (mut qi, mut run, mut total, mut first) = (0, 0u32, 0u32, None);
    for (i, ch) in c.iter().enumerate() {
        if qi < q.len() && *ch == q[qi] {
            first.get_or_insert(i);
            run += 1;
            total += 10 + run * 5;
            qi += 1;
        } else {
            run = 0;
        }
    }
    if qi < q.len() {
        return None;
    }
    let start_bonus = 50u32.saturating_sub(first.unwrap_or(0) as u32);
    let base = total + start_bonus + 100u32.saturating_sub(c.len() as u32).min(100) / 10;
    Some(if c.starts_with(&q) { base * 2 } else { base })
}

fn rank(query: &str, entries: impl Iterator<Item = Entry>, key: impl Fn(&Entry) -> &str) -> Vec<Entry> {
    let mut scored: Vec<(u32, Entry)> = entries.filter_map(|e| score(query, key(&e)).map(|s| (s, e))).collect();
    scored.sort_by_key(|e| std::cmp::Reverse(e.0));
    scored.into_iter().take(LIMIT).map(|(_, e)| e).collect()
}

pub fn commands(query: &str, session: &[CommandInfo]) -> Vec<Entry> {
    let locals = LOCAL.iter().map(|(l, n, d)| Entry { label: n.to_string(), detail: d.to_string(), pick: Pick::Local(*l) });
    let theirs = session
        .iter()
        .filter(|c| local(&c.name).is_none())
        .map(|c| Entry { label: c.name.clone(), detail: c.description.clone(), pick: Pick::Command(c.name.clone()) });
    rank(query, locals.chain(theirs), |e| e.label.trim_start_matches('/'))
}

pub fn files(query: &str, files: &[String]) -> Vec<Entry> {
    rank(query, files.iter().map(|f| Entry { label: f.clone(), detail: String::new(), pick: Pick::File(f.clone()) }), |e| &e.label)
}

pub const IMAGE_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "gif", "webp", "bmp"];

pub fn is_image(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_completes_at_the_start_and_at_after_a_space() {
        assert_eq!(trigger("/st", 3), Some((Trigger::Slash, 0, "st")));
        assert_eq!(trigger("/stash p", 8), Some((Trigger::Slash, 0, "stash p")));
        assert_eq!(trigger("/btw why", 8), None, "past the command: no completion");
        assert_eq!(trigger("look at @src/ma", 15), Some((Trigger::At, 8, "src/ma")));
        assert_eq!(trigger("a@b", 3), None, "an @ inside a word is not a mention");
        assert_eq!(trigger("@x y", 4), None);
        assert_eq!(trigger("x /y", 4), None);
    }

    #[test]
    fn a_prefix_beats_a_scattered_match_and_ten_show() {
        let names: Vec<String> = ["src/main.rs", "docs/maintenance.md", "Makefile"].iter().map(|s| s.to_string()).collect();
        assert_eq!(files("ma", &names)[0].label, "Makefile");
        assert!(files("zz", &names).is_empty());
        let many: Vec<String> = (0..30).map(|i| format!("f{i}")).collect();
        assert_eq!(files("f", &many).len(), LIMIT);
        let got = commands("stash", &[]);
        assert_eq!(got[0].label, "/stash");
        assert!(got.iter().any(|e| e.label == "/stash pop"));
    }

    #[test]
    fn session_commands_follow_the_local_ones() {
        let theirs = [CommandInfo { name: "/skill:tdd".into(), description: "tests first".into(), source: "skill".into() }];
        let got = commands("tdd", &theirs);
        assert_eq!(got[0].pick, Pick::Command("/skill:tdd".into()));
        assert!(is_image("a/B.PNG") && !is_image("a.rs"));
    }
}
