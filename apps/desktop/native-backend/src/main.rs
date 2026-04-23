use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::{
    mpsc::{self, Sender},
    Arc, Mutex,
};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

mod ai;
mod devtools;
mod spellcheck;

use ai::NativeAi;
use devtools::DevTerminalManager;
use neverwrite_ai::persistence::{
    self, PersistedSessionHistory, PersistedSessionHistoryPage, SessionSearchResult,
};
use neverwrite_index::VaultIndex;
use neverwrite_types::{
    AdvancedSearchParams, BacklinkDto, NoteDetailDto, NoteDocument, NoteDto, NoteId, NoteMetadata,
    ResolvedWikilinkDto, SearchResultDto, VaultEntryDto, VaultNoteChangeDto, VaultOpenMetricsDto,
    VaultOpenStateDto, WikilinkSuggestionDto,
};
use neverwrite_vault::{start_watcher, ScopedPathIntent, Vault, VaultEvent, WriteTracker};
use notify::RecommendedWatcher;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use spellcheck::SpellcheckState;

const VAULT_CHANGE_ORIGIN_USER: &str = "user";
const VAULT_CHANGE_ORIGIN_AGENT: &str = "agent";
const VAULT_CHANGE_ORIGIN_EXTERNAL: &str = "external";

#[derive(Debug, Deserialize)]
struct RpcRequest {
    id: Value,
    command: String,
    #[serde(default)]
    args: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "type")]
