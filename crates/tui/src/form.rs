//! Questions the TUI asks for itself, in the request dialog a session's questions use: an API key for a provider, and
//! a custom provider, step by step. They need no session: the answers go to the engine server (`credential.add`,
//! `provider.add`), so `/connect` works on the home screen too.

use lykos_client::{RequestData, RequestOption};
use serde_json::json;

use crate::app::{Action, App, Then, ToastKind};

/// What the open question is for.
#[derive(Clone, Debug, PartialEq)]
pub enum Form {
    /// The API key for a provider.
    Key { provider: String },
    /// A custom provider: the answers so far, in the order of `CUSTOM_STEPS`.
    Custom { answers: Vec<String> },
}

#[derive(Clone, Debug, PartialEq)]
pub struct Asking {
    pub form: Form,
    pub request: RequestData,
}

/// The API kinds offered for a custom provider, as `config/provider-add.ts` lists them.
const APIS: [(&str, &str); 4] = [
    ("openai-completions", "OpenAI Chat Completions (OpenRouter, Ollama, vLLM, LM Studio…)"),
    ("openai-responses", "OpenAI Responses"),
    ("anthropic-messages", "Anthropic Messages"),
    ("google-generative-ai", "Google Generative AI"),
];

fn option(value: &str, label: &str) -> RequestOption {
    RequestOption { value: value.into(), label: label.into(), note: None }
}

fn question(id: u64, title: &str, detail: String, options: Vec<RequestOption>, secret: bool) -> RequestData {
    RequestData {
        request_id: format!("local-{id}"),
        kind: "question".into(),
        title: title.into(),
        detail,
        body: None,
        patch: None,
        options,
        assumption: None,
        secret,
    }
}

impl App {
    fn ask(&mut self, form: Form, title: &str, detail: String, options: Vec<RequestOption>, secret: bool) {
        self.asked += 1;
        self.dialog = None;
        self.asking = Some(Asking { form, request: question(self.asked, title, detail, options, secret) });
    }

    /// Asks for `provider`'s API key, masked; the answer goes into its credential pool.
    pub fn ask_key(&mut self, provider: &str) {
        let detail = "The key itself, $VAR to read an environment variable, or !command to run one. Empty skips.".to_string();
        self.ask(Form::Key { provider: provider.into() }, &format!("{provider} API key"), detail, Vec::new(), true);
    }

    /// Starts the custom provider's questions.
    pub fn ask_custom(&mut self) {
        self.custom_step(Vec::new());
    }

    fn custom_step(&mut self, answers: Vec<String>) {
        let id = answers.first().cloned().unwrap_or_default();
        let (title, detail, options) = match answers.len() {
            0 => ("Provider name", "A short name for the endpoint, used as provider/model (for example local or openrouter-eu).".to_string(), Vec::new()),
            1 => ("API", format!("What {id}'s endpoint speaks."), APIS.iter().map(|(v, l)| option(v, l)).collect()),
            2 => ("Base URL", "The endpoint's base URL, for example http://localhost:11434/v1.".to_string(), Vec::new()),
            3 => ("Models", "The model ids it serves, separated by commas or spaces.".to_string(), Vec::new()),
            _ => (
                "Save to",
                "Where the declaration is written.".to_string(),
                vec![option("global", "Global: ~/.lykos/config.yaml"), option("project", "This project: .lykos/config.yaml")],
            ),
        };
        self.ask(Form::Custom { answers }, title, detail, options, false);
    }

    /// The answer to the question the TUI asked: the next question, or the call it was for. An empty answer gives up.
    pub fn form_answer(&mut self, answer: String) -> Vec<Action> {
        let Some(asking) = self.asking.take() else { return Vec::new() };
        let answer = answer.trim().to_string();
        if answer.is_empty() {
            return Vec::new();
        }
        match asking.form {
            Form::Key { provider } => {
                vec![Action::Call { method: "credential.add", params: json!({ "provider": provider, "key": answer }), then: Then::KeyStored }]
            }
            Form::Custom { mut answers } => {
                answers.push(answer);
                if answers.len() < 5 {
                    self.custom_step(answers);
                    return Vec::new();
                }
                let params = json!({ "cwd": self.cwd, "scope": answers[4], "id": answers[0], "api": answers[1], "baseUrl": answers[2], "models": answers[3] });
                vec![Action::Call { method: "provider.add", params, then: Then::ProviderAdded(answers[0].clone()) }]
            }
        }
    }

    /// `provider.add` answered: the declaration is written, so its key is next.
    pub fn on_provider_added(&mut self, id: &str, path: &str) {
        self.toast(ToastKind::Success, format!("{id} saved to {path}; a new session can use it"));
        self.ask_key(id);
    }

    /// `credential.add` answered: what the pool says now, and the lists again.
    pub fn on_key_stored(&mut self, message: &str) -> Vec<Action> {
        self.toast(ToastKind::Success, message.to_string());
        let mut out = vec![self.providers_call()];
        if let Some(session) = self.live() {
            out.push(Action::Options { session });
        }
        out
    }

    /// Asks the server for every provider `/connect` offers.
    pub fn providers_call(&self) -> Action {
        Action::Call { method: "providers.list", params: json!({ "cwd": self.cwd }), then: Then::Providers }
    }
}
