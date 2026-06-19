use std::collections::HashMap;

use serde::{Deserialize, Serialize};

pub const CODEX_RUNTIME_ID: &str = "codex-acp";
pub const CLAUDE_RUNTIME_ID: &str = "claude-acp";
pub const GROK_RUNTIME_ID: &str = "grok-acp";
pub const KILO_RUNTIME_ID: &str = "kilo-acp";
pub const OPENCODE_RUNTIME_ID: &str = "opencode-acp";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiSessionStatus {
    Idle,
    Streaming,
    WaitingPermission,
    WaitingUserInput,
    ReviewRequired,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiConfigOptionCategory {
    Mode,
    Model,
    Reasoning,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiRuntimeOption {
    pub id: String,
    pub name: String,
    pub description: String,
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiModelOption {
    pub id: String,
    pub runtime_id: String,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiModeOption {
    pub id: String,
    pub runtime_id: String,
    pub name: String,
    pub description: String,
    pub disabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiConfigSelectOption {
    pub value: String,
    pub label: String,
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiConfigOption {
    pub id: String,
    pub runtime_id: String,
    pub category: AiConfigOptionCategory,
    pub label: String,
    pub description: Option<String>,
    #[serde(rename = "type")]
    pub kind: String,
    pub value: String,
    pub options: Vec<AiConfigSelectOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiRuntimeDescriptor {
    pub runtime: AiRuntimeOption,
    pub models: Vec<AiModelOption>,
    pub modes: Vec<AiModeOption>,
    pub config_options: Vec<AiConfigOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiAuthMethod {
    pub id: String,
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiSession {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    pub runtime_id: String,
    pub model_id: String,
    pub mode_id: String,
    pub status: AiSessionStatus,
    pub efforts_by_model: HashMap<String, Vec<String>>,
    pub models: Vec<AiModelOption>,
    pub modes: Vec<AiModeOption>,
    pub config_options: Vec<AiConfigOption>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub additional_roots: Vec<String>,
    // Roots the user previously approved that could not be re-resolved on disk
    // when the session was (re)opened. Not persisted — recomputed each load.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub discarded_additional_roots: Vec<DiscardedAdditionalRoot>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DiscardedAdditionalRoot {
    pub raw: String,
    pub reason: DiscardedAdditionalRootReason,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DiscardedAdditionalRootReason {
    NotFound,
    NotADirectory,
    PermissionDenied,
    Other { message: String },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiRuntimeSessionSummary {
    pub session_id: String,
    pub runtime_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AiRuntimeBinarySource {
    Bundled,
    Custom,
    Env,
    Vendor,
    Missing,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiRuntimeSetupStatus {
    pub runtime_id: String,
    pub binary_ready: bool,
    pub binary_path: Option<String>,
    pub binary_source: AiRuntimeBinarySource,
    pub has_custom_binary_path: bool,
    pub auth_ready: bool,
    pub auth_method: Option<String>,
    pub auth_methods: Vec<AiAuthMethod>,
    pub has_gateway_config: bool,
    pub has_gateway_url: bool,
    pub onboarding_required: bool,
    pub message: Option<String>,
}