pub(crate) enum RpcOutput {
    #[serde(rename = "response")]
    Response {
        id: Value,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    #[serde(rename = "event")]
    Event {
        #[serde(rename = "eventName")]
        event_name: String,
        payload: Value,
    },
}

#[derive(Debug, Serialize)]
struct VaultFileDetail {
    path: String,
    relative_path: String,
    file_name: String,
    mime_type: Option<String>,
    content: String,
    size_bytes: u64,
    content_truncated: bool,
}

#[derive(Debug, Serialize)]
struct SavedBinaryFileDetail {
    path: String,
    relative_path: String,
    file_name: String,
    mime_type: Option<String>,
}

#[derive(Debug, Serialize)]
struct MapEntryDto {
    id: String,
    title: String,
    relative_path: String,
}

#[derive(Debug, Serialize)]
struct TagDto {
    tag: String,
    note_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ComputeLineDiffInput {
    #[serde(rename = "oldText", alias = "old_text")]
    old_text: String,
    #[serde(rename = "newText", alias = "new_text")]
    new_text: String,
}

struct VaultRuntimeState {
    vault: Vault,
    index: VaultIndex,
    entries: Vec<VaultEntryDto>,
    open_state: VaultOpenStateDto,
    graph_revision: u64,
    note_revisions: HashMap<String, u64>,
    file_revisions: HashMap<String, u64>,
    write_tracker: WriteTracker,
    _watcher: Option<RecommendedWatcher>,
}

struct NativeBackend {
    vaults: HashMap<String, VaultRuntimeState>,
    ai: NativeAi,
    devtools: DevTerminalManager,
    spellcheck: SpellcheckState,
    event_tx: Sender<RpcOutput>,
}

impl NativeBackend {
    fn new(event_tx: Sender<RpcOutput>) -> Self {
        Self {
            vaults: HashMap::new(),
            ai: NativeAi::new(event_tx.clone()),
            devtools: DevTerminalManager::new(event_tx.clone()),
            spellcheck: SpellcheckState::new(),
            event_tx,
        }
    }
}

impl NativeBackend {
    fn invoke(
        &mut self,
        command: &str,
        args: Value,
        backend_ref: &Arc<Mutex<NativeBackend>>,
    ) -> Result<Value, String> {
        match command {
            "ping" => Ok(json!({ "ok": true })),
            "debug_set_timing" => Ok(json!(null)),
            "open_vault" => {
                let path = required_string(&args, &["path"])?;
                self.open_vault(path.clone(), backend_ref)?;
                self.invoke("list_notes", json!({ "vaultPath": path }), backend_ref)
            }
            "start_open_vault" => {
                let path = required_string(&args, &["path"])?;
                self.open_vault(path, backend_ref)?;
                Ok(json!(null))
            }
            "cancel_open_vault" => {
                let vault_path = required_string(&args, &["vaultPath", "vault_path"])?;
                let root = normalize_vault_path(&vault_path)?;
                let state = self
                    .vaults
                    .entry(root.clone())
                    .or_insert_with(|| cancelled_placeholder_state(root.clone()));
                state.open_state.stage = "cancelled".to_string();
                state.open_state.message = "Opening cancelled".to_string();
                state.open_state.cancelled = true;
                state.open_state.finished_at_ms = Some(now_ms());
                Ok(json!(null))
            }
            "get_vault_open_state" => {
                let vault_path = required_string(&args, &["vaultPath", "vault_path"])?;
                let root = normalize_vault_path(&vault_path)?;
                Ok(json!(self
                    .vaults
                    .get(&root)
                    .map(|state| { state.open_state.clone() })
                    .unwrap_or_else(idle_open_state)))
            }
            "list_notes" => {
                let state = self.state(&args)?;
                let mut notes: Vec<NoteDto> =
                    state.index.metadata.values().map(note_to_dto).collect();
                notes.sort_by(|left, right| left.id.cmp(&right.id));
                Ok(json!(notes))
            }
            "get_graph_revision" => {
                let state = self.state(&args)?;
                Ok(json!(state.graph_revision.max(1)))
            }
            "list_vault_entries" => {
                let state = self.state(&args)?;
                Ok(json!(state.entries))
            }
            "read_vault_entry" => {
                let state = self.state(&args)?;
                let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
                let path = state
                    .vault
                    .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
                    .map_err(|error| error.to_string())?;
                Ok(json!(state
                    .vault
                    .read_vault_entry_from_path(&path)
                    .map_err(|error| error.to_string())?))
            }
            "read_vault_file" => {
                let state = self.state(&args)?;
                let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
                Ok(json!(build_vault_file_detail(
                    &state.vault,
                    &relative_path
                )?))
            }
            "save_vault_file" => self.save_vault_file(args),
            "save_vault_binary_file" => self.save_vault_binary_file(args),
            "read_note" => {
                let state = self.state(&args)?;
                let note_id = required_string(&args, &["noteId", "note_id"])?;
                let note = state
                    .vault
                    .read_note(&note_id)
                    .map_err(|error| error.to_string())?;
                Ok(json!(note_to_detail(&note)))
            }
            "save_note" => self.save_note(args),
            "create_note" => self.create_note(args),
            "create_folder" => self.create_folder(args),
            "delete_folder" => self.delete_folder(args),
            "delete_note" => self.delete_note(args),
            "move_folder" => self.move_folder(args),
            "copy_folder" => self.copy_folder(args),
            "rename_note" => self.rename_note(args),
            "convert_note_to_file" => self.convert_note_to_file(args),
            "move_vault_entry" => self.move_vault_entry(args),
            "move_vault_entry_to_trash" => self.move_vault_entry_to_trash(args),
            "compute_tracked_file_patches" => compute_tracked_file_patches(args),
            "search_notes" => self.search_notes(args),
            "advanced_search" => self.advanced_search(args),
            "get_tags" => {
                let state = self.state(&args)?;
                let mut tags: Vec<TagDto> = state
                    .index
                    .tags
                    .iter()
                    .map(|(tag, note_ids)| TagDto {
                        tag: tag.clone(),
                        note_ids: note_ids.iter().map(|id| id.0.clone()).collect(),
                    })
                    .collect();
                tags.sort_by(|left, right| left.tag.cmp(&right.tag));
                Ok(json!(tags))
            }
            "get_backlinks" => self.get_backlinks(args),
            "resolve_wikilinks_batch" => self.resolve_wikilinks_batch(args),
            "suggest_wikilinks" => self.suggest_wikilinks(args),
            "list_maps" => {
                let state = self.state(&args)?;
                let maps = state.entries.iter().filter_map(map_entry_from_vault_entry);
                Ok(json!(maps.collect::<Vec<_>>()))
            }
            "read_map" => {
                let state = self.state(&args)?;
                let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
                Ok(json!(state
                    .vault
                    .read_text_file(&relative_path)
                    .map_err(|error| error.to_string())?))
            }
            "save_map" => {
                self.save_vault_file(args)?;
                Ok(json!(null))
            }
            "create_map" => self.create_map(args),
            "delete_map" => self.delete_map(args),
            "ai_list_runtimes" => Ok(self.ai.list_runtimes()),
            "ai_get_setup_status" => self.ai.get_setup_status(&args),
            "ai_get_environment_diagnostics" => Ok(self.ai.get_environment_diagnostics()),
            "ai_update_setup" => self.ai.update_setup(&args),
            "ai_start_auth" => self.ai.start_auth(&args),
            "ai_list_sessions" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.list_sessions(vault_root)
            }
            "ai_load_session" => self.ai.load_session(&args),
            "ai_load_runtime_session" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.load_runtime_session(&args, vault_root)
            }
            "ai_resume_runtime_session" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.resume_runtime_session(&args, vault_root)
            }
            "ai_fork_runtime_session" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.fork_runtime_session(&args, vault_root)
            }
            "ai_create_session" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.create_session(&args, vault_root)
            }
            "ai_set_model" => self.ai.set_model(&args),
            "ai_set_mode" => self.ai.set_mode(&args),
            "ai_set_config_option" => self.ai.set_config_option(&args),
            "ai_send_message" => self.ai.send_message(&args),
            "ai_cancel_turn" => self.ai.cancel_turn(&args),
            "ai_respond_permission" => self.ai.respond_permission(&args),
            "ai_respond_user_input" => self.ai.respond_user_input(&args),
            "ai_delete_runtime_session" => self.ai.delete_runtime_session(&args),
            "ai_delete_runtime_sessions_for_vault" => {
                let vault_root = self.optional_open_vault_root(&args)?;
                self.ai.delete_runtime_sessions_for_vault(vault_root)
            }
            "ai_register_file_baseline" => self.ai.register_file_baseline(&args),
            "ai_save_session_history" => self.ai_save_session_history(args),
            "ai_load_session_histories" => self.ai_load_session_histories(args),
            "ai_load_session_history_page" => self.ai_load_session_history_page(args),
            "ai_search_session_content" => self.ai_search_session_content(args),
            "ai_fork_session_history" => self.ai_fork_session_history(args),
            "ai_delete_session_history" => self.ai_delete_session_history(args),
            "ai_delete_all_session_histories" => self.ai_delete_all_session_histories(args),
            "ai_prune_session_histories" => self.ai_prune_session_histories(args),
            "ai_get_text_file_hash" => self.ai_get_text_file_hash(args),
            "ai_restore_text_file" => self.ai_restore_text_file(args),
            "ai_start_auth_terminal_session"
            | "ai_write_auth_terminal_session"
            | "ai_resize_auth_terminal_session"
            | "ai_close_auth_terminal_session"
            | "ai_get_auth_terminal_session_snapshot" => self.ai.auth_terminal_unavailable(),
            "devtools_create_terminal_session"
            | "devtools_write_terminal_session"
            | "devtools_resize_terminal_session"
            | "devtools_restart_terminal_session"
            | "devtools_close_terminal_session"
            | "devtools_get_terminal_session_snapshot" => self.devtools.invoke(command, args),
            "spellcheck_list_languages"
            | "spellcheck_list_catalog"
            | "spellcheck_check_text"
            | "spellcheck_suggest"
            | "spellcheck_add_to_dictionary"
            | "spellcheck_remove_from_dictionary"
            | "spellcheck_ignore_word"
            | "spellcheck_get_runtime_directory"
            | "spellcheck_install_dictionary"
            | "spellcheck_remove_installed_dictionary"
            | "spellcheck_check_grammar" => self.spellcheck.invoke(command, args),
            "web_clipper_ready_vaults" => self.web_clipper_ready_vaults(),
            "web_clipper_list_folders" => self.web_clipper_list_folders(args),
            "web_clipper_list_tags" => self.web_clipper_list_tags(args),
            "web_clipper_save_note" => self.web_clipper_save_note(args),
            "sync_recent_vaults"
            | "delete_vault_snapshot"
            | "register_window_vault_route"
            | "unregister_window_vault_route" => Ok(json!(null)),
            "get_app_update_configuration" | "check_for_app_update" => Ok(json!({
                "enabled": false,
                "currentVersion": "0.1.0",
                "channel": "electron-sidecar-spike",
                "endpoint": null,
                "message": "Updates are disabled in the Electron sidecar spike.",
                "update": null
            })),
            "download_and_install_app_update" => Ok(json!(null)),
            _ => Err(format!(
                "Native backend command is not implemented yet: {command}"
            )),
        }
    }

    fn state(&self, args: &Value) -> Result<&VaultRuntimeState, String> {
        let vault_path = required_string(args, &["vaultPath", "vault_path"])?;
        let root = normalize_vault_path(&vault_path)?;
        self.vaults
            .get(&root)
            .ok_or_else(|| "Vault not open".to_string())
    }

    fn state_mut(&mut self, args: &Value) -> Result<(String, &mut VaultRuntimeState), String> {
        let vault_path = required_string(args, &["vaultPath", "vault_path"])?;
        let root = normalize_vault_path(&vault_path)?;
        let state = self
            .vaults
            .get_mut(&root)
            .ok_or_else(|| "Vault not open".to_string())?;
        Ok((root, state))
    }

    fn optional_open_vault_root(&self, args: &Value) -> Result<Option<PathBuf>, String> {
        let Some(vault_path) = optional_nullable_string(args, &["vaultPath", "vault_path"]) else {
            return Ok(None);
        };
        let root = normalize_vault_path(&vault_path)?;
        let state = self
            .vaults
            .get(&root)
            .ok_or_else(|| "Vault not open".to_string())?;
        Ok(Some(state.vault.root.clone()))
    }

    fn required_open_vault_root(&self, args: &Value) -> Result<(String, PathBuf), String> {
        let vault_path = required_string(args, &["vaultPath", "vault_path"])?;
        let root = normalize_vault_path(&vault_path)?;
        let state = self
            .vaults
            .get(&root)
            .ok_or_else(|| "Vault not open".to_string())?;
        Ok((root, state.vault.root.clone()))
    }

    fn ai_save_session_history(&self, args: Value) -> Result<Value, String> {
        let (_vault_key, vault_root) = self.required_open_vault_root(&args)?;
        let history: PersistedSessionHistory = serde_json::from_value(
            args.get("history")
                .cloned()
                .ok_or_else(|| "Missing argument: history".to_string())?,
        )
        .map_err(|error| error.to_string())?;
        persistence::save_session_history(&vault_root, &history)?;
        Ok(json!(null))
    }

    fn ai_load_session_histories(&self, args: Value) -> Result<Value, String> {
        let (_vault_key, vault_root) = self.required_open_vault_root(&args)?;
        let include_messages = bool_arg(&args, "includeMessages")
            .or_else(|| bool_arg(&args, "include_messages"))
            .unwrap_or(true);
        let histories: Vec<PersistedSessionHistory> =
            persistence::load_all_session_histories(&vault_root, include_messages)?;
        Ok(json!(histories))
    }

    fn ai_load_session_history_page(&self, args: Value) -> Result<Value, String> {
        let (_vault_key, vault_root) = self.required_open_vault_root(&args)?;
        let session_id = required_string(&args, &["sessionId", "session_id"])?;
        let start_index = required_usize(&args, &["startIndex", "start_index"])?;
        let limit = required_usize(&args, &["limit"])?;
        let page: PersistedSessionHistoryPage =
            persistence::load_session_history_page(&vault_root, &session_id, start_index, limit)?;
        Ok(json!(page))
    }

    fn ai_search_session_content(&self, args: Value) -> Result<Value, String> {
        let (_vault_key, vault_root) = self.required_open_vault_root(&args)?;
        let query = required_string(&args, &["query"])?;
        let results: Vec<SessionSearchResult> =
            persistence::search_session_content(&vault_root, &query)?;
        Ok(json!(results))
    }

    fn ai_fork_session_history(&self, args: Value) -> Result<Value, String> {
        let (_vault_key, vault_root) = self.required_open_vault_root(&args)?;
        let source_session_id = required_string(&args, &["sourceSessionId", "source_session_id"])?;
        Ok(json!(persistence::fork_session_history(
            &vault_root,
            &source_session_id
        )?))
    }

    fn ai_delete_session_history(&self, args: Value) -> Result<Value, String> {
        let (_vault_key, vault_root) = self.required_open_vault_root(&args)?;
        let session_id = required_string(&args, &["sessionId", "session_id"])?;
        persistence::delete_session_history(&vault_root, &session_id)?;
        Ok(json!(null))
    }

    fn ai_delete_all_session_histories(&self, args: Value) -> Result<Value, String> {
        let (_vault_key, vault_root) = self.required_open_vault_root(&args)?;
        persistence::delete_all_session_histories(&vault_root)?;
        Ok(json!(null))
    }

    fn ai_prune_session_histories(&self, args: Value) -> Result<Value, String> {
        let (_vault_key, vault_root) = self.required_open_vault_root(&args)?;
        let max_age_days = required_u32(&args, &["maxAgeDays", "max_age_days"])?;
        Ok(json!(persistence::prune_expired_session_histories(
            &vault_root,
            max_age_days
        )?))
    }

    fn ai_get_text_file_hash(&self, args: Value) -> Result<Value, String> {
        let state = self.state(&args)?;
        let relative_path = required_string(&args, &["path"])?;
        let resolved_path = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        match fs::read(&resolved_path) {
            Ok(bytes) => Ok(json!(Some(content_hash_bytes(&bytes)))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!(null)),
            Err(error) => Err(error.to_string()),
        }
    }

    fn ai_restore_text_file(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["path"])?;
        let previous_path = optional_nullable_string(&args, &["previousPath", "previous_path"]);
        let content = optional_nullable_string(&args, &["content"]);
        let op_id = Some(format!("ai-restore-{}", now_ms()));
        let (vault_path, state) = self.state_mut(&args)?;
        let current_path = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::CreateTarget)
            .map_err(|error| error.to_string())?;
        let restore_path = previous_path
            .as_deref()
            .map(|value| {
                state
                    .vault
                    .resolve_scoped_path(value, ScopedPathIntent::CreateTarget)
                    .map_err(|error| error.to_string())
            })
            .transpose()?;
        let final_path = restore_path.clone().unwrap_or_else(|| current_path.clone());

        state.write_tracker.track_any(current_path.clone());
        if let Some(path) = restore_path.as_ref() {
            state.write_tracker.track_any(path.clone());
        }

        let change = if let Some(text) = content {
            if let Some(parent) = final_path.parent() {
                fs::create_dir_all(parent).map_err(|error| error.to_string())?;
            }
            state.write_tracker.track_content(final_path.clone(), &text);
            fs::write(&final_path, &text).map_err(|error| error.to_string())?;
            if final_path != current_path && current_path.exists() {
                fs::remove_file(&current_path).map_err(|error| error.to_string())?;
            }
            Self::refresh_vault_state(state)?;
            let final_relative_path = state.vault.path_to_relative_path(&final_path);
            if path_has_extension(&final_path, "md") {
                let note = state
                    .vault
                    .read_note_from_path(&final_path)
                    .map_err(|error| error.to_string())?;
                let previous_note_id = (final_path != current_path
                    && path_has_extension(&current_path, "md"))
                .then(|| state.vault.path_to_id(&current_path));
                let revision = advance_revision(
                    &mut state.note_revisions,
                    &note.id.0,
                    previous_note_id.as_deref(),
                )
                .max(1);
                build_vault_note_change_with_origin(
                    &vault_path,
                    "upsert",
                    Some(note_document_to_dto(&note)),
                    Some(note.id.0.clone()),
                    None,
                    Some(final_relative_path),
                    VAULT_CHANGE_ORIGIN_AGENT,
                    op_id,
                    revision,
                    Some(note_content_hash(&note.raw_markdown)),
                    state.graph_revision.max(1),
                )
            } else {
                let entry = state.vault.read_vault_entry_from_path(&final_path).ok();
                let current_relative_path = state.vault.path_to_relative_path(&current_path);
                let previous_key = (current_relative_path != final_relative_path)
                    .then_some(current_relative_path.as_str());
                let revision = advance_revision(
                    &mut state.file_revisions,
                    &final_relative_path,
                    previous_key,
                )
                .max(1);
                build_vault_note_change_with_origin(
                    &vault_path,
                    "upsert",
                    None,
                    None,
                    entry,
                    Some(final_relative_path),
                    VAULT_CHANGE_ORIGIN_AGENT,
                    op_id,
                    revision,
                    Some(note_content_hash(&text)),
                    state.graph_revision.max(1),
                )
            }
        } else {
            if current_path.exists() {
                fs::remove_file(&current_path).map_err(|error| error.to_string())?;
            }
            if let Some(path) = restore_path.as_ref() {
                if path.exists() {
                    fs::remove_file(path).map_err(|error| error.to_string())?;
                }
            }
            let current_relative_path = state.vault.path_to_relative_path(&current_path);
            let target_relative_path = restore_path
                .as_ref()
                .map(|path| state.vault.path_to_relative_path(path));
            Self::refresh_vault_state(state)?;
            if path_has_extension(&current_path, "md") {
                let note_id = markdown_note_id_from_relative_path(&current_relative_path)
                    .unwrap_or_else(|| state.vault.path_to_id(&current_path));
                let revision = advance_revision(&mut state.note_revisions, &note_id, None).max(1);
                build_vault_note_change_with_origin(
                    &vault_path,
                    "delete",
                    None,
                    Some(note_id),
                    None,
                    Some(current_relative_path),
                    VAULT_CHANGE_ORIGIN_AGENT,
                    op_id,
                    revision,
                    None,
                    state.graph_revision.max(1),
                )
            } else {
                let revision = advance_revision(
                    &mut state.file_revisions,
                    &current_relative_path,
                    target_relative_path.as_deref(),
                )
                .max(1);
                build_vault_note_change_with_origin(
                    &vault_path,
                    "delete",
                    None,
                    None,
                    None,
                    Some(current_relative_path),
                    VAULT_CHANGE_ORIGIN_AGENT,
                    op_id,
                    revision,
                    None,
                    state.graph_revision.max(1),
                )
            }
        };

        self.emit_vault_change(change.clone());
        Ok(json!(change))
    }

    fn web_clipper_ready_vaults(&self) -> Result<Value, String> {
        let mut vaults = self
            .vaults
            .iter()
            .filter(|(_, state)| state.open_state.stage == "ready")
            .map(|(path, _)| {
                json!({
                    "path": path,
                    "name": clipper_vault_name(path),
                })
            })
            .collect::<Vec<_>>();
        vaults.sort_by(|left, right| {
            left.get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .cmp(
                    right
                        .get("path")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                )
        });
        Ok(json!(vaults))
    }

    fn web_clipper_list_folders(&self, args: Value) -> Result<Value, String> {
        let vault_key = self.resolve_web_clipper_vault_key(&args)?;
        let state = self
            .vaults
            .get(&vault_key)
            .ok_or_else(|| "Vault not found".to_string())?;
        let mut folders = state
            .entries
            .iter()
            .filter(|entry| entry.kind == "folder")
            .map(|entry| entry.relative_path.clone())
            .collect::<Vec<_>>();
        folders.sort();
        Ok(json!(folders))
    }

    fn web_clipper_list_tags(&self, args: Value) -> Result<Value, String> {
        let vault_key = self.resolve_web_clipper_vault_key(&args)?;
        let state = self
            .vaults
            .get(&vault_key)
            .ok_or_else(|| "Vault not found".to_string())?;
        let mut tags = state.index.tags.keys().cloned().collect::<Vec<_>>();
        tags.sort();
        Ok(json!(tags))
    }

    fn web_clipper_save_note(&mut self, args: Value) -> Result<Value, String> {
        let request_id = required_string(&args, &["requestId", "request_id"])?;
        let title = required_string(&args, &["title"])?;
        let folder = optional_string(&args, &["folder"]).unwrap_or_default();
        let content = required_string(&args, &["content"])?;
        if content.trim().is_empty() {
            return Err("Clip content is empty.".to_string());
        }

        let vault_key = self.resolve_web_clipper_vault_key(&args)?;
        let op_id = Some(format!("web-clipper-{request_id}"));
        let (note, relative_path, change) = {
            let state = self
                .vaults
                .get_mut(&vault_key)
                .ok_or_else(|| "Vault not found".to_string())?;
            let relative_path =
                build_web_clipper_relative_note_path(&state.vault, &folder, &title)?;
            let target_path = state
                .vault
                .resolve_note_relative_markdown_path(&relative_path)
                .map_err(|error| error.to_string())?;
            state.write_tracker.track_content(target_path, &content);
            let note = state
                .vault
                .create_note(&relative_path, &content)
                .map_err(|error| error.to_string())?;
            let entry = state
                .vault
                .read_vault_entry_from_path(&note.path.0)
                .map_err(|error| error.to_string())?;
            let revision = advance_revision(&mut state.note_revisions, &note.id.0, None).max(1);
            let change = build_vault_note_change_with_origin(
                &vault_key,
                "upsert",
                Some(note_document_to_dto(&note)),
                Some(note.id.0.clone()),
                Some(entry),
                Some(relative_path.clone()),
                VAULT_CHANGE_ORIGIN_EXTERNAL,
                op_id,
                revision,
                Some(note_content_hash(&content)),
                state.graph_revision.max(1),
            );
            Self::refresh_vault_state(state)?;
            (note, relative_path, change)
        };

        self.emit_vault_change(change);
        Ok(json!({
            "requestId": request_id,
            "vaultPath": vault_key,
            "targetWindowLabel": Value::Null,
            "noteId": note.id.0,
            "title": note.title,
            "relativePath": relative_path,
            "content": content,
        }))
    }

    fn resolve_web_clipper_vault_key(&self, args: &Value) -> Result<String, String> {
        let vault_path_hint = optional_string(args, &["vaultPathHint", "vault_path_hint"]);
        let vault_name_hint = optional_string(args, &["vaultNameHint", "vault_name_hint"]);
        let ready_keys = self
            .vaults
            .iter()
            .filter(|(_, state)| state.open_state.stage == "ready")
            .map(|(path, _)| path.clone())
            .collect::<Vec<_>>();

        resolve_web_clipper_vault_key_from_ready_keys(
            &ready_keys,
            vault_path_hint.as_deref(),
            vault_name_hint.as_deref(),
        )
    }

    fn open_vault(
        &mut self,
        path: String,
        backend_ref: &Arc<Mutex<NativeBackend>>,
    ) -> Result<(), String> {
        let root = normalize_vault_path(&path)?;
        let started_at_ms = now_ms();
        let vault = Vault::open(PathBuf::from(&root)).map_err(|error| error.to_string())?;
        let scan_started_at = now_ms();
        let notes = vault.scan().map_err(|error| error.to_string())?;
        let entries = vault
            .discover_vault_entries()
            .map_err(|error| error.to_string())?;
        let index = VaultIndex::build(notes);
        let scan_ms = now_ms().saturating_sub(scan_started_at);
        let note_count = index.metadata.len();
        let entry_count = entries.len();
        let write_tracker = WriteTracker::new();
        let watcher = start_vault_watcher(&root, write_tracker.clone(), backend_ref)?;

        self.vaults.insert(
            root.clone(),
            VaultRuntimeState {
                vault,
                index,
                entries,
                open_state: VaultOpenStateDto {
                    path: Some(root),
                    stage: "ready".to_string(),
                    message: "Vault ready".to_string(),
                    processed: entry_count,
                    total: entry_count,
                    note_count,
                    snapshot_used: false,
                    cancelled: false,
                    started_at_ms: Some(started_at_ms),
                    finished_at_ms: Some(now_ms()),
                    metrics: VaultOpenMetricsDto {
                        scan_ms,
                        snapshot_load_ms: 0,
                        parse_ms: 0,
                        index_ms: 0,
                        snapshot_save_ms: 0,
                    },
                    error: None,
                },
                graph_revision: 1,
                note_revisions: HashMap::new(),
                file_revisions: HashMap::new(),
                write_tracker,
                _watcher: Some(watcher),
            },
        );
        Ok(())
    }

    fn refresh_vault_state(state: &mut VaultRuntimeState) -> Result<(), String> {
        let notes = state.vault.scan().map_err(|error| error.to_string())?;
        state.index = VaultIndex::build(notes);
        state.entries = state
            .vault
            .discover_vault_entries()
            .map_err(|error| error.to_string())?;
        state.graph_revision = state.graph_revision.saturating_add(1).max(1);
        Ok(())
    }

    fn save_vault_file(&mut self, args: Value) -> Result<Value, String> {
        let content = required_string(&args, &["content"])?;
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let op_id = optional_string(&args, &["opId", "op_id"]);
        let (vault_path, state) = self.state_mut(&args)?;
        let target_path = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::WriteExisting)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_content(target_path, &content);
        let entry = state
            .vault
            .save_text_file(&relative_path, &content)
            .map_err(|error| error.to_string())?;
        let detail = build_vault_file_detail(&state.vault, &entry.relative_path)?;
        let revision =
            advance_revision(&mut state.file_revisions, &entry.relative_path, None).max(1);
        let change = build_vault_note_change(
            &vault_path,
            "upsert",
            None,
            None,
            Some(entry),
            Some(detail.relative_path.clone()),
            op_id,
            revision,
            Some(note_content_hash(&content)),
            state.graph_revision.max(1),
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(change);
        Ok(json!(detail))
    }

    fn save_vault_binary_file(&mut self, args: Value) -> Result<Value, String> {
        let relative_dir = required_string(&args, &["relativeDir", "relative_dir"])?;
        let file_name = required_string(&args, &["fileName", "file_name"])?;
        let bytes = bytes_arg(&args, "bytes")?;
        let op_id = optional_string(&args, &["opId", "op_id"]);
        let (vault_path, state) = self.state_mut(&args)?;
        let path = state
            .vault
            .prepare_binary_file_target(&relative_dir, &file_name)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(path.clone());
        fs::write(&path, &bytes).map_err(|error| error.to_string())?;
        let entry = state
            .vault
            .read_vault_entry_from_path(&path)
            .map_err(|error| error.to_string())?;
        let detail = SavedBinaryFileDetail {
            path: entry.path.clone(),
            relative_path: entry.relative_path.clone(),
            file_name: entry.file_name.clone(),
            mime_type: entry.mime_type.clone(),
        };
        let revision =
            advance_revision(&mut state.file_revisions, &entry.relative_path, None).max(1);
        Self::refresh_vault_state(state)?;
        let change = build_vault_note_change(
            &vault_path,
            "upsert",
            None,
            None,
            Some(entry),
            Some(detail.relative_path.clone()),
            op_id,
            revision,
            None,
            state.graph_revision.max(1),
        );
        self.emit_vault_change(change);
        Ok(json!(detail))
    }

    fn save_note(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let content = required_string(&args, &["content"])?;
        let op_id = optional_string(&args, &["opId", "op_id"]);
        let (vault_path, state) = self.state_mut(&args)?;
        let target_path = state
            .vault
            .resolve_note_id_path(&note_id)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_content(target_path, &content);
        state
            .vault
            .save_note(&note_id, &content)
            .map_err(|error| error.to_string())?;
        let note = state
            .vault
            .read_note(&note_id)
            .map_err(|error| error.to_string())?;
        let relative_path = state.vault.path_to_relative_path(&note.path.0);
        let detail = note_to_detail(&note);
        let revision = advance_revision(&mut state.note_revisions, &note_id, None).max(1);
        let change = note_change_from_document(
            &vault_path,
            &note,
            relative_path,
            op_id,
            revision,
            state.graph_revision.max(1),
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(change);
        Ok(json!(detail))
    }

    fn create_note(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["path"])?;
        let content = required_string(&args, &["content"])?;
        let (vault_path, state) = self.state_mut(&args)?;
        let target_path = state
            .vault
            .resolve_note_relative_markdown_path(&relative_path)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_content(target_path, &content);
        let note = state
            .vault
            .create_note(&relative_path, &content)
            .map_err(|error| error.to_string())?;
        let entry = state
            .vault
            .read_vault_entry_from_path(&note.path.0)
            .map_err(|error| error.to_string())?;
        let detail = note_to_detail(&note);
        let revision = advance_revision(&mut state.note_revisions, &note.id.0, None).max(1);
        let change = note_change_from_document(
            &vault_path,
            &note,
            entry.relative_path,
            None,
            revision,
            state.graph_revision.max(1),
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(change);
        Ok(json!(detail))
    }

    fn create_folder(&mut self, args: Value) -> Result<Value, String> {
        let path = required_string(&args, &["path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let target_path = state
            .vault
            .resolve_scoped_path(&path, ScopedPathIntent::CreateDirectoryTarget)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(target_path);
        let entry = state
            .vault
            .create_folder(&path)
            .map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(entry))
    }

    fn delete_folder(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        track_path_tree(&state.write_tracker, &source);
        state
            .vault
            .delete_folder(&relative_path)
            .map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(null))
    }

    fn delete_note(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let (vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_note_id_path(&note_id)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(source);
        state
            .vault
            .delete_note(&note_id)
            .map_err(|error| error.to_string())?;
        let relative_path = format!("{note_id}.md");
        let revision = advance_revision(&mut state.note_revisions, &note_id, None).max(1);
        let change = build_vault_note_change(
            &vault_path,
            "delete",
            None,
            Some(note_id.clone()),
            None,
            Some(relative_path),
            None,
            revision,
            None,
            state.graph_revision.max(1),
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(change);
        Ok(json!(null))
    }

    fn move_folder(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let new_relative_path = required_string(&args, &["newRelativePath", "new_relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        let target = state
            .vault
            .resolve_scoped_path(&new_relative_path, ScopedPathIntent::CreateDirectoryTarget)
            .map_err(|error| error.to_string())?;
        track_moved_tree(&state.write_tracker, &source, &target);
        state
            .vault
            .move_folder(&relative_path, &new_relative_path)
            .map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(null))
    }

    fn copy_folder(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let new_relative_path = required_string(&args, &["newRelativePath", "new_relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        let target = state
            .vault
            .resolve_scoped_path(&new_relative_path, ScopedPathIntent::CreateDirectoryTarget)
            .map_err(|error| error.to_string())?;
        track_copied_tree(&state.write_tracker, &source, &target);
        let entry = state
            .vault
            .copy_folder(&relative_path, &new_relative_path)
            .map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(entry))
    }

    fn rename_note(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let new_path = required_string(&args, &["newPath", "new_path"])?;
        let (vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_note_id_path(&note_id)
            .map_err(|error| error.to_string())?;
        let target = state
            .vault
            .resolve_note_relative_markdown_path(&new_path)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(source);
        state.write_tracker.track_any(target);
        let note = state
            .vault
            .rename_note(&note_id, &new_path)
            .map_err(|error| error.to_string())?;
        let entry = state
            .vault
            .read_vault_entry_from_path(&note.path.0)
            .map_err(|error| error.to_string())?;
        let detail = note_to_detail(&note);
        let revision =
            advance_revision(&mut state.note_revisions, &note.id.0, Some(&note_id)).max(1);
        let change = note_change_from_document(
            &vault_path,
            &note,
            entry.relative_path,
            None,
            revision,
            state.graph_revision.max(1),
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(change);
        Ok(json!(detail))
    }

    fn convert_note_to_file(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let new_relative_path = required_string(&args, &["newRelativePath", "new_relative_path"])?;
        let (vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_note_id_path(&note_id)
            .map_err(|error| error.to_string())?;
        let target = state
            .vault
            .resolve_scoped_path(&new_relative_path, ScopedPathIntent::CreateTarget)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(source);
        state.write_tracker.track_any(target);
        let entry = state
            .vault
            .convert_note_to_file(&note_id, &new_relative_path)
            .map_err(|error| error.to_string())?;
        let delete_revision = advance_revision(&mut state.note_revisions, &note_id, None).max(1);
        let upsert_revision =
            advance_revision(&mut state.file_revisions, &entry.relative_path, None).max(1);
        let graph_revision = state.graph_revision.max(1);
        let delete_change = build_vault_note_change(
            &vault_path,
            "delete",
            None,
            Some(note_id.clone()),
            None,
            Some(format!("{note_id}.md")),
            None,
            delete_revision,
            None,
            graph_revision,
        );
        let upsert_change = build_vault_note_change(
            &vault_path,
            "upsert",
            None,
            None,
            Some(entry.clone()),
            Some(entry.relative_path.clone()),
            None,
            upsert_revision,
            None,
            graph_revision,
        );
        Self::refresh_vault_state(state)?;
        self.emit_vault_change(delete_change);
        self.emit_vault_change(upsert_change);
        Ok(json!(entry))
    }

    fn move_vault_entry(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let new_relative_path = required_string(&args, &["newRelativePath", "new_relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        let target = state
            .vault
            .resolve_scoped_path(&new_relative_path, ScopedPathIntent::CreateTarget)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(source);
        state.write_tracker.track_any(target);
        let entry = state
            .vault
            .move_vault_entry(&relative_path, &new_relative_path)
            .map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(entry))
    }

    fn move_vault_entry_to_trash(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let source = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        if !source.is_file() {
            return Err("Only files can be moved to trash".to_string());
        }
        state.write_tracker.track_any(source.clone());
        let trash_dir = state.vault.root.join(".trash");
        fs::create_dir_all(&trash_dir).map_err(|error| error.to_string())?;
        let target = trash_dir.join(format!(
            "{}-{}",
            now_ms(),
            source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("file")
        ));
        fs::rename(&source, target).map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(null))
    }

    fn search_notes(&mut self, args: Value) -> Result<Value, String> {
        let query = required_string(&args, &["query"])?;
        let prefer_file_name = bool_arg(&args, "preferFileName").unwrap_or(false);
        let state = self.state(&args)?;
        let query_lower = query.to_lowercase();
        let mut results: Vec<SearchResultDto> = if prefer_file_name {
            state.index.search_by_file_name(&query)
        } else {
            state.index.search(&query)
        }
        .into_iter()
        .map(|result| SearchResultDto {
            id: result.metadata.id.0.clone(),
            path: result.metadata.path.0.to_string_lossy().to_string(),
            title: result.metadata.title.clone(),
            kind: "note".to_string(),
            score: result.score,
        })
        .collect();

        results.extend(state.entries.iter().filter_map(|entry| {
            if entry.kind == "note" {
                return None;
            }
            let score = non_note_score(&query_lower, entry);
            (score > 0.0).then(|| SearchResultDto {
                id: entry.id.clone(),
                path: entry.path.clone(),
                title: entry.title.clone(),
                kind: entry.kind.clone(),
                score,
            })
        }));
        results.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(200);
        Ok(json!(results))
    }

    fn advanced_search(&mut self, args: Value) -> Result<Value, String> {
        let params: AdvancedSearchParams = serde_json::from_value(
            args.get("params")
                .cloned()
                .ok_or_else(|| "Missing argument: params".to_string())?,
        )
        .map_err(|error| error.to_string())?;
        let state = self.state(&args)?;
        Ok(json!(state.index.advanced_search(&params, &state.vault)))
    }

    fn get_backlinks(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let state = self.state(&args)?;
        let id = NoteId(note_id);
        let backlinks: Vec<BacklinkDto> = state
            .index
            .get_backlinks(&id)
            .into_iter()
            .filter_map(|backlink_id| {
                let note = state.index.metadata.get(backlink_id)?;
                Some(BacklinkDto {
                    id: note.id.0.clone(),
                    title: note.title.clone(),
                })
            })
            .collect();
        Ok(json!(backlinks))
    }

    fn resolve_wikilinks_batch(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let targets: Vec<String> = serde_json::from_value(
            args.get("targets")
                .cloned()
                .unwrap_or(Value::Array(Vec::new())),
        )
        .map_err(|error| error.to_string())?;
        let state = self.state(&args)?;
        let from_note = NoteId(note_id);
        let mut seen = HashSet::new();
        let links: Vec<ResolvedWikilinkDto> = targets
            .into_iter()
            .filter(|target| seen.insert(target.clone()))
            .map(|target| {
                let resolved = state.index.resolve_wikilink(&target, &from_note);
                let (resolved_note_id, resolved_title) = match resolved {
                    Some(ref id) => (
                        Some(id.0.clone()),
                        state.index.metadata.get(id).map(|note| note.title.clone()),
                    ),
                    None => (None, None),
                };
                ResolvedWikilinkDto {
                    target,
                    resolved_note_id,
                    resolved_title,
                }
            })
            .collect();
        Ok(json!(links))
    }

    fn suggest_wikilinks(&mut self, args: Value) -> Result<Value, String> {
        let note_id = required_string(&args, &["noteId", "note_id"])?;
        let query = args
            .get("query")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(8)
            .max(1) as usize;
        let prefer_file_name = bool_arg(&args, "preferFileName").unwrap_or(false);
        let state = self.state(&args)?;
        let suggestions: Vec<WikilinkSuggestionDto> = state
            .index
            .suggest_wikilinks(&query, &NoteId(note_id), limit, prefer_file_name)
            .into_iter()
            .filter_map(|note_id| {
                let metadata = state.index.metadata.get(&note_id)?;
                let insert_text = suggestion_insert_text(metadata);
                Some(WikilinkSuggestionDto {
                    id: metadata.id.0.clone(),
                    title: insert_text.clone(),
                    subtitle: metadata.id.0.clone(),
                    insert_text,
                })
            })
            .collect();
        Ok(json!(suggestions))
    }

    fn create_map(&mut self, args: Value) -> Result<Value, String> {
        let raw_name = optional_string(&args, &["name"]).unwrap_or_else(|| "Untitled".to_string());
        let title = raw_name.trim().trim_end_matches(".excalidraw");
        let title = if title.is_empty() { "Untitled" } else { title };
        let relative_path = format!("Excalidraw/{title}.excalidraw");
        let (_vault_path, state) = self.state_mut(&args)?;
        let target = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::CreateTarget)
            .map_err(|error| error.to_string())?;
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        state.write_tracker.track_any(target.clone());
        fs::write(&target, "{}").map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(MapEntryDto {
            id: relative_path.clone(),
            title: title.to_string(),
            relative_path,
        }))
    }

    fn delete_map(&mut self, args: Value) -> Result<Value, String> {
        let relative_path = required_string(&args, &["relativePath", "relative_path"])?;
        let (_vault_path, state) = self.state_mut(&args)?;
        let target = state
            .vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::ReadExisting)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(target.clone());
        fs::remove_file(target).map_err(|error| error.to_string())?;
        Self::refresh_vault_state(state)?;
        Ok(json!(null))
    }

    fn handle_external_vault_event(
        &mut self,
        vault_path: &str,
        event: VaultEvent,
    ) -> Result<(), String> {
        match event {
            VaultEvent::FileCreated(path) | VaultEvent::FileModified(path) => {
                self.emit_external_upsert(vault_path, path)
            }
            VaultEvent::FileDeleted(path) => self.emit_external_delete(vault_path, path),
            VaultEvent::FileRenamed { from, to } => {
                self.emit_external_delete(vault_path, from)?;
                self.emit_external_upsert(vault_path, to)
            }
        }
    }

    fn emit_external_delete(&mut self, vault_path: &str, path: PathBuf) -> Result<(), String> {
        let state = self
            .vaults
            .get_mut(vault_path)
            .ok_or_else(|| "Vault not open".to_string())?;
        let relative_path = state.vault.path_to_relative_path(&path);
        let note_id = markdown_note_id_from_relative_path(&relative_path);
        let revision = match &note_id {
            Some(note_id) => advance_revision(&mut state.note_revisions, note_id, None),
            None => advance_revision(&mut state.file_revisions, &relative_path, None),
        }
        .max(1);
        Self::refresh_vault_state(state)?;
        let graph_revision = state.graph_revision.max(1);
        let change = build_vault_note_change_with_origin(
            vault_path,
            "delete",
            None,
            note_id,
            None,
            Some(relative_path),
            VAULT_CHANGE_ORIGIN_EXTERNAL,
            None,
            revision,
            None,
            graph_revision,
        );
        self.emit_vault_change(change);
        Ok(())
    }

    fn emit_external_upsert(&mut self, vault_path: &str, path: PathBuf) -> Result<(), String> {
        let state = self
            .vaults
            .get_mut(vault_path)
            .ok_or_else(|| "Vault not open".to_string())?;
        if !path.exists() {
            return Ok(());
        }

        let relative_path = state.vault.path_to_relative_path(&path);
        Self::refresh_vault_state(state)?;
        let graph_revision = state.graph_revision.max(1);
        if path.is_dir() {
            let entry = state
                .entries
                .iter()
                .find(|entry| entry.relative_path == relative_path)
                .cloned();
            let revision = advance_revision(&mut state.file_revisions, &relative_path, None).max(1);
            let change = build_vault_note_change_with_origin(
                vault_path,
                "upsert",
                None,
                None,
                entry,
                Some(relative_path),
                VAULT_CHANGE_ORIGIN_EXTERNAL,
                None,
                revision,
                None,
                graph_revision,
            );
            self.emit_vault_change(change);
            return Ok(());
        }

        if let Some(note_id) = markdown_note_id_from_relative_path(&relative_path) {
            let Some(note) = state
                .index
                .metadata
                .get(&NoteId(note_id.clone()))
                .map(note_to_dto)
            else {
                return Ok(());
            };
            let content_hash = fs::read_to_string(&path)
                .ok()
                .map(|content| note_content_hash(&content));
            let revision = advance_revision(&mut state.note_revisions, &note_id, None).max(1);
            let change = build_vault_note_change_with_origin(
                vault_path,
                "upsert",
                Some(note),
                Some(note_id),
                None,
                Some(relative_path),
                VAULT_CHANGE_ORIGIN_EXTERNAL,
                None,
                revision,
                content_hash,
                graph_revision,
            );
            self.emit_vault_change(change);
            return Ok(());
        }

        let entry = state
            .entries
            .iter()
            .find(|entry| entry.relative_path == relative_path)
            .cloned();
        let revision = advance_revision(&mut state.file_revisions, &relative_path, None).max(1);
        let content_hash = fs::read_to_string(&path)
            .ok()
            .map(|content| note_content_hash(&content));
        let change = build_vault_note_change_with_origin(
            vault_path,
            "upsert",
            None,
            None,
            entry,
            Some(relative_path),
            VAULT_CHANGE_ORIGIN_EXTERNAL,
            None,
            revision,
            content_hash,
            graph_revision,
        );
        self.emit_vault_change(change);
        Ok(())
    }

    fn emit_vault_change(&mut self, change: VaultNoteChangeDto) {
        let _ = self.event_tx.send(RpcOutput::Event {
            event_name: "vault://note-changed".to_string(),
            payload: json!(change),
        });
    }
}

fn cancelled_placeholder_state(root: String) -> VaultRuntimeState {
    let vault = Vault {
        root: PathBuf::from(root.clone()),
    };
    VaultRuntimeState {
        vault,
        index: VaultIndex::build(Vec::new()),
        entries: Vec::new(),
        open_state: VaultOpenStateDto {
            path: Some(root),
            stage: "cancelled".to_string(),
            message: "Opening cancelled".to_string(),
            processed: 0,
            total: 0,
            note_count: 0,
            snapshot_used: false,
            cancelled: true,
            started_at_ms: None,
            finished_at_ms: Some(now_ms()),
            metrics: empty_metrics(),
            error: None,
        },
        graph_revision: 1,
        note_revisions: HashMap::new(),
        file_revisions: HashMap::new(),
        write_tracker: WriteTracker::new(),
        _watcher: None,
    }
}

fn idle_open_state() -> VaultOpenStateDto {
    VaultOpenStateDto {
        path: None,
        stage: "idle".to_string(),
        message: String::new(),
        processed: 0,
        total: 0,
        note_count: 0,
        snapshot_used: false,
        cancelled: false,
        started_at_ms: None,
        finished_at_ms: None,
        metrics: empty_metrics(),
        error: None,
    }
}

fn empty_metrics() -> VaultOpenMetricsDto {
    VaultOpenMetricsDto {
        scan_ms: 0,
        snapshot_load_ms: 0,
        parse_ms: 0,
        index_ms: 0,
        snapshot_save_ms: 0,
    }
}

fn normalize_vault_path(raw: &str) -> Result<String, String> {
    if raw.trim().is_empty() {
        return Err("Vault path is required".to_string());
    }
    Ok(PathBuf::from(raw)
        .canonicalize()
        .map_err(|error| error.to_string())?
        .to_string_lossy()
        .to_string())
}

fn required_string(args: &Value, names: &[&str]) -> Result<String, String> {
    optional_string(args, names).ok_or_else(|| format!("Missing argument: {}", names[0]))
}

fn optional_string(args: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| {
        args.get(*name)
            .and_then(Value::as_str)
            .map(ToString::to_string)
            .filter(|value| !value.is_empty())
    })
}

fn optional_nullable_string(args: &Value, names: &[&str]) -> Option<String> {
    names.iter().find_map(|name| match args.get(*name) {
        Some(Value::String(value)) if !value.is_empty() => Some(value.to_string()),
        _ => None,
    })
}

fn clipper_vault_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(path)
        .to_string()
}

fn resolve_web_clipper_vault_key_from_ready_keys(
    ready_keys: &[String],
    vault_path_hint: Option<&str>,
    vault_name_hint: Option<&str>,
) -> Result<String, String> {
    if ready_keys.is_empty() {
        return Err("No ready vault is available in NeverWrite.".to_string());
    }

    if let Some(path_hint) = vault_path_hint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(found) = ready_keys.iter().find(|path| path.as_str() == path_hint) {
            return Ok(found.clone());
        }
    }

    if let Some(name_hint) = vault_name_hint
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let lower = name_hint.to_lowercase();
        let mut matches = ready_keys
            .iter()
            .filter(|path| clipper_vault_name(path).to_lowercase() == lower)
            .cloned()
            .collect::<Vec<_>>();

        if matches.len() == 1 {
            return Ok(matches.remove(0));
        }
    }

    if ready_keys.len() == 1 {
        return Ok(ready_keys[0].clone());
    }

    Err("NeverWrite has multiple open vaults. Provide a more specific vault hint.".to_string())
}

