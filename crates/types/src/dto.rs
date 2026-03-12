use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessageDto {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextDiffDto {
    pub hunks: Vec<DiffHunkDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiffHunkDto {
    pub old_start: usize,
    pub old_end: usize,
    pub new_start: usize,
    pub new_end: usize,
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposedEditDto {
    pub proposal_id: String,
    pub note_id: String,
    pub diff: TextDiffDto,
    pub base_content_hash: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamChunkDto {
    pub session_id: Option<String>,
    pub request_id: String,
    pub delta: String,
    pub done: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposedNewNoteDto {
    pub proposal_id: String,
    pub path: String,
    pub title: String,
    pub content: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultEntryDto {
    pub id: String,
    pub path: String,
    pub title: String,
    pub kind: String, // "note" | "pdf"
    pub modified_at: u64,
    pub created_at: u64,
    pub size: u64,
    pub mime_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteDto {
    pub id: String,
    pub path: String,
    pub title: String,
    pub modified_at: u64,
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteDetailDto {
    pub id: String,
    pub path: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub links: Vec<String>,
    pub frontmatter: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResultDto {
    pub id: String,
    pub path: String,
    pub title: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BacklinkDto {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultOpenMetricsDto {
    pub scan_ms: u64,
    pub snapshot_load_ms: u64,
    pub parse_ms: u64,
    pub index_ms: u64,
    pub snapshot_save_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultOpenStateDto {
    pub path: Option<String>,
    pub stage: String,
    pub message: String,
    pub processed: usize,
    pub total: usize,
    pub note_count: usize,
    pub snapshot_used: bool,
    pub cancelled: bool,
    pub started_at_ms: Option<u64>,
    pub finished_at_ms: Option<u64>,
    pub metrics: VaultOpenMetricsDto,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultNoteChangeDto {
    pub vault_path: String,
    pub kind: String,
    pub note: Option<NoteDto>,
    pub note_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedLinkDto {
    pub target: String,
    pub note_id: Option<String>,
    pub title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResolvedWikilinkDto {
    pub target: String,
    pub resolved_note_id: Option<String>,
    pub resolved_title: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikilinkSuggestionDto {
    pub id: String,
    pub title: String,
    pub subtitle: String,
    pub insert_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OutlineHeadingDto {
    pub id: String,
    pub title: String,
    pub level: u8,
    pub anchor: usize,
    pub head: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppErrorDto {
    pub code: String,
    pub message: String,
}

// ── Advanced Search ────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchTermParam {
    pub value: String,
    pub negated: bool,
    pub is_regex: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentSearchParam {
    pub value: String,
    /// "content" | "line" | "section"
    pub scope: String,
    pub negated: bool,
    pub is_regex: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PropertyFilterParam {
    /// Frontmatter property key
    pub key: String,
    /// Value to match against (substring, case-insensitive)
    pub value: String,
    pub negated: bool,
    pub is_regex: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvancedSearchParams {
    /// Title/path terms (no operator or default search)
    pub terms: Vec<SearchTermParam>,
    /// tag: filters
    pub tag_filters: Vec<SearchTermParam>,
    /// file: filters
    pub file_filters: Vec<SearchTermParam>,
    /// path: filters
    pub path_filters: Vec<SearchTermParam>,
    /// content: / line: / section: searches
    pub content_searches: Vec<ContentSearchParam>,
    /// [key:value] frontmatter property filters
    pub property_filters: Vec<PropertyFilterParam>,
    /// "relevance" | "title" | "modified"
    pub sort_by: String,
    pub sort_asc: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ContentMatchDto {
    pub line_number: usize,
    pub line_content: String,
    pub match_start: usize,
    pub match_end: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdvancedSearchResultDto {
    pub id: String,
    pub path: String,
    pub title: String,
    #[serde(default = "default_note_kind")]
    pub kind: String,
    pub score: f64,
    pub tags: Vec<String>,
    pub modified_at: u64,
    pub matches: Vec<ContentMatchDto>,
}

fn default_note_kind() -> String {
    "note".to_string()
}
