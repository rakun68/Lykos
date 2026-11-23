//! Key bindings (P5 #39): every action the TUI has, its default keys, and the config layer that changed them.
//! OpenCode `config/keybind.ts` at `4332e24`: action names, defaults and the value forms are its, read from source
//! (a key list `"ctrl+x,<leader>q"` or an array; `none` or `false` unbinds; `leader` is a key of its own). Lykos's
//! defaults differ where the old TUI's keys stay (`docs/reference/ui.md` §5 lists each). The server reads the
//! config layers (`config.keybinds`); this module knows the names, so a name it does not know is refused here.
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::Value;

/// One key with its modifiers, as matched: a letter under ctrl, alt or super in lower case, and a character typed
/// alone without its shift, which the character already carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Chord {
    pub code: KeyCode,
    pub mods: KeyModifiers,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Binding {
    /// After the leader key.
    pub leader: bool,
    pub chord: Chord,
}

pub struct Def {
    pub id: &'static str,
    pub keys: &'static str,
    pub title: &'static str,
    pub group: &'static str,
}

const fn def(id: &'static str, keys: &'static str, title: &'static str, group: &'static str) -> Def {
    Def { id, keys, title, group }
}

/// The groups, in the order the palette and the help list them.
pub const GROUPS: [&str; 8] = ["App", "Session", "Agent", "System", "Prompt", "Input", "Autocomplete", "Dialog"];

/// What a group's actions are: run from anywhere, and so listed in the palette, or only inside a list or dialog.
pub fn in_palette(group: &str) -> bool {
    matches!(group, "App" | "Session" | "Agent" | "System" | "Prompt" | "Input")
}

pub const LEADER_DEFAULT: &str = "ctrl+x";

