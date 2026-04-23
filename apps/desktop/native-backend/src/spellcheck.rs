use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use spellbook::Dictionary;

const DEFAULT_GRAMMAR_SERVER_URL: &str = "https://api.languagetool.org";
const CATALOG_JSON: &str = include_str!("../../src-tauri/src/spellcheck/catalog.json");
const EN_US_AFF: &str = include_str!("../../src-tauri/src/spellcheck/bundled/en-US/dictionary.aff");
const EN_US_DIC: &str = include_str!("../../src-tauri/src/spellcheck/bundled/en-US/dictionary.dic");
const ES_ES_AFF: &str = include_str!("../../src-tauri/src/spellcheck/bundled/es-ES/dictionary.aff");
const ES_ES_DIC: &str = include_str!("../../src-tauri/src/spellcheck/bundled/es-ES/dictionary.dic");

const LANGUAGE_DEFINITIONS: [(&str, &str); 2] =
    [("en-US", "English (US)"), ("es-ES", "Spanish (Spain)")];

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

#[derive(Debug, Clone)]
struct ResolvedSpellcheckLanguage {
    id: String,
}

#[derive(Debug, Clone)]
struct DictionaryBundle {
    language: String,
    dictionary: Dictionary,
    custom_words: HashSet<String>,
}

#[derive(Debug, Clone)]
struct DictionarySelection {
    primary: DictionaryBundle,
    secondary: Option<DictionaryBundle>,
}

#[derive(Debug, Deserialize)]
struct SpellcheckCatalogEntry {
    id: String,
    label: String,
    version: String,
    source: String,
    license: String,
    homepage: String,
    bundled: bool,
    size_bytes: u64,
    aff_url: String,
    dic_url: String,
    license_url: String,
    readme_url: String,
    aff_sha256: String,
    dic_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
struct SpellcheckCatalogEntryDto {
    id: String,
    label: String,
    version: String,
    installed_version: Option<String>,
    source: String,
    license: String,
    homepage: String,
    bundled: bool,
    size_bytes: u64,
    size_known: bool,
    integrity_available: bool,
    installed: bool,
    update_available: bool,
    install_status: String,
}

#[derive(Debug, Clone, Serialize)]
struct SpellcheckCatalogMutationResponse {
    language: String,
    installed: bool,
    install_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstalledPackIndex {
    version: String,
    source: String,
    license: String,
    homepage: String,
    aff_sha256: String,
    dic_sha256: String,
}

#[derive(Debug)]
struct Token {
    start_utf16: usize,
    end_utf16: usize,
    raw: String,
}

pub struct SpellcheckState {
    cache: Mutex<HashMap<String, Arc<DictionaryBundle>>>,
    ignored_session_words: Mutex<HashSet<String>>,
    app_data_dir: PathBuf,
}

impl SpellcheckState {
    pub fn new() -> Self {
        Self {
            cache: Mutex::new(HashMap::new()),
            ignored_session_words: Mutex::new(HashSet::new()),
            app_data_dir: app_data_dir(),
        }
    }

    pub fn invoke(&self, command: &str, args: Value) -> Result<Value, String> {
        match command {
            "spellcheck_list_languages" => Ok(json!(self.list_languages()?)),
            "spellcheck_list_catalog" => Ok(json!(self.list_catalog()?)),
            "spellcheck_check_text" => {
                let selection = self.get_or_load_dictionary_selection(
                    optional_string(&args, &["language"]),
                    optional_string(&args, &["secondaryLanguage", "secondary_language"]),
                )?;
                let ignored_words = self
                    .ignored_session_words
                    .lock()
                    .map_err(|error| error.to_string())?
                    .clone();
                Ok(json!(check_text_spelling(
                    &required_string(&args, &["text"])?,
                    &selection,
                    &ignored_words
                )))
            }
            "spellcheck_suggest" => {
                let selection = self.get_or_load_dictionary_selection(
                    optional_string(&args, &["language"]),
                    optional_string(&args, &["secondaryLanguage", "secondary_language"]),
                )?;
                Ok(json!(build_suggestions(
                    &required_string(&args, &["word"])?,
                    &selection
                )))
            }
            "spellcheck_add_to_dictionary" => Ok(json!(self.add_to_dictionary(args)?)),
            "spellcheck_remove_from_dictionary" => Ok(json!(self.remove_from_dictionary(args)?)),
            "spellcheck_ignore_word" => Ok(json!(self.ignore_word(args)?)),
            "spellcheck_get_runtime_directory" => {
                self.ensure_directories()?;
                Ok(json!(self
                    .spellcheck_directory()
                    .to_string_lossy()
                    .to_string()))
            }
            "spellcheck_install_dictionary" => Ok(json!(self.install_dictionary(args)?)),
            "spellcheck_remove_installed_dictionary" => {
                Ok(json!(self.remove_installed_dictionary(args)?))
            }
            "spellcheck_check_grammar" => Ok(json!(self.check_grammar(args)?)),
            _ => Err(format!("Unknown spellcheck command: {command}")),
        }
    }

