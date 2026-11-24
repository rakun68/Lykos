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
    /// The system prompt and tool schemas, estimated: what the context holds before a message.
    #[serde(default)]
    pub head_tokens: Option<f64>,
    pub run_usd: Option<f64>,
    pub today_usd: Option<f64>,
    pub cache_hit_ratio: Option<f64>,
    pub calls: u64,
    /// P5 #53: the old footer's counters.
    #[serde(default)]
    pub tokens: TokenCounters,
    /// P5 #53: the cache reading of the model in use.
    #[serde(default)]
    pub cache: Option<CacheGauge>,
    #[serde(default)]
    pub alerts: Vec<Alert>,
    #[serde(default)]
    pub outcome: Option<Outcome>,
}

/// What fills the context window. `measured` is Pi's total; every part is an estimate.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextBreakdown {
    pub model: Option<String>,
    pub window: Option<f64>,
    pub measured: Option<f64>,
    pub parts: Vec<ContextPart>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextPart {
    pub name: String,
    pub tokens: f64,
    #[serde(default)]
    pub count: Option<u64>,
    #[serde(default)]
    pub items: Vec<ContextItem>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextItem {
    pub name: String,
    pub tokens: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenCounters {
    pub fresh: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub output: f64,
    pub reasoning: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheGauge {
    pub model: String,
    pub pct: Option<f64>,
    /// `fresh`, `stale` or `unknown`.
    pub status: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Alert {
    pub id: String,
    /// `info`, `warn` or `danger`.
    pub severity: String,
    pub message: String,
    pub remedy: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Outcome {
    pub value: String,
    pub source: Option<String>,
    /// Only from a verification command or a human.
    pub verified: bool,
}

/// What `session.options` answers: the lists a client's pickers show for one live session.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOptions {
    /// `provider/id`.
    pub model: String,
    pub models: Vec<ModelOption>,
    /// None: the model has no effort control.
    pub effort: Option<String>,
    pub efforts: Vec<String>,
    pub specialist: String,
    pub specialists: Vec<SpecialistOption>,
    pub providers: Vec<ProviderOption>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub provider: String,
    pub id: String,
    pub name: String,
    pub context_window: Option<f64>,
    pub reasoning: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpecialistOption {
    pub name: String,
    pub description: String,
}

/// `providers.list`'s rows: every provider `/connect` offers, with or without a session.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderEntry {
    pub name: String,
    /// "oauth" (a browser sign-in) or "api_key".
    pub login: String,
    /// It has a credential, its environment variable or a declared source already.
    pub configured: bool,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProvidersResult {
    pub providers: Vec<ProviderEntry>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ProviderOption {
    pub name: String,
    pub auth: String,
    /// "reachable", "unreachable" or "unknown".
    pub reach: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct CommandInfo {
    /// As typed, with its slash.
    pub name: String,
    pub description: String,
    /// "builtin", "skill", "extension" or "pi-extension".
    pub source: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RequestOption {
    pub value: String,
    pub label: String,
    /// What the decision keeps allowing, shown while it is picked.
    #[serde(default)]
    pub note: Option<String>,
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
    /// P5 #46: a write's or an edit's change as a unified diff.
    #[serde(default)]
    pub patch: Option<String>,
    pub options: Vec<RequestOption>,
    #[serde(default)]
    pub assumption: Option<String>,
    /// A typed answer that is a secret (an API key): shown masked.
    #[serde(default)]
    pub secret: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct DiffLine {
    /// "add", "del", "ctx" or "hunk".
    pub kind: String,
    pub text: String,
}

/// One background job (`lykos/server/protocol.ts` `JobInfo`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobInfo {
    pub id: String,
    pub command: String,
    /// "running", "exited", "stopped", "capped" or "failed".
    pub status: String,
    pub started_at: String,
    #[serde(default)]
    pub exit_code: Option<i64>,
}

/// A shell call holding the turn, which `session.background` would move.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ForegroundInfo {
    pub id: String,
    pub command: String,
}

/// What `session.job.logs` answers.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLog {
    pub text: String,
    pub next_offset: u64,
    pub size: u64,
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
    /// A slash command's answer, shown out of the conversation (#58 follow-up).
    #[serde(rename = "report")]
    Report {
        command: String,
        text: String,
        /// `/context`'s parts, for its window.
        #[serde(default)]
        context: Option<ContextBreakdown>,
    },
    #[serde(rename = "usage")]
    Usage { usage: UsageData },
    #[serde(rename = "request")]
    Request { request: RequestData },
    #[serde(rename = "request.resolved", rename_all = "camelCase")]
    RequestResolved { request_id: String, answer: String },
    /// The slash commands the session runs, sent once it has booted.
    #[serde(rename = "commands")]
    Commands { commands: Vec<CommandInfo> },
    /// The session put text back in the prompt: an undone prompt (P5 #42).
    #[serde(rename = "prompt.set")]
    PromptSet { text: String },
    /// The session's background jobs and running shell calls, whole, on every change (P5 #48).
    #[serde(rename = "jobs")]
    Jobs { jobs: Vec<JobInfo>, #[serde(default)] foreground: Vec<ForegroundInfo> },
    /// An event a newer server sends that this client does not know: kept in order, shown as nothing.
    #[serde(other)]
    Unknown,
}

/// One row of `sessions.history` (`lykos/server/history.ts`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub id: String,
    pub title: Option<String>,
    pub started_utc: String,
    pub ended_utc: Option<String>,
    pub model: Option<String>,
    pub parent_session_id: Option<String>,
    pub archived: bool,
    pub resumable: bool,
    pub project_path: Option<String>,
    pub project_name: Option<String>,
}

/// An MCP or `lykos run` session that runs now (P5 #51): its owner keeps it, `session.watch` shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegatedInfo {
    /// `mcp` or `run`.
    pub owner: String,
    /// `running` or `waiting`.
    pub state: String,
    pub started_at: String,
    pub specialist: Option<String>,
}

/// `sessions.history`' answer: the rows, the live sessions by ledger id, and the delegated ones that run now.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct History {
    pub rows: Vec<HistoryRow>,
    pub live: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub delegated: std::collections::BTreeMap<String, DelegatedInfo>,
}

/// One row of `worktree.list`: a worktree of the project, the main checkout first.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub main: bool,
    /// A session runs there.
    #[serde(default)]
    pub sessions: bool,
}

/// One file of `vcs.diff` (P5 #46).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FileDiff {
    pub file: String,
    pub status: String,
    pub additions: usize,
    pub deletions: usize,
    #[serde(default)]
    pub patch: String,
}

/// `vcs.diff`: the workspace's changes against `base`, the merge base with `branch` or `HEAD`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceDiff {
    #[serde(default)]
    pub base: Option<String>,
    #[serde(default)]
    pub branch: Option<String>,
    pub files: Vec<FileDiff>,
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
    /// The server's code changed on disk since it started: it still runs the older build.
    #[serde(default)]
    pub stale: bool,
}
