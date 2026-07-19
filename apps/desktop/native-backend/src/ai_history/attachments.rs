use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MANAGED_ROOT_COMPONENTS: &[&str] = &["assets", "chat", ".neverwrite-managed", "v1", "blobs"];
const BLOB_FILE: &str = "blob";
const METADATA_FILE: &str = "metadata.json";
const PROMOTION_FILE: &str = "promotion.json";
const COMMITTED_FILE: &str = "committed";
const FORMAT_VERSION: u32 = 1;
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const ID_PREFIX: &str = "ma_";
const DRAFT_ID_PREFIX: &str = "da_";
const MANAGED_STAGING_PREFIX: &str = ".tmp-ma-";
const DRAFT_STAGING_PREFIX: &str = ".tmp-da-";
const ID_HEX_LENGTH: usize = 32;
pub(crate) const DRAFT_TTL_MS: u64 = 7 * 24 * 60 * 60 * 1000;
pub(crate) const PROMOTED_GRACE_PERIOD_MS: u64 = 7 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnreferencedDeletion {
    Deleted(bool),
    Protected,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct ManagedAttachmentId(String);

impl ManagedAttachmentId {
    fn new() -> Self {
        Self(format!("{ID_PREFIX}{}", uuid::Uuid::new_v4().simple()))
    }

    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        let hex = value
            .strip_prefix(ID_PREFIX)
            .ok_or_else(|| "Invalid managed attachment ID.".to_string())?;
        if hex.len() != ID_HEX_LENGTH
            || !hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Invalid managed attachment ID.".to_string());
        }
        Ok(Self(value.to_string()))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct DraftAttachmentId(String);

impl DraftAttachmentId {
    fn new() -> Self {
        Self(format!(
            "{DRAFT_ID_PREFIX}{}",
            uuid::Uuid::new_v4().simple()
        ))
    }

    pub(crate) fn parse(value: &str) -> Result<Self, String> {
        parse_attachment_id(value, DRAFT_ID_PREFIX, "draft attachment").map(Self)
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

fn parse_attachment_id(value: &str, prefix: &str, kind: &str) -> Result<String, String> {
    let hex = value
        .strip_prefix(prefix)
        .ok_or_else(|| format!("Invalid {kind} ID."))?;
    if hex.len() != ID_HEX_LENGTH
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(format!("Invalid {kind} ID."));
    }
    Ok(value.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ManagedAttachmentMetadata {
    version: u32,
    pub(crate) attachment_id: ManagedAttachmentId,
    pub(crate) file_name: String,
    pub(crate) mime_type: String,
    size_bytes: u64,
    sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    promoted_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct DraftAttachmentMetadata {
    version: u32,
    pub(crate) draft_id: DraftAttachmentId,
    pub(crate) file_name: String,
    pub(crate) mime_type: String,
    size_bytes: u64,
    sha256: String,
    created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DraftPromotionMetadata {
    version: u32,
    draft_id: DraftAttachmentId,
    attachment_id: ManagedAttachmentId,
}

#[derive(Debug)]
pub(crate) struct ResolvedManagedAttachment {
    pub(crate) path: PathBuf,
    pub(crate) metadata: ManagedAttachmentMetadata,
}

pub(crate) fn create(
    vault_root: &Path,
    file_name: &str,
    declared_mime_type: &str,
    bytes: &[u8],
) -> Result<ManagedAttachmentMetadata, String> {
    create_managed(vault_root, file_name, declared_mime_type, bytes, false)
}

fn create_managed(
    vault_root: &Path,
    file_name: &str,
    declared_mime_type: &str,
    bytes: &[u8],
    promoted: bool,
) -> Result<ManagedAttachmentMetadata, String> {
    validate_file_name(file_name)?;
    if bytes.is_empty() {
        return Err("Managed attachment is empty.".to_string());
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "Managed attachment exceeds the {MAX_ATTACHMENT_BYTES} byte limit."
        ));
    }
    let detected_mime_type = detect_image_mime(bytes)
        .ok_or_else(|| "Managed attachment is not a supported image.".to_string())?;
    if declared_mime_type != detected_mime_type {
        return Err(format!(
            "Managed attachment MIME mismatch: declared {declared_mime_type}, detected {detected_mime_type}."
        ));
    }

    let root = ensure_managed_root(vault_root)?;
    let attachment_id = ManagedAttachmentId::new();
    let final_dir = root.join(attachment_id.as_str());
    let staging_dir = root.join(staging_dir_name(MANAGED_STAGING_PREFIX));
    create_private_dir(&staging_dir)?;

    let result = (|| {
        write_new_file(&staging_dir.join(BLOB_FILE), bytes)?;
        let metadata = ManagedAttachmentMetadata {
            version: FORMAT_VERSION,
            attachment_id,
            file_name: file_name.to_string(),
            mime_type: detected_mime_type.to_string(),
            size_bytes: bytes.len() as u64,
            sha256: sha256_hex(bytes),
            promoted_at_ms: promoted.then(now_ms),
        };
        let metadata_bytes = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
        write_new_file(&staging_dir.join(METADATA_FILE), &metadata_bytes)?;
        sync_directory(&staging_dir)?;
        rename_path(&staging_dir, &final_dir)?;
        sync_directory(&root)?;
        Ok(metadata)
    })();

    if result.is_err() {
        fs::remove_dir_all(&staging_dir).ok();
    }
    result
}

pub(crate) fn create_draft(
    app_data_root: &Path,
    draft_root: &Path,
    file_name: &str,
    declared_mime_type: &str,
    bytes: &[u8],
) -> Result<DraftAttachmentMetadata, String> {
    validate_attachment_input(file_name, declared_mime_type, bytes, "Draft attachment")?;
    let detected_mime_type = detect_image_mime(bytes).expect("validated image MIME");
    let root = ensure_local_root(app_data_root, draft_root)?;
    let draft_id = DraftAttachmentId::new();
    let final_dir = root.join(draft_id.as_str());
    let staging_dir = root.join(staging_dir_name(DRAFT_STAGING_PREFIX));
    create_private_dir(&staging_dir)?;

    let result = (|| {
        write_new_file(&staging_dir.join(BLOB_FILE), bytes)?;
        let metadata = DraftAttachmentMetadata {
            version: FORMAT_VERSION,
            draft_id,
            file_name: file_name.to_string(),
            mime_type: detected_mime_type.to_string(),
            size_bytes: bytes.len() as u64,
            sha256: sha256_hex(bytes),
            created_at_ms: now_ms(),
        };
        let metadata_bytes = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
        write_new_file(&staging_dir.join(METADATA_FILE), &metadata_bytes)?;
        sync_directory(&staging_dir)?;
        rename_path(&staging_dir, &final_dir)?;
        sync_directory(&root)?;
        Ok(metadata)
    })();

    if result.is_err() {
        fs::remove_dir_all(&staging_dir).ok();
    }
    result
}

pub(crate) fn promote_draft(
    app_data_root: &Path,
    draft_root: &Path,
    vault_root: &Path,
    draft_id: &DraftAttachmentId,
) -> Result<ManagedAttachmentMetadata, String> {
    let (draft, bytes) = read_draft(app_data_root, draft_root, draft_id)?;
    let draft_dir = existing_local_item_dir(app_data_root, draft_root, draft_id.as_str())?;
    // A promotion marker makes retries idempotent: reuse and verify the same
    // managed blob rather than creating a new ID that the pending transcript
    // would not reference.
    if let Some(promotion) = read_draft_promotion(&draft_dir, draft_id)? {
        let (managed, managed_bytes) = read(vault_root, &promotion.attachment_id)?;
        if managed.file_name != draft.file_name
            || managed.mime_type != draft.mime_type
            || managed_bytes != bytes
        {
            return Err("Draft promotion does not match its managed blob.".to_string());
        }
        return Ok(managed);
    }

    let managed = create_managed(vault_root, &draft.file_name, &draft.mime_type, &bytes, true)?;
    let promotion = DraftPromotionMetadata {
        version: FORMAT_VERSION,
        draft_id: draft_id.clone(),
        attachment_id: managed.attachment_id.clone(),
    };
    let bytes = serde_json::to_vec(&promotion).map_err(|error| error.to_string())?;
    write_new_file(&draft_dir.join(PROMOTION_FILE), &bytes)?;
    sync_directory(&draft_dir)?;
    Ok(managed)
}

pub(crate) fn delete_draft(
    app_data_root: &Path,
    draft_root: &Path,
    draft_id: &DraftAttachmentId,
) -> Result<bool, String> {
    let candidate = draft_root.join(draft_id.as_str());
    match fs::symlink_metadata(&candidate) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    }
    let draft_dir = existing_local_item_dir(app_data_root, draft_root, draft_id.as_str())?;
    read_draft(app_data_root, draft_root, draft_id)?;
    fs::remove_dir_all(&draft_dir).map_err(|error| error.to_string())?;
    sync_directory(draft_root)?;
    Ok(true)
}

pub(crate) fn mark_committed(
    vault_root: &Path,
    attachment_id: &ManagedAttachmentId,
) -> Result<(), String> {
    read(vault_root, attachment_id)?;
    #[cfg(unix)]
    {
        mark_committed_from_directory_handles(vault_root, attachment_id)
    }
    #[cfg(not(unix))]
    {
        mark_committed_from_capability_handles(vault_root, attachment_id)
    }
}

#[cfg(unix)]
fn mark_committed_from_directory_handles(
    vault_root: &Path,
    attachment_id: &ManagedAttachmentId,
) -> Result<(), String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::OpenOptionsExt;

    fn open_directory_at(parent: &File, name: &str) -> Result<File, String> {
        let name = CString::new(name).map_err(|_| "Invalid managed path component.".to_string())?;
        let fd = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY,
            )
        };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    let canonical_vault = vault_root
        .canonicalize()
        .map_err(|error| format!("Could not resolve vault root: {error}"))?;
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&canonical_vault)
        .map_err(|error| error.to_string())?;
    for component in MANAGED_ROOT_COMPONENTS
        .iter()
        .copied()
        .chain(std::iter::once(attachment_id.as_str()))
    {
        directory = open_directory_at(&directory, component)?;
    }

    let name = CString::new(COMMITTED_FILE).expect("static marker name is valid");
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
    };
    if fd < 0 {
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            return Ok(());
        }
        return Err(error.to_string());
    }
    let mut marker = unsafe { File::from_raw_fd(fd) };
    marker
        .write_all(now_ms().to_string().as_bytes())
        .map_err(|error| error.to_string())?;
    marker.sync_all().map_err(|error| error.to_string())?;
    directory.sync_all().map_err(|error| error.to_string())
}

