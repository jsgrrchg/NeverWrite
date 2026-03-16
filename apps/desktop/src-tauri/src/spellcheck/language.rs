use std::collections::BTreeSet;
use std::fs;

use tauri::AppHandle;

use super::bundled::bundled_dictionary;
use super::catalog::catalog_entries;
use super::storage::{
    ensure_spellcheck_directories, legacy_dictionary_path, pack_aff_path, pack_dic_path,
    pack_directory, pack_exists, pack_installation_path, user_dictionary_path,
};
use super::types::{
    ResolvedSpellcheckLanguage, SpellcheckLanguageInfo, SpellcheckLanguageSelection,
};

const LANGUAGE_DEFINITIONS: [(&str, &str); 2] =
    [("en-US", "English (US)"), ("es-ES", "Spanish (Spain)")];

fn is_builtin_language(language: &str) -> bool {
    LANGUAGE_DEFINITIONS.iter().any(|(id, _)| *id == language)
}

fn normalize_language_tag_case(input: &str) -> String {
    let normalized = input.trim().replace('_', "-");
    if normalized.is_empty() {
        return String::new();
    }

    normalized
        .split('-')
        .filter(|segment| !segment.is_empty())
        .enumerate()
        .map(|(index, segment)| {
            if index == 0 {
                segment.to_lowercase()
            } else if segment.len() == 2 && segment.chars().all(|ch| ch.is_ascii_alphabetic()) {
                segment.to_uppercase()
            } else if segment.chars().all(|ch| ch.is_ascii_digit()) {
                segment.to_string()
            } else {
                let mut chars = segment.chars();
                match chars.next() {
                    Some(first) => {
                        first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase()
                    }
                    None => String::new(),
                }
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

fn canonicalize_language(input: &str) -> String {
    let normalized = normalize_language_tag_case(input);

    match normalized.to_lowercase().as_str() {
        "" | "system" => "system".to_string(),
        "en" => "en-US".to_string(),
        "es" => "es-ES".to_string(),
        _ => normalized,
    }
}

fn current_system_language() -> String {
    std::env::var("LANG")
        .ok()
        .and_then(|value| value.split('.').next().map(str::to_string))
        .map(|value| value.replace('_', "-"))
        .unwrap_or_else(|| "en-US".to_string())
}

fn installed_language_ids(app: &AppHandle) -> Result<BTreeSet<String>, String> {
    let mut languages = BTreeSet::new();

    for entry in fs::read_dir(pack_directory(app)?).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let Some(language_id) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };

        if !pack_exists(app, language_id)? {
            continue;
        }

        languages.insert(language_id.to_string());
    }

    for entry in fs::read_dir(super::storage::legacy_dictionary_directory(app)?)
        .map_err(|error| error.to_string())?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        if path.extension().and_then(|extension| extension.to_str()) != Some("txt") {
            continue;
        }

        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };

        let language_id = stem.trim();
        if !language_id.is_empty() {
            languages.insert(language_id.to_string());
        }
    }

    Ok(languages)
}

pub fn resolve_language(
    app: &AppHandle,
    requested_language: Option<String>,
) -> Result<ResolvedSpellcheckLanguage, String> {
    ensure_spellcheck_directories(app)?;

    let requested = requested_language.unwrap_or_else(|| "system".to_string());
    let normalized_requested = canonicalize_language(requested.trim());
    let candidates = if normalized_requested.eq_ignore_ascii_case("system") {
        let system_language = canonicalize_language(&current_system_language());
        let mut candidates = vec![system_language.clone()];
        match system_language.split('-').next().unwrap_or_default() {
            "es" if system_language != "es-ES" => candidates.push("es-ES".to_string()),
            "en" if system_language != "en-US" => candidates.push("en-US".to_string()),
            _ => {}
        }
        if !candidates.iter().any(|candidate| candidate == "en-US") {
            candidates.push("en-US".to_string());
        }
        candidates
    } else {
        vec![normalized_requested]
    };

    for id in candidates {
        let has_pack = pack_exists(app, &id)?;
        let has_legacy_dictionary = legacy_dictionary_path(app, &id)?.exists();
        if is_builtin_language(&id) || has_pack || has_legacy_dictionary {
            let label = language_label(&id).unwrap_or_else(|| id.clone());
            return Ok(ResolvedSpellcheckLanguage { id, label });
        }
    }

    Err(format!(
        "Spellcheck dictionary is not installed for language {}",
        requested.trim()
    ))
}

