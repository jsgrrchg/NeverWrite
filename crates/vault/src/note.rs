use std::fs;

use neverwrite_types::{NoteDocument, VaultEntryDto};

use crate::error::VaultError;
use crate::vault::{is_markdown_path, path_is_ignored, ScopedPathIntent, Vault};

impl Vault {
    /// Reads a note by ID, parses it, and returns the NoteDocument.
    pub fn read_note(&self, note_id: &str) -> Result<NoteDocument, VaultError> {
        let path = self.resolve_note_id_path(note_id)?;
        if !path.exists() {
            return Err(VaultError::NoteNotFound(note_id.to_string()));
        }
        self.read_note_from_path(&path)
    }

    /// Writes content to an existing note.
    pub fn save_note(&self, note_id: &str, content: &str) -> Result<(), VaultError> {
        let path = self.resolve_note_id_path(note_id)?;
        if !path.exists() {
            return Err(VaultError::NoteNotFound(note_id.to_string()));
        }
        fs::write(&path, content)?;
        Ok(())
    }

    /// Creates a new note. `relative_path` is relative to the vault root (for example, "folder/note.md").
    pub fn create_note(
        &self,
        relative_path: &str,
        content: &str,
    ) -> Result<NoteDocument, VaultError> {
        let path = self.resolve_note_relative_markdown_path(relative_path)?;
        if path.exists() {
            return Err(VaultError::NoteAlreadyExists(path));
        }
        // Create parent directories if they do not exist.
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&path, content)?;
        self.read_note_from_path(&path)
    }

    /// Deletes a note by ID.
    pub fn delete_note(&self, note_id: &str) -> Result<(), VaultError> {
        let path = self.resolve_note_id_path(note_id)?;
        if !path.exists() {
            return Err(VaultError::NoteNotFound(note_id.to_string()));
        }
        fs::remove_file(&path)?;
        Ok(())
    }

    /// Renames or moves a note to a new relative path.
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
        // Create parent directories if they do not exist.
        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&old_path, &new_path)?;

        self.read_note_from_path(&new_path)
    }

    /// Converts a markdown note into a generic vault file by moving it to a
    /// non-markdown relative path.
    pub fn convert_note_to_file(
        &self,
        note_id: &str,
        new_relative_path: &str,
    ) -> Result<VaultEntryDto, VaultError> {
        let old_path = self.resolve_note_id_path(note_id)?;
        if !old_path.exists() {
            return Err(VaultError::NoteNotFound(note_id.to_string()));
        }

        let new_path =
            self.resolve_scoped_path(new_relative_path, ScopedPathIntent::CreateTarget)?;
        if is_markdown_path(&new_path) || path_is_ignored(&self.root, &new_path) {
            return Err(VaultError::InvalidVaultPath(new_relative_path.to_string()));
        }
        if new_path.exists() {
            return Err(VaultError::EntryAlreadyExists(new_path));
        }

        if let Some(parent) = new_path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::rename(&old_path, &new_path)?;

        self.read_vault_entry_from_path(&new_path)
    }
}
