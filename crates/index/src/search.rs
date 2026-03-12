use std::collections::HashSet;

use regex::Regex;
use vault_ai_types::{
    AdvancedSearchParams, AdvancedSearchResultDto, ContentMatchDto, ContentSearchParam, NoteId,
    NoteMetadata, PropertyFilterParam,
};
use vault_ai_vault::Vault;

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

    pub fn advanced_search(
        &self,
        params: &AdvancedSearchParams,
        vault: &Vault,
    ) -> Vec<AdvancedSearchResultDto> {
        // Start with all notes as candidates
        let mut candidates: HashSet<&NoteId> = self.metadata.keys().collect();

        // Phase 1: Fast in-memory filtering

        // Tag filters
        for filter in &params.tag_filters {
            let matching = self.find_notes_with_tag(&filter.value, filter.is_regex);
            if filter.negated {
                candidates.retain(|id| !matching.contains(id));
            } else {
                candidates.retain(|id| matching.contains(id));
            }
        }

        // File name filters
        for filter in &params.file_filters {
            let matcher = build_matcher(&filter.value, filter.is_regex);
            candidates.retain(|id| {
                let entry = match self.search_index.get(*id) {
                    Some(e) => e,
                    None => return false,
                };
                let filename = entry
                    .path_lower
                    .rsplit('/')
                    .next()
                    .unwrap_or(&entry.path_lower);
                matcher.matches(filename) != filter.negated
            });
        }

        // Path filters
        for filter in &params.path_filters {
            let matcher = build_matcher(&filter.value, filter.is_regex);
            candidates.retain(|id| {
                let entry = match self.search_index.get(*id) {
                    Some(e) => e,
                    None => return false,
                };
                matcher.matches(&entry.path_lower) != filter.negated
            });
        }

        // Title/path terms (plain search like current behavior)
        for term in &params.terms {
            let matcher = build_matcher(&term.value, term.is_regex);
            candidates.retain(|id| {
                let entry = match self.search_index.get(*id) {
                    Some(e) => e,
                    None => return false,
                };
                let found =
                    matcher.matches(&entry.title_lower) || matcher.matches(&entry.path_lower);
                found != term.negated
            });
        }

        // Phase 2: Disk I/O — content + property searches (only if needed)
        let needs_disk_read =
            !params.content_searches.is_empty() || !params.property_filters.is_empty();
        let mut results: Vec<AdvancedSearchResultDto> = Vec::new();

        for note_id in &candidates {
            let metadata = match self.metadata.get(*note_id) {
                Some(m) => m,
                None => continue,
            };
            let indexed = self.notes.get(*note_id);
            let tags = indexed.map(|n| n.tags.clone()).unwrap_or_default();

            let mut content_matches: Vec<ContentMatchDto> = Vec::new();
            let mut content_score = 0.0f64;
            let mut passes_content_filter = true;

            if needs_disk_read {
                let doc = match vault.read_note(&note_id.0) {
                    Ok(d) => d,
                    Err(_) => continue,
                };

                // Content/line/section searches
                for cs in &params.content_searches {
                    let found = search_content(&doc.raw_markdown, cs);
                    if cs.negated {
                        if !found.is_empty() {
                            passes_content_filter = false;
                            break;
                        }
                    } else if found.is_empty() {
                        passes_content_filter = false;
                        break;
                    } else {
                        content_score += found.len() as f64 * 0.3;
                        content_matches.extend(found);
                    }
                }

                // Property / frontmatter filters
                if passes_content_filter && !params.property_filters.is_empty() {
                    for pf in &params.property_filters {
                        let matched = check_property(doc.frontmatter.as_ref(), pf);
                        if matched == pf.negated {
                            passes_content_filter = false;
                            break;
                        }
                    }
                }
            }

            if !passes_content_filter {
                continue;
            }

            // Compute title/path score
            let entry = self.search_index.get(*note_id);
            let title_path_score = if let Some(entry) = entry {
                let mut best = 0.0f64;
                for term in &params.terms {
                    if !term.negated {
                        let s1 =
                            compute_score_match(&term.value, &entry.title_lower, term.is_regex);
                        let s2 = compute_score_match(&term.value, &entry.path_lower, term.is_regex)
                            * 0.8;
                        best = best.max(s1.max(s2));
                    }
                }
                best
            } else {
                0.0
            };

            let score = if title_path_score > 0.0 && content_score > 0.0 {
                title_path_score * 0.6 + content_score * 0.4
            } else if content_score > 0.0 {
                content_score
            } else if title_path_score > 0.0 {
                title_path_score
            } else {
                // Note matched only via tag/file/path filters — base score
                0.5
            };

            content_matches.truncate(5);

            results.push(AdvancedSearchResultDto {
                id: note_id.0.clone(),
                path: metadata.path.0.to_string_lossy().to_string(),
                title: metadata.title.clone(),
                kind: "note".to_string(),
                score,
                tags,
                modified_at: metadata.modified_at,
                matches: content_matches,
            });
        }

        // Phase 2b: PDF search
        // Skip PDFs if tag or property filters are active (PDFs have neither)
        if params.tag_filters.is_empty() && params.property_filters.is_empty() {
            let mut pdf_candidates: HashSet<&NoteId> = self.pdf_metadata.keys().collect();

            for filter in &params.file_filters {
                let matcher = build_matcher(&filter.value, filter.is_regex);
                pdf_candidates.retain(|id| {
                    let entry = match self.pdf_search_index.get(*id) {
                        Some(e) => e,
                        None => return false,
                    };
                    let filename = entry
                        .path_lower
                        .rsplit('/')
                        .next()
                        .unwrap_or(&entry.path_lower);
                    matcher.matches(filename) != filter.negated
                });
            }

            for filter in &params.path_filters {
                let matcher = build_matcher(&filter.value, filter.is_regex);
                pdf_candidates.retain(|id| {
                    let entry = match self.pdf_search_index.get(*id) {
                        Some(e) => e,
                        None => return false,
                    };
                    matcher.matches(&entry.path_lower) != filter.negated
                });
            }

            for term in &params.terms {
                let matcher = build_matcher(&term.value, term.is_regex);
                pdf_candidates.retain(|id| {
                    let entry = match self.pdf_search_index.get(*id) {
                        Some(e) => e,
                        None => return false,
                    };
                    let found =
                        matcher.matches(&entry.title_lower) || matcher.matches(&entry.path_lower);
                    found != term.negated
                });
            }

            for pdf_id in &pdf_candidates {
                let pdf_meta = match self.pdf_metadata.get(*pdf_id) {
                    Some(m) => m,
                    None => continue,
                };

                let mut content_matches: Vec<ContentMatchDto> = Vec::new();
                let mut content_score = 0.0f64;
                let mut passes = true;

                if !params.content_searches.is_empty() {
                    let pdf_doc = match vault_ai_vault::pdf::extract_pdf_text(
                        &vault.root,
                        &pdf_meta.path.0,
                        &pdf_meta.id.0,
                    ) {
                        Ok(doc) => doc,
                        Err(_) => continue,
                    };

                    for cs in &params.content_searches {
                        let found = search_pdf_content(&pdf_doc.extracted_pages, cs);
                        if cs.negated {
                            if !found.is_empty() {
                                passes = false;
                                break;
                            }
                        } else if found.is_empty() {
                            passes = false;
                            break;
                        } else {
                            content_score += found.len() as f64 * 0.3;
                            content_matches.extend(found);
                        }
                    }
                }

                if !passes {
                    continue;
                }

                let entry = self.pdf_search_index.get(*pdf_id);
                let title_path_score = if let Some(entry) = entry {
                    let mut best = 0.0f64;
                    for term in &params.terms {
                        if !term.negated {
                            let s1 =
                                compute_score_match(&term.value, &entry.title_lower, term.is_regex);
                            let s2 =
                                compute_score_match(&term.value, &entry.path_lower, term.is_regex)
                                    * 0.8;
                            best = best.max(s1.max(s2));
                        }
                    }
                    best
                } else {
                    0.0
                };

                let score = if title_path_score > 0.0 && content_score > 0.0 {
                    title_path_score * 0.6 + content_score * 0.4
                } else if content_score > 0.0 {
                    content_score
                } else if title_path_score > 0.0 {
                    title_path_score
                } else {
                    0.5
                };

                content_matches.truncate(5);

                results.push(AdvancedSearchResultDto {
                    id: pdf_id.0.clone(),
                    path: pdf_meta.path.0.to_string_lossy().to_string(),
                    title: pdf_meta.title.clone(),
                    kind: "pdf".to_string(),
                    score,
                    tags: vec![],
                    modified_at: pdf_meta.modified_at,
                    matches: content_matches,
                });
            }
        }

        // Phase 2c: generic file search
        if params.tag_filters.is_empty()
            && params.property_filters.is_empty()
            && params.content_searches.is_empty()
        {
            let generic_entries = vault.discover_vault_entries().unwrap_or_default();

            for entry in generic_entries.iter().filter(|entry| entry.kind == "file") {
                let title_lower = entry.title.to_lowercase();
                let path_lower = entry.relative_path.to_lowercase();

                let file_filter_match = params.file_filters.iter().all(|filter| {
                    let matcher = build_matcher(&filter.value, filter.is_regex);
                    matcher.matches(&entry.file_name.to_lowercase()) != filter.negated
                });
                if !file_filter_match {
                    continue;
                }

                let path_filter_match = params.path_filters.iter().all(|filter| {
                    let matcher = build_matcher(&filter.value, filter.is_regex);
                    matcher.matches(&path_lower) != filter.negated
                });
                if !path_filter_match {
                    continue;
                }

                let term_match = params.terms.iter().all(|term| {
                    let matcher = build_matcher(&term.value, term.is_regex);
                    let found = matcher.matches(&title_lower) || matcher.matches(&path_lower);
                    found != term.negated
                });
                if !term_match {
                    continue;
                }

                let mut best = 0.0f64;
                for term in &params.terms {
                    if term.negated {
                        continue;
                    }
                    let title_score = compute_score_match(&term.value, &title_lower, term.is_regex);
                    let path_score =
                        compute_score_match(&term.value, &path_lower, term.is_regex) * 0.8;
                    best = best.max(title_score.max(path_score));
                }

                results.push(AdvancedSearchResultDto {
                    id: entry.id.clone(),
                    path: entry.path.clone(),
                    title: entry.title.clone(),
                    kind: "file".to_string(),
                    score: if best > 0.0 { best } else { 0.5 },
                    tags: vec![],
                    modified_at: entry.modified_at,
                    matches: vec![],
                });
            }
        }

        // Phase 3: Sort
        match params.sort_by.as_str() {
            "title" => {
                results.sort_by(|a, b| {
                    let cmp = a.title.to_lowercase().cmp(&b.title.to_lowercase());
                    if params.sort_asc {
                        cmp
                    } else {
                        cmp.reverse()
                    }
                });
            }
            "modified" => {
                results.sort_by(|a, b| {
                    let cmp = a.modified_at.cmp(&b.modified_at);
                    if params.sort_asc {
                        cmp
                    } else {
                        cmp.reverse()
                    }
                });
            }
            _ => {
                // "relevance" — sort by score descending
                results.sort_by(|a, b| {
                    b.score
                        .partial_cmp(&a.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }
        }

        results.truncate(200);
        results
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

    fn find_notes_with_tag(&self, tag_query: &str, is_regex: bool) -> HashSet<&NoteId> {
        let mut result = HashSet::new();
        if is_regex {
            if let Ok(re) = Regex::new(tag_query) {
                for (tag, note_ids) in &self.tags {
                    if re.is_match(tag) {
                        result.extend(note_ids.iter());
                    }
                }
            }
        } else {
            let lower = tag_query.to_lowercase();
            let query = lower.strip_prefix('#').unwrap_or(&lower);
            for (tag, note_ids) in &self.tags {
                if tag.to_lowercase() == query || tag.to_lowercase().contains(query) {
                    result.extend(note_ids.iter());
                }
            }
        }
        result
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

fn compute_score_match(query: &str, target: &str, is_regex: bool) -> f64 {
    if is_regex {
        if let Ok(re) = Regex::new(query) {
            if re.is_match(target) {
                return 0.7;
            }
        }
        return 0.0;
    }
    let q = query.to_lowercase();
    if target.contains(&q) {
        compute_score(&q, target)
    } else {
        0.0
    }
}

// ── Content search helpers ─────────────────────────────

enum Matcher {
    Plain(String),
    Re(Regex),
}

impl Matcher {
    fn matches(&self, text: &str) -> bool {
        match self {
            Matcher::Plain(q) => text.contains(q),
            Matcher::Re(re) => re.is_match(text),
        }
    }

    fn find_in(&self, text: &str) -> Vec<(usize, usize)> {
        match self {
            Matcher::Plain(q) => {
                let mut results = Vec::new();
                let mut start = 0;
                while let Some(pos) = text[start..].find(q) {
                    let abs = start + pos;
                    results.push((abs, abs + q.len()));
                    start = abs + 1;
                }
                results
            }
            Matcher::Re(re) => re.find_iter(text).map(|m| (m.start(), m.end())).collect(),
        }
    }
}

fn build_matcher(value: &str, is_regex: bool) -> Matcher {
    if is_regex {
        match Regex::new(value) {
            Ok(re) => Matcher::Re(re),
            Err(_) => Matcher::Plain(value.to_lowercase()),
        }
    } else {
        Matcher::Plain(value.to_lowercase())
    }
}

fn search_content(content: &str, cs: &ContentSearchParam) -> Vec<ContentMatchDto> {
    let matcher = build_matcher(&cs.value, cs.is_regex);
    let mut results = Vec::new();

    match cs.scope.as_str() {
        "line" => {
            for (line_num, line) in content.lines().enumerate() {
                let line_lower = line.to_lowercase();
                let hits = matcher.find_in(&line_lower);
                if !hits.is_empty() {
                    for (start, end) in hits.iter().take(2) {
                        results.push(ContentMatchDto {
                            line_number: line_num + 1,
                            line_content: truncate_line(line, 200),
                            match_start: *start,
                            match_end: *end,
                            page: None,
                        });
                    }
                }
                if results.len() >= 10 {
                    break;
                }
            }
        }
        "section" => {
            let lines: Vec<&str> = content.lines().collect();
            let mut section_start = 0;

            for i in 0..=lines.len() {
                let is_heading = if i < lines.len() {
                    lines[i].starts_with('#')
                } else {
                    true // end of document
                };

                if is_heading && i > section_start {
                    let section_text: String = lines[section_start..i].join("\n");
                    let section_lower = section_text.to_lowercase();
                    if matcher.matches(&section_lower) {
                        for j in section_start..i {
                            let line_lower = lines[j].to_lowercase();
                            let hits = matcher.find_in(&line_lower);
                            if !hits.is_empty() {
                                for (start, end) in hits.iter().take(1) {
                                    results.push(ContentMatchDto {
                                        line_number: j + 1,
                                        line_content: truncate_line(lines[j], 200),
                                        match_start: *start,
                                        match_end: *end,
                                        page: None,
                                    });
                                }
                                break;
                            }
                        }
                    }
                }

                if is_heading && i < lines.len() {
                    section_start = i;
                }

                if results.len() >= 10 {
                    break;
                }
            }
        }
        _ => {
            // "content" — search anywhere
            for (line_num, line) in content.lines().enumerate() {
                let line_lower = line.to_lowercase();
                let hits = matcher.find_in(&line_lower);
                if !hits.is_empty() {
                    for (start, end) in hits.iter().take(2) {
                        results.push(ContentMatchDto {
                            line_number: line_num + 1,
                            line_content: truncate_line(line, 200),
                            match_start: *start,
                            match_end: *end,
                            page: None,
                        });
                    }
                }
                if results.len() >= 10 {
                    break;
                }
            }
        }
    }

    results
}

fn truncate_line(line: &str, max: usize) -> String {
    if line.len() <= max {
        line.to_string()
    } else {
        format!("{}...", &line[..max])
    }
}

// ── PDF content search ────────────────────────────────

fn search_pdf_content(pages: &[String], cs: &ContentSearchParam) -> Vec<ContentMatchDto> {
    let matcher = build_matcher(&cs.value, cs.is_regex);
    let mut results = Vec::new();

    for (page_idx, page_text) in pages.iter().enumerate() {
        for (line_num, line) in page_text.lines().enumerate() {
            let line_lower = line.to_lowercase();
            let hits = matcher.find_in(&line_lower);
            if !hits.is_empty() {
                for (start, end) in hits.iter().take(2) {
                    results.push(ContentMatchDto {
                        line_number: line_num + 1,
                        line_content: truncate_line(line, 200),
                        match_start: *start,
                        match_end: *end,
                        page: Some(page_idx + 1),
                    });
                }
            }
            if results.len() >= 10 {
                return results;
            }
        }
    }

    results
}

// ── Property / frontmatter filter ─────────────────────

/// Returns true if the frontmatter matches the filter.
fn check_property(frontmatter: Option<&serde_json::Value>, pf: &PropertyFilterParam) -> bool {
    let fm = match frontmatter.and_then(|v| v.as_object()) {
        Some(obj) => obj,
        None => return false,
    };

    let raw_value = match fm.get(&pf.key) {
        Some(v) => v,
        None => return false,
    };

    // Convert the JSON value to a comparable string
    let as_string = json_value_to_string(raw_value);
    let haystack = as_string.to_lowercase();

    let matcher = build_matcher(&pf.value, pf.is_regex);
    matcher.matches(&haystack)
}

fn json_value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Array(arr) => arr
            .iter()
            .map(json_value_to_string)
            .collect::<Vec<_>>()
            .join(" "),
        serde_json::Value::Object(_) => v.to_string(),
        serde_json::Value::Null => String::new(),
    }
}
