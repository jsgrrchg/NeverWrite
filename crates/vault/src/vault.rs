use std::io;
use std::path::{Component, Path, PathBuf};

use neverwrite_types::{NoteDocument, VaultEntryDto};
use walkdir::WalkDir;

use crate::error::VaultError;
use crate::parser;

const IGNORED_DIR_NAMES: &[&str] = &[
    ".obsidian",
    ".git",
    ".neverwrite",
    ".neverwrite-cache",
    ".trash",
    "target",
    "node_modules",
    "vendor",
    ".cargo-home",
    ".claude",
];

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DiscoveredNoteFile {
    pub id: String,
    pub path: PathBuf,
    pub modified_at: u64,
    pub created_at: u64,
    pub size: u64,
}

pub struct Vault {
    pub root: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BoundaryPathMode {
    Canonical,
    LexicalFallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BoundaryPath {
    path: PathBuf,
    mode: BoundaryPathMode,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopedPathIntent {
    ReadExisting,
    WriteExisting,
    CreateTarget,
    CreateDirectoryTarget,
}

impl Vault {
    /// Opens a vault at the given directory path. Validates that it exists.
    pub fn open(path: PathBuf) -> Result<Self, VaultError> {
        if !path.is_dir() {
            return Err(VaultError::DirectoryNotFound(path));
        }
        Ok(Vault { root: path })
    }

    /// Discovers all `.md` files in the vault and returns lightweight metadata for each file.
    pub fn discover_markdown_files(&self) -> Result<Vec<DiscoveredNoteFile>, VaultError> {
        let mut discovered = Vec::new();

        let walker = WalkDir::new(&self.root).into_iter().filter_entry(|entry| {
            if !entry.file_type().is_dir() {
                return true;
            }

            let name = entry.file_name().to_string_lossy();
            !is_ignored_dir_name(name.as_ref())
        });

        for entry in walker.filter_map(|entry| entry.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }

            let path = entry.path();
            if !path.extension().is_some_and(|ext| ext == "md") {
                continue;
            }

            let metadata = std::fs::metadata(path)?;
            let modified_at = metadata.modified().map(system_time_to_secs).unwrap_or(0);
            let created_at = metadata
                .created()
                .map(system_time_to_secs)
                .unwrap_or(modified_at);

            discovered.push(DiscoveredNoteFile {
                id: self.path_to_id(path),
                path: path.to_path_buf(),
                modified_at,
                created_at,
                size: metadata.len(),
            });
        }

        discovered.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(discovered)
    }

    /// Discovers all files in the vault as `VaultEntryDto`.
    pub fn discover_vault_entries(&self) -> Result<Vec<VaultEntryDto>, VaultError> {
        let mut entries = Vec::new();

        let walker = WalkDir::new(&self.root).into_iter().filter_entry(|entry| {
            if !entry.file_type().is_dir() {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !is_ignored_dir_name(name.as_ref())
        });

        for entry in walker.filter_map(|e| e.ok()) {
            let path = entry.path();
            if entry.file_type().is_dir() {
                if path == self.root {
                    continue;
                }

                entries.push(build_vault_entry(path, "folder".to_string(), self)?);
                continue;
            }

            if !entry.file_type().is_file() {
                continue;
            }

            entries.push(build_vault_entry(path, entry_kind(path).to_string(), self)?);
        }

        entries.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(entries)
    }

    /// Discovers all `.pdf` files in the vault and returns lightweight metadata.
    pub fn discover_pdf_files(&self) -> Result<Vec<crate::pdf::DiscoveredPdfFile>, VaultError> {
        let mut discovered = Vec::new();

        let walker = WalkDir::new(&self.root).into_iter().filter_entry(|entry| {
            if !entry.file_type().is_dir() {
                return true;
            }
            let name = entry.file_name().to_string_lossy();
            !is_ignored_dir_name(name.as_ref())
        });

        for entry in walker.filter_map(|entry| entry.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if !path.extension().is_some_and(|ext| ext == "pdf") {
                continue;
            }

            let metadata = std::fs::metadata(path)?;
            let modified_at = metadata.modified().map(system_time_to_secs).unwrap_or(0);
            let created_at = metadata
                .created()
                .map(system_time_to_secs)
                .unwrap_or(modified_at);

            discovered.push(crate::pdf::DiscoveredPdfFile {
                id: self.path_to_entry_id(path),
                path: path.to_path_buf(),
                modified_at,
                created_at,
                size: metadata.len(),
            });
        }

        discovered.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(discovered)
    }

    /// Converts a path to an entry_id (relative path without extension).
    pub fn path_to_entry_id(&self, path: &Path) -> String {
        path_to_portable_string(
            path.strip_prefix(&self.root)
                .unwrap_or(path)
                .with_extension(""),
        )
    }

    /// Converts a path to a relative_path with extension.
    pub fn path_to_relative_path(&self, path: &Path) -> String {
        path_to_portable_string(path.strip_prefix(&self.root).unwrap_or(path))
    }

    pub fn resolve_relative_path(&self, relative_path: &str) -> Result<PathBuf, VaultError> {
        self.resolve_scoped_path(relative_path, ScopedPathIntent::CreateTarget)
    }

    pub fn resolve_scoped_path(
        &self,
        relative_path: &str,
        intent: ScopedPathIntent,
    ) -> Result<PathBuf, VaultError> {
        let path = validate_untrusted_relative_path(relative_path, true)
            .map_err(|_| VaultError::InvalidVaultPath(relative_path.to_string()))?;
        self.resolve_validated_scoped_path(&path, relative_path, intent)
    }

    /// Resolves a relative note_id without the `.md` extension inside the vault.
    pub fn resolve_note_id_path(&self, note_id: &str) -> Result<PathBuf, VaultError> {
        let path = validate_untrusted_relative_path(note_id, false)
            .map_err(|_| VaultError::InvalidVaultPath(note_id.to_string()))?;
        if path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            return Err(VaultError::InvalidVaultPath(note_id.to_string()));
        }

        let mut relative_path = path.clone();
        let file_name = relative_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| VaultError::InvalidVaultPath(note_id.to_string()))?;
        relative_path.set_file_name(format!("{file_name}.md"));
        self.resolve_validated_scoped_path(&relative_path, note_id, ScopedPathIntent::CreateTarget)
    }

    pub fn resolve_note_relative_markdown_path(
        &self,
        relative_path: &str,
    ) -> Result<PathBuf, VaultError> {
        let path = validate_untrusted_relative_path(relative_path, false)
            .map_err(|_| VaultError::InvalidVaultPath(relative_path.to_string()))?;
        if !path
            .extension()
            .and_then(|ext| ext.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
        {
            return Err(VaultError::InvalidVaultPath(relative_path.to_string()));
        }

        self.resolve_scoped_path(relative_path, ScopedPathIntent::CreateTarget)
    }

    pub fn validate_vault_leaf_file_name(&self, file_name: &str) -> Result<(), VaultError> {
        let path = validate_untrusted_relative_path(file_name, false)
            .map_err(|_| VaultError::InvalidVaultPath(file_name.to_string()))?;
        if path.components().count() != 1 {
            return Err(VaultError::InvalidVaultPath(file_name.to_string()));
        }

        Ok(())
    }

    pub fn read_text_file(&self, relative_path: &str) -> Result<String, VaultError> {
        let path = self.resolve_scoped_path(relative_path, ScopedPathIntent::ReadExisting)?;
        if !path.exists() || !path.is_file() || path_is_ignored(&self.root, &path) {
            return Err(VaultError::InvalidVaultPath(relative_path.to_string()));
        }

        Ok(std::fs::read_to_string(path)?)
    }

    pub fn save_text_file(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<VaultEntryDto, VaultError> {
        let path = self.resolve_scoped_path(relative_path, ScopedPathIntent::WriteExisting)?;

        if !path.exists()
            || !path.is_file()
            || path_is_ignored(&self.root, &path)
            || is_markdown_path(&path)
        {
            return Err(VaultError::InvalidVaultPath(relative_path.to_string()));
        }

        std::fs::write(&path, content)?;
        self.read_vault_entry_from_path(&path)
    }

    pub fn move_vault_entry(
        &self,
        relative_path: &str,
        new_relative_path: &str,
    ) -> Result<VaultEntryDto, VaultError> {
        let old_path = self.resolve_scoped_path(relative_path, ScopedPathIntent::WriteExisting)?;
        let new_path =
            self.resolve_scoped_path(new_relative_path, ScopedPathIntent::CreateTarget)?;

        if is_markdown_path(&old_path) || is_markdown_path(&new_path) {
            return Err(VaultError::InvalidVaultPath(relative_path.to_string()));
        }

        if !old_path.exists() || !old_path.is_file() || path_is_ignored(&self.root, &old_path) {
            return Err(VaultError::InvalidVaultPath(relative_path.to_string()));
        }

        if path_is_ignored(&self.root, &new_path) {
            return Err(VaultError::InvalidVaultPath(new_relative_path.to_string()));
        }

        if old_path == new_path {
            return self.read_vault_entry_from_path(&old_path);
        }

        if new_path.exists() {
            return Err(VaultError::EntryAlreadyExists(new_path));
        }

        if let Some(parent) = new_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        std::fs::rename(&old_path, &new_path)?;
        self.read_vault_entry_from_path(&new_path)
    }

    /// Saves arbitrary binary data to the vault, creating parent dirs as needed.
    /// Returns the resulting VaultEntryDto.  Does NOT overwrite — appends a
    /// short random suffix when the target path already exists.
    pub fn save_binary_file(
        &self,
        relative_dir: &str,
        file_name: &str,
        bytes: &[u8],
    ) -> Result<(PathBuf, VaultEntryDto), VaultError> {
        let target = self.prepare_binary_file_target(relative_dir, file_name)?;
        std::fs::write(&target, bytes)?;
        let entry = self.read_vault_entry_from_path(&target)?;
        Ok((target, entry))
    }

    pub fn prepare_binary_file_target(
        &self,
        relative_dir: &str,
        file_name: &str,
    ) -> Result<PathBuf, VaultError> {
        let dir_path =
            self.resolve_scoped_path(relative_dir, ScopedPathIntent::CreateDirectoryTarget)?;
        if path_is_ignored(&self.root, &dir_path) {
            return Err(VaultError::InvalidVaultPath(relative_dir.to_string()));
        }
        self.validate_vault_leaf_file_name(file_name)?;
        if !dir_path.exists() {
            std::fs::create_dir_all(&dir_path)?;
        }

        let mut target = dir_path.join(file_name);
        if target.exists() {
            // Deduplicate: stem-XXXX.ext
            let stem = target
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let ext = target
                .extension()
                .map(|e| format!(".{}", e.to_string_lossy()))
                .unwrap_or_default();
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis();
            target = dir_path.join(format!("{stem}-{ts}{ext}"));
        }

        Ok(target)
    }

    pub fn create_folder(&self, relative_path: &str) -> Result<VaultEntryDto, VaultError> {
        let path =
            self.resolve_scoped_path(relative_path, ScopedPathIntent::CreateDirectoryTarget)?;

        if path_is_ignored(&self.root, &path) {
            return Err(VaultError::InvalidVaultPath(relative_path.to_string()));
        }

        // Ensure parent directories exist, then create the leaf atomically.
        // create_dir fails with AlreadyExists if the folder (or a note with
        // the same stem) already exists, eliminating the TOCTOU window.
        if self.id_to_path(relative_path).exists() {
            return Err(VaultError::EntryAlreadyExists(path));
        }
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        match std::fs::create_dir(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(VaultError::EntryAlreadyExists(path));
            }
            Err(e) => return Err(e.into()),
        }
        self.read_vault_entry_from_path(&path)
    }

    pub fn move_folder(
        &self,
        relative_path: &str,
        new_relative_path: &str,
    ) -> Result<(), VaultError> {
        let old_path = self.resolve_scoped_path(relative_path, ScopedPathIntent::ReadExisting)?;
        let new_path =
            self.resolve_scoped_path(new_relative_path, ScopedPathIntent::CreateDirectoryTarget)?;

        if !old_path.exists() || !old_path.is_dir() || path_is_ignored(&self.root, &old_path) {
            return Err(VaultError::InvalidVaultPath(relative_path.to_string()));
        }

        if path_is_ignored(&self.root, &new_path) {
            return Err(VaultError::InvalidVaultPath(new_relative_path.to_string()));
        }

        if old_path == new_path {
            return Ok(());
        }

        if new_path.exists() || self.id_to_path(new_relative_path).exists() {
            return Err(VaultError::EntryAlreadyExists(new_path));
        }

        if let Some(parent) = new_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        std::fs::rename(&old_path, &new_path)?;
        Ok(())
    }

    pub fn copy_folder(
        &self,
        relative_path: &str,
        new_relative_path: &str,
    ) -> Result<VaultEntryDto, VaultError> {
        let source = self.resolve_scoped_path(relative_path, ScopedPathIntent::ReadExisting)?;
        let target =
            self.resolve_scoped_path(new_relative_path, ScopedPathIntent::CreateDirectoryTarget)?;

        if !source.exists() || !source.is_dir() || path_is_ignored(&self.root, &source) {
            return Err(VaultError::InvalidVaultPath(relative_path.to_string()));
        }

        if path_is_ignored(&self.root, &target) {
            return Err(VaultError::InvalidVaultPath(new_relative_path.to_string()));
        }

        if self.id_to_path(new_relative_path).exists() {
            return Err(VaultError::EntryAlreadyExists(target));
        }

        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }

        // Create the target directory atomically — fails if it already exists,
        // eliminating the TOCTOU window for the directory itself.
        match std::fs::create_dir(&target) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(VaultError::EntryAlreadyExists(target));
            }
            Err(e) => return Err(e.into()),
        }

