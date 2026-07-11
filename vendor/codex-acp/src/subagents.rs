use std::collections::HashMap;

use agent_client_protocol::schema::{
    Content, Meta, SessionId, SessionInfoUpdate, SessionNotification, SessionUpdate, ToolCall,
    ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
};
use codex_core::ThreadConfigSnapshot;
use codex_protocol::{
    ThreadId,
    protocol::{
        AgentStatus, CollabAgentRef, CollabAgentStatusEntry, EventMsg, SessionSource,
        SubAgentActivityEvent, SubAgentActivityKind, SubAgentSource,
    },
};
use serde::Serialize;
use serde_json::json;

const CODEX_ACP_EVENT_TYPE_KEY: &str = "codexAcpEventType";
const CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY: &str = "codexAcpSubagentEventType";
const CODEX_ACP_PARENT_SESSION_ID_KEY: &str = "codexAcpParentSessionId";
const CODEX_ACP_PARENT_THREAD_ID_KEY: &str = "codexAcpParentThreadId";
const CODEX_ACP_CHILD_SESSION_ID_KEY: &str = "codexAcpChildSessionId";
const CODEX_ACP_CHILD_THREAD_ID_KEY: &str = "codexAcpChildThreadId";
const CODEX_ACP_AGENT_PATH_KEY: &str = "codexAcpAgentPath";
const CODEX_ACP_AGENT_NICKNAME_KEY: &str = "codexAcpAgentNickname";
const CODEX_ACP_AGENT_ROLE_KEY: &str = "codexAcpAgentRole";
const CODEX_ACP_AGENT_STATUS_KEY: &str = "codexAcpAgentStatus";
const CODEX_ACP_AGENT_STATUSES_KEY: &str = "codexAcpAgentStatuses";
const CODEX_ACP_MODEL_KEY: &str = "codexAcpModel";
const CODEX_ACP_REASONING_EFFORT_KEY: &str = "codexAcpReasoningEffort";
const CODEX_ACP_CWD_KEY: &str = "codexAcpCwd";
const CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT: &str = "subagent_session_created";
const CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT: &str = "subagent_breadcrumb";
const CODEX_ACP_SUBAGENT_TOOL_CALL_ID_PREFIX: &str = "codex-acp:subagent:";

#[derive(Debug, Clone)]
pub(crate) struct SubagentThreadRegistration {
    pub parent_thread_id: ThreadId,
    pub parent_session_id: SessionId,
    pub child_thread_id: ThreadId,
    pub child_session_id: SessionId,
    pub agent_path: Option<String>,
    pub nickname: Option<String>,
    pub role: Option<String>,
}

pub(crate) enum SubagentProjection {
    ToolCall(ToolCall),
    ToolCallUpdate(ToolCallUpdate),
}

#[derive(Default)]
pub(crate) struct SubagentProjectionState {
    wait_tool_call_ids_by_group: HashMap<String, String>,
    wait_tool_call_ids_by_call: HashMap<String, String>,
}

impl SubagentProjectionState {
    pub(crate) fn coalesce_wait_projection(
        &mut self,
        event: &EventMsg,
        projection: &mut SubagentProjection,
    ) {
        let stable_tool_call_id = match event {
            EventMsg::CollabWaitingBegin(event) => {
                let group_key = waiting_group_key(event);
                let stable_tool_call_id = self
                    .wait_tool_call_ids_by_group
                    .entry(group_key)
                    .or_insert_with(|| subagent_tool_call_id(&event.call_id))
                    .clone();
                self.wait_tool_call_ids_by_call
                    .insert(event.call_id.clone(), stable_tool_call_id.clone());
                stable_tool_call_id
            }
            EventMsg::CollabWaitingEnd(event) => self
                .wait_tool_call_ids_by_call
                .get(&event.call_id)
                .cloned()
                .unwrap_or_else(|| subagent_tool_call_id(&event.call_id)),
            _ => return,
        };

        match projection {
            SubagentProjection::ToolCall(tool_call) => {
                tool_call.tool_call_id = stable_tool_call_id.into();
            }
            SubagentProjection::ToolCallUpdate(update) => {
                update.tool_call_id = stable_tool_call_id.into();
            }
        }
    }
}

pub(crate) fn registration_for_thread(
    child_thread_id: ThreadId,
    snapshot: &ThreadConfigSnapshot,
) -> Option<SubagentThreadRegistration> {
    let SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
        parent_thread_id,
        agent_path,
        agent_nickname,
        agent_role,
        ..
    }) = &snapshot.session_source
    else {
        return None;
    };

    Some(SubagentThreadRegistration {
        parent_thread_id: *parent_thread_id,
        parent_session_id: session_id_from_thread_id(*parent_thread_id),
        child_thread_id,
        child_session_id: session_id_from_thread_id(child_thread_id),
        agent_path: agent_path.as_ref().map(ToString::to_string),
        nickname: agent_nickname.clone(),
        role: agent_role.clone(),
    })
}

pub(crate) fn session_created_notification(
    registration: &SubagentThreadRegistration,
    snapshot: &ThreadConfigSnapshot,
) -> SessionNotification {
    let meta = session_created_meta(registration, snapshot);
    let mut update = SessionInfoUpdate::new().meta(meta.clone());
    if let Some(title) = subagent_display_name(
        registration.nickname.as_deref(),
        registration.agent_path.as_deref(),
        None,
    ) {
        update = update.title(title);
    }

    SessionNotification::new(
        registration.child_session_id.clone(),
        SessionUpdate::SessionInfoUpdate(update),
    )
    .meta(meta)
}

