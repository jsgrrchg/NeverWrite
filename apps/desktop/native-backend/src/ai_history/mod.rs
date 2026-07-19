use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{mpsc::Sender, Mutex};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use neverwrite_ai::persistence::{self, PersistedSessionHistory};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::RpcOutput;

mod attachments;
#[allow(dead_code)]
mod migration;
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
    "ai_create_draft_attachment",
    "ai_promote_draft_attachment",
    "ai_delete_draft_attachment",
    "ai_read_managed_attachment",
    "ai_delete_managed_attachment_if_unreferenced",
    "ai_resolve_managed_attachment_path",
    "ai_get_history_storage_status",
    "ai_get_history_recovery_diagnostic",
    "ai_reveal_history_recovery_root",
    "ai_retry_history_recovery",
    "reconcile_ai_history_storage",
];

pub(crate) const AI_HISTORY_STORAGE_CHANGED_EVENT: &str = "ai_history_storage_changed";

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum StorageStatusSnapshot {
    Ready {
        vault_key: String,
        generation: u64,
        scope: storage::AIStorageScope,
        orphaned_device_histories: Vec<OrphanedDeviceHistory>,
    },
    Moving {
        vault_key: String,
        generation: u64,
        from: storage::AIStorageScope,
        to: storage::AIStorageScope,
        operation_id: String,
    },
    RecoveryRequired {
        vault_key: String,
        generation: u64,
        details: RecoveryDetails,
    },
    Error {
        vault_key: String,
        generation: u64,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryDetails {
    reason: String,
    message: String,
    can_reconcile: bool,
    conflicting_session_ids: Vec<String>,
    conflicting_attachment_ids: Vec<String>,
    renamed_device_history: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryDiagnostic {
    reason: String,
    message: String,
    can_reconcile: bool,
    conflicting_session_ids: Vec<String>,
    conflicting_attachment_ids: Vec<String>,
    roots: Vec<RecoveryDiagnosticRoot>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RecoveryRootId {
    Device,
    Vault,
    PreviousDevice,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryDiagnosticRoot {
    id: RecoveryRootId,
    label: &'static str,
    has_data: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OrphanedDeviceHistory {
    vault_key: String,
    previous_vault_path: String,
}

#[derive(Debug, Clone)]
enum RecoveryPlan {
    Roots {
        inspection: migration::ReconciliationInspection,
    },
    RenamedDevice {
        source_vault_key: String,
        source: storage::ScopeLayout,
    },
    MultipleLocalRoots {
        source: storage::ScopeLayout,
    },
}

impl RecoveryPlan {
    fn can_reconcile(&self) -> bool {
        match self {
            Self::Roots { inspection } => inspection.can_reconcile(),
            Self::RenamedDevice { .. } => true,
            Self::MultipleLocalRoots { .. } => false,
        }
    }
}

#[derive(Debug)]
enum CanonicalResolution {
    Ready(storage::AIStorageScope),
    Recovery(RecoveryDetails, Option<RecoveryPlan>),
}

#[derive(Debug)]
pub(crate) struct AiHistoryStorageService {
    app_data_root: PathBuf,
    housekept_vaults: Mutex<BTreeSet<PathBuf>>,
    validated_scopes: Mutex<BTreeMap<String, storage::AIStorageScope>>,
    generations: Mutex<BTreeMap<String, u64>>,
    event_tx: Option<Sender<RpcOutput>>,
}

impl Default for AiHistoryStorageService {
    fn default() -> Self {
        #[cfg(not(test))]
        let app_data_root = crate::ai::app_data_dir();
        #[cfg(test)]
        let app_data_root = std::env::temp_dir().join(format!(
            "neverwrite-ai-history-tests-{}",
            uuid::Uuid::new_v4().simple()
        ));
        Self::new(app_data_root)
    }
}

impl AiHistoryStorageService {
    fn new(app_data_root: PathBuf) -> Self {
        Self::with_optional_events(app_data_root, None)
    }

    pub(crate) fn with_events(app_data_root: PathBuf, event_tx: Sender<RpcOutput>) -> Self {
        Self::with_optional_events(app_data_root, Some(event_tx))
    }

    fn with_optional_events(app_data_root: PathBuf, event_tx: Option<Sender<RpcOutput>>) -> Self {
        attachments::cleanup_expired_drafts_globally(&app_data_root, attachments::now_ms());
        Self {
            app_data_root,
            housekept_vaults: Mutex::new(BTreeSet::new()),
            validated_scopes: Mutex::new(BTreeMap::new()),
            generations: Mutex::new(BTreeMap::new()),
            event_tx,
        }
    }

    pub(crate) fn handles(command: &str) -> bool {
        COMMANDS.contains(&command)
    }

    pub(crate) fn forget_device_data(&self, vault_path: &Path) -> Result<(), String> {
        if migration::has_pending(&self.app_data_root)? {
            return Err(
                "AI history recovery must finish before local device data can be forgotten."
                    .to_string(),
            );
        }
        let vault_key =
            storage::remove_device_namespace_for_known_path(&self.app_data_root, vault_path)?;
        self.validated_scopes
            .lock()
            .map_err(|error| format!("AI history validation state error: {error}"))?
            .remove(&vault_key);
        Ok(())
    }

    pub(crate) fn resolve_managed_attachment_for_runtime(
        &self,
        vault_root: &Path,
        attachment_id: &str,
    ) -> Result<(Vec<u8>, String, String), String> {
        let layout = storage::resolve_layout(&self.app_data_root, vault_root)?;
        let scope = self.resolve_ready_scope(&layout)?;
        let attachment_id = attachments::ManagedAttachmentId::parse(attachment_id)?;
        let (metadata, bytes) =
            attachments::read(&layout.scope(scope).attachment_owner, &attachment_id)?;
        Ok((bytes, metadata.file_name, metadata.mime_type))
    }

    fn next_generation(&self, vault_key: &str) -> u64 {
        let Ok(mut generations) = self.generations.lock() else {
            return 1;
        };
        let generation = generations.entry(vault_key.to_string()).or_default();
        *generation = generation.saturating_add(1).max(1);
        *generation
    }

    fn emit_snapshot(&self, snapshot: &StorageStatusSnapshot) {
        let Some(event_tx) = &self.event_tx else {
            return;
        };
        if let Ok(payload) = serde_json::to_value(snapshot) {
            let _ = event_tx.send(RpcOutput::Event {
                event_name: AI_HISTORY_STORAGE_CHANGED_EVENT.to_string(),
                payload,
            });
        }
    }

    fn snapshot_for_resolution(
        &self,
        layout: &storage::VaultStorageLayout,
        resolution: CanonicalResolution,
    ) -> Result<StorageStatusSnapshot, String> {
        let generation = self.next_generation(&layout.vault_key);
        Ok(match resolution {
            CanonicalResolution::Ready(scope) => {
                // A normal Ready snapshot may inspect the canonical root, but it
                // must never make UI availability depend on the inactive root.
                let orphaned_device_histories = if migration::inspect_layout(
                    &layout.scope(scope).transaction_layout(),
                )?
                .empty
                {
                    self.available_orphaned_device_histories(layout)?
                } else {
                    Vec::new()
                };
                StorageStatusSnapshot::Ready {
                    vault_key: layout.vault_key.clone(),
                    generation,
                    scope,
                    orphaned_device_histories,
                }
            }
            CanonicalResolution::Recovery(details, _) => StorageStatusSnapshot::RecoveryRequired {
                vault_key: layout.vault_key.clone(),
                generation,
                details,
            },
        })
    }

    fn storage_status(&self, layout: &storage::VaultStorageLayout) -> StorageStatusSnapshot {
        match self.resolve_canonical(layout) {
            Ok(resolution) => match self.snapshot_for_resolution(layout, resolution) {
                Ok(snapshot) => snapshot,
                Err(message) => StorageStatusSnapshot::Error {
                    vault_key: layout.vault_key.clone(),
                    generation: self.next_generation(&layout.vault_key),
                    message,
                },
            },
            Err(message) => StorageStatusSnapshot::Error {
                vault_key: layout.vault_key.clone(),
                generation: self.next_generation(&layout.vault_key),
                message,
            },
        }
    }

    fn recover_pending_operation(
        &self,
        layout: &storage::VaultStorageLayout,
    ) -> Result<(), String> {
        let operation = storage::read_operation(layout)?;
        let Some(operation) = operation else {
            if migration::has_pending(&self.app_data_root)? {
                return Err(
                    "An AI history transaction is pending recovery for another vault.".to_string(),
                );
            }
            return Ok(());
        };

        if matches!(
            storage::read_state(layout),
            storage::StateRead::Valid(storage::CanonicalState {
                kind: storage::CanonicalStateKind::Ready { scope },
                ..
            }) if scope == operation.to
        ) && !migration::has_pending(&self.app_data_root)?
        {
            storage::remove_operation(layout)?;
            return Ok(());
        }

        let source = match operation.source_vault_key.as_deref() {
            Some(source_vault_key) => {
                storage::device_scope_for_key(&self.app_data_root, source_vault_key)?
            }
            None => layout.scope(operation.from).clone(),
        };
        let destination = layout.scope(operation.to).clone();
        let target_state = storage::CanonicalState::ready(layout, operation.to);
        let recovered = migration::recover_operation_with_commit(
            &self.app_data_root,
            &operation.operation_id,
            &source.transaction_layout(),
            &destination.transaction_layout(),
            || storage::write_state(layout, &target_state),
        )?;
        if recovered {
            self.validated_scopes
                .lock()
                .map_err(|error| format!("AI history validation state error: {error}"))?
                .insert(layout.vault_key.clone(), operation.to);
        }
        storage::remove_operation(layout)
    }

    fn resolve_canonical(
        &self,
        layout: &storage::VaultStorageLayout,
    ) -> Result<CanonicalResolution, String> {
        self.recover_pending_operation(layout)?;
        match storage::read_state(layout) {
            storage::StateRead::Missing => self.initialize_missing_state(layout),
            storage::StateRead::Invalid(message) => Ok(CanonicalResolution::Recovery(
                RecoveryDetails {
                    reason: "invalid_state".to_string(),
                    message,
                    can_reconcile: false,
                    conflicting_session_ids: Vec::new(),
                    conflicting_attachment_ids: Vec::new(),
                    renamed_device_history: false,
                },
                None,
            )),
            storage::StateRead::Valid(state) => match state.kind {
                storage::CanonicalStateKind::Ready { scope } => {
                    self.validate_active_scope_once(layout, scope)?;
                    Ok(CanonicalResolution::Ready(scope))
                }
                storage::CanonicalStateKind::RecoveryRequired => {
                    self.inspect_recovery_state(layout)
                }
            },
        }
    }

    fn initialize_missing_state(
        &self,
        layout: &storage::VaultStorageLayout,
    ) -> Result<CanonicalResolution, String> {
        let renamed = storage::find_renamed_device_namespace(&self.app_data_root, layout)?;
        let device = migration::inspect_layout(&layout.device.transaction_layout());
        let vault = migration::inspect_layout(&layout.vault.transaction_layout());
        let (device, vault) = match (device, vault) {
            (Ok(device), Ok(vault)) => (device, vault),
            (device, vault) => {
                let message = device
                    .err()
                    .or_else(|| vault.err())
                    .unwrap_or_else(|| "AI history storage is not readable.".to_string());
                return Ok(CanonicalResolution::Recovery(
                    RecoveryDetails {
                        reason: "unreadable_storage".to_string(),
                        message,
                        can_reconcile: false,
                        conflicting_session_ids: Vec::new(),
                        conflicting_attachment_ids: Vec::new(),
                        renamed_device_history: false,
                    },
                    None,
                ));
            }
        };

        if let Some(candidate) = renamed {
            let renamed_inspection =
                migration::inspect_layout(&candidate.source.transaction_layout())?;
            if !renamed_inspection.empty {
                if !device.empty || !vault.empty {
                    return Ok(CanonicalResolution::Recovery(
                        RecoveryDetails {
                            reason: "multiple_local_roots".to_string(),
                            message: "Local AI history from the previous vault path exists alongside current storage.".to_string(),
                            can_reconcile: false,
                            conflicting_session_ids: Vec::new(),
                            conflicting_attachment_ids: Vec::new(),
                            renamed_device_history: true,
                        },
                        Some(RecoveryPlan::MultipleLocalRoots {
                            source: candidate.source,
                        }),
                    ));
                }
                storage::write_state(layout, &storage::CanonicalState::recovery_required(layout))?;
                return Ok(CanonicalResolution::Recovery(
                    RecoveryDetails {
                        reason: "vault_path_changed".to_string(),
                        message:
                            "Local AI chats from this vault's previous path are ready to import."
                                .to_string(),
                        can_reconcile: true,
                        conflicting_session_ids: Vec::new(),
                        conflicting_attachment_ids: Vec::new(),
                        renamed_device_history: true,
                    },
                    Some(RecoveryPlan::RenamedDevice {
                        source_vault_key: candidate.vault_key,
                        source: candidate.source,
                    }),
                ));
            }
        }

        let scope = match (device.empty, vault.empty) {
            (true, true) | (false, true) => Some(storage::AIStorageScope::Device),
            (true, false) => Some(storage::AIStorageScope::Vault),
            (false, false) => None,
        };
        if let Some(scope) = scope {
            storage::write_state(layout, &storage::CanonicalState::ready(layout, scope))?;
            self.validated_scopes
                .lock()
                .map_err(|error| format!("AI history validation state error: {error}"))?
                .insert(layout.vault_key.clone(), scope);
            return Ok(CanonicalResolution::Ready(scope));
        }

        storage::write_state(layout, &storage::CanonicalState::recovery_required(layout))?;
        self.inspect_recovery_state(layout)
    }

    fn available_orphaned_device_histories(
        &self,
        layout: &storage::VaultStorageLayout,
    ) -> Result<Vec<OrphanedDeviceHistory>, String> {
        let mut summaries = Vec::new();
        for candidate in storage::find_orphaned_device_namespaces(&self.app_data_root, layout)? {
            let inspection = migration::inspect_layout(&candidate.source.transaction_layout())?;
            if inspection.empty {
                continue;
            }
            summaries.push(OrphanedDeviceHistory {
                vault_key: candidate.vault_key.clone(),
                previous_vault_path: candidate.previous_vault_path,
            });
        }
        Ok(summaries)
    }

    fn selected_orphaned_device_source(
        &self,
        layout: &storage::VaultStorageLayout,
        source_vault_key: &str,
    ) -> Result<storage::ScopeLayout, String> {
        for candidate in storage::find_orphaned_device_namespaces(&self.app_data_root, layout)? {
            if candidate.vault_key != source_vault_key {
                continue;
            }
            if migration::inspect_layout(&candidate.source.transaction_layout())?.empty {
                break;
            }
            return Ok(candidate.source);
        }
        Err("The selected device-local AI history import is not available.".to_string())
    }

    fn inspect_recovery_state(
        &self,
        layout: &storage::VaultStorageLayout,
    ) -> Result<CanonicalResolution, String> {
        if let Some(candidate) =
            storage::find_renamed_device_namespace(&self.app_data_root, layout)?
        {
            let source_inspection =
                migration::inspect_layout(&candidate.source.transaction_layout())?;
            let device = migration::inspect_layout(&layout.device.transaction_layout())?;
            let vault = migration::inspect_layout(&layout.vault.transaction_layout())?;
            if !source_inspection.empty && device.empty && vault.empty {
                return Ok(CanonicalResolution::Recovery(
                    RecoveryDetails {
                        reason: "vault_path_changed".to_string(),
                        message:
                            "Local AI chats from this vault's previous path are ready to import."
                                .to_string(),
                        can_reconcile: true,
                        conflicting_session_ids: Vec::new(),
                        conflicting_attachment_ids: Vec::new(),
                        renamed_device_history: true,
                    },
                    Some(RecoveryPlan::RenamedDevice {
                        source_vault_key: candidate.vault_key,
                        source: candidate.source,
                    }),
                ));
            }
        }

        let device = migration::inspect_layout(&layout.device.transaction_layout());
        let vault = migration::inspect_layout(&layout.vault.transaction_layout());
        let (device, vault) = match (device, vault) {
            (Ok(device), Ok(vault)) => (device, vault),
            (device, vault) => {
                return Ok(CanonicalResolution::Recovery(
                    RecoveryDetails {
                        reason: "unreadable_storage".to_string(),
                        message: device
                            .err()
                            .or_else(|| vault.err())
                            .unwrap_or_else(|| "AI history storage is not readable.".to_string()),
                        can_reconcile: false,
                        conflicting_session_ids: Vec::new(),
                        conflicting_attachment_ids: Vec::new(),
                        renamed_device_history: false,
                    },
                    None,
                ));
            }
        };
        if device.empty || vault.empty {
            return Ok(CanonicalResolution::Recovery(
                RecoveryDetails {
                    reason: "manual_recovery_required".to_string(),
                    message: "AI history recovery is still required before chats can be loaded."
                        .to_string(),
                    can_reconcile: false,
                    conflicting_session_ids: Vec::new(),
                    conflicting_attachment_ids: Vec::new(),
                    renamed_device_history: false,
                },
                None,
            ));
        }
        let inspection = migration::inspect_reconciliation(
            &layout.device.transaction_layout(),
            &layout.vault.transaction_layout(),
        )?;
        let can_reconcile = inspection.can_reconcile();
        let details = RecoveryDetails {
            reason: if can_reconcile {
                "dual_roots".to_string()
            } else {
                "conflicting_roots".to_string()
            },
            message: if can_reconcile {
                "AI chats exist on this device and inside the vault. Choose one canonical location."
                    .to_string()
            } else {
                "Conflicting AI chats require manual resolution before storage can change."
                    .to_string()
            },
            can_reconcile,
            conflicting_session_ids: inspection.conflicting_session_ids.clone(),
            conflicting_attachment_ids: inspection.conflicting_attachment_ids.clone(),
            renamed_device_history: false,
        };
        Ok(CanonicalResolution::Recovery(
            details,
            Some(RecoveryPlan::Roots { inspection }),
        ))
    }

    fn validate_active_scope_once(
        &self,
        layout: &storage::VaultStorageLayout,
        scope: storage::AIStorageScope,
    ) -> Result<(), String> {
        let mut validated = self
            .validated_scopes
            .lock()
            .map_err(|error| format!("AI history validation state error: {error}"))?;
        if validated.get(&layout.vault_key) == Some(&scope) {
            return Ok(());
        }
        migration::inspect_layout(&layout.scope(scope).transaction_layout()).map_err(|error| {
            format!("The canonical AI history storage is not readable: {error}")
        })?;
        validated.insert(layout.vault_key.clone(), scope);
        Ok(())
    }

    fn resolve_ready_scope(
        &self,
        layout: &storage::VaultStorageLayout,
    ) -> Result<storage::AIStorageScope, String> {
        match self.resolve_canonical(layout)? {
            CanonicalResolution::Ready(scope) => Ok(scope),
            CanonicalResolution::Recovery(details, _) => Err(details.message),
        }
    }

    fn recovery_diagnostic(
        &self,
        layout: &storage::VaultStorageLayout,
    ) -> Result<RecoveryDiagnostic, String> {
        let resolution = self.resolve_canonical(layout)?;
        let CanonicalResolution::Recovery(details, plan) = resolution else {
            return Err("AI history recovery is not required.".to_string());
        };
        let device = migration::inspect_layout(&layout.device.transaction_layout())?;
        let vault = migration::inspect_layout(&layout.vault.transaction_layout())?;
        let mut roots = Vec::new();
        match plan {
            Some(RecoveryPlan::Roots { .. }) => {
                roots.push(RecoveryDiagnosticRoot {
                    id: RecoveryRootId::Device,
                    label: "Device data",
                    has_data: !device.empty,
                });
                roots.push(RecoveryDiagnosticRoot {
                    id: RecoveryRootId::Vault,
                    label: "Vault data",
                    has_data: !vault.empty,
                });
            }
            Some(RecoveryPlan::RenamedDevice { source, .. }) => {
                let previous = migration::inspect_layout(&source.transaction_layout())?;
                roots.push(RecoveryDiagnosticRoot {
                    id: RecoveryRootId::PreviousDevice,
                    label: "Previous local data",
                    has_data: !previous.empty,
                });
            }
            Some(RecoveryPlan::MultipleLocalRoots { source }) => {
                let previous = migration::inspect_layout(&source.transaction_layout())?;
                roots.push(RecoveryDiagnosticRoot {
                    id: RecoveryRootId::PreviousDevice,
                    label: "Previous local data",
                    has_data: !previous.empty,
                });
                roots.push(RecoveryDiagnosticRoot {
                    id: RecoveryRootId::Device,
                    label: "Current device data",
                    has_data: !device.empty,
                });
                roots.push(RecoveryDiagnosticRoot {
                    id: RecoveryRootId::Vault,
                    label: "Current vault data",
                    has_data: !vault.empty,
                });
            }
            None => {}
        }
        Ok(RecoveryDiagnostic {
            reason: details.reason,
            message: details.message,
            can_reconcile: details.can_reconcile,
            conflicting_session_ids: details.conflicting_session_ids,
            conflicting_attachment_ids: details.conflicting_attachment_ids,
            // Paths remain backend-only. The UI receives stable root IDs that
            // can be resolved by the reveal command without leaking locations.
            roots,
        })
    }

    fn recovery_reveal_root(
        &self,
        layout: &storage::VaultStorageLayout,
        root: RecoveryRootId,
    ) -> Result<PathBuf, String> {
        match self.resolve_canonical(layout)? {
            CanonicalResolution::Recovery(_, Some(RecoveryPlan::RenamedDevice { source, .. }))
                if root == RecoveryRootId::PreviousDevice =>
            {
                Ok(source.histories)
            }
            CanonicalResolution::Recovery(_, Some(RecoveryPlan::MultipleLocalRoots { source })) => {
                match root {
                    RecoveryRootId::PreviousDevice => Ok(source.histories),
                    RecoveryRootId::Device => Ok(layout.device.histories.clone()),
                    RecoveryRootId::Vault => Ok(layout.vault.histories.clone()),
                }
            }
            CanonicalResolution::Recovery(_, Some(RecoveryPlan::Roots { .. })) => match root {
                RecoveryRootId::Device => Ok(layout.device.histories.clone()),
                RecoveryRootId::Vault => Ok(layout.vault.histories.clone()),
                RecoveryRootId::PreviousDevice => Err(
                    "The previous local data root is not part of this recovery state.".to_string(),
                ),
            },
            CanonicalResolution::Recovery(_, _) => {
                Err("This recovery state does not have a safe data location to reveal.".to_string())
            }
            CanonicalResolution::Ready(_) => {
                Err("AI history recovery is not required.".to_string())
            }
        }
    }

    fn retry_recovery(
        &self,
        layout: &storage::VaultStorageLayout,
    ) -> Result<StorageStatusSnapshot, String> {
        self.recover_pending_operation(layout)?;
        if !matches!(
            storage::read_state(layout),
            storage::StateRead::Valid(storage::CanonicalState {
                kind: storage::CanonicalStateKind::RecoveryRequired,
                ..
            })
        ) {
            return Ok(self.storage_status(layout));
        }

        // A retry never picks a winner between two roots. It only restores a
        // canonical state after manual work leaves exactly one unambiguous root.
        if let Some(candidate) =
            storage::find_renamed_device_namespace(&self.app_data_root, layout)?
        {
            if !migration::inspect_layout(&candidate.source.transaction_layout())?.empty {
                let status = self.storage_status(layout);
                self.emit_snapshot(&status);
                return Ok(status);
            }
        }
        let device = migration::inspect_layout(&layout.device.transaction_layout())?;
        let vault = migration::inspect_layout(&layout.vault.transaction_layout())?;
        let scope = match (device.empty, vault.empty) {
            (true, true) | (false, true) => storage::AIStorageScope::Device,
            (true, false) => storage::AIStorageScope::Vault,
            (false, false) => {
                let status = self.storage_status(layout);
                self.emit_snapshot(&status);
                return Ok(status);
            }
        };
        storage::write_state(layout, &storage::CanonicalState::ready(layout, scope))?;
        self.validated_scopes
            .lock()
            .map_err(|error| format!("AI history validation state error: {error}"))?
            .insert(layout.vault_key.clone(), scope);
        let status = self.snapshot_for_resolution(layout, CanonicalResolution::Ready(scope))?;
        self.emit_snapshot(&status);
        Ok(status)
    }

    fn reconcile_storage(
        &self,
        layout: &storage::VaultStorageLayout,
        target: storage::AIStorageScope,
        source_vault_key: Option<&str>,
    ) -> Result<Value, String> {
        let resolution = self.resolve_canonical(layout)?;
        let (from, source, operation_source_vault_key) = match resolution {
            CanonicalResolution::Ready(_scope) if source_vault_key.is_some() => {
                let source_vault_key = source_vault_key.unwrap();
                let device = migration::inspect_layout(&layout.device.transaction_layout())?;
                let vault = migration::inspect_layout(&layout.vault.transaction_layout())?;
                if !device.empty || !vault.empty {
                    return Err(
                        "Device-local AI history can only be imported into empty current storage."
                            .to_string(),
                    );
                }
                let source = self.selected_orphaned_device_source(layout, source_vault_key)?;
                (
                    storage::AIStorageScope::Device,
                    source,
                    Some(source_vault_key.to_string()),
                )
            }
            CanonicalResolution::Ready(scope) if scope == target => {
                let status =
                    self.snapshot_for_resolution(layout, CanonicalResolution::Ready(scope))?;
                return Ok(json!({
                    "completed": true,
                    "status": status,
                    "historiesMoved": 0,
                    "attachmentsMoved": 0,
                    "conflicts": [],
                }));
            }
            CanonicalResolution::Ready(scope) => (scope, layout.scope(scope).clone(), None),
            CanonicalResolution::Recovery(_details, Some(plan)) if plan.can_reconcile() => {
                match plan {
                    RecoveryPlan::Roots { .. } => {
                        let source_scope = target.other();
                        (source_scope, layout.scope(source_scope).clone(), None)
                    }
                    RecoveryPlan::RenamedDevice {
                        source_vault_key,
                        source,
                    } => (
                        storage::AIStorageScope::Device,
                        source,
                        Some(source_vault_key),
                    ),
                    RecoveryPlan::MultipleLocalRoots { .. } => {
                        return Err("Multiple local AI history roots require manual resolution."
                            .to_string());
                    }
                }
            }
            CanonicalResolution::Recovery(details, _) => {
                return Err(details.message);
            }
        };
        let destination = layout.scope(target).clone();
        let operation_id = uuid::Uuid::new_v4().simple().to_string();
        let operation = storage::PendingOperation::new(
            layout,
            operation_id.clone(),
            from,
            target,
            operation_source_vault_key,
        );
        storage::write_operation(layout, &operation)?;

        let moving = StorageStatusSnapshot::Moving {
            vault_key: layout.vault_key.clone(),
            generation: self.next_generation(&layout.vault_key),
            from,
            to: target,
            operation_id,
        };
        self.emit_snapshot(&moving);

        let target_state = storage::CanonicalState::ready(layout, target);
        let result = migration::reconcile_with_operation_commit(
            &self.app_data_root,
            &operation.operation_id,
            &source.transaction_layout(),
            &destination.transaction_layout(),
            || storage::write_state(layout, &target_state),
        );
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                if !migration::has_pending(&self.app_data_root).unwrap_or(true) {
                    storage::remove_operation(layout).ok();
                }
                let final_snapshot = self.storage_status(layout);
                self.emit_snapshot(&final_snapshot);
                return Err(error);
            }
        };
        storage::remove_operation(layout)?;
        self.validated_scopes
            .lock()
            .map_err(|error| format!("AI history validation state error: {error}"))?
            .insert(layout.vault_key.clone(), target);
        let status = self.snapshot_for_resolution(layout, CanonicalResolution::Ready(target))?;
        self.emit_snapshot(&status);
        Ok(json!({
            "completed": true,
            "status": status,
            "historiesMoved": result.histories_moved,
            "attachmentsMoved": result.attachments_moved,
            "conflicts": [],
        }))
    }

    pub(crate) fn invoke(
        &self,
        command: &str,
        vault_root: &Path,
        args: Value,
    ) -> Result<Value, String> {
        let layout = storage::resolve_layout(&self.app_data_root, vault_root)?;
        if command == "ai_get_history_storage_status" {
            return serde_json::to_value(self.storage_status(&layout))
                .map_err(|error| error.to_string());
        }
        if command == "ai_get_history_recovery_diagnostic" {
            return serde_json::to_value(self.recovery_diagnostic(&layout)?)
                .map_err(|error| error.to_string());
        }
        if command == "ai_reveal_history_recovery_root" {
            let root: RecoveryRootId = serde_json::from_value(
                args.get("root")
                    .cloned()
                    .ok_or_else(|| "Missing argument: root".to_string())?,
            )
            .map_err(|_| "Invalid AI history recovery root.".to_string())?;
            let path = self.recovery_reveal_root(&layout, root)?;
            return Ok(json!({ "path": path }));
        }
        if command == "ai_retry_history_recovery" {
            return serde_json::to_value(self.retry_recovery(&layout)?)
                .map_err(|error| error.to_string());
        }
        if command == "reconcile_ai_history_storage" {
            let target: storage::AIStorageScope = serde_json::from_value(
                args.get("targetScope")
                    .or_else(|| args.get("target_scope"))
                    .cloned()
                    .ok_or_else(|| "Missing argument: targetScope".to_string())?,
            )
            .map_err(|_| "Invalid AI history target scope.".to_string())?;
            let source_vault_key = args
                .get("sourceVaultKey")
                .or_else(|| args.get("source_vault_key"))
                .and_then(Value::as_str);
            return self.reconcile_storage(&layout, target, source_vault_key);
        }
        if command == "ai_create_draft_attachment" {
            let file_name = required_string(&args, &["fileName", "file_name"])?;
            let mime_type = required_string(&args, &["mimeType", "mime_type"])?;
            let bytes = required_bytes(&args)?;
            let metadata = attachments::create_draft(
                &self.app_data_root,
                &layout.draft_root,
                &file_name,
                &mime_type,
                &bytes,
            )?;
            return Ok(json!({
                "draft_attachment_id": metadata.draft_id.as_str(),
                "file_name": metadata.file_name,
                "mime_type": metadata.mime_type,
            }));
        }
        if command == "ai_delete_draft_attachment" {
            let draft_id = required_draft_attachment_id(&args)?;
            let deleted =
                attachments::delete_draft(&self.app_data_root, &layout.draft_root, &draft_id)?;
            return Ok(json!({ "deleted": deleted }));
        }
        let scope = self.resolve_ready_scope(&layout)?;
        let scope_layout = layout.scope(scope);
        let storage_root = scope_layout.histories.clone();
        let attachment_owner = &scope_layout.attachment_owner;
        let draft_root = layout.draft_root.clone();
        self.run_startup_housekeeping(attachment_owner, &storage_root);
        match command {
            "ai_save_session_history" => {
                let history_value = args
                    .get("history")
                    .cloned()
                    .ok_or_else(|| "Missing argument: history".to_string())?;
                let managed_attachment_ids =
                    validate_managed_attachment_shapes(attachment_owner, &history_value)?;
                let history: PersistedSessionHistory =
                    serde_json::from_value(history_value).map_err(|error| error.to_string())?;
                persistence::save_session_history(&storage_root, &history)?;
                for attachment_id in managed_attachment_ids {
                    attachments::mark_committed(attachment_owner, &attachment_id)?;
                }
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
                    attachment_owner,
                    before,
                    attachment_gc_snapshot(&storage_root),
                );
                Ok(json!(null))
            }
            "ai_delete_all_session_histories" => {
                let before = attachment_gc_snapshot(&storage_root);
                persistence::delete_all_session_histories(&storage_root)?;
                cleanup_removed_references(
                    attachment_owner,
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
                    attachment_owner,
                    before,
                    attachment_gc_snapshot(&storage_root),
                );
                Ok(json!(deleted))
            }
            "ai_create_managed_attachment" => {
                let file_name = required_string(&args, &["fileName", "file_name"])?;
                let mime_type = required_string(&args, &["mimeType", "mime_type"])?;
                let bytes = required_bytes(&args)?;
                let metadata =
                    attachments::create(attachment_owner, &file_name, &mime_type, &bytes)?;
                Ok(json!({
                    "attachment_id": metadata.attachment_id.as_str(),
                    "file_name": metadata.file_name,
                    "mime_type": metadata.mime_type,
                }))
            }
            "ai_promote_draft_attachment" => {
                let draft_id = required_draft_attachment_id(&args)?;
                let metadata = attachments::promote_draft(
                    &self.app_data_root,
                    &draft_root,
                    attachment_owner,
                    &draft_id,
                )?;
                Ok(json!({
                    "attachment_id": metadata.attachment_id.as_str(),
                    "file_name": metadata.file_name,
                    "mime_type": metadata.mime_type,
                }))
            }
            "ai_read_managed_attachment" => {
                let attachment_id = required_managed_attachment_id(&args)?;
                let (metadata, bytes) = attachments::read(attachment_owner, &attachment_id)?;
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
                match attachments::delete_if_unreferenced(
                    attachment_owner,
                    &attachment_id,
                    attachments::now_ms(),
                )? {
                    attachments::UnreferencedDeletion::Deleted(deleted) => {
                        Ok(json!({ "deleted": deleted, "protected": false }))
                    }
                    attachments::UnreferencedDeletion::Protected => {
                        Ok(json!({ "deleted": false, "protected": true }))
                    }
                }
            }
            "ai_resolve_managed_attachment_path" => {
                let attachment_id = required_managed_attachment_id(&args)?;
                let resolved = attachments::resolve(attachment_owner, &attachment_id)?;
                Ok(json!({
                    "path": resolved.path,
                    "mime_type": resolved.metadata.mime_type,
                    "file_name": resolved.metadata.file_name,
                }))
            }
            _ => Err(format!("Unsupported AI history command: {command}")),
        }
    }

    fn run_startup_housekeeping(&self, attachment_owner: &Path, storage_root: &Path) {
        let Ok(canonical_owner) = attachment_owner.canonicalize() else {
            return;
        };
        let Ok(mut housekept) = self.housekept_vaults.lock() else {
            return;
        };
        if !housekept.insert(canonical_owner) {
            return;
        }
        drop(housekept);

        let now = attachments::now_ms();
        attachments::cleanup_expired_managed_staging(attachment_owner, now);
        let inventory = attachment_gc_snapshot(storage_root);
        if inventory.safe {
            attachments::cleanup_expired_promotions(attachment_owner, &inventory.all_ids(), now);
        }
    }
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

fn validate_managed_attachment_shapes(
    vault_root: &Path,
    history: &Value,
) -> Result<BTreeSet<attachments::ManagedAttachmentId>, String> {
    let mut managed_attachment_ids = BTreeSet::new();
    let Some(messages) = history.get("messages").and_then(Value::as_array) else {
        return Ok(managed_attachment_ids);
    };
    for message in messages {
        let Some(attachments_value) = message.get("attachments") else {
            continue;
        };
        if attachments_value.is_null() {
            continue;
        }
        let attachments = attachments_value
            .as_array()
            .ok_or_else(|| "History attachments must be an array or null.".to_string())?;
        for attachment in attachments {
            if !attachment.is_object() {
                return Err("History attachment entries must be objects.".to_string());
            }
            if contains_draft_attachment_id(attachment) {
                return Err("Draft attachments cannot be persisted in history.".to_string());
            }
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
                return Err(
                    "Managed attachments cannot include paths or inline content.".to_string(),
                );
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
            managed_attachment_ids.insert(id);
        }
    }
    Ok(managed_attachment_ids)
}

fn contains_draft_attachment_id(value: &Value) -> bool {
    match value {
        Value::Object(object) => object.iter().any(|(key, child)| {
            let normalized_key: String = key
                .chars()
                .filter(|character| character.is_ascii_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect();
            (normalized_key == "draftattachmentid" && !child.is_null())
                || contains_draft_attachment_id(child)
        }),
        Value::Array(values) => values.iter().any(contains_draft_attachment_id),
        _ => false,
    }
}

fn required_managed_attachment_id(
    args: &Value,
) -> Result<attachments::ManagedAttachmentId, String> {
    let value = required_string(args, &["attachmentId", "attachment_id"])?;
    attachments::ManagedAttachmentId::parse(&value)
}

fn required_draft_attachment_id(args: &Value) -> Result<attachments::DraftAttachmentId, String> {
    let value = required_string(args, &["draftAttachmentId", "draft_attachment_id"])?;
    attachments::DraftAttachmentId::parse(&value)
}

fn required_bytes(args: &Value) -> Result<Vec<u8>, String> {
    serde_json::from_value(
        args.get("bytes")
            .cloned()
            .ok_or_else(|| "Missing argument: bytes".to_string())?,
    )
    .map_err(|error| format!("Invalid argument: bytes: {error}"))
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

    fn active_scope_layout(
        service: &AiHistoryStorageService,
        vault: &Path,
    ) -> storage::ScopeLayout {
        let layout = storage::resolve_layout(&service.app_data_root, vault).unwrap();
        let storage::StateRead::Valid(state) = storage::read_state(&layout) else {
            panic!("expected valid canonical state");
        };
        let storage::CanonicalStateKind::Ready { scope } = state.kind else {
            panic!("expected ready canonical state");
        };
        layout.scope(scope).clone()
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

    fn text_history(session_id: &str, content: &str) -> PersistedSessionHistory {
        serde_json::from_value(json!({
            "version": 1,
            "session_id": session_id,
            "runtime_id": "codex-acp",
            "model_id": "test-model",
            "mode_id": "default",
            "created_at": 1,
            "updated_at": 2,
            "messages": [{
                "id": format!("message-{session_id}"),
                "role": "user",
                "kind": "text",
                "content": content,
                "timestamp": 2
            }]
        }))
        .unwrap()
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
    fn initializes_new_and_legacy_vaults_without_mixing_roots() {
        let app_data = tempfile::tempdir().unwrap();
        let new_vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        let status = service
            .invoke("ai_get_history_storage_status", new_vault.path(), json!({}))
            .unwrap();
        assert_eq!(status["status"], "ready");
        assert_eq!(status["scope"], "device");

        service
            .invoke(
                "ai_save_session_history",
                new_vault.path(),
                json!({ "history": text_history("device", "local") }),
            )
            .unwrap();
        assert!(!new_vault.path().join(".neverwrite").exists());

        let legacy_vault = tempfile::tempdir().unwrap();
        persistence::save_session_history(
            &legacy_vault.path().join(".neverwrite"),
            &text_history("legacy", "inside vault"),
        )
        .unwrap();
        let status = service
            .invoke(
                "ai_get_history_storage_status",
                legacy_vault.path(),
                json!({}),
            )
            .unwrap();
        assert_eq!(status["scope"], "vault");
    }

    #[test]
    fn ready_status_never_inspects_the_inactive_root() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        service
            .invoke(
                "ai_save_session_history",
                vault.path(),
                json!({ "history": text_history("device", "canonical") }),
            )
            .unwrap();
        fs::create_dir_all(vault.path().join(".neverwrite")).unwrap();
        fs::write(
            vault.path().join(".neverwrite/unknown-artifact"),
            b"inactive corruption",
        )
        .unwrap();

        let status = service
            .invoke("ai_get_history_storage_status", vault.path(), json!({}))
            .unwrap();

        assert_eq!(status["status"], "ready");
        assert_eq!(status["scope"], "device");
    }

    #[test]
    fn dual_roots_require_a_target_and_conflicts_remain_blocked() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        let layout = storage::resolve_layout(app_data.path(), vault.path()).unwrap();
        persistence::save_session_history(
            &layout.device.histories,
            &text_history("device", "local"),
        )
        .unwrap();
        persistence::save_session_history(
            &layout.vault.histories,
            &text_history("vault", "shared"),
        )
        .unwrap();

        let status = service
            .invoke("ai_get_history_storage_status", vault.path(), json!({}))
            .unwrap();
        assert_eq!(status["status"], "recovery_required");
        assert_eq!(status["details"]["canReconcile"], true);
        let draft = service
            .invoke(
                "ai_create_draft_attachment",
                vault.path(),
                json!({
                    "fileName": "draft.png",
                    "mimeType": "image/png",
                    "bytes": PNG,
                }),
            )
            .unwrap();
        assert!(service
            .invoke(
                "ai_delete_draft_attachment",
                vault.path(),
                json!({ "draftAttachmentId": draft["draft_attachment_id"] }),
            )
            .is_ok());

        let moved = service
            .invoke(
                "reconcile_ai_history_storage",
                vault.path(),
                json!({ "targetScope": "device" }),
            )
            .unwrap();
        assert_eq!(moved["completed"], true);
        assert_eq!(moved["status"]["scope"], "device");
        assert_eq!(
            persistence::load_all_session_histories(&layout.device.histories, false)
                .unwrap()
                .len(),
            2
        );
        assert!(!layout.vault.histories.exists());

        let conflict_vault = tempfile::tempdir().unwrap();
        let conflict_layout =
            storage::resolve_layout(app_data.path(), conflict_vault.path()).unwrap();
        persistence::save_session_history(
            &conflict_layout.device.histories,
            &text_history("same", "device"),
        )
        .unwrap();
        persistence::save_session_history(
            &conflict_layout.vault.histories,
            &text_history("same", "vault"),
        )
        .unwrap();
        let status = service
            .invoke(
                "ai_get_history_storage_status",
                conflict_vault.path(),
                json!({}),
            )
            .unwrap();
        assert_eq!(status["details"]["canReconcile"], false);
        assert_eq!(status["details"]["conflictingSessionIds"][0], "same");
        assert!(service
            .invoke(
                "reconcile_ai_history_storage",
                conflict_vault.path(),
                json!({ "targetScope": "vault" }),
            )
            .is_err());
    }

    #[test]
    fn conflicting_recovery_exposes_only_owned_roots_and_retries_after_manual_resolution() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        let layout = storage::resolve_layout(app_data.path(), vault.path()).unwrap();
        persistence::save_session_history(
            &layout.device.histories,
            &text_history("same", "device"),
        )
        .unwrap();
        persistence::save_session_history(&layout.vault.histories, &text_history("same", "vault"))
            .unwrap();

        let diagnostic = service
            .invoke(
                "ai_get_history_recovery_diagnostic",
                vault.path(),
                json!({}),
            )
            .unwrap();
        assert_eq!(diagnostic["conflictingSessionIds"], json!(["same"]));
        assert!(diagnostic.get("path").is_none());
        assert_eq!(diagnostic["roots"][0]["id"], "device");
        assert_eq!(diagnostic["roots"][0]["label"], "Device data");
        assert_eq!(diagnostic["roots"][0]["hasData"], true);

        let revealed = service
            .invoke(
                "ai_reveal_history_recovery_root",
                vault.path(),
                json!({ "root": "device" }),
            )
            .unwrap();
        assert_eq!(revealed["path"], json!(layout.device.histories));
        assert!(service
            .invoke(
                "ai_reveal_history_recovery_root",
                vault.path(),
                json!({ "root": "outside" }),
            )
            .is_err());

        fs::remove_dir_all(&layout.vault.histories).unwrap();
        let status = service
            .invoke("ai_retry_history_recovery", vault.path(), json!({}))
            .unwrap();
        assert_eq!(status["status"], "ready");
        assert_eq!(status["scope"], "device");
        assert!(service
            .invoke("ai_load_session_histories", vault.path(), json!({}))
            .is_ok());
    }

    #[test]
    fn reconcile_emits_moving_then_ready_and_preview_ids_survive() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let (event_tx, event_rx) = std::sync::mpsc::channel();
        let service = AiHistoryStorageService::with_events(app_data.path().to_path_buf(), event_tx);
        let attachment_id = create_attachment(&service, vault.path());
        save_history(&service, vault.path(), "session", &attachment_id, 10);

        service
            .invoke(
                "reconcile_ai_history_storage",
                vault.path(),
                json!({ "targetScope": "vault" }),
            )
            .unwrap();

        let events = [event_rx.recv().unwrap(), event_rx.recv().unwrap()];
        let statuses = events.map(|event| match event {
            RpcOutput::Event {
                event_name,
                payload,
            } => {
                assert_eq!(event_name, AI_HISTORY_STORAGE_CHANGED_EVENT);
                payload["status"].as_str().unwrap().to_string()
            }
            _ => panic!("expected storage event"),
        });
        assert_eq!(statuses, ["moving", "ready"]);
        assert!(service
            .invoke(
                "ai_read_managed_attachment",
                vault.path(),
                json!({ "attachmentId": attachment_id }),
            )
            .is_ok());
    }

    #[test]
    fn recovery_commits_a_synced_temporary_state_after_source_withdrawal() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let layout = storage::resolve_layout(app_data.path(), vault.path()).unwrap();
        storage::write_state(
            &layout,
            &storage::CanonicalState::ready(&layout, storage::AIStorageScope::Device),
        )
        .unwrap();
        persistence::save_session_history(
            &layout.device.histories,
            &text_history("recover-state", "durable"),
        )
        .unwrap();
        let operation = storage::PendingOperation::new(
            &layout,
            uuid::Uuid::new_v4().simple().to_string(),
            storage::AIStorageScope::Device,
            storage::AIStorageScope::Vault,
            None,
        );
        storage::write_operation(&layout, &operation).unwrap();
        let target_state = storage::CanonicalState::ready(&layout, storage::AIStorageScope::Vault);
        let temporary = layout.state_file.with_extension("json.tmp");
        let error = migration::reconcile_with_operation_commit(
            app_data.path(),
            &operation.operation_id,
            &layout.device.transaction_layout(),
            &layout.vault.transaction_layout(),
            || {
                fs::write(
                    &temporary,
                    serde_json::to_vec_pretty(&target_state).unwrap(),
                )
                .unwrap();
                Err("simulated crash before state replace".to_string())
            },
        )
        .unwrap_err();
        assert!(error.contains("simulated crash"));
        assert!(layout.state_file.is_file());
        assert!(temporary.is_file());

        let restarted = AiHistoryStorageService::new(app_data.path().to_path_buf());
        let status = restarted
            .invoke("ai_get_history_storage_status", vault.path(), json!({}))
            .unwrap();

        assert_eq!(status["status"], "ready");
        assert_eq!(status["scope"], "vault");
        assert!(!temporary.exists());
        assert!(!layout.operation_file.exists());
        assert!(!migration::has_pending(app_data.path()).unwrap());
        assert!(!layout.device.histories.exists());
        assert_eq!(
            persistence::load_all_session_histories(&layout.vault.histories, true)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn forgetting_recents_data_never_deletes_vault_scoped_history() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        service
            .invoke(
                "ai_save_session_history",
                vault.path(),
                json!({ "history": text_history("device", "local") }),
            )
            .unwrap();
        persistence::save_session_history(
            &vault.path().join(".neverwrite"),
            &text_history("vault", "preserve"),
        )
        .unwrap();
        let layout = storage::resolve_layout(app_data.path(), vault.path()).unwrap();

        service.forget_device_data(vault.path()).unwrap();

        assert!(!layout.namespace.exists());
        assert_eq!(
            persistence::load_all_session_histories(&layout.vault.histories, false)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn a_renamed_vault_requires_visible_import_before_local_history_moves() {
        let app_data = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let original = parent.path().join("original");
        fs::create_dir(&original).unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        service
            .invoke(
                "ai_save_session_history",
                &original,
                json!({ "history": text_history("local", "before rename") }),
            )
            .unwrap();

        let renamed = parent.path().join("renamed");
        fs::rename(&original, &renamed).unwrap();
        let status = service
            .invoke("ai_get_history_storage_status", &renamed, json!({}))
            .unwrap();
        assert_eq!(status["status"], "recovery_required");
        assert_eq!(status["details"]["renamedDeviceHistory"], true);
        assert_eq!(status["details"]["canReconcile"], true);

        service
            .invoke(
                "reconcile_ai_history_storage",
                &renamed,
                json!({ "targetScope": "device" }),
            )
            .unwrap();
        let histories = service
            .invoke(
                "ai_load_session_histories",
                &renamed,
                json!({ "includeMessages": false }),
            )
            .unwrap();
        assert_eq!(histories.as_array().unwrap().len(), 1);
        assert_eq!(histories[0]["session_id"], "local");
    }

    #[test]
    fn multiple_local_roots_expose_previous_and_current_data_for_manual_recovery() {
        let app_data = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let original = parent.path().join("original");
        fs::create_dir(&original).unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        service
            .invoke(
                "ai_save_session_history",
                &original,
                json!({ "history": text_history("previous", "before rename") }),
            )
            .unwrap();

        let renamed = parent.path().join("renamed");
        fs::rename(&original, &renamed).unwrap();
        let current_layout = storage::resolve_layout(app_data.path(), &renamed).unwrap();
        persistence::save_session_history(
            &current_layout.vault.histories,
            &text_history("current", "after rename"),
        )
        .unwrap();

        let status = service
            .invoke("ai_get_history_storage_status", &renamed, json!({}))
            .unwrap();
        assert_eq!(status["details"]["reason"], "multiple_local_roots");

        let previous = storage::find_renamed_device_namespace(app_data.path(), &current_layout)
            .unwrap()
            .unwrap();
        let diagnostic = service
            .invoke("ai_get_history_recovery_diagnostic", &renamed, json!({}))
            .unwrap();
        assert_eq!(diagnostic["roots"].as_array().unwrap().len(), 3);
        assert_eq!(diagnostic["roots"][0]["id"], "previous_device");
        assert_eq!(diagnostic["roots"][0]["hasData"], true);
        assert_eq!(diagnostic["roots"][1]["id"], "device");
        assert_eq!(diagnostic["roots"][1]["hasData"], false);
        assert_eq!(diagnostic["roots"][2]["id"], "vault");
        assert_eq!(diagnostic["roots"][2]["hasData"], true);

        let previous_path = service
            .invoke(
                "ai_reveal_history_recovery_root",
                &renamed,
                json!({ "root": "previous_device" }),
            )
            .unwrap();
        assert_eq!(previous_path["path"], json!(previous.source.histories));
        let current_path = service
            .invoke(
                "ai_reveal_history_recovery_root",
                &renamed,
                json!({ "root": "vault" }),
            )
            .unwrap();
        assert_eq!(current_path["path"], json!(current_layout.vault.histories));
    }

    #[test]
    fn recreating_a_vault_path_never_reuses_its_device_history_namespace() {
        let app_data = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let vault = parent.path().join("vault");
        fs::create_dir(&vault).unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        service
            .invoke(
                "ai_save_session_history",
                &vault,
                json!({ "history": text_history("original", "before replacement") }),
            )
            .unwrap();

        fs::remove_dir_all(&vault).unwrap();
        fs::create_dir(&vault).unwrap();

        let status = service
            .invoke("ai_get_history_storage_status", &vault, json!({}))
            .unwrap();
        assert_eq!(status["status"], "recovery_required");
        assert_eq!(status["details"]["reason"], "invalid_state");
        assert!(status["details"]["message"]
            .as_str()
            .unwrap()
            .contains("previous vault"));
        assert!(service
            .invoke("ai_load_session_histories", &vault, json!({}))
            .is_err());
    }

    #[test]
    fn a_cross_volume_move_requires_an_explicit_orphan_import_choice() {
        let app_data = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let original = parent.path().join("original");
        fs::create_dir(&original).unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        service
            .invoke(
                "ai_save_session_history",
                &original,
                json!({ "history": text_history("local", "before move") }),
            )
            .unwrap();
        let old_layout = storage::resolve_layout(app_data.path(), &original).unwrap();
        let previous_path = old_layout.canonical_vault_path.clone();
        fs::remove_dir_all(&original).unwrap();
        let moved = parent.path().join("moved-on-another-volume");
        fs::create_dir(&moved).unwrap();

        let status = service
            .invoke("ai_get_history_storage_status", &moved, json!({}))
            .unwrap();
        assert_eq!(status["status"], "ready");
        assert_eq!(status["scope"], "device");
        assert_eq!(
            status["orphanedDeviceHistories"][0]["previousVaultPath"],
            previous_path
        );
        let source_vault_key = status["orphanedDeviceHistories"][0]["vaultKey"]
            .as_str()
            .unwrap();

        let unrelated = parent.path().join("unrelated-new-vault");
        fs::create_dir(&unrelated).unwrap();
        let unrelated_status = service
            .invoke("ai_get_history_storage_status", &unrelated, json!({}))
            .unwrap();
        assert_eq!(unrelated_status["status"], "ready");
        assert_eq!(unrelated_status["scope"], "device");

        let no_op = service
            .invoke(
                "reconcile_ai_history_storage",
                &moved,
                json!({ "targetScope": "device" }),
            )
            .unwrap();
        assert_eq!(no_op["historiesMoved"], 0);

        service
            .invoke(
                "reconcile_ai_history_storage",
                &moved,
                json!({
                    "targetScope": "device",
                    "sourceVaultKey": source_vault_key,
                }),
            )
            .unwrap();
        let histories = service
            .invoke("ai_load_session_histories", &moved, json!({}))
            .unwrap();
        assert_eq!(histories[0]["session_id"], "local");
    }

    #[test]
    fn sequential_moves_route_an_intervening_save_to_the_latest_scope() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        service
            .invoke(
                "ai_save_session_history",
                vault.path(),
                json!({ "history": text_history("before", "device") }),
            )
            .unwrap();

        service
            .invoke(
                "reconcile_ai_history_storage",
                vault.path(),
                json!({ "targetScope": "vault" }),
            )
            .unwrap();
        service
            .invoke(
                "ai_save_session_history",
                vault.path(),
                json!({ "history": text_history("queued", "latest scope") }),
            )
            .unwrap();
        service
            .invoke(
                "reconcile_ai_history_storage",
                vault.path(),
                json!({ "targetScope": "device" }),
            )
            .unwrap();

        let layout = storage::resolve_layout(app_data.path(), vault.path()).unwrap();
        let histories =
            persistence::load_all_session_histories(&layout.device.histories, true).unwrap();
        assert_eq!(histories.len(), 2);
        assert!(!layout.vault.histories.exists());
    }

    #[test]
    fn draft_promotion_becomes_committed_only_when_history_is_saved() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        let draft = service
            .invoke(
                "ai_create_draft_attachment",
                vault.path(),
                json!({
                    "fileName": "pasted-image.png",
                    "mimeType": "image/png",
                    "bytes": PNG,
                }),
            )
            .unwrap();
        let promoted = service
            .invoke(
                "ai_promote_draft_attachment",
                vault.path(),
                json!({ "draftAttachmentId": draft["draft_attachment_id"] }),
            )
            .unwrap();
        let attachment_id = promoted["attachment_id"].as_str().unwrap();
        let committed_marker = attachments::managed_root(
            &active_scope_layout(&service, vault.path()).attachment_owner,
        )
        .join(attachment_id)
        .join("committed");
        assert!(!committed_marker.exists());

        save_history(&service, vault.path(), "session", attachment_id, 10);

        assert!(committed_marker.is_file());
    }

    #[test]
    fn save_rejects_draft_only_and_hybrid_attachments_without_writing_history() {
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService::default();
        let attachment_id = create_attachment(&service, vault.path());

        for hybrid in [false, true] {
            let mut payload = history("session", &attachment_id, 10);
            payload["messages"][0]["attachments"][0]["draftAttachmentId"] =
                json!("da_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
            if !hybrid {
                payload["messages"][0]["attachments"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove("managedAttachmentId");
            }

            let error = service
                .invoke(
                    "ai_save_session_history",
                    vault.path(),
                    json!({ "history": payload }),
                )
                .unwrap_err();

            assert!(error.contains("Draft attachments cannot be persisted"));
        }
        for attachments in [
            json!({ "draftAttachmentId": "da_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
            json!([{
                "metadata": {
                    "draftAttachmentId": "da_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                }
            }]),
            json!([{
                "draft_attachment_id": "da_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            }]),
        ] {
            let mut payload = history("session", &attachment_id, 10);
            payload["messages"][0]["attachments"] = attachments;

            assert!(service
                .invoke(
                    "ai_save_session_history",
                    vault.path(),
                    json!({ "history": payload }),
                )
                .is_err());
        }
        assert!(!vault
            .path()
            .join(".neverwrite/sessions/session.json")
            .exists());
    }

    #[test]
    fn renderer_cleanup_respects_the_uncommitted_promotion_grace_period() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService::new(app_data.path().to_path_buf());
        let draft = service
            .invoke(
                "ai_create_draft_attachment",
                vault.path(),
                json!({
                    "fileName": "pasted-image.png",
                    "mimeType": "image/png",
                    "bytes": PNG,
                }),
            )
            .unwrap();
        let promoted = service
            .invoke(
                "ai_promote_draft_attachment",
                vault.path(),
                json!({ "draftAttachmentId": draft["draft_attachment_id"] }),
            )
            .unwrap();
        let attachment_id = promoted["attachment_id"].as_str().unwrap();

        let protected = service
            .invoke(
                "ai_delete_managed_attachment_if_unreferenced",
                vault.path(),
                json!({ "attachmentId": attachment_id }),
            )
            .unwrap();
        assert_eq!(protected["deleted"], false);
        assert_eq!(protected["protected"], true);

        let metadata_path = attachments::managed_root(
            &active_scope_layout(&service, vault.path()).attachment_owner,
        )
        .join(attachment_id)
        .join("metadata.json");
        let mut metadata: Value =
            serde_json::from_slice(&fs::read(&metadata_path).unwrap()).unwrap();
        metadata["promoted_at_ms"] = json!(1);
        fs::write(metadata_path, serde_json::to_vec(&metadata).unwrap()).unwrap();

        let deleted = service
            .invoke(
                "ai_delete_managed_attachment_if_unreferenced",
                vault.path(),
                json!({ "attachmentId": attachment_id }),
            )
            .unwrap();
        assert_eq!(deleted["deleted"], true);
        assert_eq!(deleted["protected"], false);
    }

    #[test]
    fn shared_managed_blobs_survive_until_the_last_history_reference_is_deleted() {
        let vault = tempfile::tempdir().unwrap();
        let service = AiHistoryStorageService::default();
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
        let service = AiHistoryStorageService::default();
        let attachment_id = create_attachment(&service, vault.path());
        let mut payload = history("session", &attachment_id, 10);
        payload["messages"][0]["attachments"][0]["filePath"] = json!("/tmp/should-not-persist.png");

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
        let service = AiHistoryStorageService::default();
        let attachment_id = create_attachment(&service, vault.path());
        let active = active_scope_layout(&service, vault.path());
        fs::create_dir_all(active.histories.join("sessions")).unwrap();
        fs::write(active.histories.join("sessions/broken.json"), b"{broken").unwrap();

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
        let service = AiHistoryStorageService::default();
        let attachment_id = create_attachment(&service, vault.path());
        save_history(&service, vault.path(), "session", &attachment_id, 10);
        let generic_asset = vault.path().join("assets/chat/keep.png");
        fs::create_dir_all(generic_asset.parent().unwrap()).unwrap();
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
        let service = AiHistoryStorageService::default();
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
