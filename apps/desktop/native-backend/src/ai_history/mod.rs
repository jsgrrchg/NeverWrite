use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use neverwrite_ai::persistence::{self, PersistedSessionHistory};
use serde_json::{json, Value};

mod attachments;
mod storage;

const COMMANDS: &[&str] = &[
    "ai_save_session_history",
    "ai_load_session_histories",
    "ai_load_session_history_page",
    "ai_search_session_content",
    "ai_fork_session_history",
    "ai_delete_session_history",
    "ai_delete_all_session_histories",
    "ai_prune_session_histories",
    "ai_create_managed_attachment",
    "ai_read_managed_attachment",
    "ai_delete_managed_attachment_if_unreferenced",
    "ai_resolve_managed_attachment_path",
];

#[derive(Debug, Default)]
pub(crate) struct AiHistoryStorageService;

impl AiHistoryStorageService {
    pub(crate) fn handles(command: &str) -> bool {
        COMMANDS.contains(&command)
    }

    pub(crate) fn invoke(
        &self,
        command: &str,
        vault_root: &Path,
        args: Value,
    ) -> Result<Value, String> {
        let storage_root = storage::vault_storage_root(vault_root);
        match command {
            "ai_save_session_history" => {
                let history_value = args.get("history")
                        .cloned()
                        .ok_or_else(|| "Missing argument: history".to_string())?;
                validate_managed_attachment_shapes(vault_root, &history_value)?;
                let history: PersistedSessionHistory = serde_json::from_value(history_value)
                .map_err(|error| error.to_string())?;
                persistence::save_session_history(&storage_root, &history)?;
                Ok(json!(null))
            }
            "ai_load_session_histories" => {
                let include_messages = bool_arg(&args, "includeMessages")
                    .or_else(|| bool_arg(&args, "include_messages"))
                    .unwrap_or(true);
                Ok(json!(persistence::load_all_session_histories(
                    &storage_root,
                    include_messages
                )?))
            }
            "ai_load_session_history_page" => {
                let session_id = required_string(&args, &["sessionId", "session_id"])?;
                let start_index = required_usize(&args, &["startIndex", "start_index"])?;
                let limit = required_usize(&args, &["limit"])?;
                Ok(json!(persistence::load_session_history_page(
                    &storage_root,
                    &session_id,
                    start_index,
                    limit
                )?))
            }
            "ai_search_session_content" => {
                let query = required_string(&args, &["query"])?;
                Ok(json!(persistence::search_session_content(
                    &storage_root,
                    &query
                )?))
            }
            "ai_fork_session_history" => {
                let source_session_id =
                    required_string(&args, &["sourceSessionId", "source_session_id"])?;
                Ok(json!(persistence::fork_session_history(
                    &storage_root,
                    &source_session_id
                )?))
            }
            "ai_delete_session_history" => {
                let session_id = required_string(&args, &["sessionId", "session_id"])?;
                let before = attachment_gc_snapshot(&storage_root);
                persistence::delete_session_history(&storage_root, &session_id)?;
                cleanup_removed_references(
                    vault_root,
                    before,
                    attachment_gc_snapshot(&storage_root),
                );
                Ok(json!(null))
            }
            "ai_delete_all_session_histories" => {
                let before = attachment_gc_snapshot(&storage_root);
                persistence::delete_all_session_histories(&storage_root)?;
                cleanup_removed_references(
                    vault_root,
                    before,
                    attachment_gc_snapshot(&storage_root),
                );
                Ok(json!(null))
            }
            "ai_prune_session_histories" => {
                let max_age_days = required_u32(&args, &["maxAgeDays", "max_age_days"])?;
                let before = attachment_gc_snapshot(&storage_root);
                let deleted =
                    persistence::prune_expired_session_histories(&storage_root, max_age_days)?;
                cleanup_removed_references(
                    vault_root,
                    before,
                    attachment_gc_snapshot(&storage_root),
                );
                Ok(json!(deleted))
            }
            "ai_create_managed_attachment" => {
                let file_name = required_string(&args, &["fileName", "file_name"])?;
                let mime_type = required_string(&args, &["mimeType", "mime_type"])?;
                let bytes: Vec<u8> = serde_json::from_value(
                    args.get("bytes")
                        .cloned()
                        .ok_or_else(|| "Missing argument: bytes".to_string())?,
                )
                .map_err(|error| format!("Invalid argument: bytes: {error}"))?;
                let metadata = attachments::create(vault_root, &file_name, &mime_type, &bytes)?;
                Ok(json!({
                    "attachment_id": metadata.attachment_id.as_str(),
                    "file_name": metadata.file_name,
                    "mime_type": metadata.mime_type,
                }))
            }
            "ai_read_managed_attachment" => {
                let attachment_id = required_managed_attachment_id(&args)?;
                let (metadata, bytes) = attachments::read(vault_root, &attachment_id)?;
                Ok(json!({
                    "attachment_id": metadata.attachment_id.as_str(),
                    "file_name": metadata.file_name,
                    "mime_type": metadata.mime_type,
                    "data_base64": BASE64_STANDARD.encode(bytes),
                }))
            }
            "ai_delete_managed_attachment_if_unreferenced" => {
                let attachment_id = required_managed_attachment_id(&args)?;
                let inventory = attachment_gc_snapshot(&storage_root);
                if !inventory.safe {
                    return Ok(json!({ "deleted": false, "protected": true }));
                }
                if inventory.all_ids().contains(attachment_id.as_str()) {
                    return Ok(json!({ "deleted": false, "protected": false }));
                }
                let deleted = attachments::delete_validated(vault_root, &attachment_id)?;
                Ok(json!({ "deleted": deleted, "protected": false }))
            }
            "ai_resolve_managed_attachment_path" => {
                let attachment_id = required_managed_attachment_id(&args)?;
                let resolved = attachments::resolve(vault_root, &attachment_id)?;
                Ok(json!({
                    "path": resolved.path,
                    "mime_type": resolved.metadata.mime_type,
                    "file_name": resolved.metadata.file_name,
                }))
            }
            _ => Err(format!("Unsupported AI history command: {command}")),
        }
    }
}