#[cfg(not(unix))]
fn sync_cap_directory(directory: cap_std::fs::Dir) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Windows does not provide a portable directory fsync. The marker is
        // flushed before publication, and renames use MOVEFILE_WRITE_THROUGH.
        let _ = directory;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        directory
            .into_std_file()
            .sync_all()
            .map_err(|error| error.to_string())
    }
}

#[cfg(not(unix))]
fn mark_committed_from_capability_handles(
    vault_root: &Path,
    attachment_id: &ManagedAttachmentId,
) -> Result<(), String> {
    use cap_std::ambient_authority;
    use cap_std::fs::{Dir, OpenOptions as CapOpenOptions};

    let mut directory = Dir::open_ambient_dir(vault_root, ambient_authority())
        .map_err(|error| error.to_string())?;
    for component in MANAGED_ROOT_COMPONENTS
        .iter()
        .copied()
        .chain(std::iter::once(attachment_id.as_str()))
    {
        directory = directory
            .open_dir(component)
            .map_err(|error| error.to_string())?;
    }
    let mut options = CapOpenOptions::new();
    options.write(true).create_new(true);
    let mut marker = match directory.open_with(COMMITTED_FILE, &options) {
        Ok(marker) => marker,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    marker
        .write_all(now_ms().to_string().as_bytes())
        .map_err(|error| error.to_string())?;
    marker.sync_all().map_err(|error| error.to_string())?;
    sync_cap_directory(directory)
}

pub(crate) fn cleanup_expired_drafts(app_data_root: &Path, draft_root: &Path, now: u64) {
    let Ok(root) = existing_local_root(app_data_root, draft_root) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Some(created_at_ms) = parse_staging_created_at(&name, DRAFT_STAGING_PREFIX) {
            if now.saturating_sub(created_at_ms) >= DRAFT_TTL_MS {
                delete_staging_dir(&root, &entry.path()).ok();
            }
            continue;
        }
        let Ok(draft_id) = DraftAttachmentId::parse(&name) else {
            continue;
        };
        let Ok((metadata, _)) = read_draft_metadata(app_data_root, draft_root, &draft_id) else {
            continue;
        };
        if now.saturating_sub(metadata.created_at_ms) >= DRAFT_TTL_MS {
            delete_draft(app_data_root, draft_root, &draft_id).ok();
        }
    }
}

