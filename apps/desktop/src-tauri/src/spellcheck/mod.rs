mod bundled;
mod catalog;
mod engine;
pub mod grammar;
mod language;
mod storage;
mod types;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tauri::AppHandle;

use catalog::{
    install_catalog_dictionary, list_catalog, remove_catalog_dictionary, SpellcheckCatalogEntryDto,
    SpellcheckCatalogMutationResponse,
};
use engine::{
    build_dictionary_selection, build_suggestions, check_text_spelling, ignored_session_key,
    normalize_dictionary_word, normalize_dictionary_word_key, DictionaryBundle,
    DictionarySelection,
};
use language::{list_supported_languages, resolve_language, resolve_language_selection};
use storage::{
    app_spellcheck_directory, ensure_spellcheck_directories, load_dictionary_bundle,
    remove_word_from_user_dictionary, user_dictionary_path, write_word_to_user_dictionary,
};
use types::{
    SpellcheckCheckTextResponse, SpellcheckDictionaryMutationResponse, SpellcheckLanguageInfo,
    SpellcheckSuggestionResponse,
};

pub struct SpellcheckState {
    cache: Mutex<HashMap<String, Arc<DictionaryBundle>>>,
    ignored_session_words: Mutex<HashSet<String>>,
    metrics: Mutex<SpellcheckMetrics>,
}

impl SpellcheckState {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            ignored_session_words: Mutex::new(HashSet::new()),
            metrics: Mutex::new(SpellcheckMetrics::default()),
        }
    }
}

#[derive(Debug, Default)]
struct SpellcheckMetrics {
    check_requests: usize,
    suggestion_requests: usize,
    secondary_selection_requests: usize,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SpellcheckMetricsDto {
    check_requests: usize,
    suggestion_requests: usize,
    secondary_selection_requests: usize,
}

fn cache_key(language: &str) -> String {
    language.to_string()
}

fn get_or_load_dictionary(
    app: &AppHandle,
    state: &tauri::State<'_, SpellcheckState>,
    requested_language: Option<String>,
) -> Result<Arc<DictionaryBundle>, String> {
    ensure_spellcheck_directories(app)?;
    let resolved = resolve_language(app, requested_language)?;
    let key = cache_key(&resolved.id);

    if let Some(cached) = state
        .cache
        .lock()
        .map_err(|error| error.to_string())?
        .get(&key)
        .cloned()
    {
        return Ok(cached);
    }

    let bundle = Arc::new(load_dictionary_bundle(app, &resolved)?);
    state
        .cache
        .lock()
        .map_err(|error| error.to_string())?
        .insert(key, Arc::clone(&bundle));
    Ok(bundle)
}

fn get_or_load_dictionary_selection(
    app: &AppHandle,
    state: &tauri::State<'_, SpellcheckState>,
    primary_language: Option<String>,
    secondary_language: Option<String>,
) -> Result<DictionarySelection, String> {
    let selection = resolve_language_selection(app, primary_language, secondary_language)?;
    let primary = (*get_or_load_dictionary(app, state, Some(selection.primary.clone()))?).clone();
    let secondary = match selection.secondary.clone() {
        Some(language) => Some((*get_or_load_dictionary(app, state, Some(language))?).clone()),
        None => None,
    };

    Ok(build_dictionary_selection(&selection, primary, secondary))
}

fn resolve_primary_action_language(
    app: &AppHandle,
    language: Option<String>,
) -> Result<String, String> {
    Ok(resolve_language_selection(app, language, None)?.primary)
}

fn invalidate_dictionary_cache(
    state: &tauri::State<'_, SpellcheckState>,
    language: &str,
) -> Result<(), String> {
    state
        .cache
        .lock()
        .map_err(|error| error.to_string())?
        .remove(language);
    Ok(())
}

#[tauri::command]
pub fn spellcheck_list_languages(app: AppHandle) -> Result<Vec<SpellcheckLanguageInfo>, String> {
    ensure_spellcheck_directories(&app)?;
    list_supported_languages(&app)
}

#[tauri::command]
pub fn spellcheck_list_catalog(app: AppHandle) -> Result<Vec<SpellcheckCatalogEntryDto>, String> {
    ensure_spellcheck_directories(&app)?;
    list_catalog(&app)
}

#[tauri::command]
pub fn spellcheck_check_text(
    text: String,
    language: Option<String>,
    secondary_language: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, SpellcheckState>,
) -> Result<SpellcheckCheckTextResponse, String> {
    let selection = get_or_load_dictionary_selection(&app, &state, language, secondary_language)?;
    let ignored_words = state
        .ignored_session_words
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    record_metrics(&state, |metrics| {
        metrics.check_requests += 1;
        if selection.secondary.is_some() {
            metrics.secondary_selection_requests += 1;
        }
    })?;
    Ok(check_text_spelling(&text, &selection, &ignored_words))
}

#[tauri::command]
pub fn spellcheck_suggest(
    word: String,
    language: Option<String>,
    secondary_language: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, SpellcheckState>,
) -> Result<SpellcheckSuggestionResponse, String> {
    let selection = get_or_load_dictionary_selection(&app, &state, language, secondary_language)?;
    record_metrics(&state, |metrics| {
        metrics.suggestion_requests += 1;
        if selection.secondary.is_some() {
            metrics.secondary_selection_requests += 1;
        }
    })?;
    Ok(build_suggestions(&word, &selection))
}

#[tauri::command]
pub fn spellcheck_add_to_dictionary(
    word: String,
    language: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, SpellcheckState>,
) -> Result<SpellcheckDictionaryMutationResponse, String> {
    let resolved = resolve_primary_action_language(&app, language)?;
    let normalized_word = normalize_dictionary_word(&word)
        .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;
    let normalized_key = normalize_dictionary_word_key(&word)
        .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;

    write_word_to_user_dictionary(&app, &resolved, &normalized_word)?;
    invalidate_dictionary_cache(&state, &resolved)?;
    state
        .ignored_session_words
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&ignored_session_key(&normalized_key));
    let user_dictionary_path = user_dictionary_path(&app, &resolved)?
        .to_string_lossy()
        .to_string();

