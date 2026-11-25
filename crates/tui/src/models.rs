//! The model list and the model picker. The list has a section for each connected provider: the models shown from it,
//! then "Select models…", which opens the picker. The picker lists every model the provider's endpoint offers; Enter
//! shows or hides one (all start hidden), Ctrl+R renames it (its id stays), and left and right set the effort a switch
//! to it sets. What the picker sets is kept in `~/.lykos/tui/state.json` (`prefs.rs`).
//!
//! A model chosen with no session open is the one the next session starts on.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use lykos_client::ProviderModel;
use serde_json::json;

use crate::app::{select, tokens, Action, App, Dialog, List, Row, Then, ToastKind};
use crate::menu;
use crate::prefs::ModelPref;

/// The value of a model list row that opens the picker for the provider named after it.
pub const MORE: &str = "select-models:";

/// The efforts a picker row cycles through: none (the session's own), then each the model takes.
fn effort_choices(m: &ProviderModel) -> Vec<Option<String>> {
    let takes: Vec<&String> = m.efforts.iter().filter(|e| e.as_str() != "off").collect();
    if takes.is_empty() {
        return Vec::new();
    }
    std::iter::once(None).chain(m.efforts.iter().map(|e| Some(e.clone()))).collect()
}

impl App {
    /// The model list's rows. With no query: Favorites, Recent, then each connected provider's shown models and its
    /// "Select models…" row. A search ranks the shown models, favorites first.
    pub fn model_rows(&self, query: &str) -> Vec<Row> {
        let now = self.model_now();
        let connected: Vec<&str> = self.providers.iter().flatten().filter(|p| p.configured).map(|p| p.name.as_str()).collect();
        let provider_of = |key: &str| key.split('/').next().unwrap_or_default().to_string();
        // The shown models of connected providers, and the model in use though it is not shown.
        let mut models: Vec<(String, ModelPref)> =
            self.prefs.shown().filter(|(k, _)| connected.contains(&provider_of(k).as_str())).map(|(k, m)| (k.clone(), m.clone())).collect();
        if let Some(now) = &now {
            if !models.iter().any(|(k, _)| k == now) && now.contains('/') {
                let own = self.options.as_ref().and_then(|o| o.models.iter().find(|m| format!("{}/{}", m.provider, m.id) == *now));
                let pref = self.prefs.model(now).cloned().unwrap_or_else(|| ModelPref {
                    label: own.map_or_else(|| now.split_once('/').map_or(now.clone(), |(_, id)| id.to_string()), |m| m.name.clone()),
                    context: own.and_then(|m| m.context_window),
                    reasoning: own.is_some_and(|m| m.reasoning),
                    ..ModelPref::default()
                });
                models.push((now.clone(), pref));
            }
        }
        let make = |key: &str, m: &ModelPref, group: &str| {
            let mut detail = Vec::new();
            if let Some(e) = &m.effort {
                detail.push(e.clone());
            }
            if let Some(c) = m.context {
                detail.push(tokens(c));
            }
            let fav = self.prefs.favorite.iter().any(|f| f == key);
            Row { value: key.to_string(), title: m.name().to_string(), detail: detail.join(" · "), group: group.to_string(), current: now.as_deref() == Some(key), favorite: fav }
        };
        if !query.is_empty() {
            let mut scored: Vec<(bool, u32, Row)> = models
                .iter()
                .filter_map(|(k, m)| {
                    let s = [menu::score(query, m.name()), menu::score(query, k)];
                    s.iter().any(Option::is_some).then(|| {
                        let r = make(k, m, "");
                        (r.favorite, s.iter().flatten().sum(), r)
                    })
                })
                .collect();
            scored.sort_by_key(|(f, s, _)| (std::cmp::Reverse(*f), std::cmp::Reverse(*s)));
            return scored.into_iter().map(|(_, _, r)| r).collect();
        }
        let find = |key: &String| models.iter().find(|(k, _)| k == key);
        let mut out: Vec<Row> = self.prefs.favorite.iter().filter_map(find).map(|(k, m)| make(k, m, "Favorites")).collect();
        out.extend(self.prefs.recent.iter().filter(|k| !self.prefs.favorite.contains(k)).filter_map(find).map(|(k, m)| make(k, m, "Recent")));
        let listed: Vec<String> = out.iter().map(|r| r.value.clone()).collect();
        for provider in &connected {
            for (k, m) in models.iter().filter(|(k, _)| provider_of(k) == *provider && !listed.contains(k)) {
                out.push(make(k, m, provider));
            }
            out.push(Row { value: format!("{MORE}{provider}"), title: "Select models…".into(), detail: String::new(), group: provider.to_string(), current: false, favorite: false });
        }
        out
    }

