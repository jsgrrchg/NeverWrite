use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const MANAGED_ROOT_COMPONENTS: &[&str] = &["assets", "chat", ".neverwrite-managed", "v1", "blobs"];
const BLOB_FILE: &str = "blob";
const METADATA_FILE: &str = "metadata.json";
const FORMAT_VERSION: u32 = 1;
const MAX_ATTACHMENT_BYTES: usize = 20 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 64 * 1024;
const ID_PREFIX: &str = "ma_";
const ID_HEX_LENGTH: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ManagedAttachmentMetadata {
    version: u32,
    pub(crate) attachment_id: ManagedAttachmentId,
    pub(crate) file_name: String,
    pub(crate) mime_type: String,
    size_bytes: u64,
    sha256: String,
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
    let staging_dir = root.join(format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir(&staging_dir).map_err(|error| error.to_string())?;

    let result = (|| {
        write_new_file(&staging_dir.join(BLOB_FILE), bytes)?;
        let metadata = ManagedAttachmentMetadata {
            version: FORMAT_VERSION,
            attachment_id,
            file_name: file_name.to_string(),
            mime_type: detected_mime_type.to_string(),
            size_bytes: bytes.len() as u64,
            sha256: sha256_hex(bytes),
        };
        let metadata_bytes = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
        write_new_file(&staging_dir.join(METADATA_FILE), &metadata_bytes)?;
        sync_directory(&staging_dir)?;
        fs::rename(&staging_dir, &final_dir).map_err(|error| error.to_string())?;
        sync_directory(&root)?;
        Ok(metadata)
    })();

    if result.is_err() {
        fs::remove_dir_all(&staging_dir).ok();
    }
    result
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
        directory = directory.open_dir(component).map_err(|error| error.to_string())?;
    }
    let mut metadata_file = directory.open(METADATA_FILE).map_err(|error| error.to_string())?;
    if !metadata_file.metadata().map_err(|error| error.to_string())?.is_file() {
        return Err("Managed attachment metadata is not a regular file.".to_string());
    }
    let mut metadata_bytes = Vec::new();
    metadata_file
        .take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut metadata_bytes)
        .map_err(|error| error.to_string())?;
    let metadata = parse_metadata_bytes(&metadata_bytes, attachment_id)?;
    let mut blob_file = directory.open(BLOB_FILE).map_err(|error| error.to_string())?;
    if !blob_file.metadata().map_err(|error| error.to_string())?.is_file() {
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
    if !metadata_file.metadata().map_err(|error| error.to_string())?.is_file() {
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
    if !blob_file.metadata().map_err(|error| error.to_string())?.is_file() {
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

fn managed_root(vault_root: &Path) -> PathBuf {
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

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
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
            use std::os::windows::fs::OpenOptionsExt;
            const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x02000000;
            return OpenOptions::new()
                .read(true)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
                .open(path)
                .and_then(|directory| directory.sync_all())
                .map_err(|error| error.to_string());
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