pub(crate) fn cleanup_expired_drafts_globally(app_data_root: &Path, now: u64) {
    let vaults_root = app_data_root.join("ai-history/v1/vaults");
    let Ok(vaults_root) = existing_local_root(app_data_root, &vaults_root) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&vaults_root) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(vault_key) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_lower_hex(&vault_key, 64) {
            continue;
        }
        let vault_namespace = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&vault_namespace) else {
            continue;
        };
        if !metadata.file_type().is_dir() {
            continue;
        }
        let Ok(canonical_namespace) = vault_namespace.canonicalize() else {
            continue;
        };
        if canonical_namespace.parent() != Some(vaults_root.as_path()) {
            continue;
        }
        let draft_root = vault_namespace.join("drafts");
        cleanup_expired_drafts(app_data_root, &draft_root, now);
    }
}

pub(crate) fn cleanup_expired_managed_staging(vault_root: &Path, now: u64) {
    let Ok(root) = existing_managed_root(vault_root) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(created_at_ms) = parse_staging_created_at(&name, MANAGED_STAGING_PREFIX) else {
            continue;
        };
        if now.saturating_sub(created_at_ms) >= PROMOTED_GRACE_PERIOD_MS {
            delete_staging_dir(&root, &entry.path()).ok();
        }
    }
}

pub(crate) fn cleanup_expired_promotions(
    vault_root: &Path,
    referenced_ids: &std::collections::BTreeSet<String>,
    now: u64,
) {
    let Ok(root) = existing_managed_root(vault_root) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Ok(attachment_id) = ManagedAttachmentId::parse(&name) else {
            continue;
        };
        if referenced_ids.contains(attachment_id.as_str()) {
            continue;
        }
        delete_expired_uncommitted_promotion(vault_root, &attachment_id, now).ok();
    }
}

pub(crate) fn delete_if_unreferenced(
    vault_root: &Path,
    attachment_id: &ManagedAttachmentId,
    now: u64,
) -> Result<UnreferencedDeletion, String> {
    let (metadata, _) = read(vault_root, attachment_id)?;
    // This is not normal retention. The grace period covers the interval
    // between draft promotion and durable transcript persistence or a retry.
    if let Some(promoted_at_ms) = metadata.promoted_at_ms {
        let marker = committed_marker_state(vault_root, attachment_id)?;
        if !marker && now.saturating_sub(promoted_at_ms) < PROMOTED_GRACE_PERIOD_MS {
            return Ok(UnreferencedDeletion::Protected);
        }
    }
    delete_validated(vault_root, attachment_id).map(UnreferencedDeletion::Deleted)
}

fn delete_expired_uncommitted_promotion(
    vault_root: &Path,
    attachment_id: &ManagedAttachmentId,
    now: u64,
) -> Result<UnreferencedDeletion, String> {
    let (metadata, _) = read(vault_root, attachment_id)?;
    let Some(promoted_at_ms) = metadata.promoted_at_ms else {
        return Ok(UnreferencedDeletion::Protected);
    };
    if committed_marker_state(vault_root, attachment_id)?
        || now.saturating_sub(promoted_at_ms) < PROMOTED_GRACE_PERIOD_MS
    {
        return Ok(UnreferencedDeletion::Protected);
    }
    delete_validated(vault_root, attachment_id).map(UnreferencedDeletion::Deleted)
}

