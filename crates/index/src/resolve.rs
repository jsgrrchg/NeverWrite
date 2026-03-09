use vault_ai_types::NoteId;

use crate::VaultIndex;

impl VaultIndex {
    /// Resuelve un wikilink a un NoteId.
    /// `link_text`: el target del wikilink (ej: "Mi Nota" o "carpeta/nota").
    /// `from_note`: el NoteId de la nota que contiene el wikilink.
    pub fn resolve_wikilink(&self, link_text: &str, from_note: &NoteId) -> Option<NoteId> {
        let from_parent_dir = self.parent_dirs.get(from_note)?;
        self.resolve_link_target(link_text, from_parent_dir)
    }

    /// Devuelve las notas que apuntan a esta nota (backlinks).
    pub fn get_backlinks(&self, note_id: &NoteId) -> Vec<&NoteId> {
        self.backlinks
            .get(note_id)
            .map(|v| v.iter().collect())
            .unwrap_or_default()
    }

    /// Devuelve las notas a las que apunta esta nota (forward links).
    pub fn get_forward_links(&self, note_id: &NoteId) -> Vec<&NoteId> {
        self.forward_links
            .get(note_id)
            .map(|v| v.iter().collect())
            .unwrap_or_default()
    }

    /// Devuelve las notas con un tag específico.
    pub fn get_notes_by_tag(&self, tag: &str) -> Vec<&NoteId> {
        self.tags
            .get(tag)
            .map(|v| v.iter().collect())
            .unwrap_or_default()
    }
}
