//! The client's copy of the server's state, fed only by events. Applying the same events in the same order gives
//! the same store; an event already applied (a replay overlapping what was seen) is skipped by its `seq`.
use std::collections::BTreeMap;

use crate::protocol::{DiffData, Event, EventData, RequestData, SessionSummary, UsageData};

#[derive(Clone, Debug, PartialEq)]
pub enum ToolState {
    Running,
    Ok,
    Error,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Item {
    User(String),
    Followup(String),
    Assistant(String),
    Thinking(String),
    Tool { id: String, name: String, summary: String, state: ToolState, preview: Option<String>, diff: Option<DiffData> },
    System(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    pub summary: SessionSummary,
    pub items: Vec<Item>,
    pub usage: Option<UsageData>,
    /// Requests still waiting on an answer, oldest first.
    pub requests: Vec<RequestData>,
    pub last_seq: u64,
    /// True while an assistant message is streaming into the last item.
    open_assistant: bool,
    open_thinking: bool,
}

impl Session {
    fn new(summary: SessionSummary) -> Self {
        Session { summary, items: Vec::new(), usage: None, requests: Vec::new(), last_seq: 0, open_assistant: false, open_thinking: false }
    }

    fn close_stream(&mut self) {
        self.open_assistant = false;
        self.open_thinking = false;
    }

    fn apply(&mut self, data: &EventData) {
        match data {
            EventData::SessionStatus { session } => self.summary = session.clone(),
            EventData::MessageUser { text } => {
                self.close_stream();
                self.items.push(Item::User(text.clone()));
            }
            EventData::MessageFollowup { text } => self.items.push(Item::Followup(text.clone())),
            EventData::MessageDelta { text } => {
                self.open_thinking = false;
                match self.items.last_mut() {
                    Some(Item::Assistant(s)) if self.open_assistant => s.push_str(text),
                    _ => {
                        self.items.push(Item::Assistant(text.clone()));
                        self.open_assistant = true;
                    }
                }
            }
            EventData::ThinkingDelta { text } => {
                self.open_assistant = false;
                match self.items.last_mut() {
                    Some(Item::Thinking(s)) if self.open_thinking => s.push_str(text),
                    _ => {
                        self.items.push(Item::Thinking(text.clone()));
                        self.open_thinking = true;
                    }
                }
            }
            EventData::MessageEnd | EventData::TurnEnd => self.close_stream(),
            EventData::ToolStart { tool_id, name, summary, .. } => {
                self.close_stream();
                self.items.push(Item::Tool { id: tool_id.clone(), name: name.clone(), summary: summary.clone(), state: ToolState::Running, preview: None, diff: None });
            }
            EventData::ToolEnd { tool_id, ok, preview: p, diff: d, .. } => {
                let found = self.items.iter_mut().rev().find_map(|it| match it {
                    Item::Tool { id, state, preview, diff, .. } if id == tool_id => Some((state, preview, diff)),
                    _ => None,
                });
                if let Some((state, preview, diff)) = found {
                    *state = if *ok { ToolState::Ok } else { ToolState::Error };
                    *preview = p.clone();
                    if d.is_some() {
                        *diff = d.clone();
                    }
                }
            }
            EventData::System { text } => {
                self.close_stream();
                self.items.push(Item::System(text.clone()));
            }
            EventData::Usage { usage } => self.usage = Some(usage.clone()),
            EventData::Request { request } => self.requests.push(request.clone()),
            EventData::RequestResolved { request_id, .. } => self.requests.retain(|r| &r.request_id != request_id),
            EventData::Unknown => {}
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Store {
    pub sessions: BTreeMap<String, Session>,
}

impl Store {
    /// Applies one event. Returns false for one already applied, or one that arrived out of order.
    pub fn apply(&mut self, event: &Event) -> bool {
        let session = match self.sessions.get_mut(&event.session) {
            Some(s) => s,
            None => {
                // A session's first event is always its status; anything else for an unknown session is ignored.
                let EventData::SessionStatus { session } = &event.data else { return false };
                self.sessions.entry(event.session.clone()).or_insert_with(|| Session::new(session.clone()))
            }
        };
        if event.seq != session.last_seq + 1 {
            return false;
        }
        session.apply(&event.data);
        session.last_seq = event.seq;
        true
    }

    /// The last seq applied per session: what a resubscribe asks to continue after.
    pub fn after(&self) -> BTreeMap<String, u64> {
        self.sessions.iter().map(|(id, s)| (id.clone(), s.last_seq)).collect()
    }
}
