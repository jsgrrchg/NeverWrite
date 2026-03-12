use std::collections::{HashMap, HashSet};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc, Mutex,
};
use std::thread;

use vault_ai_types::{IndexedNote, NoteDocument, NoteId, NoteMetadata, PdfDocument, PdfMetadata};

const PROGRESS_REPORT_EVERY: usize = 256;
const MAX_SUGGESTION_PREFIX_CHARS: usize = 64;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SearchEntry {
    pub title_lower: String,
    pub path_lower: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum UniqueNoteMatch {
    Unique(NoteId),
    Ambiguous,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VaultIndex {
    pub metadata: HashMap<NoteId, NoteMetadata>,
    pub notes: HashMap<NoteId, IndexedNote>,
    pub backlinks: HashMap<NoteId, Vec<NoteId>>,
    pub forward_links: HashMap<NoteId, Vec<NoteId>>,
    pub tags: HashMap<String, Vec<NoteId>>,
    pub names: HashMap<String, Vec<NoteId>>,
    pub path_suffixes: HashMap<String, Vec<NoteId>>,
    pub exact_ids: HashMap<String, NoteId>,
    pub exact_titles: HashMap<String, UniqueNoteMatch>,
    pub exact_filenames: HashMap<String, UniqueNoteMatch>,
    pub parent_dirs: HashMap<NoteId, String>,
    pub search_index: HashMap<NoteId, SearchEntry>,
    pub suggestion_prefixes: HashMap<String, Vec<NoteId>>,
    pub suggestion_order: Vec<NoteId>,
    #[serde(default)]
    pub pdf_metadata: HashMap<NoteId, PdfMetadata>,
    #[serde(default)]
    pub pdf_search_index: HashMap<NoteId, SearchEntry>,
}

impl VaultIndex {
    pub fn build(notes: Vec<NoteDocument>) -> Self {
        Self::build_with_progress(notes, |_| {})
    }

    pub fn build_with_progress(
        notes: Vec<NoteDocument>,
        mut on_progress: impl FnMut(IndexBuildProgress),
    ) -> Self {
        let prepared_notes: Vec<PreparedNote> =
            notes.into_iter().map(PreparedNote::from_note).collect();
        let note_count = prepared_notes.len();

        let mut index = VaultIndex {
            metadata: HashMap::with_capacity(note_count),
            notes: HashMap::with_capacity(note_count),
            backlinks: HashMap::with_capacity(note_count),
            forward_links: HashMap::with_capacity(note_count),
            tags: HashMap::new(),
            names: HashMap::new(),
            path_suffixes: HashMap::new(),
            exact_ids: HashMap::with_capacity(note_count),
            exact_titles: HashMap::with_capacity(note_count),
            exact_filenames: HashMap::with_capacity(note_count),
            parent_dirs: HashMap::with_capacity(note_count),
            search_index: HashMap::with_capacity(note_count),
            suggestion_prefixes: HashMap::new(),
            suggestion_order: Vec::with_capacity(note_count),
            pdf_metadata: HashMap::new(),
            pdf_search_index: HashMap::new(),
        };

        let total_notes = prepared_notes.len();
        for (current, note) in prepared_notes.iter().enumerate() {
            index.register_note(note);
            on_progress(IndexBuildProgress {
                phase: IndexBuildPhase::RegisteringNotes,
                current: current + 1,
                total: total_notes.max(1),
            });
        }

        index.finalize_suggestion_order();

        let total_links = prepared_notes
            .iter()
            .map(|note| note.prepared_links.len())
            .sum::<usize>()
            .max(1);

        index.resolve_links_parallel(&prepared_notes, total_links, &mut on_progress);
        index
    }

    pub fn reindex_note(&mut self, note: NoteDocument) {
        self.remove_note(&note.id);
        self.add_note(note);
    }

    pub fn remove_note(&mut self, note_id: &NoteId) {
        if let Some(targets) = self.forward_links.remove(note_id) {
            for target_id in &targets {
                if let Some(backlinks) = self.backlinks.get_mut(target_id) {
                    backlinks.retain(|id| id != note_id);
                }
            }
        }

        self.backlinks.remove(note_id);

        let metadata = self.metadata.get(note_id).cloned();
        let indexed_note = self.notes.get(note_id).cloned();

        if let Some(note) = indexed_note.as_ref() {
            for tag in &note.tags {
                remove_note_id_from_map_list(&mut self.tags, tag, note_id);
            }
        }

        if let Some(note_metadata) = metadata.as_ref() {
            self.unregister_note_names(note_metadata, note_id);
            self.unregister_path_suffixes(note_metadata, note_id);
            self.unregister_exact_matches(note_metadata, note_id);
            self.unregister_suggestion_prefixes(note_metadata, note_id);
        }

        self.parent_dirs.remove(note_id);
        self.search_index.remove(note_id);
        self.suggestion_order.retain(|id| id != note_id);
        self.metadata.remove(note_id);
        self.notes.remove(note_id);
    }

    pub fn register_pdf(
        &mut self,
        doc: &PdfDocument,
        modified_at: u64,
        created_at: u64,
        size: u64,
    ) {
        let id = doc.id.clone();
        self.pdf_search_index.insert(
            id.clone(),
            SearchEntry {
                title_lower: doc.title.to_lowercase(),
                path_lower: id.0.to_lowercase(),
            },
        );
        self.pdf_metadata.insert(
            id,
            PdfMetadata {
                id: doc.id.clone(),
                path: doc.path.clone(),
                title: doc.title.clone(),
                page_count: doc.page_count,
                modified_at,
                created_at,
                size,
            },
        );
    }

    pub fn remove_pdf(&mut self, pdf_id: &NoteId) {
        self.pdf_metadata.remove(pdf_id);
        self.pdf_search_index.remove(pdf_id);
    }

    pub fn reindex_pdf(&mut self, doc: &PdfDocument, modified_at: u64, created_at: u64, size: u64) {
        self.remove_pdf(&doc.id);
        self.register_pdf(doc, modified_at, created_at, size);
    }

    pub fn get_note_metadata(&self, note_id: &NoteId) -> Option<&NoteMetadata> {
        self.metadata.get(note_id)
    }

    pub(crate) fn resolve_link_target(
        &self,
        link_text: &str,
        from_parent_dir: &str,
    ) -> Option<NoteId> {
        let prepared_link = PreparedLink::from_raw(link_text);
        self.resolve_prepared_link_in_index(&prepared_link, from_parent_dir)
    }

    fn add_note(&mut self, note: NoteDocument) {
        let prepared = PreparedNote::from_note(note);
        let note_id = prepared.id.clone();

        self.register_note(&prepared);
        self.insert_suggestion_sorted(&note_id);

        let mut resolved_targets = Vec::new();
        for link in &prepared.prepared_links {
            if let Some(target_id) = self.resolve_prepared_link_in_index(link, &prepared.parent_dir)
            {
                resolved_targets.push(target_id.clone());
                self.backlinks
                    .entry(target_id)
                    .or_default()
                    .push(note_id.clone());
            }
        }

        self.forward_links.insert(note_id, resolved_targets);
    }

    fn register_note(&mut self, note: &PreparedNote) {
        self.register_note_names(note);
        self.register_path_suffixes(note);
        self.register_exact_matches(note);
        self.register_metadata(note);
        self.register_suggestion_prefixes(note);
        self.register_suggestion_order(&note.id);

        for tag in &note.tags {
            self.tags
                .entry(tag.clone())
                .or_default()
                .push(note.id.clone());
        }

        self.notes.insert(
            note.id.clone(),
            IndexedNote {
                tags: note.tags.clone(),
                links: note.raw_links.clone(),
            },
        );
    }

    fn resolve_links_parallel(
        &mut self,
        prepared_notes: &[PreparedNote],
        total_links: usize,
        on_progress: &mut impl FnMut(IndexBuildProgress),
    ) {
        if prepared_notes.is_empty() {
            on_progress(IndexBuildProgress {
                phase: IndexBuildPhase::ResolvingLinks,
                current: total_links,
                total: total_links,
            });
            return;
        }

        let worker_count = thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(4)
            .min(prepared_notes.len().max(1));
        let chunk_size = prepared_notes.len().div_ceil(worker_count);
        let chunk_count = prepared_notes.chunks(chunk_size).len();

        let (tx, rx) = mpsc::channel::<WorkerMessage>();
        let cache = Arc::new(Mutex::new(HashMap::<ResolveCacheKey, Option<NoteId>>::new()));
        let progress = Arc::new(AtomicUsize::new(0));
        let resolver = Arc::new(self.resolver_context());

        thread::scope(|scope| {
            for chunk in prepared_notes.chunks(chunk_size) {
                let tx = tx.clone();
                let cache = Arc::clone(&cache);
                let progress = Arc::clone(&progress);
                let resolver = Arc::clone(&resolver);

                scope.spawn(move || {
                    let mut forward_links = Vec::with_capacity(chunk.len());
                    let mut backlinks = Vec::new();
                    let mut pending_progress = 0_usize;

                    for note in chunk {
                        let mut resolved_targets = Vec::new();

                        for link in &note.prepared_links {
                            if let Some(target_id) =
                                resolver.resolve_prepared_link(link, &note.parent_dir, Some(&cache))
                            {
                                resolved_targets.push(target_id.clone());
                                backlinks.push((target_id, note.id.clone()));
                            }

                            pending_progress += 1;
                            if pending_progress >= PROGRESS_REPORT_EVERY {
                                let current = progress
                                    .fetch_add(pending_progress, Ordering::Relaxed)
                                    + pending_progress;
                                let _ = tx.send(WorkerMessage::Progress(current));
                                pending_progress = 0;
                            }
                        }

                        forward_links.push((note.id.clone(), resolved_targets));
                    }

                    if pending_progress > 0 {
                        let current = progress.fetch_add(pending_progress, Ordering::Relaxed)
                            + pending_progress;
                        let _ = tx.send(WorkerMessage::Progress(current));
                    }

                    let _ = tx.send(WorkerMessage::Chunk(ResolvedChunk {
                        forward_links,
                        backlinks,
                    }));
                });
            }

            drop(tx);

            let mut received_chunks = 0_usize;
            while received_chunks < chunk_count {
                match rx.recv() {
                    Ok(WorkerMessage::Progress(current)) => on_progress(IndexBuildProgress {
                        phase: IndexBuildPhase::ResolvingLinks,
                        current,
                        total: total_links,
                    }),
                    Ok(WorkerMessage::Chunk(chunk)) => {
                        for (note_id, targets) in chunk.forward_links {
                            self.forward_links.insert(note_id, targets);
                        }

                        for (target_id, source_id) in chunk.backlinks {
                            self.backlinks.entry(target_id).or_default().push(source_id);
                        }

                        received_chunks += 1;
                    }
                    Err(_) => break,
                }
            }
        });

        on_progress(IndexBuildProgress {
            phase: IndexBuildPhase::ResolvingLinks,
            current: total_links,
            total: total_links,
        });
    }

    fn register_note_names(&mut self, note: &PreparedNote) {
        let mut seen_aliases = HashSet::new();

        for alias in note_alias_values(&note.title, &note.id.0, &note.filename) {
            for normalized in normalize_note_alias_variants(&alias) {
                if seen_aliases.insert(normalized.clone()) {
                    self.names
                        .entry(normalized)
                        .or_default()
                        .push(note.id.clone());
                }
            }
        }
    }

    fn register_path_suffixes(&mut self, note: &PreparedNote) {
        let parts: Vec<&str> = note.normalized_id.split('/').collect();
        for start in 0..parts.len() {
            let suffix = parts[start..].join("/");
            self.path_suffixes
                .entry(suffix)
                .or_default()
                .push(note.id.clone());
        }
    }

    fn register_exact_matches(&mut self, note: &PreparedNote) {
        self.exact_ids
            .insert(note.normalized_id.clone(), note.id.clone());
        record_unique_match(
            &mut self.exact_titles,
            &note.normalized_title,
            note.id.clone(),
        );
        record_unique_match(
            &mut self.exact_filenames,
            &note.normalized_filename,
            note.id.clone(),
        );
    }

    fn register_metadata(&mut self, note: &PreparedNote) {
        self.parent_dirs
            .insert(note.id.clone(), note.parent_dir.clone());

        self.search_index.insert(
            note.id.clone(),
            SearchEntry {
                title_lower: note.title.to_lowercase(),
                path_lower: note.id.0.to_lowercase(),
            },
        );

        self.metadata.insert(
            note.id.clone(),
            NoteMetadata {
                id: note.id.clone(),
                path: note.path.clone(),
                title: note.title.clone(),
                modified_at: note.modified_at,
                created_at: note.created_at,
                size: note.size,
            },
        );
    }

    fn register_suggestion_prefixes(&mut self, note: &PreparedNote) {
        let mut seen_prefixes = HashSet::new();

        for alias in note_alias_values(&note.title, &note.id.0, &note.filename) {
            for normalized in normalize_note_alias_variants(&alias) {
                for prefix in suggestion_prefix_keys(&normalized) {
                    if !seen_prefixes.insert(prefix.clone()) {
                        continue;
                    }
                    self.suggestion_prefixes
                        .entry(prefix)
                        .or_default()
                        .push(note.id.clone());
                }
            }
        }
    }

    fn register_suggestion_order(&mut self, note_id: &NoteId) {
        if !self.suggestion_order.contains(note_id) {
            self.suggestion_order.push(note_id.clone());
        }
    }

    fn insert_suggestion_sorted(&mut self, note_id: &NoteId) {
        let sort_key = self
            .metadata
            .get(note_id)
            .map(suggestion_sort_key)
            .unwrap_or_default();

        let pos = self
            .suggestion_order
            .binary_search_by(|existing| {
                self.metadata
                    .get(existing)
                    .map(suggestion_sort_key)
                    .unwrap_or_default()
                    .cmp(&sort_key)
            })
            .unwrap_or_else(|pos| pos);

        // register_suggestion_order already pushed it; remove the tail entry
        // and insert at the sorted position instead.
        if let Some(tail_pos) = self.suggestion_order.iter().rposition(|id| id == note_id) {
            self.suggestion_order.remove(tail_pos);
        }
        self.suggestion_order
            .insert(pos.min(self.suggestion_order.len()), note_id.clone());
    }

    fn finalize_suggestion_order(&mut self) {
        self.suggestion_order.sort_by(|left, right| {
            let left_key = self
                .metadata
                .get(left)
                .map(suggestion_sort_key)
                .unwrap_or_default();
            let right_key = self
                .metadata
                .get(right)
                .map(suggestion_sort_key)
                .unwrap_or_default();
            left_key.cmp(&right_key)
        });
    }

    fn unregister_note_names(&mut self, note: &NoteMetadata, note_id: &NoteId) {
        for alias in note_alias_keys(note) {
            remove_note_id_from_map_list(&mut self.names, &alias, note_id);
        }
    }

    fn unregister_path_suffixes(&mut self, note: &NoteMetadata, note_id: &NoteId) {
        for suffix in note_path_suffix_keys(note) {
            remove_note_id_from_map_list(&mut self.path_suffixes, &suffix, note_id);
        }
    }

    fn unregister_exact_matches(&mut self, note: &NoteMetadata, note_id: &NoteId) {
        self.exact_ids.remove(&normalize_alias(&note.id.0));
        self.recompute_unique_title_match(&normalize_alias(&note.title), note_id);
        self.recompute_unique_filename_match(&normalized_filename(note), note_id);
    }

    fn unregister_suggestion_prefixes(&mut self, note: &NoteMetadata, note_id: &NoteId) {
        let mut seen_prefixes = HashSet::new();
        for alias in note_alias_keys(note) {
            for prefix in suggestion_prefix_keys(&alias) {
                if !seen_prefixes.insert(prefix.clone()) {
                    continue;
                }
                remove_note_id_from_map_list(&mut self.suggestion_prefixes, &prefix, note_id);
            }
        }
    }

    pub fn suggest_wikilinks(&self, query: &str, from_note: &NoteId, limit: usize) -> Vec<NoteId> {
        if limit == 0 {
            return Vec::new();
        }

        let normalized_query = normalize_link_target(query);
        let from_parent_dir = self
            .parent_dirs
            .get(from_note)
            .map(String::as_str)
            .unwrap_or_default();

        let candidates: Vec<NoteId> = if normalized_query.is_empty() {
            self.suggestion_order
                .iter()
                .take(limit.saturating_mul(4))
                .cloned()
                .collect()
        } else {
            self.suggestion_prefixes
                .get(suggestion_lookup_key(&normalized_query))
                .cloned()
                .unwrap_or_default()
        };

        let mut ranked: Vec<(u8, usize, String, NoteId)> = candidates
            .into_iter()
            .filter_map(|note_id| {
                let metadata = self.metadata.get(&note_id)?;
                let insert_text = suggestion_insert_text(metadata);
                let normalized_title = normalize_alias(&insert_text);
                let normalized_basename = metadata
                    .id
                    .0
                    .split('/')
                    .next_back()
                    .map(normalize_alias)
                    .unwrap_or_default();
                let normalized_id = normalize_alias(&metadata.id.0);
                let rank = if normalized_query.is_empty() {
                    100
                } else if normalized_title.starts_with(&normalized_query) {
                    0
                } else if normalized_basename.starts_with(&normalized_query) {
                    1
                } else if normalized_id.starts_with(&normalized_query) {
                    2
                } else if normalized_title.contains(&normalized_query) {
                    3
                } else if normalized_basename.contains(&normalized_query) {
                    4
                } else if normalized_id.contains(&normalized_query) {
                    5
                } else {
                    return None;
                };

                let target_parent_dir = self
                    .parent_dirs
                    .get(&note_id)
                    .map(String::as_str)
                    .unwrap_or_default();

                Some((
                    rank,
                    path_distance(from_parent_dir, target_parent_dir),
                    suggestion_sort_key(metadata),
                    note_id,
                ))
            })
            .collect();

        ranked.sort_by(|left, right| {
            left.0
                .cmp(&right.0)
                .then(left.1.cmp(&right.1))
                .then(left.2.cmp(&right.2))
        });
        ranked.dedup_by(|left, right| left.3 == right.3);

        ranked
            .into_iter()
            .take(limit)
            .map(|(_, _, _, note_id)| note_id)
            .collect()
    }

    fn recompute_unique_title_match(&mut self, normalized_title: &str, removed_note_id: &NoteId) {
        let next_match =
            compute_unique_match_entry(&self.metadata, normalized_title, removed_note_id, |note| {
                normalize_alias(&note.title)
            });

        match next_match {
            Some(value) => {
                self.exact_titles
                    .insert(normalized_title.to_string(), value);
            }
            None => {
                self.exact_titles.remove(normalized_title);
            }
        }
    }

    fn recompute_unique_filename_match(
        &mut self,
        normalized_filename_key: &str,
        removed_note_id: &NoteId,
    ) {
        let next_match = compute_unique_match_entry(
            &self.metadata,
            normalized_filename_key,
            removed_note_id,
            normalized_filename,
        );

        match next_match {
            Some(value) => {
                self.exact_filenames
                    .insert(normalized_filename_key.to_string(), value);
            }
            None => {
                self.exact_filenames.remove(normalized_filename_key);
            }
        }
    }

    fn resolve_prepared_link_in_index(
        &self,
        link: &PreparedLink,
        from_parent_dir: &str,
    ) -> Option<NoteId> {
        for normalized_link in &link.normalized_variants {
            if link.is_path_like {
                if let Some(id) = self.exact_ids.get(normalized_link) {
                    return Some(id.clone());
                }

                if let Some(candidates) = self.path_suffixes.get(normalized_link) {
                    if candidates.len() == 1 {
                        return Some(candidates[0].clone());
                    }
                    if let Some(id) =
                        self.closest_by_parent_dir_in_index(candidates, from_parent_dir)
                    {
                        return Some(id);
                    }
                }
                continue;
            }

            if let Some(id) =
                self.resolve_unique_match_in_index(&self.exact_titles, normalized_link)
            {
                return Some(id);
            }

            if let Some(id) =
                self.resolve_unique_match_in_index(&self.exact_filenames, normalized_link)
            {
                return Some(id);
            }

            let Some(candidates) = self.names.get(normalized_link.as_str()) else {
                continue;
            };

            if candidates.len() == 1 {
                return Some(candidates[0].clone());
            }

            if let Some(id) = self.closest_by_parent_dir_in_index(candidates, from_parent_dir) {
                return Some(id);
            }
        }

        for normalized_link in &link.strong_prefix_variants {
            if let Some(id) = self.resolve_unique_prefix_match_in_index(normalized_link) {
                return Some(id);
            }
        }

        None
    }

    fn resolve_unique_match_in_index(
        &self,
        map: &HashMap<String, UniqueNoteMatch>,
        key: &str,
    ) -> Option<NoteId> {
        match map.get(key) {
            Some(UniqueNoteMatch::Unique(id)) => Some(id.clone()),
            _ => None,
        }
    }

    fn closest_by_parent_dir_in_index(
        &self,
        candidates: &[NoteId],
        from_parent_dir: &str,
    ) -> Option<NoteId> {
        candidates
            .iter()
            .filter_map(|id| {
                let target_parent_dir = self.parent_dirs.get(id)?;
                Some((
                    id.clone(),
                    path_distance(from_parent_dir, target_parent_dir),
                ))
            })
            .min_by_key(|(_, distance)| *distance)
            .map(|(id, _)| id)
    }

    fn resolve_unique_prefix_match_in_index(&self, normalized_link: &str) -> Option<NoteId> {
        if !is_strong_prefix_candidate(normalized_link) {
            return None;
        }

        let mut matches = Vec::new();

        for note in self.metadata.values() {
            let aliases = [
                normalize_alias(&note.title),
                normalized_filename(note),
                normalize_alias(note.id.0.split('/').next_back().unwrap_or_default()),
            ];

            if !aliases
                .iter()
                .filter(|alias| !alias.is_empty())
                .any(|alias| is_prefix_expansion(alias, normalized_link))
            {
                continue;
            }

            matches.push(note.id.clone());
            if matches.len() > 1 {
                return None;
            }
        }

        matches.into_iter().next()
    }

    fn resolver_context(&self) -> ResolverContext {
        let prefix_entries = self
            .metadata
            .values()
            .map(|note| PrefixEntry {
                note_id: note.id.clone(),
                aliases: [
                    Some(normalize_alias(&note.title)),
                    note.path
                        .0
                        .file_stem()
                        .and_then(|stem| stem.to_str())
                        .map(normalize_alias),
                    note.id.0.split('/').next_back().map(normalize_alias),
                ]
                .into_iter()
                .flatten()
                .filter(|alias| !alias.is_empty())
                .collect(),
            })
            .collect();

        ResolverContext {
            names: self.names.clone(),
            path_suffixes: self.path_suffixes.clone(),
            exact_ids: self.exact_ids.clone(),
            exact_titles: self.exact_titles.clone(),
            exact_filenames: self.exact_filenames.clone(),
            parent_dirs: self.parent_dirs.clone(),
            prefix_entries,
        }
    }
}

#[derive(Clone, Copy)]
pub enum IndexBuildPhase {
    RegisteringNotes,
    ResolvingLinks,
}

pub struct IndexBuildProgress {
    pub phase: IndexBuildPhase,
    pub current: usize,
    pub total: usize,
}

struct PreparedNote {
    id: NoteId,
    path: vault_ai_types::NotePath,
    title: String,
    filename: String,
    tags: Vec<String>,
    raw_links: Vec<String>,
    prepared_links: Vec<PreparedLink>,
    normalized_id: String,
    normalized_title: String,
    normalized_filename: String,
    parent_dir: String,
    modified_at: u64,
    created_at: u64,
    size: u64,
}

impl PreparedNote {
    fn from_note(note: NoteDocument) -> Self {
        let raw_links: Vec<String> = note.links.iter().map(|link| link.target.clone()).collect();
        let prepared_links = raw_links
            .iter()
            .map(|target| PreparedLink::from_raw(target))
            .collect();
        let filename = note
            .path
            .0
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or_default()
            .to_string();
        let (modified_at, created_at, size) = read_note_file_stats(&note.path.0);

        Self {
            normalized_id: normalize_alias(&note.id.0),
            normalized_title: normalize_alias(&note.title),
            normalized_filename: normalize_alias(&filename),
            parent_dir: parent_dir_from_note_id(&note.id),
            id: note.id,
            path: note.path,
            title: note.title,
            filename,
            tags: note.tags,
            raw_links,
            prepared_links,
            modified_at,
            created_at,
            size,
        }
    }
}

#[derive(Clone)]
struct PreparedLink {
    normalized_variants: Vec<String>,
    strong_prefix_variants: Vec<String>,
    cache_key: String,
    is_path_like: bool,
}

impl PreparedLink {
    fn from_raw(target: &str) -> Self {
        let normalized_variants = normalize_link_target_variants(target);
        let cache_key = normalized_variants
            .first()
            .cloned()
            .unwrap_or_else(|| normalize_link_target(target));
        let strong_prefix_variants = normalized_variants
            .iter()
            .filter(|variant| is_strong_prefix_candidate(variant))
            .cloned()
            .collect();
        let is_path_like = normalized_variants
            .iter()
            .any(|variant| variant.contains('/'));

        Self {
            normalized_variants,
            strong_prefix_variants,
            cache_key,
            is_path_like,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Hash)]
struct ResolveCacheKey {
    target: String,
    from_parent_dir: String,
}

struct ResolvedChunk {
    forward_links: Vec<(NoteId, Vec<NoteId>)>,
    backlinks: Vec<(NoteId, NoteId)>,
}

enum WorkerMessage {
    Progress(usize),
    Chunk(ResolvedChunk),
}

struct ResolverContext {
    names: HashMap<String, Vec<NoteId>>,
    path_suffixes: HashMap<String, Vec<NoteId>>,
    exact_ids: HashMap<String, NoteId>,
    exact_titles: HashMap<String, UniqueNoteMatch>,
    exact_filenames: HashMap<String, UniqueNoteMatch>,
    parent_dirs: HashMap<NoteId, String>,
    prefix_entries: Vec<PrefixEntry>,
}

struct PrefixEntry {
    note_id: NoteId,
    aliases: Vec<String>,
}

impl ResolverContext {
    fn resolve_prepared_link(
        &self,
        link: &PreparedLink,
        from_parent_dir: &str,
        cache: Option<&Arc<Mutex<HashMap<ResolveCacheKey, Option<NoteId>>>>>,
    ) -> Option<NoteId> {
        if let Some(cache) = cache {
            let key = ResolveCacheKey {
                target: link.cache_key.clone(),
                from_parent_dir: from_parent_dir.to_string(),
            };

            if let Some(cached) = cache.lock().ok().and_then(|guard| guard.get(&key).cloned()) {
                return cached;
            }

            let resolved = self.resolve_prepared_link_uncached(link, from_parent_dir);
            if let Ok(mut guard) = cache.lock() {
                guard.insert(key, resolved.clone());
            }
            return resolved;
        }

        self.resolve_prepared_link_uncached(link, from_parent_dir)
    }

    fn resolve_prepared_link_uncached(
        &self,
        link: &PreparedLink,
        from_parent_dir: &str,
    ) -> Option<NoteId> {
        for normalized_link in &link.normalized_variants {
            if link.is_path_like {
                if let Some(id) = self.exact_ids.get(normalized_link) {
                    return Some(id.clone());
                }

                if let Some(candidates) = self.path_suffixes.get(normalized_link) {
                    if candidates.len() == 1 {
                        return Some(candidates[0].clone());
                    }
                    if let Some(id) = self.closest_by_parent_dir(candidates, from_parent_dir) {
                        return Some(id);
                    }
                }
                continue;
            }

            if let Some(id) = self.resolve_unique_match(&self.exact_titles, normalized_link) {
                return Some(id);
            }

            if let Some(id) = self.resolve_unique_match(&self.exact_filenames, normalized_link) {
                return Some(id);
            }

            let Some(candidates) = self.names.get(normalized_link.as_str()) else {
                continue;
            };

            if candidates.len() == 1 {
                return Some(candidates[0].clone());
            }

            if let Some(id) = self.closest_by_parent_dir(candidates, from_parent_dir) {
                return Some(id);
            }
        }

        for normalized_link in &link.strong_prefix_variants {
            if let Some(id) = self.resolve_unique_prefix_match(normalized_link) {
                return Some(id);
            }
        }

        None
    }

    fn resolve_unique_match(
        &self,
        map: &HashMap<String, UniqueNoteMatch>,
        key: &str,
    ) -> Option<NoteId> {
        match map.get(key) {
            Some(UniqueNoteMatch::Unique(id)) => Some(id.clone()),
            _ => None,
        }
    }

    fn closest_by_parent_dir(
        &self,
        candidates: &[NoteId],
        from_parent_dir: &str,
    ) -> Option<NoteId> {
        candidates
            .iter()
            .filter_map(|id| {
                let target_parent_dir = self.parent_dirs.get(id)?;
                Some((
                    id.clone(),
                    path_distance(from_parent_dir, target_parent_dir),
                ))
            })
            .min_by_key(|(_, distance)| *distance)
            .map(|(id, _)| id)
    }

    fn resolve_unique_prefix_match(&self, normalized_link: &str) -> Option<NoteId> {
        if !is_strong_prefix_candidate(normalized_link) {
            return None;
        }

        let mut matches = Vec::new();

        for entry in &self.prefix_entries {
            let matched = entry
                .aliases
                .iter()
                .any(|alias| is_prefix_expansion(alias, normalized_link));

            if matched {
                if matches.iter().any(|id: &NoteId| id == &entry.note_id) {
                    continue;
                }
                matches.push(entry.note_id.clone());
                if matches.len() > 1 {
                    return None;
                }
            }
        }

        matches.into_iter().next()
    }
}

fn record_unique_match(map: &mut HashMap<String, UniqueNoteMatch>, key: &str, note_id: NoteId) {
    if key.is_empty() {
        return;
    }

    match map.get(key) {
        None => {
            map.insert(key.to_string(), UniqueNoteMatch::Unique(note_id));
        }
        Some(UniqueNoteMatch::Unique(existing)) if existing == &note_id => {}
        _ => {
            map.insert(key.to_string(), UniqueNoteMatch::Ambiguous);
        }
    }
}

fn remove_note_id_from_map_list(
    map: &mut HashMap<String, Vec<NoteId>>,
    key: &str,
    note_id: &NoteId,
) {
    let should_remove = match map.get_mut(key) {
        Some(entries) => {
            entries.retain(|id| id != note_id);
            entries.is_empty()
        }
        None => false,
    };

    if should_remove {
        map.remove(key);
    }
}

fn note_alias_keys(note: &NoteMetadata) -> Vec<String> {
    let mut aliases = HashSet::new();
    let filename = note
        .path
        .0
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or_default();

    for alias in note_alias_values(&note.title, &note.id.0, filename) {
        for normalized in normalize_note_alias_variants(&alias) {
            aliases.insert(normalized);
        }
    }

    aliases.into_iter().collect()
}

fn note_alias_values(title: &str, note_id: &str, filename: &str) -> Vec<String> {
    vec![
        filename.to_string(),
        title.to_string(),
        note_id.to_string(),
        note_id
            .split('/')
            .next_back()
            .unwrap_or_default()
            .to_string(),
    ]
}

fn note_path_suffix_keys(note: &NoteMetadata) -> Vec<String> {
    let normalized_id = normalize_alias(&note.id.0);
    let parts: Vec<&str> = normalized_id.split('/').collect();
    (0..parts.len())
        .map(|start| parts[start..].join("/"))
        .collect()
}

fn normalized_filename(note: &NoteMetadata) -> String {
    note.path
        .0
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(normalize_alias)
        .unwrap_or_default()
}

fn suggestion_prefix_keys(value: &str) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }

    let mut prefixes = Vec::new();
    let mut char_count = 0;
    for (index, _) in value.char_indices().skip(1) {
        char_count += 1;
        if char_count > MAX_SUGGESTION_PREFIX_CHARS {
            break;
        }
        prefixes.push(value[..index].to_string());
    }

    if prefixes.last().map(String::as_str) != Some(value) {
        prefixes.push(value.to_string());
    }

    prefixes
}

fn suggestion_lookup_key(value: &str) -> &str {
    let mut count = 0;
    for (index, _) in value.char_indices() {
        if count == MAX_SUGGESTION_PREFIX_CHARS {
            return &value[..index];
        }
        count += 1;
    }
    value
}

fn suggestion_insert_text(note: &NoteMetadata) -> String {
    let title = note.title.trim();
    if !title.is_empty() {
        return title.to_string();
    }

    note.id
        .0
        .split('/')
        .next_back()
        .unwrap_or(&note.id.0)
        .trim_end_matches(".md")
        .to_string()
}

fn suggestion_sort_key(note: &NoteMetadata) -> String {
    normalize_alias(&suggestion_insert_text(note))
}

fn compute_unique_match_entry(
    metadata: &HashMap<NoteId, NoteMetadata>,
    key: &str,
    removed_note_id: &NoteId,
    project_key: impl Fn(&NoteMetadata) -> String,
) -> Option<UniqueNoteMatch> {
    if key.is_empty() {
        return None;
    }

    let mut matches = metadata
        .values()
        .filter(|note| &note.id != removed_note_id)
        .filter(|note| project_key(note) == key)
        .map(|note| note.id.clone());

    match (matches.next(), matches.next()) {
        (None, _) => None,
        (Some(id), None) => Some(UniqueNoteMatch::Unique(id)),
        _ => Some(UniqueNoteMatch::Ambiguous),
    }
}

fn parent_dir_from_note_id(note_id: &NoteId) -> String {
    note_id
        .0
        .rsplit_once('/')
        .map(|(parent, _)| normalize_alias(parent))
        .unwrap_or_default()
}

fn read_note_file_stats(path: &std::path::Path) -> (u64, u64, u64) {
    let Ok(metadata) = std::fs::metadata(path) else {
        return (0, 0, 0);
    };

    let modified_at = metadata.modified().map(system_time_to_secs).unwrap_or(0);
    let created_at = metadata
        .created()
        .map(system_time_to_secs)
        .unwrap_or(modified_at);

    (modified_at, created_at, metadata.len())
}

fn system_time_to_secs(value: std::time::SystemTime) -> u64 {
    value
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
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

fn path_distance(from_parent_dir: &str, target_parent_dir: &str) -> usize {
    let from_components: Vec<&str> = if from_parent_dir.is_empty() {
        Vec::new()
    } else {
        from_parent_dir.split('/').collect()
    };
    let target_components: Vec<&str> = if target_parent_dir.is_empty() {
        Vec::new()
    } else {
        target_parent_dir.split('/').collect()
    };

    let shared = from_components
        .iter()
        .zip(target_components.iter())
        .take_while(|(left, right)| left == right)
        .count();

    (from_components.len() - shared) + (target_components.len() - shared)
}
