//! The provider popup `/connect` opens: a provider's API key, or a custom provider and its key, every field in one
//! dialog. It needs no session: the answers go to the engine server (`provider.add`, `credential.add`), so `/connect`
//! works on the home screen too.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;

use crate::app::{Action, App, Dialog, Then, ToastKind};

/// The API kinds offered for a custom provider, as `config/provider-add.ts` lists them.
pub const APIS: [(&str, &str); 4] = [
    ("openai-completions", "OpenAI Chat Completions"),
    ("openai-responses", "OpenAI Responses"),
    ("anthropic-messages", "Anthropic Messages"),
    ("google-generative-ai", "Google Generative AI"),
];

/// Where a custom provider's declaration is written.
pub const SCOPES: [(&str, &str); 2] = [("global", "Global (~/.lykos/config.yaml)"), ("project", "This project (.lykos/config.yaml)")];

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Field {
    Name,
    Api,
    BaseUrl,
    Models,
    Key,
    Scope,
}

const CUSTOM: [Field; 6] = [Field::Name, Field::Api, Field::BaseUrl, Field::Models, Field::Key, Field::Scope];
const KEY_ONLY: [Field; 1] = [Field::Key];

impl Field {
    pub fn label(self) -> &'static str {
        match self {
            Field::Name => "Name",
            Field::Api => "API",
            Field::BaseUrl => "Base URL",
            Field::Models => "Models",
            Field::Key => "API key",
            Field::Scope => "Save to",
        }
    }

    /// What an empty text field shows, dimmed.
    pub fn placeholder(self, key_only: bool) -> &'static str {
        match self {
            Field::Name => "local",
            Field::BaseUrl => "http://localhost:11434/v1",
            Field::Models => "llama3.1, qwen2.5-coder",
            Field::Key if key_only => "the key, $VAR or !command",
            Field::Key => "optional: the key, $VAR or !command",
            Field::Api | Field::Scope => "",
        }
    }

    /// Changed with the arrows, not typed.
    pub fn choice(self) -> bool {
        matches!(self, Field::Api | Field::Scope)
    }
}

/// The popup's state: what is typed so far and which field has the cursor.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ProviderForm {
    /// `Some`: only this provider's key is asked. `None`: a custom provider.
    pub provider: Option<String>,
    pub name: String,
    pub api: usize,
    pub base_url: String,
    pub models: String,
    pub key: String,
    pub scope: usize,
    pub focus: usize,
    /// What the server or a check said was wrong, shown under the fields.
    pub error: Option<String>,
    /// A call is out: keys other than Esc wait for it.
    pub busy: bool,
}

impl ProviderForm {
    pub fn key_only(provider: &str) -> Self {
        Self { provider: Some(provider.into()), ..Self::default() }
    }

    pub fn fields(&self) -> &'static [Field] {
        if self.provider.is_some() { &KEY_ONLY } else { &CUSTOM }
    }

    pub fn field(&self) -> Field {
        let f = self.fields();
        f[self.focus.min(f.len() - 1)]
    }

    pub fn title(&self) -> String {
        match &self.provider {
            Some(p) => format!("{p} API key"),
            None => "Add a custom provider".into(),
        }
    }

    /// The provider the key goes to.
    pub fn id(&self) -> String {
        self.provider.clone().unwrap_or_else(|| self.name.trim().to_string())
    }

    fn text_mut(&mut self, f: Field) -> Option<&mut String> {
        match f {
            Field::Name => Some(&mut self.name),
            Field::BaseUrl => Some(&mut self.base_url),
            Field::Models => Some(&mut self.models),
            Field::Key => Some(&mut self.key),
            Field::Api | Field::Scope => None,
        }
    }

    /// A field's value as drawn: the key masked, a choice by its label. Empty when nothing is typed.
    pub fn shown(&self, f: Field) -> String {
        match f {
            Field::Name => self.name.clone(),
            Field::BaseUrl => self.base_url.clone(),
            Field::Models => self.models.clone(),
            Field::Key => "•".repeat(self.key.chars().count()),
            Field::Api => APIS[self.api].1.into(),
            Field::Scope => SCOPES[self.scope].1.into(),
        }
    }

    /// Types `text` into the field with the cursor, if it takes text.
    pub fn paste(&mut self, text: &str) {
        if let Some(t) = self.text_mut(self.field()) {
            t.push_str(text);
        }
    }

    /// The first field a save needs and lacks.
    fn missing(&self) -> Option<usize> {
        let empty = |f: Field| match f {
            Field::Name => self.name.trim().is_empty(),
            Field::BaseUrl => self.base_url.trim().is_empty(),
            Field::Models => self.models.trim().is_empty(),
            Field::Key => self.provider.is_some() && self.key.trim().is_empty(),
            Field::Api | Field::Scope => false,
        };
        self.fields().iter().position(|f| empty(*f))
    }
}