pub(crate) fn projection_for_event(
    event: &EventMsg,
    current_thread_id: ThreadId,
    parent_session_id: &SessionId,
) -> Option<SubagentProjection> {
    match event {
        EventMsg::SubAgentActivity(event) => {
            project_subagent_activity(event, current_thread_id, parent_session_id)
        }
        EventMsg::CollabAgentSpawnBegin(event) => {
            let title = "Spawning subagent";
            Some(SubagentProjection::ToolCall(
                ToolCall::new(subagent_tool_call_id(&event.call_id), title)
                    .kind(ToolKind::Other)
                    .status(ToolCallStatus::InProgress)
                    .content(content(Some(format!(
                        "Prompt: {}\nModel: {}\nReasoning effort: {}",
                        trim_for_detail(&event.prompt),
                        event.model,
                        format_jsonish(&event.reasoning_effort)
                    ))))
                    .raw_input(raw_event(event))
                    .meta(breadcrumb_meta(
                        "spawn_begin",
                        event.sender_thread_id,
                        None,
                        None,
                        None,
                        None,
                    )),
            ))
        }
        EventMsg::CollabAgentSpawnEnd(event) => {
            let display_name =
                subagent_display_name(event.new_agent_nickname.as_deref(), None, None)
                    .unwrap_or_else(|| "subagent".to_string());
            let status = if event.new_thread_id.is_some() {
                ToolCallStatus::Completed
            } else {
                ToolCallStatus::Failed
            };
            let title = if event.new_thread_id.is_some() {
                format!("Spawned {display_name}")
            } else {
                format!("Failed to spawn {display_name}")
            };
            Some(SubagentProjection::ToolCallUpdate(
                ToolCallUpdate::new(
                    subagent_tool_call_id(&event.call_id),
                    ToolCallUpdateFields::new()
                        .title(title)
                        .status(status)
                        .content(content(Some(format!(
                            "Status: {}",
                            agent_status_label(&event.status)
                        ))))
                        .raw_output(raw_event(event)),
                )
                .meta(breadcrumb_meta(
                    "spawn_end",
                    event.sender_thread_id,
                    event.new_thread_id,
                    event.new_agent_nickname.as_deref(),
                    event.new_agent_role.as_deref(),
                    Some(&event.status),
                )),
            ))
        }
        EventMsg::CollabAgentInteractionBegin(event) => Some(SubagentProjection::ToolCall(
            ToolCall::new(subagent_tool_call_id(&event.call_id), "Contacting subagent")
                .kind(ToolKind::Other)
                .status(ToolCallStatus::InProgress)
                .content(content(Some(format!(
                    "Receiver: {}\nPrompt: {}",
                    event.receiver_thread_id,
                    trim_for_detail(&event.prompt)
                ))))
                .raw_input(raw_event(event))
                .meta(breadcrumb_meta(
                    "interaction_begin",
                    event.sender_thread_id,
                    Some(event.receiver_thread_id),
                    None,
                    None,
                    None,
                )),
        )),
        EventMsg::CollabAgentInteractionEnd(event) => {
            let display_name = subagent_display_name(
                event.receiver_agent_nickname.as_deref(),
                None,
                Some(event.receiver_thread_id),
            )
            .unwrap_or_else(|| "subagent".to_string());
            Some(SubagentProjection::ToolCallUpdate(
                ToolCallUpdate::new(
                    subagent_tool_call_id(&event.call_id),
                    ToolCallUpdateFields::new()
                        .title(format!("{display_name} responded"))
                        .status(ToolCallStatus::Completed)
                        .content(content(Some(format!(
                            "Status: {}",
                            agent_status_label(&event.status)
                        ))))
                        .raw_output(raw_event(event)),
                )
                .meta(breadcrumb_meta(
                    "interaction_end",
                    event.sender_thread_id,
                    Some(event.receiver_thread_id),
                    event.receiver_agent_nickname.as_deref(),
                    event.receiver_agent_role.as_deref(),
                    Some(&event.status),
                )),
            ))
        }
        EventMsg::CollabWaitingBegin(event) => Some(SubagentProjection::ToolCall(
            ToolCall::new(
                subagent_tool_call_id(&event.call_id),
                "Waiting for subagents",
            )
            .kind(ToolKind::Other)
            .status(ToolCallStatus::InProgress)
            .content(content(Some(
                format_agent_refs(&event.receiver_agents).unwrap_or_else(|| {
                    event
                        .receiver_thread_ids
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                }),
            )))
            .raw_input(raw_event(event))
            .meta(breadcrumb_meta(
                "waiting_begin",
                event.sender_thread_id,
                None,
                None,
                None,
                None,
            )),
        )),
        EventMsg::CollabWaitingEnd(event) => Some(SubagentProjection::ToolCallUpdate(
            ToolCallUpdate::new(
                subagent_tool_call_id(&event.call_id),
                ToolCallUpdateFields::new()
                    .title(waiting_end_title(event))
                    .status(waiting_end_tool_status(event))
                    .content(content(
                        format_agent_statuses(&event.agent_statuses)
                            .or_else(|| format_thread_statuses(&event.statuses)),
                    ))
                    .raw_output(raw_event(event)),
            )
            .meta(waiting_end_breadcrumb_meta(event)),
        )),
        EventMsg::CollabResumeBegin(event) => {
            let display_name = subagent_display_name(
                event.receiver_agent_nickname.as_deref(),
                None,
                Some(event.receiver_thread_id),
            )
            .unwrap_or_else(|| "subagent".to_string());
            Some(SubagentProjection::ToolCall(
                ToolCall::new(
                    subagent_tool_call_id(&event.call_id),
                    format!("Resuming {display_name}"),
                )
                .kind(ToolKind::Other)
                .status(ToolCallStatus::InProgress)
                .raw_input(raw_event(event))
                .meta(breadcrumb_meta(
                    "resume_begin",
                    event.sender_thread_id,
                    Some(event.receiver_thread_id),
                    event.receiver_agent_nickname.as_deref(),
                    event.receiver_agent_role.as_deref(),
                    None,
                )),
            ))
        }
        EventMsg::CollabResumeEnd(event) => {
            let display_name = subagent_display_name(
                event.receiver_agent_nickname.as_deref(),
                None,
                Some(event.receiver_thread_id),
            )
            .unwrap_or_else(|| "subagent".to_string());
            Some(SubagentProjection::ToolCallUpdate(
                ToolCallUpdate::new(
                    subagent_tool_call_id(&event.call_id),
                    ToolCallUpdateFields::new()
                        .title(format!("Resumed {display_name}"))
                        .status(ToolCallStatus::Completed)
                        .content(content(Some(format!(
                            "Status: {}",
                            agent_status_label(&event.status)
                        ))))
                        .raw_output(raw_event(event)),
                )
                .meta(breadcrumb_meta(
                    "resume_end",
                    event.sender_thread_id,
                    Some(event.receiver_thread_id),
                    event.receiver_agent_nickname.as_deref(),
                    event.receiver_agent_role.as_deref(),
                    Some(&event.status),
                )),
            ))
        }
        EventMsg::CollabCloseBegin(event) => Some(SubagentProjection::ToolCall(
            ToolCall::new(subagent_tool_call_id(&event.call_id), "Closing subagent")
                .kind(ToolKind::Other)
                .status(ToolCallStatus::InProgress)
                .raw_input(raw_event(event))
                .meta(breadcrumb_meta(
                    "close_begin",
                    event.sender_thread_id,
                    Some(event.receiver_thread_id),
                    None,
                    None,
                    None,
                )),
        )),
        EventMsg::CollabCloseEnd(event) => {
            let display_name = subagent_display_name(
                event.receiver_agent_nickname.as_deref(),
                None,
                Some(event.receiver_thread_id),
            )
            .unwrap_or_else(|| "subagent".to_string());
            Some(SubagentProjection::ToolCallUpdate(
                ToolCallUpdate::new(
                    subagent_tool_call_id(&event.call_id),
                    ToolCallUpdateFields::new()
                        .title(format!("Closed {display_name}"))
                        .status(ToolCallStatus::Completed)
                        .content(content(Some(format!(
                            "Final status: {}",
                            agent_status_label(&event.status)
                        ))))
                        .raw_output(raw_event(event)),
                )
                .meta(breadcrumb_meta(
                    "close_end",
                    event.sender_thread_id,
                    Some(event.receiver_thread_id),
                    event.receiver_agent_nickname.as_deref(),
                    event.receiver_agent_role.as_deref(),
                    Some(&event.status),
                )),
            ))
        }
        _ => None,
    }
}

