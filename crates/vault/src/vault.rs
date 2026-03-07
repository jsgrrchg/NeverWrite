use std::path::{Path, PathBuf};

use vault_ai_types::NoteDocument;
use walkdir::WalkDir;

use crate::error::VaultError;
use crate::parser;

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

    /// Escanea recursivamente todos los archivos `.md` y los parsea.
    pub fn scan(&self) -> Result<Vec<NoteDocument>, VaultError> {
        let mut notes = Vec::new();

        for entry in WalkDir::new(&self.root)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file() && e.path().extension().is_some_and(|ext| ext == "md")
            })
        {
            let path = entry.path();
            let content = std::fs::read_to_string(path)?;
            let id = self.path_to_id(path);
            let note = parser::parse_note(&id, path, &content);
            notes.push(note);
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
}