fn normalize_web_clipper_folder(folder: &str) -> Result<String, String> {
    let mut normalized = PathBuf::new();

    for component in Path::new(folder).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::Normal(value) => normalized.push(value),
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => {
                return Err("Folder hint must stay inside the vault.".to_string())
            }
        }
    }

    Ok(normalized.to_string_lossy().replace('\\', "/"))
}

fn sanitize_web_clipper_title(title: &str) -> String {
    let sanitized = title
        .trim()
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => ' ',
            value if value.is_control() => ' ',
            value => value,
        })
        .collect::<String>()
        .replace('.', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");

    sanitized
        .chars()
        .take(96)
        .collect::<String>()
        .trim()
        .to_string()
}

fn build_web_clipper_relative_note_path(
    vault: &Vault,
    folder: &str,
    title: &str,
) -> Result<String, String> {
    let normalized_folder = normalize_web_clipper_folder(folder)?;
    let stem = sanitize_web_clipper_title(title);
    let base = if stem.is_empty() {
        "untitled-clip".to_string()
    } else {
        stem
    };

    for index in 1..10_000 {
        let file_name = if index == 1 {
            format!("{base}.md")
        } else {
            format!("{base}-{index}.md")
        };
        let relative_path = if normalized_folder.is_empty() {
            file_name
        } else {
            format!("{normalized_folder}/{file_name}")
        };
        let path = vault
            .resolve_scoped_path(&relative_path, ScopedPathIntent::CreateTarget)
            .map_err(|error| error.to_string())?;
        if !path.exists() {
            return Ok(relative_path);
        }
    }

    Err("Could not find a free filename for the clip.".to_string())
}