        copy_dir_recursive(&source, &target)?;
        self.read_vault_entry_from_path(&target)
    }

    pub fn delete_folder(&self, relative_path: &str) -> Result<(), VaultError> {
        let path = self.resolve_scoped_path(relative_path, ScopedPathIntent::ReadExisting)?;

        if !path.exists() || !path.is_dir() {
            return Err(VaultError::InvalidVaultPath(relative_path.to_string()));
        }

        if path_is_ignored(&self.root, &path) {
            return Err(VaultError::InvalidVaultPath(relative_path.to_string()));
        }

        std::fs::remove_dir_all(&path)?;
        Ok(())
    }

    /// Recursively scans all `.md` files and parses them.
    pub fn scan(&self) -> Result<Vec<NoteDocument>, VaultError> {
        self.parse_discovered_files(&self.discover_markdown_files()?, |_| {})
    }

    pub fn parse_discovered_files(
        &self,
        files: &[DiscoveredNoteFile],
        mut on_progress: impl FnMut(usize),
    ) -> Result<Vec<NoteDocument>, VaultError> {
        let mut notes = Vec::with_capacity(files.len());

        for (index, file) in files.iter().enumerate() {
            notes.push(self.read_note_from_path(&file.path)?);
            on_progress(index + 1);
        }

        Ok(notes)
    }

    /// Converts an absolute path to a note_id (relative path without the .md extension).
    pub fn path_to_id(&self, path: &Path) -> String {
        path_to_portable_string(
            path.strip_prefix(&self.root)
                .unwrap_or(path)
                .with_extension(""),
        )
    }

    /// Converts an already validated note_id to the file's absolute path.
    pub(crate) fn id_to_path(&self, note_id: &str) -> PathBuf {
        self.root.join(format!("{}.md", note_id))
    }

    pub fn read_note_from_path(&self, path: &Path) -> Result<NoteDocument, VaultError> {
        let content = std::fs::read_to_string(path)?;
        let id = self.path_to_id(path);
        Ok(parser::parse_note(&id, path, &content))
    }

    pub fn read_vault_entry_from_path(&self, path: &Path) -> Result<VaultEntryDto, VaultError> {
        build_vault_entry(path, entry_kind(path).to_string(), self)
    }
}

