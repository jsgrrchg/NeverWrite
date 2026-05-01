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
        SubAgentSource,
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
const CODEX_ACP_AGENT_NICKNAME_KEY: &str = "codexAcpAgentNickname";
const CODEX_ACP_AGENT_ROLE_KEY: &str = "codexAcpAgentRole";
const CODEX_ACP_AGENT_STATUS_KEY: &str = "codexAcpAgentStatus";
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
    pub nickname: Option<String>,
    pub role: Option<String>,
}

pub(crate) enum SubagentProjection {
    ToolCall(ToolCall),
    ToolCallUpdate(ToolCallUpdate),
}

pub(crate) fn registration_for_thread(
    child_thread_id: ThreadId,
    snapshot: &ThreadConfigSnapshot,
) -> Option<SubagentThreadRegistration> {
    let SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
        parent_thread_id,
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
    if let Some(title) = subagent_display_name(registration.nickname.as_deref(), None) {
        update = update.title(title);
    }

    SessionNotification::new(
        registration.child_session_id.clone(),
        SessionUpdate::SessionInfoUpdate(update),
    )
    .meta(meta)
}

pub(crate) fn projection_for_collab_event(event: &EventMsg) -> Option<SubagentProjection> {
    match event {
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
            let display_name = subagent_display_name(event.new_agent_nickname.as_deref(), None)
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
                    .title("Subagents finished")
                    .status(ToolCallStatus::Completed)
                    .content(content(
                        format_agent_statuses(&event.agent_statuses)
                            .or_else(|| format_thread_statuses(&event.statuses)),
                    ))
                    .raw_output(raw_event(event)),
            )
            .meta(breadcrumb_meta(
                "waiting_end",
                event.sender_thread_id,
                None,
                None,
                None,
                None,
            )),
        )),
        EventMsg::CollabResumeBegin(event) => {
            let display_name = subagent_display_name(
                event.receiver_agent_nickname.as_deref(),
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
        json!(snapshot.cwd.display().to_string()),
    );

    if let Some(reasoning_effort) = snapshot.reasoning_effort {
        meta.insert(
            CODEX_ACP_REASONING_EFFORT_KEY.to_string(),
            json!(reasoning_effort),
        );
    }
    if let Some(nickname) = registration.nickname.as_deref() {
        meta.insert(CODEX_ACP_AGENT_NICKNAME_KEY.to_string(), json!(nickname));
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

fn subagent_tool_call_id(call_id: &str) -> String {
    format!("{CODEX_ACP_SUBAGENT_TOOL_CALL_ID_PREFIX}{call_id}")
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
    fallback_thread_id: Option<ThreadId>,
) -> Option<String> {
    nickname
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
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
                subagent_display_name(agent.agent_nickname.as_deref(), Some(agent.thread_id))
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
                let display_name =
                    subagent_display_name(entry.agent_nickname.as_deref(), Some(entry.thread_id))
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
        config_types::{ApprovalsReviewer, ServiceTier},
        models::PermissionProfile,
        openai_models::ReasoningEffort,
        protocol::{AskForApproval, SandboxPolicy},
    };

    fn thread_snapshot(parent_thread_id: ThreadId) -> ThreadConfigSnapshot {
        ThreadConfigSnapshot {
            model: "gpt-5.5".to_string(),
            model_provider_id: "openai".to_string(),
            service_tier: Some(ServiceTier::Fast),
            approval_policy: AskForApproval::OnFailure,
            approvals_reviewer: ApprovalsReviewer::default(),
            sandbox_policy: SandboxPolicy::DangerFullAccess,
            permission_profile: PermissionProfile::default(),
            cwd: std::env::current_dir()
                .expect("current dir should be available")
                .try_into()
                .expect("current dir should be absolute"),
            ephemeral: false,
            reasoning_effort: Some(ReasoningEffort::High),
            personality: None,
            session_source: SessionSource::SubAgent(SubAgentSource::ThreadSpawn {
                parent_thread_id,
                depth: 1,
                agent_path: None,
                agent_nickname: Some("Galileo".to_string()),
                agent_role: Some("explorer".to_string()),
            }),
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
        assert!(matches!(
            notification.update,
            SessionUpdate::SessionInfoUpdate(update) if update.title.value().map(String::as_str) == Some("Galileo")
        ));
    }

    #[test]
    fn collab_spawn_events_project_compact_breadcrumbs() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();

        let begin = projection_for_collab_event(&EventMsg::CollabAgentSpawnBegin(
            codex_protocol::protocol::CollabAgentSpawnBeginEvent {
                call_id: "spawn-1".to_string(),
                sender_thread_id: parent_thread_id,
                prompt: "inspect the renderer".to_string(),
                model: "gpt-5.5".to_string(),
                reasoning_effort: ReasoningEffort::Medium,
            },
        ))
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

        let end = projection_for_collab_event(&EventMsg::CollabAgentSpawnEnd(
            codex_protocol::protocol::CollabAgentSpawnEndEvent {
                call_id: "spawn-1".to_string(),
                sender_thread_id: parent_thread_id,
                new_thread_id: Some(child_thread_id),
                new_agent_nickname: Some("Galileo".to_string()),
                new_agent_role: Some("explorer".to_string()),
                prompt: "inspect the renderer".to_string(),
                model: "gpt-5.5".to_string(),
                reasoning_effort: ReasoningEffort::Medium,
                status: AgentStatus::Running,
            },
        ))
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
}
