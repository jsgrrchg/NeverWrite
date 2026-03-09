use vault_ai_types::{NoteId, NoteMetadata};

use crate::VaultIndex;

pub struct SearchResult<'a> {
    pub note_id: &'a NoteId,
    pub metadata: &'a NoteMetadata,
    pub score: f64,
}

impl VaultIndex {
    pub fn search_by_title(&self, query: &str) -> Vec<SearchResult<'_>> {
        self.search_internal(query, SearchScope::TitleOnly)
    }

    pub fn search_by_path(&self, query: &str) -> Vec<SearchResult<'_>> {
        self.search_internal(query, SearchScope::PathOnly)
    }

    pub fn search(&self, query: &str) -> Vec<SearchResult<'_>> {
        self.search_internal(query, SearchScope::TitleAndPath)
    }

    fn search_internal(&self, query: &str, scope: SearchScope) -> Vec<SearchResult<'_>> {
        if query.is_empty() {
            return Vec::new();
        }

        let query_lower = query.to_lowercase();

        let mut results: Vec<SearchResult<'_>> = self
            .search_index
            .iter()
            .filter_map(|(note_id, entry)| {
                let metadata = self.metadata.get(note_id)?;

                let title_score =
                    if matches!(scope, SearchScope::TitleOnly | SearchScope::TitleAndPath)
                        && entry.title_lower.contains(&query_lower)
                    {
                        compute_score(&query_lower, &entry.title_lower)
                    } else {
                        0.0
                    };

                let path_score =
                    if matches!(scope, SearchScope::PathOnly | SearchScope::TitleAndPath)
                        && entry.path_lower.contains(&query_lower)
                    {
                        compute_score(&query_lower, &entry.path_lower)
                            * if matches!(scope, SearchScope::TitleAndPath) {
                                0.8
                            } else {
                                1.0
                            }
                    } else {
                        0.0
                    };

                let score = title_score.max(path_score);
                if score > 0.0 {
                    Some(SearchResult {
                        note_id,
                        metadata,
                        score,
                    })
                } else {
                    None
                }
            })
            .collect();

        results.sort_by(|left, right| right.score.partial_cmp(&left.score).unwrap());
        results
    }
}

#[derive(Clone, Copy)]
enum SearchScope {
    TitleOnly,
    PathOnly,
    TitleAndPath,
}

fn compute_score(query: &str, target: &str) -> f64 {
    if target == query {
        return 1.0;
    }
    if target.starts_with(query) {
        return 0.9 * (query.len() as f64 / target.len() as f64);
    }
    0.5 * (query.len() as f64 / target.len() as f64)
}
