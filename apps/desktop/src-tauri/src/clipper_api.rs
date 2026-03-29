use std::{collections::BTreeSet, env, fs, path::PathBuf, thread};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use uuid::Uuid;

use crate::{
    web_clipper_list_folders, web_clipper_list_tags, web_clipper_ready_vaults,
    web_clipper_save_note,
};

const WEB_CLIPPER_API_PORT: u16 = 32145;
const CHROME_EXTENSION_ID: &str = "pogmjgibofkooljfgaandhoinmenfhao";
const FIREFOX_EXTENSION_ID: &str = "web-clipper@vaultai.app";
const WEB_CLIPPER_DEV_ORIGINS_ENV: &str = "VAULTAI_WEB_CLIPPER_DEV_ORIGINS";
const WEB_CLIPPER_ALLOW_HEADERS: &str =
    "content-type,x-vaultai-clipper-token,x-vaultai-extension-id";
const WEB_CLIPPER_TOKEN_HEADER: &str = "X-VaultAI-Clipper-Token";
const WEB_CLIPPER_EXTENSION_ID_HEADER: &str = "X-VaultAI-Extension-Id";
const WEB_CLIPPER_AUTH_FILE: &str = "web_clipper_auth.json";

#[derive(Debug, Clone, PartialEq, Eq)]
enum ClipperOriginAuthError {
    MissingOrigin,
    OriginNotAllowed,
    MissingExtensionId,
    ExtensionNotAllowed,
    PairingRequired,
    InvalidToken,
    AuthUnavailable,
}

impl ClipperOriginAuthError {
    fn status_code(&self) -> StatusCode {
        match self {
            Self::MissingOrigin => StatusCode(401),
            Self::OriginNotAllowed => StatusCode(403),
            Self::MissingExtensionId => StatusCode(401),
            Self::ExtensionNotAllowed => StatusCode(403),
            Self::PairingRequired => StatusCode(401),
            Self::InvalidToken => StatusCode(403),
            Self::AuthUnavailable => StatusCode(500),
        }
    }

