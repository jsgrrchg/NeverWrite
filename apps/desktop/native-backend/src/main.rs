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

const VAULT_CHANGE_ORIGIN_USER: &str = "user";
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
enum RpcOutput {
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
    event_tx: Sender<RpcOutput>,
}

impl NativeBackend {
    fn new(event_tx: Sender<RpcOutput>) -> Self {
        Self {
            vaults: HashMap::new(),
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
        let (_vault_path, state) = self.state_mut(&args)?;
        let (path, entry) = state
            .vault
            .save_binary_file(&relative_dir, &file_name, &bytes)
            .map_err(|error| error.to_string())?;
        state.write_tracker.track_any(path);
        let detail = SavedBinaryFileDetail {
            path: entry.path.clone(),
            relative_path: entry.relative_path.clone(),
            file_name: entry.file_name.clone(),
            mime_type: entry.mime_type.clone(),
        };
        Self::refresh_vault_state(state)?;
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
        if !path.exists() || !path.is_file() {
            return Ok(());
        }

        let relative_path = state.vault.path_to_relative_path(&path);
        Self::refresh_vault_state(state)?;
        let graph_revision = state.graph_revision.max(1);
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
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
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
