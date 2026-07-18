use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use neverwrite_ai::persistence::{
    self, InspectedHistory, PersistedSessionHistory, StorageInventory,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::attachments::ManagedAttachmentId;

const JOURNAL_VERSION: u32 = 1;
const JOURNAL_FILE: &str = "journal.json";
const TEMP_JOURNAL_FILE: &str = ".journal.json.tmp";
const WITHDRAWN_MARKER_FILE: &str = "withdrawn";
const STAGE_PREFIX: &str = ".ai-history-stage-";
const BACKUP_PREFIX: &str = ".ai-history-backup-";
const QUARANTINE_PREFIX: &str = ".ai-history-source-";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct MigrationJournal {
    version: u32,
    operation_id: String,
    source: PathBuf,
    destination: PathBuf,
    stage: PathBuf,
    destination_backup: PathBuf,
    source_quarantine: PathBuf,
    source_fingerprint: String,
    destination_fingerprint: String,
    staged_fingerprint: String,
    source_existed: bool,
    destination_existed: bool,
    source_managed: PathBuf,
    destination_managed: PathBuf,
    managed_stage: PathBuf,
    managed_destination_backup: PathBuf,
    managed_source_quarantine: PathBuf,
    source_managed_fingerprint: String,
    destination_managed_fingerprint: String,
    staged_managed_fingerprint: String,
    source_managed_existed: bool,
    destination_managed_existed: bool,
    legacy_withdrawals: Vec<LegacyWithdrawal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyWithdrawal {
    source: PathBuf,
    quarantine: PathBuf,
    owned_root: PathBuf,
    fingerprint: String,
}

#[derive(Debug, Clone)]
struct LegacyCandidate {
    owned_root: PathBuf,
    fingerprint: String,
}

#[derive(Debug, Clone)]
pub(super) struct RootLayout {
    pub histories: PathBuf,
    pub managed: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReconcileResult {
    pub histories_moved: usize,
    pub attachments_moved: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Failpoint {
    BeforePublish,
    AfterPrepared,
    AfterHistoryPublished,
    AfterManagedPublished,
    AfterDestinationPublished,
    BeforeSourceWithdrawal,
    AfterHistoryWithdrawn,
    AfterManagedWithdrawn,
    AfterLegacyWithdrawn,
    AfterSourceWithdrawn,
    AfterSourceDeleted,
    BeforeCommit,
    AfterCommit,
    AfterCommitted,
}

pub(super) trait FailureInjector {
    fn check(&mut self, point: Failpoint) -> Result<(), String>;
}

struct NoFailures;

impl FailureInjector for NoFailures {
    fn check(&mut self, _point: Failpoint) -> Result<(), String> {
        Ok(())
    }
}

pub(super) fn reconcile(
    app_data_root: &Path,
    source: &RootLayout,
    destination: &RootLayout,
) -> Result<ReconcileResult, String> {
    reconcile_with_failures(app_data_root, source, destination, &mut NoFailures)
}

pub(super) fn reconcile_with_failures(
    app_data_root: &Path,
    source: &RootLayout,
    destination: &RootLayout,
    failures: &mut dyn FailureInjector,
) -> Result<ReconcileResult, String> {
    ensure_managed_parent(&source.managed)?;
    ensure_managed_parent(&destination.managed)?;
    let source_history = normalize_transaction_root(&source.histories)?;
    let destination_history = normalize_transaction_root(&destination.histories)?;
    let source_managed = normalize_managed_root(&source.managed)?;
    let destination_managed = normalize_managed_root(&destination.managed)?;
    let source = source_history.as_path();
    let destination = destination_history.as_path();
    validate_all_roots(&[
        &source_history,
        &source_managed,
        &destination_history,
        &destination_managed,
    ])?;
    recover_pending(app_data_root)?;

    let source_fingerprint = transaction_fingerprint(source)?;
    let destination_fingerprint = transaction_fingerprint(destination)?;
    let source_managed_fingerprint = transaction_fingerprint(&source_managed)?;
    let destination_managed_fingerprint = transaction_fingerprint(&destination_managed)?;
    let source_managed_existed = source_managed.exists();
    let destination_managed_existed = destination_managed.exists();

    let source_inventory = inspect_root(source)?;
    let destination_inventory = inspect_root(destination)?;
    ensure_safe_inventory("source", &source_inventory)?;
    ensure_safe_inventory("destination", &destination_inventory)?;
    let merge = classify_merge(&source_inventory, &destination_inventory)?;
    let mut attachment_ids = classify_attachments(&source_managed, &destination_managed)?;

    let operation_id = uuid::Uuid::new_v4().simple().to_string();
    let destination_parent = required_parent(destination)?;
    fs::create_dir_all(destination_parent).map_err(|error| error.to_string())?;
    let stage = destination_parent.join(format!("{STAGE_PREFIX}{operation_id}"));
    let destination_backup = destination_parent.join(format!("{BACKUP_PREFIX}{operation_id}"));
    let source_parent = required_parent(source)?;
    let source_quarantine = source_parent.join(format!("{QUARANTINE_PREFIX}{operation_id}"));
    let managed_destination_parent = required_parent(&destination_managed)?;
    let managed_source_parent = required_parent(&source_managed)?;
    let managed_stage = managed_destination_parent.join(format!("{STAGE_PREFIX}{operation_id}"));
    let managed_destination_backup =
        managed_destination_parent.join(format!("{BACKUP_PREFIX}{operation_id}"));
    let managed_source_quarantine =
        managed_source_parent.join(format!("{QUARANTINE_PREFIX}{operation_id}"));
    reject_existing_transaction_path(&stage)?;
    reject_existing_transaction_path(&destination_backup)?;
    reject_existing_transaction_path(&source_quarantine)?;
    reject_existing_transaction_path(&managed_stage)?;
    reject_existing_transaction_path(&managed_destination_backup)?;
    reject_existing_transaction_path(&managed_source_quarantine)?;

    build_managed_stage(
        &source_managed,
        &destination_managed,
        &managed_stage,
        attachment_ids.keys(),
    )?;
    let (converted_sessions, legacy_files) = build_stage(
        source,
        destination,
        &stage,
        &merge,
        &managed_stage,
        &mut attachment_ids,
    )?;
    let staged_inventory = inspect_root(&stage)?;
    ensure_safe_inventory("staging", &staged_inventory)?;
    ensure_staged_merge(&merge, &converted_sessions, &staged_inventory)?;
    ensure_staged_attachments(&managed_stage, &attachment_ids)?;

    assert_unchanged(source, &source_fingerprint, "source")?;
    assert_unchanged(destination, &destination_fingerprint, "destination")?;

    let staged_fingerprint = transaction_fingerprint(&stage)?;
    let staged_managed_fingerprint = transaction_fingerprint(&managed_stage)?;
    let legacy_withdrawals = legacy_files
        .into_iter()
        .enumerate()
        .map(|(index, (source, candidate))| {
            let quarantine = required_parent(&source)?
                .join(format!(".ai-history-legacy-{}-{index}", operation_id));
            reject_existing_transaction_path(&quarantine)?;
            Ok(LegacyWithdrawal {
                fingerprint: candidate.fingerprint,
                source,
                quarantine,
                owned_root: candidate.owned_root,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let journal = MigrationJournal {
        version: JOURNAL_VERSION,
        operation_id,
        source: source.to_path_buf(),
        destination: destination.to_path_buf(),
        stage,
        destination_backup,
        source_quarantine,
        source_fingerprint,
        destination_fingerprint,
        staged_fingerprint,
        source_existed: source_inventory.histories.storage_root_exists,
        destination_existed: destination_inventory.histories.storage_root_exists,
        source_managed: source_managed.clone(),
        destination_managed: destination_managed.clone(),
        managed_stage,
        managed_destination_backup,
        managed_source_quarantine,
        source_managed_fingerprint,
        destination_managed_fingerprint,
        staged_managed_fingerprint,
        source_managed_existed,
        destination_managed_existed,
        legacy_withdrawals,
    };
    persist_journal(app_data_root, &journal)?;
    failures.check(Failpoint::AfterPrepared)?;
    failures.check(Failpoint::BeforePublish)?;

    if let Err(error) = assert_source_unchanged(&journal).and_then(|()| {
        assert_component_original(journal.history_component())?;
        assert_component_original(journal.managed_component())
    }) {
        rollback_transaction(&journal)?;
        remove_journal(app_data_root, &journal)?;
        return Err(error);
    }
    drive_prepared_transaction(&journal, app_data_root, failures)?;
    failures.check(Failpoint::AfterDestinationPublished)?;
    failures.check(Failpoint::BeforeSourceWithdrawal)?;

    if let Err(error) = assert_source_unchanged(&journal) {
        rollback_transaction(&journal)?;
        remove_journal(app_data_root, &journal)?;
        return Err(error);
    }
    withdraw_source(&journal, failures)?;
    failures.check(Failpoint::AfterSourceWithdrawn)?;

    failures.check(Failpoint::BeforeCommit)?;
    mark_withdrawn(app_data_root, &journal)?;
    failures.check(Failpoint::AfterCommit)?;
    finish_critical_cleanup(&journal, failures)?;
    failures.check(Failpoint::AfterCommitted)?;
    remove_journal(app_data_root, &journal)?;

    Ok(ReconcileResult {
        histories_moved: merge.len(),
        attachments_moved: attachment_ids.len(),
    })
}

pub(super) fn recover_pending(app_data_root: &Path) -> Result<(), String> {
    let Some(journal) = load_journal(app_data_root)? else {
        return Ok(());
    };
    validate_journal(&journal)?;
    if withdrawn_marker_path(app_data_root).exists() {
        assert_published_destination(&journal)?;
        finish_critical_cleanup(&journal, &mut NoFailures)?;
        remove_journal(app_data_root, &journal)?;
        return Ok(());
    }
    if withdrawal_started(&journal) {
        assert_published_destination(&journal)?;
        withdraw_source(&journal, &mut NoFailures)?;
        mark_withdrawn(app_data_root, &journal)?;
        finish_critical_cleanup(&journal, &mut NoFailures)?;
        remove_journal(app_data_root, &journal)?;
        return Ok(());
    }
    if let Err(error) = assert_source_unchanged(&journal) {
        rollback_transaction(&journal)?;
        remove_journal(app_data_root, &journal)?;
        return Err(error);
    }
    drive_prepared_transaction(&journal, app_data_root, &mut NoFailures)?;
    assert_source_unchanged(&journal)?;
    withdraw_source(&journal, &mut NoFailures)?;
    mark_withdrawn(app_data_root, &journal)?;
    finish_critical_cleanup(&journal, &mut NoFailures)?;
    remove_journal(app_data_root, &journal)?;
    Ok(())
}

fn inspect_root(root: &Path) -> Result<StorageInventory, String> {
    let inventory = persistence::inspect_history_storage(root);
    if let Some(entry) = inventory.histories.unknown_entries.first() {
        return Err(format!(
            "Unknown AI history artifact at {}.",
            entry.relative_path
        ));
    }
    Ok(inventory)
}

fn ensure_safe_inventory(label: &str, inventory: &StorageInventory) -> Result<(), String> {
    let histories = &inventory.histories;
    if !histories.corrupt_artifacts.is_empty()
        || !histories.read_errors.is_empty()
        || !histories.duplicate_session_ids.is_empty()
        || !histories.recoverable_states.is_empty()
    {
        return Err(format!(
            "The {label} AI history root is not safe to reconcile."
        ));
    }
    Ok(())
}

fn classify_merge(
    source: &StorageInventory,
    destination: &StorageInventory,
) -> Result<BTreeMap<String, MergeSource>, String> {
    let mut merged = BTreeMap::new();
    for history in &destination.histories.sessions {
        merged.insert(
            history.session_id.clone(),
            MergeSource::Destination(history.clone()),
        );
    }
    for history in &source.histories.sessions {
        match merged.get(&history.session_id) {
            None => {
                merged.insert(
                    history.session_id.clone(),
                    MergeSource::Source(history.clone()),
                );
            }
            Some(existing)
                if existing.history().content_fingerprint == history.content_fingerprint => {}
            Some(_) => {
                return Err(format!(
                    "Session {} differs between AI history roots.",
                    history.session_id
                ));
            }
        }
    }
    Ok(merged)
}

#[derive(Debug)]
enum MergeSource {
    Source(InspectedHistory),
    Destination(InspectedHistory),
}

impl MergeSource {
    fn history(&self) -> &InspectedHistory {
        match self {
            Self::Source(history) | Self::Destination(history) => history,
        }
    }
}

fn build_stage(
    source: &Path,
    destination: &Path,
    stage: &Path,
    merge: &BTreeMap<String, MergeSource>,
    managed_stage: &Path,
    attachments_by_id: &mut BTreeMap<ManagedAttachmentId, Vec<u8>>,
) -> Result<(BTreeSet<String>, BTreeMap<PathBuf, LegacyCandidate>), String> {
    create_private_dir(stage)?;
    let source_histories = load_histories_strict(source)?;
    let destination_histories = load_histories_strict(destination)?;
    let mut by_source = source_histories
        .into_iter()
        .map(|history| (history.session_id.clone(), history))
        .collect::<BTreeMap<_, _>>();
    let mut by_destination = destination_histories
        .into_iter()
        .map(|history| (history.session_id.clone(), history))
        .collect::<BTreeMap<_, _>>();
    let mut converted_sessions = BTreeSet::new();
    let mut legacy_files = BTreeMap::new();
    for (session_id, selected) in merge {
        let (history, owner_root) = match selected {
            MergeSource::Source(_) => (by_source.remove(session_id), source),
            MergeSource::Destination(_) => (by_destination.remove(session_id), destination),
        };
        let mut history =
            history.ok_or_else(|| format!("Could not load inspected session {session_id}."))?;
        if convert_legacy_attachments(
            &mut history,
            owner_root,
            managed_stage,
            attachments_by_id,
            &mut legacy_files,
        )? {
            converted_sessions.insert(session_id.clone());
        }
        persistence::save_session_history(stage, &history)?;
    }
    sync_tree(stage)?;
    sync_directory(stage)?;
    Ok((converted_sessions, legacy_files))
}

fn load_histories_strict(root: &Path) -> Result<Vec<PersistedSessionHistory>, String> {
    let histories = persistence::load_all_session_histories(root, true)?;
    let inventory = persistence::inspect_history_storage(root);
    if histories.len() != inventory.histories.sessions.len() {
        return Err("Strict inventory and loaded history count differ.".into());
    }
    Ok(histories)
}

fn convert_legacy_attachments(
    history: &mut PersistedSessionHistory,
    history_root: &Path,
    managed_stage: &Path,
    attachments_by_id: &mut BTreeMap<ManagedAttachmentId, Vec<u8>>,
    legacy_files: &mut BTreeMap<PathBuf, LegacyCandidate>,
) -> Result<bool, String> {
    let legacy_root = required_parent(history_root)?.join("assets/chat");
    let Some(canonical_legacy_root) = canonical_directory_if_present(&legacy_root)? else {
        return Ok(false);
    };
    let mut converted = false;
    for message in &mut history.messages {
        if let Some(attachments) = &mut message.attachments {
            converted |= convert_legacy_attachment_value(
                attachments,
                &canonical_legacy_root,
                managed_stage,
                attachments_by_id,
                legacy_files,
            )?;
        }
    }
    Ok(converted)
}

fn convert_legacy_attachment_value(
    value: &mut serde_json::Value,
    legacy_root: &Path,
    managed_stage: &Path,
    attachments_by_id: &mut BTreeMap<ManagedAttachmentId, Vec<u8>>,
    legacy_files: &mut BTreeMap<PathBuf, LegacyCandidate>,
) -> Result<bool, String> {
    match value {
        serde_json::Value::Array(values) => {
            let mut converted = false;
            for value in values {
                converted |= convert_legacy_attachment_value(
                    value,
                    legacy_root,
                    managed_stage,
                    attachments_by_id,
                    legacy_files,
                )?;
            }
            Ok(converted)
        }
        serde_json::Value::Object(object) => {
            if object.contains_key("managedAttachmentId") {
                return Ok(false);
            }
            let file_path = object
                .get("filePath")
                .or_else(|| object.get("file_path"))
                .and_then(serde_json::Value::as_str)
                .map(str::to_string);
            if let Some(file_path) = file_path {
                let path = PathBuf::from(&file_path);
                if path.is_absolute() && path.exists() {
                    let metadata =
                        fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
                    if metadata.file_type().is_symlink() || !metadata.file_type().is_file() {
                        return Err("Legacy owned attachment is not a regular file.".into());
                    }
                    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
                    if canonical.starts_with(legacy_root) {
                        let bytes = fs::read(&canonical).map_err(|error| error.to_string())?;
                        let file_name = object
                            .get("fileName")
                            .or_else(|| object.get("file_name"))
                            .and_then(serde_json::Value::as_str)
                            .or_else(|| canonical.file_name().and_then(|name| name.to_str()))
                            .ok_or_else(|| "Legacy attachment has no safe file name.".to_string())?
                            .to_string();
                        let mime_type = object
                            .get("mimeType")
                            .or_else(|| object.get("mime_type"))
                            .and_then(serde_json::Value::as_str)
                            .ok_or_else(|| "Legacy attachment has no MIME type.".to_string())?
                            .to_string();
                        let attachment_id = write_converted_managed_attachment(
                            managed_stage,
                            &file_name,
                            &mime_type,
                            &bytes,
                        )?;
                        let fingerprint = format!("{:x}", Sha256::digest(&bytes));
                        attachments_by_id.insert(attachment_id.clone(), bytes);
                        legacy_files.insert(
                            canonical,
                            LegacyCandidate {
                                owned_root: legacy_root.to_path_buf(),
                                fingerprint,
                            },
                        );
                        object.remove("filePath");
                        object.remove("file_path");
                        object.insert(
                            "managedAttachmentId".into(),
                            serde_json::Value::String(attachment_id.as_str().to_string()),
                        );
                        return Ok(true);
                    }
                }
            }
            let mut converted = false;
            for nested in object.values_mut() {
                converted |= convert_legacy_attachment_value(
                    nested,
                    legacy_root,
                    managed_stage,
                    attachments_by_id,
                    legacy_files,
                )?;
            }
            Ok(converted)
        }
        _ => Ok(false),
    }
}

fn write_converted_managed_attachment(
    managed_stage: &Path,
    file_name: &str,
    mime_type: &str,
    bytes: &[u8],
) -> Result<ManagedAttachmentId, String> {
    if bytes.is_empty() || !mime_type.starts_with("image/") {
        return Err("Legacy owned attachment is not a supported image.".into());
    }
    let attachment_id = loop {
        let candidate =
            ManagedAttachmentId::parse(&format!("ma_{}", uuid::Uuid::new_v4().simple()))?;
        if !managed_stage.join(candidate.as_str()).exists() {
            break candidate;
        }
    };
    let directory = managed_stage.join(attachment_id.as_str());
    create_private_dir(&directory)?;
    write_new_file(&directory.join("blob"), bytes)?;
    let metadata = serde_json::json!({
        "version": 1,
        "attachment_id": attachment_id.as_str(),
        "file_name": file_name,
        "mime_type": mime_type,
        "size_bytes": bytes.len(),
        "sha256": format!("{:x}", Sha256::digest(bytes)),
    });
    write_new_file(
        &directory.join("metadata.json"),
        &serde_json::to_vec(&metadata).map_err(|error| error.to_string())?,
    )?;
    write_new_file(&directory.join("committed"), b"legacy-conversion")?;
    sync_directory(&directory)?;
    Ok(attachment_id)
}

fn canonical_directory_if_present(path: &Path) -> Result<Option<PathBuf>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(Some(
            path.canonicalize().map_err(|error| error.to_string())?,
        )),
        Ok(_) => Err("Legacy attachment root is not a regular directory.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn inspect_managed_attachments(
    managed_root: &Path,
) -> Result<BTreeMap<ManagedAttachmentId, Vec<u8>>, String> {
    let metadata = match fs::symlink_metadata(managed_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_dir() {
        return Err("Managed attachment root is not a regular directory.".into());
    }
    let mut attachments_by_id = BTreeMap::new();
    for entry in fs::read_dir(managed_root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Managed attachment name is not UTF-8.".to_string())?;
        let attachment_id = ManagedAttachmentId::parse(&name)?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if !metadata.file_type().is_dir() {
            return Err(format!(
                "Managed attachment {name} is not a regular directory."
            ));
        }
        let bytes = inspect_managed_attachment_directory(&entry.path(), &attachment_id)?;
        attachments_by_id.insert(attachment_id, bytes);
    }
    Ok(attachments_by_id)
}

fn inspect_managed_attachment_directory(
    directory: &Path,
    attachment_id: &ManagedAttachmentId,
) -> Result<Vec<u8>, String> {
    let mut names = BTreeMap::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| "Managed attachment artifact name is not UTF-8.".to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if !metadata.file_type().is_file()
            || !matches!(name.as_str(), "blob" | "metadata.json" | "committed")
        {
            return Err(format!("Unsafe managed attachment artifact: {name}."));
        }
        names.insert(name, entry.path());
    }
    let blob_path = names
        .get("blob")
        .ok_or_else(|| "Managed attachment is missing its blob.".to_string())?;
    let metadata_path = names
        .get("metadata.json")
        .ok_or_else(|| "Managed attachment is missing metadata.".to_string())?;
    let blob = fs::read(blob_path).map_err(|error| error.to_string())?;
    let metadata_bytes = fs::read(metadata_path).map_err(|error| error.to_string())?;
    if metadata_bytes.len() > 64 * 1024 {
        return Err("Managed attachment metadata is too large.".into());
    }
    let metadata: serde_json::Value =
        serde_json::from_slice(&metadata_bytes).map_err(|error| error.to_string())?;
    let expected_sha = format!("{:x}", Sha256::digest(&blob));
    if metadata.get("version").and_then(serde_json::Value::as_u64) != Some(1)
        || metadata
            .get("attachment_id")
            .and_then(serde_json::Value::as_str)
            != Some(attachment_id.as_str())
        || metadata
            .get("size_bytes")
            .and_then(serde_json::Value::as_u64)
            != Some(blob.len() as u64)
        || metadata.get("sha256").and_then(serde_json::Value::as_str) != Some(expected_sha.as_str())
    {
        return Err(format!(
            "Managed attachment {} failed metadata validation.",
            attachment_id.as_str()
        ));
    }
    Ok(blob)
}

fn classify_attachments(
    source_managed: &Path,
    destination_managed: &Path,
) -> Result<BTreeMap<ManagedAttachmentId, Vec<u8>>, String> {
    let source_attachments = inspect_managed_attachments(source_managed)?;
    let destination_attachments = inspect_managed_attachments(destination_managed)?;
    for (attachment_id, source_bytes) in &source_attachments {
        if let Some(destination_bytes) = destination_attachments.get(attachment_id) {
            if destination_bytes != source_bytes {
                return Err(format!(
                    "Managed attachment {} differs between AI history roots.",
                    attachment_id.as_str()
                ));
            }
        }
    }
    let mut merged = destination_attachments;
    merged.extend(source_attachments);
    Ok(merged)
}

fn build_managed_stage<'a>(
    source_managed: &Path,
    destination_managed: &Path,
    managed_stage: &Path,
    attachment_ids: impl Iterator<Item = &'a ManagedAttachmentId>,
) -> Result<(), String> {
    create_private_dir(managed_stage)?;
    for attachment_id in attachment_ids {
        let source_dir = source_managed.join(attachment_id.as_str());
        let destination_dir = destination_managed.join(attachment_id.as_str());
        let selected = if source_dir.exists() {
            source_dir
        } else {
            destination_dir
        };
        let target = managed_stage.join(attachment_id.as_str());
        copy_regular_tree(&selected, &target)?;
    }
    sync_tree(managed_stage)?;
    sync_directory(managed_stage)
}

fn ensure_staged_merge(
    merge: &BTreeMap<String, MergeSource>,
    converted_sessions: &BTreeSet<String>,
    staged: &StorageInventory,
) -> Result<(), String> {
    let staged_by_id = staged
        .histories
        .sessions
        .iter()
        .map(|history| (history.session_id.as_str(), history))
        .collect::<BTreeMap<_, _>>();
    if staged_by_id.len() != merge.len() {
        return Err("Staged history count does not match the planned merge.".into());
    }
    for (session_id, selected) in merge {
        let staged_history = staged_by_id
            .get(session_id.as_str())
            .ok_or_else(|| format!("Staging is missing session {session_id}."))?;
        if !converted_sessions.contains(session_id)
            && staged_history.content_fingerprint != selected.history().content_fingerprint
        {
            return Err(format!("Staged session {session_id} failed validation."));
        }
    }
    Ok(())
}

fn ensure_staged_attachments(
    stage: &Path,
    expected: &BTreeMap<ManagedAttachmentId, Vec<u8>>,
) -> Result<(), String> {
    let actual = inspect_managed_attachments(stage)?;
    if &actual != expected {
        return Err("Staged managed attachment inventory does not match the planned merge.".into());
    }
    Ok(())
}

fn drive_prepared_transaction(
    journal: &MigrationJournal,
    app_data_root: &Path,
    failures: &mut dyn FailureInjector,
) -> Result<(), String> {
    if let Err(error) = drive_component(journal.history_component()) {
        rollback_component(journal.managed_component())?;
        rollback_component(journal.history_component())?;
        remove_journal(app_data_root, journal)?;
        return Err(error);
    }
    failures.check(Failpoint::AfterHistoryPublished)?;
    if let Err(error) = drive_component(journal.managed_component()) {
        rollback_component(journal.managed_component())?;
        rollback_component(journal.history_component())?;
        remove_journal(app_data_root, journal)?;
        return Err(error);
    }
    failures.check(Failpoint::AfterManagedPublished)?;
    Ok(())
}

#[derive(Clone, Copy)]
struct TransactionComponent<'a> {
    source: &'a Path,
    destination: &'a Path,
    stage: &'a Path,
    backup: &'a Path,
    quarantine: &'a Path,
    source_fingerprint: &'a str,
    destination_fingerprint: &'a str,
    staged_fingerprint: &'a str,
    source_existed: bool,
    destination_existed: bool,
}

impl MigrationJournal {
    fn history_component(&self) -> TransactionComponent<'_> {
        TransactionComponent {
            source: &self.source,
            destination: &self.destination,
            stage: &self.stage,
            backup: &self.destination_backup,
            quarantine: &self.source_quarantine,
            source_fingerprint: &self.source_fingerprint,
            destination_fingerprint: &self.destination_fingerprint,
            staged_fingerprint: &self.staged_fingerprint,
            source_existed: self.source_existed,
            destination_existed: self.destination_existed,
        }
    }

    fn managed_component(&self) -> TransactionComponent<'_> {
        TransactionComponent {
            source: &self.source_managed,
            destination: &self.destination_managed,
            stage: &self.managed_stage,
            backup: &self.managed_destination_backup,
            quarantine: &self.managed_source_quarantine,
            source_fingerprint: &self.source_managed_fingerprint,
            destination_fingerprint: &self.destination_managed_fingerprint,
            staged_fingerprint: &self.staged_managed_fingerprint,
            source_existed: self.source_managed_existed,
            destination_existed: self.destination_managed_existed,
        }
    }
}

fn drive_component(component: TransactionComponent<'_>) -> Result<(), String> {
    if fingerprint_matches(component.destination, component.staged_fingerprint)? {
        assert_component_backup(component)?;
        return Ok(());
    }
    if !fingerprint_matches(component.stage, component.staged_fingerprint)? {
        return Err("AI history staging no longer matches its journal.".into());
    }

    let destination_is_original =
        fingerprint_matches(component.destination, component.destination_fingerprint)?;
    let backup_is_original =
        fingerprint_matches(component.backup, component.destination_fingerprint)?;
    if destination_is_original {
        if component.destination_existed {
            fs::rename(component.destination, component.backup)
                .map_err(|error| error.to_string())?;
            sync_parent(component.destination)?;
        }
    } else if !backup_is_original || component.destination.exists() {
        return Err("AI history destination changed during publication.".into());
    }

    fs::rename(component.stage, component.destination).map_err(|error| error.to_string())?;
    sync_parent(component.destination)?;
    assert_component_published(component)?;
    assert_component_backup(component)
}

fn assert_component_backup(component: TransactionComponent<'_>) -> Result<(), String> {
    if component.destination_existed {
        let unchanged_destination_needs_no_backup = component.destination_fingerprint
            == component.staged_fingerprint
            && !component.backup.exists();
        if unchanged_destination_needs_no_backup
            || fingerprint_matches(component.backup, component.destination_fingerprint)?
        {
            Ok(())
        } else {
            Err(format!(
                "AI history destination backup does not match its journal: expected {}, found {}.",
                component.destination_fingerprint,
                transaction_fingerprint(component.backup)?
            ))
        }
    } else if component.backup.exists() {
        Err("Unexpected AI history destination backup.".into())
    } else {
        Ok(())
    }
}

fn rollback_component(component: TransactionComponent<'_>) -> Result<(), String> {
    if component.destination_fingerprint == component.staged_fingerprint
        && fingerprint_matches(component.destination, component.destination_fingerprint)?
        && !component.backup.exists()
    {
        remove_regular_tree_if_exists(component.stage)?;
        return Ok(());
    }
    if fingerprint_matches(component.destination, component.staged_fingerprint)? {
        if component.stage.exists() {
            return Err("Cannot safely roll back duplicate staging trees.".into());
        }
        fs::rename(component.destination, component.stage).map_err(|error| error.to_string())?;
        sync_parent(component.destination)?;
    } else if !fingerprint_matches(component.stage, component.staged_fingerprint)? {
        return Err("Cannot locate the staged AI history tree for rollback.".into());
    }

    if component.destination_existed {
        if fingerprint_matches(component.destination, component.destination_fingerprint)? {
            // A previous rollback already restored the original destination.
        } else if !component.destination.exists()
            && fingerprint_matches(component.backup, component.destination_fingerprint)?
        {
            fs::rename(component.backup, component.destination)
                .map_err(|error| error.to_string())?;
            sync_parent(component.destination)?;
        } else if component.stage.exists() && !component.backup.exists() {
            remove_regular_tree_if_exists(component.stage)?;
            return Ok(());
        } else {
            return Err("Cannot safely restore the original AI history destination.".into());
        }
    } else if component.destination.exists() {
        return Err("Cannot restore an originally absent AI history destination.".into());
    }
    remove_regular_tree_if_exists(component.stage)?;
    remove_regular_tree_if_exists(component.backup)?;
    Ok(())
}

fn withdraw_source(
    journal: &MigrationJournal,
    failures: &mut dyn FailureInjector,
) -> Result<(), String> {
    withdraw_component(journal.history_component())?;
    failures.check(Failpoint::AfterHistoryWithdrawn)?;
    withdraw_component(journal.managed_component())?;
    failures.check(Failpoint::AfterManagedWithdrawn)?;
    for legacy in &journal.legacy_withdrawals {
        if legacy.quarantine.exists() {
            if file_fingerprint(&legacy.quarantine)? != legacy.fingerprint {
                return Err("Legacy attachment quarantine does not match its journal.".into());
            }
            continue;
        }
        if !legacy.source.exists() || file_fingerprint(&legacy.source)? != legacy.fingerprint {
            return Err("Legacy attachment changed before withdrawal.".into());
        }
        fs::rename(&legacy.source, &legacy.quarantine).map_err(|error| error.to_string())?;
        sync_parent(&legacy.source)?;
    }
    failures.check(Failpoint::AfterLegacyWithdrawn)?;
    Ok(())
}

fn withdraw_component(component: TransactionComponent<'_>) -> Result<(), String> {
    if !component.source_existed {
        return if fingerprint_matches(component.source, component.source_fingerprint)? {
            Ok(())
        } else {
            Err("AI history source appeared before withdrawal.".into())
        };
    }
    if component.quarantine.exists() {
        return if fingerprint_matches(component.quarantine, component.source_fingerprint)? {
            Ok(())
        } else {
            Err("AI history source quarantine does not match its journal.".into())
        };
    }
    if !component.source.exists()
        || !fingerprint_matches(component.source, component.source_fingerprint)?
    {
        return Err("AI history source changed before withdrawal.".into());
    }
    fs::rename(component.source, component.quarantine).map_err(|error| error.to_string())?;
    sync_parent(component.source)
}

fn finish_critical_cleanup(
    journal: &MigrationJournal,
    failures: &mut dyn FailureInjector,
) -> Result<(), String> {
    for component in [journal.history_component(), journal.managed_component()] {
        remove_regular_tree_if_exists(component.quarantine)?;
        remove_regular_tree_if_exists(component.backup)?;
        remove_regular_tree_if_exists(component.stage)?;
        sync_parent(component.source)?;
        sync_parent(component.destination)?;
    }
    failures.check(Failpoint::AfterSourceDeleted)?;
    for legacy in &journal.legacy_withdrawals {
        match fs::remove_file(&legacy.quarantine) {
            Ok(()) => sync_parent(&legacy.quarantine)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn assert_source_unchanged(journal: &MigrationJournal) -> Result<(), String> {
    for component in [journal.history_component(), journal.managed_component()] {
        if !fingerprint_matches(component.source, component.source_fingerprint)? {
            return Err("AI history source changed before withdrawal.".into());
        }
    }
    for legacy in &journal.legacy_withdrawals {
        if !legacy.source.exists() || file_fingerprint(&legacy.source)? != legacy.fingerprint {
            return Err("Legacy attachment changed before withdrawal.".into());
        }
    }
    Ok(())
}

fn assert_published_destination(journal: &MigrationJournal) -> Result<(), String> {
    for component in [journal.history_component(), journal.managed_component()] {
        assert_component_published(component)?;
    }
    Ok(())
}

fn assert_component_published(component: TransactionComponent<'_>) -> Result<(), String> {
    if fingerprint_matches(component.destination, component.staged_fingerprint)? {
        Ok(())
    } else {
        Err("Published AI history destination does not match its journal.".into())
    }
}

fn rollback_transaction(journal: &MigrationJournal) -> Result<(), String> {
    rollback_component(journal.managed_component())?;
    rollback_component(journal.history_component())
}

fn withdrawal_started(journal: &MigrationJournal) -> bool {
    [journal.history_component(), journal.managed_component()]
        .into_iter()
        .any(|component| {
            component.quarantine.exists()
                || (component.source_existed && !component.source.exists())
        })
        || journal
            .legacy_withdrawals
            .iter()
            .any(|legacy| legacy.quarantine.exists() || !legacy.source.exists())
}

fn assert_component_original(component: TransactionComponent<'_>) -> Result<(), String> {
    if fingerprint_matches(component.destination, component.destination_fingerprint)? {
        Ok(())
    } else {
        Err("AI history destination changed during staging.".into())
    }
}

fn assert_unchanged(root: &Path, fingerprint: &str, label: &str) -> Result<(), String> {
    if fingerprint_matches(root, fingerprint)? {
        Ok(())
    } else {
        Err(format!("AI history {label} changed during staging."))
    }
}

fn fingerprint_matches(root: &Path, fingerprint: &str) -> Result<bool, String> {
    Ok(transaction_fingerprint(root)? == fingerprint)
}

fn file_fingerprint(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("Legacy attachment is not a regular file.".into());
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(fs::read(path).map_err(|error| error.to_string())?)
    ))
}

fn transaction_fingerprint(root: &Path) -> Result<String, String> {
    let mut hasher = Sha256::new();
    match fs::symlink_metadata(root) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            hasher.update(b"missing");
            return Ok(format!("{:x}", hasher.finalize()));
        }
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if !metadata.file_type().is_dir() => {
            return Err("AI history transaction root is not a regular directory.".into());
        }
        Ok(_) => hasher.update(b"present"),
    }
    fingerprint_tree(root, root, &mut hasher)?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn fingerprint_tree(root: &Path, directory: &Path, hasher: &mut Sha256) -> Result<(), String> {
    let mut entries = fs::read_dir(directory)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_dir() {
            hasher.update(b"dir\0");
            hasher.update(relative.as_bytes());
            fingerprint_tree(root, &path, hasher)?;
        } else if metadata.file_type().is_file() {
            hasher.update(b"file\0");
            hasher.update(relative.as_bytes());
            hasher.update(fs::read(&path).map_err(|error| error.to_string())?);
        } else {
            return Err(format!("Unsafe transaction artifact at {relative}."));
        }
    }
    Ok(())
}

fn journal_root(app_data_root: &Path) -> PathBuf {
    app_data_root.join("ai-history/v1/transactions")
}

fn journal_path(app_data_root: &Path) -> PathBuf {
    journal_root(app_data_root).join(JOURNAL_FILE)
}

fn withdrawn_marker_path(app_data_root: &Path) -> PathBuf {
    journal_root(app_data_root).join(WITHDRAWN_MARKER_FILE)
}

fn mark_withdrawn(app_data_root: &Path, journal: &MigrationJournal) -> Result<(), String> {
    let root = ensure_journal_root(app_data_root)?;
    let marker = root.join(WITHDRAWN_MARKER_FILE);
    match write_new_file(&marker, journal.operation_id.as_bytes()) {
        Ok(()) => sync_directory(&root),
        Err(_error) if marker.is_file() => {
            if fs::read(&marker).map_err(|error| error.to_string())?
                == journal.operation_id.as_bytes()
            {
                Ok(())
            } else {
                Err("Invalid existing AI history withdrawal marker.".into())
            }
        }
        Err(error) => Err(error),
    }
}

fn persist_journal(app_data_root: &Path, journal: &MigrationJournal) -> Result<(), String> {
    let root = ensure_journal_root(app_data_root)?;
    let path = root.join(JOURNAL_FILE);
    let temporary = root.join(TEMP_JOURNAL_FILE);
    reject_existing_transaction_path(&path)?;
    reject_existing_transaction_path(&temporary)?;
    let bytes = serde_json::to_vec_pretty(journal).map_err(|error| error.to_string())?;
    write_new_file(&temporary, &bytes)?;
    fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
    sync_directory(&root)
}

fn load_journal(app_data_root: &Path) -> Result<Option<MigrationJournal>, String> {
    let requested_root = journal_root(app_data_root);
    if !requested_root.exists() {
        return Ok(None);
    }
    let root = ensure_journal_root(app_data_root)?;
    let path = root.join(JOURNAL_FILE);
    let temporary = root.join(TEMP_JOURNAL_FILE);
    let mut has_journal = false;
    let mut has_temporary = false;
    let mut withdrawn_operation_id = None;
    for entry in fs::read_dir(&root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name();
        if name == JOURNAL_FILE {
            has_journal = true;
        } else if name == TEMP_JOURNAL_FILE {
            has_temporary = true;
        } else if name == WITHDRAWN_MARKER_FILE {
            let bytes = fs::read(entry.path()).map_err(|error| error.to_string())?;
            let operation_id = String::from_utf8(bytes)
                .map_err(|_| "Invalid AI history withdrawal marker.".to_string())?;
            if operation_id.len() != 32 {
                return Err("Invalid AI history withdrawal marker.".into());
            }
            withdrawn_operation_id = Some(operation_id);
        } else {
            return Err("Unknown or multiple AI history transaction artifacts.".into());
        }
    }
    if !has_journal && !has_temporary {
        if withdrawn_operation_id.is_some() {
            return Err("Orphan AI history withdrawal marker.".into());
        }
        return Ok(None);
    }
    if has_temporary {
        let temporary_bytes = fs::read(&temporary).map_err(|error| error.to_string())?;
        let temporary_journal: MigrationJournal = serde_json::from_slice(&temporary_bytes)
            .map_err(|error| format!("Invalid temporary AI history journal: {error}"))?;
        validate_journal(&temporary_journal)?;
        if has_journal {
            let journal_bytes = fs::read(&path).map_err(|error| error.to_string())?;
            if journal_bytes != temporary_bytes {
                return Err("Multiple different AI history transaction journals.".into());
            }
            fs::remove_file(&temporary).map_err(|error| error.to_string())?;
            sync_directory(&root)?;
        } else {
            fs::rename(&temporary, &path).map_err(|error| error.to_string())?;
            sync_directory(&root)?;
        }
    }
    let bytes = fs::read(&path).map_err(|error| error.to_string())?;
    let journal: MigrationJournal = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Invalid AI history transaction journal: {error}"))?;
    if withdrawn_operation_id
        .as_deref()
        .is_some_and(|operation_id| operation_id != journal.operation_id)
    {
        return Err("AI history withdrawal marker belongs to another operation.".into());
    }
    Ok(Some(journal))
}

fn validate_journal(journal: &MigrationJournal) -> Result<(), String> {
    if journal.version != JOURNAL_VERSION {
        return Err("Unsupported AI history transaction journal version.".into());
    }
    if journal.operation_id.len() != 32
        || !journal
            .operation_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || normalize_transaction_root(&journal.source)? != journal.source
        || normalize_transaction_root(&journal.destination)? != journal.destination
        || normalize_managed_root(&journal.source_managed)? != journal.source_managed
        || normalize_managed_root(&journal.destination_managed)? != journal.destination_managed
    {
        return Err("AI history transaction journal contains invalid root identity.".into());
    }
    validate_distinct_roots(&journal.source, &journal.destination)?;
    validate_all_roots(&[
        &journal.source,
        &journal.source_managed,
        &journal.destination,
        &journal.destination_managed,
    ])?;
    let destination_parent = required_parent(&journal.destination)?;
    let source_parent = required_parent(&journal.source)?;
    if journal.stage.parent() != Some(destination_parent)
        || journal.destination_backup.parent() != Some(destination_parent)
        || journal.source_quarantine.parent() != Some(source_parent)
        || journal
            .stage
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| name != format!("{STAGE_PREFIX}{}", journal.operation_id))
        || journal
            .destination_backup
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| name != format!("{BACKUP_PREFIX}{}", journal.operation_id))
        || journal
            .source_quarantine
            .file_name()
            .and_then(|name| name.to_str())
            .is_none_or(|name| name != format!("{QUARANTINE_PREFIX}{}", journal.operation_id))
    {
        return Err("AI history transaction journal contains unsafe paths.".into());
    }
    validate_component_transaction_paths(
        &journal.operation_id,
        &journal.destination_managed,
        &journal.source_managed,
        &journal.managed_stage,
        &journal.managed_destination_backup,
        &journal.managed_source_quarantine,
    )?;
    for (index, legacy) in journal.legacy_withdrawals.iter().enumerate() {
        let normalized_source = normalize_transaction_root(&legacy.source)?;
        let canonical_owned_root = legacy
            .owned_root
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let allowed_owned_roots = [&journal.source, &journal.destination]
            .into_iter()
            .filter_map(|history_root| {
                canonical_directory_if_present(
                    &required_parent(history_root).ok()?.join("assets/chat"),
                )
                .ok()
                .flatten()
            })
            .collect::<Vec<_>>();
        if normalized_source != legacy.source
            || canonical_owned_root != legacy.owned_root
            || !allowed_owned_roots.contains(&canonical_owned_root)
            || !legacy.source.starts_with(&canonical_owned_root)
            || legacy.quarantine.parent() != legacy.source.parent()
            || legacy.quarantine.file_name().and_then(|name| name.to_str())
                != Some(format!(".ai-history-legacy-{}-{index}", journal.operation_id).as_str())
            || legacy.fingerprint.len() != 64
            || !legacy
                .fingerprint
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("AI history journal contains an unsafe legacy withdrawal.".into());
        }
    }
    Ok(())
}

