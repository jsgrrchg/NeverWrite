use std::collections::HashMap;

use agent_client_protocol::schema::{
    Content, Meta, SessionId, SessionInfoUpdate, SessionNotification, SessionUpdate, ToolCall,
    ToolCallContent, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields, ToolKind,
};
use codex_core::ThreadConfigSnapshot;
use codex_protocol::{
    AgentPath, ThreadId,
    items::{
        CollabAgentTool, CollabAgentToolCallItem, CollabAgentToolCallStatus, SubAgentActivityItem,
    },
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
    active_canonical_wait_turn_id: Option<String>,
}

impl SubagentProjectionState {
    fn begin_canonical_wait_turn(&mut self, turn_id: &str) {
        if self.active_canonical_wait_turn_id.as_deref() == Some(turn_id) {
            return;
        }

        if let Some(previous_turn_id) = self.active_canonical_wait_turn_id.replace(turn_id.into()) {
            let previous_turn_prefix = format!("{previous_turn_id}:");
            self.wait_tool_call_ids_by_group
                .retain(|key, _| !key.starts_with(&previous_turn_prefix));
            self.wait_tool_call_ids_by_call
                .retain(|key, _| !key.starts_with(&previous_turn_prefix));
        }
    }

    pub(crate) fn coalesce_wait_projection(
        &mut self,
        event: &EventMsg,
        projection: &mut SubagentProjection,
    ) {
        let stable_tool_call_id = match event {
            EventMsg::CollabWaitingBegin(event) => {
                let group_key = waiting_group_key(
                    "legacy-turn",
                    event.sender_thread_id,
                    event
                        .receiver_thread_ids
                        .iter()
                        .chain(event.receiver_agents.iter().map(|agent| &agent.thread_id)),
                );
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

        set_projection_tool_call_id(projection, stable_tool_call_id);
    }

    pub(crate) fn coalesce_wait_item_projection(
        &mut self,
        turn_id: &str,
        item: &CollabAgentToolCallItem,
        projection: &mut SubagentProjection,
    ) {
        if item.tool != CollabAgentTool::Wait {
            return;
        }

        let call_key = format!("{turn_id}:{}", item.id);
        let stable_tool_call_id = if item.status == CollabAgentToolCallStatus::InProgress {
            self.begin_canonical_wait_turn(turn_id);
            let group_key = waiting_group_key(
                turn_id,
                item.sender_thread_id,
                item.receiver_thread_ids
                    .iter()
                    .chain(item.receiver_agents.iter().map(|agent| &agent.thread_id)),
            );
            let stable_tool_call_id = self
                .wait_tool_call_ids_by_group
                .entry(group_key)
                .or_insert_with(|| subagent_tool_call_id(&item.id))
                .clone();
            self.wait_tool_call_ids_by_call
                .insert(call_key, stable_tool_call_id.clone());
            stable_tool_call_id
        } else {
            self.wait_tool_call_ids_by_call
                .get(&call_key)
                .cloned()
                .unwrap_or_else(|| subagent_tool_call_id(&item.id))
        };

        set_projection_tool_call_id(projection, stable_tool_call_id);
    }
}

fn set_projection_tool_call_id(projection: &mut SubagentProjection, tool_call_id: String) {
    match projection {
        SubagentProjection::ToolCall(tool_call) => {
            tool_call.tool_call_id = tool_call_id.into();
        }
        SubagentProjection::ToolCallUpdate(update) => {
            update.tool_call_id = tool_call_id.into();
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

pub(crate) fn projection_for_collab_item(item: &CollabAgentToolCallItem) -> SubagentProjection {
    let receiver = collab_item_receiver(item);
    let display_name = receiver
        .as_ref()
        .and_then(|receiver| {
            subagent_display_name(receiver.agent_nickname, None, Some(receiver.thread_id))
        })
        .unwrap_or_else(|| "subagent".to_string());
    let in_progress = item.status == CollabAgentToolCallStatus::InProgress;
    let event_type = match (item.tool, in_progress) {
        (CollabAgentTool::SpawnAgent, true) => "spawn_begin",
        (CollabAgentTool::SpawnAgent, false) => "spawn_end",
        (CollabAgentTool::SendInput, true) => "interaction_begin",
        (CollabAgentTool::SendInput, false) => "interaction_end",
        (CollabAgentTool::ResumeAgent, true) => "resume_begin",
        (CollabAgentTool::ResumeAgent, false) => "resume_end",
        (CollabAgentTool::Wait, true) => "waiting_begin",
        (CollabAgentTool::Wait, false) => "waiting_end",
        (CollabAgentTool::CloseAgent, true) => "close_begin",
        (CollabAgentTool::CloseAgent, false) => "close_end",
        (CollabAgentTool::SendMessage, true) => "message_begin",
        (CollabAgentTool::SendMessage, false) => "message_end",
        (CollabAgentTool::FollowupTask, true) => "followup_begin",
        (CollabAgentTool::FollowupTask, false) => "followup_end",
        (CollabAgentTool::InterruptAgent, true) => "interrupt_begin",
        (CollabAgentTool::InterruptAgent, false) => "interrupt_end",
        (CollabAgentTool::ListAgents, true) => "list_agents_begin",
        (CollabAgentTool::ListAgents, false) => "list_agents_end",
    };
    let title = collab_item_title(item, &display_name);
    let detail = collab_item_detail(item);
    let meta = collab_item_breadcrumb_meta(event_type, item, receiver.as_ref());
    let tool_call_id = subagent_tool_call_id(&item.id);

    if in_progress {
        let mut tool_call = ToolCall::new(tool_call_id, title)
            .kind(ToolKind::Other)
            .status(ToolCallStatus::InProgress)
            .raw_input(raw_event(item))
            .meta(meta);
        if let Some(detail) = detail {
            tool_call = tool_call.content(content(Some(detail)));
        }
        SubagentProjection::ToolCall(tool_call)
    } else {
        let mut fields = ToolCallUpdateFields::new()
            .title(title)
            .status(collab_item_tool_status(item))
            .raw_output(raw_event(item));
        if let Some(detail) = detail {
            fields = fields.content(content(Some(detail)));
        }
        SubagentProjection::ToolCallUpdate(ToolCallUpdate::new(tool_call_id, fields).meta(meta))
    }
}

struct CollabItemReceiver<'a> {
    thread_id: ThreadId,
    agent_nickname: Option<&'a str>,
    agent_role: Option<&'a str>,
}

fn collab_item_receiver(item: &CollabAgentToolCallItem) -> Option<CollabItemReceiver<'_>> {
    if item.tool == CollabAgentTool::ListAgents {
        return None;
    }

    item.receiver_agents
        .first()
        .map(|agent| CollabItemReceiver {
            thread_id: agent.thread_id,
            agent_nickname: agent.agent_nickname.as_deref(),
            agent_role: agent.agent_role.as_deref(),
        })
        .or_else(|| {
            item.receiver_thread_ids
                .first()
                .copied()
                .map(|thread_id| CollabItemReceiver {
                    thread_id,
                    agent_nickname: None,
                    agent_role: None,
                })
        })
}

fn collab_item_title(item: &CollabAgentToolCallItem, display_name: &str) -> String {
    let failed = item.status == CollabAgentToolCallStatus::Failed;
    match (item.tool, item.status) {
        (CollabAgentTool::SpawnAgent, CollabAgentToolCallStatus::InProgress) => {
            "Spawning subagent".to_string()
        }
        (CollabAgentTool::SpawnAgent, _) if failed => {
            format!("Failed to spawn {display_name}")
        }
        (CollabAgentTool::SpawnAgent, _) => format!("Spawned {display_name}"),
        (CollabAgentTool::SendInput, CollabAgentToolCallStatus::InProgress) => {
            format!("Contacting {display_name}")
        }
        (CollabAgentTool::SendInput, _) if failed => {
            format!("Failed to contact {display_name}")
        }
        (CollabAgentTool::SendInput, _) => format!("{display_name} responded"),
        (CollabAgentTool::ResumeAgent, CollabAgentToolCallStatus::InProgress) => {
            format!("Resuming {display_name}")
        }
        (CollabAgentTool::ResumeAgent, _) if failed => {
            format!("Failed to resume {display_name}")
        }
        (CollabAgentTool::ResumeAgent, _) => format!("Resumed {display_name}"),
        (CollabAgentTool::Wait, CollabAgentToolCallStatus::InProgress) => {
            "Waiting for subagents".to_string()
        }
        (CollabAgentTool::Wait, _) => waiting_title_for_statuses(&item.agents_states).to_string(),
        (CollabAgentTool::CloseAgent, CollabAgentToolCallStatus::InProgress) => {
            format!("Closing {display_name}")
        }
        (CollabAgentTool::CloseAgent, _) if failed => {
            format!("Failed to close {display_name}")
        }
        (CollabAgentTool::CloseAgent, _) => format!("Closed {display_name}"),
        (CollabAgentTool::SendMessage, CollabAgentToolCallStatus::InProgress) => {
            format!("Messaging {display_name}")
        }
        (CollabAgentTool::SendMessage, _) if failed => {
            format!("Failed to message {display_name}")
        }
        (CollabAgentTool::SendMessage, _) => format!("Messaged {display_name}"),
        (CollabAgentTool::FollowupTask, CollabAgentToolCallStatus::InProgress) => {
            format!("Following up with {display_name}")
        }
        (CollabAgentTool::FollowupTask, _) if failed => {
            format!("Failed to follow up with {display_name}")
        }
        (CollabAgentTool::FollowupTask, _) => format!("Followed up with {display_name}"),
        (CollabAgentTool::InterruptAgent, CollabAgentToolCallStatus::InProgress) => {
            format!("Interrupting {display_name}")
        }
        (CollabAgentTool::InterruptAgent, _) if failed => {
            format!("Failed to interrupt {display_name}")
        }
        (CollabAgentTool::InterruptAgent, _) => format!("Interrupted {display_name}"),
        (CollabAgentTool::ListAgents, CollabAgentToolCallStatus::InProgress) => {
            "Listing agents".to_string()
        }
        (CollabAgentTool::ListAgents, _) if failed => "Failed to list agents".to_string(),
        (CollabAgentTool::ListAgents, _) => "Listed agents".to_string(),
    }
}

fn collab_item_detail(item: &CollabAgentToolCallItem) -> Option<String> {
    if item.tool == CollabAgentTool::Wait {
        if item.agents_states.is_empty() {
            return format_agent_refs(&item.receiver_agents).or_else(|| {
                (!item.receiver_thread_ids.is_empty()).then(|| {
                    item.receiver_thread_ids
                        .iter()
                        .map(ToString::to_string)
                        .collect::<Vec<_>>()
                        .join(", ")
                })
            });
        }
        return format_thread_statuses(&item.agents_states);
    }

    let mut lines = Vec::new();
    if let Some(prompt) = item
        .prompt
        .as_deref()
        .filter(|prompt| !prompt.trim().is_empty())
    {
        lines.push(format!("Prompt: {}", trim_for_detail(prompt)));
    }
    if let Some(model) = item.model.as_deref().filter(|model| !model.is_empty()) {
        lines.push(format!("Model: {model}"));
    }
    if let Some(reasoning_effort) = item.reasoning_effort.as_ref() {
        lines.push(format!(
            "Reasoning effort: {}",
            format_jsonish(reasoning_effort)
        ));
    }
    if !item.agents_states.is_empty()
        && let Some(statuses) = format_thread_statuses(&item.agents_states)
    {
        lines.push(statuses);
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

fn collab_item_tool_status(item: &CollabAgentToolCallItem) -> ToolCallStatus {
    if matches!(
        item.status,
        CollabAgentToolCallStatus::Failed | CollabAgentToolCallStatus::Interrupted
    ) {
        return ToolCallStatus::Failed;
    }

    if item.tool == CollabAgentTool::Wait
        && (item.agents_states.is_empty()
            || !item.agents_states.values().all(is_terminal_agent_status))
    {
        return ToolCallStatus::InProgress;
    }

    ToolCallStatus::Completed
}

fn collab_item_breadcrumb_meta(
    event_type: &str,
    item: &CollabAgentToolCallItem,
    receiver: Option<&CollabItemReceiver<'_>>,
) -> Meta {
    let status = receiver.and_then(|receiver| item.agents_states.get(&receiver.thread_id));
    let mut meta = breadcrumb_meta(
        event_type,
        item.sender_thread_id,
        receiver.map(|receiver| receiver.thread_id),
        receiver.and_then(|receiver| receiver.agent_nickname),
        receiver.and_then(|receiver| receiver.agent_role),
        status,
    );
    if matches!(
        item.tool,
        CollabAgentTool::Wait | CollabAgentTool::ListAgents
    ) && !item.agents_states.is_empty()
    {
        meta.insert(
            CODEX_ACP_AGENT_STATUSES_KEY.to_string(),
            json!(agent_status_values(
                &item.agents_states,
                &item.receiver_agents
            )),
        );
    }
    meta
}

fn project_subagent_activity(
    event: &SubAgentActivityEvent,
    current_thread_id: ThreadId,
    parent_session_id: &SessionId,
) -> Option<SubagentProjection> {
    project_subagent_activity_fields(
        &event.event_id,
        event.kind,
        event.agent_thread_id,
        &event.agent_path,
        current_thread_id,
        parent_session_id,
        event,
    )
}

pub(crate) fn projection_for_subagent_activity_item(
    item: &SubAgentActivityItem,
    current_thread_id: ThreadId,
    parent_session_id: &SessionId,
) -> Option<SubagentProjection> {
    project_subagent_activity_fields(
        &item.id,
        item.kind,
        item.agent_thread_id,
        &item.agent_path,
        current_thread_id,
        parent_session_id,
        item,
    )
}

fn project_subagent_activity_fields(
    activity_id: &str,
    kind: SubAgentActivityKind,
    agent_thread_id: ThreadId,
    agent_path: &AgentPath,
    current_thread_id: ThreadId,
    parent_session_id: &SessionId,
    raw_output: impl Serialize,
) -> Option<SubagentProjection> {
    if agent_thread_id == current_thread_id {
        return None;
    }

    let display_name = agent_path.name();
    let (event_type, title, status, tool_status) = match kind {
        SubAgentActivityKind::Started => (
            "activity_started",
            format!("Started {display_name}"),
            "running",
            ToolCallStatus::InProgress,
        ),
        SubAgentActivityKind::Interacted => (
            "activity_interacted",
            format!("Contacted {display_name}"),
            "running",
            ToolCallStatus::InProgress,
        ),
        SubAgentActivityKind::Interrupted => (
            "activity_interrupted",
            format!("Interrupted {display_name}"),
            "interrupted",
            ToolCallStatus::Failed,
        ),
        SubAgentActivityKind::Completed => (
            "activity_completed",
            format!("Completed {display_name}"),
            "completed",
            ToolCallStatus::Completed,
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
        json!(agent_thread_id.to_string()),
    );
    meta.insert(
        CODEX_ACP_CHILD_THREAD_ID_KEY.to_string(),
        json!(agent_thread_id.to_string()),
    );
    meta.insert(CODEX_ACP_AGENT_PATH_KEY.to_string(), json!(agent_path));
    meta.insert(CODEX_ACP_AGENT_STATUS_KEY.to_string(), json!(status));

    Some(SubagentProjection::ToolCall(
        ToolCall::new(subagent_activity_tool_call_id(activity_id), title)
            .kind(ToolKind::Other)
            .status(tool_status)
            .content(content(Some(format!("Agent: {agent_path}"))))
            .raw_output(raw_event(raw_output))
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

fn waiting_group_key<'a>(
    turn_id: &str,
    sender_thread_id: ThreadId,
    receiver_thread_ids: impl Iterator<Item = &'a ThreadId>,
) -> String {
    let mut receiver_thread_ids = receiver_thread_ids
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    receiver_thread_ids.sort();
    receiver_thread_ids.dedup();

    if receiver_thread_ids.is_empty() {
        format!("{turn_id}:{sender_thread_id}:all")
    } else {
        format!(
            "{turn_id}:{sender_thread_id}:{}",
            receiver_thread_ids.join(",")
        )
    }
}

fn waiting_end_title(event: &codex_protocol::protocol::CollabWaitingEndEvent) -> &'static str {
    waiting_title(waiting_end_agent_statuses(event).into_iter())
}

fn waiting_title_for_statuses(statuses: &HashMap<ThreadId, AgentStatus>) -> &'static str {
    waiting_title(statuses.values())
}

fn waiting_title<'a>(statuses: impl Iterator<Item = &'a AgentStatus>) -> &'static str {
    let statuses = statuses.collect::<Vec<_>>();
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
    matches!(
        status,
        AgentStatus::Completed(_)
            | AgentStatus::Errored(_)
            | AgentStatus::Shutdown
            | AgentStatus::NotFound
    )
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

fn agent_status_values(
    statuses: &HashMap<ThreadId, AgentStatus>,
    agents: &[CollabAgentRef],
) -> Vec<serde_json::Value> {
    let mut values = statuses
        .iter()
        .map(|(thread_id, status)| {
            let agent = agents.iter().find(|agent| agent.thread_id == *thread_id);
            json!({
                "codexAcpChildSessionId": thread_id.to_string(),
                "codexAcpChildThreadId": thread_id.to_string(),
                "codexAcpAgentNickname": agent.and_then(|agent| agent.agent_nickname.as_deref()),
                "codexAcpAgentRole": agent.and_then(|agent| agent.agent_role.as_deref()),
                "codexAcpAgentStatus": status,
            })
        })
        .collect::<Vec<_>>();
    values.sort_by(|left, right| {
        left.get(CODEX_ACP_CHILD_THREAD_ID_KEY)
            .and_then(serde_json::Value::as_str)
            .cmp(
                &right
                    .get(CODEX_ACP_CHILD_THREAD_ID_KEY)
                    .and_then(serde_json::Value::as_str),
            )
    });
    values
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

        for (kind, event_type, status, title, tool_status) in [
            (
                SubAgentActivityKind::Started,
                "activity_started",
                "running",
                "Started explorer",
                ToolCallStatus::InProgress,
            ),
            (
                SubAgentActivityKind::Interacted,
                "activity_interacted",
                "running",
                "Contacted explorer",
                ToolCallStatus::InProgress,
            ),
            (
                SubAgentActivityKind::Interrupted,
                "activity_interrupted",
                "interrupted",
                "Interrupted explorer",
                ToolCallStatus::Failed,
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
            assert_eq!(tool_call.status, tool_status);
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
    fn canonical_collab_item_projects_navigable_spawn_breadcrumbs() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let begin_item = CollabAgentToolCallItem {
            id: "spawn-canonical".to_string(),
            tool: CollabAgentTool::SpawnAgent,
            status: CollabAgentToolCallStatus::InProgress,
            sender_thread_id: parent_thread_id,
            receiver_thread_ids: Vec::new(),
            receiver_agents: Vec::new(),
            prompt: Some("inspect the renderer".to_string()),
            model: Some("gpt-5.5".to_string()),
            reasoning_effort: Some(ReasoningEffort::Medium),
            agents_states: HashMap::new(),
        };
        let SubagentProjection::ToolCall(begin) = projection_for_collab_item(&begin_item) else {
            panic!("canonical spawn start should create a tool call");
        };
        assert_eq!(begin.title, "Spawning subagent");
        assert_eq!(
            begin.tool_call_id.0.as_ref(),
            "codex-acp:subagent:spawn-canonical"
        );
        assert!(
            begin
                .meta
                .as_ref()
                .is_some_and(|meta| !meta.contains_key(CODEX_ACP_CHILD_THREAD_ID_KEY))
        );

        let completed_item = CollabAgentToolCallItem {
            status: CollabAgentToolCallStatus::Completed,
            receiver_thread_ids: vec![child_thread_id],
            receiver_agents: vec![CollabAgentRef {
                thread_id: child_thread_id,
                agent_nickname: Some("Galileo".to_string()),
                agent_role: Some("explorer".to_string()),
            }],
            agents_states: HashMap::from([(child_thread_id, AgentStatus::Running)]),
            ..begin_item
        };
        let SubagentProjection::ToolCallUpdate(completed) =
            projection_for_collab_item(&completed_item)
        else {
            panic!("canonical spawn completion should update the tool call");
        };
        assert_eq!(
            completed.tool_call_id.0.as_ref(),
            "codex-acp:subagent:spawn-canonical"
        );
        assert_eq!(completed.fields.title.as_deref(), Some("Spawned Galileo"));
        assert_eq!(completed.fields.status, Some(ToolCallStatus::Completed));
        assert_eq!(
            completed
                .meta
                .as_ref()
                .and_then(|meta| meta.get(CODEX_ACP_CHILD_THREAD_ID_KEY))
                .and_then(serde_json::Value::as_str),
            Some(child_thread_id.to_string().as_str())
        );
    }

    #[test]
    fn expanded_collaboration_tools_project_stable_and_distinct_lifecycles() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let item = |id: &str, tool, status| CollabAgentToolCallItem {
            id: id.to_string(),
            tool,
            status,
            sender_thread_id: parent_thread_id,
            receiver_thread_ids: vec![child_thread_id],
            receiver_agents: vec![CollabAgentRef {
                thread_id: child_thread_id,
                agent_nickname: Some("Galileo".to_string()),
                agent_role: Some("explorer".to_string()),
            }],
            prompt: Some("private coordination payload".to_string()),
            model: None,
            reasoning_effort: None,
            agents_states: HashMap::from([(child_thread_id, AgentStatus::Running)]),
        };

        for (tool, expected_begin, expected_end, end_status, expected_event) in [
            (
                CollabAgentTool::SendMessage,
                "Messaging Galileo",
                "Messaged Galileo",
                CollabAgentToolCallStatus::Completed,
                "message_end",
            ),
            (
                CollabAgentTool::FollowupTask,
                "Following up with Galileo",
                "Followed up with Galileo",
                CollabAgentToolCallStatus::Completed,
                "followup_end",
            ),
            (
                CollabAgentTool::InterruptAgent,
                "Interrupting Galileo",
                "Interrupted Galileo",
                CollabAgentToolCallStatus::Interrupted,
                "interrupt_end",
            ),
            (
                CollabAgentTool::ListAgents,
                "Listing agents",
                "Listed agents",
                CollabAgentToolCallStatus::Completed,
                "list_agents_end",
            ),
        ] {
            let id = format!("{tool:?}");
            let SubagentProjection::ToolCall(begin) =
                projection_for_collab_item(&item(&id, tool, CollabAgentToolCallStatus::InProgress))
            else {
                panic!("{tool:?} begin should create a tool call");
            };
            let SubagentProjection::ToolCallUpdate(end) =
                projection_for_collab_item(&item(&id, tool, end_status))
            else {
                panic!("{tool:?} end should update a tool call");
            };

            assert_eq!(begin.tool_call_id, end.tool_call_id);
            assert_eq!(begin.title, expected_begin);
            assert_eq!(end.fields.title.as_deref(), Some(expected_end));
            assert_eq!(
                end.fields.status,
                Some(if tool == CollabAgentTool::InterruptAgent {
                    ToolCallStatus::Failed
                } else {
                    ToolCallStatus::Completed
                })
            );
            assert_eq!(
                end.meta
                    .as_ref()
                    .and_then(|meta| meta.get(CODEX_ACP_SUBAGENT_EVENT_TYPE_KEY))
                    .and_then(serde_json::Value::as_str),
                Some(expected_event)
            );
            if tool == CollabAgentTool::ListAgents {
                assert!(
                    end.meta
                        .as_ref()
                        .is_some_and(|meta| !meta.contains_key(CODEX_ACP_CHILD_THREAD_ID_KEY))
                );
                assert!(
                    end.meta
                        .as_ref()
                        .is_some_and(|meta| meta.contains_key(CODEX_ACP_AGENT_STATUSES_KEY))
                );
            }
        }
    }

    #[test]
    fn completed_activity_is_a_terminal_projection_with_runtime_identity() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let parent_session_id = SessionId::new(parent_thread_id.to_string());
        let item = SubAgentActivityItem {
            id: "activity-1".to_string(),
            kind: SubAgentActivityKind::Completed,
            agent_thread_id: child_thread_id,
            agent_path: "/root/research/explorer"
                .try_into()
                .expect("valid agent path"),
        };

        let Some(SubagentProjection::ToolCall(projection)) =
            projection_for_subagent_activity_item(&item, parent_thread_id, &parent_session_id)
        else {
            panic!("completed activity should project");
        };
        assert_eq!(
            projection.tool_call_id.0.as_ref(),
            "codex-acp:subagent:activity-1"
        );
        assert_eq!(projection.title, "Completed explorer");
        assert_eq!(projection.status, ToolCallStatus::Completed);
        assert_eq!(
            projection
                .meta
                .as_ref()
                .and_then(|meta| meta.get(CODEX_ACP_CHILD_THREAD_ID_KEY))
                .and_then(serde_json::Value::as_str),
            Some(child_thread_id.to_string().as_str())
        );
    }

    #[test]
    fn canonical_waits_coalesce_only_within_the_same_turn() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let mut state = SubagentProjectionState::default();
        let wait_item = |id: &str| CollabAgentToolCallItem {
            id: id.to_string(),
            tool: CollabAgentTool::Wait,
            status: CollabAgentToolCallStatus::InProgress,
            sender_thread_id: parent_thread_id,
            receiver_thread_ids: vec![child_thread_id],
            receiver_agents: Vec::new(),
            prompt: None,
            model: None,
            reasoning_effort: None,
            agents_states: HashMap::new(),
        };
        let project = |state: &mut SubagentProjectionState, turn_id: &str, item| {
            let mut projection = projection_for_collab_item(&item);
            state.coalesce_wait_item_projection(turn_id, &item, &mut projection);
            let SubagentProjection::ToolCall(tool_call) = projection else {
                panic!("wait start should create a tool call");
            };
            tool_call.tool_call_id.to_string()
        };

        let first = project(&mut state, "turn-1", wait_item("wait-1"));
        let equivalent = project(&mut state, "turn-1", wait_item("wait-2"));
        let next_turn = project(&mut state, "turn-2", wait_item("wait-3"));

        assert_eq!(first, equivalent);
        assert_ne!(first, next_turn);
        assert!(
            state
                .wait_tool_call_ids_by_group
                .keys()
                .all(|key| !key.starts_with("turn-1:"))
        );
        assert!(
            state
                .wait_tool_call_ids_by_call
                .keys()
                .all(|key| !key.starts_with("turn-1:"))
        );
    }

    #[test]
    fn canonical_wait_pruning_preserves_legacy_correlations() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let parent_session_id = SessionId::new(parent_thread_id.to_string());
        let mut state = SubagentProjectionState::default();
        let legacy_begin =
            EventMsg::CollabWaitingBegin(codex_protocol::protocol::CollabWaitingBeginEvent {
                sender_thread_id: parent_thread_id,
                receiver_thread_ids: vec![child_thread_id],
                receiver_agents: Vec::new(),
                call_id: "legacy-wait".to_string(),
                started_at_ms: 0,
            });
        let mut legacy_projection =
            projection_for_event(&legacy_begin, parent_thread_id, &parent_session_id)
                .expect("legacy wait begin should project");
        state.coalesce_wait_projection(&legacy_begin, &mut legacy_projection);
        let SubagentProjection::ToolCall(legacy_tool_call) = legacy_projection else {
            panic!("legacy wait begin should create a tool call");
        };
        let legacy_tool_call_id = legacy_tool_call.tool_call_id.to_string();

        for (turn_id, item_id) in [("turn-1", "wait-1"), ("turn-2", "wait-2")] {
            let item = CollabAgentToolCallItem {
                id: item_id.to_string(),
                tool: CollabAgentTool::Wait,
                status: CollabAgentToolCallStatus::InProgress,
                sender_thread_id: parent_thread_id,
                receiver_thread_ids: vec![child_thread_id],
                receiver_agents: Vec::new(),
                prompt: None,
                model: None,
                reasoning_effort: None,
                agents_states: HashMap::new(),
            };
            let mut projection = projection_for_collab_item(&item);
            state.coalesce_wait_item_projection(turn_id, &item, &mut projection);
        }

        let legacy_end =
            EventMsg::CollabWaitingEnd(codex_protocol::protocol::CollabWaitingEndEvent {
                sender_thread_id: parent_thread_id,
                call_id: "legacy-wait".to_string(),
                agent_statuses: Vec::new(),
                statuses: HashMap::new(),
                completed_at_ms: 0,
            });
        let mut legacy_projection =
            projection_for_event(&legacy_end, parent_thread_id, &parent_session_id)
                .expect("legacy wait end should project");
        state.coalesce_wait_projection(&legacy_end, &mut legacy_projection);
        let SubagentProjection::ToolCallUpdate(legacy_update) = legacy_projection else {
            panic!("legacy wait end should update a tool call");
        };

        assert_eq!(legacy_update.tool_call_id.to_string(), legacy_tool_call_id);
        assert!(
            state
                .wait_tool_call_ids_by_group
                .keys()
                .any(|key| key.starts_with("legacy-turn:"))
        );
        assert!(state.wait_tool_call_ids_by_call.contains_key("legacy-wait"));
    }

    #[test]
    fn only_final_agent_states_terminalize_waits() {
        let parent_thread_id = ThreadId::new();
        let child_thread_id = ThreadId::new();
        let wait_with_status = |status| CollabAgentToolCallItem {
            id: format!("wait-{status:?}"),
            tool: CollabAgentTool::Wait,
            status: CollabAgentToolCallStatus::Completed,
            sender_thread_id: parent_thread_id,
            receiver_thread_ids: vec![child_thread_id],
            receiver_agents: Vec::new(),
            prompt: None,
            model: None,
            reasoning_effort: None,
            agents_states: HashMap::from([(child_thread_id, status)]),
        };

        for status in [
            AgentStatus::Completed(None),
            AgentStatus::Errored("failed".to_string()),
            AgentStatus::Shutdown,
            AgentStatus::NotFound,
        ] {
            let SubagentProjection::ToolCallUpdate(update) =
                projection_for_collab_item(&wait_with_status(status))
            else {
                panic!("completed wait should update a tool call");
            };
            assert!(matches!(
                update.fields.status,
                Some(ToolCallStatus::Completed | ToolCallStatus::Failed)
            ));
        }

        for status in [
            AgentStatus::PendingInit,
            AgentStatus::Running,
            AgentStatus::Interrupted,
        ] {
            let SubagentProjection::ToolCallUpdate(update) =
                projection_for_collab_item(&wait_with_status(status))
            else {
                panic!("wait result should update a tool call");
            };
            assert_eq!(update.fields.status, Some(ToolCallStatus::InProgress));
        }

        let failed_wait_without_states = CollabAgentToolCallItem {
            id: "wait-failed-empty".to_string(),
            tool: CollabAgentTool::Wait,
            status: CollabAgentToolCallStatus::Failed,
            sender_thread_id: parent_thread_id,
            receiver_thread_ids: vec![child_thread_id],
            receiver_agents: Vec::new(),
            prompt: None,
            model: None,
            reasoning_effort: None,
            agents_states: HashMap::new(),
        };
        let SubagentProjection::ToolCallUpdate(update) =
            projection_for_collab_item(&failed_wait_without_states)
        else {
            panic!("failed wait should update a tool call");
        };
        assert_eq!(update.fields.status, Some(ToolCallStatus::Failed));
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

        let project_begin = |state: &mut SubagentProjectionState,
                             sender_thread_id,
                             call_id: &str,
                             receiver_thread_ids| {
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
            &mut state,
            parent_thread_id,
            "wait-1",
            vec![first_child_thread_id, second_child_thread_id],
        );
        let repeated = project_begin(
            &mut state,
            parent_thread_id,
            "wait-2",
            vec![
                second_child_thread_id,
                first_child_thread_id,
                first_child_thread_id,
            ],
        );
        let different_group = project_begin(
            &mut state,
            parent_thread_id,
            "wait-3",
            vec![first_child_thread_id],
        );
        let different_parent = project_begin(
            &mut state,
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

        let first_end =
            EventMsg::CollabWaitingEnd(codex_protocol::protocol::CollabWaitingEndEvent {
                sender_thread_id: parent_thread_id,
                call_id: "wait-1".to_string(),
                agent_statuses: Vec::new(),
                statuses: HashMap::new(),
                completed_at_ms: 0,
            });
        let mut projection = projection_for_event(&first_end, parent_thread_id, &parent_session_id)
            .expect("waiting end should project");
        state.coalesce_wait_projection(&first_end, &mut projection);

        let next_cycle = project_begin(
            &mut state,
            parent_thread_id,
            "wait-next-cycle",
            vec![first_child_thread_id, second_child_thread_id],
        );
        assert_eq!(
            next_cycle, first,
            "equivalent waits remain coalesced for the owning turn"
        );

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