fn project_subagent_activity(
    event: &SubAgentActivityEvent,
    current_thread_id: ThreadId,
    parent_session_id: &SessionId,
) -> Option<SubagentProjection> {
    if event.agent_thread_id == current_thread_id {
        return None;
    }

    let display_name = event.agent_path.name();
    let (event_type, title, status) = match event.kind {
        SubAgentActivityKind::Started => (
            "activity_started",
            format!("Started {display_name}"),
            "running",
        ),
        SubAgentActivityKind::Interacted => (
            "activity_interacted",
            format!("Contacted {display_name}"),
            "running",
        ),
        SubAgentActivityKind::Interrupted => (
            "activity_interrupted",
            format!("Interrupted {display_name}"),
            "interrupted",
        ),
    };

    let mut meta = Meta::new();
    meta.insert(
        CODEX_ACP_EVENT_TYPE_KEY.to_string(),
        json!(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT),
    );
    meta.insert(
        CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY.to_string(),
        json!(event_type),
    );
    meta.insert(
        CODEX_ACP_PARENT_SESSION_ID_KEY.to_string(),
        json!(parent_session_id.0.to_string()),
    );
    meta.insert(
        CODEX_ACP_PARENT_THREAD_ID_KEY.to_string(),
        json!(current_thread_id.to_string()),
    );
    meta.insert(
        CODEX_ACP_CHILD_SESSION_ID_KEY.to_string(),
        json!(event.agent_thread_id.to_string()),
    );
    meta.insert(
        CODEX_ACP_CHILD_THREAD_ID_KEY.to_string(),
        json!(event.agent_thread_id.to_string()),
    );
    meta.insert(
        CODEX_ACP_AGENT_PATH_KEY.to_string(),
        json!(event.agent_path),
    );
    meta.insert(CODEX_ACP_AGENT_STATUS_KEY.to_string(), json!(status));

    Some(SubagentProjection::ToolCall(
        ToolCall::new(subagent_activity_tool_call_id(&event.event_id), title)
            .kind(ToolKind::Other)
            .status(ToolCallStatus::Completed)
            .content(content(Some(format!("Agent: {}", event.agent_path))))
            .raw_output(raw_event(event))
            .meta(meta),
    ))
}

fn session_id_from_thread_id(thread_id: ThreadId) -> SessionId {
    SessionId::new(thread_id.to_string())
}

