use std::fs;

use vault_ai_types::NoteDocument;

use crate::error::VaultError;
use crate::vault::Vault;

impl Vault {
    /// Lee una nota por su ID, la parsea y devuelve el NoteDocument.
    pub fn read_note(&self, note_id: &str) -> Result<NoteDocument, VaultError> {
        let path = self.resolve_note_id_path(note_id)?;
        if !path.exists() {
            return Err(VaultError::NoteNotFound(note_id.to_string()));
        }
        self.read_note_from_path(&path)
    }

    /// Escribe contenido a una nota existente.
    pub fn save_note(&self, note_id: &str, content: &str) -> Result<(), VaultError> {
        let path = self.resolve_note_id_path(note_id)?;
        if !path.exists() {
            return Err(VaultError::NoteNotFound(note_id.to_string()));
        }
        fs::write(&path, content)?;
        Ok(())
    }

    /// Crea una nota nueva. `relative_path` es relativo a la raíz del vault (ej: "carpeta/nota.md").
    pub fn create_note(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<NoteDocument, VaultError> {
        let path = self.resolve_note_relative_markdown_path(relative_path)?;
        if path.exists() {
            return Err(VaultError::NoteAlreadyExists(path));
        }
        // Crear directorios padre si no existen
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, content)?;
        self.read_note_from_path(&path)
    }

    /// Elimina una nota por su ID.
    pub fn delete_note(&self, note_id: &str) -> Result<(), VaultError> {
        let path = self.resolve_note_id_path(note_id)?;
        if !path.exists() {
            return Err(VaultError::NoteNotFound(note_id.to_string()));
        }
        fs::remove_file(&path)?;
        Ok(())
    }

    /// Renombra/mueve una nota a un nuevo path relativo.
    pub fn rename_note(
        &self,
        note_id: &str,
        new_relative_path: &str,
    ) -> Result<NoteDocument, VaultError> {
        let old_path = self.resolve_note_id_path(note_id)?;
        if !old_path.exists() {
            return Err(VaultError::NoteNotFound(note_id.to_string()));
        }
        let new_path = self.resolve_note_relative_markdown_path(new_relative_path)?;
        if new_path.exists() {
            return Err(VaultError::NoteAlreadyExists(new_path));
        }
        // Crear directorios padre si no existen
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&old_path, &new_path)?;

        self.read_note_from_path(&new_path)
    }
}