fn required_usize(args: &Value, names: &[&str]) -> Result<usize, String> {
    names
        .iter()
        .find_map(|name| args.get(*name).and_then(Value::as_u64))
        .map(|value| {
            usize::try_from(value).map_err(|_| format!("Argument out of range: {}", names[0]))
        })
        .transpose()?
        .ok_or_else(|| format!("Missing argument: {}", names[0]))
}

fn required_u32(args: &Value, names: &[&str]) -> Result<u32, String> {
    names
        .iter()
        .find_map(|name| args.get(*name).and_then(Value::as_u64))
        .map(|value| {
            u32::try_from(value).map_err(|_| format!("Argument out of range: {}", names[0]))
        })
        .transpose()?
        .ok_or_else(|| format!("Missing argument: {}", names[0]))
}

fn bool_arg(args: &Value, name: &str) -> Option<bool> {
    args.get(name).and_then(Value::as_bool)
}

fn bytes_arg(args: &Value, name: &str) -> Result<Vec<u8>, String> {
    let values = args
        .get(name)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("Missing argument: {name}"))?;
    values
        .iter()
        .map(|value| {
            let byte = value
                .as_u64()
                .ok_or_else(|| "Binary bytes must be an array of numbers".to_string())?;
            u8::try_from(byte).map_err(|_| "Binary byte value out of range".to_string())
        })
        .collect()
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn system_time_to_secs(value: SystemTime) -> u64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn note_to_dto(note: &NoteMetadata) -> NoteDto {
    NoteDto {
        id: note.id.0.clone(),
        path: note.path.0.to_string_lossy().to_string(),
        title: note.title.clone(),
        modified_at: note.modified_at,
        created_at: note.created_at,
    }
}