/// Every action, in the order a key tries them: where two share a key, the first that applies wins (ctrl+c copies
/// a selection, else clears the prompt, else exits).
pub const DEFS: &[Def] = &[
    def("command.palette.show", "ctrl+p", "List available commands", "App"),
    def("help.show", "none", "Open help dialog", "App"),
    def("prompt.copy", "ctrl+c", "Copy the selection", "Prompt"),
    def("prompt.cut", "ctrl+x", "Cut the selection", "Prompt"),
    def("prompt.clear", "ctrl+c", "Clear input field", "Prompt"),
    def("app.exit", "ctrl+c,ctrl+d", "Exit the application", "App"),
    def("session.interrupt", "escape", "Interrupt current session", "Session"),
    def("session.page.up", "pageup,ctrl+alt+b", "Scroll messages up by one page", "Session"),
    def("session.page.down", "pagedown,ctrl+alt+f", "Scroll messages down by one page", "Session"),
    def("session.line.up", "ctrl+alt+y", "Scroll messages up by one line", "Session"),
    def("session.line.down", "ctrl+alt+e", "Scroll messages down by one line", "Session"),
    def("session.half.page.up", "ctrl+alt+u", "Scroll messages up by half page", "Session"),
    def("session.half.page.down", "ctrl+alt+d", "Scroll messages down by half page", "Session"),
    def("session.first", "ctrl+g,alt+home", "Navigate to first message", "Session"),
    def("session.last", "ctrl+alt+g", "Navigate to last message", "Session"),
    def("session.queued_prompts", "<leader>q", "Manage queued prompts", "Session"),
    def("session.aside", "none", "Ask a side question", "Session"),
    // OpenCode's model, variant (Lykos: effort) and agent (Lykos: specialist) actions.
    def("model.list", "<leader>m", "List available models", "Agent"),
    def("model.cycle_recent", "f2", "Next recently used model", "Agent"),
    def("model.cycle_recent_reverse", "shift+f2", "Previous recently used model", "Agent"),
    def("model.cycle_favorite", "none", "Next favorite model", "Agent"),
    def("model.cycle_favorite_reverse", "none", "Previous favorite model", "Agent"),
    def("variant.cycle", "ctrl+t", "Cycle thinking effort", "Agent"),
    def("variant.list", "none", "List thinking effort levels", "Agent"),
    def("agent.list", "<leader>a", "List specialists", "Agent"),
    def("agent.cycle", "shift+tab", "Next specialist", "Agent"),
    def("agent.cycle.reverse", "none", "Previous specialist", "Agent"),
    def("usage.show", "none", "View usage", "Agent"),
    def("mcp.list", "none", "List MCP servers", "Agent"),
    def("provider.connect", "none", "Connect a provider", "Agent"),
    def("theme.switch", "none", "List available themes", "System"),
    def("theme.switch_mode", "none", "Switch between light and dark theme mode", "System"),
    def("lykos.status", "<leader>s", "View status", "System"),
    def("lykos.debug", "none", "View debug info", "System"),
    def("prompt.queue", "<leader>return", "Queue prompt", "Prompt"),
    def("prompt.editor", "<leader>e", "Open external editor", "Prompt"),
    def("prompt.images.view", "<leader>i", "View image attachments", "Prompt"),
    def("prompt.stash", "none", "Stash prompt", "Prompt"),
    def("prompt.stash.pop", "none", "Pop stashed prompt", "Prompt"),
    def("prompt.stash.list", "none", "List stashed prompts", "Prompt"),
    def("prompt.paste", "ctrl+v", "Paste what was cut or copied", "Prompt"),
    def("prompt.history.previous", "ctrl+up", "Previous history item", "Prompt"),
    def("prompt.history.next", "ctrl+down", "Next history item", "Prompt"),
    def("prompt.history.search", "ctrl+r", "Search history", "Prompt"),
    def("input.submit", "return", "Submit input", "Input"),
    def("input.newline", "shift+return,ctrl+return,alt+return,ctrl+j", "Insert newline in input", "Input"),
    def("input.move.left", "left,ctrl+b", "Move cursor left in input", "Input"),
    def("input.move.right", "right,ctrl+f", "Move cursor right in input", "Input"),
    def("input.move.up", "up", "Move cursor up in input", "Input"),
    def("input.move.down", "down", "Move cursor down in input", "Input"),
    def("input.select.left", "shift+left", "Select left in input", "Input"),
    def("input.select.right", "shift+right", "Select right in input", "Input"),
    def("input.select.up", "shift+up", "Select up in input", "Input"),
    def("input.select.down", "shift+down", "Select down in input", "Input"),
    def("input.line.home", "ctrl+a,home", "Move to start of line in input", "Input"),
    def("input.line.end", "ctrl+e,end", "Move to end of line in input", "Input"),
    def("input.select.line.home", "ctrl+shift+a", "Select to start of line in input", "Input"),
    def("input.select.line.end", "ctrl+shift+e", "Select to end of line in input", "Input"),
    def("input.visual.line.home", "alt+a", "Move to start of visual line in input", "Input"),
    def("input.visual.line.end", "alt+e", "Move to end of visual line in input", "Input"),
    def("input.select.visual.line.home", "alt+shift+a", "Select to start of visual line in input", "Input"),
    def("input.select.visual.line.end", "alt+shift+e", "Select to end of visual line in input", "Input"),
    def("input.buffer.home", "none", "Move to start of buffer in input", "Input"),
    def("input.buffer.end", "none", "Move to end of buffer in input", "Input"),
    def("input.select.buffer.home", "shift+home", "Select to start of buffer in input", "Input"),
    def("input.select.buffer.end", "shift+end", "Select to end of buffer in input", "Input"),
    def("input.delete.line", "ctrl+shift+d", "Delete line in input", "Input"),
    def("input.delete.to.line.end", "ctrl+k", "Delete to end of line in input", "Input"),
    def("input.delete.to.line.start", "ctrl+u", "Delete to start of line in input", "Input"),
    def("input.backspace", "backspace,shift+backspace", "Backspace in input", "Input"),
    def("input.delete", "ctrl+d,delete,shift+delete", "Delete character in input", "Input"),
    def("input.undo", "ctrl+-,ctrl+_,super+z,ctrl+z", "Undo in input", "Input"),
    def("input.redo", "ctrl+.,super+shift+z,ctrl+y,ctrl+shift+z", "Redo in input", "Input"),
    def("input.word.forward", "alt+f,alt+right,ctrl+right", "Move word forward in input", "Input"),
    def("input.word.backward", "alt+b,alt+left,ctrl+left", "Move word backward in input", "Input"),
    def("input.select.word.forward", "alt+shift+f,alt+shift+right,ctrl+shift+right", "Select word forward in input", "Input"),
    def("input.select.word.backward", "alt+shift+b,alt+shift+left,ctrl+shift+left", "Select word backward in input", "Input"),
    def("input.delete.word.forward", "alt+d,alt+delete,ctrl+delete", "Delete word forward in input", "Input"),
    def("input.delete.word.backward", "ctrl+w,ctrl+backspace,alt+backspace,ctrl+h", "Delete word backward in input", "Input"),
    def("input.select.all", "super+a", "Select all in input", "Input"),
    def("prompt.autocomplete.prev", "up,ctrl+p", "Move to previous autocomplete item", "Autocomplete"),
    def("prompt.autocomplete.next", "down,ctrl+n", "Move to next autocomplete item", "Autocomplete"),
    def("prompt.autocomplete.hide", "escape", "Hide autocomplete", "Autocomplete"),
    def("prompt.autocomplete.select", "return", "Select autocomplete item", "Autocomplete"),
    def("prompt.autocomplete.complete", "tab", "Complete autocomplete item", "Autocomplete"),
    def("dialog.select.prev", "up,ctrl+p", "Move to previous dialog item", "Dialog"),
    def("dialog.select.next", "down,ctrl+n", "Move to next dialog item", "Dialog"),
    def("dialog.select.page_up", "pageup", "Move up one page in dialog", "Dialog"),
    def("dialog.select.page_down", "pagedown", "Move down one page in dialog", "Dialog"),
    def("dialog.select.home", "home", "Move to first dialog item", "Dialog"),
    def("dialog.select.end", "end", "Move to last dialog item", "Dialog"),
    def("dialog.select.submit", "return", "Submit selected dialog item", "Dialog"),
    def("dialog.close", "escape", "Close the dialog", "Dialog"),
    def("queued_prompt.undo", "ctrl+u", "Undo queued prompt", "Dialog"),
    def("queued_prompt.delete", "ctrl+d,delete", "Delete queued prompt", "Dialog"),
    def("stash.delete", "ctrl+d,delete", "Delete stash entry", "Dialog"),
    def("aside.copy", "c", "Copy the side answer", "Dialog"),
    def("debug.copy", "c", "Copy the debug info", "Dialog"),
    def("model.dialog.provider", "ctrl+a", "Open provider list from model dialog", "Dialog"),
    def("model.dialog.favorite", "ctrl+f", "Toggle model favorite status", "Dialog"),
    def("model.dialog.usage", "ctrl+u", "Open usage from model dialog", "Dialog"),
];

