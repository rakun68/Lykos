//! The engine server's protocol, mirrored from `lykos/server/protocol.ts` (its source of truth) and
//! `docs/reference/engine-server.md`.
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Bumped with the server's: a client of another version is refused.
pub const PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionStatus {
    Starting,
    Idle,
    Running,
    Waiting,
    Closed,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub cwd: String,
    pub status: SessionStatus,
    pub model: String,
    pub title: Option<String>,
    pub started_at: String,
    pub origin: String,
    pub ledger_session_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageData {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub context_tokens: Option<f64>,
    pub context_window: Option<f64>,
    pub context_percent: Option<f64>,
    pub run_usd: Option<f64>,
    pub today_usd: Option<f64>,
    pub cache_hit_ratio: Option<f64>,
    pub calls: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RequestOption {
    pub value: String,
    pub label: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestData {
    pub request_id: String,
    /// "approval" or "question".
    pub kind: String,
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub body: Option<String>,
    pub options: Vec<RequestOption>,
    #[serde(default)]
    pub assumption: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DiffLine {
    /// "add", "del", "ctx" or "hunk".
    pub kind: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DiffData {
    pub path: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum EventData {
    #[serde(rename = "session.status")]
    SessionStatus { session: SessionSummary },
    #[serde(rename = "message.user")]
    MessageUser { text: String },
    #[serde(rename = "message.followup")]
    MessageFollowup { text: String },
    #[serde(rename = "message.delta")]
    MessageDelta { text: String },
    #[serde(rename = "message.end")]
    MessageEnd,
    #[serde(rename = "thinking.delta")]
    ThinkingDelta { text: String },
    #[serde(rename = "tool.start", rename_all = "camelCase")]
    ToolStart { tool_id: String, name: String, summary: String, #[serde(default)] args: Value },
    #[serde(rename = "tool.end", rename_all = "camelCase")]
    ToolEnd {
        tool_id: String,
        name: String,
        ok: bool,
        #[serde(default)]
        preview: Option<String>,
        #[serde(default)]
        diff: Option<DiffData>,
    },
    #[serde(rename = "turn.end")]
    TurnEnd,
    #[serde(rename = "system")]
    System { text: String },
    #[serde(rename = "usage")]
    Usage { usage: UsageData },
    #[serde(rename = "request")]
    Request { request: RequestData },
    #[serde(rename = "request.resolved", rename_all = "camelCase")]
    RequestResolved { request_id: String, answer: String },
    /// An event a newer server sends that this client does not know: kept in order, shown as nothing.
    #[serde(other)]
    Unknown,
}

/// One event; `seq` counts from 1 per session.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Event {
    pub event: String,
    pub session: String,
    pub seq: u64,
    pub data: EventData,
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Welcome {
    pub protocol: u32,
    pub server: String,
    pub pid: u32,
}
