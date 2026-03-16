use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpellcheckLanguageSelection {
    pub primary: String,
    pub secondary: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpellcheckDiagnostic {
    pub start_utf16: usize,
    pub end_utf16: usize,
    pub word: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpellcheckCheckTextResponse {
    pub language: String,
    pub secondary_language: Option<String>,
    pub diagnostics: Vec<SpellcheckDiagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpellcheckSuggestionResponse {
    pub language: String,
    pub secondary_language: Option<String>,
    pub word: String,
    pub correct: bool,
    pub suggestions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpellcheckLanguageInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
    pub source: String,
    pub dictionary_path: Option<String>,
    pub user_dictionary_path: String,
    pub aff_path: Option<String>,
    pub dic_path: Option<String>,
    pub version: Option<String>,
    pub size_bytes: Option<u64>,
    pub license: Option<String>,
    pub homepage: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SpellcheckDictionaryMutationResponse {
    pub language: String,
    pub word: String,
    pub updated: bool,
    pub user_dictionary_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedSpellcheckLanguage {
    pub id: String,
    pub label: String,
}
