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

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LayoutInspection {
    pub empty: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ReconciliationInspection {
    pub conflicting_session_ids: Vec<String>,
    pub conflicting_attachment_ids: Vec<String>,
}

impl ReconciliationInspection {
    pub(super) fn can_reconcile(&self) -> bool {
        self.conflicting_session_ids.is_empty() && self.conflicting_attachment_ids.is_empty()
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum ReconciliationPhase {
    Inspect,
    Prepare,
    Validate,
    Publish,
    Withdraw,
    Commit,
    Housekeeping,
}

impl ReconciliationPhase {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Inspect => "inspect",
            Self::Prepare => "prepare",
            Self::Validate => "validate",
            Self::Publish => "publish",
            Self::Withdraw => "withdraw",
            Self::Commit => "commit",
            Self::Housekeeping => "housekeeping",
        }
    }
}

pub(super) trait ReconciliationObserver {
    fn phase_started(&mut self, phase: ReconciliationPhase);
    fn phase_completed(&mut self, phase: ReconciliationPhase);
}

struct NoFailures;

impl FailureInjector for NoFailures {
    fn check(&mut self, _point: Failpoint) -> Result<(), String> {
        Ok(())
    }
}

struct NoReconciliationObserver;

impl ReconciliationObserver for NoReconciliationObserver {
    fn phase_started(&mut self, _phase: ReconciliationPhase) {}

    fn phase_completed(&mut self, _phase: ReconciliationPhase) {}
}

pub(super) fn reconcile(
    app_data_root: &Path,
    source: &RootLayout,
    destination: &RootLayout,
) -> Result<ReconcileResult, String> {
    reconcile_with_commit(app_data_root, source, destination, || Ok(()))
}

pub(super) fn reconcile_with_commit(
    app_data_root: &Path,
    source: &RootLayout,
    destination: &RootLayout,
    mut logical_commit: impl FnMut() -> Result<(), String>,
) -> Result<ReconcileResult, String> {
    let operation_id = uuid::Uuid::new_v4().simple().to_string();
    reconcile_with_operation_commit(
        app_data_root,
        &operation_id,
        source,
        destination,
        &mut logical_commit,
    )
}

pub(super) fn reconcile_with_operation_commit(
    app_data_root: &Path,
    operation_id: &str,
    source: &RootLayout,
    destination: &RootLayout,
    mut logical_commit: impl FnMut() -> Result<(), String>,
) -> Result<ReconcileResult, String> {
    let mut observer = NoReconciliationObserver;
    reconcile_with_operation_commit_observed(
        app_data_root,
        operation_id,
        source,
        destination,
        &mut logical_commit,
        &mut observer,
    )
}

pub(super) fn reconcile_with_operation_commit_observed(
    app_data_root: &Path,
    operation_id: &str,
    source: &RootLayout,
    destination: &RootLayout,
    logical_commit: &mut dyn FnMut() -> Result<(), String>,
    observer: &mut dyn ReconciliationObserver,
) -> Result<ReconcileResult, String> {
    reconcile_internal(
        app_data_root,
        operation_id,
        source,
        destination,
        &mut NoFailures,
        logical_commit,
        observer,
    )
}

pub(super) fn reconcile_with_failures(
    app_data_root: &Path,
    source: &RootLayout,
    destination: &RootLayout,
    failures: &mut dyn FailureInjector,
) -> Result<ReconcileResult, String> {
    let operation_id = uuid::Uuid::new_v4().simple().to_string();
    let mut observer = NoReconciliationObserver;
    reconcile_internal(
        app_data_root,
        &operation_id,
        source,
        destination,
        failures,
        &mut || Ok(()),
        &mut observer,
    )
}

fn reconcile_internal(
    app_data_root: &Path,
    operation_id: &str,
    source: &RootLayout,
    destination: &RootLayout,
    failures: &mut dyn FailureInjector,
    logical_commit: &mut dyn FnMut() -> Result<(), String>,
    observer: &mut dyn ReconciliationObserver,
) -> Result<ReconcileResult, String> {
    validate_operation_id(operation_id)?;
    observer.phase_started(ReconciliationPhase::Inspect);
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
    let source_attachments = inspect_managed_attachments(&source_managed)?;
    let destination_attachments = inspect_managed_attachments(&destination_managed)?;
    validate_merged_managed_references(
        "source and destination",
        [&source_inventory, &destination_inventory],
        [&source_attachments, &destination_attachments],
    )?;
    let merge = classify_merge(&source_inventory, &destination_inventory)?;
    let mut attachment_ids =
        classify_attachment_inventories(source_attachments, destination_attachments)?;
    observer.phase_completed(ReconciliationPhase::Inspect);

    observer.phase_started(ReconciliationPhase::Prepare);
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
    observer.phase_completed(ReconciliationPhase::Prepare);

    observer.phase_started(ReconciliationPhase::Validate);
    let staged_inventory = inspect_root(&stage)?;
    ensure_safe_inventory("staging", &staged_inventory)?;
    ensure_staged_merge(&merge, &converted_sessions, &staged_inventory)?;
    ensure_staged_attachments(&managed_stage, &attachment_ids)?;
    validate_merged_managed_references("staging", [&staged_inventory], [&attachment_ids])?;

    assert_unchanged(source, &source_fingerprint, "source")?;
    assert_unchanged(destination, &destination_fingerprint, "destination")?;
    observer.phase_completed(ReconciliationPhase::Validate);

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
        operation_id: operation_id.to_string(),
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
    // Persisting the journal makes the prepared transaction durable, which is
    // the first boundary of publishing it. Keep Publish active if that write
    // or an immediate durable-boundary check fails.
    observer.phase_started(ReconciliationPhase::Publish);
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
    observer.phase_completed(ReconciliationPhase::Publish);

    observer.phase_started(ReconciliationPhase::Withdraw);
    if let Err(error) = assert_source_unchanged(&journal) {
        rollback_transaction(&journal)?;
        remove_journal(app_data_root, &journal)?;
        return Err(error);
    }
    withdraw_source(&journal, failures)?;
    failures.check(Failpoint::AfterSourceWithdrawn)?;
    observer.phase_completed(ReconciliationPhase::Withdraw);

    observer.phase_started(ReconciliationPhase::Commit);
    failures.check(Failpoint::BeforeCommit)?;
    mark_withdrawn(app_data_root, &journal)?;
    failures.check(Failpoint::AfterCommit)?;
    finish_critical_cleanup(&journal, failures)?;
    logical_commit()?;
    failures.check(Failpoint::AfterCommitted)?;
    observer.phase_completed(ReconciliationPhase::Commit);

    observer.phase_started(ReconciliationPhase::Housekeeping);
    remove_journal(app_data_root, &journal)?;
    observer.phase_completed(ReconciliationPhase::Housekeeping);

    Ok(ReconcileResult {
        histories_moved: merge.len(),
        attachments_moved: attachment_ids.len(),
    })
}

pub(super) fn recover_pending(app_data_root: &Path) -> Result<(), String> {
    recover_pending_with_commit(app_data_root, || Ok(())).map(|_| ())
}

pub(super) fn recover_pending_with_commit(
    app_data_root: &Path,
    mut logical_commit: impl FnMut() -> Result<(), String>,
) -> Result<bool, String> {
    let Some(journal) = load_journal(app_data_root)? else {
        return Ok(false);
    };
    validate_journal(&journal)?;
    recover_loaded_journal(app_data_root, journal, &mut logical_commit)
}

pub(super) fn recover_operation_with_commit(
    app_data_root: &Path,
    operation_id: &str,
    source: &RootLayout,
    destination: &RootLayout,
    mut logical_commit: impl FnMut() -> Result<(), String>,
) -> Result<bool, String> {
    validate_operation_id(operation_id)?;
    let Some(journal) = load_journal(app_data_root)? else {
        return Ok(false);
    };
    validate_journal(&journal)?;
    validate_expected_journal(&journal, operation_id, source, destination)?;
    recover_loaded_journal(app_data_root, journal, &mut logical_commit)
}

fn recover_loaded_journal(
    app_data_root: &Path,
    journal: MigrationJournal,
    logical_commit: &mut dyn FnMut() -> Result<(), String>,
) -> Result<bool, String> {
    if withdrawn_marker_path(app_data_root).exists() {
        assert_published_destination(&journal)?;
        finish_critical_cleanup(&journal, &mut NoFailures)?;
        logical_commit()?;
        remove_journal(app_data_root, &journal)?;
        return Ok(true);
    }
    if withdrawal_started(&journal) {
        assert_published_destination(&journal)?;
        withdraw_source(&journal, &mut NoFailures)?;
        mark_withdrawn(app_data_root, &journal)?;
        finish_critical_cleanup(&journal, &mut NoFailures)?;
        logical_commit()?;
        remove_journal(app_data_root, &journal)?;
        return Ok(true);
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
    logical_commit()?;
    remove_journal(app_data_root, &journal)?;
    Ok(true)
}

fn validate_expected_journal(
    journal: &MigrationJournal,
    operation_id: &str,
    source: &RootLayout,
    destination: &RootLayout,
) -> Result<(), String> {
    let expected_source = normalize_transaction_root(&source.histories)?;
    let expected_destination = normalize_transaction_root(&destination.histories)?;
    let expected_source_managed = normalize_managed_root(&source.managed)?;
    let expected_destination_managed = normalize_managed_root(&destination.managed)?;
    if journal.operation_id != operation_id
        || journal.source != expected_source
        || journal.destination != expected_destination
        || journal.source_managed != expected_source_managed
        || journal.destination_managed != expected_destination_managed
    {
        return Err(
            "Pending AI history operation does not match its transaction journal.".to_string(),
        );
    }
    Ok(())
}

pub(super) fn has_pending(app_data_root: &Path) -> Result<bool, String> {
    load_journal(app_data_root).map(|journal| journal.is_some())
}

pub(super) fn inspect_layout(layout: &RootLayout) -> Result<LayoutInspection, String> {
    let inventory = inspect_root(&layout.histories)?;
    ensure_safe_inventory("AI history", &inventory)?;
    let attachments = inspect_managed_attachments(&layout.managed)?;
    validate_merged_managed_references("AI history", [&inventory], [&attachments])?;
    Ok(LayoutInspection {
        empty: inventory.histories.sessions.is_empty() && attachments.is_empty(),
    })
}

pub(super) fn inspect_reconciliation(
    source: &RootLayout,
    destination: &RootLayout,
) -> Result<ReconciliationInspection, String> {
    let source_inventory = inspect_root(&source.histories)?;
    let destination_inventory = inspect_root(&destination.histories)?;
    ensure_safe_inventory("source", &source_inventory)?;
    ensure_safe_inventory("destination", &destination_inventory)?;

    let source_attachments = inspect_managed_attachments(&source.managed)?;
    let destination_attachments = inspect_managed_attachments(&destination.managed)?;
    validate_merged_managed_references(
        "source and destination",
        [&source_inventory, &destination_inventory],
        [&source_attachments, &destination_attachments],
    )?;

    let destination_by_id = destination_inventory
        .histories
        .sessions
        .iter()
        .map(|history| (history.session_id.as_str(), history))
        .collect::<BTreeMap<_, _>>();
    let mut conflicting_session_ids = source_inventory
        .histories
        .sessions
        .iter()
        .filter_map(|history| {
            destination_by_id
                .get(history.session_id.as_str())
                .filter(|other| other.content_fingerprint != history.content_fingerprint)
                .map(|_| history.session_id.clone())
        })
        .collect::<Vec<_>>();
    conflicting_session_ids.sort();

    let mut conflicting_attachment_ids = source_attachments
        .iter()
        .filter_map(|(attachment_id, bytes)| {
            destination_attachments
                .get(attachment_id)
                .filter(|other| *other != bytes)
                .map(|_| attachment_id.as_str().to_string())
        })
        .collect::<Vec<_>>();
    conflicting_attachment_ids.sort();

    Ok(ReconciliationInspection {
        conflicting_session_ids,
        conflicting_attachment_ids,
    })
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

fn validate_merged_managed_references<'a>(
    label: &str,
    inventories: impl IntoIterator<Item = &'a StorageInventory>,
    attachment_inventories: impl IntoIterator<
        Item = &'a BTreeMap<ManagedAttachmentId, ManagedAttachmentInspection>,
    >,
) -> Result<(), String> {
    let available = attachment_inventories
        .into_iter()
        .flat_map(|attachments| attachments.keys().cloned())
        .collect::<BTreeSet<_>>();
    for history in inventories
        .into_iter()
        .flat_map(|inventory| &inventory.histories.sessions)
    {
        for raw_id in &history.managed_attachment_ids {
            let attachment_id = ManagedAttachmentId::parse(raw_id).map_err(|_| {
                format!(
                    "Session {} contains an invalid managed attachment ID.",
                    history.session_id
                )
            })?;
            if !available.contains(&attachment_id) {
                return Err(format!(
                    "The {label} inventory is missing managed attachment {} referenced by session {}.",
                    attachment_id.as_str(),
                    history.session_id
                ));
            }
        }
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
    attachments_by_id: &mut BTreeMap<ManagedAttachmentId, ManagedAttachmentInspection>,
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
    attachments_by_id: &mut BTreeMap<ManagedAttachmentId, ManagedAttachmentInspection>,
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
    attachments_by_id: &mut BTreeMap<ManagedAttachmentId, ManagedAttachmentInspection>,
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
                        attachments_by_id.insert(
                            attachment_id.clone(),
                            ManagedAttachmentInspection {
                                bytes,
                                file_name,
                                mime_type,
                            },
                        );
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
) -> Result<BTreeMap<ManagedAttachmentId, ManagedAttachmentInspection>, String> {
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
) -> Result<ManagedAttachmentInspection, String> {
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
    let (file_name, mime_type) =
        super::attachments::validate_migration_attachment(&metadata_bytes, attachment_id, &blob)?;
    Ok(ManagedAttachmentInspection {
        bytes: blob,
        file_name,
        mime_type,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ManagedAttachmentInspection {
    bytes: Vec<u8>,
    file_name: String,
    mime_type: String,
}

fn classify_attachment_inventories(
    source_attachments: BTreeMap<ManagedAttachmentId, ManagedAttachmentInspection>,
    destination_attachments: BTreeMap<ManagedAttachmentId, ManagedAttachmentInspection>,
) -> Result<BTreeMap<ManagedAttachmentId, ManagedAttachmentInspection>, String> {
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
    expected: &BTreeMap<ManagedAttachmentId, ManagedAttachmentInspection>,
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
            rename_path(component.destination, component.backup)
                .map_err(|error| error.to_string())?;
            sync_parent(component.destination)?;
        }
    } else if !backup_is_original || component.destination.exists() {
        return Err("AI history destination changed during publication.".into());
    }

    rename_path(component.stage, component.destination)?;
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
        rename_path(component.destination, component.stage)?;
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
            rename_path(component.backup, component.destination)
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
        rename_path(&legacy.source, &legacy.quarantine)?;
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
    rename_path(component.source, component.quarantine)?;
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
    rename_path(&temporary, &path)?;
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
            rename_path(&temporary, &path)?;
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
    validate_operation_id(&journal.operation_id)?;
    if normalize_transaction_root(&journal.source)? != journal.source
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

fn validate_operation_id(operation_id: &str) -> Result<(), String> {
    if operation_id.len() != 32
        || !operation_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("Invalid AI history operation ID.".to_string());
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
        rename_path(&root, &retired)?;
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
fn rename_path(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn rename_path(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let succeeded = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

#[cfg(not(windows))]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), String> {
    // Windows has no reliable POSIX-style directory fsync. Files are flushed
    // before publication and rename_path uses MOVEFILE_WRITE_THROUGH.
    Ok(())
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

    fn managed_test_bytes(payload: &[u8]) -> Vec<u8> {
        [b"\x89PNG\r\n\x1a\n".as_slice(), payload].concat()
    }

    fn write_managed(root: &Path, id: &str, bytes: &[u8], promoted: bool) {
        let bytes = managed_test_bytes(bytes);
        let directory = root.join(id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("blob"), &bytes).unwrap();
        fs::write(
            directory.join("metadata.json"),
            serde_json::to_vec(&json!({
                "version": 1,
                "attachment_id": id,
                "file_name": "screenshot.png",
                "mime_type": "image/png",
                "size_bytes": bytes.len(),
                "sha256": format!("{:x}", Sha256::digest(&bytes)),
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
    fn recovery_runs_the_logical_commit_before_retiring_the_journal() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        persistence::save_session_history(&source.histories, &history("a", "source")).unwrap();

        let error = reconcile_with_failures(
            temp.path(),
            &source,
            &destination,
            &mut StopAt(Failpoint::AfterCommitted),
        )
        .unwrap_err();
        assert!(error.contains("AfterCommitted"));
        assert!(journal_path(temp.path()).exists());

        let committed = std::cell::Cell::new(false);
        let recovered = recover_pending_with_commit(temp.path(), || {
            committed.set(true);
            Ok(())
        })
        .unwrap();

        assert!(recovered);
        assert!(committed.get());
        assert!(!journal_path(temp.path()).exists());
        assert!(!source.histories.exists());
        assert_eq!(
            persistence::load_all_session_histories(&destination.histories, true)
                .unwrap()
                .len(),
            1
        );
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
                .get(&ManagedAttachmentId::parse(promoted_id).unwrap())
                .map(|attachment| attachment.bytes.as_slice()),
            Some(managed_test_bytes(b"promoted-orphan").as_slice())
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
    fn blocks_equal_blob_ids_when_their_durable_metadata_differs() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        let attachment_id = "ma_0123456789abcdef0123456789abcdef";
        write_managed(&source.managed, attachment_id, b"same", false);
        write_managed(&destination.managed, attachment_id, b"same", false);
        let metadata_path = destination
            .managed
            .join(attachment_id)
            .join("metadata.json");
        let mut metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        metadata["file_name"] = json!("different.png");
        fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();

        let inspection = inspect_reconciliation(&source, &destination).unwrap();
        assert_eq!(
            inspection.conflicting_attachment_ids,
            vec![attachment_id.to_string()]
        );
        assert!(!inspection.can_reconcile());
        assert!(reconcile(temp.path(), &source, &destination).is_err());
        assert!(source.managed.exists());
        assert!(destination.managed.exists());
    }

    #[test]
    fn rejects_managed_metadata_that_runtime_reading_cannot_validate() {
        let temp = tempfile::tempdir().unwrap();
        let root = layout(temp.path(), "root");
        let attachment_id = "ma_0123456789abcdef0123456789abcdef";
        write_managed(&root.managed, attachment_id, b"invalid-metadata", false);
        let metadata_path = root.managed.join(attachment_id).join("metadata.json");
        let mut metadata: serde_json::Value =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        metadata.as_object_mut().unwrap().remove("mime_type");
        fs::write(&metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();

        assert!(inspect_layout(&root).is_err());
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
        fs::write(&legacy_path, managed_test_bytes(b"legacy-image")).unwrap();
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
                .get(&ManagedAttachmentId::parse(attachment_id).unwrap())
                .map(|attachment| attachment.bytes.as_slice()),
            Some(managed_test_bytes(b"promoted").as_slice())
        );
    }

    #[test]
    fn rejects_histories_with_missing_managed_attachments() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        let attachment_id = "ma_0123456789abcdef0123456789abcdef";
        let mut broken = history("broken", "attachment");
        broken.messages[0].attachments = Some(json!([{
            "managedAttachmentId": attachment_id,
            "fileName": "missing.png",
            "mimeType": "image/png"
        }]));
        persistence::save_session_history(&source.histories, &broken).unwrap();

        let inspection_error = inspect_layout(&source).unwrap_err();
        assert!(inspection_error.contains(attachment_id));
        let reconcile_error = reconcile(temp.path(), &source, &destination).unwrap_err();
        assert!(reconcile_error.contains(attachment_id));
        assert!(source.histories.exists());
        assert!(!destination.histories.exists());
    }

    #[test]
    fn recovery_requires_the_service_operation_identity_and_roots() {
        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        persistence::save_session_history(&source.histories, &history("a", "source")).unwrap();
        let operation_id = "0123456789abcdef0123456789abcdef";
        let mut observer = NoReconciliationObserver;
        let error = reconcile_internal(
            temp.path(),
            operation_id,
            &source,
            &destination,
            &mut StopAt(Failpoint::AfterPrepared),
            &mut || Ok(()),
            &mut observer,
        )
        .unwrap_err();
        assert!(error.contains("AfterPrepared"));
        assert_eq!(
            load_journal(temp.path()).unwrap().unwrap().operation_id,
            operation_id
        );

        let mut committed = false;
        let mismatch = recover_operation_with_commit(
            temp.path(),
            "fedcba9876543210fedcba9876543210",
            &source,
            &destination,
            || {
                committed = true;
                Ok(())
            },
        )
        .unwrap_err();
        assert!(mismatch.contains("does not match"));
        assert!(!committed);
        assert!(source.histories.exists());

        let wrong_destination = layout(temp.path(), "wrong-destination");
        ensure_managed_parent(&wrong_destination.managed).unwrap();
        let root_mismatch = recover_operation_with_commit(
            temp.path(),
            operation_id,
            &source,
            &wrong_destination,
            || {
                committed = true;
                Ok(())
            },
        )
        .unwrap_err();
        assert!(root_mismatch.contains("does not match"));
        assert!(!committed);

        assert!(recover_operation_with_commit(
            temp.path(),
            operation_id,
            &source,
            &destination,
            || {
                committed = true;
                Ok(())
            },
        )
        .unwrap());
        assert!(committed);
        assert!(!source.histories.exists());
        assert!(destination.histories.exists());
    }

    #[test]
    fn reports_reconciliation_phases_at_their_durable_boundaries() {
        #[derive(Default)]
        struct RecordingObserver {
            events: Vec<(ReconciliationPhase, &'static str)>,
        }

        impl ReconciliationObserver for RecordingObserver {
            fn phase_started(&mut self, phase: ReconciliationPhase) {
                self.events.push((phase, "started"));
            }

            fn phase_completed(&mut self, phase: ReconciliationPhase) {
                self.events.push((phase, "completed"));
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        persistence::save_session_history(&source.histories, &history("a", "source")).unwrap();
        let mut observer = RecordingObserver::default();

        reconcile_with_operation_commit_observed(
            temp.path(),
            "0123456789abcdef0123456789abcdef",
            &source,
            &destination,
            &mut || Ok(()),
            &mut observer,
        )
        .unwrap();

        let phases = [
            ReconciliationPhase::Inspect,
            ReconciliationPhase::Prepare,
            ReconciliationPhase::Validate,
            ReconciliationPhase::Publish,
            ReconciliationPhase::Withdraw,
            ReconciliationPhase::Commit,
            ReconciliationPhase::Housekeeping,
        ];
        assert_eq!(
            observer.events,
            phases
                .into_iter()
                .flat_map(|phase| [(phase, "started"), (phase, "completed")])
                .collect::<Vec<_>>(),
        );
    }

    #[test]
    fn reports_publish_as_active_after_preparing_the_durable_journal() {
        #[derive(Default)]
        struct RecordingObserver {
            events: Vec<(ReconciliationPhase, &'static str)>,
        }

        impl ReconciliationObserver for RecordingObserver {
            fn phase_started(&mut self, phase: ReconciliationPhase) {
                self.events.push((phase, "started"));
            }

            fn phase_completed(&mut self, phase: ReconciliationPhase) {
                self.events.push((phase, "completed"));
            }
        }

        let temp = tempfile::tempdir().unwrap();
        let source = layout(temp.path(), "source");
        let destination = layout(temp.path(), "destination");
        persistence::save_session_history(&source.histories, &history("a", "source")).unwrap();
        let mut observer = RecordingObserver::default();

        let error = reconcile_internal(
            temp.path(),
            "0123456789abcdef0123456789abcdef",
            &source,
            &destination,
            &mut StopAt(Failpoint::AfterPrepared),
            &mut || Ok(()),
            &mut observer,
        )
        .unwrap_err();

        assert!(error.contains("AfterPrepared"));
        assert_eq!(
            observer.events.last(),
            Some(&(ReconciliationPhase::Publish, "started")),
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