impl App {
    /// Opens the popup for `provider`'s API key.
    pub fn ask_key(&mut self, provider: &str) {
        self.dialog = Some(Dialog::Provider(ProviderForm::key_only(provider)));
    }

    /// Opens the custom provider popup.
    pub fn ask_custom(&mut self) {
        self.dialog = Some(Dialog::Provider(ProviderForm::default()));
    }

    /// A key in the popup: up and down (or tab) move between fields, left and right change a choice, Enter goes to
    /// the next field and on the last one saves.
    pub fn provider_form_key(&mut self, key: &KeyEvent, ids: &[&str], mut f: ProviderForm) -> Vec<Action> {
        if ids.contains(&"dialog.close") {
            self.dialog = None;
            return Vec::new();
        }
        if f.busy {
            return Vec::new();
        }
        let n = f.fields().len();
        let field = f.field();
        match key.code {
            KeyCode::Up | KeyCode::BackTab => f.focus = (f.focus + n - 1) % n,
            KeyCode::Down | KeyCode::Tab => f.focus = (f.focus + 1) % n,
            KeyCode::Left | KeyCode::Right if field.choice() => {
                let len = if field == Field::Api { APIS.len() } else { SCOPES.len() };
                let v = if field == Field::Api { &mut f.api } else { &mut f.scope };
                *v = if key.code == KeyCode::Left { (*v + len - 1) % len } else { (*v + 1) % len };
            }
            KeyCode::Enter if f.focus + 1 < n => f.focus += 1,
            KeyCode::Enter => return self.save_provider(f),
            KeyCode::Backspace => {
                if let Some(t) = f.text_mut(field) {
                    t.pop();
                }
            }
            KeyCode::Char(c) if !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) => {
                if let Some(t) = f.text_mut(field) {
                    t.push(c);
                }
            }
            _ => {}
        }
        self.dialog = Some(Dialog::Provider(f));
        Vec::new()
    }

    fn save_provider(&mut self, mut f: ProviderForm) -> Vec<Action> {
        if let Some(i) = f.missing() {
            f.error = Some(format!("{} is empty", f.fields()[i].label()));
            f.focus = i;
            self.dialog = Some(Dialog::Provider(f));
            return Vec::new();
        }
        f.error = None;
        f.busy = true;
        let call = if f.provider.is_some() {
            key_call(&f)
        } else {
            let params = json!({
                "cwd": self.cwd, "scope": SCOPES[f.scope].0, "id": f.name.trim(), "api": APIS[f.api].0,
                "baseUrl": f.base_url.trim(), "models": f.models.trim(),
            });
            Action::Call { method: "provider.add", params, then: Then::ProviderAdded(f.id()) }
        };
        self.dialog = Some(Dialog::Provider(f));
        vec![call]
    }

    /// `provider.add` answered: the declaration is written; its key is stored next when one was typed.
    pub fn on_provider_added(&mut self, id: &str, path: &str) -> Vec<Action> {
        self.toast(ToastKind::Success, format!("{id} saved to {path}; a new session can use it"));
        match &self.dialog {
            Some(Dialog::Provider(f)) if !f.key.trim().is_empty() => vec![key_call(f)],
            _ => {
                self.dialog = None;
                vec![self.providers_call()]
            }
        }
    }

    /// `credential.add` answered: what the pool says now, and the lists again.
    pub fn on_key_stored(&mut self, message: &str) -> Vec<Action> {
        if matches!(self.dialog, Some(Dialog::Provider(_))) {
            self.dialog = None;
        }
        self.toast(ToastKind::Success, message.to_string());
        let mut out = vec![self.providers_call()];
        if let Some(session) = self.live() {
            out.push(Action::Options { session });
        }
        out
    }

    /// A save the server refused: the popup stays open with the reason.
    pub fn on_provider_error(&mut self, error: String) {
        match &mut self.dialog {
            Some(Dialog::Provider(f)) => {
                f.busy = false;
                f.error = Some(error);
            }
            _ => self.toast(ToastKind::Error, error),
        }
    }

    /// Asks the server for every provider `/connect` offers.
    pub fn providers_call(&self) -> Action {
        Action::Call { method: "providers.list", params: json!({ "cwd": self.cwd }), then: Then::Providers }
    }
}

fn key_call(f: &ProviderForm) -> Action {
    Action::Call { method: "credential.add", params: json!({ "provider": f.id(), "key": f.key.trim() }), then: Then::KeyStored }
}