pub(crate) fn resolve_managed_attachment_for_runtime(
    vault_root: &Path,
    attachment_id: &str,
) -> Result<(Vec<u8>, String, String), String> {
    let attachment_id = attachments::ManagedAttachmentId::parse(attachment_id)?;
    let (metadata, bytes) = attachments::read(vault_root, &attachment_id)?;
    Ok((
        bytes,
        metadata.file_name,
        metadata.mime_type,
    ))
}

#[derive(Debug, Default)]
struct AttachmentGcSnapshot {
    safe: bool,
    ids_by_session: BTreeMap<String, BTreeSet<String>>,
}

impl AttachmentGcSnapshot {
    fn all_ids(&self) -> BTreeSet<String> {
        self.ids_by_session
            .values()
            .flat_map(|ids| ids.iter().cloned())
            .collect()
    }
}

fn attachment_gc_snapshot(storage_root: &Path) -> AttachmentGcSnapshot {
    let inventory = persistence::inspect_history_storage(storage_root);
    let histories = inventory.histories;
    let mut snapshot = AttachmentGcSnapshot {
        safe: histories.corrupt_artifacts.is_empty()
            && histories.read_errors.is_empty()
            && histories.unknown_entries.is_empty()
            && histories.duplicate_session_ids.is_empty()
            && histories.recoverable_states.is_empty(),
        ids_by_session: BTreeMap::new(),
    };
    for history in histories.sessions {
        let ids = snapshot
            .ids_by_session
            .entry(history.session_id)
            .or_default();
        for id in history.managed_attachment_ids {
            if attachments::ManagedAttachmentId::parse(&id).is_err() {
                snapshot.safe = false;
            }
            ids.insert(id);
        }
    }
    snapshot
}

