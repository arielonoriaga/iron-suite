use serde::{Deserialize, Serialize};

use crate::types::{
    AgentState, GridSnapshot, HostMode, HostStatus, JournalEntry, OverheadStats, SessionInspection,
    SessionSummary, StructuredPrompt, TodoItem,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub id: u64,
    pub msg: ClientMsg,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ClientMsg {
    Ping,
    ListFleet,
    SpawnSession {
        title: String,
        host_id: Option<String>,
        project: String,
        worktree_path: String,
        cli: String,
        command: Vec<String>,
        pinned_host: Option<String>,
        pin_reason: Option<String>,
        resume_cmd: Option<String>,
    },
    AttachPty {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    DetachPty {
        session_id: String,
    },
    PtyInput {
        session_id: String,
        bytes: Vec<u8>,
    },
    PtyResize {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    ResolvePrompt {
        session_id: String,
        action_id: String,
        custom_reply: Option<String>,
    },
    HibernateSession {
        session_id: String,
        checkpoint: Option<String>,
    },
    WakeSession {
        session_id: String,
        rebase_onto_main: bool,
    },
    MoveSessionHost {
        session_id: String,
        target_host_id: String,
    },
    SetHostMode {
        host_id: String,
        mode: HostMode,
    },
    InspectSession {
        session_id: String,
    },
    UpdateSessionState {
        session_id: String,
        state: AgentState,
        checkpoint: Option<String>,
        prompt: Option<StructuredPrompt>,
    },
    UpdateTodos {
        session_id: String,
        todos: Vec<TodoItem>,
    },
    UpdateFlow {
        session_id: String,
        phase: String,
        phases: Option<Vec<String>>,
    },
    UpdateCheckpoint {
        session_id: String,
        checkpoint: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RpcResponse {
    Pong {
        version: String,
    },
    Fleet {
        hosts: Vec<HostStatus>,
        sessions: Vec<SessionSummary>,
        overhead: OverheadStats,
    },
    Session {
        session: SessionSummary,
    },
    Attached {
        snapshot: GridSnapshot,
    },
    Inspection {
        inspection: SessionInspection,
    },
    Host {
        host: HostStatus,
    },
    Ok,
    MoveBlocked {
        reason: String,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum DaemonEvent {
    FleetDelta {
        sessions: Vec<SessionSummary>,
        hosts: Vec<HostStatus>,
        overhead: OverheadStats,
    },
    GridDelta {
        snapshot: GridSnapshot,
    },
    PromptRaised {
        session_id: String,
        prompt: StructuredPrompt,
    },
    JournalAppended {
        entry: JournalEntry,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ServerFrame {
    Response {
        id: u64,
        response: Box<RpcResponse>,
    },
    Event {
        event: DaemonEvent,
    },
}