fn note_document_to_dto(note: &NoteDocument) -> NoteDto {
    let (modified_at, created_at) = get_file_times(&note.path.0);
    NoteDto {
        id: note.id.0.clone(),
        path: note.path.0.to_string_lossy().to_string(),
        title: note.title.clone(),
        modified_at,
        created_at,
    }
}

fn note_to_detail(note: &NoteDocument) -> NoteDetailDto {
    NoteDetailDto {
        id: note.id.0.clone(),
        path: note.path.0.to_string_lossy().to_string(),
        title: note.title.clone(),
        content: note.raw_markdown.clone(),
        tags: note.tags.clone(),
        links: note.links.iter().map(|link| link.target.clone()).collect(),
        frontmatter: note.frontmatter.clone(),
    }
}

fn get_file_times(path: &Path) -> (u64, u64) {
    let Ok(meta) = fs::metadata(path) else {
        return (0, 0);
    };
    let modified = meta.modified().map(system_time_to_secs).unwrap_or(0);
    let created = meta.created().map(system_time_to_secs).unwrap_or(modified);
    (modified, created)
}

fn build_vault_file_detail(vault: &Vault, relative_path: &str) -> Result<VaultFileDetail, String> {
    let content = vault
        .read_text_file(relative_path)
        .map_err(|error| error.to_string())?;
    let path = vault
        .resolve_scoped_path(relative_path, ScopedPathIntent::ReadExisting)
        .map_err(|error| error.to_string())?;
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    let entry = vault
        .read_vault_entry_from_path(&path)
        .map_err(|error| error.to_string())?;
    Ok(VaultFileDetail {
        path: path.to_string_lossy().to_string(),
        relative_path: relative_path.to_string(),
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_else(|| relative_path.to_string()),
        mime_type: entry.mime_type,
        content,
        size_bytes: metadata.len(),
        content_truncated: false,
    })
}

