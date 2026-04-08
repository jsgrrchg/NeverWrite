use std::collections::{HashSet, VecDeque};

use neverwrite_types::NoteId;

use crate::VaultIndex;

impl VaultIndex {
    /// Resolves a wikilink to a NoteId.
    /// `link_text`: the wikilink target (for example, "My Note" or "folder/note").
    /// `from_note`: the NoteId of the note that contains the wikilink.
    pub fn resolve_wikilink(&self, link_text: &str, from_note: &NoteId) -> Option<NoteId> {
        let from_parent_dir = self.parent_dirs.get(from_note)?;
        self.resolve_link_target(link_text, from_parent_dir)
    }

    /// Returns the notes that point to this note (backlinks).
    pub fn get_backlinks(&self, note_id: &NoteId) -> Vec<&NoteId> {
        self.backlinks
            .get(note_id)
            .map(|v| v.iter().collect())
            .unwrap_or_default()
    }

    /// Returns the notes that this note points to (forward links).
    pub fn get_forward_links(&self, note_id: &NoteId) -> Vec<&NoteId> {
        self.forward_links
            .get(note_id)
            .map(|v| v.iter().collect())
            .unwrap_or_default()
    }

    /// Returns the notes with a specific tag.
    pub fn get_notes_by_tag(&self, tag: &str) -> Vec<&NoteId> {
        self.tags
            .get(tag)
            .map(|v| v.iter().collect())
            .unwrap_or_default()
    }

    /// BFS from `root` up to `max_depth` hops, using forward_links + backlinks.
    /// Returns (visited nodes with their distance, internal links within the subgraph).
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