/// Normalizes an existing vault path for stable storage. On Windows, some
/// virtual filesystems (notably rclone/WinFsp drive-letter mounts) support
/// normal file operations but fail canonicalization with OS error 1005.
pub fn normalize_existing_vault_path(path: &Path) -> io::Result<PathBuf> {
    canonicalize_existing_path_for_boundary(path).map(|resolved| resolved.path)
}

impl Vault {
    fn resolve_validated_scoped_path(
        &self,
        relative_path: &Path,
        raw_input: &str,
        intent: ScopedPathIntent,
    ) -> Result<PathBuf, VaultError> {
        let candidate = self.root.join(relative_path);
        let resolved_root = canonicalize_existing_path_for_boundary(&self.root)
            .map_err(|_| VaultError::InvalidVaultPath(raw_input.to_string()))?;

        let nearest_existing_ancestor =
            nearest_existing_ancestor(&candidate).map_err(VaultError::from)?;
        let resolved_ancestor = canonicalize_existing_path_for_boundary(&nearest_existing_ancestor)
            .map_err(|_| VaultError::InvalidVaultPath(raw_input.to_string()))?;
        if !boundary_path_starts_with(&resolved_ancestor, &resolved_root) {
            return Err(VaultError::InvalidVaultPath(raw_input.to_string()));
        }

        self.reject_forbidden_existing_components(relative_path, raw_input)?;

        if matches!(
            intent,
            ScopedPathIntent::ReadExisting | ScopedPathIntent::WriteExisting
        ) && !candidate.exists()
        {
            return Err(VaultError::InvalidVaultPath(raw_input.to_string()));
        }

        Ok(candidate)
    }