pub fn index(id: &str) -> Option<usize> {
    DEFS.iter().position(|d| d.id == id)
}

/// The chord a key event is matched as.
pub fn chord(ev: &KeyEvent) -> Chord {
    let mut mods = ev.modifiers & (KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SHIFT | KeyModifiers::SUPER);
    let code = match ev.code {
        KeyCode::Char(c) if mods.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) => KeyCode::Char(c.to_ascii_lowercase()),
        KeyCode::Char(c) => {
            mods.remove(KeyModifiers::SHIFT);
            KeyCode::Char(c)
        }
        KeyCode::BackTab => {
            mods.insert(KeyModifiers::SHIFT);
            KeyCode::Tab
        }
        c => c,
    };
    Chord { code, mods }
}

/// One key as written in config: `ctrl+shift+a`, `<leader>e`, `return`, `pageup`, `?`.
pub fn parse(text: &str) -> Result<Binding, String> {
    let t = text.trim();
    let (leader, rest) = match t.strip_prefix("<leader>") {
        Some(r) => (true, r.trim_start()),
        None => (false, t),
    };
    let (mods_part, name) = if rest.len() > 1 && rest.ends_with("++") {
        (&rest[..rest.len() - 2], "+")
    } else {
        match rest.rfind('+') {
            Some(i) if i + 1 < rest.len() => (&rest[..i], &rest[i + 1..]),
            _ => ("", rest),
        }
    };
    let mut mods = KeyModifiers::NONE;
    for m in mods_part.split('+').filter(|m| !m.is_empty()) {
        mods |= match m.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => KeyModifiers::CONTROL,
            "alt" | "meta" | "option" => KeyModifiers::ALT,
            "shift" => KeyModifiers::SHIFT,
            "super" | "cmd" | "win" => KeyModifiers::SUPER,
            _ => return Err(format!("unknown modifier \"{m}\" in \"{text}\"")),
        };
    }
    let lower = name.to_ascii_lowercase();
    let code = match lower.as_str() {
        "" => return Err(format!("no key in \"{text}\"")),
        "return" | "enter" => KeyCode::Enter,
        "escape" | "esc" => KeyCode::Esc,
        "tab" => KeyCode::Tab,
        "backspace" => KeyCode::Backspace,
        "delete" | "del" => KeyCode::Delete,
        "insert" => KeyCode::Insert,
        "up" => KeyCode::Up,
        "down" => KeyCode::Down,
        "left" => KeyCode::Left,
        "right" => KeyCode::Right,
        "home" | "kphome" => KeyCode::Home,
        "end" | "kpend" => KeyCode::End,
        "pageup" | "kppageup" => KeyCode::PageUp,
        "pagedown" | "kppagedown" => KeyCode::PageDown,
        "space" => KeyCode::Char(' '),
        f if f.len() > 1 && f.starts_with('f') && f[1..].parse::<u8>().is_ok_and(|n| (1..=24).contains(&n)) => KeyCode::F(f[1..].parse().unwrap_or(1)),
        _ => {
            let mut chars = name.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => KeyCode::Char(c),
                _ => return Err(format!("unknown key \"{name}\" in \"{text}\"")),
            }
        }
    };
    // Matched as `chord` makes them: `shift+g` is `G`, and a letter under a modifier is lower case.
    let code = match code {
        KeyCode::Char(c) if !mods.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) => {
            let shifted = mods.contains(KeyModifiers::SHIFT);
            mods.remove(KeyModifiers::SHIFT);
            KeyCode::Char(if shifted { c.to_ascii_uppercase() } else { c })
        }
        KeyCode::Char(c) => KeyCode::Char(c.to_ascii_lowercase()),
        c => c,
    };
    Ok(Binding { leader, chord: Chord { code, mods } })
}