    fn message(&self) -> &'static str {
        match self {
            Self::MissingOrigin => "Web clipper origin is required.",
            Self::OriginNotAllowed => "Web clipper origin is not allowed.",
            Self::MissingExtensionId => "Web clipper extension identity is required.",
            Self::ExtensionNotAllowed => "Web clipper extension is not allowed.",
            Self::PairingRequired => "Web clipper pairing is required.",
            Self::InvalidToken => "Web clipper token is invalid.",
            Self::AuthUnavailable => "Web clipper authentication is unavailable.",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ExtensionIdentity {
    OfficialChrome,
    OfficialFirefox,
    ExplicitDev,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AuthorizedClipper {
    origin: String,
    identity: ExtensionIdentity,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WebClipperAuthState {
    token: String,
    firefox_origin: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LookupRequest {
    vault_path_hint: Option<String>,
    vault_name_hint: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SaveClipRequest {
    request_id: String,
    title: String,
    content: String,
    folder: String,
    #[allow(dead_code)]
    #[serde(default)]
    tags: Vec<String>,
    #[allow(dead_code)]
    #[serde(default)]
    source_url: String,
    vault_path_hint: Option<String>,
    vault_name_hint: Option<String>,
}

fn json_header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid web clipper api header")
}

fn request_origin(request: &tiny_http::Request) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Origin"))
        .map(|header| header.value.as_str().trim().to_string())
        .filter(|origin| !origin.is_empty())
}

fn request_header_value(request: &tiny_http::Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| match name {
            WEB_CLIPPER_TOKEN_HEADER => header.field.equiv(WEB_CLIPPER_TOKEN_HEADER),
            WEB_CLIPPER_EXTENSION_ID_HEADER => header.field.equiv(WEB_CLIPPER_EXTENSION_ID_HEADER),
            _ => false,
        })
        .map(|header| header.value.as_str().trim().to_string())
        .filter(|value| !value.is_empty())
}

fn parse_dev_origins(raw: &str) -> Vec<String> {
    raw.split([',', ';', '\n'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| is_extension_origin(value))
        .map(str::to_string)
        .collect()
}

fn is_extension_origin(origin: &str) -> bool {
    origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://")
}

fn is_chrome_extension_origin(origin: &str) -> bool {
    origin.starts_with("chrome-extension://")
}

fn is_firefox_extension_origin(origin: &str) -> bool {
    origin.starts_with("moz-extension://")
}

fn allowed_browser_origins() -> BTreeSet<String> {
    allowed_browser_origins_with_dev_origins(
        env::var(WEB_CLIPPER_DEV_ORIGINS_ENV)
            .ok()
            .map(|raw| parse_dev_origins(&raw))
            .unwrap_or_default(),
    )
}

fn allowed_browser_origins_with_dev_origins(dev_origins: Vec<String>) -> BTreeSet<String> {
    let mut origins = BTreeSet::from([
        format!("chrome-extension://{CHROME_EXTENSION_ID}"),
        format!("moz-extension://{FIREFOX_EXTENSION_ID}"),
    ]);
    origins.extend(dev_origins);
    origins
}

fn resolve_extension_identity(
    origin: Option<&str>,
    extension_id: Option<&str>,
) -> Result<AuthorizedClipper, ClipperOriginAuthError> {
    let origin = origin
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(ClipperOriginAuthError::MissingOrigin)?;
    let extension_id = extension_id
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or(ClipperOriginAuthError::MissingExtensionId)?;

    if !is_extension_origin(origin) {
        return Err(ClipperOriginAuthError::OriginNotAllowed);
    }

    if extension_id == CHROME_EXTENSION_ID
        && origin == format!("chrome-extension://{CHROME_EXTENSION_ID}")
    {
        return Ok(AuthorizedClipper {
            origin: origin.to_string(),
            identity: ExtensionIdentity::OfficialChrome,
        });
    }

    if extension_id == FIREFOX_EXTENSION_ID && is_firefox_extension_origin(origin) {
        return Ok(AuthorizedClipper {
            origin: origin.to_string(),
            identity: ExtensionIdentity::OfficialFirefox,
        });
    }

    if allowed_browser_origins().contains(origin) {
        return Ok(AuthorizedClipper {
            origin: origin.to_string(),
            identity: ExtensionIdentity::ExplicitDev,
        });
    }

    if is_chrome_extension_origin(origin) || is_firefox_extension_origin(origin) {
        return Err(ClipperOriginAuthError::ExtensionNotAllowed);
    }

    Err(ClipperOriginAuthError::OriginNotAllowed)
}

fn web_clipper_auth_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error: tauri::Error| error.to_string())?;
    Ok(app_data_dir.join(WEB_CLIPPER_AUTH_FILE))
}

fn write_web_clipper_auth_state(
    app: &AppHandle,
    state: &WebClipperAuthState,
) -> Result<(), String> {
    let path = web_clipper_auth_file_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let payload = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    fs::write(path, payload).map_err(|error| error.to_string())
}

fn load_or_create_web_clipper_auth_state(app: &AppHandle) -> Result<WebClipperAuthState, String> {
    let path = web_clipper_auth_file_path(app)?;
    match fs::read(&path) {
        Ok(bytes) => {
            serde_json::from_slice::<WebClipperAuthState>(&bytes).map_err(|error| error.to_string())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let state = WebClipperAuthState {
                token: Uuid::new_v4().to_string(),
                firefox_origin: None,
            };
            write_web_clipper_auth_state(app, &state)?;
            Ok(state)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn pair_web_clipper(
    app: &AppHandle,
    authorized: &AuthorizedClipper,
) -> Result<WebClipperAuthState, ClipperOriginAuthError> {
    let mut state = load_or_create_web_clipper_auth_state(app)
        .map_err(|_| ClipperOriginAuthError::AuthUnavailable)?;
    if matches!(authorized.identity, ExtensionIdentity::OfficialFirefox)
        && state.firefox_origin.as_deref() != Some(authorized.origin.as_str())
    {
        state.token = Uuid::new_v4().to_string();
        state.firefox_origin = Some(authorized.origin.clone());
        write_web_clipper_auth_state(app, &state)
            .map_err(|_| ClipperOriginAuthError::AuthUnavailable)?;
    } else if state.firefox_origin.is_none()
        && matches!(authorized.identity, ExtensionIdentity::OfficialFirefox)
    {
        state.firefox_origin = Some(authorized.origin.clone());
        write_web_clipper_auth_state(app, &state)
            .map_err(|_| ClipperOriginAuthError::AuthUnavailable)?;
    }
    Ok(state)
}

fn authorize_request(
    request: &tiny_http::Request,
    app: &AppHandle,
) -> Result<AuthorizedClipper, ClipperOriginAuthError> {
    let authorized = resolve_extension_identity(
        request_origin(request).as_deref(),
        request_header_value(request, WEB_CLIPPER_EXTENSION_ID_HEADER).as_deref(),
    )?;
    let token = request_header_value(request, WEB_CLIPPER_TOKEN_HEADER)
        .ok_or(ClipperOriginAuthError::PairingRequired)?;
    let state = load_or_create_web_clipper_auth_state(app)
        .map_err(|_| ClipperOriginAuthError::AuthUnavailable)?;

    if token != state.token {
        return Err(ClipperOriginAuthError::InvalidToken);
    }

    if matches!(authorized.identity, ExtensionIdentity::OfficialFirefox)
        && state.firefox_origin.as_deref() != Some(authorized.origin.as_str())
    {
        return Err(ClipperOriginAuthError::PairingRequired);
    }

    Ok(authorized)
}

fn json_response(
    body: serde_json::Value,
    status: StatusCode,
    origin: Option<&str>,
) -> Response<std::io::Cursor<Vec<u8>>> {
    let mut response = Response::from_string(body.to_string()).with_status_code(status);
    response.add_header(json_header("Content-Type", "application/json"));
    if let Some(origin) = origin {
        response.add_header(json_header("Access-Control-Allow-Origin", origin));
        response.add_header(json_header("Vary", "Origin"));
        response.add_header(json_header(
            "Access-Control-Allow-Headers",
            WEB_CLIPPER_ALLOW_HEADERS,
        ));
        response.add_header(json_header(
            "Access-Control-Allow-Methods",
            "GET,POST,OPTIONS",
        ));
    }
    response
}

fn parse_body<T: for<'de> Deserialize<'de>>(request: &mut tiny_http::Request) -> Result<T, String> {
    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&body).map_err(|error| error.to_string())
}

pub(crate) fn start_server(app: AppHandle) {
    thread::spawn(move || {
        let Ok(server) = Server::http(("127.0.0.1", WEB_CLIPPER_API_PORT)) else {
            eprintln!(
                "[web-clipper-api] Failed to bind to 127.0.0.1:{}",
                WEB_CLIPPER_API_PORT
            );
            return;
        };

        for mut request in server.incoming_requests() {
            let pairing_identity = resolve_extension_identity(
                request_origin(&request).as_deref(),
                request_header_value(&request, WEB_CLIPPER_EXTENSION_ID_HEADER).as_deref(),
            );

            if request.method() == &Method::Options {
                let response = match pairing_identity {
                    Ok(authorized) => json_response(
                        json!({ "ok": true }),
                        StatusCode(204),
                        Some(&authorized.origin),
                    ),
                    Err(error) => json_response(
                        json!({
                            "ok": false,
                            "status": "unauthorized",
                            "message": error.message(),
                        }),
                        error.status_code(),
                        None,
                    ),
                };
                let _ = request.respond(response);
                continue;
            }

            let path = request.url().split('?').next().unwrap_or_default();
            if path == "/api/web-clipper/pair" {
                let response = match pairing_identity {
                    Ok(authorized) => match pair_web_clipper(&app, &authorized) {
                        Ok(auth_state) => json_response(
                            json!({
                                "ok": true,
                                "token": auth_state.token,
                            }),
                            StatusCode(200),
                            Some(&authorized.origin),
                        ),
                        Err(error) => json_response(
                            json!({
                                "ok": false,
                                "status": "unauthorized",
                                "message": error.message(),
                            }),
                            error.status_code(),
                            None,
                        ),
                    },
                    Err(error) => json_response(
                        json!({
                            "ok": false,
                            "status": "unauthorized",
                            "message": error.message(),
                        }),
                        error.status_code(),
                        None,
                    ),
                };
                let _ = request.respond(response);
                continue;
            }

            let authorized = match authorize_request(&request, &app) {
                Ok(authorized) => authorized,
                Err(error) => {
                    let _ = request.respond(json_response(
                        json!({
                            "ok": false,
                            "status": "unauthorized",
                            "message": error.message(),
                        }),
                        error.status_code(),
                        None,
                    ));
                    continue;
                }
            };

            let response = match (request.method(), path) {
                (&Method::Get, "/api/web-clipper/health") => match web_clipper_ready_vaults(&app) {
                    Ok(vaults) => json_response(
                        json!({
                            "ok": true,
                            "message": if vaults.is_empty() {
                                "VaultAI is running, but no vault is ready."
                            } else {
                                "VaultAI desktop API is ready."
                            },
                            "vaults": vaults.into_iter().map(|(path, name)| json!({ "path": path, "name": name })).collect::<Vec<_>>(),
                        }),
                        StatusCode(200),
                        Some(&authorized.origin),
                    ),
                    Err(message) => json_response(
                        json!({ "ok": false, "message": message }),
                        StatusCode(500),
                        Some(&authorized.origin),
                    ),
                },
                (&Method::Get, "/api/web-clipper/themes") => json_response(
                    json!({
                        "themes": [
                            { "id": "default", "label": "Default" },
                            { "id": "ocean", "label": "Ocean" },
                            { "id": "forest", "label": "Forest" },
                            { "id": "rose", "label": "Rose" },
                            { "id": "amber", "label": "Amber" },
                            { "id": "lavender", "label": "Lavender" },
                            { "id": "nord", "label": "Nord" },
                            { "id": "sunset", "label": "Sunset" },
                            { "id": "catppuccin", "label": "Catppuccin" },
                            { "id": "solarized", "label": "Solarized" },
                            { "id": "tokyoNight", "label": "Tokyo Night" },
                            { "id": "gruvbox", "label": "Gruvbox" },
                            { "id": "ayu", "label": "Ayu" },
                            { "id": "nightOwl", "label": "Night Owl" },
                            { "id": "vesper", "label": "Vesper" },
                            { "id": "rosePine", "label": "Rose Pine" },
                            { "id": "kanagawa", "label": "Kanagawa" },
                            { "id": "everforest", "label": "Everforest" },
                            { "id": "synthwave84", "label": "Synthwave 84" },
                            { "id": "claude", "label": "Claude" },
                            { "id": "codex", "label": "Codex" }
                        ]
                    }),
                    StatusCode(200),
                    Some(&authorized.origin),
                ),
                (&Method::Post, "/api/web-clipper/folders") => {
                    match parse_body::<LookupRequest>(&mut request) {
                        Ok(input) => match web_clipper_list_folders(
                            &app,
                            input.vault_path_hint.as_deref(),
                            input.vault_name_hint.as_deref(),
                        ) {
                            Ok(folders) => json_response(
                                json!({ "folders": folders }),
                                StatusCode(200),
                                Some(&authorized.origin),
                            ),
                            Err(message) => json_response(
                                json!({ "message": message }),
                                StatusCode(400),
                                Some(&authorized.origin),
                            ),
                        },
                        Err(message) => json_response(
                            json!({ "message": message }),
                            StatusCode(400),
                            Some(&authorized.origin),
                        ),
                    }
                }
                (&Method::Post, "/api/web-clipper/tags") => {
                    match parse_body::<LookupRequest>(&mut request) {
                        Ok(input) => match web_clipper_list_tags(
                            &app,
                            input.vault_path_hint.as_deref(),
                            input.vault_name_hint.as_deref(),
                        ) {
                            Ok(tags) => json_response(
                                json!({ "tags": tags }),
                                StatusCode(200),
                                Some(&authorized.origin),
                            ),
                            Err(message) => json_response(
                                json!({ "message": message }),
                                StatusCode(400),
                                Some(&authorized.origin),
                            ),
                        },
                        Err(message) => json_response(
                            json!({ "message": message }),
                            StatusCode(400),
                            Some(&authorized.origin),
                        ),
                    }
                }
                (&Method::Post, "/api/web-clipper/clips") => {
                    match parse_body::<SaveClipRequest>(&mut request) {
                        Ok(input) => {
                            if input.content.trim().is_empty() {
                                json_response(
                                    json!({
                                        "ok": false,
                                        "status": "error",
                                        "message": "Clip content is empty."
                                    }),
                                    StatusCode(400),
                                    Some(&authorized.origin),
                                )
                            } else {
                                match web_clipper_save_note(
                                    &app,
                                    input.request_id,
                                    input.vault_path_hint.as_deref(),
                                    input.vault_name_hint.as_deref(),
                                    &input.title,
                                    &input.folder,
                                    &input.content,
                                ) {
                                    Ok(saved) => json_response(
                                        json!({
                                            "ok": true,
                                            "status": "saved",
                                            "message": format!("Saved clip to {}.", saved.relative_path),
                                            "noteId": saved.note_id,
                                            "relativePath": saved.relative_path,
                                        }),
                                        StatusCode(200),
                                        Some(&authorized.origin),
                                    ),
                                    Err(message) => json_response(
                                        json!({
                                            "ok": false,
                                            "status": "error",
                                            "message": message,
                                        }),
                                        StatusCode(400),
                                        Some(&authorized.origin),
                                    ),
                                }
                            }
                        }
                        Err(message) => json_response(
                            json!({
                                "ok": false,
                                "status": "error",
                                "message": message,
                            }),
                            StatusCode(400),
                            Some(&authorized.origin),
                        ),
                    }
                }
                _ => json_response(
                    json!({ "ok": false, "message": "Not found." }),
                    StatusCode(404),
                    Some(&authorized.origin),
                ),
            };

            let _ = request.respond(response);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        parse_dev_origins, resolve_extension_identity, AuthorizedClipper, ExtensionIdentity,
        CHROME_EXTENSION_ID, FIREFOX_EXTENSION_ID,
    };

    #[test]
    fn accepts_official_chrome_and_firefox_extension_identity() {
        assert_eq!(
            resolve_extension_identity(
                Some(&format!("chrome-extension://{CHROME_EXTENSION_ID}")),
                Some(CHROME_EXTENSION_ID),
            ),
            Ok(AuthorizedClipper {
                origin: format!("chrome-extension://{CHROME_EXTENSION_ID}"),
                identity: ExtensionIdentity::OfficialChrome,
            })
        );
        assert_eq!(
            resolve_extension_identity(
                Some("moz-extension://random-firefox-origin"),
                Some(FIREFOX_EXTENSION_ID),
            ),
            Ok(AuthorizedClipper {
                origin: "moz-extension://random-firefox-origin".to_string(),
                identity: ExtensionIdentity::OfficialFirefox,
            })
        );
    }

    #[test]
    fn rejects_missing_and_unapproved_extension_identity() {
        assert!(resolve_extension_identity(None, Some(CHROME_EXTENSION_ID)).is_err());
        assert!(resolve_extension_identity(
            Some("chrome-extension://fakeid"),
            Some(CHROME_EXTENSION_ID),
        )
        .is_err());
        assert!(resolve_extension_identity(
            Some("moz-extension://fake"),
            Some("fake-extension-id"),
        )
        .is_err());
        assert!(resolve_extension_identity(Some("http://127.0.0.1:3000"), Some("dev")).is_err());
        assert!(resolve_extension_identity(
            Some("chrome-extension://pogmjgibofkooljfgaandhoinmenfhao"),
            None,
        )
        .is_err());
    }

    #[test]
    fn accepts_explicit_dev_origins_only() {
        let dev_origins = parse_dev_origins(
            "chrome-extension://devclipper,moz-extension://temporary-id,http://localhost:3000",
        );
        assert_eq!(
            dev_origins,
            vec![
                "chrome-extension://devclipper".to_string(),
                "moz-extension://temporary-id".to_string(),
            ]
        );
        assert_eq!(
            dev_origins.contains(&"chrome-extension://devclipper".to_string()),
            true
        );
        assert_eq!(
            dev_origins.contains(&"moz-extension://temporary-id".to_string()),
            true
        );
    }
}