fn committed_marker_state(
    vault_root: &Path,
    attachment_id: &ManagedAttachmentId,
) -> Result<bool, String> {
    let marker = managed_root(vault_root)
        .join(attachment_id.as_str())
        .join(COMMITTED_FILE);
    match fs::symlink_metadata(marker) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(true),
        Ok(_) => Err("Managed attachment committed marker is not a regular file.".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

pub(crate) fn resolve(
    vault_root: &Path,
    attachment_id: &ManagedAttachmentId,
) -> Result<ResolvedManagedAttachment, String> {
    let root = existing_managed_root(vault_root)?;
    let attachment_dir = root.join(attachment_id.as_str());
    require_regular_directory(&attachment_dir)?;
    let metadata_path = attachment_dir.join(METADATA_FILE);
    let blob_path = attachment_dir.join(BLOB_FILE);
    require_regular_file(&metadata_path)?;
    require_regular_file(&blob_path)?;

    let root = root.canonicalize().map_err(|error| error.to_string())?;
    let attachment_dir = attachment_dir
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let blob_path = blob_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let metadata_path = metadata_path
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if attachment_dir.parent() != Some(root.as_path())
        || !blob_path.starts_with(&attachment_dir)
        || !metadata_path.starts_with(&attachment_dir)
    {
        return Err("Managed attachment escapes its storage root.".to_string());
    }

    let metadata_size = fs::metadata(&metadata_path)
        .map_err(|error| error.to_string())?
        .len();
    if metadata_size > MAX_METADATA_BYTES {
        return Err("Managed attachment metadata is too large.".to_string());
    }
    let metadata: ManagedAttachmentMetadata =
        serde_json::from_reader(File::open(&metadata_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Invalid managed attachment metadata: {error}"))?;
    if metadata.version != FORMAT_VERSION || metadata.attachment_id != *attachment_id {
        return Err("Managed attachment metadata does not match its ID.".to_string());
    }
    validate_file_name(&metadata.file_name)?;

    let (size_bytes, sha256, detected_mime_type) = inspect_blob(&blob_path)?;
    if size_bytes != metadata.size_bytes
        || sha256 != metadata.sha256
        || detected_mime_type != metadata.mime_type
    {
        return Err("Managed attachment blob does not match its metadata.".to_string());
    }

    Ok(ResolvedManagedAttachment {
        path: blob_path,
        metadata,
    })
}

pub(crate) fn read(
    vault_root: &Path,
    attachment_id: &ManagedAttachmentId,
) -> Result<(ManagedAttachmentMetadata, Vec<u8>), String> {
    #[cfg(unix)]
    {
        read_from_directory_handles(vault_root, attachment_id)
    }
    #[cfg(not(unix))]
    {
        read_from_capability_handles(vault_root, attachment_id)
    }
}

#[cfg(not(unix))]
fn read_from_capability_handles(
    vault_root: &Path,
    attachment_id: &ManagedAttachmentId,
) -> Result<(ManagedAttachmentMetadata, Vec<u8>), String> {
    use cap_std::ambient_authority;
    use cap_std::fs::Dir;

    let mut directory = Dir::open_ambient_dir(vault_root, ambient_authority())
        .map_err(|error| error.to_string())?;
    for component in MANAGED_ROOT_COMPONENTS
        .iter()
        .copied()
        .chain(std::iter::once(attachment_id.as_str()))
    {
        directory = directory
            .open_dir(component)
            .map_err(|error| error.to_string())?;
    }
    let mut metadata_file = directory
        .open(METADATA_FILE)
        .map_err(|error| error.to_string())?;
    if !metadata_file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Managed attachment metadata is not a regular file.".to_string());
    }
    let mut metadata_bytes = Vec::new();
    metadata_file
        .take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut metadata_bytes)
        .map_err(|error| error.to_string())?;
    let metadata = parse_metadata_bytes(&metadata_bytes, attachment_id)?;
    let mut blob_file = directory
        .open(BLOB_FILE)
        .map_err(|error| error.to_string())?;
    if !blob_file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Managed attachment blob is not a regular file.".to_string());
    }
    read_verified_blob(&mut blob_file, metadata)
}

#[cfg(unix)]
fn read_from_directory_handles(
    vault_root: &Path,
    attachment_id: &ManagedAttachmentId,
) -> Result<(ManagedAttachmentMetadata, Vec<u8>), String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::OpenOptionsExt;

    fn open_at(parent: &File, name: &str, directory: bool) -> Result<File, String> {
        let name = CString::new(name).map_err(|_| "Invalid managed path component.".to_string())?;
        let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
        if directory {
            flags |= libc::O_DIRECTORY;
        } else {
            flags |= libc::O_NONBLOCK;
        }
        // Every managed component is opened relative to an already verified directory handle.
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(unsafe { File::from_raw_fd(fd) })
    }

    let canonical_vault = vault_root
        .canonicalize()
        .map_err(|error| format!("Could not resolve vault root: {error}"))?;
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
        .open(&canonical_vault)
        .map_err(|error| error.to_string())?;
    for component in MANAGED_ROOT_COMPONENTS
        .iter()
        .copied()
        .chain(std::iter::once(attachment_id.as_str()))
    {
        directory = open_at(&directory, component, true)?;
    }

    let mut metadata_file = open_at(&directory, METADATA_FILE, false)?;
    if !metadata_file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Managed attachment metadata is not a regular file.".to_string());
    }
    let mut metadata_bytes = Vec::new();
    Read::by_ref(&mut metadata_file)
        .take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut metadata_bytes)
        .map_err(|error| error.to_string())?;
    if metadata_bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err("Managed attachment metadata is too large.".to_string());
    }
    let metadata = parse_metadata_bytes(&metadata_bytes, attachment_id)?;

    let mut blob_file = open_at(&directory, BLOB_FILE, false)?;
    if !blob_file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Managed attachment blob is not a regular file.".to_string());
    }
    read_verified_blob(&mut blob_file, metadata)
}

fn parse_metadata_bytes(
    bytes: &[u8],
    attachment_id: &ManagedAttachmentId,
) -> Result<ManagedAttachmentMetadata, String> {
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err("Managed attachment metadata is too large.".to_string());
    }
    let metadata: ManagedAttachmentMetadata = serde_json::from_slice(bytes)
        .map_err(|error| format!("Invalid managed attachment metadata: {error}"))?;
    if metadata.version != FORMAT_VERSION || metadata.attachment_id != *attachment_id {
        return Err("Managed attachment metadata does not match its ID.".to_string());
    }
    if metadata.size_bytes > MAX_ATTACHMENT_BYTES as u64 {
        return Err("Managed attachment blob exceeds the size limit.".to_string());
    }
    validate_file_name(&metadata.file_name)?;
    Ok(metadata)
}

pub(super) fn validate_migration_attachment(
    metadata_bytes: &[u8],
    attachment_id: &ManagedAttachmentId,
    blob: &[u8],
) -> Result<(String, String), String> {
    let metadata = parse_metadata_bytes(metadata_bytes, attachment_id)?;
    let mut blob_reader = blob;
    let (metadata, _) = read_verified_blob(&mut blob_reader, metadata)?;
    Ok((metadata.file_name, metadata.mime_type))
}