/// A config value: a key list, a list of keys, `none` or `false`.
pub fn parse_value(v: &Value) -> Result<Vec<Binding>, String> {
    let items: Vec<&str> = match v {
        Value::Bool(false) => return Ok(Vec::new()),
        Value::String(s) => vec![s.as_str()],
        Value::Array(a) => a.iter().map(|x| x.as_str().ok_or_else(|| "a key list holds only strings".to_string())).collect::<Result<_, _>>()?,
        _ => return Err("a key list, a list of keys, \"none\" or false".into()),
    };
    let mut out = Vec::new();
    for item in items {
        for key in item.split(',').map(str::trim).filter(|k| !k.is_empty()) {
            if key.eq_ignore_ascii_case("none") {
                continue;
            }
            out.push(parse(key)?);
        }
    }
    Ok(out)
}

fn defaults(keys: &str) -> Vec<Binding> {
    parse_value(&Value::String(keys.into())).unwrap_or_default()
}

pub struct Keymap {
    pub leader: Vec<Chord>,
    leader_source: Option<String>,
    binds: Vec<Vec<Binding>>,
    /// The layer that set each action's keys; `None` is the default.
    sources: Vec<Option<String>>,
}

impl Default for Keymap {
    fn default() -> Keymap {
        Keymap {
            leader: defaults(LEADER_DEFAULT).into_iter().map(|b| b.chord).collect(),
            leader_source: None,
            binds: DEFS.iter().map(|d| defaults(d.keys)).collect(),
            sources: vec![None; DEFS.len()],
        }
    }
}