    fn list_languages(&self) -> Result<Vec<SpellcheckLanguageInfo>, String> {
        self.ensure_directories()?;
        let mut language_ids = BTreeSet::new();
        language_ids.extend(LANGUAGE_DEFINITIONS.iter().map(|(id, _)| (*id).to_string()));
        language_ids.extend(self.installed_language_ids()?);
        language_ids.extend(catalog_entries()?.into_iter().map(|entry| entry.id));

        language_ids
            .into_iter()
            .map(|id| {
                let installed_pack = self.pack_exists(&id);
                let legacy_path = self.legacy_dictionary_path(&id);
                let user_path = self.user_dictionary_path(&id);
                let catalog_entry = catalog_entries()?.into_iter().find(|entry| entry.id == id);
                let builtin = is_builtin_language(&id);
                let label = language_label(&id)
                    .or_else(|| catalog_entry.as_ref().map(|entry| entry.label.clone()))
                    .unwrap_or_else(|| id.clone());
                let source = if builtin {
                    "bundled".to_string()
                } else if installed_pack {
                    "installed".to_string()
                } else if legacy_path.exists() {
                    "user".to_string()
                } else {
                    "catalog".to_string()
                };

                Ok(SpellcheckLanguageInfo {
                    id: id.clone(),
                    label,
                    available: builtin || installed_pack || legacy_path.exists(),
                    source,
                    dictionary_path: installed_pack.then(|| {
                        self.pack_installation_path(&id)
                            .to_string_lossy()
                            .to_string()
                    }),
                    user_dictionary_path: user_path.to_string_lossy().to_string(),
                    aff_path: installed_pack
                        .then(|| self.pack_aff_path(&id).to_string_lossy().to_string()),
                    dic_path: installed_pack
                        .then(|| self.pack_dic_path(&id).to_string_lossy().to_string()),
                    version: catalog_entry.as_ref().map(|entry| entry.version.clone()),
                    size_bytes: catalog_entry.as_ref().map(|entry| entry.size_bytes),
                    license: catalog_entry.as_ref().map(|entry| entry.license.clone()),
                    homepage: catalog_entry.as_ref().map(|entry| entry.homepage.clone()),
                })
            })
            .collect()
    }

    fn list_catalog(&self) -> Result<Vec<SpellcheckCatalogEntryDto>, String> {
        self.ensure_directories()?;
        catalog_entries()?
            .into_iter()
            .map(|entry| {
                let installed = self.pack_exists(&entry.id);
                let installed_index = self.read_installed_pack_index(&entry.id)?;
                let installed_version = installed_index.as_ref().map(|index| index.version.clone());
                let integrity_available =
                    !entry.aff_sha256.trim().is_empty() && !entry.dic_sha256.trim().is_empty();
                let update_available = if installed && !entry.bundled && installed_index.is_none() {
                    true
                } else {
                    installed_index
                        .as_ref()
                        .map(|index| {
                            index.version != entry.version
                                || index.aff_sha256 != entry.aff_sha256
                                || index.dic_sha256 != entry.dic_sha256
                        })
                        .unwrap_or(false)
                };

                Ok(SpellcheckCatalogEntryDto {
                    id: entry.id,
                    label: entry.label,
                    version: entry.version,
                    installed_version,
                    source: entry.source,
                    license: entry.license,
                    homepage: entry.homepage,
                    bundled: entry.bundled,
                    size_bytes: entry.size_bytes,
                    size_known: entry.size_bytes > 0,
                    integrity_available,
                    installed,
                    update_available,
                    install_status: if entry.bundled {
                        "bundled".to_string()
                    } else if update_available {
                        "update-available".to_string()
                    } else if installed {
                        "installed".to_string()
                    } else {
                        "available".to_string()
                    },
                })
            })
            .collect()
    }

    fn add_to_dictionary(
        &self,
        args: Value,
    ) -> Result<SpellcheckDictionaryMutationResponse, String> {
        let resolved =
            self.resolve_primary_action_language(optional_string(&args, &["language"]))?;
        let word = normalize_dictionary_word(&required_string(&args, &["word"])?)
            .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;
        let normalized_key = normalize_dictionary_word_key(&word)
            .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;

        self.write_word_to_user_dictionary(&resolved, &word)?;
        self.invalidate_dictionary_cache(&resolved)?;
        self.ignored_session_words
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&ignored_session_key(&normalized_key));

        Ok(SpellcheckDictionaryMutationResponse {
            language: resolved.clone(),
            word,
            updated: true,
            user_dictionary_path: self
                .user_dictionary_path(&resolved)
                .to_string_lossy()
                .to_string(),
        })
    }

    fn remove_from_dictionary(
        &self,
        args: Value,
    ) -> Result<SpellcheckDictionaryMutationResponse, String> {
        let resolved =
            self.resolve_primary_action_language(optional_string(&args, &["language"]))?;
        let word = normalize_dictionary_word(&required_string(&args, &["word"])?)
            .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;
        let updated = self.remove_word_from_user_dictionary(&resolved, &word)?;
        self.invalidate_dictionary_cache(&resolved)?;

        Ok(SpellcheckDictionaryMutationResponse {
            language: resolved.clone(),
            word,
            updated,
            user_dictionary_path: self
                .user_dictionary_path(&resolved)
                .to_string_lossy()
                .to_string(),
        })
    }