fn note_content_hash(content: &str) -> String {
    content_hash_bytes(content.as_bytes())
}

fn content_hash_bytes(bytes: &[u8]) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn path_has_extension(path: &Path, extension: &str) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
}

fn advance_revision(
    revisions: &mut HashMap<String, u64>,
    key: &str,
    previous_key: Option<&str>,
) -> u64 {
    let previous_revision = previous_key
        .filter(|previous| *previous != key)
        .and_then(|previous| revisions.remove(previous))
        .unwrap_or(0);
    let current_revision = revisions.get(key).copied().unwrap_or(0);
    let next_revision = previous_revision
        .max(current_revision)
        .saturating_add(1)
        .max(1);
    revisions.insert(key.to_string(), next_revision);
    next_revision
}

fn build_vault_note_change(
    vault_path: &str,
    kind: &str,
    note: Option<NoteDto>,
    note_id: Option<String>,
    entry: Option<VaultEntryDto>,
    relative_path: Option<String>,
    op_id: Option<String>,
    revision: u64,
    content_hash: Option<String>,
    graph_revision: u64,
) -> VaultNoteChangeDto {
    build_vault_note_change_with_origin(
        vault_path,
        kind,
        note,
        note_id,
        entry,
        relative_path,
        VAULT_CHANGE_ORIGIN_USER,
        op_id,
        revision,
        content_hash,
        graph_revision,
    )
}

