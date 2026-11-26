//! The store against a recorded event stream, with no server: a real session's events, recorded by
//! `lykos/server/session-child.test.ts` (`LYKOS_RECORD_EVENTS`).
use lykos_client::{Event, Item, SessionStatus, Store, ToolState};

fn recorded() -> Vec<Event> {
    include_str!("fixtures/session.ndjson")
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).expect("every recorded line parses"))
        .collect()
}

fn fed(events: &[Event]) -> Store {
    let mut store = Store::default();
    for e in events {
        store.apply(e);
    }
    store
}

#[test]
fn a_recorded_session_builds_its_conversation() {
    let events = recorded();
    let store = fed(&events);
    assert_eq!(store.sessions.len(), 1);
    let s = store.sessions.values().next().unwrap();
    assert_eq!(s.summary.status, SessionStatus::Closed);
    assert_eq!(s.summary.title.as_deref(), Some("Reply with the word pong."));
    assert!(s.summary.ledger_session_id.is_some());
    assert_eq!(s.last_seq, events.len() as u64);
    assert_eq!(s.items[0], Item::User("Reply with the word pong.".into()));
    assert_eq!(s.items[1], Item::Assistant("pong".into()));
    assert_eq!(s.items[2], Item::User("Write note.txt.".into()));
    match &s.items[3] {
        Item::Tool { name, summary, state, .. } => {
            assert_eq!(name, "write");
            assert_eq!(summary, "note.txt");
            assert_eq!(*state, ToolState::Ok);
        }
        other => panic!("expected the write, got {other:?}"),
    }
    assert!(s.requests.is_empty(), "the approval was answered");
    let usage = s.usage.as_ref().expect("usage arrived");
    assert_eq!(usage.model.as_deref(), Some("m1"));
}

#[test]
fn a_replay_after_any_point_gives_the_same_store() {
    let events = recorded();
    let whole = fed(&events);
    for cut in 1..events.len() {
        // A client that saw the first `cut` events, dropped, and resubscribed after its last seq: the server
        // replays from there. An overlapping replay (the server sending some it already had) changes nothing.
        let mut store = fed(&events[..cut]);
        let overlap = cut.saturating_sub(3);
        for e in &events[overlap..] {
            store.apply(e);
        }
        assert_eq!(store, whole, "after a drop at {cut}");
    }
}

#[test]
fn a_gap_is_not_applied() {
    let events = recorded();
    let mut store = Store::default();
    store.apply(&events[0]);
    assert!(!store.apply(&events[2]), "seq 3 after seq 1 waits for seq 2");
    assert!(store.apply(&events[1]));
    assert!(store.apply(&events[2]));
}
