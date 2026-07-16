use std::path::Path;

use neverwrite_ai::persistence::{self, PersistedSessionHistory};
use serde_json::{json, Value};

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
                let history: PersistedSessionHistory = serde_json::from_value(
                    args.get("history")
                        .cloned()
                        .ok_or_else(|| "Missing argument: history".to_string())?,
                )
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
                persistence::delete_session_history(&storage_root, &session_id)?;
                Ok(json!(null))
            }
            "ai_delete_all_session_histories" => {
                persistence::delete_all_session_histories(&storage_root)?;
                Ok(json!(null))
            }
            "ai_prune_session_histories" => {
                let max_age_days = required_u32(&args, &["maxAgeDays", "max_age_days"])?;
                Ok(json!(persistence::prune_expired_session_histories(
                    &storage_root,
                    max_age_days
                )?))
            }
            _ => Err(format!("Unsupported AI history command: {command}")),
        }
    }
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