impl Keymap {
    /// Applies `config.keybinds`' answer, `{name: {value, source}}`. What it cannot read is skipped and named in
    /// the problems returned; the rest applies.
    pub fn apply(&mut self, keybinds: &Value) -> Vec<String> {
        let mut problems = Vec::new();
        let Some(map) = keybinds.as_object() else { return problems };
        for (name, setting) in map {
            let source = setting["source"].as_str().unwrap_or("config").to_string();
            let parsed = parse_value(&setting["value"]);
            match (name.as_str(), parsed) {
                (_, Err(e)) => problems.push(format!("keybind {name} ({source}): {e}")),
                ("leader", Ok(b)) if b.iter().any(|b| b.leader) => problems.push(format!("keybind leader ({source}): the leader cannot use <leader>")),
                ("leader", Ok(b)) => {
                    self.leader = b.into_iter().map(|b| b.chord).collect();
                    self.leader_source = Some(source);
                }
                (n, Ok(b)) => match index(n) {
                    Some(i) => {
                        self.binds[i] = b;
                        self.sources[i] = Some(source);
                    }
                    None => problems.push(format!("unknown keybind {name} ({source})")),
                },
            }
        }
        problems
    }

    /// The actions bound to this key, in the order they are tried.
    pub fn matches(&self, ev: &KeyEvent, after_leader: bool) -> Vec<&'static str> {
        let c = chord(ev);
        DEFS.iter().zip(&self.binds).filter(|(_, b)| b.iter().any(|b| b.leader == after_leader && b.chord == c)).map(|(d, _)| d.id).collect()
    }

    pub fn is_leader(&self, ev: &KeyEvent) -> bool {
        let c = chord(ev);
        self.leader.contains(&c)
    }

    /// An action's keys as shown: `ctrl+x e, ctrl+q`; empty when unbound.
    pub fn keys(&self, id: &str) -> String {
        let Some(i) = index(id) else { return String::new() };
        let leader = self.leader.first().map(label).unwrap_or_else(|| "<leader>".into());
        self.binds[i].iter().map(|b| if b.leader { format!("{leader} {}", label(&b.chord)) } else { label(&b.chord) }).collect::<Vec<_>>().join(", ")
    }

    /// An action's first key, for a hint: `none` when unbound.
    pub fn first(&self, id: &str) -> String {
        let keys = self.keys(id);
        match keys.split(", ").next() {
            Some(k) if !k.is_empty() => k.to_string(),
            _ => "none".into(),
        }
    }

    /// The layer that set an action's keys, or `default`.
    pub fn source(&self, id: &str) -> &str {
        let s = if id == "leader" { self.leader_source.as_deref() } else { index(id).and_then(|i| self.sources[i].as_deref()) };
        s.unwrap_or("default")
    }

    pub fn leader_label(&self) -> String {
        self.leader.iter().map(label).collect::<Vec<_>>().join(", ")
    }
}