fn cleanup_removed_references(
    vault_root: &Path,
    before: AttachmentGcSnapshot,
    after: AttachmentGcSnapshot,
) {
    if !before.safe || !after.safe {
        return;
    }
    let before_ids = before.all_ids();
    let after_ids = after.all_ids();
    for candidate in before_ids.difference(&after_ids) {
        let Ok(candidate) = attachments::ManagedAttachmentId::parse(candidate) else {
            continue;
        };
        attachments::delete_validated(vault_root, &candidate).ok();
    }
}

fn validate_managed_attachment_shapes(vault_root: &Path, history: &Value) -> Result<(), String> {
    let Some(messages) = history.get("messages").and_then(Value::as_array) else {
        return Ok(());
    };
    for attachment in messages
        .iter()
        .filter_map(|message| message.get("attachments").and_then(Value::as_array))
        .flatten()
    {
        let Some(id_value) = attachment.get("managedAttachmentId") else {
            continue;
        };
        let id = id_value
            .as_str()
            .ok_or_else(|| "Invalid managed attachment ID.".to_string())?;
        if attachment.get("type").and_then(Value::as_str) != Some("file")
            || ["path", "filePath", "content"]
                .iter()
                .any(|key| attachment.get(*key).is_some_and(|value| !value.is_null()))
        {
            return Err("Managed attachments cannot include paths or inline content.".to_string());
        }
        let id = attachments::ManagedAttachmentId::parse(id)?;
        let resolved = attachments::resolve(vault_root, &id)?;
        if attachment.get("fileName").and_then(Value::as_str)
            != Some(resolved.metadata.file_name.as_str())
            || attachment.get("mimeType").and_then(Value::as_str)
                != Some(resolved.metadata.mime_type.as_str())
        {
            return Err("Managed attachment metadata does not match its blob.".to_string());
        }
    }
    Ok(())
}

fn required_managed_attachment_id(
    args: &Value,
) -> Result<attachments::ManagedAttachmentId, String> {
    let value = required_string(args, &["attachmentId", "attachment_id"])?;
    attachments::ManagedAttachmentId::parse(&value)
}