    fn ignore_word(&self, args: Value) -> Result<SpellcheckDictionaryMutationResponse, String> {
        let resolved =
            self.resolve_primary_action_language(optional_string(&args, &["language"]))?;
        let word = normalize_dictionary_word(&required_string(&args, &["word"])?)
            .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;
        let normalized_key = normalize_dictionary_word_key(&word)
            .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;

        self.ignored_session_words
            .lock()
            .map_err(|error| error.to_string())?
            .insert(ignored_session_key(&normalized_key));

        Ok(SpellcheckDictionaryMutationResponse {
            language: resolved.clone(),
            word,
            updated: true,
            user_dictionary_path: self
                .user_dictionary_path(&resolved)
                .to_string_lossy()
                .to_string(),
        })
    }

    fn install_dictionary(&self, args: Value) -> Result<SpellcheckCatalogMutationResponse, String> {
        self.ensure_directories()?;
        let language = required_string(&args, &["language"])?;
        let entry = catalog_entries()?
            .into_iter()
            .find(|entry| entry.id == language)
            .ok_or_else(|| format!("Spellcheck catalog entry not found for {language}"))?;

        if entry.bundled {
            return Ok(SpellcheckCatalogMutationResponse {
                language: entry.id,
                installed: true,
                install_path: None,
            });
        }

        let client = Client::builder()
            .build()
            .map_err(|error| error.to_string())?;
        let install_path = self.pack_installation_path(&entry.id);
        let temp_path = self.cache_directory().join(format!("install-{}", entry.id));
        let backup_path = self
            .cache_directory()
            .join(format!("install-{}-backup", entry.id));
        if temp_path.exists() {
            fs::remove_dir_all(&temp_path).map_err(|error| error.to_string())?;
        }
        if backup_path.exists() {
            fs::remove_dir_all(&backup_path).map_err(|error| error.to_string())?;
        }
        fs::create_dir_all(&temp_path).map_err(|error| error.to_string())?;

        let install_result = (|| -> Result<(), String> {
            download_and_validate(
                &client,
                &entry.aff_url,
                &temp_path.join("dictionary.aff"),
                &entry.aff_sha256,
            )?;
            download_and_validate(
                &client,
                &entry.dic_url,
                &temp_path.join("dictionary.dic"),
                &entry.dic_sha256,
            )?;
            let _ = download_optional(&client, &entry.license_url, &temp_path.join("LICENSE.txt"));
            let _ = download_optional(&client, &entry.readme_url, &temp_path.join("README.txt"));
            write_installed_pack_index(
                &temp_path.join("index.json"),
                &InstalledPackIndex {
                    version: entry.version.clone(),
                    source: entry.source.clone(),
                    license: entry.license.clone(),
                    homepage: entry.homepage.clone(),
                    aff_sha256: entry.aff_sha256.clone(),
                    dic_sha256: entry.dic_sha256.clone(),
                },
            )?;

            if install_path.exists() {
                fs::rename(&install_path, &backup_path).map_err(|error| error.to_string())?;
            }
            if let Err(error) = fs::rename(&temp_path, &install_path) {
                if backup_path.exists() {
                    let _ = fs::rename(&backup_path, &install_path);
                }
                return Err(error.to_string());
            }
            if backup_path.exists() {
                let _ = fs::remove_dir_all(&backup_path);
            }
            Ok(())
        })();

        if install_result.is_err() {
            if temp_path.exists() {
                let _ = fs::remove_dir_all(&temp_path);
            }
            if backup_path.exists() && !install_path.exists() {
                let _ = fs::rename(&backup_path, &install_path);
            }
        }
        install_result?;
        self.invalidate_dictionary_cache(&entry.id)?;

        Ok(SpellcheckCatalogMutationResponse {
            language: entry.id,
            installed: true,
            install_path: Some(install_path.to_string_lossy().to_string()),
        })
    }

    fn remove_installed_dictionary(
        &self,
        args: Value,
    ) -> Result<SpellcheckCatalogMutationResponse, String> {
        self.ensure_directories()?;
        let language = required_string(&args, &["language"])?;
        let entry = catalog_entries()?
            .into_iter()
            .find(|entry| entry.id == language)
            .ok_or_else(|| format!("Spellcheck catalog entry not found for {language}"))?;
        if entry.bundled {
            return Err(format!("Bundled dictionary {language} cannot be removed"));
        }

        let install_path = self.pack_installation_path(&language);
        if install_path.exists() {
            fs::remove_dir_all(&install_path).map_err(|error| error.to_string())?;
        }
        self.invalidate_dictionary_cache(&language)?;

        Ok(SpellcheckCatalogMutationResponse {
            language,
            installed: false,
            install_path: Some(install_path.to_string_lossy().to_string()),
        })
    }

