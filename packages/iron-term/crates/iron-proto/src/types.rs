use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentState {
    NeedsApproval,
    ReviewReady,
    Failed,
    Queued,
    Running,
    Hibernated,
}

impl AgentState {
    pub fn is_urgent(self) -> bool {
        matches!(self, Self::NeedsApproval | Self::ReviewReady | Self::Failed)
    }

    pub fn is_live(self) -> bool {
        self != Self::Hibernated
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "needs_approval" | "approval" => Some(Self::NeedsApproval),
            "review_ready" | "review" => Some(Self::ReviewReady),
            "failed" | "error" => Some(Self::Failed),
            "queued" => Some(Self::Queued),
            "running" => Some(Self::Running),
            "hibernated" | "dormant" => Some(Self::Hibernated),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptKind {
    Guardrail,
    Permission,
    Review,
    Exit75,
}

impl PromptKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "guardrail" => Some(Self::Guardrail),
            "permission" => Some(Self::Permission),
            "review" => Some(Self::Review),
            "exit75" | "exit_75" => Some(Self::Exit75),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptAction {
    pub id: String,
    pub label: String,
    pub command_to_send: Option<String>,
    pub is_primary: bool,
    pub is_destructive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StructuredPrompt {
    pub kind: PromptKind,
    pub title: String,
    pub description: String,
    pub command: String,
    pub actions: Vec<PromptAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunqJobRef {
    pub kind: String,
    pub command: String,
    pub cpus: u8,
    pub mem_gb: u8,
    pub position: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostMode {
    Free,
    Shared,
    Off,
}

impl HostMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "free" => Some(Self::Free),
            "shared" => Some(Self::Shared),
            "off" => Some(Self::Off),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostStatus {
    pub id: String,
    pub hostname: String,
    pub mode: HostMode,
    pub cpu_pct: u8,
    pub cap_pct: u8,
    pub ram_used_gb: f32,
    pub ram_total_gb: f32,
    pub active_slots: u8,
    pub max_slots: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OverheadStats {
    pub rendered_ptys: usize,
    pub headless_live: usize,
    pub hibernated: usize,
    pub total_live_ram_mb: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    Active,
    Done,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TodoItem {
    pub text: String,
    pub status: TodoStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct JournalEntry {
    pub id: i64,
    pub ts_ms: i64,
    pub session_id: Option<String>,
    pub agent_label: String,
    pub kind: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub cli: String,
    pub host_id: String,
    pub project: String,
    pub worktree_path: String,
    pub git_branch: String,
    pub git_dirty: bool,
    pub git_behind_main: u32,
    pub state: AgentState,
    pub phase: String,
    pub phases: Vec<String>,
    pub ram_mb: u32,
    pub pinned_host: Option<String>,
    pub pin_reason: Option<String>,
    pub checkpoint: String,
    pub resume_cmd: Option<String>,
    #[serde(default)]
    pub resume_argv: Option<Vec<String>>,
    pub prompt: Option<StructuredPrompt>,
    pub queue_job: Option<RunqJobRef>,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionInspection {
    pub session: SessionSummary,
    pub todos: Vec<TodoItem>,
    pub recent_journal: Vec<JournalEntry>,
    pub scrollback_tail: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GridCell {
    pub ch: char,
    pub fg: u32,
    pub bg: u32,
    pub flags: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GridRow {
    pub row: u16,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GridSnapshot {
    pub session_id: String,
    pub seq: u64,
    pub cols: u16,
    pub rows: u16,
    pub cursor_col: u16,
    pub cursor_row: u16,
    pub lines: Vec<GridRow>,
}
