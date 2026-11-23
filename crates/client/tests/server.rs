//! The client against the real TypeScript engine server, with a scripted session child
//! (`lykos/server/scripted-child.fixture.ts`). Runs when `LYKOS_SERVE_CMD` names the server, as
//! `scripts/tui/client-test.mjs` sets it; skipped otherwise, since a plain `cargo test` has no Node.
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::mpsc::RecvTimeoutError;
use std::time::{Duration, Instant};

use lykos_client::{Client, Error, Events, Item, Options, SessionStatus, Store, Update, PROTOCOL_VERSION};
use serde_json::json;

fn temp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("lykos-client-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Feeds the store until `done` holds, saying what arrived when it does not.
fn pump(events: &Events, store: &mut Store, mut seen: impl FnMut(&Update), done: impl Fn(&Store) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !done(store) {
        let left = deadline.saturating_duration_since(Instant::now());
        match events.rx.recv_timeout(left) {
            Ok(u) => {
                seen(&u);
                if let Update::Event(e) = &u {
                    store.apply(e);
                }
            }
            Err(RecvTimeoutError::Timeout) => panic!("timed out; store: {store:#?}"),
            Err(RecvTimeoutError::Disconnected) => panic!("the events thread ended"),
        }
    }
}

fn turns(store: &Store) -> usize {
    store.sessions.values().map(|s| s.items.iter().filter(|i| matches!(i, Item::User(_))).count()).sum()
}

fn idle_after(store: &Store, n: usize) -> bool {
    turns(store) >= n && store.sessions.values().all(|s| s.summary.status == SessionStatus::Idle)
}

#[test]
fn starts_reuses_resyncs_and_refuses_an_old_protocol() {
    let Ok(serve) = std::env::var("LYKOS_SERVE_CMD") else {
        eprintln!("skipped: LYKOS_SERVE_CMD is not set");
        return;
    };
    let root = temp("server");
    let home = root.join("home");
    let workspace = root.join("workspace");
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&workspace).unwrap();
    // The server inherits these: a throwaway home, so its trust store and project registry are not the user's.
    std::env::set_var("HOME", &home);
    std::env::set_var("USERPROFILE", &home);
    let mut opts = Options::from_env("client-test").unwrap();
    opts.dir = root.join("run");
    opts.serve = serde_json::from_str(&serve).unwrap();

    // Starts one when none runs; the next client reuses it.
    let mut a = Client::connect(opts.clone()).expect("connect, starting a server");
    assert!(a.started, "the first client started the server");
    let b = Client::connect(opts.clone()).expect("connect again");
    assert!(!b.started, "the second found it running");
    assert_eq!(a.welcome.pid, b.welcome.pid, "one server");

    let events = a.subscribe(BTreeMap::new());
    let mut store = Store::default();
    let started = a.request("session.start", json!({ "cwd": workspace, "trust": true })).expect("start a session");
    let id = started["id"].as_str().unwrap().to_string();
    pump(&events, &mut store, |_| {}, |s| s.sessions.get(&id).is_some_and(|s| s.summary.status == SessionStatus::Idle));
    a.request("session.prompt", json!({ "session": id, "text": "hello there" })).unwrap();
    pump(&events, &mut store, |_| {}, |s| idle_after(s, 1));

    // The server drops the events connection; what happens while it is down is replayed after it reconnects.
    let dropped = a.request("server.disconnect", json!({})).unwrap();
    assert!(dropped["closed"].as_u64().unwrap() >= 1);
    a.request("session.prompt", json!({ "session": id, "text": "while away" })).unwrap();
    let (mut down, mut up) = (false, false);
    pump(
        &events,
        &mut store,
        |u| match u {
            Update::Disconnected(_) => down = true,
            Update::Reconnected => up = true,
            Update::Event(_) => {}
        },
        |s| idle_after(s, 2),
    );
    assert!(down && up, "the drop was seen and recovered from");

    // The store matches the server: the same as a fresh client fed the whole stream, and the same summary.
    let fresh = a.subscribe(BTreeMap::new());
    let mut whole = Store::default();
    let last = store.sessions[&id].last_seq;
    pump(&fresh, &mut whole, |_| {}, |s| s.sessions.get(&id).is_some_and(|s| s.last_seq >= last));
    assert_eq!(store, whole);
    let list = a.request("sessions.list", json!({})).unwrap();
    let summary: lykos_client::SessionSummary = serde_json::from_value(list[0].clone()).unwrap();
    assert_eq!(store.sessions[&id].summary, summary);
    let text: String = store.sessions[&id].items.iter().filter_map(|i| if let Item::Assistant(t) = i { Some(t.as_str()) } else { None }).collect();
    assert_eq!(text, "hello therewhile away");
    events.stop();
    fresh.stop();

    // A client of an older protocol is refused, with both versions named.
    let mut old = opts.clone();
    old.protocol = 0;
    match Client::connect(old) {
        Err(Error::Protocol(m)) => assert!(m.contains(&format!("protocol {PROTOCOL_VERSION}")) && m.contains("speaks 0"), "{m}"),
        Err(e) => panic!("refused for the wrong reason: {e}"),
        Ok(_) => panic!("an old protocol was let in"),
    }

    a.request("server.shutdown", json!({})).unwrap();
}