    fn check_grammar(&self, args: Value) -> Result<GrammarCheckResponse, String> {
        let language = self
            .resolve_language_selection(optional_string(&args, &["language"]), None)?
            .primary;
        let text = required_string(&args, &["text"])?;
        let server_url = optional_string(&args, &["serverUrl", "server_url"])
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_GRAMMAR_SERVER_URL.to_string());
        check_grammar_blocking(&text, &language, &server_url)
    }

    fn get_or_load_dictionary_selection(
        &self,
        primary_language: Option<String>,
        secondary_language: Option<String>,
    ) -> Result<DictionarySelection, String> {
        let selection = self.resolve_language_selection(primary_language, secondary_language)?;
        let primary = (*self.get_or_load_dictionary(Some(selection.primary.clone()))?).clone();
        let secondary = match selection.secondary.clone() {
            Some(language) => Some((*self.get_or_load_dictionary(Some(language))?).clone()),
            None => None,
        };
        Ok(DictionarySelection {
            primary,
            secondary: secondary.filter(|bundle| {
                selection
                    .secondary
                    .as_ref()
                    .is_some_and(|language| bundle.language == *language)
            }),
        })
    }

    fn get_or_load_dictionary(
        &self,
        requested_language: Option<String>,
    ) -> Result<Arc<DictionaryBundle>, String> {
        self.ensure_directories()?;
        let resolved = self.resolve_language(requested_language)?;
        if let Some(cached) = self
            .cache
            .lock()
            .map_err(|error| error.to_string())?
            .get(&resolved.id)
            .cloned()
        {
            return Ok(cached);
        }

        let bundle = Arc::new(self.load_dictionary_bundle(&resolved)?);
        self.cache
            .lock()
            .map_err(|error| error.to_string())?
            .insert(resolved.id, Arc::clone(&bundle));
        Ok(bundle)
    }

    fn resolve_primary_action_language(&self, language: Option<String>) -> Result<String, String> {
        Ok(self.resolve_language_selection(language, None)?.primary)
    }

    fn resolve_language(
        &self,
        requested_language: Option<String>,
    ) -> Result<ResolvedSpellcheckLanguage, String> {
        self.ensure_directories()?;
        let requested = requested_language.unwrap_or_else(|| "system".to_string());
        let normalized_requested = canonicalize_language(requested.trim());
        let candidates = if normalized_requested.eq_ignore_ascii_case("system") {
            build_language_candidates(&current_system_language())
        } else {
            build_language_candidates(&normalized_requested)
        };

        for id in candidates {
            let has_pack = self.pack_exists(&id);
            let has_legacy_dictionary = self.legacy_dictionary_path(&id).exists();
            if is_builtin_language(&id) || has_pack || has_legacy_dictionary {
                return Ok(ResolvedSpellcheckLanguage { id });
            }
        }

        Err(format!(
            "Spellcheck dictionary is not installed for language {}",
            requested.trim()
        ))
    }

    fn resolve_language_selection(
        &self,
        primary_language: Option<String>,
        secondary_language: Option<String>,
    ) -> Result<LanguageSelection, String> {
        let primary = match self.resolve_language(primary_language.clone()) {
            Ok(language) => language.id,
            Err(_) => self.resolve_language(None)?.id,
        };
        let secondary = match secondary_language {
            Some(language) => {
                let trimmed = language.trim();
                if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("system") {
                    None
                } else {
                    match self.resolve_language(Some(trimmed.to_string())) {
                        Ok(language) => (language.id != primary).then_some(language.id),
                        Err(_) => None,
                    }
                }
            }
            None => None,
        };

        Ok(LanguageSelection { primary, secondary })
    }

    fn load_dictionary_bundle(
        &self,
        language: &ResolvedSpellcheckLanguage,
    ) -> Result<DictionaryBundle, String> {
        let mut extra_words = read_word_list(&self.user_dictionary_path(&language.id))?;
        let legacy_path = self.legacy_dictionary_path(&language.id);
        if legacy_path.exists() {
            extra_words.extend(read_word_list(&legacy_path)?);
        }

        if self.pack_exists(&language.id) {
            let aff_content = fs::read_to_string(self.pack_aff_path(&language.id))
                .map_err(|error| error.to_string())?;
            let dic_content = fs::read_to_string(self.pack_dic_path(&language.id))
                .map_err(|error| error.to_string())?;
            return load_hunspell_bundle(&language.id, &aff_content, &dic_content, extra_words);
        }

        if let Some((aff, dic)) = bundled_hunspell_files_for_language(&language.id) {
            return load_hunspell_bundle(&language.id, aff, dic, extra_words);
        }

        Err(format!(
            "Spellcheck dictionary pack is not installed for language {}",
            language.id
        ))
    }