    fn reject_forbidden_existing_components(
        &self,
        relative_path: &Path,
        raw_input: &str,
    ) -> Result<(), VaultError> {
        let mut current = self.root.clone();
        for component in relative_path.components() {
            current.push(component.as_os_str());
            match std::fs::symlink_metadata(&current) {
                Ok(metadata) => {
                    if metadata_has_forbidden_link_behavior(&metadata) {
                        return Err(VaultError::InvalidVaultPath(raw_input.to_string()));
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                Err(error) => return Err(error.into()),
            }
        }

        Ok(())
    }
}

fn validate_untrusted_relative_path(raw: &str, allow_empty: bool) -> Result<PathBuf, ()> {
    if raw.is_empty() {
        return if allow_empty {
            Ok(PathBuf::new())
        } else {
            Err(())
        };
    }

    if raw.contains('\\') || raw.split('/').any(str::is_empty) {
        return Err(());
    }

    let mut normalized = PathBuf::new();
    let mut has_component = false;

    for component in Path::new(raw).components() {
        match component {
            Component::Normal(value) => {
                let value = value.to_str().ok_or(())?;
                if value == "." || value == ".." || looks_like_windows_prefix(value) {
                    return Err(());
                }
                normalized.push(value);
                has_component = true;
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => return Err(()),
        }
    }

    if !has_component && !allow_empty {
        return Err(());
    }

    Ok(normalized)
}

fn looks_like_windows_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

pub fn is_ignored_dir_name(name: &str) -> bool {
    IGNORED_DIR_NAMES.contains(&name)
}

pub(crate) fn is_markdown_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

pub(crate) fn is_pdf_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("pdf"))
}

pub fn is_supported_text_path(path: &Path) -> bool {
    let Some(mime_type) = guess_mime_type(path) else {
        return false;
    };

    is_text_like_mime_type(&mime_type)
}

fn entry_kind(path: &Path) -> &'static str {
    if path.is_dir() {
        "folder"
    } else if is_markdown_path(path) {
        "note"
    } else if is_pdf_path(path) {
        "pdf"
    } else {
        "file"
    }
}

