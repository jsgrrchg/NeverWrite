use std::collections::HashMap;

use vault_ai_types::{IndexedNote, NoteDocument, NoteId, NotePath};

pub struct VaultIndex {
    pub notes: HashMap<NoteId, IndexedNote>,
    pub backlinks: HashMap<NoteId, Vec<NoteId>>,
    pub forward_links: HashMap<NoteId, Vec<NoteId>>,
    pub tags: HashMap<String, Vec<NoteId>>,
    /// Mapa de nombre de archivo (sin extensión, lowercase) → lista de NoteIds.
    /// Usado para resolver wikilinks.
    pub names: HashMap<String, Vec<NoteId>>,
}

impl VaultIndex {
    /// Construye el índice completo a partir de las notas escaneadas.
    /// Usa dos pasadas: primero registra todas las notas, luego resuelve links.
    pub fn build(notes: Vec<NoteDocument>) -> Self {
        let mut index = VaultIndex {
            notes: HashMap::new(),
            backlinks: HashMap::new(),
            forward_links: HashMap::new(),
            tags: HashMap::new(),
            names: HashMap::new(),
        };

        // Pasada 1: registrar notas, names y tags
        for note in &notes {
            let note_id = note.id.clone();
            index.register_note_names(note);

            for tag in &note.tags {
                index
                    .tags
                    .entry(tag.clone())
                    .or_default()
                    .push(note_id.clone());
            }

            index.notes.insert(
                note_id,
                IndexedNote {
                    id: note.id.clone(),
                    path: note.path.clone(),
                    title: note.title.clone(),
                    tags: note.tags.clone(),
                    links: note.links.iter().map(|l| l.target.clone()).collect(),
                },
            );
        }

        // Pasada 2: resolver links y construir backlinks/forward_links
        for note in &notes {
            let note_id = &note.id;
            let mut resolved_targets = Vec::new();

            for link in &note.links {
                if let Some(target_id) = index.resolve_link_target(&link.target, &note.path) {
                    resolved_targets.push(target_id.clone());
                    index
                        .backlinks
                        .entry(target_id)
                        .or_default()
                        .push(note_id.clone());
                }
            }

            index
                .forward_links
                .insert(note_id.clone(), resolved_targets);
        }

        index
    }

    /// Reindexar una nota (tras edición o cambio externo).
    /// Primero elimina la nota vieja del índice, luego la agrega de nuevo.
    pub fn reindex_note(&mut self, note: NoteDocument) {
        self.remove_note(&note.id);
        self.add_note(note);
    }

    /// Elimina una nota del índice.
    pub fn remove_note(&mut self, note_id: &NoteId) {
        // Remover forward links y los backlinks correspondientes
        if let Some(targets) = self.forward_links.remove(note_id) {
            for target_id in &targets {
                if let Some(bl) = self.backlinks.get_mut(target_id) {
                    bl.retain(|id| id != note_id);
                }
            }
        }

        // Remover backlinks que apuntan a esta nota desde otras
        self.backlinks.remove(note_id);

        // Remover de tags
        for tag_notes in self.tags.values_mut() {
            tag_notes.retain(|id| id != note_id);
        }
        self.tags.retain(|_, v| !v.is_empty());

        // Remover de names
        for name_notes in self.names.values_mut() {
            name_notes.retain(|id| id != note_id);
        }
        self.names.retain(|_, v| !v.is_empty());

        // Remover la nota
        self.notes.remove(note_id);
    }

    fn add_note(&mut self, note: NoteDocument) {
        let note_id = note.id.clone();
        let link_targets: Vec<String> = note.links.iter().map(|l| l.target.clone()).collect();

        self.register_note_names(&note);

        // Registrar tags
        for tag in &note.tags {
            self.tags
                .entry(tag.clone())
                .or_default()
                .push(note_id.clone());
        }

        // Resolver forward links y construir backlinks
        let mut resolved_targets = Vec::new();
        for link_text in &link_targets {
            if let Some(target_id) = self.resolve_link_target(link_text, &note.path) {
                resolved_targets.push(target_id.clone());
                self.backlinks
                    .entry(target_id)
                    .or_default()
                    .push(note_id.clone());
            }
        }
        self.forward_links.insert(note_id.clone(), resolved_targets);

        // Guardar nota indexada
        self.notes.insert(
            note_id,
            IndexedNote {
                id: note.id,
                path: note.path,
                title: note.title,
                tags: note.tags,
                links: link_targets,
            },
        );
    }

    /// Resuelve el target de un wikilink a un NoteId.
    pub(crate) fn resolve_link_target(
        &self,
        link_text: &str,
        from_path: &NotePath,
    ) -> Option<NoteId> {
        let normalized_links = normalize_link_target_variants(link_text);

        for normalized_link in &normalized_links {
            // Si el link tiene path (contiene /), intentar match exacto por id
            if normalized_link.contains('/') {
                let target_id = NoteId(normalized_link.clone());
                if self.notes.contains_key(&target_id) {
                    return Some(target_id);
                }
                // También buscar como sufijo de path
                for (id, _note) in &self.notes {
                    if id.0.to_lowercase().ends_with(normalized_link.as_str()) {
                        return Some(id.clone());
                    }
                }
                continue;
            }

            let Some(candidates) = self.names.get(normalized_link.as_str()) else {
                continue;
            };

            if candidates.len() == 1 {
                return Some(candidates[0].clone());
            }

            if let Some(id) = self.closest_by_path(candidates, from_path) {
                return Some(id);
            }
        }

        for normalized_link in &normalized_links {
            if let Some(id) = self.resolve_unique_prefix_match(normalized_link) {
                return Some(id);
            }
        }

        None
    }

