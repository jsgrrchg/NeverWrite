//! JsonRpcMessage and JsonRpcNotification/JsonRpcRequest implementations for
//! the ACP enum types from agent-client-protocol-schema.

use crate::schema::{AgentNotification, AgentRequest, ClientNotification, ClientRequest};

// ============================================================================
// Agent side (messages that agents receive)
// ============================================================================

impl_jsonrpc_request_enum!(ClientRequest {
    InitializeRequest => "initialize",
    AuthenticateRequest => "authenticate",
    #[cfg(feature = "unstable_logout")]
    LogoutRequest => "logout",
    NewSessionRequest => "session/new",
    LoadSessionRequest => "session/load",
    ListSessionsRequest => "session/list",
    #[cfg(feature = "unstable_session_delete")]
    DeleteSessionRequest => "session/delete",
    #[cfg(feature = "unstable_session_fork")]
    ForkSessionRequest => "session/fork",
    ResumeSessionRequest => "session/resume",
    CloseSessionRequest => "session/close",
    SetSessionModeRequest => "session/set_mode",
    SetSessionConfigOptionRequest => "session/set_config_option",
    PromptRequest => "session/prompt",
    #[cfg(feature = "unstable_session_model")]
    SetSessionModelRequest => "session/set_model",
    [ext] ExtMethodRequest,
});

impl_jsonrpc_notification_enum!(ClientNotification {
    CancelNotification => "session/cancel",
    [ext] ExtNotification,
});

// ============================================================================
// Client side (messages that clients/editors receive)
// ============================================================================

impl_jsonrpc_request_enum!(AgentRequest {
    WriteTextFileRequest => "fs/write_text_file",
    ReadTextFileRequest => "fs/read_text_file",
    RequestPermissionRequest => "session/request_permission",
    CreateTerminalRequest => "terminal/create",
    TerminalOutputRequest => "terminal/output",
    ReleaseTerminalRequest => "terminal/release",
    WaitForTerminalExitRequest => "terminal/wait_for_exit",
    KillTerminalRequest => "terminal/kill",
    [ext] ExtMethodRequest,
});

impl_jsonrpc_notification_enum!(AgentNotification {
    SessionNotification => "session/update",
    [ext] ExtNotification,
});