fn read_verified_blob(
    blob_file: &mut impl Read,
    metadata: ManagedAttachmentMetadata,
) -> Result<(ManagedAttachmentMetadata, Vec<u8>), String> {
    let capacity = usize::try_from(metadata.size_bytes)
        .map_err(|_| "Managed attachment size cannot be represented.".to_string())?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(capacity)
        .map_err(|_| "Managed attachment allocation failed.".to_string())?;
    blob_file
        .take(MAX_ATTACHMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 != metadata.size_bytes
        || sha256_hex(&bytes) != metadata.sha256
        || detect_image_mime(&bytes) != Some(metadata.mime_type.as_str())
    {
        return Err("Managed attachment blob does not match its metadata.".to_string());
    }
    Ok((metadata, bytes))
}

pub(crate) fn delete_validated(
    vault_root: &Path,
    attachment_id: &ManagedAttachmentId,
) -> Result<bool, String> {
    let candidate = managed_root(vault_root).join(attachment_id.as_str());
    match fs::symlink_metadata(&candidate) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    }
    let resolved = resolve(vault_root, attachment_id)?;
    let attachment_dir = resolved
        .path
        .parent()
        .ok_or_else(|| "Managed attachment has no parent directory.".to_string())?;
    fs::remove_dir_all(attachment_dir).map_err(|error| error.to_string())?;
    Ok(true)
}

pub(super) fn managed_root(vault_root: &Path) -> PathBuf {
    MANAGED_ROOT_COMPONENTS
        .iter()
        .fold(vault_root.to_path_buf(), |path, component| {
            path.join(component)
        })
}

fn ensure_managed_root(vault_root: &Path) -> Result<PathBuf, String> {
    let canonical_vault = vault_root
        .canonicalize()
        .map_err(|error| format!("Could not resolve vault root: {error}"))?;
    let mut current = vault_root.to_path_buf();
    for component in MANAGED_ROOT_COMPONENTS {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => {
                return Err(format!(
                    "Managed attachment storage component is not a regular directory: {}",
                    current.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                fs::create_dir(&current).map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let canonical_root = current.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_root.starts_with(&canonical_vault) {
        return Err("Managed attachment storage escapes the vault.".to_string());
    }
    Ok(canonical_root)
}

fn existing_managed_root(vault_root: &Path) -> Result<PathBuf, String> {
    let mut root = vault_root.to_path_buf();
    for component in MANAGED_ROOT_COMPONENTS {
        root.push(component);
        require_regular_directory(&root)?;
    }
    let canonical_vault = vault_root
        .canonicalize()
        .map_err(|error| format!("Could not resolve vault root: {error}"))?;
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_root.starts_with(&canonical_vault) {
        return Err("Managed attachment storage escapes the vault.".to_string());
    }
    Ok(canonical_root)
}

fn ensure_local_root(app_data_root: &Path, root: &Path) -> Result<PathBuf, String> {
    create_private_dir_all(app_data_root)?;
    let relative = root
        .strip_prefix(app_data_root)
        .map_err(|_| "Draft storage is outside app data.".to_string())?;
    let canonical_app_data = app_data_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut current = app_data_root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_dir() => {
                harden_private_directory(&current)?;
            }
            Ok(_) => {
                return Err(format!(
                    "Draft storage component is not a regular directory: {}",
                    current.display()
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                create_private_dir(&current)?;
            }
            Err(error) => return Err(error.to_string()),
        }
    }
    let canonical_root = current.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_root.starts_with(&canonical_app_data) {
        return Err("Draft storage escapes app data.".to_string());
    }
    Ok(canonical_root)
}

fn existing_local_root(app_data_root: &Path, root: &Path) -> Result<PathBuf, String> {
    let canonical_app_data = app_data_root
        .canonicalize()
        .map_err(|error| error.to_string())?;
    require_regular_directory(root)?;
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    if !canonical_root.starts_with(&canonical_app_data) {
        return Err("Draft storage escapes app data.".to_string());
    }
    Ok(canonical_root)
}

fn existing_local_item_dir(
    app_data_root: &Path,
    root: &Path,
    item_id: &str,
) -> Result<PathBuf, String> {
    let root = existing_local_root(app_data_root, root)?;
    let item = root.join(item_id);
    require_regular_directory(&item)?;
    let canonical_item = item.canonicalize().map_err(|error| error.to_string())?;
    if canonical_item.parent() != Some(root.as_path()) {
        return Err("Draft attachment escapes its storage root.".to_string());
    }
    Ok(canonical_item)
}

fn read_draft(
    app_data_root: &Path,
    draft_root: &Path,
    draft_id: &DraftAttachmentId,
) -> Result<(DraftAttachmentMetadata, Vec<u8>), String> {
    let (metadata, draft_dir) = read_draft_metadata(app_data_root, draft_root, draft_id)?;
    let blob_path = draft_dir.join(BLOB_FILE);
    require_regular_file(&blob_path)?;

    let mut blob = File::open(&blob_path).map_err(|error| error.to_string())?;
    let capacity = usize::try_from(metadata.size_bytes)
        .map_err(|_| "Draft attachment size cannot be represented.".to_string())?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(capacity)
        .map_err(|_| "Draft attachment allocation failed.".to_string())?;
    Read::by_ref(&mut blob)
        .take(MAX_ATTACHMENT_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 != metadata.size_bytes
        || sha256_hex(&bytes) != metadata.sha256
        || detect_image_mime(&bytes) != Some(metadata.mime_type.as_str())
    {
        return Err("Draft attachment blob does not match its metadata.".to_string());
    }
    Ok((metadata, bytes))
}

fn read_draft_metadata(
    app_data_root: &Path,
    draft_root: &Path,
    draft_id: &DraftAttachmentId,
) -> Result<(DraftAttachmentMetadata, PathBuf), String> {
    let draft_dir = existing_local_item_dir(app_data_root, draft_root, draft_id.as_str())?;
    let metadata_path = draft_dir.join(METADATA_FILE);
    require_regular_file(&metadata_path)?;
    let metadata_size = fs::metadata(&metadata_path)
        .map_err(|error| error.to_string())?
        .len();
    if metadata_size > MAX_METADATA_BYTES {
        return Err("Draft attachment metadata is too large.".to_string());
    }
    let metadata: DraftAttachmentMetadata =
        serde_json::from_reader(File::open(&metadata_path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Invalid draft attachment metadata: {error}"))?;
    if metadata.version != FORMAT_VERSION || metadata.draft_id != *draft_id {
        return Err("Draft attachment metadata does not match its ID.".to_string());
    }
    if metadata.size_bytes > MAX_ATTACHMENT_BYTES as u64 {
        return Err("Draft attachment blob exceeds the size limit.".to_string());
    }
    validate_file_name(&metadata.file_name)?;
    Ok((metadata, draft_dir))
}

fn read_draft_promotion(
    draft_dir: &Path,
    draft_id: &DraftAttachmentId,
) -> Result<Option<DraftPromotionMetadata>, String> {
    let path = draft_dir.join(PROMOTION_FILE);
    match fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err("Draft promotion marker is not a regular file.".to_string());
        }
        Ok(metadata) if metadata.len() > MAX_METADATA_BYTES => {
            return Err("Draft promotion marker is too large.".to_string());
        }
        Ok(_) => {}
    }
    let promotion: DraftPromotionMetadata =
        serde_json::from_reader(File::open(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Invalid draft promotion marker: {error}"))?;
    if promotion.version != FORMAT_VERSION || promotion.draft_id != *draft_id {
        return Err("Draft promotion marker does not match its ID.".to_string());
    }
    Ok(Some(promotion))
}

fn require_regular_directory(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(format!(
            "Managed attachment path is not a regular directory: {}",
            path.display()
        )),
        Err(error) => Err(format!(
            "Managed attachment path does not exist or cannot be read: {}: {error}",
            path.display()
        )),
    }
}

fn require_regular_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => Ok(()),
        Ok(_) => Err(format!(
            "Managed attachment artifact is not a regular file: {}",
            path.display()
        )),
        Err(error) => Err(format!(
            "Managed attachment artifact does not exist or cannot be read: {}: {error}",
            path.display()
        )),
    }
}

fn validate_file_name(file_name: &str) -> Result<(), String> {
    let trimmed = file_name.trim();
    if trimmed.is_empty()
        || trimmed.len() > 255
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains(['/', '\\'])
        || trimmed.chars().any(char::is_control)
    {
        return Err("Invalid managed attachment file name.".to_string());
    }
    Ok(())
}

fn validate_attachment_input(
    file_name: &str,
    declared_mime_type: &str,
    bytes: &[u8],
    kind: &str,
) -> Result<(), String> {
    validate_file_name(file_name)?;
    if bytes.is_empty() {
        return Err(format!("{kind} is empty."));
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "{kind} exceeds the {MAX_ATTACHMENT_BYTES} byte limit."
        ));
    }
    let detected_mime_type =
        detect_image_mime(bytes).ok_or_else(|| format!("{kind} is not a supported image."))?;
    if declared_mime_type != detected_mime_type {
        return Err(format!(
            "{kind} MIME mismatch: declared {declared_mime_type}, detected {detected_mime_type}."
        ));
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

fn create_private_dir_all(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|error| error.to_string())
}

fn create_private_dir(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|error| error.to_string())
}

fn harden_private_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
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

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        File::open(path)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())
    }
    #[cfg(not(unix))]
    {
        #[cfg(windows)]
        {
            // Files are synced before publication and rename_path requests a
            // write-through rename. Directory fsync is not portable on Windows.
            let _ = path;
            return Ok(());
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            Ok(())
        }
    }
}