    /// Elige el candidato más cercano al path de origen.
    fn closest_by_path(&self, candidates: &[NoteId], from_path: &NotePath) -> Option<NoteId> {
        let from_dir = from_path.0.parent()?;

        candidates
            .iter()
            .filter_map(|id| {
                let note = self.notes.get(id)?;
                let distance = path_distance(from_dir, &note.path.0);
                Some((id.clone(), distance))
            })
            .min_by_key(|(_, dist)| *dist)
            .map(|(id, _)| id)
    }

    fn register_note_names(&mut self, note: &NoteDocument) {
        let note_id = note.id.clone();

        let aliases = [
            note.path
                .0
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string),
            Some(note.title.clone()),
            Some(note.id.0.clone()),
            note.id.0.split('/').next_back().map(str::to_string),
        ];

        for alias in aliases.into_iter().flatten() {
            for normalized in normalize_note_alias_variants(&alias) {
                let entry = self.names.entry(normalized).or_default();
                if !entry.contains(&note_id) {
                    entry.push(note_id.clone());
                }
            }
        }
    }

    fn resolve_unique_prefix_match(&self, normalized_link: &str) -> Option<NoteId> {
        if !is_strong_prefix_candidate(normalized_link) {
            return None;
        }

        let mut matches = Vec::new();

        for note in self.notes.values() {
            let aliases = [
                Some(note.title.as_str()),
                note.path.0.file_stem().and_then(|s| s.to_str()),
                note.id.0.split('/').next_back(),
            ];

            let matched = aliases
                .into_iter()
                .flatten()
                .map(normalize_alias)
                .any(|alias| is_prefix_expansion(&alias, normalized_link));

            if matched {
                if matches.iter().any(|id: &NoteId| id == &note.id) {
                    continue;
                }
                matches.push(note.id.clone());
                if matches.len() > 1 {
                    return None;
                }
            }
        }

        matches.into_iter().next()
    }
}

fn normalize_alias(value: &str) -> String {
    let normalized_chars = value
        .trim()
        .chars()
        .map(normalize_char)
        .collect::<String>()
        .to_lowercase();

    normalized_chars
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_link_target(value: &str) -> String {
    let trimmed = value.trim();
    let without_subpath = trimmed.split(['#', '^']).next().unwrap_or(trimmed).trim();
    let without_ext = without_subpath
        .strip_suffix(".md")
        .or_else(|| without_subpath.strip_suffix(".MD"))
        .unwrap_or(without_subpath);
    normalize_alias(without_ext)
}

fn normalize_link_target_variants(value: &str) -> Vec<String> {
    let normalized = normalize_link_target(value);
    if normalized.is_empty() {
        return Vec::new();
    }

    let trimmed = trim_terminal_punctuation(&normalized);
    if trimmed != normalized {
        vec![normalized, trimmed]
    } else {
        vec![normalized]
    }
}

fn normalize_note_alias_variants(value: &str) -> Vec<String> {
    let normalized = normalize_alias(value);
    if normalized.is_empty() {
        return Vec::new();
    }

    let trimmed = trim_terminal_punctuation(&normalized);
    if trimmed != normalized {
        vec![normalized, trimmed]
    } else {
        vec![normalized]
    }
}

fn trim_terminal_punctuation(value: &str) -> String {
    value
        .trim_end_matches(['.', ',', '!', '?', ';', ':'])
        .trim_end()
        .to_string()
}

fn is_strong_prefix_candidate(value: &str) -> bool {
    value.chars().count() >= 24 && value.split_whitespace().count() >= 4
}

fn is_prefix_expansion(candidate: &str, target: &str) -> bool {
    if candidate == target || !candidate.starts_with(target) {
        return false;
    }

    matches!(
        candidate[target.len()..].chars().next(),
        Some(' ' | '-' | ':' | '(' | '[' | '"')
    )
}

fn normalize_char(ch: char) -> char {
    match ch {
        '’' | '‘' => '\'',
        '“' | '”' => '"',
        '…' => '.',
        'á' | 'à' | 'ä' | 'â' | 'ã' | 'å' | 'Á' | 'À' | 'Ä' | 'Â' | 'Ã' | 'Å' => 'a',
        'é' | 'è' | 'ë' | 'ê' | 'É' | 'È' | 'Ë' | 'Ê' => 'e',
        'í' | 'ì' | 'ï' | 'î' | 'Í' | 'Ì' | 'Ï' | 'Î' => 'i',
        'ó' | 'ò' | 'ö' | 'ô' | 'õ' | 'Ó' | 'Ò' | 'Ö' | 'Ô' | 'Õ' => 'o',
        'ú' | 'ù' | 'ü' | 'û' | 'Ú' | 'Ù' | 'Ü' | 'Û' => 'u',
        'ñ' | 'Ñ' => 'n',
        'ç' | 'Ç' => 'c',
        _ => ch,
    }
}

/// Calcula la "distancia" entre dos paths contando componentes diferentes.
fn path_distance(from_dir: &std::path::Path, to_path: &std::path::Path) -> usize {
    let to_dir = to_path.parent().unwrap_or(to_path);

    let from_parts: Vec<_> = from_dir.components().collect();
    let to_parts: Vec<_> = to_dir.components().collect();

    // Encontrar el prefijo común
    let common = from_parts
        .iter()
        .zip(to_parts.iter())
        .take_while(|(a, b)| a == b)
        .count();

    // Distancia = subidas desde from + bajadas hacia to
    (from_parts.len() - common) + (to_parts.len() - common)
}