fn is_excalidraw_path(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("excalidraw"))
}

fn is_text_like_mime_type(mime_type: &str) -> bool {
    mime_type.starts_with("text/")
        || matches!(
            mime_type,
            "application/json" | "application/yaml" | "application/toml" | "application/xml"
        )
}

#[derive(Debug, Clone)]
struct VaultEntryClassification {
    mime_type: Option<String>,
    is_text_like: bool,
    is_image_like: bool,
    open_in_app: bool,
    viewer_kind: String,
}

fn classify_vault_entry_path(path: &Path, kind: &str) -> VaultEntryClassification {
    let mime_type = guess_mime_type(path);
    let is_text_like = mime_type.as_deref().is_some_and(is_text_like_mime_type);
    let is_image_like = mime_type
        .as_deref()
        .is_some_and(|mime_type| mime_type.starts_with("image/"));

    let (open_in_app, viewer_kind) = match kind {
        "folder" => (false, "folder"),
        "note" => (true, "markdown"),
        "pdf" => (true, "pdf"),
        _ if is_excalidraw_path(path) => (true, "map"),
        _ if is_image_like => (true, "image"),
        _ if is_text_like => (true, "text"),
        _ => (false, "external"),
    };

    VaultEntryClassification {
        mime_type,
        is_text_like,
        is_image_like,
        open_in_app,
        viewer_kind: viewer_kind.to_string(),
    }
}

