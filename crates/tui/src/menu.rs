//! Completion for `/` commands and `@` files, as OpenCode's `component/prompt/autocomplete.tsx` at `4332e24` does
//! it: `/` at the start of the prompt completes commands, `@` after a space (or at the start) completes files, the
//! query is what follows up to the cursor, results are fuzzy with a prefix match scoring double. Ten show at a time and
//! the list scrolls with the selection, a row under it counting what is above and below (#58 item 1).
use lykos_client::CommandInfo;

/// The rows shown at once.
pub const LIMIT: usize = 10;
/// The most matches a list holds: past this a query narrows it.
const MAX: usize = 500;

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
    Help,
    Models,
    Effort,
    Agents,
    Themes,
    Connect,
    Status,
    Context,
    Usage,
    Mcps,
    Debug,
    /// A session action (`keymap::DEFS`), P5 #42.
    Run(&'static str),
}

pub const LOCAL: [(Local, &str, &str); 23] = [
    (Local::Btw, "/btw", "Ask a side question; the answer stays out of the conversation"),
    (Local::Editor, "/editor", "Open the prompt in your editor"),
    (Local::Images, "/images", "View the images attached to the prompt"),
    (Local::Queue, "/queue", "Manage queued prompts"),
    (Local::Stash, "/stash", "Stash the prompt"),
    (Local::StashList, "/stash list", "List stashed prompts"),
    (Local::StashPop, "/stash pop", "Pop the last stashed prompt"),
    (Local::Help, "/help", "Every key, and the config layer that set it"),
    // OpenCode's slash names for its lists (`app.tsx`).
    (Local::Models, "/models", "Switch model"),
    (Local::Agents, "/agents", "Switch specialist"),
    (Local::Themes, "/themes", "Switch theme"),
    (Local::Connect, "/connect", "Connect a provider"),
    (Local::Status, "/status", "View status"),
    (Local::Context, "/context", "What fills the context window"),
    (Local::Usage, "/usage", "Tokens, cache and spend"),
    (Local::Mcps, "/mcps", "MCP servers"),
    (Local::Debug, "/debug", "View debug info"),
    (Local::Run("session.list"), "/sessions", "Switch session"),
    (Local::Run("open.menu"), "/open", "Open session or project"),
    (Local::Run("session.timeline"), "/timeline", "Jump to message"),
    (Local::Run("session.move"), "/worktrees", "Manage workspaces"),
    (Local::Run("messages.copy"), "/copy", "Copy last assistant message"),
    (Local::Run("diff.open"), "/diff", "Open diff viewer"),
];

/// The session's own commands typed bare open their list; with an argument they go to the session.
pub fn bare(name: &str) -> Option<Local> {
    match name {
        "/model" => Some(Local::Models),
        "/effort" => Some(Local::Effort),
        "/specialist" => Some(Local::Agents),
        "/login" => Some(Local::Connect),
        "/resume" => Some(Local::Run("session.list")),
        "/new" => Some(Local::Run("session.new")),
        "/rename" => Some(Local::Run("session.rename")),
        _ => None,
    }
}

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
    /// A command that runs with no argument, so Tab runs it (#58 item 15).
    pub bare: bool,
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
    /// The first entry shown while the mouse selects: the window stays put under it.
    pub pinned: Option<usize>,
}

impl Menu {
    /// The first entry shown: the selection stays in the middle of the window of `LIMIT`, except near either end,
    /// or where the mouse left it while the selection is in it.
    pub fn first(&self) -> usize {
        match self.pinned {
            Some(p) if (p..p + LIMIT).contains(&self.selected) && p <= self.entries.len().saturating_sub(LIMIT) => p,
            _ => centered(self.selected, 1, self.entries.len(), LIMIT),
        }
    }

    /// The rows it takes: the window, and a count row when there is more than fits.
    pub fn height(&self) -> usize {
        self.entries.len().min(LIMIT) + usize::from(self.entries.len() > LIMIT)
    }
}