fn build_vault_note_change_with_origin(
    vault_path: &str,
    kind: &str,
    note: Option<NoteDto>,
    note_id: Option<String>,
    entry: Option<VaultEntryDto>,
    relative_path: Option<String>,
    origin: &str,
    op_id: Option<String>,
    revision: u64,
    content_hash: Option<String>,
    graph_revision: u64,
) -> VaultNoteChangeDto {
    VaultNoteChangeDto {
        vault_path: vault_path.to_string(),
        kind: kind.to_string(),
        note,
        note_id,
        entry,
        relative_path,
        origin: origin.to_string(),
        op_id,
        revision,
        content_hash,
        graph_revision,
    }
}

fn note_change_from_document(
    vault_path: &str,
    note: &NoteDocument,
    relative_path: String,
    op_id: Option<String>,
    revision: u64,
    graph_revision: u64,
) -> VaultNoteChangeDto {
    build_vault_note_change(
        vault_path,
        "upsert",
        Some(note_document_to_dto(note)),
        Some(note.id.0.clone()),
        None,
        Some(relative_path),
        op_id,
        revision,
        Some(note_content_hash(&note.raw_markdown)),
        graph_revision,
    )
}

fn compute_tracked_file_patches(args: Value) -> Result<Value, String> {
    let inputs: Vec<ComputeLineDiffInput> = serde_json::from_value(
        args.get("inputs")
            .cloned()
            .unwrap_or(Value::Array(Vec::new())),
    )
    .map_err(|error| error.to_string())?;
    let patches: Vec<_> = inputs
        .into_iter()
        .map(|input| neverwrite_diff::compute_tracked_file_patch(&input.old_text, &input.new_text))
        .collect();
    Ok(json!(patches))
}

