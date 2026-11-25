//! The transcript laid out as rows, as OpenCode's session screen at `4332e24` lays it out:
//! `routes/session/grouping/session.ts` (which parts group), `group-view.tsx` and `activity-summary.ts` (what a group
//! says), `message-parts.tsx` (thinking) and `context/thinking.ts` (a thought's title).
//!
//! Low verbosity, the default, folds each run of tool calls and thoughts between answers into one line,
//! "3 commands, 1 edit, 2 thoughts, 4 reads". Medium and high leave them out, grouping only adjacent thoughts
//! (while thinking is hidden) and adjacent reads and searches (while grouping is on); high opens those. A click on a
//! group's line opens or closes it.
//!
//! A block that can no longer change (nothing in it runs, and something came after it) is laid out once and kept,
//! and the settled run from the first item is shared from frame to frame, so a frame lays out only what is new.
use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::rc::Rc;

use lykos_client::{Item, Session, SessionStatus, ToolState};
use lykos_term::{Attr, Style};

use crate::markdown::{self, Span};
use crate::theme::{self, c};
use crate::wrap::wrap;

pub const SPINNER: [char; 10] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/// What shows in place of "Thinking" while the model works: one word a turn, the same wherever it shows.
pub const BUSY_WORDS: [&str; 48] = [
    "Prowling", "Howling", "Sniffing around", "Circling", "Stalking the bug", "Padding about", "Tracking", "Den-building",
    "Noodling", "Percolating", "Marinating", "Simmering", "Stewing", "Brewing", "Kneading", "Fermenting",
    "Cogitating", "Ruminating", "Mulling", "Musing", "Woolgathering", "Daydreaming", "Philosophizing", "Chin-stroking",
    "Tinkering", "Fiddling", "Puttering", "Whittling", "Wrangling", "Untangling", "Juggling", "Rummaging",
    "Sleuthing", "Spelunking", "Scheming", "Conjuring", "Hatching", "Doodling", "Moseying", "Gallivanting",
    "Dithering", "Lollygagging", "Bamboozling", "Hornswoggling", "Galumphing", "Discombobulating", "Kerfuffling", "Skedaddling",
];

/// The word for the `turn`-th prompt of a session.
pub fn busy_word(turn: usize) -> &'static str {
    BUSY_WORDS[turn.wrapping_mul(2_654_435_761) % BUSY_WORDS.len()]
}

/// Which prompt of the session item `i` answers: the user messages up to it.
pub fn turn_of(items: &[Item], i: usize) -> usize {
    items.iter().take(i + 1).filter(|x| matches!(x, Item::User(_))).count()
}

/// `session.verbosity`: low, medium or high, low by default (`grouping/session.ts` `defaultVerbosity`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum Verbosity {
    #[default]
    Low,
    Medium,
    High,
}

impl Verbosity {
    pub fn name(self) -> &'static str {
        match self {
            Verbosity::Low => "low",
            Verbosity::Medium => "medium",
            Verbosity::High => "high",
        }
    }

    pub fn parse(s: &str) -> Option<Verbosity> {
        [Verbosity::Low, Verbosity::Medium, Verbosity::High].into_iter().find(|v| v.name() == s)
    }

    pub fn next(self) -> Verbosity {
        match self {
            Verbosity::Low => Verbosity::Medium,
            Verbosity::Medium => Verbosity::High,
            Verbosity::High => Verbosity::Low,
        }
    }

    pub fn prev(self) -> Verbosity {
        self.next().next()
    }
}

/// What the transcript toggles set.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Look {
    /// `session.thinking` "show": every thought in full. "hide" (the default) folds them.
    pub show_thinking: bool,
    /// `session.grouping` "auto" (the default): adjacent reads and searches fold into one line.
    pub grouping: bool,
    pub verbosity: Verbosity,
    pub animations: bool,
}