fn session_created_meta(
    registration: &SubagentThreadRegistration,
    snapshot: &ThreadConfigSnapshot,
) -> Meta {
    let mut meta = Meta::new();
    // NeverWrite consumes these codexAcp* keys as a private child-session contract.
    meta.insert(
        CODEX_ACP_EVENT_TYPE_KEY.to_string(),
        json!(CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT),
    );
    meta.insert(
        CODEX_ACP_PARENT_SESSION_ID_KEY.to_string(),
        json!(registration.parent_session_id.0.to_string()),
    );
    meta.insert(
        CODEX_ACP_PARENT_THREAD_ID_KEY.to_string(),
        json!(registration.parent_thread_id.to_string()),
    );
    meta.insert(
        CODEX_ACP_CHILD_SESSION_ID_KEY.to_string(),
        json!(registration.child_session_id.0.to_string()),
    );
    meta.insert(
        CODEX_ACP_CHILD_THREAD_ID_KEY.to_string(),
        json!(registration.child_thread_id.to_string()),
    );
    meta.insert(CODEX_ACP_MODEL_KEY.to_string(), json!(snapshot.model));
    meta.insert(
        CODEX_ACP_CWD_KEY.to_string(),
        json!(snapshot.cwd().display().to_string()),
    );

    if let Some(reasoning_effort) = snapshot.reasoning_effort.as_ref() {
        meta.insert(
            CODEX_ACP_REASONING_EFFORT_KEY.to_string(),
            json!(reasoning_effort),
        );
    }
    if let Some(nickname) = registration.nickname.as_deref() {
        meta.insert(CODEX_ACP_AGENT_NICKNAME_KEY.to_string(), json!(nickname));
    }
    if let Some(agent_path) = registration.agent_path.as_deref() {
        meta.insert(CODEX_ACP_AGENT_PATH_KEY.to_string(), json!(agent_path));
    }
    if let Some(role) = registration.role.as_deref() {
        meta.insert(CODEX_ACP_AGENT_ROLE_KEY.to_string(), json!(role));
    }

    meta
}

fn breadcrumb_meta(
    event_type: &str,
    parent_thread_id: ThreadId,
    child_thread_id: Option<ThreadId>,
    nickname: Option<&str>,
    role: Option<&str>,
    status: Option<&AgentStatus>,
) -> Meta {
    let mut meta = Meta::new();
    meta.insert(
        CODEX_ACP_EVENT_TYPE_KEY.to_string(),
        json!(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT),
    );
    meta.insert(
        CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY.to_string(),
        json!(event_type),
    );
    meta.insert(
        CODEX_ACP_PARENT_SESSION_ID_KEY.to_string(),
        json!(parent_thread_id.to_string()),
    );
    meta.insert(
        CODEX_ACP_PARENT_THREAD_ID_KEY.to_string(),
        json!(parent_thread_id.to_string()),
    );
    if let Some(child_thread_id) = child_thread_id {
        meta.insert(
            CODEX_ACP_CHILD_SESSION_ID_KEY.to_string(),
            json!(child_thread_id.to_string()),
        );
        meta.insert(
            CODEX_ACP_CHILD_THREAD_ID_KEY.to_string(),
            json!(child_thread_id.to_string()),
        );
    }
    if let Some(nickname) = nickname {
        meta.insert(CODEX_ACP_AGENT_NICKNAME_KEY.to_string(), json!(nickname));
    }
    if let Some(role) = role {
        meta.insert(CODEX_ACP_AGENT_ROLE_KEY.to_string(), json!(role));
    }
    if let Some(status) = status {
        meta.insert(CODEX_ACP_AGENT_STATUS_KEY.to_string(), json!(status));
    }
    meta
}

fn waiting_end_breadcrumb_meta(event: &codex_protocol::protocol::CollabWaitingEndEvent) -> Meta {
    let mut meta = breadcrumb_meta(
        "waiting_end",
        event.sender_thread_id,
        None,
        None,
        None,
        None,
    );
    let statuses = waiting_end_statuses(event);
    if !statuses.is_empty() {
        meta.insert(CODEX_ACP_AGENT_STATUSES_KEY.to_string(), json!(statuses));
    }
    meta
}

fn waiting_group_key(event: &codex_protocol::protocol::CollabWaitingBeginEvent) -> String {
    let mut receiver_thread_ids = event
        .receiver_thread_ids
        .iter()
        .chain(event.receiver_agents.iter().map(|agent| &agent.thread_id))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    receiver_thread_ids.sort();
    receiver_thread_ids.dedup();

    if receiver_thread_ids.is_empty() {
        format!("{}:all", event.sender_thread_id)
    } else {
        format!(
            "{}:{}",
            event.sender_thread_id,
            receiver_thread_ids.join(",")
        )
    }
}

fn waiting_end_title(event: &codex_protocol::protocol::CollabWaitingEndEvent) -> &'static str {
    let statuses = waiting_end_agent_statuses(event);
    if statuses.is_empty() {
        "Checked subagents"
    } else if statuses
        .iter()
        .all(|status| is_terminal_agent_status(status))
    {
        "Subagents finished"
    } else {
        "Subagents still running"
    }
}

fn waiting_end_tool_status(
    event: &codex_protocol::protocol::CollabWaitingEndEvent,
) -> ToolCallStatus {
    let statuses = waiting_end_agent_statuses(event);
    if !statuses.is_empty()
        && statuses
            .iter()
            .all(|status| is_terminal_agent_status(status))
    {
        ToolCallStatus::Completed
    } else {
        ToolCallStatus::InProgress
    }
}

fn waiting_end_agent_statuses(
    event: &codex_protocol::protocol::CollabWaitingEndEvent,
) -> Vec<&AgentStatus> {
    if event.agent_statuses.is_empty() {
        event.statuses.values().collect()
    } else {
        event
            .agent_statuses
            .iter()
            .map(|entry| &entry.status)
            .collect()
    }
}

fn is_terminal_agent_status(status: &AgentStatus) -> bool {
    !matches!(status, AgentStatus::PendingInit | AgentStatus::Running)
}