fn non_note_score(query: &str, entry: &VaultEntryDto) -> f64 {
    if query.is_empty() {
        return 0.0;
    }
    let title = entry.title.to_lowercase();
    let path = entry.relative_path.to_lowercase();
    score_substring(query, &title).max(score_substring(query, &path) * 0.85)
}

fn score_substring(query: &str, target: &str) -> f64 {
    target.find(query).map_or(0.0, |index| {
        1.0 / (1.0 + index as f64) + query.len() as f64 / target.len().max(1) as f64
    })
}

fn map_entry_from_vault_entry(entry: &VaultEntryDto) -> Option<MapEntryDto> {
    if !entry.extension.eq_ignore_ascii_case("excalidraw") {
        return None;
    }
    Some(MapEntryDto {
        id: entry.relative_path.clone(),
        title: entry.title.clone(),
        relative_path: entry.relative_path.clone(),
    })
}

fn markdown_note_id_from_relative_path(relative_path: &str) -> Option<String> {
    relative_path
        .to_lowercase()
        .ends_with(".md")
        .then(|| relative_path[..relative_path.len().saturating_sub(3)].to_string())
}

fn track_path_tree(write_tracker: &WriteTracker, path: &Path) {
    write_tracker.track_any(path.to_path_buf());
    let Ok(metadata) = fs::metadata(path) else {
        return;
    };
    if !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(path) else {
        return;
    };
    for entry in entries.flatten() {
        track_path_tree(write_tracker, &entry.path());
    }
}

fn track_moved_tree(write_tracker: &WriteTracker, source: &Path, target: &Path) {
    write_tracker.track_any(source.to_path_buf());
    write_tracker.track_any(target.to_path_buf());
    let Ok(metadata) = fs::metadata(source) else {
        return;
    };
    if !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(source) else {
        return;
    };
    for entry in entries.flatten() {
        let source_child = entry.path();
        let target_child = target.join(entry.file_name());
        track_moved_tree(write_tracker, &source_child, &target_child);
    }
}

fn track_copied_tree(write_tracker: &WriteTracker, source: &Path, target: &Path) {
    write_tracker.track_any(target.to_path_buf());
    let Ok(metadata) = fs::metadata(source) else {
        return;
    };
    if !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(source) else {
        return;
    };
    for entry in entries.flatten() {
        let source_child = entry.path();
        let target_child = target.join(entry.file_name());
        track_copied_tree(write_tracker, &source_child, &target_child);
    }
}

fn start_vault_watcher(
    root: &str,
    write_tracker: WriteTracker,
    backend_ref: &Arc<Mutex<NativeBackend>>,
) -> Result<RecommendedWatcher, String> {
    let vault_path = root.to_string();
    let backend_ref = Arc::downgrade(backend_ref);
    start_watcher(PathBuf::from(root), write_tracker, move |event| {
        let Some(backend_ref) = backend_ref.upgrade() else {
            return;
        };
        let mut backend = backend_ref.lock().unwrap();
        if let Err(error) = backend.handle_external_vault_event(&vault_path, event) {
            eprintln!("Failed to process vault watcher event: {error}");
        }
    })
    .map_err(|error| error.to_string())
}

fn suggestion_insert_text(note: &NoteMetadata) -> String {
    if note.title.trim().is_empty() {
        note.id
            .0
            .split('/')
            .next_back()
            .unwrap_or(&note.id.0)
            .trim_end_matches(".md")
            .to_string()
    } else {
        note.title.trim().to_string()
    }
}

fn write_output(output: &RpcOutput) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, output)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn main() {
    let stdin = io::stdin();
    let (event_tx, event_rx) = mpsc::channel::<RpcOutput>();
    thread::spawn(move || {
        for event in event_rx {
            if let Err(error) = write_output(&event) {
                eprintln!("Failed to write event: {error}");
                break;
            }
        }
    });
    let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                eprintln!("Failed to read request: {error}");
                continue;
            }
        };
        if line.trim().is_empty() {
            continue;
        }

        let request: Result<RpcRequest, _> = serde_json::from_str(&line);
        let output = match request {
            Ok(request) => {
                let id = request.id.clone();
                let result =
                    backend
                        .lock()
                        .unwrap()
                        .invoke(&request.command, request.args, &backend);
                match result {
                    Ok(result) => RpcOutput::Response {
                        id,
                        ok: true,
                        result: Some(result),
                        error: None,
                    },
                    Err(error) => RpcOutput::Response {
                        id,
                        ok: false,
                        result: None,
                        error: Some(error),
                    },
                }
            }
            Err(error) => RpcOutput::Response {
                id: Value::Null,
                ok: false,
                result: None,
                error: Some(format!("Invalid request: {error}")),
            },
        };

        if let Err(error) = write_output(&output) {
            eprintln!("Failed to write response: {error}");
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invoke(
        backend: &Arc<Mutex<NativeBackend>>,
        command: &str,
        args: Value,
    ) -> Result<Value, String> {
        backend.lock().unwrap().invoke(command, args, backend)
    }

    #[test]
    fn invokes_vault_editor_commands_without_electron() {
        let (event_tx, _event_rx) = mpsc::channel::<RpcOutput>();
        let backend = Arc::new(Mutex::new(NativeBackend::new(event_tx)));
        let vault_dir = tempfile::tempdir().unwrap();
        let notes_dir = vault_dir.path().join("Notes");
        fs::create_dir_all(&notes_dir).unwrap();
        fs::write(notes_dir.join("A.md"), "# Alpha\n\n[[B]] #tag-one\n").unwrap();
        fs::write(notes_dir.join("B.md"), "# Beta\n").unwrap();

        let vault_path = vault_dir.path().to_string_lossy().to_string();
        invoke(&backend, "start_open_vault", json!({ "path": vault_path })).unwrap();

        let notes = invoke(&backend, "list_notes", json!({ "vaultPath": vault_path })).unwrap();
        assert!(notes
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note.get("id").and_then(Value::as_str) == Some("Notes/A")));

        let backlinks = invoke(
            &backend,
            "get_backlinks",
            json!({ "vaultPath": vault_path, "noteId": "Notes/B" }),
        )
        .unwrap();
        assert!(backlinks
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note.get("id").and_then(Value::as_str) == Some("Notes/A")));

        let suggestions = invoke(
            &backend,
            "suggest_wikilinks",
            json!({
                "vaultPath": vault_path,
                "noteId": "Notes/A",
                "query": "Be",
                "limit": 8
            }),
        )
        .unwrap();
        assert!(suggestions
            .as_array()
            .unwrap()
            .iter()
            .any(|note| note.get("id").and_then(Value::as_str) == Some("Notes/B")));
    }
}