    fn ensure_directories(&self) -> Result<(), String> {
        for directory in [
            self.spellcheck_directory(),
            self.pack_directory(),
            self.legacy_dictionary_directory(),
            self.user_dictionary_directory(),
            self.cache_directory(),
        ] {
            fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn spellcheck_directory(&self) -> PathBuf {
        self.app_data_dir.join("spellcheck")
    }

    fn pack_directory(&self) -> PathBuf {
        self.spellcheck_directory().join("packs")
    }

    fn legacy_dictionary_directory(&self) -> PathBuf {
        self.spellcheck_directory().join("dictionaries")
    }

    fn user_dictionary_directory(&self) -> PathBuf {
        self.spellcheck_directory().join("user")
    }

    fn cache_directory(&self) -> PathBuf {
        self.spellcheck_directory().join("cache")
    }

    fn legacy_dictionary_path(&self, language: &str) -> PathBuf {
        self.legacy_dictionary_directory()
            .join(dictionary_file_name(language))
    }

    fn pack_installation_path(&self, language: &str) -> PathBuf {
        self.pack_directory().join(language)
    }

    fn pack_aff_path(&self, language: &str) -> PathBuf {
        self.pack_installation_path(language).join("dictionary.aff")
    }

    fn pack_dic_path(&self, language: &str) -> PathBuf {
        self.pack_installation_path(language).join("dictionary.dic")
    }

    fn pack_exists(&self, language: &str) -> bool {
        self.pack_aff_path(language).exists() && self.pack_dic_path(language).exists()
    }

    fn user_dictionary_path(&self, language: &str) -> PathBuf {
        self.user_dictionary_directory()
            .join(dictionary_file_name(language))
    }

    fn installed_language_ids(&self) -> Result<BTreeSet<String>, String> {
        let mut languages = BTreeSet::new();

        for entry in fs::read_dir(self.pack_directory()).map_err(|error| error.to_string())? {
            let path = entry.map_err(|error| error.to_string())?.path();
            if !path.is_dir() {
                continue;
            }
            let Some(language_id) = path.file_name().and_then(|name| name.to_str()) else {
                continue;
            };
            if self.pack_exists(language_id) {
                languages.insert(language_id.to_string());
            }
        }

        for entry in
            fs::read_dir(self.legacy_dictionary_directory()).map_err(|error| error.to_string())?
        {
            let path = entry.map_err(|error| error.to_string())?.path();
            if !path.is_file() || path.extension().and_then(|ext| ext.to_str()) != Some("txt") {
                continue;
            }
            if let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) {
                if !stem.trim().is_empty() {
                    languages.insert(stem.trim().to_string());
                }
            }
        }

        Ok(languages)
    }

    fn read_installed_pack_index(
        &self,
        language: &str,
    ) -> Result<Option<InstalledPackIndex>, String> {
        let path = self.pack_installation_path(language).join("index.json");
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
        serde_json::from_str(&content)
            .map(Some)
            .map_err(|error| error.to_string())
    }

    fn write_word_to_user_dictionary(&self, language: &str, word: &str) -> Result<(), String> {
        let path = self.user_dictionary_path(language);
        let mut words = read_word_list(&path)?;
        let normalized = normalize_dictionary_word_key(word)
            .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;
        words.retain(|existing| {
            normalize_dictionary_word_key(existing).as_deref() != Some(normalized.as_str())
        });
        words.insert(word.to_string());
        write_word_lines(&path, &words)
    }

    fn remove_word_from_user_dictionary(&self, language: &str, word: &str) -> Result<bool, String> {
        let path = self.user_dictionary_path(language);
        let mut words = read_word_list(&path)?;
        let normalized = normalize_dictionary_word_key(word)
            .ok_or_else(|| "Word must be a single spellcheck token".to_string())?;
        let original_len = words.len();
        words.retain(|existing| {
            normalize_dictionary_word_key(existing).as_deref() != Some(normalized.as_str())
        });
        let removed = words.len() != original_len;
        write_word_lines(&path, &words)?;
        Ok(removed)
    }

    fn invalidate_dictionary_cache(&self, language: &str) -> Result<(), String> {
        self.cache
            .lock()
            .map_err(|error| error.to_string())?
            .remove(language);
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LanguageSelection {
    primary: String,
    secondary: Option<String>,
}

fn dictionary_file_name(language: &str) -> String {
    format!("{language}.txt")
}

fn catalog_entries() -> Result<Vec<SpellcheckCatalogEntry>, String> {
    serde_json::from_str(CATALOG_JSON).map_err(|error| error.to_string())
}

fn bundled_hunspell_files_for_language(language: &str) -> Option<(&'static str, &'static str)> {
    match language {
        "en-US" => Some((EN_US_AFF, EN_US_DIC)),
        "es-ES" => Some((ES_ES_AFF, ES_ES_DIC)),
        _ => None,
    }
}

fn load_hunspell_bundle(
    language: &str,
    aff_content: &str,
    dic_content: &str,
    extra_words: impl IntoIterator<Item = String>,
) -> Result<DictionaryBundle, String> {
    let mut dictionary =
        Dictionary::new(aff_content, dic_content).map_err(|error| error.to_string())?;
    let mut custom_words = HashSet::new();

    for word in extra_words {
        if let Some(normalized) = normalize_dictionary_word(&word) {
            dictionary
                .add(&normalized)
                .map_err(|error| error.to_string())?;
            if let Some(key) = normalize_dictionary_word_key(&normalized) {
                custom_words.insert(key);
            }
        }
    }

    Ok(DictionaryBundle {
        language: language.to_string(),
        dictionary,
        custom_words,
    })
}

fn check_text_spelling(
    text: &str,
    selection: &DictionarySelection,
    ignored_session_words: &HashSet<String>,
) -> SpellcheckCheckTextResponse {
    let diagnostics = tokenize_words(text)
        .into_iter()
        .filter(|token| should_check_word(&token.raw))
        .filter(|token| {
            let normalized = normalize_word(&token.raw);
            let primary_correct = selection.primary.dictionary.check(&token.raw);
            let primary_custom_correct = custom_word_matches(&selection.primary, &token.raw);
            let secondary_correct = selection
                .secondary
                .as_ref()
                .is_some_and(|bundle| bundle.dictionary.check(&token.raw));
            let secondary_custom_correct = selection
                .secondary
                .as_ref()
                .is_some_and(|bundle| custom_word_matches(bundle, &token.raw));
            !normalized.is_empty()
                && !primary_correct
                && !primary_custom_correct
                && !secondary_correct
                && !secondary_custom_correct
                && !ignored_session_words.contains(&ignored_session_key(&normalized))
        })
        .map(|token| SpellcheckDiagnostic {
            start_utf16: token.start_utf16,
            end_utf16: token.end_utf16,
            word: token.raw,
        })
        .collect();

    SpellcheckCheckTextResponse {
        language: selection.primary.language.clone(),
        secondary_language: selection
            .secondary
            .as_ref()
            .map(|bundle| bundle.language.clone()),
        diagnostics,
    }
}

fn build_suggestions(word: &str, selection: &DictionarySelection) -> SpellcheckSuggestionResponse {
    let primary_correct =
        selection.primary.dictionary.check(word) || custom_word_matches(&selection.primary, word);
    let secondary_correct = selection
        .secondary
        .as_ref()
        .is_some_and(|bundle| bundle.dictionary.check(word) || custom_word_matches(bundle, word));
    let correct = primary_correct || secondary_correct;
    let mut suggestions = Vec::new();
    selection.primary.dictionary.suggest(word, &mut suggestions);
    if let Some(secondary) = &selection.secondary {
        let mut secondary_suggestions = Vec::new();
        secondary
            .dictionary
            .suggest(word, &mut secondary_suggestions);
        suggestions.extend(secondary_suggestions);
    }
    suggestions.dedup();
    suggestions.truncate(6);

    SpellcheckSuggestionResponse {
        language: selection.primary.language.clone(),
        secondary_language: selection
            .secondary
            .as_ref()
            .map(|bundle| bundle.language.clone()),
        word: word.to_string(),
        correct,
        suggestions,
    }
}

fn tokenize_words(text: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut current_start = None;
    let mut current_utf16_start = 0usize;
    let mut current_word = String::new();
    let mut utf16_index = 0usize;
    let mut previous_was_letter = false;

    for ch in text.chars() {
        let is_joiner = matches!(ch, '\'' | '’' | '-');
        let starts_or_continues_word = ch.is_alphabetic() || (is_joiner && previous_was_letter);

        if starts_or_continues_word {
            if current_start.is_none() {
                current_start = Some(utf16_index);
                current_utf16_start = utf16_index;
                current_word.clear();
            }
            current_word.push(ch);
        } else if current_start.is_some() {
            tokens.push(Token {
                start_utf16: current_utf16_start,
                end_utf16: utf16_index,
                raw: current_word.clone(),
            });
            current_start = None;
            current_word.clear();
        }

        previous_was_letter = ch.is_alphabetic();
        utf16_index += ch.len_utf16();
    }

    if current_start.is_some() {
        tokens.push(Token {
            start_utf16: current_utf16_start,
            end_utf16: utf16_index,
            raw: current_word,
        });
    }

    tokens
}

fn normalize_dictionary_word(word: &str) -> Option<String> {
    let normalized = trim_dictionary_word(word);
    if normalized.is_empty() || normalized.chars().any(char::is_whitespace) {
        return None;
    }
    if !normalized
        .chars()
        .all(|ch| ch.is_alphabetic() || matches!(ch, '\'' | '’' | '-'))
    {
        return None;
    }
    should_check_word(&normalized).then_some(normalized)
}

fn normalize_dictionary_word_key(word: &str) -> Option<String> {
    normalize_dictionary_word(word).map(|normalized| normalized.to_lowercase())
}

fn ignored_session_key(word: &str) -> String {
    word.to_string()
}

fn should_check_word(word: &str) -> bool {
    word.chars().filter(|ch| ch.is_alphabetic()).count() >= 2
}

fn trim_dictionary_word(word: &str) -> String {
    word.trim_matches(|ch: char| !ch.is_alphabetic() && ch != '\'' && ch != '’')
        .to_string()
}

fn normalize_word(word: &str) -> String {
    trim_dictionary_word(word).to_lowercase()
}

fn custom_word_matches(bundle: &DictionaryBundle, word: &str) -> bool {
    normalize_dictionary_word_key(word)
        .is_some_and(|normalized| bundle.custom_words.contains(&normalized))
}

fn is_builtin_language(language: &str) -> bool {
    LANGUAGE_DEFINITIONS.iter().any(|(id, _)| *id == language)
}

fn language_label(language: &str) -> Option<String> {
    LANGUAGE_DEFINITIONS
        .iter()
        .find(|(id, _)| *id == language)
        .map(|(_, label)| (*label).to_string())
}

fn canonicalize_language(input: &str) -> String {
    let normalized = input.trim().replace('_', "-");
    if normalized.is_empty() {
        return String::new();
    }
    let normalized = normalized
        .split('-')
        .filter(|segment| !segment.is_empty())
        .enumerate()
        .map(|(index, segment)| {
            if index == 0 {
                segment.to_lowercase()
            } else if segment.len() == 2 && segment.chars().all(|ch| ch.is_ascii_alphabetic()) {
                segment.to_uppercase()
            } else {
                segment.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("-");

    match normalized.to_lowercase().as_str() {
        "" | "system" => "system".to_string(),
        "en" => "en-US".to_string(),
        "es" => "es-ES".to_string(),
        _ => normalized,
    }
}

fn build_language_candidates(input: &str) -> Vec<String> {
    let normalized = canonicalize_language(input);
    if normalized.is_empty() {
        return Vec::new();
    }

    let mut candidates = Vec::new();
    push_unique(&mut candidates, normalized.clone());
    let mut segments: Vec<&str> = normalized.split('-').collect();
    while segments.len() > 1 {
        segments.pop();
        push_unique(&mut candidates, canonicalize_language(&segments.join("-")));
    }
    push_unique(&mut candidates, "en-US".to_string());
    candidates
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !value.is_empty() && !values.contains(&value) {
        values.push(value);
    }
}

fn current_system_language() -> String {
    for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(value) = std::env::var(key) {
            let normalized = value
                .trim()
                .split('.')
                .next()
                .unwrap_or_default()
                .split('@')
                .next()
                .unwrap_or_default()
                .replace('_', "-");
            if normalized.is_empty() {
                continue;
            }
            match normalized.to_ascii_lowercase().as_str() {
                "c" | "posix" => return "en-US".to_string(),
                _ => return normalized,
            }
        }
    }
    "en-US".to_string()
}

fn read_word_list(path: &Path) -> Result<HashSet<String>, String> {
    if !path.exists() {
        return Ok(HashSet::new());
    }
    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    Ok(content
        .lines()
        .map(|line| line.trim().to_string())
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
    fs::rename(&temp_path, path).map_err(|error| error.to_string())
}

fn download_optional(client: &Client, url: &str, destination: &Path) -> Result<(), String> {
    if url.trim().is_empty() {
        return Ok(());
    }
    let response = match client.get(url).send() {
        Ok(response) => response,
        Err(_) => return Ok(()),
    };
    if !response.status().is_success() {
        return Ok(());
    }
    let bytes = match response.bytes() {
        Ok(bytes) => bytes,
        Err(_) => return Ok(()),
    };
    fs::write(destination, bytes).map_err(|error| error.to_string())
}

fn download_and_validate(
    client: &Client,
    url: &str,
    destination: &Path,
    expected_sha256: &str,
) -> Result<(), String> {
    let response = client.get(url).send().map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Failed to download {url}: {}", response.status()));
    }
    let bytes = response.bytes().map_err(|error| error.to_string())?;
    if !expected_sha256.is_empty() {
        let actual = sha256_hex(bytes.as_ref());
        if !actual.trim().eq_ignore_ascii_case(expected_sha256.trim()) {
            return Err(format!(
                "Checksum mismatch for {url}: expected {expected_sha256}, got {actual}"
            ));
        }
    }
    fs::write(destination, bytes).map_err(|error| error.to_string())
}

fn write_installed_pack_index(path: &Path, index: &InstalledPackIndex) -> Result<(), String> {
    let content = serde_json::to_vec(index).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[derive(Debug, Clone, Serialize)]
struct GrammarDiagnostic {
    start_utf16: usize,
    end_utf16: usize,
    message: String,
    short_message: Option<String>,
    replacements: Vec<String>,
    rule_id: String,
    rule_description: String,
    issue_type: String,
    category_id: String,
    category_name: String,
}

#[derive(Debug, Clone, Serialize)]
struct GrammarCheckResponse {
    language: String,
    diagnostics: Vec<GrammarDiagnostic>,
}

#[derive(Deserialize)]
struct LTResponse {
    language: LTLanguage,
    matches: Vec<LTMatch>,
}

#[derive(Deserialize)]
struct LTLanguage {
    code: String,
}

#[derive(Deserialize)]
struct LTMatch {
    message: String,
    #[serde(rename = "shortMessage")]
    short_message: Option<String>,
    offset: usize,
    length: usize,
    replacements: Vec<LTReplacement>,
    rule: LTRule,
}

#[derive(Deserialize)]
struct LTReplacement {
    value: String,
}

#[derive(Deserialize)]
struct LTRule {
    id: String,
    description: String,
    #[serde(rename = "issueType")]
    issue_type: Option<String>,
    category: LTCategory,
}

#[derive(Deserialize)]
struct LTCategory {
    id: String,
    name: String,
}

fn check_grammar_blocking(
    text: &str,
    language: &str,
    server_url: &str,
) -> Result<GrammarCheckResponse, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| format!("Failed to build HTTP client: {error}"))?;
    let url = format!("{}/v2/check", server_url.trim_end_matches('/'));
    let body = format!(
        "text={}&language={}",
        percent_encode(text),
        percent_encode(language)
    );
    let response = client
        .post(&url)
        .header("Content-Type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .map_err(|error| format!("Grammar check request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("Grammar check failed: HTTP {}", response.status()));
    }
    let response_text = response
        .text()
        .map_err(|error| format!("Failed to read grammar check response: {error}"))?;
    let lt_response: LTResponse = serde_json::from_str(&response_text)
        .map_err(|error| format!("Failed to parse grammar check response: {error}"))?;
    let diagnostics = lt_response
        .matches
        .into_iter()
        .filter_map(|match_item| {
            let start_utf16 = char_offset_to_utf16(text, match_item.offset)?;
            let end_utf16 = char_offset_to_utf16(text, match_item.offset + match_item.length)?;
            Some(GrammarDiagnostic {
                start_utf16,
                end_utf16,
                message: match_item.message,
                short_message: match_item.short_message,
                replacements: match_item
                    .replacements
                    .into_iter()
                    .take(5)
                    .map(|replacement| replacement.value)
                    .collect(),
                rule_id: match_item.rule.id,
                rule_description: match_item.rule.description,
                issue_type: match_item.rule.issue_type.unwrap_or_default(),
                category_id: match_item.rule.category.id,
                category_name: match_item.rule.category.name,
            })
        })
        .collect();

    Ok(GrammarCheckResponse {
        language: lt_response.language.code,
        diagnostics,
    })
}

fn percent_encode(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'*' => {
                out.push(byte as char);
            }
            b' ' => out.push('+'),
            _ => {
                out.push('%');
                out.push(char::from(HEX[(byte >> 4) as usize]));
                out.push(char::from(HEX[(byte & 0x0f) as usize]));
            }
        }
    }
    out
}

const HEX: [u8; 16] = *b"0123456789ABCDEF";

fn char_offset_to_utf16(text: &str, char_offset: usize) -> Option<usize> {
    let mut utf16_offset = 0;
    let mut char_count = 0;
    for ch in text.chars() {
        if char_count == char_offset {
            return Some(utf16_offset);
        }
        utf16_offset += ch.len_utf16();
        char_count += 1;
    }
    (char_offset == char_count).then_some(utf16_offset)
}

fn app_data_dir() -> PathBuf {
    if let Ok(path) = std::env::var("NEVERWRITE_APP_DATA_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("NeverWrite");
        }
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return PathBuf::from(appdata).join("NeverWrite");
        }
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Some(xdg_data_home) = std::env::var_os("XDG_DATA_HOME") {
            return PathBuf::from(xdg_data_home).join("NeverWrite");
        }
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("NeverWrite");
        }
    }

    std::env::temp_dir().join("NeverWrite")
}

