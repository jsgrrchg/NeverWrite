use std::fs;

use vault_ai_types::NoteDocument;

use crate::error::VaultError;
use crate::parser;
use crate::vault::Vault;

impl Vault {
    /// Lee una nota por su ID, la parsea y devuelve el NoteDocument.
    pub fn read_note(&self, note_id: &str) -> Result<NoteDocument, VaultError> {
        let path = self.id_to_path(note_id);
        if !path.exists() {
            return Err(VaultError::NoteNotFound(note_id.to_string()));
        }
        let content = fs::read_to_string(&path)?;
        Ok(parser::parse_note(note_id, &path, &content))
    }

    /// Escribe contenido a una nota existente.
    pub fn save_note(&self, note_id: &str, content: &str) -> Result<(), VaultError> {
        let path = self.id_to_path(note_id);
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
        let path = self.root.join(relative_path);
        if path.exists() {
            return Err(VaultError::NoteAlreadyExists(path));
        }
        // Crear directorios padre si no existen
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, content)?;
        let id = self.path_to_id(&path);
        Ok(parser::parse_note(&id, &path, content))
    }

    /// Elimina una nota por su ID.
    pub fn delete_note(&self, note_id: &str) -> Result<(), VaultError> {
        let path = self.id_to_path(note_id);
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
        let old_path = self.id_to_path(note_id);
        if !old_path.exists() {
            return Err(VaultError::NoteNotFound(note_id.to_string()));
        }
        let new_path = self.root.join(new_relative_path);
        if new_path.exists() {
            return Err(VaultError::NoteAlreadyExists(new_path));
        }
        // Crear directorios padre si no existen
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&old_path, &new_path)?;

        let content = fs::read_to_string(&new_path)?;
        let new_id = self.path_to_id(&new_path);
        Ok(parser::parse_note(&new_id, &new_path, &content))
    }
}
