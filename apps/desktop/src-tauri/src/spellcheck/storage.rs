use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

use super::engine::{bundled_hunspell_files_for_language, load_hunspell_bundle, DictionaryBundle};
use super::types::ResolvedSpellcheckLanguage;

pub fn app_spellcheck_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(base.join("spellcheck"))
}

pub fn pack_directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_spellcheck_directory(app)?.join("packs"))
}

pub fn legacy_dictionary_directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_spellcheck_directory(app)?.join("dictionaries"))
}

pub fn user_dictionary_directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_spellcheck_directory(app)?.join("user"))
}

pub fn cache_directory(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_spellcheck_directory(app)?.join("cache"))
}

pub fn ensure_spellcheck_directories(app: &AppHandle) -> Result<(), String> {
    for directory in [
        app_spellcheck_directory(app)?,
        pack_directory(app)?,
        legacy_dictionary_directory(app)?,
        user_dictionary_directory(app)?,
        cache_directory(app)?,
    ] {
        fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn dictionary_file_name(language: &str) -> String {
    format!("{language}.txt")
}

pub fn legacy_dictionary_path(app: &AppHandle, language: &str) -> Result<PathBuf, String> {
    Ok(legacy_dictionary_directory(app)?.join(dictionary_file_name(language)))
}

pub fn pack_installation_path(app: &AppHandle, language: &str) -> Result<PathBuf, String> {
    Ok(pack_directory(app)?.join(language))
}

pub fn pack_aff_path(app: &AppHandle, language: &str) -> Result<PathBuf, String> {
    Ok(pack_installation_path(app, language)?.join("dictionary.aff"))
}

pub fn pack_dic_path(app: &AppHandle, language: &str) -> Result<PathBuf, String> {
    Ok(pack_installation_path(app, language)?.join("dictionary.dic"))
}

pub fn pack_exists(app: &AppHandle, language: &str) -> Result<bool, String> {
    Ok(pack_aff_path(app, language)?.exists() && pack_dic_path(app, language)?.exists())
}

pub fn user_dictionary_path(app: &AppHandle, language: &str) -> Result<PathBuf, String> {
    Ok(user_dictionary_directory(app)?.join(dictionary_file_name(language)))
}

fn read_word_list(path: &Path) -> Result<HashSet<String>, String> {
    if !path.exists() {
        return Ok(HashSet::new());
    }

    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    Ok(content
        .lines()
        .map(|line| line.trim().to_lowercase())
        .filter(|line| !line.is_empty())
        .collect())
}

fn write_word_lines(path: &Path, words: &HashSet<String>) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Spellcheck path without parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;

    let mut sorted_words: Vec<&str> = words.iter().map(String::as_str).collect();
    sorted_words.sort_unstable();
    let serialized = if sorted_words.is_empty() {
        String::new()
    } else {
        format!("{}\n", sorted_words.join("\n"))
    };

    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, serialized).map_err(|error| error.to_string())?;
    fs::rename(&temp_path, path).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn write_word_to_user_dictionary(
    app: &AppHandle,
    language: &str,
    word: &str,
) -> Result<(), String> {
    let path = user_dictionary_path(app, language)?;
    let mut words = read_word_list(&path)?;
    words.insert(word.to_string());
    write_word_lines(&path, &words)
}

pub fn remove_word_from_user_dictionary(
    app: &AppHandle,
    language: &str,
    word: &str,
) -> Result<bool, String> {
    let path = user_dictionary_path(app, language)?;
    let mut words = read_word_list(&path)?;
    let removed = words.remove(word);
    write_word_lines(&path, &words)?;
    Ok(removed)
}

pub fn load_dictionary_bundle(
    app: &AppHandle,
    language: &ResolvedSpellcheckLanguage,
) -> Result<DictionaryBundle, String> {
    ensure_spellcheck_directories(app)?;

    let mut extra_words = read_word_list(&user_dictionary_path(app, &language.id)?)?;

    let legacy_path = legacy_dictionary_path(app, &language.id)?;
    if legacy_path.exists() {
        extra_words.extend(read_word_list(&legacy_path)?);
    }

    if pack_exists(app, &language.id)? {
        let aff_content = fs::read_to_string(pack_aff_path(app, &language.id)?)
            .map_err(|error| error.to_string())?;
        let dic_content = fs::read_to_string(pack_dic_path(app, &language.id)?)
            .map_err(|error| error.to_string())?;
        return load_hunspell_bundle(&language.id, &aff_content, &dic_content, extra_words);
    }

    if let Some(files) = bundled_hunspell_files_for_language(&language.id) {
        return load_hunspell_bundle(&language.id, &files.aff, &files.dic, extra_words);
    }

    Err(format!(
        "Spellcheck dictionary pack is not installed for language {}",
        language.id
    ))
}