fn waiting_end_statuses(
    event: &codex_protocol::protocol::CollabWaitingEndEvent,
) -> Vec<serde_json::Value> {
    if !event.agent_statuses.is_empty() {
        return event
            .agent_statuses
            .iter()
            .map(|entry| {
                json!({
                    "codexAcpChildSessionId": entry.thread_id.to_string(),
                    "codexAcpChildThreadId": entry.thread_id.to_string(),
                    "codexAcpAgentNickname": entry.agent_nickname,
                    "codexAcpAgentRole": entry.agent_role,
                    "codexAcpAgentStatus": entry.status,
                })
            })
            .collect();
    }

    event
        .statuses
        .iter()
        .map(|(thread_id, status)| {
            json!({
                "codexAcpChildSessionId": thread_id.to_string(),
                "codexAcpChildThreadId": thread_id.to_string(),
                "codexAcpAgentStatus": status,
            })
        })
        .collect()
}

fn subagent_tool_call_id(call_id: &str) -> String {
    format!("{CODEX_ACP_SUBAGENT_TOOL_CALL_ID_PREFIX}{call_id}")
}

/// Both 0.144 representations of a subagent activity share this protocol ID.
/// No descriptive attribute is a valid correlation fallback when the IDs differ.
pub(crate) fn subagent_activity_tool_call_id(protocol_id: &str) -> String {
    subagent_tool_call_id(protocol_id)
}

fn raw_event(event: impl Serialize) -> serde_json::Value {
    serde_json::to_value(event).unwrap_or_else(|_| json!({}))
}

fn content(detail: Option<String>) -> Vec<ToolCallContent> {
    detail
        .filter(|detail| !detail.trim().is_empty())
        .into_iter()
        .map(|detail| ToolCallContent::Content(Content::new(detail)))
        .collect()
}

fn subagent_display_name(
    nickname: Option<&str>,
    agent_path: Option<&str>,
    fallback_thread_id: Option<ThreadId>,
) -> Option<String> {
    nickname
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
        .or_else(|| {
            agent_path
                .and_then(|path| path.rsplit('/').find(|segment| !segment.is_empty()))
                .map(ToString::to_string)
        })
        .or_else(|| fallback_thread_id.map(|thread_id| format!("subagent {thread_id}")))
}

fn trim_for_detail(value: &str) -> String {
    const MAX_CHARS: usize = 240;
    let trimmed = value.trim();
    if trimmed.chars().count() <= MAX_CHARS {
        return trimmed.to_string();
    }

    let mut output = trimmed.chars().take(MAX_CHARS - 3).collect::<String>();
    output.push_str("...");
    output
}

