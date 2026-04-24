use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum VaultError {
    #[error("El directorio del vault no existe: {0}")]
    DirectoryNotFound(PathBuf),

    #[error("Nota no encontrada: {0}")]
    NoteNotFound(String),

    #[error("La nota ya existe: {0}")]
    NoteAlreadyExists(PathBuf),

    #[error("La entrada ya existe: {0}")]
    EntryAlreadyExists(PathBuf),

    #[error("Path inválido dentro del vault: {0}")]
    InvalidVaultPath(String),

    #[error("Error de IO: {0}")]
    Io(#[from] std::io::Error),

    #[error("Error del watcher: {0}")]
    Watcher(#[from] notify::Error),

    #[error("Error de extracción PDF: {0}")]
    PdfExtraction(String),
}

// Allows converting VaultError to a string across command/RPC boundaries.
impl serde::Serialize for VaultError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