fn required_string(args: &Value, keys: &[&str]) -> Result<String, String> {
    for key in keys {
        if let Some(value) = args.get(*key).and_then(Value::as_str) {
            let trimmed = value.trim();
            if !trimmed.is_empty() {
                return Ok(trimmed.to_string());
            }
        }
    }
    Err(format!("Missing argument: {}", keys[0]))
}

fn optional_string(args: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| args.get(*key).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_misspelled_words_with_utf16_offsets() {
        let selection = DictionarySelection {
            primary: load_hunspell_bundle(
                "en-US",
                "SET UTF-8\nTRY esiarntolcdugmphbyfvkwzxjq\n",
                "3\nhello\nworld\nadios\n",
                std::iter::empty(),
            )
            .expect("dictionary"),
            secondary: None,
        };
        let result = check_text_spelling("hello wrld adios", &selection, &HashSet::new());
        assert_eq!(result.diagnostics.len(), 1);
        assert_eq!(result.diagnostics[0].word, "wrld");
        assert_eq!(result.diagnostics[0].start_utf16, 6);
        assert_eq!(result.diagnostics[0].end_utf16, 10);
    }

    #[test]
    fn normalizes_language_aliases() {
        assert_eq!(canonicalize_language("en"), "en-US");
        assert_eq!(canonicalize_language("es_es"), "es-ES");
        assert_eq!(canonicalize_language("system"), "system");
    }

    #[test]
    fn converts_grammar_offsets_to_utf16() {
        assert_eq!(char_offset_to_utf16("A😀B", 0), Some(0));
        assert_eq!(char_offset_to_utf16("A😀B", 1), Some(1));
        assert_eq!(char_offset_to_utf16("A😀B", 2), Some(3));
        assert_eq!(char_offset_to_utf16("A😀B", 3), Some(4));
    }
}