impl Default for Look {
    fn default() -> Look {
        Look { show_thinking: false, grouping: true, verbosity: Verbosity::Low, animations: true }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Kind {
    Activity,
    Exploration,
    Reasoning,
}

/// A group, by its first item and kind: what a click opens and closes.
pub type GroupId = (usize, Kind);

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub indent: u16,
    pub text: String,
    pub style: Style,
    pub bar: Option<Style>,
    pub bg: Option<Style>,
    /// An answer's rows: its markdown drawn (`markdown.rs`); `text` is then what they say, for a copy.
    pub spans: Vec<Span>,
}

impl Row {
    pub fn plain(indent: u16, text: String, style: Style) -> Row {
        Row { indent, text, style, bar: None, bg: None, spans: Vec::new() }
    }

    pub fn rich(indent: u16, spans: Vec<Span>) -> Row {
        Row { indent, text: spans.iter().map(|s| s.text.as_str()).collect(), style: theme::text(), bar: None, bg: None, spans }
    }

    /// The link drawn `col` columns into the row, if one is.
    pub fn link_at(&self, col: usize) -> Option<&str> {
        let mut at = self.indent as usize;
        for s in &self.spans {
            let w = unicode_width::UnicodeWidthStr::width(s.text.as_str());
            if (at..at + w).contains(&col) {
                return s.link.as_deref();
            }
            at += w;
        }
        None
    }

    pub fn blank() -> Row {
        Row::plain(0, String::new(), Style::default())
    }
}

#[derive(Debug)]
enum Node {
    Leaf(usize),
    Group { kind: Kind, first: usize, last: usize, children: Vec<Node> },
}

impl Node {
    fn first(&self) -> usize {
        match self {
            Node::Leaf(i) => *i,
            Node::Group { first, .. } => *first,
        }
    }

    fn last(&self) -> usize {
        match self {
            Node::Leaf(i) => *i,
            Node::Group { last, .. } => *last,
        }
    }
}

/// `explorationTools`, in Lykos's tool names.
fn exploration(name: &str) -> bool {
    matches!(name, "read" | "grep" | "find" | "glob" | "search" | "web_fetch" | "web_search")
}

/// `partPath`: the groups an item sits in, outermost first. Answers, prompts and notes stand alone, as do questions.
fn path(item: &Item, look: Look) -> Vec<Kind> {
    let mut out = Vec::new();
    let (inner, part) = match item {
        Item::Thinking(_) => ((!look.show_thinking).then_some(Kind::Reasoning), true),
        Item::Tool { name, .. } if name != "ask" => ((look.grouping && exploration(name)).then_some(Kind::Exploration), true),
        _ => (None, false),
    };
    if part && look.verbosity == Verbosity::Low {
        out.push(Kind::Activity);
    }
    out.extend(inner);
    out
}

/// `groupEntries`: adjacent items whose paths share a prefix share those groups.
fn nodes(items: &[Item], from: usize, look: Look) -> Vec<Node> {
    let mut top: Vec<Node> = Vec::new();
    let mut open: Vec<Kind> = Vec::new();
    for (i, item) in items.iter().enumerate().skip(from) {
        let p = path(item, look);
        let keep = open.iter().zip(&p).take_while(|(a, b)| a == b).count();
        open.truncate(keep);
        // The open groups are the last node at each depth: descend to the deepest one kept.
        let mut level = &mut top;
        for _ in 0..keep {
            let Some(Node::Group { children, last, .. }) = level.last_mut() else { unreachable!("an open group is the last node") };
            *last = i;
            level = children;
        }
        for &kind in &p[keep..] {
            level.push(Node::Group { kind, first: i, last: i, children: Vec::new() });
            open.push(kind);
            let Some(Node::Group { children, .. }) = level.last_mut() else { unreachable!() };
            level = children;
        }
        level.push(Node::Leaf(i));
    }
    top
}

/// `reasoningSummary`: a thought that opens with a bold line has that line as its title.
fn thought_title(text: &str) -> (Option<&str>, &str) {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("**") {
        if let Some(end) = rest.find("**") {
            let title = &rest[..end];
            let after = &rest[end + 2..];
            if !title.is_empty() && !title.contains('\n') && (after.is_empty() || after.starts_with("\n\n") || after.starts_with("\r\n\r\n")) {
                return (Some(title.trim()), after.trim());
            }
        }
    }
    (None, t)
}

/// `canonicalToolName`, as the summaries count: a shell is a command; edit, write and patch are edits.
fn category(name: &str) -> &'static str {
    match name {
        "bash" | "powershell" | "shell" => "command",
        "edit" | "write" | "patch" | "ast_edit" => "edit",
        "read" => "read",
        _ => "tool",
    }
}

