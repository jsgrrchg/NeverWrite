use std::thread;

use serde::Deserialize;
use serde_json::json;
use tauri::AppHandle;
use tiny_http::{Header, Method, Response, Server, StatusCode};

use crate::{
    web_clipper_list_folders, web_clipper_list_tags, web_clipper_ready_vaults,
    web_clipper_save_note,
};

const WEB_CLIPPER_API_PORT: u16 = 32145;

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
    tags: Vec<String>,
    #[allow(dead_code)]
    source_url: String,
    vault_path_hint: Option<String>,
    vault_name_hint: Option<String>,
}

fn json_header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid web clipper api header")
}

fn allowed_origin(request: &tiny_http::Request) -> Option<String> {
    let origin = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Origin"))
        .map(|header| header.value.as_str().to_string())?;

    if origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://") {
        Some(origin)
    } else {
        None
    }
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
        response.add_header(json_header("Access-Control-Allow-Headers", "content-type"));
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
            let origin = allowed_origin(&request);

            if request.method() == &Method::Options {
                let response =
                    json_response(json!({ "ok": true }), StatusCode(204), origin.as_deref());
                let _ = request.respond(response);
                continue;
            }

            if request
                .headers()
                .iter()
                .any(|header| header.field.equiv("Origin"))
                && origin.is_none()
            {
                let _ = request.respond(json_response(
                    json!({ "ok": false, "message": "Origin not allowed." }),
                    StatusCode(403),
                    None,
                ));
                continue;
            }

            let path = request.url().split('?').next().unwrap_or_default();
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
                        origin.as_deref(),
                    ),
                    Err(message) => json_response(
                        json!({ "ok": false, "message": message }),
                        StatusCode(500),
                        origin.as_deref(),
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
                    origin.as_deref(),
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
                                origin.as_deref(),
                            ),
                            Err(message) => json_response(
                                json!({ "message": message }),
                                StatusCode(400),
                                origin.as_deref(),
                            ),
                        },
                        Err(message) => json_response(
                            json!({ "message": message }),
                            StatusCode(400),
                            origin.as_deref(),
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
                                origin.as_deref(),
                            ),
                            Err(message) => json_response(
                                json!({ "message": message }),
                                StatusCode(400),
                                origin.as_deref(),
                            ),
                        },
                        Err(message) => json_response(
                            json!({ "message": message }),
                            StatusCode(400),
                            origin.as_deref(),
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
                                    origin.as_deref(),
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
                                        origin.as_deref(),
                                    ),
                                    Err(message) => json_response(
                                        json!({
                                            "ok": false,
                                            "status": "error",
                                            "message": message,
                                        }),
                                        StatusCode(400),
                                        origin.as_deref(),
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
                            origin.as_deref(),
                        ),
                    }
                }
                _ => json_response(
                    json!({ "ok": false, "message": "Not found." }),
                    StatusCode(404),
                    origin.as_deref(),
                ),
            };

            let _ = request.respond(response);
        }
    });
}
