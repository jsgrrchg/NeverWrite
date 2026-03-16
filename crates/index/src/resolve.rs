use std::collections::{HashSet, VecDeque};

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

    /// BFS desde `root` hasta `max_depth` hops, usando forward_links + backlinks.
    /// Devuelve (nodos visitados con su distancia, links internos al subgrafo).
    pub fn get_local_graph(
        &self,
        root: &NoteId,
        max_depth: u32,
    ) -> (Vec<(NoteId, u32)>, Vec<(NoteId, NoteId)>) {
        let mut visited: HashSet<NoteId> = HashSet::new();
        let mut queue: VecDeque<(NoteId, u32)> = VecDeque::new();
        let mut nodes: Vec<(NoteId, u32)> = Vec::new();

        if !self.metadata.contains_key(root) {
            return (nodes, Vec::new());
        }

        visited.insert(root.clone());
        queue.push_back((root.clone(), 0));

        while let Some((current, depth)) = queue.pop_front() {
            nodes.push((current.clone(), depth));

            if depth >= max_depth {
                continue;
            }

            // Expand forward links
            if let Some(targets) = self.forward_links.get(&current) {
                for target in targets {
                    if visited.insert(target.clone()) {
                        queue.push_back((target.clone(), depth + 1));
                    }
                }
            }

            // Expand backlinks (bidirectional traversal)
            if let Some(sources) = self.backlinks.get(&current) {
                for source in sources {
                    if visited.insert(source.clone()) {
                        queue.push_back((source.clone(), depth + 1));
                    }
                }
            }
        }

        // Collect links: only those where both endpoints are in the subgraph
        let mut links: Vec<(NoteId, NoteId)> = Vec::new();
        for node_id in &visited {
            if let Some(targets) = self.forward_links.get(node_id) {
                for target in targets {
                    if visited.contains(target) {
                        links.push((node_id.clone(), target.clone()));
                    }
                }
            }
        }

        (nodes, links)
    }
}
