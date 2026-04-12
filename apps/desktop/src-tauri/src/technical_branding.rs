#![allow(dead_code)]

use std::path::PathBuf;

use serde_json::{Map, Value};
use tauri::{AppHandle, Manager, Runtime};

pub const TECHNICAL_PRODUCT_SLUG: &str = "neverwrite";
pub const APP_IDENTIFIER: &str = "com.neverwrite";
pub const APP_DEV_IDENTIFIER: &str = "com.neverwrite.dev";

pub const WEB_CLIPPER_DEEP_LINK_SCHEME: &str = "neverwrite";
pub const FILE_PREVIEW_SCHEME: &str = "neverwrite-file";

pub const PRODUCT_STATE_DIR_NAME: &str = ".neverwrite";
pub const PRODUCT_CACHE_DIR_NAME: &str = ".neverwrite-cache";

pub const WEB_CLIPPER_FIREFOX_EXTENSION_ID: &str = "web-clipper@neverwrite.app";
pub const WEB_CLIPPER_DEV_ORIGINS_ENV_VARS: [&str; 1] = ["NEVERWRITE_WEB_CLIPPER_DEV_ORIGINS"];
pub const WEB_CLIPPER_TOKEN_HEADER: &str = "X-NeverWrite-Clipper-Token";
pub const WEB_CLIPPER_EXTENSION_ID_HEADER: &str = "X-NeverWrite-Extension-Id";
pub const WEB_CLIPPER_ALLOW_HEADERS: &str =
    "content-type,x-neverwrite-clipper-token,x-neverwrite-extension-id";

pub const CODEX_ACP_BUNDLE_BIN_ENV_VARS: [&str; 1] = ["NEVERWRITE_CODEX_ACP_BUNDLE_BIN"];
pub const CODEX_ACP_BIN_ENV_VARS: [&str; 1] = ["NEVERWRITE_CODEX_ACP_BIN"];
pub const CLAUDE_ACP_BUNDLE_BIN_ENV_VARS: [&str; 1] = ["NEVERWRITE_CLAUDE_ACP_BUNDLE_BIN"];
pub const CLAUDE_ACP_BIN_ENV_VARS: [&str; 1] = ["NEVERWRITE_CLAUDE_ACP_BIN"];
pub const GEMINI_ACP_BIN_ENV_VARS: [&str; 1] = ["NEVERWRITE_GEMINI_ACP_BIN"];
pub const KILO_ACP_BIN_ENV_VARS: [&str; 1] = ["NEVERWRITE_KILO_ACP_BIN"];
pub const EMBEDDED_NODE_BIN_ENV_VARS: [&str; 1] = ["NEVERWRITE_EMBEDDED_NODE_BIN"];

pub const UPDATER_PUBLIC_KEY_ENV_VARS: [&str; 1] = ["NEVERWRITE_UPDATER_PUBLIC_KEY"];
pub const UPDATER_ENDPOINT_ENV_VARS: [&str; 1] = ["NEVERWRITE_UPDATER_ENDPOINT"];
pub const UPDATER_BASE_URL_ENV_VARS: [&str; 1] = ["NEVERWRITE_UPDATER_BASE_URL"];
pub const UPDATER_CHANNEL_ENV_VARS: [&str; 1] = ["NEVERWRITE_UPDATER_CHANNEL"];
pub const UPDATER_ALLOWED_FEED_HOSTS_ENV_VARS: [&str; 1] =
    ["NEVERWRITE_UPDATER_ALLOWED_FEED_HOSTS"];
pub const UPDATER_ALLOWED_DOWNLOAD_HOSTS_ENV_VARS: [&str; 1] =
    ["NEVERWRITE_UPDATER_ALLOWED_DOWNLOAD_HOSTS"];
pub const UPDATER_ALLOW_PROD_ENDPOINTS_IN_NON_PROD_ENV_VARS: [&str; 1] =
    ["NEVERWRITE_UPDATER_ALLOW_PRODUCTION_ENDPOINTS_IN_NON_PROD"];

pub const SECRET_STORE_SERVICE: &str = "com.neverwrite.desktop.ai";

pub const ACP_IMPLEMENTATION_ID: &str = "neverwrite";
pub const ACP_STATUS_EVENT_TYPE_KEY: &str = "neverwriteEventType";
pub const ACP_STATUS_KIND_KEY: &str = "neverwriteStatusKind";
pub const ACP_STATUS_EMPHASIS_KEY: &str = "neverwriteStatusEmphasis";
pub const ACP_USER_INPUT_EVENT_TYPE: &str = "user_input_request";
pub const ACP_USER_INPUT_RESPONSE_PREFIX: &str = "__neverwrite_user_input_response__:";
pub const ACP_PLAN_TITLE_KEY: &str = "neverwritePlanTitle";
pub const ACP_PLAN_DETAIL_KEY: &str = "neverwritePlanDetail";
pub const ACP_DIFF_PREVIOUS_PATH_KEY: &str = "neverwritePreviousPath";
pub const ACP_DIFF_HUNKS_KEY: &str = "neverwriteHunks";
pub const ACP_STATUS_EVENT_ID_PREFIX: &str = "neverwrite:status:";

pub fn is_supported_deep_link_scheme(value: &str) -> bool {
    value.eq_ignore_ascii_case(WEB_CLIPPER_DEEP_LINK_SCHEME)
}

pub fn meta_get<'a>(meta: &'a Map<String, Value>, key: &str) -> Option<&'a Value> {
    meta.get(key)
}

pub fn meta_get_str<'a>(meta: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    meta_get(meta, key)?.as_str()
}

pub fn normalize_user_input_response_payload(payload: &str) -> Option<&str> {
    payload.strip_prefix(ACP_USER_INPUT_RESPONSE_PREFIX)
}

pub fn app_data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|error| error.to_string())
}