fn build_vault_entry(
    path: &Path,
    kind: String,
    vault: &Vault,
) -> Result<VaultEntryDto, VaultError> {
    let relative_path = vault.path_to_relative_path(path);
    let file_name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| relative_path.clone());
    let extension = if kind == "folder" {
        String::new()
    } else {
        path.extension()
            .and_then(|e| e.to_str())
            .map(|value| value.to_ascii_lowercase())
            .unwrap_or_default()
    };
    let metadata = std::fs::metadata(path)?;
    let modified_at = metadata.modified().map(system_time_to_secs).unwrap_or(0);
    let created_at = metadata
        .created()
        .map(system_time_to_secs)
        .unwrap_or(modified_at);
    let classification = classify_vault_entry_path(path, &kind);
    let id = match kind.as_str() {
        "file" | "folder" => relative_path.clone(),
        _ => vault.path_to_entry_id(path),
    };
    let title = if kind == "folder" {
        file_name.clone()
    } else {
        path.file_stem()
            .and_then(|s| {
                let value = s.to_string_lossy();
                if value.is_empty() {
                    None
                } else {
                    Some(value.to_string())
                }
            })
            .unwrap_or_else(|| file_name.clone())
    };

    Ok(VaultEntryDto {
        id,
        path: path.to_string_lossy().to_string(),
        relative_path,
        title,
        file_name,
        extension,
        kind,
        modified_at,
        created_at,
        size: metadata.len(),
        mime_type: classification.mime_type,
        is_text_like: Some(classification.is_text_like),
        is_image_like: Some(classification.is_image_like),
        open_in_app: Some(classification.open_in_app),
        viewer_kind: Some(classification.viewer_kind),
    })
}

fn path_to_portable_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().replace('\\', "/")
}

fn nearest_existing_ancestor(path: &Path) -> Result<PathBuf, std::io::Error> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        match std::fs::symlink_metadata(candidate) {
            Ok(_) => return Ok(candidate.to_path_buf()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                current = candidate.parent();
            }
            Err(error) => return Err(error),
        }
    }

    Err(std::io::Error::new(
        std::io::ErrorKind::NotFound,
        "No existing ancestor found for vault path",
    ))
}

fn canonicalize_existing_path_for_boundary(path: &Path) -> io::Result<BoundaryPath> {
    canonicalize_existing_path_with(
        path,
        |path| std::fs::canonicalize(path),
        is_virtual_fs_canonicalize_error,
    )
}

fn canonicalize_existing_path_with(
    path: &Path,
    canonicalize: impl FnOnce(&Path) -> io::Result<PathBuf>,
    is_virtual_fs_error: impl FnOnce(&io::Error) -> bool,
) -> io::Result<BoundaryPath> {
    match canonicalize(path) {
        Ok(path) => Ok(BoundaryPath {
            path,
            mode: BoundaryPathMode::Canonical,
        }),
        Err(error) => {
            if !is_virtual_fs_error(&error) {
                return Err(error);
            }
            std::fs::metadata(path)?;
            Ok(BoundaryPath {
                path: normalize_lexically(path),
                mode: BoundaryPathMode::LexicalFallback,
            })
        }
    }
}

#[cfg(windows)]
fn is_virtual_fs_canonicalize_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(1005)
}

#[cfg(not(windows))]
fn is_virtual_fs_canonicalize_error(_error: &io::Error) -> bool {
    false
}

fn boundary_path_starts_with(child: &BoundaryPath, parent: &BoundaryPath) -> bool {
    if child.mode == BoundaryPathMode::Canonical && parent.mode == BoundaryPathMode::Canonical {
        return child.path.starts_with(&parent.path);
    }

    normalize_lexically(&child.path).starts_with(normalize_lexically(&parent.path))
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut normalized = if path.is_absolute() {
        PathBuf::new()
    } else {
        std::env::current_dir().unwrap_or_else(|_| PathBuf::new())
    };

    for component in path.components() {
        match component {
            Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
            Component::RootDir => normalized.push(component.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            Component::Normal(value) => normalized.push(value),
        }
    }

    normalized
}

fn metadata_has_forbidden_link_behavior(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || metadata_is_windows_reparse_point(metadata)
}

#[cfg(windows)]
fn metadata_is_windows_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_windows_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), VaultError> {
    std::fs::create_dir_all(target)?;

    for entry in std::fs::read_dir(source)? {
        let entry = entry?;
        let source_path = entry.path();
        let target_path = target.join(entry.file_name());

        let metadata = std::fs::symlink_metadata(&source_path)?;
        if metadata_has_forbidden_link_behavior(&metadata) {
            return Err(VaultError::InvalidVaultPath(
                source_path.to_string_lossy().to_string(),
            ));
        }

        if metadata.is_dir() {
            copy_dir_recursive(&source_path, &target_path)?;
        } else {
            std::fs::copy(&source_path, &target_path)?;
        }
    }

    Ok(())
}

