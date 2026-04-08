use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use tauri::{http, Manager, Runtime};
use neverwrite_vault::ScopedPathIntent;

pub use crate::technical_branding::FILE_PREVIEW_SCHEME;
use crate::technical_branding::{PRODUCT_CACHE_DIR_NAME, PRODUCT_STATE_DIR_NAME};
use crate::AppState;

pub fn handle_request<R: Runtime>(
    context: tauri::UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
) -> http::Response<Vec<u8>> {
    match parse_preview_request(request.uri()) {
        Ok(PreviewRequest::Vault {
            vault_path,
            relative_path,
        }) => match read_authorized_vault_preview_file(
            context.app_handle().state::<Mutex<AppState>>().inner(),
            &vault_path,
            &relative_path,
        ) {
            Ok(path) => build_file_response(&request, &path),
            Err(error) => error_response(http::StatusCode::FORBIDDEN, &error),
        },
        Err(error) => error_response(http::StatusCode::BAD_REQUEST, &error),
    }
}

enum PreviewRequest {
    Vault {
        vault_path: String,
        relative_path: String,
    },
}

fn parse_preview_request(uri: &http::Uri) -> Result<PreviewRequest, String> {
    let segments: Vec<&str> = uri
        .path()
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();

    if segments.len() != 3 || segments[0] != "vault" {
        return Err("Unsupported preview request".to_string());
    }

    let vault_path = decode_segment(segments[1])?;
    let relative_path = decode_segment(segments[2])?;

    Ok(PreviewRequest::Vault {
        vault_path,
        relative_path,
    })
}

fn decode_segment(value: &str) -> Result<String, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| "Invalid preview token".to_string())?;
    String::from_utf8(bytes).map_err(|_| "Invalid preview token".to_string())
}

fn read_authorized_vault_preview_file(
    state: &Mutex<AppState>,
    vault_path: &str,
    relative_path: &str,
) -> Result<PathBuf, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Internal preview state error: {error}"))?;
    let instance = state
        .vaults
        .get(vault_path)
        .ok_or("Vault preview is no longer available".to_string())?;
    let vault = instance
        .vault
        .as_ref()
        .ok_or("Vault preview is no longer available".to_string())?;
    let path = vault
        .resolve_scoped_path(relative_path, ScopedPathIntent::ReadExisting)
        .map_err(|error| error.to_string())?;

    if !path.is_file() {
        return Err("Preview target is not a file".to_string());
    }
    if path_is_hidden_preview_path(&vault.root, &path) {
        return Err("Preview target is not allowed".to_string());
    }

    Ok(path)
}

fn path_is_hidden_preview_path(vault_root: &Path, path: &Path) -> bool {
    const STATIC_HIDDEN_DIR_NAMES: &[&str] = &[
        ".obsidian",
        ".git",
        ".trash",
        "target",
        "node_modules",
        "vendor",
        ".cargo-home",
        ".claude",
    ];

    let Ok(relative_path) = path.strip_prefix(vault_root) else {
        return true;
    };

    relative_path.components().any(|component| match component {
        std::path::Component::Normal(name) => {
            let value = name.to_string_lossy();
            STATIC_HIDDEN_DIR_NAMES.contains(&value.as_ref())
                || value == PRODUCT_STATE_DIR_NAME
                || value == PRODUCT_CACHE_DIR_NAME
        }
        _ => false,
    })
}

fn build_file_response(request: &http::Request<Vec<u8>>, path: &Path) -> http::Response<Vec<u8>> {
    let builder = http::Response::builder()
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(http::header::CACHE_CONTROL, "no-store")
        .header(http::header::CONTENT_TYPE, detect_mime_type(path));

    if request.method() == http::Method::HEAD {
        return builder.body(Vec::new()).unwrap_or_else(|_| {
            error_response(
                http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to build preview response",
            )
        });
    }

    match fs::read(path) {
        Ok(bytes) => builder.body(bytes).unwrap_or_else(|_| {
            error_response(
                http::StatusCode::INTERNAL_SERVER_ERROR,
                "Failed to build preview response",
            )
        }),
        Err(error) => error_response(
            http::StatusCode::NOT_FOUND,
            &format!("Failed to read preview file: {error}"),
        ),
    }
}

fn error_response(status: http::StatusCode, message: &str) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(http::header::CACHE_CONTROL, "no-store")
        .header(http::header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .unwrap()
}