/// What lays a session out: its items, whether it runs, and which groups the person opened.
struct Ctx<'a> {
    items: &'a [Item],
    running: bool,
    look: Look,
    width: usize,
    tick: u64,
    opened: Option<&'a BTreeMap<GroupId, bool>>,
}

impl Ctx<'_> {
    fn spinner(&self) -> char {
        if self.look.animations {
            SPINNER[(self.tick % 10) as usize]
        } else {
            '⋯'
        }
    }

    /// A thought is done once anything follows it, or the session stopped.
    fn done(&self, i: usize) -> bool {
        i + 1 < self.items.len() || !self.running
    }

    fn active(&self, i: usize) -> bool {
        match &self.items[i] {
            Item::Thinking(_) => !self.done(i),
            Item::Tool { state, .. } => *state == ToolState::Running,
            _ => false,
        }
    }

    fn expanded(&self, id: GroupId) -> bool {
        self.opened.and_then(|o| o.get(&id).copied()).unwrap_or_else(|| default_open(self.look, id.1))
    }
}

/// Whether a group shows open before a click: exploration at high verbosity.
pub fn default_open(look: Look, kind: Kind) -> bool {
    look.verbosity == Verbosity::High && kind == Kind::Exploration
}

fn leaves(node: &Node, out: &mut Vec<usize>) {
    match node {
        Node::Leaf(i) => out.push(*i),
        Node::Group { children, .. } => children.iter().for_each(|c| leaves(c, out)),
    }
}

/// `activitySummary`: what finished, counted; while nothing has, what runs (`busyLabel`).
fn activity_label(ctx: &Ctx, ids: &[usize]) -> (String, bool) {
    let mut counts: [(&str, usize); 5] = [("command", 0), ("edit", 0), ("thought", 0), ("read", 0), ("tool", 0)];
    let mut bump = |name: &str| {
        if let Some(c) = counts.iter_mut().find(|(n, _)| *n == name) {
            c.1 += 1;
        }
    };
    for &i in ids {
        if ctx.active(i) {
            continue;
        }
        match &ctx.items[i] {
            Item::Thinking(t) if !t.trim().is_empty() => bump("thought"),
            Item::Tool { name, .. } => bump(category(name)),
            _ => {}
        }
    }
    let label = counts.iter().filter(|(_, n)| *n > 0).map(|(name, n)| format!("{n} {name}{}", if *n == 1 { "" } else { "s" })).collect::<Vec<_>>().join(", ");
    let busy = ids.iter().copied().find(|&i| ctx.active(i));
    if !label.is_empty() || busy.is_none() {
        return (label, busy.is_some());
    }
    let running = match &ctx.items[busy.unwrap_or_default()] {
        Item::Tool { name, .. } => format!("Running {}…", if category(name) == "command" { "command" } else { name.as_str() }),
        _ => format!("{}…", busy_word(turn_of(ctx.items, busy.unwrap_or_default()))),
    };
    (running, true)
}

/// `GroupContent`'s exploration label: "Explored: 2 reads, 1 search".
fn exploration_label(ctx: &Ctx, ids: &[usize], done: bool) -> String {
    let mut counts: Vec<(&str, usize)> = Vec::new();
    for &i in ids {
        let Item::Tool { name, .. } = &ctx.items[i] else { continue };
        let n = match name.as_str() {
            "grep" | "find" | "glob" | "search" | "web_search" => "search",
            "web_fetch" => "fetch",
            other => other,
        };
        match counts.iter_mut().find(|(k, _)| *k == n) {
            Some(c) => c.1 += 1,
            None => counts.push((n, 1)),
        }
    }
    let names: Vec<String> = counts
        .iter()
        .map(|(n, k)| format!("{k} {}", if *k == 1 { n.to_string() } else if *n == "search" || *n == "fetch" { format!("{n}es") } else { format!("{n}s") }))
        .collect();
    format!("{}: {}", if done { "Explored" } else { "Exploring" }, names.join(", "))
}