pub fn resolve_language_selection(
    app: &AppHandle,
    primary_language: Option<String>,
    secondary_language: Option<String>,
) -> Result<SpellcheckLanguageSelection, String> {
    let primary = match resolve_language(app, primary_language.clone()) {
        Ok(language) => language.id,
        Err(_) => resolve_language(app, None)?.id,
    };
    let secondary = match secondary_language {
        Some(language) => {
            let trimmed = language.trim();
            if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("system") {
                None
            } else {
                match resolve_language(app, Some(trimmed.to_string())) {
                    Ok(language) => (language.id != primary).then_some(language.id),
                    Err(_) => None,
                }
            }
        }
        None => None,
    };

    Ok(SpellcheckLanguageSelection { primary, secondary })
}

fn language_label(language: &str) -> Option<String> {
    LANGUAGE_DEFINITIONS
        .iter()
        .find(|(id, _)| *id == language)
        .map(|(_, label)| (*label).to_string())
}

fn catalog_label(language: &str) -> Result<Option<String>, String> {
    Ok(catalog_entries()?
        .into_iter()
        .find(|entry| entry.id == language)
        .map(|entry| entry.label))
}

fn catalog_entry(language: &str) -> Result<Option<super::catalog::SpellcheckCatalogEntry>, String> {
    Ok(catalog_entries()?
        .into_iter()
        .find(|entry| entry.id == language))
}

pub fn list_supported_languages(app: &AppHandle) -> Result<Vec<SpellcheckLanguageInfo>, String> {
    ensure_spellcheck_directories(app)?;

    let mut language_ids = BTreeSet::new();
    language_ids.extend(LANGUAGE_DEFINITIONS.iter().map(|(id, _)| (*id).to_string()));
    language_ids.extend(installed_language_ids(app)?);
    language_ids.extend(catalog_entries()?.into_iter().map(|entry| entry.id));

    language_ids
        .into_iter()
        .map(|id| {
            let pack_path = pack_installation_path(app, &id)?;
            let aff_path = pack_aff_path(app, &id)?;
            let dic_path = pack_dic_path(app, &id)?;
            let legacy_path = legacy_dictionary_path(app, &id)?;
            let user_path = user_dictionary_path(app, &id)?;
            let installed_pack = pack_exists(app, &id)?;
            let installed_legacy = legacy_path.exists();
            let builtin = is_builtin_language(&id);
            let bundled = bundled_dictionary(&id);
            let catalog = catalog_entry(&id)?;

            let source = if installed_pack {
                "installed-pack"
            } else if installed_legacy {
                "legacy-installed"
            } else if builtin {
                "bundled-pack"
            } else {
                "not-installed"
            };

            let dictionary_path = if installed_pack {
                Some(pack_path.to_string_lossy().to_string())
            } else if installed_legacy {
                Some(legacy_path.to_string_lossy().to_string())
            } else {
                None
            };

            Ok(SpellcheckLanguageInfo {
                id: id.clone(),
                label: language_label(&id)
                    .or(catalog_label(&id)?)
                    .unwrap_or_else(|| id.clone()),
                available: builtin || installed_pack || installed_legacy,
                source: source.to_string(),
                dictionary_path,
                user_dictionary_path: user_path.to_string_lossy().to_string(),
                aff_path: installed_pack.then(|| aff_path.to_string_lossy().to_string()),
                dic_path: installed_pack.then(|| dic_path.to_string_lossy().to_string()),
                version: catalog
                    .as_ref()
                    .map(|metadata| metadata.version.clone())
                    .or_else(|| {
                        bundled
                            .as_ref()
                            .map(|metadata| metadata.version.to_string())
                    }),
                size_bytes: if installed_pack {
                    Some(
                        fs::metadata(&aff_path)
                            .map_err(|error| error.to_string())?
                            .len()
                            + fs::metadata(&dic_path)
                                .map_err(|error| error.to_string())?
                                .len(),
                    )
                } else {
                    bundled
                        .as_ref()
                        .map(|metadata| {
                            (metadata.aff.len()
                                + metadata.dic.len()
                                + metadata.license_text.len()
                                + metadata.readme_text.len()) as u64
                        })
                        .or_else(|| catalog.as_ref().map(|metadata| metadata.size_bytes))
                },
                license: catalog
                    .as_ref()
                    .map(|metadata| metadata.license.clone())
                    .or_else(|| {
                        bundled
                            .as_ref()
                            .map(|metadata| metadata.license.to_string())
                    }),
                homepage: catalog
                    .as_ref()
                    .map(|metadata| metadata.homepage.clone())
                    .or_else(|| {
                        bundled
                            .as_ref()
                            .map(|metadata| metadata.homepage.to_string())
                    }),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::canonicalize_language;

    #[test]
    fn canonicalizes_language_tags_case_and_aliases() {
        assert_eq!(canonicalize_language("EN_us"), "en-US");
        assert_eq!(canonicalize_language("en-gb"), "en-GB");
        assert_eq!(canonicalize_language("es_cl"), "es-CL");
        assert_eq!(canonicalize_language("pt-br"), "pt-BR");
    }
}