fn validate_component_transaction_paths(
    operation_id: &str,
    destination: &Path,
    source: &Path,
    stage: &Path,
    backup: &Path,
    quarantine: &Path,
) -> Result<(), String> {
    if stage.parent() != Some(required_parent(destination)?)
        || backup.parent() != Some(required_parent(destination)?)
        || quarantine.parent() != Some(required_parent(source)?)
        || stage.file_name().and_then(|name| name.to_str())
            != Some(format!("{STAGE_PREFIX}{operation_id}").as_str())
        || backup.file_name().and_then(|name| name.to_str())
            != Some(format!("{BACKUP_PREFIX}{operation_id}").as_str())
        || quarantine.file_name().and_then(|name| name.to_str())
            != Some(format!("{QUARANTINE_PREFIX}{operation_id}").as_str())
    {
        return Err("AI history transaction journal contains unsafe component paths.".into());
    }
    Ok(())
}

fn remove_journal(app_data_root: &Path, journal: &MigrationJournal) -> Result<(), String> {
    let root = ensure_journal_root(app_data_root)?;
    let path = root.join(JOURNAL_FILE);
    let marker = root.join(WITHDRAWN_MARKER_FILE);
    if marker.exists() {
        if fs::read(&marker).map_err(|error| error.to_string())? != journal.operation_id.as_bytes()
        {
            return Err("AI history withdrawal marker belongs to another operation.".into());
        }
        let parent = required_parent(&root)?;
        let retired = parent.join(format!(".transactions-completed-{}", journal.operation_id));
        reject_existing_transaction_path(&retired)?;
        fs::rename(&root, &retired).map_err(|error| error.to_string())?;
        sync_directory(parent)?;
        remove_regular_tree_if_exists(&retired)?;
        return Ok(());
    }
    match fs::remove_file(path) {
        Ok(()) => sync_directory(&root),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn copy_regular_tree(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_dir() {
        return Err(format!("{} is not a regular directory.", source.display()));
    }
    create_private_dir(destination)?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        let target = destination.join(entry.file_name());
        if metadata.file_type().is_dir() {
            copy_regular_tree(&entry.path(), &target)?;
        } else if metadata.file_type().is_file() {
            let bytes = fs::read(entry.path()).map_err(|error| error.to_string())?;
            write_new_file(&target, &bytes)?;
        } else {
            return Err(format!("{} is not a regular file.", entry.path().display()));
        }
    }
    sync_directory(destination)
}

fn remove_regular_tree_if_exists(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            fs::remove_dir_all(path).map_err(|error| error.to_string())
        }
        Ok(_) => Err(format!(
            "Refusing to remove non-directory {}.",
            path.display()
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn sync_tree(path: &Path) -> Result<(), String> {
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| error.to_string())?;
        if metadata.file_type().is_dir() {
            sync_tree(&entry.path())?;
            sync_directory(&entry.path())?;
        } else if metadata.file_type().is_file() {
            File::open(entry.path())
                .and_then(|file| file.sync_all())
                .map_err(|error| error.to_string())?;
        } else {
            return Err("Cannot sync a symlink or special transaction artifact.".into());
        }
    }
    Ok(())
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn sync_directory(path: &Path) -> Result<(), String> {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

fn sync_parent(path: &Path) -> Result<(), String> {
    sync_directory(required_parent(path)?)
}

fn required_parent(path: &Path) -> Result<&Path, String> {
    path.parent()
        .ok_or_else(|| format!("{} has no parent directory.", path.display()))
}

fn validate_distinct_roots(source: &Path, destination: &Path) -> Result<(), String> {
    if source == destination || source.starts_with(destination) || destination.starts_with(source) {
        return Err("AI history source and destination roots must be distinct.".into());
    }
    Ok(())
}

fn normalize_transaction_root(root: &Path) -> Result<PathBuf, String> {
    let file_name = root
        .file_name()
        .ok_or_else(|| "AI history root has no final component.".to_string())?;
    if file_name == "." || file_name == ".." {
        return Err("AI history root has an unsafe final component.".into());
    }
    let parent = required_parent(root)?
        .canonicalize()
        .map_err(|error| format!("Could not resolve AI history root parent: {error}"))?;
    let candidate = parent.join(file_name);
    match fs::symlink_metadata(&candidate) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err("AI history root cannot be a symlink.".into())
        }
        Ok(_) => candidate.canonicalize().map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(candidate),
        Err(error) => Err(error.to_string()),
    }
}

fn normalize_managed_root(root: &Path) -> Result<PathBuf, String> {
    normalize_transaction_root(root)
}

fn ensure_managed_parent(root: &Path) -> Result<(), String> {
    let parent = required_parent(root)?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let metadata = fs::symlink_metadata(parent).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_dir() {
        return Err("Managed attachment parent is not a regular directory.".into());
    }
    Ok(())
}

fn validate_component_roots(histories: &Path, managed: &Path) -> Result<(), String> {
    if histories == managed || histories.starts_with(managed) || managed.starts_with(histories) {
        return Err("History and managed attachment roots must not overlap.".into());
    }
    Ok(())
}

fn validate_all_roots(roots: &[&Path]) -> Result<(), String> {
    for (index, left) in roots.iter().enumerate() {
        for right in roots.iter().skip(index + 1) {
            validate_component_roots(left, right)?;
        }
    }
    Ok(())
}

fn ensure_journal_root(app_data_root: &Path) -> Result<PathBuf, String> {
    let canonical_app_data = app_data_root
        .canonicalize()
        .map_err(|error| format!("Could not resolve app data root: {error}"))?;
    let root = journal_root(&canonical_app_data);
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let metadata = fs::symlink_metadata(&root).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_dir() {
        return Err("AI history transaction root is not a regular directory.".into());
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_root.starts_with(&canonical_app_data) {
        return Err("AI history transaction root escapes app data.".into());
    }
    Ok(canonical_root)
}

fn reject_existing_transaction_path(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
        Ok(_) => Err(format!(
            "Transaction path already exists: {}.",
            path.display()
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neverwrite_ai::persistence::PersistedMessage;
    use serde_json::json;

    fn history(session_id: &str, content: &str) -> PersistedSessionHistory {
        PersistedSessionHistory {
            version: 1,
            session_id: session_id.into(),
            parent_session_id: None,
            closed_at: None,
            runtime_id: None,
            model_id: "model".into(),
            mode_id: "mode".into(),
            models: None,
            modes: None,
            config_options: None,
            additional_roots: vec![],
            created_at: 1,
            updated_at: 1,
            start_index: Some(0),
            message_count: Some(1),
            title: None,
            custom_title: None,
            preview: None,
            messages: vec![PersistedMessage {
                id: "message".into(),
                role: "user".into(),
                kind: "text".into(),
                content: content.into(),
                timestamp: 1,
                attachments: None,
                title: None,
                meta: None,
                permission_request_id: None,
                permission_options: None,
                diffs: None,
                review_diffs: None,
                user_input_request_id: None,
                user_input_questions: None,
                url_elicitation_request_id: None,
                url_elicitation_id: None,
                url_elicitation_url: None,
                plan_entries: None,
                plan_detail: None,
                tool_action: None,
            }],
        }
    }

    fn layout(parent: &Path, name: &str) -> RootLayout {
        RootLayout {
            histories: parent.join(format!("{name}-histories")),
            managed: parent.join(format!("{name}-managed-parent/blobs")),
        }
    }

    fn write_managed(root: &Path, id: &str, bytes: &[u8], promoted: bool) {
        let directory = root.join(id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("blob"), bytes).unwrap();
        fs::write(
            directory.join("metadata.json"),
            serde_json::to_vec(&json!({
                "version": 1,
                "attachment_id": id,
                "file_name": "screenshot.png",
                "mime_type": "image/png",
                "size_bytes": bytes.len(),
                "sha256": format!("{:x}", Sha256::digest(bytes)),
                "promoted_at_ms": promoted.then_some(1_u64),
            }))
            .unwrap(),
        )
        .unwrap();
    }

    struct StopAt(Failpoint);

    impl FailureInjector for StopAt {
        fn check(&mut self, point: Failpoint) -> Result<(), String> {
            if point == self.0 {
                Err(format!("failpoint:{point:?}"))
            } else {
                Ok(())
            }
        }
    }

    struct MutateAt {
        point: Failpoint,
        root: PathBuf,
    }

    struct AbortAt(Failpoint);

    impl FailureInjector for AbortAt {
        fn check(&mut self, point: Failpoint) -> Result<(), String> {
            if point == self.0 {
                std::process::abort();
            }
            Ok(())
        }
    }

    impl FailureInjector for MutateAt {
        fn check(&mut self, point: Failpoint) -> Result<(), String> {
            if point == self.point {
                persistence::save_session_history(&self.root, &history("external", "change"))?;
            }
            Ok(())
        }
    }

    #[test]
    fn merges_distinct_sessions_and_withdraws_source() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        persistence::save_session_history(&source.histories, &history("a", "source")).unwrap();
        persistence::save_session_history(&destination.histories, &history("b", "destination"))
            .unwrap();

        let result = reconcile(temp.path(), &source, &destination).unwrap();

        assert_eq!(result.histories_moved, 2);
        assert!(!source.histories.exists());
        let loaded = persistence::load_all_session_histories(&destination.histories, true).unwrap();
        assert_eq!(loaded.len(), 2);
        assert!(!journal_path(temp.path()).exists());
    }

    #[test]
    fn deduplicates_equal_sessions_and_blocks_different_content() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        persistence::save_session_history(&source.histories, &history("same", "one")).unwrap();
        persistence::save_session_history(&destination.histories, &history("same", "one")).unwrap();
        reconcile(temp.path(), &source, &destination).unwrap();
        assert_eq!(
            persistence::load_all_session_histories(&destination.histories, true)
                .unwrap()
                .len(),
            1
        );

        let second = tempfile::tempdir().unwrap();
        let source = layout(second.path(), "source");
        let destination = layout(second.path(), "destination");
        persistence::save_session_history(&source.histories, &history("same", "one")).unwrap();
        persistence::save_session_history(&destination.histories, &history("same", "two")).unwrap();
        assert!(reconcile(second.path(), &source, &destination).is_err());
        assert!(source.histories.exists());
        assert!(destination.histories.exists());
    }

    #[test]
    fn recovers_idempotently_from_each_durable_boundary() {
        for point in [
            Failpoint::AfterPrepared,
            Failpoint::AfterDestinationPublished,
            Failpoint::AfterSourceWithdrawn,
            Failpoint::AfterCommitted,
        ] {
            let temp = tempfile::tempdir().unwrap();
            let source = layout(temp.path(), "source");
            let destination = layout(temp.path(), "destination");
            persistence::save_session_history(&source.histories, &history("a", "source")).unwrap();
            persistence::save_session_history(&destination.histories, &history("b", "destination"))
                .unwrap();
            let error =
                reconcile_with_failures(temp.path(), &source, &destination, &mut StopAt(point))
                    .unwrap_err();
            assert!(error.starts_with("failpoint:"));

            recover_pending(temp.path())
                .unwrap_or_else(|error| panic!("recovery failed at {point:?}: {error}"));
            recover_pending(temp.path()).unwrap();
            assert!(!source.histories.exists());
            assert_eq!(
                persistence::load_all_session_histories(&destination.histories, true)
                    .unwrap()
                    .len(),
                2
            );
        }
    }

    #[test]
    fn rejects_unknown_artifacts_and_corrupt_journals() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        fs::create_dir_all(&source.histories).unwrap();
        fs::write(source.histories.join("unknown"), b"data").unwrap();
        assert!(reconcile(temp.path(), &source, &destination).is_err());

        let root = journal_root(temp.path());
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(JOURNAL_FILE), json!({"version": 99}).to_string()).unwrap();
        assert!(recover_pending(temp.path()).is_err());
    }

    #[test]
    fn destination_change_before_publish_aborts_without_deleting_data() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        persistence::save_session_history(&source.histories, &history("a", "source")).unwrap();
        persistence::save_session_history(&destination.histories, &history("b", "destination"))
            .unwrap();

        let error = reconcile_with_failures(
            temp.path(),
            &source,
            &destination,
            &mut MutateAt {
                point: Failpoint::BeforePublish,
                root: destination.histories.clone(),
            },
        )
        .unwrap_err();

        assert!(error.contains("destination changed"));
        assert!(source.histories.exists());
        assert_eq!(
            persistence::load_all_session_histories(&destination.histories, true)
                .unwrap()
                .len(),
            2
        );
        assert!(!journal_path(temp.path()).exists());
    }

    #[test]
    fn source_change_before_withdrawal_restores_original_destination() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        persistence::save_session_history(&source.histories, &history("a", "source")).unwrap();
        persistence::save_session_history(&destination.histories, &history("b", "destination"))
            .unwrap();

        let error = reconcile_with_failures(
            temp.path(),
            &source,
            &destination,
            &mut MutateAt {
                point: Failpoint::BeforeSourceWithdrawal,
                root: source.histories.clone(),
            },
        )
        .unwrap_err();

        assert!(error.contains("source changed"));
        assert_eq!(
            persistence::load_all_session_histories(&source.histories, true)
                .unwrap()
                .len(),
            2
        );
        let destination_histories =
            persistence::load_all_session_histories(&destination.histories, true).unwrap();
        assert_eq!(destination_histories.len(), 1);
        assert_eq!(destination_histories[0].session_id, "b");
        assert!(!journal_path(temp.path()).exists());
    }

    #[test]
    fn moves_complete_managed_namespace_and_blocks_id_collisions() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        let promoted_id = "ma_0123456789abcdef0123456789abcdef";
        write_managed(&source.managed, promoted_id, b"promoted-orphan", true);

        let result = reconcile(temp.path(), &source, &destination).unwrap();

        assert_eq!(result.attachments_moved, 1);
        assert!(!source.managed.exists());
        assert_eq!(
            inspect_managed_attachments(&destination.managed)
                .unwrap()
                .get(&ManagedAttachmentId::parse(promoted_id).unwrap()),
            Some(&b"promoted-orphan".to_vec())
        );

        let collision = tempfile::tempdir().unwrap();
        let source = layout(collision.path(), "source");
        let destination = layout(collision.path(), "destination");
        write_managed(&source.managed, promoted_id, b"source", false);
        write_managed(&destination.managed, promoted_id, b"destination", false);
        assert!(reconcile(collision.path(), &source, &destination).is_err());
        assert!(source.managed.exists());
        assert!(destination.managed.exists());
    }

    #[test]
    fn recovers_partial_publish_with_valid_temporary_journal() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        persistence::save_session_history(&source.histories, &history("a", "source")).unwrap();
        persistence::save_session_history(&destination.histories, &history("b", "destination"))
            .unwrap();
        let error = reconcile_with_failures(
            temp.path(),
            &source,
            &destination,
            &mut StopAt(Failpoint::AfterPrepared),
        )
        .unwrap_err();
        assert!(error.starts_with("failpoint:"));

        let journal: MigrationJournal =
            serde_json::from_slice(&fs::read(journal_path(temp.path())).unwrap()).unwrap();
        fs::rename(&journal.destination, &journal.destination_backup).unwrap();
        fs::rename(
            journal_path(temp.path()),
            journal_root(temp.path()).join(TEMP_JOURNAL_FILE),
        )
        .unwrap();

        recover_pending(temp.path()).unwrap();
        assert!(!source.histories.exists());
        assert_eq!(
            persistence::load_all_session_histories(&destination.histories, true)
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn converts_owned_legacy_images_and_preserves_external_paths() {
        let temp = tempfile::tempdir().unwrap();
        let source_parent = temp.path().join("source-vault");
        let destination_parent = temp.path().join("destination-vault");
        fs::create_dir_all(&source_parent).unwrap();
        fs::create_dir_all(&destination_parent).unwrap();
        let source = RootLayout {
            histories: source_parent.join(".neverwrite"),
            managed: source_parent.join("assets/chat/.neverwrite-managed/v1/blobs"),
        };
        let destination = RootLayout {
            histories: destination_parent.join(".neverwrite"),
            managed: destination_parent.join("assets/chat/.neverwrite-managed/v1/blobs"),
        };
        let legacy_path = source_parent.join("assets/chat/legacy.png");
        fs::create_dir_all(legacy_path.parent().unwrap()).unwrap();
        fs::write(&legacy_path, b"legacy-image").unwrap();
        let external_path = temp.path().join("external.png");
        fs::write(&external_path, b"external-image").unwrap();
        let mut source_history = history("legacy", "attachments");
        source_history.messages[0].attachments = Some(json!([
            {
                "filePath": legacy_path,
                "fileName": "legacy.png",
                "mimeType": "image/png"
            },
            {
                "filePath": external_path,
                "fileName": "external.png",
                "mimeType": "image/png"
            }
        ]));
        persistence::save_session_history(&source.histories, &source_history).unwrap();

        reconcile(temp.path(), &source, &destination).unwrap();

        let histories =
            persistence::load_all_session_histories(&destination.histories, true).unwrap();
        let attachments = histories[0].messages[0].attachments.as_ref().unwrap();
        assert!(attachments[0].get("managedAttachmentId").is_some());
        assert!(attachments[0].get("filePath").is_none());
        assert_eq!(
            attachments[1]
                .get("filePath")
                .and_then(serde_json::Value::as_str),
            external_path.to_str()
        );
        assert_eq!(
            inspect_managed_attachments(&destination.managed)
                .unwrap()
                .len(),
            1
        );
        assert!(!legacy_path.exists());
        assert!(external_path.exists());
    }

    #[test]
    fn rejects_managed_changes_after_staging() {
        struct MutateManaged {
            root: PathBuf,
        }
        impl FailureInjector for MutateManaged {
            fn check(&mut self, point: Failpoint) -> Result<(), String> {
                if point == Failpoint::BeforePublish {
                    write_managed(
                        &self.root,
                        "ma_abcdefabcdefabcdefabcdefabcdefab",
                        b"late-blob",
                        false,
                    );
                }
                Ok(())
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        write_managed(
            &source.managed,
            "ma_0123456789abcdef0123456789abcdef",
            b"initial",
            false,
        );
        let error = reconcile_with_failures(
            temp.path(),
            &source,
            &destination,
            &mut MutateManaged {
                root: source.managed.clone(),
            },
        )
        .unwrap_err();
        assert!(error.contains("source changed"));
        assert_eq!(
            inspect_managed_attachments(&source.managed).unwrap().len(),
            2
        );
        assert!(!destination.managed.exists());
    }

    #[test]
    fn rejects_sources_that_appear_after_prepare() {
        struct CreateSources {
            layout: RootLayout,
        }
        impl FailureInjector for CreateSources {
            fn check(&mut self, point: Failpoint) -> Result<(), String> {
                if point == Failpoint::BeforeSourceWithdrawal {
                    persistence::save_session_history(
                        &self.layout.histories,
                        &history("external", "appeared"),
                    )?;
                    write_managed(
                        &self.layout.managed,
                        "ma_abcdefabcdefabcdefabcdefabcdefab",
                        b"appeared",
                        false,
                    );
                }
                Ok(())
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        let error = reconcile_with_failures(
            temp.path(),
            &source,
            &destination,
            &mut CreateSources {
                layout: source.clone(),
            },
        )
        .unwrap_err();
        assert!(error.contains("source changed"));
        assert!(source.histories.exists());
        assert!(source.managed.exists());
    }

    #[test]
    fn promoted_blob_survives_reconcile_then_history_save() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        let attachment_id = "ma_0123456789abcdef0123456789abcdef";
        write_managed(&source.managed, attachment_id, b"promoted", true);
        let mut promoted_history = history("promoted", "attachment");
        promoted_history.messages[0].attachments = Some(json!([{
            "managedAttachmentId": attachment_id,
            "fileName": "screenshot.png",
            "mimeType": "image/png"
        }]));
        persistence::save_session_history(&source.histories, &promoted_history).unwrap();

        reconcile(temp.path(), &source, &destination).unwrap();
        let loaded = persistence::load_all_session_histories(&destination.histories, true)
            .unwrap()
            .pop()
            .unwrap();
        persistence::save_session_history(&destination.histories, &loaded).unwrap();

        assert_eq!(
            inspect_managed_attachments(&destination.managed)
                .unwrap()
                .get(&ManagedAttachmentId::parse(attachment_id).unwrap()),
            Some(&b"promoted".to_vec())
        );
    }

    #[test]
    fn rejects_orphan_and_mismatched_withdrawal_markers() {
        let temp = tempfile::tempdir().unwrap();
        let root = ensure_journal_root(temp.path()).unwrap();
        fs::write(
            root.join(WITHDRAWN_MARKER_FILE),
            b"0123456789abcdef0123456789abcdef",
        )
        .unwrap();
        assert!(recover_pending(temp.path()).is_err());
    }

    #[test]
    fn real_process_aborts_across_durable_boundaries_recover_idempotently() {
        const CHILD_ENV: &str = "NEVERWRITE_MIGRATION_ABORT_CHILD";
        const ROOT_ENV: &str = "NEVERWRITE_MIGRATION_ABORT_ROOT";
        const POINT_ENV: &str = "NEVERWRITE_MIGRATION_ABORT_POINT";
        if std::env::var_os(CHILD_ENV).is_some() {
            let root = PathBuf::from(std::env::var_os(ROOT_ENV).unwrap());
            let source = layout(&root, "source");
            let destination = layout(&root, "destination");
            let point = match std::env::var(POINT_ENV).unwrap().as_str() {
                "history-published" => Failpoint::AfterHistoryPublished,
                "managed-published" => Failpoint::AfterManagedPublished,
                "history-withdrawn" => Failpoint::AfterHistoryWithdrawn,
                "managed-withdrawn" => Failpoint::AfterManagedWithdrawn,
                "source-deleted" => Failpoint::AfterSourceDeleted,
                "before-commit" => Failpoint::BeforeCommit,
                "after-commit" => Failpoint::AfterCommit,
                value => panic!("unknown subprocess failpoint: {value}"),
            };
            let _ = reconcile_with_failures(&root, &source, &destination, &mut AbortAt(point));
            unreachable!("abort failpoint must terminate the child process");
        }

        for point in [
            "history-published",
            "managed-published",
            "history-withdrawn",
            "managed-withdrawn",
            "source-deleted",
            "before-commit",
            "after-commit",
        ] {
            let temp = tempfile::tempdir().unwrap();
            let source = layout(temp.path(), "source");
            let destination = layout(temp.path(), "destination");
            persistence::save_session_history(&source.histories, &history("a", "source")).unwrap();
            write_managed(
                &source.managed,
                "ma_0123456789abcdef0123456789abcdef",
                b"managed",
                true,
            );
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("--exact")
                .arg("ai_history::migration::tests::real_process_aborts_across_durable_boundaries_recover_idempotently")
                .arg("--nocapture")
                .env(CHILD_ENV, "1")
                .env(ROOT_ENV, temp.path())
                .env(POINT_ENV, point)
                .status()
                .unwrap();
            assert!(!status.success(), "child did not abort at {point}");

            recover_pending(temp.path()).unwrap();
            recover_pending(temp.path()).unwrap();
            assert!(!source.histories.exists());
            assert!(!source.managed.exists());
            assert_eq!(
                persistence::load_all_session_histories(&destination.histories, true)
                    .unwrap()
                    .len(),
                1
            );
            assert_eq!(
                inspect_managed_attachments(&destination.managed)
                    .unwrap()
                    .len(),
                1
            );
        }
    }
}