    Ok(SpellcheckDictionaryMutationResponse {
        language: resolved,
        word: normalized_word,
        updated: true,
        user_dictionary_path,
    })
}

#[tauri::command]
pub fn spellcheck_remove_from_dictionary(
    word: String,
    language: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, SpellcheckState>,
) -> Result<SpellcheckDictionaryMutationResponse, String> {
    let resolved = resolve_primary_action_language(&app, language)?;
    let normalized_word = normalize_dictionary_word(&word)
        .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;

    let updated = remove_word_from_user_dictionary(&app, &resolved, &normalized_word)?;
    invalidate_dictionary_cache(&state, &resolved)?;
    let user_dictionary_path = user_dictionary_path(&app, &resolved)?
        .to_string_lossy()
        .to_string();

    Ok(SpellcheckDictionaryMutationResponse {
        language: resolved,
        word: normalized_word,
        updated,
        user_dictionary_path,
    })
}

#[tauri::command]
pub fn spellcheck_ignore_word(
    word: String,
    language: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, SpellcheckState>,
) -> Result<SpellcheckDictionaryMutationResponse, String> {
    let resolved = resolve_primary_action_language(&app, language)?;
    let normalized_word = normalize_dictionary_word(&word)
        .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;
    let normalized_key = normalize_dictionary_word_key(&word)
        .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;

    state
        .ignored_session_words
        .lock()
        .map_err(|error| error.to_string())?
        .insert(ignored_session_key(&normalized_key));
    let user_dictionary_path = user_dictionary_path(&app, &resolved)?
        .to_string_lossy()
        .to_string();

    Ok(SpellcheckDictionaryMutationResponse {
        language: resolved,
        word: normalized_word,
        updated: true,
        user_dictionary_path,
    })
}

#[tauri::command]
pub fn spellcheck_get_runtime_directory(app: AppHandle) -> Result<String, String> {
    Ok(app_spellcheck_directory(&app)?
        .to_string_lossy()
        .to_string())
}

#[tauri::command]
pub fn spellcheck_get_metrics(
    state: tauri::State<'_, SpellcheckState>,
) -> Result<SpellcheckMetricsDto, String> {
    let metrics = state.metrics.lock().map_err(|error| error.to_string())?;
    Ok(SpellcheckMetricsDto {
        check_requests: metrics.check_requests,
        suggestion_requests: metrics.suggestion_requests,
        secondary_selection_requests: metrics.secondary_selection_requests,
    })
}

#[tauri::command]
pub fn spellcheck_reset_metrics(state: tauri::State<'_, SpellcheckState>) -> Result<(), String> {
    let mut metrics = state.metrics.lock().map_err(|error| error.to_string())?;
    *metrics = SpellcheckMetrics::default();
    Ok(())
}

#[tauri::command]
pub fn spellcheck_install_dictionary(
    language: String,
    app: AppHandle,
    state: tauri::State<'_, SpellcheckState>,
) -> Result<SpellcheckCatalogMutationResponse, String> {
    let response = install_catalog_dictionary(&app, &language)?;
    invalidate_dictionary_cache(&state, &language)?;
    Ok(response)
}

#[tauri::command]
pub fn spellcheck_remove_installed_dictionary(
    language: String,
    app: AppHandle,
    state: tauri::State<'_, SpellcheckState>,
) -> Result<SpellcheckCatalogMutationResponse, String> {
    let response = remove_catalog_dictionary(&app, &language)?;
    invalidate_dictionary_cache(&state, &language)?;
    Ok(response)
}

#[tauri::command]
pub async fn spellcheck_check_grammar(
    text: String,
    language: Option<String>,
    server_url: Option<String>,
    app: AppHandle,
) -> Result<grammar::GrammarCheckResponse, String> {
    let resolved = resolve_language_selection(&app, language, None)?.primary;
    let url = grammar::resolve_server_url(server_url.as_deref());
    grammar::check_grammar(&text, &resolved, url).await
}

fn record_metrics(
    state: &tauri::State<'_, SpellcheckState>,
    update: impl FnOnce(&mut SpellcheckMetrics),
) -> Result<(), String> {
    let mut metrics = state.metrics.lock().map_err(|error| error.to_string())?;
    update(&mut metrics);
    Ok(())
}