fn required_string(args: &Value, names: &[&str]) -> Result<String, String> {
    names
        .iter()
        .find_map(|name| args.get(*name).and_then(Value::as_str))
        .map(str::to_string)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("Missing argument: {}", names[0]))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nmanaged-image";

    fn create_attachment(service: &AiHistoryStorageService, vault: &Path) -> String {
        service
            .invoke(
                "ai_create_managed_attachment",
                vault,
                json!({
                    "fileName": "pasted-image.png",
                    "mimeType": "image/png",
                    "bytes": PNG,
                }),
            )
            .unwrap()["attachment_id"]
            .as_str()
            .unwrap()
            .to_string()
    }

    fn history(session_id: &str, attachment_id: &str, updated_at: u64) -> Value {
        json!({
            "version": 1,
            "session_id": session_id,
            "runtime_id": "codex-acp",
            "model_id": "test-model",
            "mode_id": "default",
            "created_at": 1,
            "updated_at": updated_at,
            "messages": [{
                "id": format!("message-{session_id}"),
                "role": "user",
                "kind": "text",
                "content": "Inspect this",
                "timestamp": updated_at,
                "attachments": [{
                    "id": format!("ui-{session_id}"),
                    "type": "file",
                    "noteId": null,
                    "label": "Screenshot",
                    "path": null,
                    "managedAttachmentId": attachment_id,
                    "fileName": "pasted-image.png",
                    "mimeType": "image/png"
                }]
            }]
        })
    }

    fn save_history(
        service: &AiHistoryStorageService,
        vault: &Path,
        session_id: &str,
        attachment_id: &str,
        updated_at: u64,
    ) {
        service
            .invoke(
                "ai_save_session_history",
                vault,
                json!({
                    "history": history(session_id, attachment_id, updated_at),
                }),
            )
            .unwrap();
    }

    #[test]
    fn shared_managed_blobs_survive_until_the_last_history_reference_is_deleted() {
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService;
        let attachment_id = create_attachment(&service, vault.path());
        save_history(&service, vault.path(), "first", &attachment_id, 10);
        save_history(&service, vault.path(), "second", &attachment_id, 20);

        service
            .invoke(
                "ai_delete_session_history",
                vault.path(),
                json!({ "sessionId": "first" }),
            )
            .unwrap();
        assert!(service
            .invoke(
                "ai_read_managed_attachment",
                vault.path(),
                json!({ "attachmentId": attachment_id }),
            )
            .is_ok());

        service
            .invoke(
                "ai_delete_session_history",
                vault.path(),
                json!({ "sessionId": "second" }),
            )
            .unwrap();
        assert!(service
            .invoke(
                "ai_read_managed_attachment",
                vault.path(),
                json!({ "attachmentId": attachment_id }),
            )
            .is_err());
    }

    #[test]
    fn save_rejects_managed_attachments_that_also_contain_a_physical_path() {
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService;
        let attachment_id = create_attachment(&service, vault.path());
        let mut payload = history("session", &attachment_id, 10);
        payload["messages"][0]["attachments"][0]["filePath"] =
            json!("/tmp/should-not-persist.png");

        let error = service
            .invoke(
                "ai_save_session_history",
                vault.path(),
                json!({ "history": payload }),
            )
            .unwrap_err();

        assert!(error.contains("cannot include paths"));
    }

    #[test]
    fn corrupt_history_protects_managed_blobs_from_cleanup() {
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService;
        let attachment_id = create_attachment(&service, vault.path());
        fs::create_dir_all(vault.path().join(".neverwrite/sessions")).unwrap();
        fs::write(
            vault.path().join(".neverwrite/sessions/broken.json"),
            b"{broken",
        )
        .unwrap();

        let cleanup = service
            .invoke(
                "ai_delete_managed_attachment_if_unreferenced",
                vault.path(),
                json!({ "attachmentId": attachment_id }),
            )
            .unwrap();
        assert_eq!(cleanup["deleted"], false);
        assert_eq!(cleanup["protected"], true);
        assert!(service
            .invoke(
                "ai_read_managed_attachment",
                vault.path(),
                json!({ "attachmentId": attachment_id }),
            )
            .is_ok());
    }

    #[test]
    fn delete_all_removes_only_referenced_managed_blobs_and_preserves_generic_chat_assets() {
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService;
        let attachment_id = create_attachment(&service, vault.path());
        save_history(&service, vault.path(), "session", &attachment_id, 10);
        let generic_asset = vault.path().join("assets/chat/keep.png");
        fs::write(&generic_asset, PNG).unwrap();

        service
            .invoke("ai_delete_all_session_histories", vault.path(), json!({}))
            .unwrap();

        assert!(generic_asset.exists());
        assert!(service
            .invoke(
                "ai_read_managed_attachment",
                vault.path(),
                json!({ "attachmentId": attachment_id }),
            )
            .is_err());
    }

    #[test]
    fn pruning_removes_blobs_only_after_their_last_expired_reference() {
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService;
        let attachment_id = create_attachment(&service, vault.path());
        save_history(&service, vault.path(), "expired", &attachment_id, 1);

        let deleted = service
            .invoke(
                "ai_prune_session_histories",
                vault.path(),
                json!({ "maxAgeDays": 1 }),
            )
            .unwrap();

        assert_eq!(deleted, 1);
        assert!(service
            .invoke(
                "ai_read_managed_attachment",
                vault.path(),
                json!({ "attachmentId": attachment_id }),
            )
            .is_err());
    }
}
