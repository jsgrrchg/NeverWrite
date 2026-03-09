use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

// --- Identificadores ---

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NoteId(pub String);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NotePath(pub PathBuf);

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ProposalId(pub Uuid);

// --- Note ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteDocument {
    pub id: NoteId,
    pub path: NotePath,
    pub title: String,
    pub raw_markdown: String,
    pub links: Vec<WikiLink>,
    pub tags: Vec<String>,
    pub frontmatter: Option<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WikiLink {
    pub target: String,
    pub alias: Option<String>,
    pub range: TextRange,
}

// --- Index ---

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NoteMetadata {
    pub id: NoteId,
    pub path: NotePath,
    pub title: String,
    pub modified_at: u64,
    pub created_at: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedNote {
    pub tags: Vec<String>,
    pub links: Vec<String>,
}

// --- Diff ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextDiff {
    pub hunks: Vec<DiffHunk>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffHunk {
    pub old_range: TextRange,
    pub new_range: TextRange,
    pub old_text: String,
    pub new_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextRange {
    pub start: usize,
    pub end: usize,
}

// --- Chat ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ChatRole {
    User,
    Assistant,
    System,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

// --- Providers ---

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProviderType {
    Anthropic,
    OpenAi,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderConfig {
    pub provider: ProviderType,
    pub api_key: String,
    pub model: String,
    pub max_tokens: usize,
}