fn format_jsonish(value: impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .map(|value| match value {
            serde_json::Value::String(value) => value,
            value => value.to_string(),
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn format_agent_refs(agents: &[CollabAgentRef]) -> Option<String> {
    if agents.is_empty() {
        return None;
    }

    Some(
        agents
            .iter()
            .map(|agent| {
                subagent_display_name(agent.agent_nickname.as_deref(), None, Some(agent.thread_id))
                    .unwrap_or_else(|| agent.thread_id.to_string())
            })
            .collect::<Vec<_>>()
            .join(", "),
    )
}

fn format_agent_statuses(statuses: &[CollabAgentStatusEntry]) -> Option<String> {
    if statuses.is_empty() {
        return None;
    }

    Some(
        statuses
            .iter()
            .map(|entry| {
                let display_name = subagent_display_name(
                    entry.agent_nickname.as_deref(),
                    None,
                    Some(entry.thread_id),
                )
                .unwrap_or_else(|| entry.thread_id.to_string());
                format!("{display_name}: {}", agent_status_label(&entry.status))
            })
            .collect::<Vec<_>>()
            .join("\n"),
    )
}

fn format_thread_statuses(statuses: &HashMap<ThreadId, AgentStatus>) -> Option<String> {
    if statuses.is_empty() {
        return None;
    }

    let mut lines = statuses
        .iter()
        .map(|(thread_id, status)| format!("{thread_id}: {}", agent_status_label(status)))
        .collect::<Vec<_>>();
    lines.sort();
    Some(lines.join("\n"))
}

fn agent_status_label(status: &AgentStatus) -> String {
    match status {
        AgentStatus::PendingInit => "pending".to_string(),
        AgentStatus::Running => "running".to_string(),
        AgentStatus::Interrupted => "interrupted".to_string(),
        AgentStatus::Completed(message) => message
            .as_deref()
            .filter(|message| !message.trim().is_empty())
            .map(|message| format!("completed: {}", trim_for_detail(message)))
            .unwrap_or_else(|| "completed".to_string()),
        AgentStatus::Errored(error) => format!("errored: {}", trim_for_detail(error)),
        AgentStatus::Shutdown => "shutdown".to_string(),
        AgentStatus::NotFound => "not found".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::{
        AgentPath,
        config_types::{ApprovalsReviewer, CollaborationMode, ModeKind, Settings},
        models::PermissionProfile,
        openai_models::ReasoningEffort,
        protocol::{AskForApproval, ThreadHistoryMode, TurnEnvironmentSelections},
    };

    fn thread_snapshot(parent_thread_id: ThreadId) -> ThreadConfigSnapshot {
        let cwd = std::env::current_dir()
            .expect("current dir should be available")
            .try_into()
            .expect("current dir should be absolute");
        ThreadConfigSnapshot {
            model: "gpt-5.5".to_string(),
            model_provider_id: "openai".to_string(),
            service_tier: Some("fast".to_string()),
            approval_policy: AskForApproval::OnRequest,
            approvals_reviewer: ApprovalsReviewer::default(),
            permission_profile: PermissionProfile::default(),
            active_permission_profile: None,
            environments: TurnEnvironmentSelections::new(cwd, Vec::new()),
            workspace_roots: Vec::new(),
            profile_workspace_roots: Vec::new(),
            ephemeral: false,
            reasoning_effort: Some(ReasoningEffort::High),
            reasoning_summary: None,
            personality: None,
            collaboration_mode: CollaborationMode {
                mode: ModeKind::Default,
                settings: Settings {
                    model: "gpt-5.5".to_string(),
                    reasoning_effort: Some(ReasoningEffort::High),
                    developer_instructions: None,
                },
            },
            session_source: SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id,
                depth: 1,
                agent_path: Some(
                    AgentPath::from_string("/root/research/explorer".to_string())
                        .expect("agent path should be valid"),
                ),
                agent_nickname: Some("Galileo".to_string()),
                agent_role: Some("explorer".to_string()),
            }),
            parent_thread_id: Some(parent_thread_id),
            thread_source: None,
            history_mode: ThreadHistoryMode::default(),
            forked_from_thread_id: None,
            originator: String::new(),
        }
    }

    #[test]
    fn registration_for_thread_only_accepts_thread_spawn_subagents() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let snapshot = thread_snapshot(parent_thread_id);

        let registration = registration_for_thread(child_thread_id, &snapshot)
            .expect("thread spawn subagent should register");

        assert_eq!(registration.parent_thread_id, parent_thread_id);
        assert_eq!(registration.child_thread_id, child_thread_id);
        assert_eq!(
            registration.parent_session_id.0.as_ref(),
            parent_thread_id.to_string()
        );
        assert_eq!(
            registration.child_session_id.0.as_ref(),
            child_thread_id.to_string()
        );
        assert_eq!(registration.nickname.as_deref(), Some("Galileo"));
        assert_eq!(registration.role.as_deref(), Some("explorer"));
        assert_eq!(
            registration.agent_path.as_deref(),
            Some("/root/research/explorer")
        );
    }

    #[test]
    fn session_created_notification_carries_private_child_session_contract() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let snapshot = thread_snapshot(parent_thread_id);
        let registration = registration_for_thread(child_thread_id, &snapshot)
            .expect("thread spawn subagent should register");

        let notification = session_created_notification(&registration, &snapshot);
        let meta = notification
            .meta
            .expect("notification should carry metadata");

        assert_eq!(notification.session_id, registration.child_session_id);
        assert_eq!(
            meta.get(CODEX_ACP_EVENT_TYPE_KEY)
                .and_then(|value| value.as_str()),
            Some(CODEX_ACP_SUBAGENT_SESSION_CREATED_EVENT)
        );
        assert_eq!(
            meta.get(CODEX_ACP_PARENT_THREAD_ID_KEY)
                .and_then(|value| value.as_str()),
            Some(parent_thread_id.to_string().as_str())
        );
        assert_eq!(
            meta.get(CODEX_ACP_CHILD_THREAD_ID_KEY)
                .and_then(|value| value.as_str()),
            Some(child_thread_id.to_string().as_str())
        );
        assert_eq!(
            meta.get(CODEX_ACP_AGENT_NICKNAME_KEY)
                .and_then(|value| value.as_str()),
            Some("Galileo")
        );
        assert_eq!(
            meta.get(CODEX_ACP_AGENT_PATH_KEY)
                .and_then(|value| value.as_str()),
            Some("/root/research/explorer")
        );
        assert!(matches!(
            notification.update,
            SessionUpdate::SessionInfoUpdate(update) if update.title.value().map(String::as_str) == Some("Galileo")
        ));
    }

    #[test]
    fn agent_path_is_optional_metadata_and_visible_title_fallback() {
        assert_eq!(
            subagent_display_name(None, Some("/root/research/explorer"), None).as_deref(),
            Some("explorer")
        );
        assert_eq!(
            subagent_display_name(Some("Galileo"), Some("/root/research/explorer"), None,)
                .as_deref(),
            Some("Galileo")
        );

        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let mut snapshot = thread_snapshot(parent_thread_id);
        let SessionSource::SubAgent(SubAgentSource::ThreadSpawn { agent_path, .. }) =
            &mut snapshot.session_source
        else {
            panic!("fixture should be a spawned subagent");
        };
        *agent_path = None;

        let registration = registration_for_thread(child_thread_id, &snapshot)
            .expect("thread spawn subagent should register");
        let notification = session_created_notification(&registration, &snapshot);
        let meta = notification
            .meta
            .expect("notification should carry metadata");
        assert!(!meta.contains_key(CODEX_ACP_AGENT_PATH_KEY));
    }

    #[test]
    fn subagent_activity_projects_navigable_breadcrumbs() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let parent_session_id = SessionId::new("parent-runtime-session-id");

        for (kind, event_type, status, title) in [
            (
                SubAgentActivityKind::Started,
                "activity_started",
                "running",
                "Started explorer",
            ),
            (
                SubAgentActivityKind::Interacted,
                "activity_interacted",
                "running",
                "Contacted explorer",
            ),
            (
                SubAgentActivityKind::Interrupted,
                "activity_interrupted",
                "interrupted",
                "Interrupted explorer",
            ),
        ] {
            let projection = projection_for_event(
                &EventMsg::SubAgentActivity(SubAgentActivityEvent {
                    event_id: format!("event-{kind:?}"),
                    occurred_at_ms: 12,
                    agent_thread_id: child_thread_id,
                    agent_path: "/root/research/explorer"
                        .try_into()
                        .expect("agent path should be valid"),
                    kind,
                }),
                parent_thread_id,
                &parent_session_id,
            )
            .expect("activity should project");
            let SubagentProjection::ToolCall(tool_call) = projection else {
                panic!("activity should create a tool call");
            };

            assert_eq!(tool_call.title, title);
            assert_eq!(tool_call.status, ToolCallStatus::Completed);
            assert_eq!(
                tool_call.tool_call_id.0.as_ref(),
                subagent_activity_tool_call_id(&format!("event-{kind:?}"))
            );
            let meta = tool_call.meta.expect("activity should include metadata");
            assert_eq!(
                meta.get(CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY)
                    .and_then(|value| value.as_str()),
                Some(event_type)
            );
            assert_eq!(
                meta.get(CODEX_ACP_PARENT_SESSION_ID_KEY)
                    .and_then(|value| value.as_str()),
                Some("parent-runtime-session-id")
            );
            assert_eq!(
                meta.get(CODEX_ACP_CHILD_THREAD_ID_KEY)
                    .and_then(|value| value.as_str()),
                Some(child_thread_id.to_string().as_str())
            );
            assert_eq!(
                meta.get(CODEX_ACP_AGENT_STATUS_KEY)
                    .and_then(|value| value.as_str()),
                Some(status)
            );
        }
    }

    #[test]
    fn subagent_activity_uses_typed_thread_identity_for_self_reference() {
        let current_thread_id = ThreadId::new();
        let event = EventMsg::SubAgentActivity(SubAgentActivityEvent {
            event_id: "self".to_string(),
            occurred_at_ms: 0,
            agent_thread_id: current_thread_id,
            agent_path: "/root".try_into().expect("root path should be valid"),
            kind: SubAgentActivityKind::Started,
        });
        assert!(
            projection_for_event(
                &event,
                current_thread_id,
                &SessionId::new("session-id-with-a-different-serialization"),
            )
            .is_none()
        );

        let distinct_thread_id = ThreadId::new();
        let EventMsg::SubAgentActivity(event) = event else {
            unreachable!();
        };
        assert!(
            projection_for_event(
                &EventMsg::SubAgentActivity(SubAgentActivityEvent {
                    agent_thread_id: distinct_thread_id,
                    ..event
                }),
                current_thread_id,
                &SessionId::new("parent-session"),
            )
            .is_some()
        );
    }

    #[test]
    fn collab_spawn_events_project_compact_breadcrumbs() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();

        let begin = projection_for_event(
            &EventMsg::CollabAgentSpawnBegin(
                codex_protocol::protocol::CollabAgentSpawnBeginEvent {
                    call_id: "spawn-1".to_string(),
                    sender_thread_id: parent_thread_id,
                    prompt: "inspect the renderer".to_string(),
                    model: "gpt-5.5".to_string(),
                    reasoning_effort: ReasoningEffort::Medium,
                    started_at_ms: 0,
                },
            ),
            parent_thread_id,
            &SessionId::new(parent_thread_id.to_string()),
        )
        .expect("spawn begin should project");
        let SubagentProjection::ToolCall(tool_call) = begin else {
            panic!("expected ToolCall projection");
        };
        assert_eq!(tool_call.title, "Spawning subagent");
        assert_eq!(tool_call.status, ToolCallStatus::InProgress);
        assert_eq!(
            tool_call
                .meta
                .as_ref()
                .and_then(|meta| meta.get(CODEX_ACP_EVENT_TYPE_KEY))
                .and_then(|value| value.as_str()),
            Some(CODEX_ACP_SUBAGENT_BREADCRUMB_EVENT)
        );
        assert!(
            tool_call
                .meta
                .as_ref()
                .is_some_and(|meta| !meta.contains_key(CODEX_ACP_CHILD_SESSION_ID_KEY)),
            "spawn begin should not invent a child before Codex returns it"
        );

        let end = projection_for_event(
            &EventMsg::CollabAgentSpawnEnd(codex_protocol::protocol::CollabAgentSpawnEndEvent {
                call_id: "spawn-1".to_string(),
                sender_thread_id: parent_thread_id,
                new_thread_id: Some(child_thread_id),
                new_agent_nickname: Some("Galileo".to_string()),
                new_agent_role: Some("explorer".to_string()),
                prompt: "inspect the renderer".to_string(),
                model: "gpt-5.5".to_string(),
                reasoning_effort: ReasoningEffort::Medium,
                status: AgentStatus::Running,
                completed_at_ms: 0,
            }),
            parent_thread_id,
            &SessionId::new(parent_thread_id.to_string()),
        )
        .expect("spawn end should project");
        let SubagentProjection::ToolCallUpdate(update) = end else {
            panic!("expected ToolCallUpdate projection");
        };
        assert_eq!(update.fields.title.as_deref(), Some("Spawned Galileo"));
        assert_eq!(update.fields.status, Some(ToolCallStatus::Completed));
        assert_eq!(
            update
                .meta
                .as_ref()
                .and_then(|meta| meta.get(CODEX_ACP_CHILD_THREAD_ID_KEY))
                .and_then(|value| value.as_str()),
            Some(child_thread_id.to_string().as_str())
        );
    }

    #[test]
    fn collab_waiting_end_projects_structured_agent_statuses() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let projection = projection_for_event(
            &EventMsg::CollabWaitingEnd(codex_protocol::protocol::CollabWaitingEndEvent {
                sender_thread_id: parent_thread_id,
                call_id: "wait-1".to_string(),
                agent_statuses: vec![codex_protocol::protocol::CollabAgentStatusEntry {
                    thread_id: child_thread_id,
                    agent_nickname: Some("Galileo".to_string()),
                    agent_role: Some("explorer".to_string()),
                    status: AgentStatus::Completed(Some("done".to_string())),
                }],
                statuses: HashMap::new(),
                completed_at_ms: 0,
            }),
            parent_thread_id,
            &SessionId::new(parent_thread_id.to_string()),
        )
        .expect("waiting end should project");
        let SubagentProjection::ToolCallUpdate(update) = projection else {
            panic!("expected ToolCallUpdate projection");
        };
        let statuses = update
            .meta
            .as_ref()
            .and_then(|meta| meta.get(CODEX_ACP_AGENT_STATUSES_KEY))
            .and_then(|value| value.as_array())
            .expect("waiting_end should include structured statuses");
        let status = statuses.first().expect("first status should exist");

        assert_eq!(
            status
                .get(CODEX_ACP_CHILD_SESSION_ID_KEY)
                .and_then(|value| value.as_str()),
            Some(child_thread_id.to_string().as_str())
        );
        assert_eq!(
            status
                .get(CODEX_ACP_AGENT_NICKNAME_KEY)
                .and_then(|value| value.as_str()),
            Some("Galileo")
        );
        assert!(
            status
                .get(CODEX_ACP_AGENT_STATUS_KEY)
                .and_then(|value| value.get("completed"))
                .is_some(),
            "status={status:?}"
        );
    }

    #[test]
    fn collab_waiting_end_keeps_partial_and_empty_waits_in_progress() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let parent_session_id = SessionId::new(parent_thread_id.to_string());

        for (call_id, statuses, expected_title) in [
            (
                "wait-running",
                vec![
                    AgentStatus::Completed(Some("done".to_string())),
                    AgentStatus::Running,
                ],
                "Subagents still running",
            ),
            ("wait-empty", Vec::new(), "Checked subagents"),
        ] {
            let agent_statuses = statuses
                .into_iter()
                .enumerate()
                .map(|(index, status)| CollabAgentStatusEntry {
                    thread_id: if index == 0 {
                        child_thread_id
                    } else {
                        ThreadId::new()
                    },
                    agent_nickname: None,
                    agent_role: None,
                    status,
                })
                .collect();
            let projection = projection_for_event(
                &EventMsg::CollabWaitingEnd(codex_protocol::protocol::CollabWaitingEndEvent {
                    sender_thread_id: parent_thread_id,
                    call_id: call_id.to_string(),
                    agent_statuses,
                    statuses: HashMap::new(),
                    completed_at_ms: 0,
                }),
                parent_thread_id,
                &parent_session_id,
            )
            .expect("waiting end should project");
            let SubagentProjection::ToolCallUpdate(update) = projection else {
                panic!("waiting end should update a tool call");
            };
            assert_eq!(update.fields.title.as_deref(), Some(expected_title));
            assert_eq!(update.fields.status, Some(ToolCallStatus::InProgress));
        }
    }

    #[test]
    fn repeated_waits_coalesce_by_parent_and_normalized_receivers() {
        let parent_thread_id = ThreadId::new();
        let other_parent_thread_id = ThreadId::new();
        let first_child_thread_id = ThreadId::new();
        let second_child_thread_id = ThreadId::new();
        let parent_session_id = SessionId::new(parent_thread_id.to_string());
        let mut state = SubagentProjectionState::default();

        let mut project_begin = |sender_thread_id, call_id: &str, receiver_thread_ids| {
            let event =
                EventMsg::CollabWaitingBegin(codex_protocol::protocol::CollabWaitingBeginEvent {
                    sender_thread_id,
                    receiver_thread_ids,
                    receiver_agents: Vec::new(),
                    call_id: call_id.to_string(),
                    started_at_ms: 0,
                });
            let mut projection = projection_for_event(&event, parent_thread_id, &parent_session_id)
                .expect("waiting begin should project");
            state.coalesce_wait_projection(&event, &mut projection);
            let SubagentProjection::ToolCall(tool_call) = projection else {
                panic!("waiting begin should create a tool call");
            };
            tool_call.tool_call_id.to_string()
        };

        let first = project_begin(
            parent_thread_id,
            "wait-1",
            vec![first_child_thread_id, second_child_thread_id],
        );
        let repeated = project_begin(
            parent_thread_id,
            "wait-2",
            vec![
                second_child_thread_id,
                first_child_thread_id,
                first_child_thread_id,
            ],
        );
        let different_group =
            project_begin(parent_thread_id, "wait-3", vec![first_child_thread_id]);
        let different_parent = project_begin(
            other_parent_thread_id,
            "wait-4",
            vec![first_child_thread_id, second_child_thread_id],
        );

        assert_eq!(first, repeated);
        assert_ne!(first, different_group);
        assert_ne!(first, different_parent);

        let repeated_end =
            EventMsg::CollabWaitingEnd(codex_protocol::protocol::CollabWaitingEndEvent {
                sender_thread_id: parent_thread_id,
                call_id: "wait-2".to_string(),
                agent_statuses: vec![CollabAgentStatusEntry {
                    thread_id: first_child_thread_id,
                    agent_nickname: None,
                    agent_role: None,
                    status: AgentStatus::Completed(None),
                }],
                statuses: HashMap::new(),
                completed_at_ms: 0,
            });
        let mut projection =
            projection_for_event(&repeated_end, parent_thread_id, &parent_session_id)
                .expect("waiting end should project");
        state.coalesce_wait_projection(&repeated_end, &mut projection);
        let SubagentProjection::ToolCallUpdate(update) = projection else {
            panic!("waiting end should update a tool call");
        };
        assert_eq!(update.tool_call_id.0.as_ref(), first);
        assert_eq!(update.fields.status, Some(ToolCallStatus::Completed));

        let end_without_begin =
            EventMsg::CollabWaitingEnd(codex_protocol::protocol::CollabWaitingEndEvent {
                sender_thread_id: parent_thread_id,
                call_id: "missing-begin".to_string(),
                agent_statuses: Vec::new(),
                statuses: HashMap::new(),
                completed_at_ms: 0,
            });
        let mut projection =
            projection_for_event(&end_without_begin, parent_thread_id, &parent_session_id)
                .expect("waiting end should project");
        state.coalesce_wait_projection(&end_without_begin, &mut projection);
        let SubagentProjection::ToolCallUpdate(update) = projection else {
            panic!("waiting end should update a tool call");
        };
        assert_eq!(
            update.tool_call_id.0.as_ref(),
            "codex-acp:subagent:missing-begin"
        );
    }
}