/// A chord as config writes it.
pub fn label(c: &Chord) -> String {
    let mut out = String::new();
    for (m, name) in [(KeyModifiers::CONTROL, "ctrl+"), (KeyModifiers::ALT, "alt+"), (KeyModifiers::SUPER, "super+"), (KeyModifiers::SHIFT, "shift+")] {
        if c.mods.contains(m) {
            out.push_str(name);
        }
    }
    match c.code {
        KeyCode::Enter => out.push_str("return"),
        KeyCode::Esc => out.push_str("esc"),
        KeyCode::Tab => out.push_str("tab"),
        KeyCode::Backspace => out.push_str("backspace"),
        KeyCode::Delete => out.push_str("delete"),
        KeyCode::Insert => out.push_str("insert"),
        KeyCode::Up => out.push_str("up"),
        KeyCode::Down => out.push_str("down"),
        KeyCode::Left => out.push_str("left"),
        KeyCode::Right => out.push_str("right"),
        KeyCode::Home => out.push_str("home"),
        KeyCode::End => out.push_str("end"),
        KeyCode::PageUp => out.push_str("pageup"),
        KeyCode::PageDown => out.push_str("pagedown"),
        KeyCode::Char(' ') => out.push_str("space"),
        KeyCode::Char(ch) => out.push(ch),
        KeyCode::F(n) => out.push_str(&format!("f{n}")),
        _ => out.push('?'),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(code: KeyCode, mods: KeyModifiers) -> KeyEvent {
        KeyEvent::new(code, mods)
    }

    #[test]
    fn every_default_parses_and_names_are_unique() {
        for d in DEFS {
            if d.keys != "none" {
                assert!(!defaults(d.keys).is_empty(), "{} {}", d.id, d.keys);
            }
            assert_eq!(DEFS.iter().filter(|o| o.id == d.id).count(), 1, "{}", d.id);
        }
    }

    #[test]
    fn keys_parse_as_events_match() {
        let k = Keymap::default();
        assert_eq!(k.matches(&ev(KeyCode::Char('c'), KeyModifiers::CONTROL), false), ["prompt.copy", "prompt.clear", "app.exit"]);
        // A terminal sends ctrl+shift+a as an upper-case letter.
        assert_eq!(k.matches(&ev(KeyCode::Char('A'), KeyModifiers::CONTROL | KeyModifiers::SHIFT), false), ["input.select.line.home"]);
        assert_eq!(k.matches(&ev(KeyCode::Enter, KeyModifiers::NONE), true), ["prompt.queue"]);
        assert_eq!(k.matches(&ev(KeyCode::Char('e'), KeyModifiers::NONE), true), ["prompt.editor"]);
        assert!(k.is_leader(&ev(KeyCode::Char('x'), KeyModifiers::CONTROL)));
        assert_eq!(parse("shift+g").unwrap().chord, chord(&ev(KeyCode::Char('G'), KeyModifiers::SHIFT)));
        assert_eq!(parse("ctrl++").unwrap().chord, Chord { code: KeyCode::Char('+'), mods: KeyModifiers::CONTROL });
        assert!(parse("hyper+a").is_err());
        assert!(parse("ctrl+nope").is_err());
    }

    #[test]
    fn config_rebinds_unbinds_and_adds_keys_and_says_where() {
        let mut k = Keymap::default();
        let problems = k.apply(&json!({
            "leader": { "value": "ctrl+o", "source": "global (g.yaml)" },
            "app.exit": { "value": "none", "source": "project (p.yaml)" },
            "input.undo": { "value": ["ctrl+z", "alt+u"], "source": "project (p.yaml)" },
            "session.aside": { "value": "<leader>b", "source": "project (p.yaml)" },
            "nope.action": { "value": "ctrl+q", "source": "project (p.yaml)" },
            "prompt.clear": { "value": "ctrl+what", "source": "project (p.yaml)" },
        }));
        assert_eq!(problems.len(), 2, "{problems:?}");
        assert!(problems.iter().any(|p| p.contains("unknown keybind nope.action")));
        assert_eq!(k.matches(&ev(KeyCode::Char('c'), KeyModifiers::CONTROL), false), ["prompt.copy", "prompt.clear"], "exit unbound");
        assert_eq!(k.keys("app.exit"), "");
        assert_eq!(k.keys("input.undo"), "ctrl+z, alt+u");
        assert_eq!(k.keys("session.aside"), "ctrl+o b");
        assert_eq!(k.source("input.undo"), "project (p.yaml)");
        assert_eq!(k.source("leader"), "global (g.yaml)");
        assert_eq!(k.source("input.redo"), "default");
        assert!(k.is_leader(&ev(KeyCode::Char('o'), KeyModifiers::CONTROL)));
        assert!(!k.is_leader(&ev(KeyCode::Char('x'), KeyModifiers::CONTROL)));
        assert_eq!(k.matches(&ev(KeyCode::Char('b'), KeyModifiers::NONE), true), ["session.aside"]);
        assert_eq!(k.keys("prompt.clear"), "ctrl+c", "a bad value leaves the default");
    }
}