/// The first of `room` rows shown out of `len`, keeping the item at `at` (`span` rows tall) in the middle, except
/// near either end: what the completion and every dialog list scroll by.
pub fn centered(at: usize, span: usize, len: usize, room: usize) -> usize {
    at.saturating_sub(room.saturating_sub(span) / 2).min(len.saturating_sub(room))
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
    scored.into_iter().take(MAX).map(|(_, e)| e).collect()
}

pub fn commands(query: &str, session: &[CommandInfo]) -> Vec<Entry> {
    rank(query, all_commands(session).into_iter(), |e| e.label.trim_start_matches('/'))
}

/// Every command, the prompt's own first: what the completion ranks and the palette lists.
pub fn all_commands(session: &[CommandInfo]) -> Vec<Entry> {
    let locals = LOCAL.iter().map(|(l, n, d)| Entry { label: n.to_string(), detail: d.to_string(), pick: Pick::Local(*l), bare: *l != Local::Btw });
    // A built-in that takes no argument, or does something useful without one (it lists, reports or opens its
    // picker). One whose description shows an argument (`<provider>`), and `/followup`, need one.
    let theirs = session.iter().filter(|c| local(&c.name).is_none()).map(|c| Entry {
        label: c.name.clone(),
        detail: c.description.clone(),
        pick: Pick::Command(c.name.clone()),
        bare: bare(&c.name).is_some() || (c.source == "builtin" && !c.description.contains('<') && !matches!(c.name.as_str(), "/followup" | "/btw")),
    });
    locals.chain(theirs).collect()
}

pub fn files(query: &str, files: &[String]) -> Vec<Entry> {
    rank(query, files.iter().map(|f| Entry { label: f.clone(), detail: String::new(), pick: Pick::File(f.clone()), bare: false }), |e| &e.label)
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
        let all = files("f", &many);
        assert_eq!(all.len(), 30, "every match, so the list scrolls to each");
        let mut m = Menu { trigger: Trigger::At, at: 0, entries: all, selected: 0, pinned: None };
        assert_eq!((m.first(), m.height()), (0, LIMIT + 1));
        m.selected = 14;
        assert_eq!(m.first(), 10, "the selection stays in the middle");
        m.selected = 2;
        assert_eq!(m.first(), 0, "near the top the window does not move");
        m.selected = 29;
        assert_eq!(m.first(), 20, "nor near the bottom");
        let got = commands("stash", &[]);
        assert_eq!(got[0].label, "/stash");
        assert!(got.iter().any(|e| e.label == "/stash pop"));
    }

    #[test]
    fn session_commands_follow_the_local_ones() {
        let theirs = [
            CommandInfo { name: "/skill:tdd".into(), description: "tests first".into(), source: "skill".into() },
            CommandInfo { name: "/context".into(), description: "what is occupying the context window".into(), source: "builtin".into() },
            CommandInfo { name: "/login".into(), description: "add a credential: /login <provider>".into(), source: "builtin".into() },
            CommandInfo { name: "/followup".into(), description: "queue a follow-up".into(), source: "builtin".into() },
        ];
        let got = commands("tdd", &theirs);
        assert_eq!(got[0].pick, Pick::Command("/skill:tdd".into()));
        let bare_of = |name: &str| all_commands(&theirs).into_iter().find(|e| e.label == name).map(|e| e.bare);
        assert_eq!(bare_of("/skill:tdd"), Some(false), "a skill takes the prompt");
        assert_eq!(bare_of("/context"), Some(true));
        assert_eq!(bare_of("/login"), Some(true), "bare, it opens its list");
        assert_eq!(bare_of("/followup"), Some(false));
        assert_eq!(bare_of("/models"), Some(true));
        assert_eq!(bare_of("/btw"), Some(false));
        assert!(is_image("a/B.PNG") && !is_image("a.rs"));
    }
}