pub(crate) fn path_is_ignored(root: &Path, path: &Path) -> bool {
    let Ok(relative_path) = path.strip_prefix(root) else {
        return false;
    };

    relative_path.components().any(|component| match component {
        Component::Normal(name) => is_ignored_dir_name(&name.to_string_lossy()),
        _ => false,
    })
}

fn system_time_to_secs(value: std::time::SystemTime) -> u64 {
    value
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn guess_mime_type(path: &Path) -> Option<String> {
    let file_name = path.file_name()?.to_str()?.to_ascii_lowercase();
    let mime = match file_name.as_str() {
        ".babelrc" | ".dockerignore" | ".editorconfig" | ".eslintignore" | ".eslintrc"
        | ".gitattributes" | ".gitconfig" | ".gitignore" | ".gitmodules" | ".ignore"
        | ".node-version" | ".npmignore" | ".npmrc" | ".prettierignore" | ".prettierrc"
        | ".python-version" | ".ruby-version" | ".stylelintrc" | ".stylelintignore"
        | ".terraform-version" | ".tool-versions" | ".yarnrc" | ".bash_profile" | ".bashrc"
        | ".profile" | ".zprofile" | ".zshrc" | "brewfile" | "cmakelists.txt" | "containerfile"
        | "dockerfile" | "gemfile" | "gnumakefile" | "justfile" | "makefile" | "podfile"
        | "procfile" | "rakefile" => "text/plain",
        value if value == ".env" || value.starts_with(".env.") => "text/plain",
        value if value.starts_with('.') && (value.ends_with("rc") || value.ends_with("ignore")) => {
            "text/plain"
        }
        _ => {
            let ext = path.extension()?.to_str()?.to_ascii_lowercase();
            match ext.as_str() {
                "md" | "mdx" => "text/markdown",
                "txt" | "log" | "ini" | "cfg" | "conf" => "text/plain",
                "rs" => "text/rust",
                "js" | "cjs" | "mjs" => "text/javascript",
                "ts" | "tsx" | "cts" | "mts" => "text/typescript",
                "jsx" => "text/jsx",
                "json" => "application/json",
                "yaml" | "yml" => "application/yaml",
                "toml" => "application/toml",
                "xml" => "application/xml",
                "html" | "htm" => "text/html",
                "css" => "text/css",
                "csv" => "text/csv",
                "astro" | "bat" | "bash" | "c" | "cc" | "clj" | "cljs" | "cmake" | "cpp" | "cs"
                | "d" | "dart" | "diff" | "elm" | "env" | "erl" | "ex" | "exs" | "fish" | "go"
                | "gradle" | "graphql" | "groovy" | "h" | "hpp" | "hs" | "java" | "jl"
                | "jsonc" | "kt" | "kts" | "less" | "lock" | "lua" | "m" | "mk" | "nim" | "nix"
                | "patch" | "php" | "pl" | "plist" | "prisma" | "properties" | "proto" | "ps1"
                | "py" | "r" | "rb" | "rc" | "sass" | "scala" | "scss" | "sh" | "sql" | "styl"
                | "svelte" | "swift" | "tcl" | "tex" | "tf" | "tfvars" | "v" | "vb" | "vue"
                | "wast" | "zig" | "zsh" => "text/plain",
                "svg" => "image/svg+xml",
                "png" => "image/png",
                "jpg" | "jpeg" | "jpe" | "jfif" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                "avif" => "image/avif",
                "bmp" => "image/bmp",
                "ico" => "image/x-icon",
                "pdf" => "application/pdf",
                "excalidraw" => "application/json",
                _ => return None,
            }
        }
    };

    Some(mime.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        boundary_path_starts_with, canonicalize_existing_path_with, guess_mime_type,
        is_supported_text_path, normalize_lexically, BoundaryPath, BoundaryPathMode, Vault,
    };
    use std::io;
    use std::path::{Path, PathBuf};

    #[test]
    fn guess_mime_type_recognizes_extended_text_file_set() {
        assert_eq!(
            guess_mime_type(Path::new("src/main.py")).as_deref(),
            Some("text/plain")
        );
        assert_eq!(
            guess_mime_type(Path::new("src/App.svelte")).as_deref(),
            Some("text/plain")
        );
        assert_eq!(
            guess_mime_type(Path::new("src/workflow.mdx")).as_deref(),
            Some("text/markdown")
        );
        assert_eq!(
            guess_mime_type(Path::new("src/config.jsonc")).as_deref(),
            Some("text/plain")
        );
    }

    #[test]
    fn supported_text_path_accepts_extended_text_files() {
        assert!(is_supported_text_path(Path::new("src/main.py")));
        assert!(is_supported_text_path(Path::new("src/App.svelte")));
        assert!(is_supported_text_path(Path::new(".env.local")));
    }

    #[test]
    fn vault_relative_dtos_use_forward_slashes() {
        let vault_dir = tempfile::tempdir().unwrap();
        let nested_dir = vault_dir.path().join("Folder").join("Nested");
        std::fs::create_dir_all(&nested_dir).unwrap();
        std::fs::write(nested_dir.join("main.ts"), "export const value = 1;\n").unwrap();
        std::fs::write(nested_dir.join("Note.md"), "# Note\n").unwrap();

        let vault = Vault::open(vault_dir.path().to_path_buf()).unwrap();
        let entries = vault.discover_vault_entries().unwrap();

        let source_entry = entries
            .iter()
            .find(|entry| entry.file_name == "main.ts")
            .unwrap();
        assert_eq!(source_entry.id, "Folder/Nested/main.ts");
        assert_eq!(source_entry.relative_path, "Folder/Nested/main.ts");
        assert!(!source_entry.relative_path.contains('\\'));

        let note_entry = entries
            .iter()
            .find(|entry| entry.file_name == "Note.md")
            .unwrap();
        assert_eq!(note_entry.id, "Folder/Nested/Note");
        assert_eq!(note_entry.relative_path, "Folder/Nested/Note.md");
        assert!(!note_entry.id.contains('\\'));
        assert!(!note_entry.relative_path.contains('\\'));

        let notes = vault.discover_markdown_files().unwrap();
        assert_eq!(notes[0].id, "Folder/Nested/Note");
        assert!(!notes[0].id.contains('\\'));
    }

    #[test]
    fn canonicalize_fallback_accepts_existing_virtual_filesystem_paths() {
        let vault_dir = tempfile::tempdir().unwrap();
        let error = io::Error::from_raw_os_error(1005);

        let resolved = canonicalize_existing_path_with(
            vault_dir.path(),
            |_| Err(error),
            |error| error.raw_os_error() == Some(1005),
        )
        .unwrap();

        assert_eq!(resolved.mode, BoundaryPathMode::LexicalFallback);
        assert_eq!(resolved.path, normalize_lexically(vault_dir.path()));
    }

    #[test]
    fn canonicalize_fallback_still_requires_existing_paths() {
        let missing = PathBuf::from("__neverwrite_missing_virtual_vault__");
        let error = io::Error::from_raw_os_error(1005);

        let result = canonicalize_existing_path_with(
            &missing,
            |_| Err(error),
            |error| error.raw_os_error() == Some(1005),
        );

        assert!(result.is_err());
    }

    #[test]
    fn lexical_boundary_checks_are_path_component_aware() {
        let parent = BoundaryPath {
            path: PathBuf::from("/vault"),
            mode: BoundaryPathMode::LexicalFallback,
        };
        let child = BoundaryPath {
            path: PathBuf::from("/vault/Notes/Alpha.md"),
            mode: BoundaryPathMode::LexicalFallback,
        };
        let sibling_with_same_prefix = BoundaryPath {
            path: PathBuf::from("/vault-other/Alpha.md"),
            mode: BoundaryPathMode::LexicalFallback,
        };

        assert!(boundary_path_starts_with(&child, &parent));
        assert!(!boundary_path_starts_with(
            &sibling_with_same_prefix,
            &parent
        ));
    }
}
