use std::path::{Path, PathBuf};

use vault_ai_types::NoteDocument;
use walkdir::WalkDir;

use crate::error::VaultError;
use crate::parser;

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

impl Vault {
    /// Abre un vault en el directorio dado. Valida que exista.
    pub fn open(path: PathBuf) -> Result<Self, VaultError> {
        if !path.is_dir() {
            return Err(VaultError::DirectoryNotFound(path));
        }
        Ok(Vault { root: path })
    }

    /// Descubre todos los archivos `.md` del vault y devuelve metadata liviana por archivo.
    pub fn discover_markdown_files(&self) -> Result<Vec<DiscoveredNoteFile>, VaultError> {
        let mut discovered = Vec::new();

        let walker = WalkDir::new(&self.root).into_iter().filter_entry(|entry| {
            if !entry.file_type().is_dir() {
                return true;
            }

            let name = entry.file_name().to_string_lossy();
            !matches!(
                name.as_ref(),
                ".obsidian" | ".git" | ".vaultai" | ".vaultai-cache" | ".trash"
            )
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

    /// Escanea recursivamente todos los archivos `.md` y los parsea.
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

    /// Convierte un path absoluto a un note_id (path relativo sin extensión .md).
    pub fn path_to_id(&self, path: &Path) -> String {
        path.strip_prefix(&self.root)
            .unwrap_or(path)
            .with_extension("")
            .to_string_lossy()
            .to_string()
    }

    /// Convierte un note_id al path absoluto del archivo.
    pub fn id_to_path(&self, note_id: &str) -> PathBuf {
        self.root.join(format!("{}.md", note_id))
    }

    pub fn read_note_from_path(&self, path: &Path) -> Result<NoteDocument, VaultError> {
        let content = std::fs::read_to_string(path)?;
        let id = self.path_to_id(path);
        Ok(parser::parse_note(&id, path, &content))
    }
}

fn system_time_to_secs(value: std::time::SystemTime) -> u64 {
    value
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}
