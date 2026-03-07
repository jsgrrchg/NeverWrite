use vault_ai_types::IndexedNote;

use crate::VaultIndex;

pub struct SearchResult<'a> {
    pub note: &'a IndexedNote,
    pub score: f64,
}

impl VaultIndex {
    /// Busca notas por título (case-insensitive substring match, con scoring).
    pub fn search_by_title(&self, query: &str) -> Vec<SearchResult<'_>> {
        if query.is_empty() {
            return Vec::new();
        }
        let query_lower = query.to_lowercase();

        let mut results: Vec<SearchResult<'_>> = self
            .notes
            .values()
            .filter_map(|note| {
                let title_lower = note.title.to_lowercase();
                if title_lower.contains(&query_lower) {
                    let score = compute_score(&query_lower, &title_lower);
                    Some(SearchResult { note, score })
                } else {
                    None
                }
            })
            .collect();

        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        results
    }

    /// Busca notas por path (case-insensitive substring match).
    pub fn search_by_path(&self, query: &str) -> Vec<SearchResult<'_>> {
        if query.is_empty() {
            return Vec::new();
        }
        let query_lower = query.to_lowercase();

        let mut results: Vec<SearchResult<'_>> = self
            .notes
            .values()
            .filter_map(|note| {
                let path_str = note.id.0.to_lowercase();
                if path_str.contains(&query_lower) {
                    let score = compute_score(&query_lower, &path_str);
                    Some(SearchResult { note, score })
                } else {
                    None
                }
            })
            .collect();

        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        results
    }

    /// Busca por título y path combinados.
    pub fn search(&self, query: &str) -> Vec<SearchResult<'_>> {
        if query.is_empty() {
            return Vec::new();
        }
        let query_lower = query.to_lowercase();

        let mut results: Vec<SearchResult<'_>> = self
            .notes
            .values()
            .filter_map(|note| {
                let title_lower = note.title.to_lowercase();
                let path_lower = note.id.0.to_lowercase();

                let title_score = if title_lower.contains(&query_lower) {
                    compute_score(&query_lower, &title_lower)
                } else {
                    0.0
                };

                let path_score = if path_lower.contains(&query_lower) {
                    compute_score(&query_lower, &path_lower) * 0.8 // Path match vale un poco menos
                } else {
                    0.0
                };

                let score = title_score.max(path_score);
                if score > 0.0 {
                    Some(SearchResult { note, score })
                } else {
                    None
                }
            })
            .collect();

        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        results
    }
}

/// Score simple: match exacto = 1.0, starts_with > contains, penaliza por longitud extra.
fn compute_score(query: &str, target: &str) -> f64 {
    if target == query {
        return 1.0;
    }
    if target.starts_with(query) {
        return 0.9 * (query.len() as f64 / target.len() as f64);
    }
    // Contains
    0.5 * (query.len() as f64 / target.len() as f64)
}