/// Lays out one node. Group lines are noted in `heads`, by row, for the mouse.
fn render(ctx: &Ctx, node: &Node, indent: u16, rows: &mut Vec<Row>, heads: &mut Vec<(usize, GroupId)>) {
    let w = ctx.width.saturating_sub(indent as usize);
    match node {
        Node::Leaf(i) => item_rows(ctx, *i, indent, rows),
        Node::Group { kind, first, last, children } => {
            let id = (*first, *kind);
            let open = ctx.expanded(id);
            let mut ids = Vec::new();
            leaves(node, &mut ids);
            let closed = *last + 1 < ctx.items.len() || !ctx.running;
            match kind {
                Kind::Activity => {
                    let (label, active) = activity_label(ctx, &ids);
                    if label.is_empty() {
                        return;
                    }
                    let icon = if !open && active { ctx.spinner() } else if open { '−' } else { '+' };
                    heads.push((rows.len(), id));
                    push_wrapped(rows, indent, &format!("{icon} {label}"), w, theme::muted());
                    if open {
                        for child in children {
                            rows.push(Row::blank());
                            render(ctx, child, indent + 2, rows, heads);
                        }
                    }
                }
                Kind::Exploration => {
                    let done = closed || ids.iter().all(|&i| !ctx.active(i));
                    let icon = if done { '→' } else { ctx.spinner() };
                    heads.push((rows.len(), id));
                    push_wrapped(rows, indent, &format!("{icon} {}", exploration_label(ctx, &ids, done)), w, theme::muted());
                    if open {
                        for child in children {
                            render(ctx, child, indent + 2, rows, heads);
                        }
                    }
                }
                Kind::Reasoning => {
                    let thoughts: Vec<usize> = ids.iter().copied().filter(|&i| matches!(&ctx.items[i], Item::Thinking(t) if !t.trim().is_empty())).collect();
                    if thoughts.is_empty() {
                        return;
                    }
                    let latest = thoughts.iter().rev().find_map(|&i| match &ctx.items[i] {
                        Item::Thinking(t) => thought_title(t).0,
                        _ => None,
                    });
                    let done = closed || thoughts.iter().all(|&i| ctx.done(i));
                    let header = if !done {
                        let word = busy_word(turn_of(ctx.items, thoughts[0]));
                        format!("{} {}", ctx.spinner(), latest.map_or(format!("{word}…"), |t| format!("{word}: {t}")))
                    } else {
                        let mut h = format!("{} Thought", if open { '-' } else { '+' });
                        if let Some(t) = latest.filter(|_| !open) {
                            h.push_str(&format!(": {t}"));
                        }
                        if thoughts.len() > 1 {
                            h.push_str(&format!(" · {} steps", thoughts.len()));
                        }
                        h
                    };
                    heads.push((rows.len(), id));
                    push_wrapped(rows, indent, &header, w, Style::fg(c().gold));
                    if open {
                        for &i in &thoughts {
                            if let Item::Thinking(t) = &ctx.items[i] {
                                push_wrapped(rows, indent + 3, t.trim(), w.saturating_sub(3), thought_style());
                            }
                        }
                    }
                }
            }
        }
    }
}

fn thought_style() -> Style {
    Style { fg: c().muted, attr: Attr::ITALIC, ..Style::default() }
}

fn push_wrapped(rows: &mut Vec<Row>, indent: u16, text: &str, width: usize, style: Style) {
    for line in wrap(text, width) {
        rows.push(Row::plain(indent, line, style));
    }
}

