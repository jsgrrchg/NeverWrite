use std::fs;
use std::path::Path;

use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::AppHandle;

use super::storage::{
    app_spellcheck_directory, ensure_spellcheck_directories, pack_exists, pack_installation_path,
};

const CATALOG_JSON: &str = include_str!("catalog.json");

#[derive(Debug, Clone, Deserialize)]
pub struct SpellcheckCatalogEntry {
    pub id: String,
    pub label: String,
    pub version: String,
    pub source: String,
    pub license: String,
    pub homepage: String,
    pub bundled: bool,
    pub size_bytes: u64,
    pub aff_url: String,
    pub dic_url: String,
    pub license_url: String,
    pub readme_url: String,
    pub aff_sha256: String,
    pub dic_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpellcheckCatalogEntryDto {
    pub id: String,
    pub label: String,
    pub version: String,
    pub installed_version: Option<String>,
    pub source: String,
    pub license: String,
    pub homepage: String,
    pub bundled: bool,
    pub size_bytes: u64,
    pub installed: bool,
    pub update_available: bool,
    pub install_status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SpellcheckCatalogMutationResponse {
    pub language: String,
    pub installed: bool,
    pub install_path: Option<String>,
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

pub fn catalog_entries() -> Result<Vec<SpellcheckCatalogEntry>, String> {
    serde_json::from_str(CATALOG_JSON).map_err(|error| error.to_string())
}

pub fn list_catalog(app: &AppHandle) -> Result<Vec<SpellcheckCatalogEntryDto>, String> {
    ensure_spellcheck_directories(app)?;

    catalog_entries()?
        .into_iter()
        .map(|entry| {
            let installed = pack_exists(app, &entry.id)?;
            let installed_index = read_installed_pack_index(app, &entry.id)?;
            let installed_version = installed_index.as_ref().map(|index| index.version.clone());
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

pub fn install_catalog_dictionary(
    app: &AppHandle,
    language: &str,
) -> Result<SpellcheckCatalogMutationResponse, String> {
    ensure_spellcheck_directories(app)?;
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

    let install_path = pack_installation_path(app, &entry.id)?;
    let cache_path = app_spellcheck_directory(app)?.join("cache");
    let temp_path = cache_path.join(format!("install-{}", entry.id));
    let backup_path = cache_path.join(format!("install-{}-backup", entry.id));
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

    Ok(SpellcheckCatalogMutationResponse {
        language: entry.id,
        installed: true,
        install_path: Some(install_path.to_string_lossy().to_string()),
    })
}

pub fn remove_catalog_dictionary(
    app: &AppHandle,
    language: &str,
) -> Result<SpellcheckCatalogMutationResponse, String> {
    ensure_spellcheck_directories(app)?;
    let entry = catalog_entries()?
        .into_iter()
        .find(|entry| entry.id == language)
        .ok_or_else(|| format!("Spellcheck catalog entry not found for {language}"))?;

    if entry.bundled {
        return Err(format!("Bundled dictionary {language} cannot be removed"));
    }

    let install_path = pack_installation_path(app, language)?;
    if install_path.exists() {
        fs::remove_dir_all(&install_path).map_err(|error| error.to_string())?;
    }

    Ok(SpellcheckCatalogMutationResponse {
        language: entry.id,
        installed: false,
        install_path: Some(install_path.to_string_lossy().to_string()),
    })
}

fn download_optional(client: &Client, url: &str, destination: &Path) -> Result<(), String> {
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
    fs::write(destination, bytes).map_err(|error| error.to_string())?;
    Ok(())
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
        if !sha256_matches(&actual, expected_sha256) {
            return Err(format!(
                "Checksum mismatch for {url}: expected {expected_sha256}, got {actual}"
            ));
        }
    }

    fs::write(destination, bytes).map_err(|error| error.to_string())?;
    Ok(())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn sha256_matches(actual: &str, expected: &str) -> bool {
    actual.trim().eq_ignore_ascii_case(expected.trim())
}

fn installed_pack_index_path(
    app: &AppHandle,
    language: &str,
) -> Result<std::path::PathBuf, String> {
    Ok(pack_installation_path(app, language)?.join("index.json"))
}

fn read_installed_pack_index(
    app: &AppHandle,
    language: &str,
) -> Result<Option<InstalledPackIndex>, String> {
    let path = installed_pack_index_path(app, language)?;
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&content)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn write_installed_pack_index(path: &Path, index: &InstalledPackIndex) -> Result<(), String> {
    let content = serde_json::to_string_pretty(index).map_err(|error| error.to_string())?;
    fs::write(path, content).map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{catalog_entries, sha256_matches};

    #[test]
    fn loads_embedded_catalog_entries() {
        let catalog = catalog_entries().expect("catalog should parse");
        assert!(catalog.iter().any(|entry| entry.id == "es-CL"));
        assert!(catalog.iter().any(|entry| entry.id == "es-MX"));
    }

    #[test]
    fn checksum_matching_ignores_case_and_whitespace() {
        assert!(sha256_matches("abc123", " ABC123 "));
        assert!(!sha256_matches("abc123", "def456"));
    }
}