fn detect_mime_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    match extension.as_deref() {
        Some("pdf") => "application/pdf",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        Some("tif") | Some("tiff") => "image/tiff",
        Some("txt") => "text/plain; charset=utf-8",
        Some("md") => "text/markdown; charset=utf-8",
        Some("json") => "application/json",
        Some("toml") => "application/toml",
        Some("yaml") | Some("yml") => "application/yaml",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use neverwrite_vault::Vault;

    #[test]
    fn parse_preview_request_decodes_vault_and_relative_path() {
        let uri = format!(
            "{FILE_PREVIEW_SCHEME}://localhost/vault/{}/{}",
            URL_SAFE_NO_PAD.encode("/vault"),
            URL_SAFE_NO_PAD.encode("docs/spec.pdf")
        );
        let request = http::Uri::try_from(uri).unwrap();

        let parsed = parse_preview_request(&request).unwrap();

        match parsed {
            PreviewRequest::Vault {
                vault_path,
                relative_path,
            } => {
                assert_eq!(vault_path, "/vault");
                assert_eq!(relative_path, "docs/spec.pdf");
            }
        }
    }

    #[test]
    fn parse_preview_request_rejects_invalid_shape() {
        let request =
            http::Uri::try_from(format!("{FILE_PREVIEW_SCHEME}://localhost/invalid")).unwrap();

        assert!(parse_preview_request(&request).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn read_authorized_vault_preview_file_rejects_symlink_escape() {
        let dir = std::env::temp_dir().join(format!(
            "neverwrite-preview-gateway-test-{}",
            uuid::Uuid::new_v4()
        ));
        let outside = std::env::temp_dir().join(format!(
            "neverwrite-preview-gateway-outside-{}",
            uuid::Uuid::new_v4()
        ));

        fs::create_dir_all(dir.join("assets")).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.pdf"), b"secret").unwrap();
        symlink(&outside, dir.join("assets/link")).unwrap();

        let vault = Vault::open(dir.clone()).unwrap();
        let mut state = AppState::new();
        state.vaults.insert(
            dir.to_string_lossy().to_string(),
            crate::VaultInstance {
                vault: Some(vault),
                index: None,
                entries: None,
                non_note_search_index: None,
                graph_base_snapshot: None,
                graph_revision: 0,
                index_revision: 0,
                note_revisions: Default::default(),
                file_revisions: Default::default(),
                graph_query_cache: Default::default(),
                graph_query_cache_clock: 0,
                watcher: None,
                open_job_id: 0,
                open_cancel: None,
                open_state: crate::VaultOpenState::idle(),
            },
        );

        let result = read_authorized_vault_preview_file(
            &Mutex::new(state),
            &dir.to_string_lossy(),
            "assets/link/secret.pdf",
        );

        assert!(result.is_err());

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn read_authorized_vault_preview_file_rejects_hidden_internal_paths() {
        let dir = std::env::temp_dir().join(format!(
            "neverwrite-preview-gateway-hidden-{}",
            uuid::Uuid::new_v4()
        ));

        fs::create_dir_all(dir.join(PRODUCT_STATE_DIR_NAME)).unwrap();
        fs::write(
            dir.join(PRODUCT_STATE_DIR_NAME).join("secret.txt"),
            b"secret",
        )
        .unwrap();

        let vault = Vault::open(dir.clone()).unwrap();
        let mut state = AppState::new();
        state.vaults.insert(
            dir.to_string_lossy().to_string(),
            crate::VaultInstance {
                vault: Some(vault),
                index: None,
                entries: None,
                non_note_search_index: None,
                graph_base_snapshot: None,
                graph_revision: 0,
                index_revision: 0,
                note_revisions: Default::default(),
                file_revisions: Default::default(),
                graph_query_cache: Default::default(),
                graph_query_cache_clock: 0,
                watcher: None,
                open_job_id: 0,
                open_cancel: None,
                open_state: crate::VaultOpenState::idle(),
            },
        );

        let result = read_authorized_vault_preview_file(
            &Mutex::new(state),
            &dir.to_string_lossy(),
            &format!("{PRODUCT_STATE_DIR_NAME}/secret.txt"),
        );

        assert!(result.is_err());

        let _ = fs::remove_dir_all(&dir);
    }
}
