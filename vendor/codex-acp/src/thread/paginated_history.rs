//! ACP replay of the store's display history, independent of its model-context suffix.

use codex_app_server_protocol::{
    DynamicToolCallOutputContentItem, PatchChangeKind, ThreadItem, UserInput as StoredUserInput,
};
use codex_thread_store::StoredThreadItem;

use super::*;

impl<A: Auth> ThreadActor<A> {
    pub(super) async fn handle_replay_stored_history(
        &mut self,
        items: Vec<StoredThreadItem>,
    ) -> Result<(), Error> {
        // Validate the whole page before emitting any of it. Never decode this
        // app-server display schema as Core's differently shaped TurnItem.
        let items = items
            .into_iter()
            .map(|stored| {
                serde_json::from_slice::<ThreadItem>(&stored.item_json)
                    .map(|item| (stored, item))
                    .map_err(Error::into_internal_error)
            })
            .collect::<Result<Vec<_>, _>>()?;
        for (stored, item) in items {
            let (turn_id, mut projection) = self
                .stored_history_projection
                .take()
                .filter(|(turn_id, _)| *turn_id == stored.turn_id)
                .unwrap_or_else(|| {
                    (
                        stored.turn_id.clone(),
                        PromptState::projection(
                            stored.turn_id.clone(),
                            self.thread.clone(),
                            self.resolution_tx.clone(),
                        ),
                    )
                });
            let result = self.replay_stored_item(stored, item, &mut projection).await;
            self.stored_history_projection = Some((turn_id, projection));
            result?;
        }
        Ok(())
    }