    /// Switches to `key` (`provider/id`) and sets the effort the picker gave it. With no session open, the next session
    /// starts on it.
    pub fn switch_model(&mut self, key: &str) -> Vec<Action> {
        self.prefs.used(key);
        let pref = self.prefs.model(key).cloned();
        let effort = pref.as_ref().and_then(|m| m.effort.clone());
        self.next_model = Some(key.to_string());
        match self.live() {
            Some(session) => {
                let mut out = self.command(format!("/model {key}"));
                if let Some(e) = effort {
                    out.push(Action::Prompt { session, text: format!("/effort {e}") });
                }
                out
            }
            None => {
                self.next_effort = effort;
                let name = pref.map_or_else(|| key.to_string(), |m| m.name().to_string());
                self.toast(ToastKind::Info, format!("The next session starts on {name}"));
                Vec::new()
            }
        }
    }

    /// Opens the picker for `provider` and asks the server for its models.
    pub fn open_picker(&mut self, provider: &str) -> Vec<Action> {
        self.picker = None;
        self.dialog = Some(Dialog::ModelPicker { provider: provider.to_string(), query: String::new(), selected: 0, rename: None });
        vec![Action::Call { method: "provider.models", params: json!({ "cwd": self.cwd, "provider": provider }), then: Then::ProviderModels(provider.to_string()) }]
    }

    /// The picker's models for a query, in the provider's order; a search ranks them by name, then id.
    pub fn picker_rows(&self, provider: &str, query: &str) -> Vec<ProviderModel> {
        let Some(Ok(all)) = &self.picker else { return Vec::new() };
        if query.is_empty() {
            return all.clone();
        }
        let name = |m: &ProviderModel| self.prefs.model(&format!("{provider}/{}", m.id)).map_or(m.name.clone(), |p| if p.rename.is_empty() { m.name.clone() } else { p.rename.clone() });
        let mut scored: Vec<(u32, ProviderModel)> = all
            .iter()
            .filter_map(|m| {
                let s = [menu::score(query, &name(m)).map(|s| s * 2), menu::score(query, &m.id)];
                s.iter().any(Option::is_some).then(|| (s.iter().flatten().sum(), m.clone()))
            })
            .collect();
        scored.sort_by_key(|(s, _)| std::cmp::Reverse(*s));
        scored.into_iter().map(|(_, m)| m).collect()
    }

