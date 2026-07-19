use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::attachments;
use super::migration::RootLayout;

const STATE_VERSION: u32 = 1;
const OPERATION_VERSION: u32 = 1;
const VAULT_STORAGE_DIR: &str = ".neverwrite";
const STATE_FILE: &str = "state.json";
const OPERATION_FILE: &str = "operation.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum AIStorageScope {
    Device,
    Vault,
}

impl AIStorageScope {
    pub(crate) fn other(self) -> Self {
        match self {
            Self::Device => Self::Vault,
            Self::Vault => Self::Device,
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct ScopeLayout {
    pub histories: PathBuf,
    pub attachment_owner: PathBuf,
    pub managed: PathBuf,
}

impl ScopeLayout {
    pub(super) fn transaction_layout(&self) -> RootLayout {
        RootLayout {
            histories: self.histories.clone(),
            managed: self.managed.clone(),
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct VaultStorageLayout {
    pub vault_key: String,
    pub filesystem_identity: String,
    pub canonical_vault_path: String,
    pub namespace: PathBuf,
    pub state_file: PathBuf,
    pub operation_file: PathBuf,
    pub draft_root: PathBuf,
    pub device: ScopeLayout,
    pub vault: ScopeLayout,
}

impl VaultStorageLayout {
    pub(super) fn scope(&self, scope: AIStorageScope) -> &ScopeLayout {
        match scope {
            AIStorageScope::Device => &self.device,
            AIStorageScope::Vault => &self.vault,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CanonicalState {
    version: u32,
    pub vault_key: String,
    pub filesystem_identity: String,
    pub vault_path: String,
    pub kind: CanonicalStateKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum CanonicalStateKind {
    Ready { scope: AIStorageScope },
    RecoveryRequired,
}

impl CanonicalState {
    pub(super) fn ready(layout: &VaultStorageLayout, scope: AIStorageScope) -> Self {
        Self {
            version: STATE_VERSION,
            vault_key: layout.vault_key.clone(),
            filesystem_identity: layout.filesystem_identity.clone(),
            vault_path: layout.canonical_vault_path.clone(),
            kind: CanonicalStateKind::Ready { scope },
        }
    }

    pub(super) fn recovery_required(layout: &VaultStorageLayout) -> Self {
        Self {
            version: STATE_VERSION,
            vault_key: layout.vault_key.clone(),
            filesystem_identity: layout.filesystem_identity.clone(),
            vault_path: layout.canonical_vault_path.clone(),
            kind: CanonicalStateKind::RecoveryRequired,
        }
    }
}

#[derive(Debug)]
pub(super) enum StateRead {
    Missing,
    Valid(CanonicalState),
    Invalid(String),
}

enum AtomicJsonRead<T> {
    Missing,
    Value(T),
}

#[derive(Debug, Deserialize)]
struct CanonicalStateEnvelope {
    version: u32,
    vault_key: String,
    filesystem_identity: String,
    vault_path: String,
}

#[derive(Debug, Clone)]
pub(super) struct OrphanedDeviceNamespace {
    pub vault_key: String,
    pub previous_vault_path: String,
    pub source: ScopeLayout,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct PendingOperation {
    version: u32,
    pub operation_id: String,
    pub vault_key: String,
    pub from: AIStorageScope,
    pub to: AIStorageScope,
    pub source_vault_key: Option<String>,
}

impl PendingOperation {
    pub(super) fn new(
        layout: &VaultStorageLayout,
        operation_id: String,
        from: AIStorageScope,
        to: AIStorageScope,
        source_vault_key: Option<String>,
    ) -> Self {
        Self {
            version: OPERATION_VERSION,
            operation_id,
            vault_key: layout.vault_key.clone(),
            from,
            to,
            source_vault_key,
        }
    }
}

pub(super) fn resolve_layout(
    app_data_root: &Path,
    vault_root: &Path,
) -> Result<VaultStorageLayout, String> {
    ensure_private_app_data_root(app_data_root)?;
    let canonical_vault = vault_root
        .canonicalize()
        .map_err(|error| format!("Could not resolve vault root: {error}"))?;
    let metadata = fs::symlink_metadata(&canonical_vault).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_dir() {
        return Err("Vault root is not a regular directory.".to_string());
    }

    let normalized = normalized_vault_path(&canonical_vault);
    // The path-derived key intentionally changes when a vault is moved or renamed.
    // Reusing the old device namespace silently would attach local chat data to a
    // different user-visible vault location; recovery makes that adoption explicit.
    let vault_key = hex_sha256(normalized.as_bytes());
    let filesystem_identity = filesystem_identity(&canonical_vault, &metadata, &normalized);
    let namespace = app_data_root
        .join("ai-history")
        .join("v1")
        .join("vaults")
        .join(&vault_key);
    let device_attachment_owner = namespace.clone();
    let vault_attachment_owner = canonical_vault.clone();

    Ok(VaultStorageLayout {
        vault_key,
        filesystem_identity,
        canonical_vault_path: normalized,
        state_file: namespace.join(STATE_FILE),
        operation_file: namespace.join(OPERATION_FILE),
        draft_root: namespace.join("drafts"),
        device: ScopeLayout {
            histories: namespace.join("history"),
            managed: attachments::managed_root(&device_attachment_owner),
            attachment_owner: device_attachment_owner,
        },
        vault: ScopeLayout {
            histories: canonical_vault.join(VAULT_STORAGE_DIR),
            managed: attachments::managed_root(&vault_attachment_owner),
            attachment_owner: vault_attachment_owner,
        },
        namespace,
    })
}

pub(super) fn read_state(layout: &VaultStorageLayout) -> StateRead {
    let state: CanonicalState =
        match read_json_atomically(&layout.namespace, &layout.state_file, "AI history state") {
            Ok(AtomicJsonRead::Missing) => return StateRead::Missing,
            Ok(AtomicJsonRead::Value(state)) => state,
            Err(error) => return StateRead::Invalid(error),
        };
    if state.version != STATE_VERSION {
        return StateRead::Invalid(format!(
            "Unsupported AI history state version: {}.",
            state.version
        ));
    }
    // The key, canonical path, and filesystem identity each catch a different
    // mismatch: namespace reuse, path aliases, and a new directory replacing an
    // old vault at the same path. Accepting only one would make local history
    // adoption ambiguous after filesystem changes.
    if state.vault_key != layout.vault_key {
        return StateRead::Invalid("AI history state belongs to another vault key.".to_string());
    }
    if state.vault_path != layout.canonical_vault_path {
        return StateRead::Invalid("AI history state belongs to another vault path.".to_string());
    }
    if state.filesystem_identity != layout.filesystem_identity {
        return StateRead::Invalid(
            "AI history state belongs to a previous vault at this path.".to_string(),
        );
    }
    StateRead::Valid(state)
}

pub(super) fn write_state(
    layout: &VaultStorageLayout,
    state: &CanonicalState,
) -> Result<(), String> {
    write_json_atomically(&layout.namespace, &layout.state_file, state)
}

pub(super) fn read_operation(
    layout: &VaultStorageLayout,
) -> Result<Option<PendingOperation>, String> {
    let operation: PendingOperation = match read_json_atomically(
        &layout.namespace,
        &layout.operation_file,
        "AI history operation state",
    )? {
        AtomicJsonRead::Missing => return Ok(None),
        AtomicJsonRead::Value(operation) => operation,
    };
    if operation.version != OPERATION_VERSION
        || operation.vault_key != layout.vault_key
        || operation.operation_id.len() != 32
        || !operation
            .operation_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        || (operation.from == operation.to && operation.source_vault_key.is_none())
        || operation
            .source_vault_key
            .as_deref()
            .is_some_and(|key| !is_lower_hex(key, 64) || key == operation.vault_key)
    {
        return Err("Invalid AI history operation state.".to_string());
    }
    Ok(Some(operation))
}

pub(super) fn write_operation(
    layout: &VaultStorageLayout,
    operation: &PendingOperation,
) -> Result<(), String> {
    write_json_atomically(&layout.namespace, &layout.operation_file, operation)
}

pub(super) fn remove_operation(layout: &VaultStorageLayout) -> Result<(), String> {
    match fs::remove_file(&layout.operation_file) {
        Ok(()) => sync_directory(&layout.namespace),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn find_renamed_device_namespace(
    app_data_root: &Path,
    current: &VaultStorageLayout,
) -> Result<Option<OrphanedDeviceNamespace>, String> {
    let vaults_root = app_data_root.join("ai-history/v1/vaults");
    let entries = match fs::read_dir(&vaults_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut candidate = None;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let key = entry
            .file_name()
            .into_string()
            .map_err(|_| "AI history namespace name is not UTF-8.".to_string())?;
        if key == current.vault_key || !is_lower_hex(&key, 64) {
            continue;
        }
        let namespace = entry.path();
        let metadata = fs::symlink_metadata(&namespace).map_err(|error| error.to_string())?;
        if !metadata.file_type().is_dir() {
            return Err("AI history namespace is not a regular directory.".to_string());
        }
        let state_path = namespace.join(STATE_FILE);
        match fs::symlink_metadata(&state_path) {
            Ok(metadata) if metadata.file_type().is_file() => {}
            Ok(_) => return Err("AI history state is not a regular file.".to_string()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        }
        let bytes = match fs::read(&state_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        let envelope: CanonicalStateEnvelope = match serde_json::from_slice(&bytes) {
            Ok(envelope) => envelope,
            Err(_) => continue,
        };
        if envelope.filesystem_identity != current.filesystem_identity {
            continue;
        }
        if envelope.version != STATE_VERSION {
            return Err(format!(
                "Unsupported AI history state version in the previous vault namespace: {}.",
                envelope.version
            ));
        }
        if envelope.vault_key != key {
            return Err("AI history state does not match its namespace key.".to_string());
        }
        let state: CanonicalState = serde_json::from_slice(&bytes).map_err(|error| {
            format!("Invalid AI history state in the previous vault namespace: {error}")
        })?;
        match state.kind {
            CanonicalStateKind::Ready {
                scope: AIStorageScope::Device,
            } => {}
            CanonicalStateKind::Ready {
                scope: AIStorageScope::Vault,
            } => continue,
            CanonicalStateKind::RecoveryRequired => {
                return Err(
                    "The previous vault namespace still requires AI history recovery.".to_string(),
                );
            }
        }
        let attachment_owner = namespace.clone();
        let source = ScopeLayout {
            histories: namespace.join("history"),
            managed: attachments::managed_root(&attachment_owner),
            attachment_owner,
        };
        let renamed = OrphanedDeviceNamespace {
            vault_key: key,
            previous_vault_path: envelope.vault_path,
            source,
        };
        if candidate.replace(renamed).is_some() {
            return Err("Multiple local AI history namespaces match this moved vault.".to_string());
        }
    }
    Ok(candidate)
}

pub(super) fn find_orphaned_device_namespaces(
    app_data_root: &Path,
    current: &VaultStorageLayout,
) -> Result<Vec<OrphanedDeviceNamespace>, String> {
    let vaults_root = app_data_root.join("ai-history/v1/vaults");
    let entries = match fs::read_dir(&vaults_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let canonical_vaults_root = vaults_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut candidates = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let key = entry
            .file_name()
            .into_string()
            .map_err(|_| "AI history namespace name is not UTF-8.".to_string())?;
        if key == current.vault_key || !is_lower_hex(&key, 64) {
            continue;
        }
        let namespace = entry.path();
        let namespace_metadata =
            fs::symlink_metadata(&namespace).map_err(|error| error.to_string())?;
        if !namespace_metadata.file_type().is_dir() {
            return Err("AI history namespace is not a regular directory.".to_string());
        }
        let canonical_namespace = namespace
            .canonicalize()
            .map_err(|error| error.to_string())?;
        if canonical_namespace.parent() != Some(canonical_vaults_root.as_path())
            || canonical_namespace
                .file_name()
                .and_then(|value| value.to_str())
                != Some(&key)
        {
            return Err("AI history namespace escapes app data.".to_string());
        }
        let state_path = namespace.join(STATE_FILE);
        let bytes = match read_optional_regular_file(&state_path)? {
            Some(bytes) => bytes,
            None => continue,
        };
        let envelope: CanonicalStateEnvelope = match serde_json::from_slice(&bytes) {
            Ok(envelope) => envelope,
            Err(_) => continue,
        };
        let previous_path = PathBuf::from(&envelope.vault_path);
        match fs::symlink_metadata(&previous_path) {
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        if envelope.version != STATE_VERSION {
            return Err(format!(
                "Unsupported AI history state version in an orphaned vault namespace: {}.",
                envelope.version
            ));
        }
        if envelope.vault_key != key
            || hex_sha256(normalized_vault_path(&previous_path).as_bytes()) != key
        {
            return Err("Orphaned AI history state does not match its namespace key.".to_string());
        }
        let state: CanonicalState = serde_json::from_slice(&bytes).map_err(|error| {
            format!("Invalid AI history state in an orphaned vault namespace: {error}")
        })?;
        if !matches!(
            state.kind,
            CanonicalStateKind::Ready {
                scope: AIStorageScope::Device
            }
        ) {
            continue;
        }
        let attachment_owner = namespace.clone();
        let source = ScopeLayout {
            histories: namespace.join("history"),
            managed: attachments::managed_root(&attachment_owner),
            attachment_owner,
        };
        if !source.histories.exists() && !source.managed.exists() {
            continue;
        }
        candidates.push(OrphanedDeviceNamespace {
            vault_key: key,
            previous_vault_path: envelope.vault_path,
            source,
        });
    }
    candidates.sort_by(|left, right| left.previous_vault_path.cmp(&right.previous_vault_path));
    Ok(candidates)
}

pub(super) fn device_scope_for_key(
    app_data_root: &Path,
    vault_key: &str,
) -> Result<ScopeLayout, String> {
    if !is_lower_hex(vault_key, 64) {
        return Err("Invalid device-local AI history namespace key.".to_string());
    }
    let namespace = app_data_root
        .join("ai-history")
        .join("v1")
        .join("vaults")
        .join(vault_key);
    Ok(ScopeLayout {
        histories: namespace.join("history"),
        managed: attachments::managed_root(&namespace),
        attachment_owner: namespace,
    })
}

pub(super) fn remove_device_namespace_for_known_path(
    app_data_root: &Path,
    vault_path: &Path,
) -> Result<String, String> {
    ensure_private_app_data_root(app_data_root)?;
    let known_path = match vault_path.canonicalize() {
        Ok(canonical) => canonical,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => vault_path.to_path_buf(),
        Err(error) => return Err(error.to_string()),
    };
    if !known_path.is_absolute()
        || known_path.components().any(|component| {
            matches!(
                component,
                std::path::Component::CurDir | std::path::Component::ParentDir
            )
        })
    {
        return Err("The stored vault path is not an absolute normalized path.".to_string());
    }
    let vault_key = hex_sha256(normalized_vault_path(&known_path).as_bytes());
    let namespace = app_data_root
        .join("ai-history")
        .join("v1")
        .join("vaults")
        .join(&vault_key);
    remove_device_namespace_by_key(&namespace, &vault_key)?;
    Ok(vault_key)
}

fn remove_device_namespace_by_key(namespace: &Path, vault_key: &str) -> Result<(), String> {
    match fs::symlink_metadata(namespace) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return Err("AI history device namespace is not a regular directory.".to_string()),
    }
    let canonical_root = namespace
        .parent()
        .ok_or_else(|| "AI history namespace has no parent.".to_string())?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical_namespace = namespace
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if canonical_namespace.parent() != Some(canonical_root.as_path())
        || canonical_namespace
            .file_name()
            .and_then(|value| value.to_str())
            != Some(vault_key)
    {
        return Err("AI history device namespace escapes app data.".to_string());
    }
    fs::remove_dir_all(&canonical_namespace).map_err(|error| error.to_string())?;
    sync_directory(&canonical_root)
}

fn write_json_atomically<T: Serialize>(
    namespace: &Path,
    destination: &Path,
    value: &T,
) -> Result<(), String> {
    ensure_private_namespace(namespace)?;
    let temporary = destination.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    // Never overwrite a leftover temporary file. It may be evidence of an
    // interrupted write or another process; only the same logical state can
    // safely be completed here.
    if let Some(temporary_bytes) = read_optional_regular_file(&temporary)? {
        let expected: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        let pending: serde_json::Value = serde_json::from_slice(&temporary_bytes)
            .map_err(|error| format!("Invalid temporary AI history state: {error}"))?;
        if pending != expected {
            return Err(format!(
                "A different temporary AI history state file already exists: {}.",
                temporary.display()
            ));
        }
        replace_file(&temporary, destination)?;
        return sync_directory(namespace);
    }
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    replace_file(&temporary, destination)?;
    sync_directory(namespace)
}

fn read_json_atomically<T: for<'de> Deserialize<'de>>(
    namespace: &Path,
    destination: &Path,
    label: &str,
) -> Result<AtomicJsonRead<T>, String> {
    let temporary = destination.with_extension("json.tmp");
    let destination_bytes = read_optional_regular_file(destination)?;
    let temporary_bytes = read_optional_regular_file(&temporary)?;
    match (destination_bytes, temporary_bytes) {
        (None, None) => Ok(AtomicJsonRead::Missing),
        (Some(bytes), None) => serde_json::from_slice(&bytes)
            .map(AtomicJsonRead::Value)
            .map_err(|error| format!("Invalid {label}: {error}")),
        (None, Some(bytes)) => {
            let value = serde_json::from_slice(&bytes)
                .map_err(|error| format!("Invalid temporary {label}: {error}"))?;
            replace_file(&temporary, destination)?;
            sync_directory(namespace)?;
            Ok(AtomicJsonRead::Value(value))
        }
        (Some(destination_bytes), Some(temporary_bytes)) => {
            if destination_bytes != temporary_bytes {
                return Err(format!("Multiple different {label} files exist."));
            }
            let value = serde_json::from_slice(&destination_bytes)
                .map_err(|error| format!("Invalid {label}: {error}"))?;
            fs::remove_file(&temporary).map_err(|error| error.to_string())?;
            sync_directory(namespace)?;
            Ok(AtomicJsonRead::Value(value))
        }
    }
}

fn read_optional_regular_file(path: &Path) -> Result<Option<Vec<u8>>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            fs::read(path).map(Some).map_err(|error| error.to_string())
        }
        Ok(_) => Err(format!("{} is not a regular file.", path.display())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(|error| error.to_string())
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

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
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if succeeded == 0 {
        Err(std::io::Error::last_os_error().to_string())
    } else {
        Ok(())
    }
}

fn ensure_private_app_data_root(root: &Path) -> Result<(), String> {
    create_private_dir_all(root)
}

fn ensure_private_namespace(namespace: &Path) -> Result<(), String> {
    let vaults_root = namespace
        .parent()
        .ok_or_else(|| "AI history namespace has no vaults root.".to_string())?;
    let version_root = vaults_root
        .parent()
        .ok_or_else(|| "AI history namespace has no version root.".to_string())?;
    let history_root = version_root
        .parent()
        .ok_or_else(|| "AI history namespace has no history root.".to_string())?;
    let app_data_root = history_root
        .parent()
        .ok_or_else(|| "AI history namespace has no app data root.".to_string())?;

    ensure_private_app_data_root(app_data_root)?;
    for directory in [history_root, version_root, vaults_root, namespace] {
        match fs::create_dir(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        let metadata = fs::symlink_metadata(directory).map_err(|error| error.to_string())?;
        if !metadata.file_type().is_dir() {
            return Err(format!(
                "AI history storage component is not a regular directory: {}",
                directory.display()
            ));
        }
        harden_private_directory(directory)?;
    }

    let canonical_root = app_data_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let canonical_namespace = namespace
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !canonical_namespace.starts_with(&canonical_root) {
        return Err("AI history namespace escapes app data.".to_string());
    }
    Ok(())
}

fn create_private_dir_all(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_dir() {
        return Err("AI history app-data root is not a regular directory.".to_string());
    }
    harden_private_directory(path)
}

fn harden_private_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn normalized_vault_path(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    #[cfg(windows)]
    {
        normalized.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        normalized
    }
}

fn filesystem_identity(path: &Path, metadata: &fs::Metadata, _normalized_path: &str) -> String {
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!("unix:{}:{}", metadata.dev(), metadata.ino())
    };
    #[cfg(windows)]
    let identity = {
        let _ = metadata;
        windows_file_identity(path).unwrap_or_else(|| format!("path:{_normalized_path}"))
    };
    #[cfg(not(any(unix, windows)))]
    let identity = {
        let _ = (path, metadata);
        format!("path:{_normalized_path}")
    };
    let _ = path;
    hex_sha256(identity.as_bytes())
}

#[cfg(windows)]
fn windows_file_identity(path: &Path) -> Option<String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let directory = File::open(path).ok()?;
    let mut information = std::mem::MaybeUninit::<BY_HANDLE_FILE_INFORMATION>::zeroed();
    let succeeded =
        unsafe { GetFileInformationByHandle(directory.as_raw_handle(), information.as_mut_ptr()) };
    if succeeded == 0 {
        return None;
    }
    let information = unsafe { information.assume_init() };
    let index =
        (u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
    Some(format!(
        "windows:{}:{index}",
        information.dwVolumeSerialNumber
    ))
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn is_lower_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), String> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> Result<(), String> {
    // replace_file already uses MOVEFILE_WRITE_THROUGH on Windows. Directory
    // handles cannot be portably flushed with File::sync_all.
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn sync_directory(_path: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derives_separate_device_and_vault_layouts_without_exposing_the_path() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let layout = resolve_layout(app_data.path(), vault.path()).unwrap();

        assert!(layout
            .namespace
            .starts_with(app_data.path().join("ai-history/v1/vaults")));
        assert_eq!(
            layout.vault.histories,
            vault.path().canonicalize().unwrap().join(".neverwrite")
        );
        assert_eq!(layout.device.histories, layout.namespace.join("history"));
        assert_eq!(layout.draft_root, layout.namespace.join("drafts"));
        assert!(!layout
            .namespace
            .to_string_lossy()
            .contains(&vault.path().to_string_lossy().to_string()));
    }

    #[test]
    fn state_round_trips_and_future_versions_fail_closed() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let layout = resolve_layout(app_data.path(), vault.path()).unwrap();
        let state = CanonicalState::ready(&layout, AIStorageScope::Device);
        write_state(&layout, &state).unwrap();
        assert!(matches!(
            read_state(&layout),
            StateRead::Valid(CanonicalState {
                kind: CanonicalStateKind::Ready {
                    scope: AIStorageScope::Device
                },
                ..
            })
        ));

        let mut value = serde_json::to_value(state).unwrap();
        value["version"] = serde_json::json!(2);
        fs::write(&layout.state_file, serde_json::to_vec(&value).unwrap()).unwrap();
        assert!(matches!(read_state(&layout), StateRead::Invalid(_)));
    }

    #[test]
    fn state_promotes_a_complete_temporary_file_after_an_interrupted_write() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let layout = resolve_layout(app_data.path(), vault.path()).unwrap();
        let state = CanonicalState::ready(&layout, AIStorageScope::Vault);
        create_private_dir_all(&layout.namespace).unwrap();
        let temporary = layout.state_file.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(&state).unwrap()).unwrap();

        assert!(matches!(
            read_state(&layout),
            StateRead::Valid(CanonicalState {
                kind: CanonicalStateKind::Ready {
                    scope: AIStorageScope::Vault
                },
                ..
            })
        ));
        assert!(layout.state_file.is_file());
        assert!(!temporary.exists());
    }

    #[test]
    fn state_fails_closed_when_committed_and_temporary_files_disagree() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let layout = resolve_layout(app_data.path(), vault.path()).unwrap();
        write_state(
            &layout,
            &CanonicalState::ready(&layout, AIStorageScope::Device),
        )
        .unwrap();
        let temporary = layout.state_file.with_extension("json.tmp");
        fs::write(
            &temporary,
            serde_json::to_vec_pretty(&CanonicalState::ready(&layout, AIStorageScope::Vault))
                .unwrap(),
        )
        .unwrap();

        assert!(matches!(read_state(&layout), StateRead::Invalid(_)));
        assert!(layout.state_file.is_file());
        assert!(temporary.is_file());
    }

    #[cfg(unix)]
    #[test]
    fn state_write_rejects_a_symlinked_storage_ancestor() {
        use std::os::unix::fs::symlink;

        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        symlink(external.path(), app_data.path().join("ai-history")).unwrap();
        let layout = resolve_layout(app_data.path(), vault.path()).unwrap();

        let error = write_state(
            &layout,
            &CanonicalState::ready(&layout, AIStorageScope::Device),
        )
        .unwrap_err();

        assert!(error.contains("not a regular directory"));
    }

    #[test]
    fn local_namespace_can_be_forgotten_after_the_vault_path_disappears() {
        let app_data = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let vault = parent.path().join("vault");
        fs::create_dir(&vault).unwrap();
        let layout = resolve_layout(app_data.path(), &vault).unwrap();
        write_state(
            &layout,
            &CanonicalState::ready(&layout, AIStorageScope::Device),
        )
        .unwrap();
        fs::create_dir_all(layout.device.histories.join("sessions")).unwrap();
        let known_path = vault.canonicalize().unwrap();
        fs::remove_dir_all(&vault).unwrap();

        let removed_key =
            remove_device_namespace_for_known_path(app_data.path(), &known_path).unwrap();

        assert_eq!(removed_key, layout.vault_key);
        assert!(!layout.namespace.exists());
    }

    #[cfg(unix)]
    #[test]
    fn local_namespace_forget_resolves_an_existing_symlink_path() {
        use std::os::unix::fs::symlink;

        let app_data = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let vault = parent.path().join("vault");
        let alias = parent.path().join("alias");
        fs::create_dir(&vault).unwrap();
        symlink(&vault, &alias).unwrap();
        let layout = resolve_layout(app_data.path(), &alias).unwrap();
        write_state(
            &layout,
            &CanonicalState::ready(&layout, AIStorageScope::Device),
        )
        .unwrap();

        let removed_key = remove_device_namespace_for_known_path(app_data.path(), &alias).unwrap();

        assert_eq!(removed_key, layout.vault_key);
        assert!(!layout.namespace.exists());
    }

    #[test]
    fn rename_candidate_uses_filesystem_identity_without_merging_copies() {
        let app_data = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let original = parent.path().join("original");
        fs::create_dir(&original).unwrap();
        let old_layout = resolve_layout(app_data.path(), &original).unwrap();
        write_state(
            &old_layout,
            &CanonicalState::ready(&old_layout, AIStorageScope::Device),
        )
        .unwrap();
        fs::create_dir_all(old_layout.device.histories.join("sessions")).unwrap();

        let renamed = parent.path().join("renamed");
        fs::rename(&original, &renamed).unwrap();
        let new_layout = resolve_layout(app_data.path(), &renamed).unwrap();
        assert!(find_renamed_device_namespace(app_data.path(), &new_layout)
            .unwrap()
            .is_some());

        let copied = parent.path().join("copied");
        fs::create_dir(&copied).unwrap();
        let copied_layout = resolve_layout(app_data.path(), &copied).unwrap();
        assert!(
            find_renamed_device_namespace(app_data.path(), &copied_layout)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn renamed_vault_fails_closed_for_a_future_previous_state() {
        let app_data = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let original = parent.path().join("original");
        fs::create_dir(&original).unwrap();
        let old_layout = resolve_layout(app_data.path(), &original).unwrap();
        let state = CanonicalState::ready(&old_layout, AIStorageScope::Device);
        write_state(&old_layout, &state).unwrap();
        let mut value = serde_json::to_value(state).unwrap();
        value["version"] = serde_json::json!(2);
        fs::write(&old_layout.state_file, serde_json::to_vec(&value).unwrap()).unwrap();
        fs::create_dir_all(old_layout.device.histories.join("sessions")).unwrap();

        let renamed = parent.path().join("renamed");
        fs::rename(&original, &renamed).unwrap();
        let new_layout = resolve_layout(app_data.path(), &renamed).unwrap();

        let error = find_renamed_device_namespace(app_data.path(), &new_layout).unwrap_err();
        assert!(error.contains("Unsupported AI history state version"));
    }

    #[cfg(unix)]
    #[test]
    fn orphaned_namespace_scan_rejects_a_symlink() {
        use std::os::unix::fs::symlink;

        let app_data = tempfile::tempdir().unwrap();
        let old_vault = tempfile::tempdir().unwrap();
        let current_vault = tempfile::tempdir().unwrap();
        let old_layout = resolve_layout(app_data.path(), old_vault.path()).unwrap();
        let current_layout = resolve_layout(app_data.path(), current_vault.path()).unwrap();
        let external = tempfile::tempdir().unwrap();
        fs::create_dir_all(old_layout.namespace.parent().unwrap()).unwrap();
        symlink(external.path(), &old_layout.namespace).unwrap();

        let error = find_orphaned_device_namespaces(app_data.path(), &current_layout).unwrap_err();

        assert!(error.contains("not a regular directory"));
    }
}