    async fn replay_stored_item(
        &mut self,
        stored: StoredThreadItem,
        item: ThreadItem,
        projection: &mut PromptState,
    ) -> Result<(), Error> {
        let raw = serde_json::to_value(&item).map_err(Error::into_internal_error)?;
        let id = item.id().to_string();
        let mut content = Vec::new();
        let mut locations = Vec::new();
        let mut meta = neverwrite_activity_started_at_meta(stored.started_at_ms);
        let status = match raw.get("status").and_then(serde_json::Value::as_str) {
            Some("inProgress") => ToolCallStatus::InProgress,
            Some("failed" | "declined" | "interrupted") => ToolCallStatus::Failed,
            _ => ToolCallStatus::Completed,
        };
        let (title, kind, call_id) = match item {
            ThreadItem::UserMessage { content, .. } => {
                let text = content
                    .into_iter()
                    .filter_map(|input| match input {
                        StoredUserInput::Text { text, .. } => Some(text),
                        _ => None,
                    })
                    .join("\n");
                self.client.send_user_message(text).await;
                return Ok(());
            }
            ThreadItem::AgentMessage { text, .. } => {
                self.client.send_agent_text(text).await;
                return Ok(());
            }
            ThreadItem::Reasoning {
                summary, content, ..
            } => {
                for text in if summary.is_empty() { content } else { summary } {
                    self.client.send_agent_thought(text).await;
                }
                return Ok(());
            }
            ThreadItem::FunctionCallOutput { .. } => return Ok(()),
            ThreadItem::Plan { text, .. } => {
                projection
                    .emit_plan_text_update(&self.client, &text, false)
                    .await;
                return Ok(());
            }
            ThreadItem::ImageGeneration(image) => {
                self.client
                    .send_tool_call(completed_image_generation_tool_call(
                        image.id,
                        image.status,
                        image.revised_prompt,
                        image.result,
                        image.saved_path.map(|path| path.display().to_string()),
                        image.failure,
                    ))
                    .await;
                return Ok(());
            }
            ThreadItem::CommandExecution {
                command,
                aggregated_output,
                ..
            } => {
                if let Some(output) = aggregated_output {
                    content.push(ToolCallContent::Content(Content::new(output)));
                }
                (command, ToolKind::Execute, id)
            }
            ThreadItem::FileChange { changes, .. } => {
                for change in changes {
                    let path = PathBuf::from(change.path);
                    let target = match &change.kind {
                        PatchChangeKind::Update {
                            move_path: Some(path),
                        } => path.clone(),
                        _ => path.clone(),
                    };
                    locations.push(ToolCallLocation::new(target));
                    match change.kind {
                        PatchChangeKind::Add => {
                            content.extend(extract_tool_call_content_from_change(
                                path,
                                FileChange::Add {
                                    content: change.diff,
                                },
                            ))
                        }
                        PatchChangeKind::Delete => {
                            content.extend(extract_tool_call_content_from_change(
                                path,
                                FileChange::Delete {
                                    content: change.diff,
                                },
                            ))
                        }
                        PatchChangeKind::Update { move_path } => {
                            // Display storage appends a move annotation to the unified diff.
                            let diff = match &move_path {
                                Some(path) => change
                                    .diff
                                    .strip_suffix(&format!("\n\nMoved to: {}", path.display()))
                                    .unwrap_or(&change.diff)
                                    .to_string(),
                                None => change.diff,
                            };
                            content.extend(extract_tool_call_content_from_unified_diff(
                                path, move_path, diff,
                            ))
                        }
                    }
                }
                ("Edit files".to_string(), ToolKind::Edit, id)
            }
            ThreadItem::McpToolCall {
                server,
                tool,
                result,
                error,
                ..
            } => {
                if let Some(result) = result {
                    content.extend(
                        result
                            .content
                            .into_iter()
                            .filter_map(|value| serde_json::from_value::<ContentBlock>(value).ok())
                            .map(|block| ToolCallContent::Content(Content::new(block))),
                    );
                }
                if let Some(error) = error {
                    content.push(ToolCallContent::Content(Content::new(error.message)));
                }
                (format!("{server}: {tool}"), ToolKind::Other, id)
            }
            ThreadItem::DynamicToolCall {
                tool,
                content_items,
                ..
            } => {
                content.extend(content_items.unwrap_or_default().into_iter().map(
                    |item| match item {
                        DynamicToolCallOutputContentItem::InputText { text } => {
                            ToolCallContent::Content(Content::new(text))
                        }
                        DynamicToolCallOutputContentItem::InputImage { image_url } => {
                            ToolCallContent::Content(Content::new(ContentBlock::ResourceLink(
                                ResourceLink::new("Image output", image_url),
                            )))
                        }
                        DynamicToolCallOutputContentItem::InputAudio { audio_url } => {
                            ToolCallContent::Content(Content::new(ContentBlock::ResourceLink(
                                ResourceLink::new("Audio output", audio_url),
                            )))
                        }
                    },
                ));
                (tool, ToolKind::Other, id)
            }
            ThreadItem::SubAgentActivity {
                kind,
                agent_thread_id,
                agent_path,
                ..
            } => {
                let thread_id =
                    ThreadId::from_string(&agent_thread_id).map_err(Error::into_internal_error)?;
                let core = codex_protocol::items::SubAgentActivityItem {
                    id,
                    kind: match kind {
                        codex_app_server_protocol::SubAgentActivityKind::Started => {
                            codex_protocol::protocol::SubAgentActivityKind::Started
                        }
                        codex_app_server_protocol::SubAgentActivityKind::Interacted => {
                            codex_protocol::protocol::SubAgentActivityKind::Interacted
                        }
                        codex_app_server_protocol::SubAgentActivityKind::Interrupted => {
                            codex_protocol::protocol::SubAgentActivityKind::Interrupted
                        }
                        codex_app_server_protocol::SubAgentActivityKind::Completed => {
                            codex_protocol::protocol::SubAgentActivityKind::Completed
                        }
                    },
                    agent_thread_id: thread_id,
                    agent_path: serde_json::from_value(json!(agent_path))
                        .map_err(Error::into_internal_error)?,
                };
                projection
                    .complete_turn_item(
                        &self.client,
                        &stored.turn_id,
                        &TurnItem::SubAgentActivity(core),
                        stored.started_at_ms,
                    )
                    .await;
                return Ok(());
            }
            ThreadItem::CollabAgentToolCall {
                tool,
                status,
                sender_thread_id,
                receiver_thread_ids,
                prompt,
                model,
                reasoning_effort,
                agents_states,
                ..
            } => {
                use codex_app_server_protocol::{
                    CollabAgentStatus as AppAgentStatus, CollabAgentTool as AppTool,
                    CollabAgentToolCallStatus as AppStatus,
                };
                use codex_protocol::items::{
                    CollabAgentTool as CoreTool, CollabAgentToolCallItem,
                    CollabAgentToolCallStatus as CoreStatus,
                };
                use codex_protocol::protocol::AgentStatus;
                let parse_id =
                    |id: &str| ThreadId::from_string(id).map_err(Error::into_internal_error);
                let core = CollabAgentToolCallItem {
                    id,
                    tool: match tool {
                        AppTool::SpawnAgent => CoreTool::SpawnAgent,
                        AppTool::SendInput => CoreTool::SendInput,
                        AppTool::ResumeAgent => CoreTool::ResumeAgent,
                        AppTool::Wait => CoreTool::Wait,
                        AppTool::CloseAgent => CoreTool::CloseAgent,
                        AppTool::SendMessage => CoreTool::SendMessage,
                        AppTool::FollowupTask => CoreTool::FollowupTask,
                        AppTool::InterruptAgent => CoreTool::InterruptAgent,
                        AppTool::ListAgents => CoreTool::ListAgents,
                    },
                    status: match status {
                        AppStatus::InProgress => CoreStatus::InProgress,
                        AppStatus::Completed => CoreStatus::Completed,
                        AppStatus::Failed => CoreStatus::Failed,
                        AppStatus::Interrupted => CoreStatus::Interrupted,
                    },
                    sender_thread_id: parse_id(&sender_thread_id)?,
                    receiver_thread_ids: receiver_thread_ids
                        .iter()
                        .map(|id| parse_id(id))
                        .collect::<Result<_, _>>()?,
                    // Persisted display items contain IDs, but no Core receiver descriptors.
                    receiver_agents: Vec::new(),
                    prompt,
                    model,
                    reasoning_effort,
                    agents_states: agents_states
                        .into_iter()
                        .map(|(id, state)| {
                            Ok((
                                parse_id(&id)?,
                                match state.status {
                                    AppAgentStatus::PendingInit => AgentStatus::PendingInit,
                                    AppAgentStatus::Running => AgentStatus::Running,
                                    AppAgentStatus::Interrupted => AgentStatus::Interrupted,
                                    AppAgentStatus::Completed => {
                                        AgentStatus::Completed(state.message)
                                    }
                                    AppAgentStatus::Errored => {
                                        AgentStatus::Errored(state.message.unwrap_or_default())
                                    }
                                    AppAgentStatus::Shutdown => AgentStatus::Shutdown,
                                    AppAgentStatus::NotFound => AgentStatus::NotFound,
                                },
                            ))
                        })
                        .collect::<Result<_, Error>>()?,
                };
                if core.tool == CoreTool::Wait && core.status != CoreStatus::InProgress {
                    // Storage retains only the latest item, so its begin event is
                    // absent. Seed the same coalescing group without emitting an
                    // invented begin activity to the client.
                    let mut begin = core.clone();
                    begin.status = CoreStatus::InProgress;
                    let mut begin_projection = subagents::projection_for_collab_item(&begin);
                    projection
                        .subagent_projection_state
                        .coalesce_wait_item_projection(
                            &stored.turn_id,
                            &begin,
                            &mut begin_projection,
                        );
                }
                projection
                    .complete_turn_item(
                        &self.client,
                        &stored.turn_id,
                        &TurnItem::CollabAgentToolCall(core),
                        stored.started_at_ms,
                    )
                    .await;
                return Ok(());
            }
            ThreadItem::WebSearch(item) => (item.query, ToolKind::Fetch, id),
            ThreadItem::ImageView { path, .. } => (path.to_string(), ToolKind::Read, id),
            ThreadItem::Sleep(_) => {
                merge_tool_call_meta(
                    &mut meta,
                    Some(neverwrite_status_meta("item_activity", "neutral")),
                );
                (
                    "Waiting".to_string(),
                    ToolKind::Other,
                    format!("{NEVERWRITE_STATUS_EVENT_ID_PREFIX}item:{id}"),
                )
            }
            ThreadItem::HookPrompt { .. } => return Ok(()),
            ThreadItem::EnteredReviewMode { review, .. }
            | ThreadItem::ExitedReviewMode { review, .. } => {
                self.client.send_agent_text(review).await;
                return Ok(());
            }
            ThreadItem::ContextCompaction { .. } => return Ok(()),
        };
        let mut call = ToolCall::new(call_id, title)
            .kind(kind)
            .status(status)
            .locations(locations)
            .content(content)
            .raw_input(raw);
        call.meta = meta;
        self.client.send_tool_call(call).await;
        Ok(())
    }
}
