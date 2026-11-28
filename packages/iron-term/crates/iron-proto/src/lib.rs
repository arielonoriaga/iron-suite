pub mod frame;
pub mod osc;
pub mod paths;
pub mod rpc;
pub mod types;

pub use frame::{MAX_FRAME_BYTES, decode_frame, encode_frame, read_frame_sync, write_frame_sync};
pub use osc::{OscEvent, OscScanner};
pub use paths::{
    effective_uid, resolve_config_dir, resolve_config_dir_from, resolve_data_dir,
    resolve_data_dir_from, resolve_local_hostname, resolve_local_hostname_from,
    resolve_socket_path, resolve_socket_path_from,
};
pub use rpc::{ClientMsg, DaemonEvent, RpcRequest, RpcResponse, ServerFrame};
pub use types::{
    AgentState, GridCell, GridRow, GridSnapshot, HostMode, HostStatus, JournalEntry, OverheadStats,
    PromptAction, PromptKind, RunqJobRef, SessionInspection, SessionSummary, StructuredPrompt,
    TodoItem, TodoStatus,
};