fn inspect_blob(path: &Path) -> Result<(u64, String, String), String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut header = Vec::with_capacity(16);
    let mut buffer = [0_u8; 64 * 1024];
    let mut size = 0_u64;
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        size = size.saturating_add(read as u64);
        if size > MAX_ATTACHMENT_BYTES as u64 {
            return Err("Managed attachment blob exceeds the size limit.".to_string());
        }
        if header.len() < 16 {
            let remaining = 16 - header.len();
            header.extend_from_slice(&buffer[..read.min(remaining)]);
        }
        hasher.update(&buffer[..read]);
    }
    let mime_type = detect_image_mime(&header)
        .ok_or_else(|| "Managed attachment blob is not a supported image.".to_string())?;
    Ok((
        size,
        digest_hex(&hasher.finalize().into()),
        mime_type.to_string(),
    ))
}

fn detect_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    digest_hex(&hasher.finalize().into())
}

fn digest_hex(digest: &[u8; 32]) -> String {
    let mut value = String::with_capacity(64);
    for byte in digest {
        use std::fmt::Write as _;
        let _ = write!(&mut value, "{byte:02x}");
    }
    value
}

fn staging_dir_name(prefix: &str) -> String {
    format!("{prefix}{}-{}", now_ms(), uuid::Uuid::new_v4().simple())
}

fn parse_staging_created_at(value: &str, prefix: &str) -> Option<u64> {
    let (timestamp, nonce) = value.strip_prefix(prefix)?.split_once('-')?;
    if timestamp.is_empty()
        || timestamp.len() > 20
        || !timestamp.bytes().all(|byte| byte.is_ascii_digit())
        || nonce.len() != ID_HEX_LENGTH
        || !nonce
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return None;
    }
    timestamp.parse().ok()
}