/// One item, as it stands alone.
fn item_rows(ctx: &Ctx, i: usize, indent: u16, rows: &mut Vec<Row>) {
    let w = ctx.width.saturating_sub(indent as usize);
    match &ctx.items[i] {
        // A user message: a bar in the accent colour on a raised background, padded a row above and below.
        item @ (Item::User(text) | Item::Followup(text)) => {
            let user_bg = Style::default().on(c().surface);
            let bar = Style::fg(if matches!(item, Item::User(_)) { c().accent } else { c().muted }).on(c().surface);
            let edge = Row { indent: 0, text: String::new(), style: theme::text(), bar: Some(bar), bg: Some(user_bg), spans: Vec::new() };
            rows.push(edge.clone());
            for line in wrap(text, ctx.width.saturating_sub(3)) {
                rows.push(Row { indent: 2, text: line, style: theme::text(), bar: Some(bar), bg: Some(user_bg), spans: Vec::new() });
            }
            rows.push(edge);
            rows.push(Row::blank());
        }
        Item::Assistant(text) => {
            for spans in markdown::render(text.trim_end(), w.saturating_sub(3)) {
                rows.push(Row::rich(indent + 3, spans));
            }
            rows.push(Row::blank());
        }
        // Thinking shown (`ReasoningPart` outside hide mode): a header, then the thought, behind a bar.
        Item::Thinking(text) => {
            if text.trim().is_empty() {
                return;
            }
            let bar = Some(Style::fg(c().overlay));
            let header = if ctx.done(i) { "Thought".to_string() } else { format!("{} {}…", ctx.spinner(), busy_word(turn_of(ctx.items, i))) };
            rows.push(Row { indent: indent + 2, text: header, style: Style::fg(c().gold), bar, bg: None, spans: Vec::new() });
            for line in wrap(text.trim(), w.saturating_sub(5)) {
                rows.push(Row { indent: indent + 2, text: line, style: thought_style(), bar, bg: None, spans: Vec::new() });
            }
            rows.push(Row::blank());
        }
        Item::Tool { name, summary, state, .. } => {
            let (icon, style) = match state {
                ToolState::Running => (ctx.spinner(), Style::fg(c().accent)),
                ToolState::Ok => (tool_icon(name), theme::muted()),
                ToolState::Error => ('✗', Style::fg(c().love)),
            };
            push_wrapped(rows, indent + 3, &format!("{icon} {name} {summary}"), w.saturating_sub(3), style);
        }
        Item::System(text) => push_wrapped(rows, indent + 3, text, w.saturating_sub(3), theme::muted()),
    }
}

/// `routes/session/index.tsx`'s inline tool icons: `→` reads, `←` writes, `✱` searches, `%` the web, `$` a shell.
fn tool_icon(name: &str) -> char {
    match name {
        "read" | "ls" => '→',
        "write" | "edit" | "ast_edit" => '←',
        "grep" | "find" | "glob" | "search" | "ast_grep" => '✱',
        "web_fetch" | "web_search" => '%',
        "bash" | "powershell" => '$',
        _ => '⚙',
    }
}

/// A laid-out block: its rows, and its group lines by row within it.
#[derive(Debug, Default)]
pub struct Block {
    pub rows: Vec<Row>,
    pub heads: Vec<(usize, GroupId)>,
    /// The items it holds, whether it stands alone, and whether it is done changing: an item follows it or the
    /// session stopped, and nothing in it runs.
    pub first: usize,
    pub last: usize,
    pub leaf: bool,
    pub done: bool,
}

/// Blocks in order, and the row each starts on.
#[derive(Clone, Debug, Default)]
pub struct Part {
    blocks: Vec<Rc<Block>>,
    starts: Vec<usize>,
}

impl Part {
    fn push(&mut self, block: Rc<Block>, start: usize) {
        self.blocks.push(block);
        self.starts.push(start);
    }
}

/// The transcript as laid out for one frame: the settled blocks, shared with the cache from frame to frame so a
/// long session is not walked again, then the rest.
#[derive(Debug, Default)]
pub struct Layout {
    head: Rc<Part>,
    tail: Part,
    pub total: usize,
}

