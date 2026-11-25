//! A browser sign-in in a popup of its own, with no session: the engine server runs it (`provider.login`) and opens
//! the browser, and the popup shows what it says and asks what it asks until it is done.

use std::time::Instant;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::{json, Value};

use crate::app::{Action, App, Dialog, Then, ToastKind};

/// How often an open sign-in is read, as the output view reads a job.
const POLL_MS: u128 = 300;

/// The sign-in popup's state.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Login {
    pub provider: String,
    /// The server's id for it, once it answered the start.
    pub id: Option<String>,
    pub lines: Vec<String>,
    /// The question it waits on, and whether its answer is masked.
    pub ask: Option<(String, bool)>,
    pub input: String,
    /// Set when it failed; a sign-in that worked closes the popup.
    pub failed: bool,
}

impl App {
    /// Opens the sign-in popup for `provider` and starts its browser sign-in on the server.
    pub fn open_login(&mut self, provider: &str) -> Vec<Action> {
        self.poll = None;
        self.dialog = Some(Dialog::Login(Login { provider: provider.to_string(), ..Login::default() }));
        vec![Action::Call { method: "provider.login", params: json!({ "provider": provider }), then: Then::LoginStarted(provider.to_string()) }]
    }

    /// Reads the open sign-in, no more often than `POLL_MS` and never while a read is out.
    pub fn poll_login(&mut self, now: Instant) -> Vec<Action> {
        let Some(Dialog::Login(Login { id: Some(id), failed: false, .. })) = &self.dialog else { return Vec::new() };
        if self.poll.is_some_and(|(at, waiting)| waiting || now.duration_since(at).as_millis() < POLL_MS) {
            return Vec::new();
        }
        self.poll = Some((now, true));
        vec![Action::Call { method: "provider.login.status", params: json!({ "login": id }), then: Then::LoginStatus(id.clone()) }]
    }

    /// `provider.login`'s answer: the id the popup reads from now on.
    pub fn on_login_started(&mut self, provider: &str, result: Result<Value, String>) {
        let Some(Dialog::Login(l)) = &mut self.dialog else { return };
        if l.provider != provider || l.id.is_some() {
            return;
        }
        match result {
            Ok(v) => l.id = v["login"].as_str().map(str::to_string),
            Err(e) => {
                l.lines.push(e);
                l.failed = true;
            }
        }
    }

    /// `provider.login.status`' answer: its lines and question; done, a toast and fresh lists, or the failure shown.
    pub fn on_login_status(&mut self, id: &str, result: Result<Value, String>) -> Vec<Action> {
        self.poll = self.poll.map(|(at, _)| (at, false));
        let Some(Dialog::Login(l)) = &mut self.dialog else { return Vec::new() };
        if l.id.as_deref() != Some(id) {
            return Vec::new();
        }
        let v = match result {
            Ok(v) => v,
            Err(e) => {
                l.lines.push(e);
                l.failed = true;
                return Vec::new();
            }
        };
        l.lines = v["lines"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
        let ask = v["ask"]["prompt"].as_str().map(|p| (p.to_string(), v["ask"]["secret"].as_bool().unwrap_or(false)));
        if ask.is_none() {
            l.input.clear();
        }
        l.ask = ask;
        match v["done"]["ok"].as_bool() {
            Some(true) => {
                let message = l.lines.iter().rev().find(|x| x.contains("logged in to") || x.contains("updated")).cloned().unwrap_or_else(|| format!("Signed in to {}", l.provider));
                self.dialog = None;
                self.on_key_stored(&message)
            }
            Some(false) => {
                l.failed = true;
                Vec::new()
            }
            None => Vec::new(),
        }
    }

    /// The popup's keys: typing answers its question, Enter sends it, Esc ends the sign-in and closes it.
    pub fn login_key(&mut self, key: &KeyEvent, ids: &[&str], mut l: Login) -> Vec<Action> {
        if ids.contains(&"dialog.close") {
            self.dialog = None;
            self.poll = None;
            return match l.id.filter(|_| !l.failed) {
                Some(id) => vec![Action::Call { method: "provider.login.cancel", params: json!({ "login": id }), then: Then::Quiet }],
                None => Vec::new(),
            };
        }
        let Some(id) = l.id.clone().filter(|_| l.ask.is_some()) else { return Vec::new() };
        match key.code {
            KeyCode::Enter => {
                let answer = std::mem::take(&mut l.input);
                l.ask = None;
                self.dialog = Some(Dialog::Login(l));
                return vec![Action::Call { method: "provider.login.answer", params: json!({ "login": id, "answer": answer }), then: Then::Quiet }];
            }
            KeyCode::Backspace => {
                l.input.pop();
            }
            KeyCode::Char(c) if !key.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER) => l.input.push(c),
            _ => return Vec::new(),
        }
        self.dialog = Some(Dialog::Login(l));
        Vec::new()
    }

    /// What `/login` typed does: a browser sign-in when the provider has one, else its API key popup.
    pub fn login_command(&mut self, provider: &str) -> Vec<Action> {
        let entry = self.providers.iter().flatten().find(|p| p.name == provider);
        if entry.is_some_and(|p| !p.signs_in_with_browser()) {
            self.ask_key(provider);
            return Vec::new();
        }
        self.toast(ToastKind::Info, format!("Signing in to {provider}"));
        self.open_login(provider)
    }
}
