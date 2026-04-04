use std::fs;
use std::net::TcpListener;
use std::path::{Component, Path, PathBuf};
use std::thread;

use tauri::{AppHandle, Manager};
use tiny_http::{Header, Method, Response, ResponseBox, Server, StatusCode};
use url::Url;

const FRONTEND_SERVER_PORTS: &[u16] = &[32146, 32147, 32148, 32149, 32150];

pub(crate) fn start(app: AppHandle) -> Result<Option<Url>, String> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }

    let root = resolve_frontend_root(&app)?;
    let (server, port) = bind_frontend_server()?;
    let url = Url::parse(&format!("http://localhost:{port}/"))
        .map_err(|error| format!("Failed to build frontend URL: {error}"))?;

    thread::spawn(move || {
        for request in server.incoming_requests() {
            let response = build_response(&root, &request);
            if let Err(error) = request.respond(response) {
                eprintln!("[frontend-server] Failed to respond to request: {error}");
            }
        }
    });

    Ok(Some(url))
}

fn resolve_frontend_root(app: &AppHandle) -> Result<PathBuf, String> {
    let root = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")))
        .join("frontend-dist");

    if root.join("index.html").is_file() {
        Ok(root)
    } else {
        Err(format!(
            "Bundled frontend is missing from {}",
            root.display()
        ))
    }
}

fn bind_frontend_server() -> Result<(Server, u16), String> {
    for port in FRONTEND_SERVER_PORTS {
        let listener = match TcpListener::bind(("127.0.0.1", *port)) {
            Ok(listener) => listener,
            Err(_) => continue,
        };

        let server = Server::from_listener(listener, None)
            .map_err(|error| format!("Failed to start frontend server on port {port}: {error}"))?;
        return Ok((server, *port));
    }

    Err(format!(
        "Failed to bind a frontend server on localhost. Tried ports: {}",
        FRONTEND_SERVER_PORTS
            .iter()
            .map(u16::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn build_response(root: &Path, request: &tiny_http::Request) -> ResponseBox {
    if request.method() != &Method::Get && request.method() != &Method::Head {
        return text_response(
            StatusCode(405),
            "Method not allowed",
            "text/plain; charset=utf-8",
        );
    }

    let Some(relative_path) = sanitize_request_path(request.url()) else {
        return text_response(
            StatusCode(400),
            "Invalid frontend request path",
            "text/plain; charset=utf-8",
        );
    };

    let Some(path) = resolve_request_file(root, &relative_path) else {
        return text_response(
            StatusCode(404),
            "Frontend asset not found",
            "text/plain; charset=utf-8",
        );
    };

    let content_type = detect_mime_type(&path);
    let cache_control = if path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value == "index.html")
    {
        "no-store"
    } else {
        "public, max-age=31536000, immutable"
    };

    if request.method() == &Method::Head {
        return Response::empty(StatusCode(200))
            .with_header(header("Content-Type", content_type))
            .with_header(header("Cache-Control", cache_control))
            .boxed();
    }

    match fs::read(&path) {
        Ok(bytes) => Response::from_data(bytes)
            .with_header(header("Content-Type", content_type))
            .with_header(header("Cache-Control", cache_control))
            .boxed(),
        Err(error) => text_response(
            StatusCode(500),
            format!("Failed to read frontend asset: {error}"),
            "text/plain; charset=utf-8",
        ),
    }
}

fn sanitize_request_path(raw_url: &str) -> Option<PathBuf> {
    let path = raw_url.split('?').next().unwrap_or("/");
    let trimmed = path.trim_start_matches('/');
    if trimmed.is_empty() {
        return Some(PathBuf::new());
    }

    let mut normalized = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(value) => normalized.push(value),
            _ => return None,
        }
    }

    Some(normalized)
}

fn resolve_request_file(root: &Path, relative_path: &Path) -> Option<PathBuf> {
    if relative_path.as_os_str().is_empty() {
        return Some(root.join("index.html"));
    }

    let candidate = root.join(relative_path);
    if candidate.is_file() {
        return Some(candidate);
    }

    if candidate.is_dir() {
        let nested_index = candidate.join("index.html");
        if nested_index.is_file() {
            return Some(nested_index);
        }
    }

    if relative_path.extension().is_none() {
        let fallback = root.join("index.html");
        if fallback.is_file() {
            return Some(fallback);
        }
    }

    None
}

fn text_response(
    status: StatusCode,
    message: impl Into<String>,
    content_type: &str,
) -> ResponseBox {
    Response::from_string(message.into())
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", "no-store"))
        .boxed()
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes())
        .expect("frontend server header must be valid")
}

fn detect_mime_type(path: &Path) -> &'static str {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase());

    match extension.as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("json") | Some("map") => "application/json",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_request_path_rejects_path_traversal() {
        assert!(sanitize_request_path("/assets/../../secret.txt").is_none());
        assert!(sanitize_request_path("/../secret.txt").is_none());
    }

    #[test]
    fn sanitize_request_path_preserves_normal_segments() {
        assert_eq!(
            sanitize_request_path("/assets/index.js?cache=bust").unwrap(),
            PathBuf::from("assets").join("index.js")
        );
        assert_eq!(sanitize_request_path("/").unwrap(), PathBuf::new());
    }

    #[test]
    fn resolve_request_file_falls_back_to_index_for_routes() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");
        let file = resolve_request_file(&root, Path::new("settings")).unwrap();
        assert_eq!(file, root.join("index.html"));
    }

    #[test]
    fn detect_mime_type_handles_bundled_assets() {
        assert_eq!(
            detect_mime_type(Path::new("assets/index.js")),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(
            detect_mime_type(Path::new("assets/font.woff2")),
            "font/woff2"
        );
    }
}
