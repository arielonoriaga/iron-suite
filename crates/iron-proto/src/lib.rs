pub mod frame;
pub mod osc;
pub mod rpc;
pub mod types;

pub use frame::{MAX_FRAME_BYTES, decode_frame, encode_frame, read_frame_sync, write_frame_sync};
pub use osc::{OscEvent, OscScanner};
pub use rpc::{ClientMsg, DaemonEvent, RpcRequest, RpcResponse, ServerFrame};
pub use types::{
    AgentState, GridCell, GridRow, GridSnapshot, HostMode, HostStatus, JournalEntry, OverheadStats,
    PromptAction, PromptKind, RunqJobRef, SessionInspection, SessionSummary, StructuredPrompt,
    TodoItem, TodoStatus,
};