impl Layout {
    /// The block row `i` is in, and the row it starts on.
    fn locate(&self, i: usize) -> Option<(&Block, usize)> {
        let part = if self.tail.starts.first().is_some_and(|&s| i >= s) { &self.tail } else { &*self.head };
        let b = part.starts.partition_point(|&s| s <= i).checked_sub(1)?;
        Some((&part.blocks[b], part.starts[b]))
    }

    /// The row `i`.
    pub fn row(&self, i: usize) -> Option<&Row> {
        let (b, start) = self.locate(i)?;
        b.rows.get(i - start)
    }

    /// The first row of the block that starts with item `item`, when it stands alone (a prompt or an answer).
    pub fn item_row(&self, item: usize) -> Option<usize> {
        [&*self.head, &self.tail].into_iter().find_map(|p| {
            let b = p.blocks.binary_search_by_key(&item, |b| b.first).ok()?;
            p.blocks[b].leaf.then_some(p.starts[b])
        })
    }

    /// The group whose line is row `i`.
    pub fn head_at(&self, i: usize) -> Option<GroupId> {
        let (b, start) = self.locate(i)?;
        b.heads.iter().find(|(r, _)| *r == i - start).map(|(_, id)| *id)
    }

    /// Every block, with the row it starts on.
    pub fn blocks(&self) -> impl Iterator<Item = (usize, &Block)> {
        let (h, t): (&Part, &Part) = (&self.head, &self.tail);
        h.starts.iter().copied().zip(h.blocks.iter().map(|b| &**b)).chain(t.starts.iter().copied().zip(t.blocks.iter().map(|b| &**b)))
    }

    /// A block after the session's own: what the screen adds under them.
    pub fn push(&mut self, block: Block) {
        let n = block.rows.len();
        self.tail.push(Rc::new(block), self.total);
        self.total += n;
    }

    #[cfg(test)]
    fn block(&self, k: usize) -> (&Rc<Block>, usize) {
        let h = self.head.blocks.len();
        if k < h {
            (&self.head.blocks[k], self.head.starts[k])
        } else {
            (&self.tail.blocks[k - h], self.tail.starts[k - h])
        }
    }
}

/// What the kept blocks were laid out for; anything else lays them out again.
#[derive(Debug, Default, PartialEq)]
struct Key {
    session: String,
    width: usize,
    look: Option<Look>,
    theme: u32,
}

/// The kept blocks, by first item: the last item and the opened groups they were laid out with. And the settled
/// run from the first item, as the last layout had it: the items it holds and its rows.
#[derive(Debug, Default)]
pub struct Cache {
    key: Key,
    opened: u64,
    items: usize,
    blocks: HashMap<usize, (usize, u64, Rc<Block>)>,
    head: Rc<Part>,
    head_items: usize,
    head_rows: usize,
}

/// A hash of which groups in `node` are open: a click lays the block out again.
fn opened_sig(ctx: &Ctx, node: &Node) -> u64 {
    match node {
        Node::Leaf(_) => 0,
        Node::Group { kind, first, children, .. } => {
            let own = u64::from(ctx.expanded((*first, *kind))) << (*kind as u64);
            children.iter().fold(own.wrapping_mul(31).wrapping_add(*first as u64), |h, c| h.wrapping_mul(1_000_003) ^ opened_sig(ctx, c))
        }
    }
}