    /// A key in the picker. While a name is typed, the keys edit it: Enter keeps it, Esc drops it.
    #[allow(clippy::too_many_arguments)]
    pub fn picker_key(&mut self, key: &KeyEvent, ids: &[&str], provider: String, mut query: String, mut selected: usize, rename: Option<String>, page: usize) -> Vec<Action> {
        let has = |id: &str| ids.contains(&id);
        let rows = self.picker_rows(&provider, &query);
        let chosen = rows.get(selected).cloned();
        if let Some(mut text) = rename {
            let mut rename = Some(String::new());
            match key.code {
                KeyCode::Esc => rename = None,
                KeyCode::Enter => {
                    if let Some(m) = &chosen {
                        let e = self.prefs.model_entry(&format!("{provider}/{}", m.id), &m.name, m.context_window, m.reasoning);
                        let typed = text.trim();
                        e.rename = if typed == m.name { String::new() } else { typed.to_string() };
                        self.prefs.save();
                    }
                    rename = None;
                }
                KeyCode::Backspace => {
                    text.pop();
                }
                KeyCode::Char(c) if !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) => text.push(c),
                _ => {}
            }
            if rename.is_some() {
                rename = Some(text);
            }
            self.dialog = Some(Dialog::ModelPicker { provider, query, selected, rename });
            return Vec::new();
        }
        if has("dialog.close") {
            // Back to the model list, on this provider's "Select models…".
            let value = format!("{MORE}{provider}");
            let at = self.model_rows("").iter().position(|r| r.value == value).unwrap_or(0);
            self.dialog = Some(Dialog::List { list: List::Models, query: String::new(), selected: at });
            return Vec::new();
        }
        let mut out = Vec::new();
        let mut rename = None;
        let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
        if has("dialog.select.submit") {
            match (&self.picker, &chosen) {
                (Some(Err(_)), _) if self.no_endpoint() => {
                    // Known only by a stored key: its endpoint is asked for, with its name filled in.
                    self.ask_custom_named(&provider);
                    return Vec::new();
                }
                (_, Some(m)) => out = self.toggle_shown(&provider, m),
                _ => {}
            }
        } else if matches!(key.code, KeyCode::Left | KeyCode::Right) {
            if let Some(m) = &chosen {
                let choices = effort_choices(m);
                if !choices.is_empty() {
                    let key_ = format!("{provider}/{}", m.id);
                    let now = self.prefs.model(&key_).and_then(|p| p.effort.clone());
                    let i = choices.iter().position(|c| *c == now).unwrap_or(0);
                    let n = choices.len();
                    let next = if key.code == KeyCode::Left { (i + n - 1) % n } else { (i + 1) % n };
                    self.prefs.model_entry(&key_, &m.name, m.context_window, m.reasoning).effort = choices[next].clone();
                    self.prefs.save();
                }
            }
        } else if (ctrl && key.code == KeyCode::Char('r')) || key.code == KeyCode::F(2) {
            if let Some(m) = &chosen {
                let p = self.prefs.model(&format!("{provider}/{}", m.id));
                rename = Some(p.map_or(m.name.clone(), |p| if p.rename.is_empty() { m.name.clone() } else { p.rename.clone() }));
            }
        } else {
            select(key, ids, Some(&mut query), &mut selected, rows.len(), page);
        }
        self.dialog = Some(Dialog::ModelPicker { provider, query, selected, rename });
        out
    }

    /// Shows or hides a model. One the endpoint lists that the provider's declaration lacks is added to it when shown,
    /// so a new session can switch to it.
    fn toggle_shown(&mut self, provider: &str, m: &ProviderModel) -> Vec<Action> {
        let e = self.prefs.model_entry(&format!("{provider}/{}", m.id), &m.name, m.context_window, m.reasoning);
        e.shown = !e.shown;
        let shown = e.shown;
        self.prefs.save();
        if shown && !m.listed {
            let params = json!({ "cwd": self.cwd, "provider": provider, "model": m.id });
            return vec![Action::Call { method: "provider.model.add", params, then: Then::ModelAdded(provider.to_string(), m.id.clone()) }];
        }
        Vec::new()
    }

    /// `provider.model.add` answered: the model is in the declaration, and the picker says so.
    pub fn on_model_added(&mut self, provider: &str, id: &str, path: &str) {
        if let Some(Ok(models)) = &mut self.picker {
            if let Some(m) = models.iter_mut().find(|m| m.id == id) {
                m.listed = true;
            }
        }
        self.toast(ToastKind::Success, format!("{provider}/{id} added to {path}; a new session can switch to it"));
    }

    /// The picker's provider has a stored key and no endpoint: no declaration names its base URL.
    pub fn no_endpoint(&self) -> bool {
        matches!(&self.picker, Some(Err(e)) if e.contains("has no endpoint"))
    }

    /// The effort a picker row shows: the one set, else the session's own; none for a model that does not reason.
    pub fn picker_effort(&self, provider: &str, m: &ProviderModel) -> Option<String> {
        if effort_choices(m).is_empty() {
            return None;
        }
        Some(self.prefs.model(&format!("{provider}/{}", m.id)).and_then(|p| p.effort.clone()).unwrap_or_else(|| "auto".into()))
    }
}