fn is_lower_hex(value: &str, expected_length: usize) -> bool {
    value.len() == expected_length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn delete_staging_dir(root: &Path, candidate: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(candidate).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_dir() {
        return Err("Attachment staging entry is not a regular directory.".to_string());
    }
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_candidate = candidate
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if canonical_candidate.parent() != Some(canonical_root.as_path()) {
        return Err("Attachment staging directory escapes its root.".to_string());
    }
    fs::remove_dir_all(&canonical_candidate).map_err(|error| error.to_string())?;
    sync_directory(&canonical_root)
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nmanaged-image";

    #[test]
    fn creates_and_resolves_a_managed_blob_without_using_the_file_name_as_a_path() {
        let vault = tempfile::tempdir().unwrap();

        let metadata = create(vault.path(), "Screenshot by Jane.png", "image/png", PNG).unwrap();
        let resolved = resolve(vault.path(), &metadata.attachment_id).unwrap();

        assert_eq!(resolved.metadata.file_name, "Screenshot by Jane.png");
        assert_eq!(resolved.metadata.mime_type, "image/png");
        assert_eq!(fs::read(resolved.path).unwrap(), PNG);
        assert!(!managed_root(vault.path())
            .join(metadata.attachment_id.as_str())
            .join("Screenshot by Jane.png")
            .exists());
    }

    #[test]
    fn rejects_declared_mime_that_does_not_match_the_blob() {
        let vault = tempfile::tempdir().unwrap();
        let error = create(vault.path(), "image.jpg", "image/jpeg", PNG).unwrap_err();
        assert!(error.contains("MIME mismatch"));
    }

    #[test]
    fn rejects_untrusted_metadata_size_before_allocating_blob_memory() {
        let vault = tempfile::tempdir().unwrap();
        let metadata = create(vault.path(), "image.png", "image/png", PNG).unwrap();
        let metadata_path = managed_root(vault.path())
            .join(metadata.attachment_id.as_str())
            .join(METADATA_FILE);
        let mut corrupt = metadata.clone();
        corrupt.size_bytes = u64::MAX;
        fs::write(metadata_path, serde_json::to_vec(&corrupt).unwrap()).unwrap();

        let error = read(vault.path(), &metadata.attachment_id).unwrap_err();
        assert!(error.contains("size limit"));
    }

    #[test]
    fn rejects_paths_and_encoded_separators_as_attachment_ids() {
        for value in [
            "../blob",
            "..\\blob",
            "%2e%2e%2fblob",
            "C:\\blob",
            "//server/share",
            "ma_0000000000000000000000000000000/",
        ] {
            assert!(
                ManagedAttachmentId::parse(value).is_err(),
                "accepted {value}"
            );
        }
        for value in [
            "../draft",
            "..\\draft",
            "%2e%2e%2fdraft",
            "C:\\draft",
            "//server/share",
            "da_0000000000000000000000000000000/",
        ] {
            assert!(DraftAttachmentId::parse(value).is_err(), "accepted {value}");
        }
    }

    #[test]
    fn promotes_a_local_draft_idempotently_then_deletes_only_the_draft() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let draft_root = app_data.path().join("ai-history/v1/vaults/test/drafts");
        let draft =
            create_draft(app_data.path(), &draft_root, "pasted.png", "image/png", PNG).unwrap();
        assert!(!managed_root(vault.path()).exists());

        let first =
            promote_draft(app_data.path(), &draft_root, vault.path(), &draft.draft_id).unwrap();
        let second =
            promote_draft(app_data.path(), &draft_root, vault.path(), &draft.draft_id).unwrap();

        assert_eq!(first.attachment_id, second.attachment_id);
        assert_eq!(read(vault.path(), &first.attachment_id).unwrap().1, PNG);
        assert!(delete_draft(app_data.path(), &draft_root, &draft.draft_id).unwrap());
        assert!(read(vault.path(), &first.attachment_id).is_ok());
    }

    #[test]
    fn startup_cleanup_respects_draft_ttl_and_promoted_blob_grace() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let draft_root = app_data.path().join("ai-history/v1/vaults/test/drafts");
        let draft =
            create_draft(app_data.path(), &draft_root, "pasted.png", "image/png", PNG).unwrap();
        let metadata_path = draft_root.join(draft.draft_id.as_str()).join(METADATA_FILE);
        let mut expired_draft = draft.clone();
        expired_draft.created_at_ms = 1;
        fs::write(&metadata_path, serde_json::to_vec(&expired_draft).unwrap()).unwrap();
        cleanup_expired_drafts(app_data.path(), &draft_root, DRAFT_TTL_MS + 1);
        assert!(!draft_root.join(draft.draft_id.as_str()).exists());

        let draft = create_draft(
            app_data.path(),
            &draft_root,
            "promoted.png",
            "image/png",
            PNG,
        )
        .unwrap();
        let promoted =
            promote_draft(app_data.path(), &draft_root, vault.path(), &draft.draft_id).unwrap();
        let promoted_at = promoted.promoted_at_ms.unwrap();
        cleanup_expired_promotions(
            vault.path(),
            &std::collections::BTreeSet::new(),
            promoted_at + PROMOTED_GRACE_PERIOD_MS - 1,
        );
        assert!(read(vault.path(), &promoted.attachment_id).is_ok());
        cleanup_expired_promotions(
            vault.path(),
            &std::collections::BTreeSet::new(),
            promoted_at + PROMOTED_GRACE_PERIOD_MS,
        );
        assert!(read(vault.path(), &promoted.attachment_id).is_err());
    }

    #[test]
    fn committed_promotions_are_never_collected_as_grace_orphans() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let draft_root = app_data.path().join("ai-history/v1/vaults/test/drafts");
        let draft =
            create_draft(app_data.path(), &draft_root, "pasted.png", "image/png", PNG).unwrap();
        let promoted =
            promote_draft(app_data.path(), &draft_root, vault.path(), &draft.draft_id).unwrap();
        mark_committed(vault.path(), &promoted.attachment_id).unwrap();
        cleanup_expired_promotions(
            vault.path(),
            &std::collections::BTreeSet::new(),
            promoted.promoted_at_ms.unwrap() + PROMOTED_GRACE_PERIOD_MS,
        );
        assert!(read(vault.path(), &promoted.attachment_id).is_ok());
    }

    #[test]
    fn global_startup_cleanup_removes_expired_drafts_for_unopened_vaults() {
        let app_data = tempfile::tempdir().unwrap();
        let vault_key = "a".repeat(64);
        let draft_root = app_data
            .path()
            .join("ai-history/v1/vaults")
            .join(vault_key)
            .join("drafts");
        let draft =
            create_draft(app_data.path(), &draft_root, "pasted.png", "image/png", PNG).unwrap();
        let metadata_path = draft_root.join(draft.draft_id.as_str()).join(METADATA_FILE);
        let mut expired = draft.clone();
        expired.created_at_ms = 1;
        fs::write(metadata_path, serde_json::to_vec(&expired).unwrap()).unwrap();

        cleanup_expired_drafts_globally(app_data.path(), DRAFT_TTL_MS + 1);

        assert!(!draft_root.join(draft.draft_id.as_str()).exists());
    }

    #[test]
    fn cleanup_removes_only_expired_well_formed_staging_directories() {
        let app_data = tempfile::tempdir().unwrap();
        let vault = tempfile::tempdir().unwrap();
        let draft_root = app_data.path().join("ai-history/v1/vaults/test/drafts");
        create_draft(app_data.path(), &draft_root, "pasted.png", "image/png", PNG).unwrap();
        create(vault.path(), "managed.png", "image/png", PNG).unwrap();
        let old = 1;
        let now = DRAFT_TTL_MS + 1;
        let draft_old = draft_root.join(format!(
            "{DRAFT_STAGING_PREFIX}{old}-{}",
            "a".repeat(ID_HEX_LENGTH)
        ));
        let draft_fresh = draft_root.join(format!(
            "{DRAFT_STAGING_PREFIX}{now}-{}",
            "b".repeat(ID_HEX_LENGTH)
        ));
        let draft_unknown = draft_root.join(".tmp-da-not-owned");
        fs::create_dir(&draft_old).unwrap();
        fs::create_dir(&draft_fresh).unwrap();
        fs::create_dir(&draft_unknown).unwrap();

        let managed_root = managed_root(vault.path());
        let managed_old = managed_root.join(format!(
            "{MANAGED_STAGING_PREFIX}{old}-{}",
            "c".repeat(ID_HEX_LENGTH)
        ));
        let managed_fresh = managed_root.join(format!(
            "{MANAGED_STAGING_PREFIX}{now}-{}",
            "d".repeat(ID_HEX_LENGTH)
        ));
        fs::create_dir(&managed_old).unwrap();
        fs::create_dir(&managed_fresh).unwrap();

        cleanup_expired_drafts(app_data.path(), &draft_root, now);
        cleanup_expired_managed_staging(vault.path(), now);

        assert!(!draft_old.exists());
        assert!(draft_fresh.exists());
        assert!(draft_unknown.exists());
        assert!(!managed_old.exists());
        assert!(managed_fresh.exists());
    }

    #[cfg(unix)]
    #[test]
    fn draft_storage_uses_private_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let app_data = tempfile::tempdir().unwrap();
        let draft_root = app_data.path().join("ai-history/v1/vaults/test/drafts");
        let draft =
            create_draft(app_data.path(), &draft_root, "pasted.png", "image/png", PNG).unwrap();
        let draft_dir = draft_root.join(draft.draft_id.as_str());

        for directory in [draft_root.as_path(), draft_dir.as_path()] {
            assert_eq!(
                fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        for file in [draft_dir.join(BLOB_FILE), draft_dir.join(METADATA_FILE)] {
            assert_eq!(
                fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn staging_cleanup_preserves_symlinks() {
        use std::os::unix::fs::symlink;

        let app_data = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let draft_root = app_data.path().join("ai-history/v1/vaults/test/drafts");
        create_draft(app_data.path(), &draft_root, "pasted.png", "image/png", PNG).unwrap();
        let link = draft_root.join(format!(
            "{DRAFT_STAGING_PREFIX}1-{}",
            "e".repeat(ID_HEX_LENGTH)
        ));
        symlink(outside.path(), &link).unwrap();

        cleanup_expired_drafts(app_data.path(), &draft_root, DRAFT_TTL_MS + 1);

        assert!(fs::symlink_metadata(link).unwrap().file_type().is_symlink());
        assert!(outside.path().exists());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_symlinked_managed_storage_component() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(vault.path().join("assets/chat")).unwrap();
        symlink(
            outside.path(),
            vault.path().join("assets/chat/.neverwrite-managed"),
        )
        .unwrap();

        let error = create(vault.path(), "image.png", "image/png", PNG).unwrap_err();
        assert!(error.contains("not a regular directory"));
        assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn rejects_a_blob_replaced_with_a_symlink_after_creation() {
        use std::os::unix::fs::symlink;

        let vault = tempfile::tempdir().unwrap();
        let outside = tempfile::NamedTempFile::new().unwrap();
        fs::write(outside.path(), PNG).unwrap();
        let metadata = create(vault.path(), "image.png", "image/png", PNG).unwrap();
        let attachment_dir = managed_root(vault.path()).join(metadata.attachment_id.as_str());
        let blob_path = attachment_dir.join(BLOB_FILE);
        fs::remove_file(&blob_path).unwrap();
        symlink(outside.path(), &blob_path).unwrap();

        let error = resolve(vault.path(), &metadata.attachment_id).unwrap_err();
        assert!(error.contains("not a regular file"));
        assert!(delete_validated(vault.path(), &metadata.attachment_id).is_err());
        assert_eq!(fs::read(outside.path()).unwrap(), PNG);
    }
}