/// Lays out `session` at `width`, reusing the blocks `cache` kept.
pub fn layout(cache: &RefCell<Cache>, session: &Session, look: Look, width: usize, tick: u64, opened: Option<&BTreeMap<GroupId, bool>>) -> Layout {
    let items = &session.items;
    let running = matches!(session.summary.status, SessionStatus::Running | SessionStatus::Waiting | SessionStatus::Starting);
    let ctx = Ctx { items, running, look, width, tick, opened };
    let mut cache = cache.borrow_mut();
    let opened_hash = opened.map_or(0, |o| o.iter().fold(17u64, |h, ((i, k), on)| h.wrapping_mul(1_000_003) ^ ((*i as u64) << 3 | (*k as u64) << 1 | u64::from(*on))));
    let same = cache.key.session == session.summary.id && cache.key.width == width && cache.key.look == Some(look) && cache.key.theme == theme::version();
    // A session rebuilt shorter (an undo) has new items where the kept ones were.
    if !same || items.len() < cache.items {
        cache.key = Key { session: session.summary.id.clone(), width, look: Some(look), theme: theme::version() };
        cache.blocks.clear();
    }
    // A click lays the settled run out again, from the kept blocks.
    if !same || items.len() < cache.items || cache.opened != opened_hash {
        cache.opened = opened_hash;
        (cache.head, cache.head_items, cache.head_rows) = (Rc::default(), 0, 0);
    }
    cache.items = items.len();
    let mut head = std::mem::take(&mut cache.head);
    let (mut tail, mut total, mut growing) = (Part::default(), cache.head_rows, true);
    for node in nodes(items, cache.head_items, look) {
        let (first, last) = (node.first(), node.last());
        let sig = opened_sig(&ctx, &node);
        let quiet = !(first..=last).any(|i| ctx.active(i));
        let settled = last + 1 < items.len() && quiet;
        let done = (last + 1 < items.len() || !running) && quiet;
        let kept = cache.blocks.get(&first).filter(|(l, s, _)| settled && *l == last && *s == sig).map(|(_, _, b)| b.clone());
        let block = kept.unwrap_or_else(|| {
            let mut b = Block { first, last, leaf: matches!(node, Node::Leaf(_)), done, ..Block::default() };
            render(&ctx, &node, 0, &mut b.rows, &mut b.heads);
            if matches!(node, Node::Group { .. }) && !b.rows.is_empty() {
                b.rows.push(Row::blank());
            }
            let b = Rc::new(b);
            if settled {
                cache.blocks.insert(first, (last, sig, b.clone()));
            }
            b
        });
        let n = block.rows.len();
        // The run from the first item grows while each block is settled; the first that is not ends it.
        if growing && settled {
            Rc::make_mut(&mut head).push(block, total);
            (cache.head_items, cache.head_rows) = (last + 1, total + n);
        } else {
            growing = false;
            tail.push(block, total);
        }
        total += n;
    }
    cache.head = head.clone();
    Layout { head, tail, total }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lykos_client::SessionSummary;

    fn tool(name: &str, state: ToolState) -> Item {
        Item::Tool { id: name.into(), name: name.into(), summary: "x".into(), state, preview: None, diff: None }
    }

    fn session(items: Vec<Item>, status: SessionStatus) -> Session {
        let summary = SessionSummary { id: "s1".into(), cwd: "/w".into(), status, model: "m".into(), title: None, started_at: String::new(), origin: "tui".into(), ledger_session_id: None };
        let mut s = Session::new(summary);
        s.items = items;
        s
    }

    fn text(l: &Layout) -> Vec<String> {
        (0..l.total).map(|i| l.row(i).map(|r| r.text.clone()).unwrap_or_default()).filter(|t| !t.is_empty()).collect()
    }

    fn work() -> Vec<Item> {
        vec![
            Item::User("go".into()),
            Item::Thinking("**Reading the code**\n\nfirst".into()),
            tool("read", ToolState::Ok),
            tool("grep", ToolState::Ok),
            tool("bash", ToolState::Ok),
            tool("edit", ToolState::Ok),
            Item::Thinking("again".into()),
            Item::Assistant("done".into()),
        ]
    }

    #[test]
    fn low_folds_a_run_into_one_summary_and_a_click_opens_it() {
        let s = session(work(), SessionStatus::Idle);
        let cache = RefCell::new(Cache::default());
        let l = layout(&cache, &s, Look::default(), 60, 0, None);
        assert_eq!(text(&l), ["go", "+ 1 command, 1 edit, 2 thoughts, 1 read, 1 tool", "done"]);
        let head = (0..l.total).find_map(|i| l.head_at(i)).unwrap();
        assert_eq!(head, (1, Kind::Activity));
        let opened = BTreeMap::from([(head, true)]);
        let l = layout(&cache, &s, Look::default(), 60, 0, Some(&opened));
        let t = text(&l);
        assert_eq!(t[1], "− 1 command, 1 edit, 2 thoughts, 1 read, 1 tool");
        assert!(t.contains(&"+ Thought: Reading the code".to_string()), "{t:?}");
        assert!(t.contains(&"→ Explored: 1 read, 1 search".to_string()), "{t:?}");
        assert!(t.contains(&"$ bash x".to_string()), "{t:?}");
    }

    #[test]
    fn medium_groups_thoughts_and_reads_high_opens_reads_and_show_lists_thoughts() {
        let s = session(work(), SessionStatus::Idle);
        let cache = RefCell::new(Cache::default());
        let medium = Look { verbosity: Verbosity::Medium, ..Look::default() };
        assert_eq!(text(&layout(&cache, &s, medium, 60, 0, None)), ["go", "+ Thought: Reading the code", "→ Explored: 1 read, 1 search", "$ bash x", "← edit x", "+ Thought", "done"]);
        let high = Look { verbosity: Verbosity::High, ..Look::default() };
        let t = text(&layout(&cache, &s, high, 60, 0, None));
        assert!(t.contains(&"→ read x".to_string()) && t.contains(&"✱ grep x".to_string()), "{t:?}");
        let ungrouped = Look { verbosity: Verbosity::Medium, grouping: false, show_thinking: true, ..Look::default() };
        let t = text(&layout(&cache, &s, ungrouped, 60, 0, None));
        assert_eq!(&t[..6], ["go", "Thought", "**Reading the code**", "first", "→ read x", "✱ grep x"], "shown in full, the title in it");
    }

    #[test]
    fn a_running_run_says_what_runs_and_settled_blocks_are_kept() {
        let mut items = vec![Item::User("go".into()), tool("bash", ToolState::Running)];
        let s = session(items.clone(), SessionStatus::Running);
        let cache = RefCell::new(Cache::default());
        let look = Look { animations: false, ..Look::default() };
        assert_eq!(text(&layout(&cache, &s, look, 60, 0, None))[1], "⋯ Running command…");
        items[1] = tool("bash", ToolState::Ok);
        items.push(Item::Assistant("ok".into()));
        let s = session(items, SessionStatus::Running);
        let a = layout(&cache, &s, look, 60, 0, None);
        let b = layout(&cache, &s, look, 60, 0, None);
        assert!(Rc::ptr_eq(a.block(1).0, b.block(1).0), "a finished run is laid out once");
        assert!(!Rc::ptr_eq(a.block(2).0, b.block(2).0), "the last item may still stream");
        assert_eq!(a.item_row(2), Some(a.block(2).1));
        drop((a, b));
        assert_eq!(cache.borrow().head_items, 2, "the settled run holds the prompt and the run");
        // A click on a group in the settled run lays it out again.
        let s = session(vec![Item::User("go".into()), tool("bash", ToolState::Ok), Item::Assistant("ok".into())], SessionStatus::Idle);
        let opened = BTreeMap::from([((1, Kind::Activity), true)]);
        assert!(text(&layout(&cache, &s, look, 60, 0, Some(&opened))).contains(&"$ bash x".to_string()));
        assert!(!text(&layout(&cache, &s, look, 60, 0, None)).contains(&"$ bash x".to_string()));
    }

    #[test]
    fn a_long_session_lays_out_only_what_is_new() {
        let mut items = Vec::new();
        for i in 0..10_000 {
            items.push(if i % 2 == 0 { Item::User(format!("q{i}")) } else { Item::Assistant(format!("a{i}")) });
        }
        let s = session(items, SessionStatus::Idle);
        let cache = RefCell::new(Cache::default());
        let first = layout(&cache, &s, Look::default(), 60, 0, None);
        let again = layout(&cache, &s, Look::default(), 60, 0, None);
        assert!(Rc::ptr_eq(&first.head, &again.head), "the settled run is shared, not walked");
        assert_eq!((first.total, again.total), (again.total, first.blocks().count() * 3), "a blank, the text, a blank");
        assert_eq!(again.row(again.total - 2).map(|r| r.text.as_str()), Some("a9999"));
    }
}
