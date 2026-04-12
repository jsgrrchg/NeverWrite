use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use neverwrite_ai::{AiAuthMethod, AiRuntimeBinarySource, AiRuntimeSetupStatus, KILO_RUNTIME_ID};
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::process::Command;

use crate::ai::env::find_program_on_preferred_path;
use crate::technical_branding::{app_data_dir, KILO_ACP_BIN_ENV_VARS};

const SETUP_FILE_NAME: &str = "kilo-setup.json";
const KILO_PROGRAM_NAME: &str = "kilo";
const KILO_LOGIN_METHOD_ID: &str = "kilo-login";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct KiloSetupConfig {
    pub custom_binary_path: Option<String>,
    pub auth_invalidated_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct KiloSetupInput {
    pub custom_binary_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ResolvedBinary {
    pub program: Option<String>,
    pub args: Vec<String>,
    pub display: Option<String>,
    pub source: AiRuntimeBinarySource,
}

impl KiloSetupConfig {
    fn apply_input(&mut self, input: &KiloSetupInput) {
        if let Some(path) = input.custom_binary_path.as_ref() {
            self.custom_binary_path = normalize_optional_string(Some(path.clone()));
        }
    }
}

pub fn load_setup_config(app: &AppHandle) -> Result<KiloSetupConfig, String> {
    let path = setup_file_path(app)?;
    load_setup_config_from_path(&path)
}

pub fn save_setup_config(
    app: &AppHandle,
    input: KiloSetupInput,
) -> Result<KiloSetupConfig, String> {
    let path = setup_file_path(app)?;
    let mut config = load_setup_config_from_path(&path)?;
    config.apply_input(&input);
    write_setup_config_to_path(&path, &config)?;
    Ok(config)
}

pub fn clear_authenticated_method(app: &AppHandle) -> Result<KiloSetupConfig, String> {
    let path = setup_file_path(app)?;
    let mut config = load_setup_config_from_path(&path)?;
    config.auth_invalidated_at_ms = Some(current_time_millis());
    write_setup_config_to_path(&path, &config)?;
    Ok(config)
}

pub fn setup_status(app: &AppHandle) -> Result<AiRuntimeSetupStatus, String> {
    let config = load_setup_config(app)?;
    let resolved = resolve_binary_command(&config);
    let binary_ready = resolved.program.is_some();
    let auth_methods = available_auth_methods();
    let auth_method = detect_auth_method(&config)?;
    let auth_ready = auth_method.is_some();

    let message = if !binary_ready {
        Some("Kilo CLI was not found. Install kilo or provide a custom runtime path.".to_string())
    } else if !auth_ready {
        Some("Sign in with Kilo to finish setup.".to_string())
    } else {
        None
    };

    Ok(AiRuntimeSetupStatus {
        runtime_id: KILO_RUNTIME_ID.to_string(),
        binary_ready,
        binary_path: resolved.display,
        binary_source: if binary_ready {
            resolved.source
        } else {
            AiRuntimeBinarySource::Missing
        },
        has_custom_binary_path: config.custom_binary_path.is_some(),
        auth_ready,
        auth_method,
        auth_methods,
        has_gateway_config: false,
        has_gateway_url: false,
        onboarding_required: !binary_ready || !auth_ready,
        message,
    })
}

pub fn resolve_binary_command(config: &KiloSetupConfig) -> ResolvedBinary {
    if let Some(raw) = read_env_override(&KILO_ACP_BIN_ENV_VARS) {
        let resolved = resolve_command_candidate(raw.trim(), AiRuntimeBinarySource::Env);
        if resolved.display.is_some() {
            return resolved;
        }
    }

    if let Some(raw) = config.custom_binary_path.as_deref() {
        let resolved = resolve_command_candidate(raw, AiRuntimeBinarySource::Custom);
        if resolved.program.is_some() {
            return resolved;
        }
    }

    if let Some(path) = find_program(KILO_PROGRAM_NAME) {
        return command_from_existing_path(path, AiRuntimeBinarySource::Env);
    }

    ResolvedBinary {
        program: None,
        args: Vec::new(),
        display: Some(KILO_PROGRAM_NAME.to_string()),
        source: AiRuntimeBinarySource::Env,
    }
}

pub fn apply_auth_env(
    _command: &mut Command,
    _app: &AppHandle,
    _config: &KiloSetupConfig,
) -> Result<(), String> {
    Ok(())
}

fn available_auth_methods() -> Vec<AiAuthMethod> {
    vec![AiAuthMethod {
        id: KILO_LOGIN_METHOD_ID.to_string(),
        name: "Kilo login".to_string(),
        description: "Open the Kilo CLI sign-in flow in an integrated terminal.".to_string(),
    }]
}

fn detect_auth_method(config: &KiloSetupConfig) -> Result<Option<String>, String> {
    let Some(status) = kilo_auth_store_status()? else {
        return Ok(None);
    };

    if !status.has_active_auth {
        return Ok(None);
    }

    if config
        .auth_invalidated_at_ms
        .zip(status.modified_at_ms)
        .is_some_and(|(invalidated_at, modified_at)| modified_at <= invalidated_at)
    {
        return Ok(None);
    }

    Ok(Some(KILO_LOGIN_METHOD_ID.to_string()))
}

fn load_setup_config_from_path(path: &Path) -> Result<KiloSetupConfig, String> {
    if !path.exists() {
        return Ok(KiloSetupConfig::default());
    }

    let raw = fs::read_to_string(path).map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|error| error.to_string())
}

fn write_setup_config_to_path(path: &Path, config: &KiloSetupConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }

    let serialized = serde_json::to_string_pretty(config).map_err(|error| error.to_string())?;
    fs::write(path, serialized).map_err(|error| error.to_string())
}

fn setup_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app_data_dir(app)?;
    Ok(base.join("ai").join(SETUP_FILE_NAME))
}

fn read_env_override(keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| env::var(key).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let trimmed = raw.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum KiloAuthInfo {
    Oauth { expires: u64 },
    Api { key: String },
    Wellknown { key: String, token: String },
}

#[derive(Debug)]
struct KiloAuthStoreStatus {
    has_active_auth: bool,
    modified_at_ms: Option<u64>,
}

fn kilo_auth_store_status() -> Result<Option<KiloAuthStoreStatus>, String> {
    let sqlite_status = kilo_sqlite_auth_store_status()?;
    let legacy_status = kilo_legacy_auth_store_status()?;
    Ok(merge_auth_store_status(sqlite_status, legacy_status))
}

fn kilo_legacy_auth_store_status() -> Result<Option<KiloAuthStoreStatus>, String> {
    let path = kilo_auth_store_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let entries: HashMap<String, KiloAuthInfo> =
        serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    let now_ms = current_time_millis();
    let has_active_auth = entries.values().any(|entry| match entry {
        KiloAuthInfo::Oauth { expires } => *expires > now_ms,
        KiloAuthInfo::Api { key } => !key.trim().is_empty(),
        KiloAuthInfo::Wellknown { key, token } => {
            !key.trim().is_empty() && !token.trim().is_empty()
        }
    });

    let modified_at_ms = file_modified_at_millis(&path);

    Ok(Some(KiloAuthStoreStatus {
        has_active_auth,
        modified_at_ms,
    }))
}

fn kilo_sqlite_auth_store_status() -> Result<Option<KiloAuthStoreStatus>, String> {
    let path = kilo_sqlite_store_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let connection = Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|error| error.to_string())?;
    let now_ms = current_time_millis();

    let has_active_auth = has_active_account_row(&connection, now_ms)?
        || has_active_control_account_row(&connection, now_ms)?
        || has_any_authenticated_account_row(&connection, now_ms)?;

    Ok(Some(KiloAuthStoreStatus {
        has_active_auth,
        modified_at_ms: file_modified_at_millis(&path),
    }))
}

fn merge_auth_store_status(
    primary: Option<KiloAuthStoreStatus>,
    secondary: Option<KiloAuthStoreStatus>,
) -> Option<KiloAuthStoreStatus> {
    match (primary, secondary) {
        (None, None) => None,
        (Some(status), None) | (None, Some(status)) => Some(status),
        (Some(primary), Some(secondary)) => Some(KiloAuthStoreStatus {
            has_active_auth: primary.has_active_auth || secondary.has_active_auth,
            modified_at_ms: match (primary.modified_at_ms, secondary.modified_at_ms) {
                (Some(left), Some(right)) => Some(left.max(right)),
                (Some(value), None) | (None, Some(value)) => Some(value),
                (None, None) => None,
            },
        }),
    }
}

fn has_active_account_row(connection: &Connection, now_ms: u64) -> Result<bool, String> {
    let row = connection
        .query_row(
            r#"
            SELECT a.access_token, a.refresh_token, a.token_expiry
            FROM account_state AS state
            JOIN account AS a ON a.id = state.active_account_id
            WHERE state.active_account_id IS NOT NULL
            LIMIT 1
            "#,
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    Ok(
        row.is_some_and(|(access_token, refresh_token, token_expiry)| {
            has_valid_sqlite_auth_tokens(&access_token, &refresh_token, token_expiry, now_ms)
        }),
    )
}

fn has_active_control_account_row(connection: &Connection, now_ms: u64) -> Result<bool, String> {
    let row = connection
        .query_row(
            r#"
            SELECT access_token, refresh_token, token_expiry
            FROM control_account
            WHERE active = 1
            LIMIT 1
            "#,
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    Ok(
        row.is_some_and(|(access_token, refresh_token, token_expiry)| {
            has_valid_sqlite_auth_tokens(&access_token, &refresh_token, token_expiry, now_ms)
        }),
    )
}

fn has_any_authenticated_account_row(connection: &Connection, now_ms: u64) -> Result<bool, String> {
    let row = connection
        .query_row(
            r#"
            SELECT access_token, refresh_token, token_expiry
            FROM account
            ORDER BY time_updated DESC
            LIMIT 1
            "#,
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?;

    Ok(
        row.is_some_and(|(access_token, refresh_token, token_expiry)| {
            has_valid_sqlite_auth_tokens(&access_token, &refresh_token, token_expiry, now_ms)
        }),
    )
}

fn has_valid_sqlite_auth_tokens(
    access_token: &str,
    refresh_token: &str,
    token_expiry: Option<i64>,
    now_ms: u64,
) -> bool {
    let has_tokens = !access_token.trim().is_empty() && !refresh_token.trim().is_empty();
    if !has_tokens {
        return false;
    }

    match token_expiry.and_then(normalize_timestamp_to_millis) {
        Some(expires_at_ms) => expires_at_ms > now_ms,
        None => true,
    }
}

fn normalize_timestamp_to_millis(value: i64) -> Option<u64> {
    let value = u64::try_from(value).ok()?;
    if value == 0 {
        return None;
    }

    if value < 1_000_000_000_000 {
        Some(value.saturating_mul(1_000))
    } else {
        Some(value)
    }
}

fn kilo_auth_store_path() -> Result<PathBuf, String> {
    let base = kilo_data_dir()?;
    Ok(base.join("kilo").join("auth.json"))
}

fn kilo_sqlite_store_path() -> Result<PathBuf, String> {
    let base = kilo_data_dir()?;
    Ok(base.join("kilo").join("kilo.db"))
}

fn kilo_data_dir() -> Result<PathBuf, String> {
    if let Some(value) = env::var_os("XDG_DATA_HOME").filter(|value| !value.is_empty()) {
        return Ok(PathBuf::from(value));
    }

    #[cfg(target_os = "windows")]
    {
        if let Some(value) = env::var_os("LOCALAPPDATA").filter(|value| !value.is_empty()) {
            return Ok(PathBuf::from(value));
        }
    }

    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "Unable to resolve home directory for Kilo auth storage.".to_string())?;
    Ok(home.join(".local").join("share"))
}

fn current_time_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn system_time_to_millis(value: SystemTime) -> Option<u64> {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

fn file_modified_at_millis(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(system_time_to_millis)
}

fn resolve_command_candidate(raw: &str, source: AiRuntimeBinarySource) -> ResolvedBinary {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return ResolvedBinary {
            program: None,
            args: Vec::new(),
            display: None,
            source,
        };
    }

    let candidate = PathBuf::from(trimmed);
    let looks_like_path = candidate.is_absolute()
        || trimmed.contains(std::path::MAIN_SEPARATOR)
        || trimmed.contains('/')
        || trimmed.contains('\\');

    if looks_like_path {
        if candidate.exists() {
            return command_from_existing_path(candidate, source);
        }

        return ResolvedBinary {
            program: None,
            args: Vec::new(),
            display: Some(trimmed.to_string()),
            source,
        };
    }

    if let Some(found) = find_program(trimmed) {
        return command_from_existing_path(found, source);
    }

    ResolvedBinary {
        program: None,
        args: Vec::new(),
        display: Some(trimmed.to_string()),
        source,
    }
}

fn command_from_existing_path(path: PathBuf, source: AiRuntimeBinarySource) -> ResolvedBinary {
    ResolvedBinary {
        program: Some(path.display().to_string()),
        args: Vec::new(),
        display: Some(path.display().to_string()),
        source,
    }
}

fn find_program(program: &str) -> Option<PathBuf> {
    find_program_on_preferred_path(program)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::secret_store::test_lock;

    fn temp_setup_path(name: &str) -> PathBuf {
        let dir = env::temp_dir().join(format!(
            "neverwrite-kilo-setup-tests-{}-{}",
            std::process::id(),
            name
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir.join(SETUP_FILE_NAME)
    }

    #[test]
    fn writes_and_loads_public_setup_config() {
        let path = temp_setup_path("roundtrip");
        let config = KiloSetupConfig {
            custom_binary_path: Some("/tmp/kilo".to_string()),
            auth_invalidated_at_ms: None,
        };

        write_setup_config_to_path(&path, &config).expect("write setup");
        let loaded = load_setup_config_from_path(&path).expect("load setup");

        assert_eq!(loaded.custom_binary_path.as_deref(), Some("/tmp/kilo"));

        let _ = fs::remove_file(path);
    }

    #[test]
    fn resolve_binary_command_prefers_existing_custom_binary() {
        let _guard = test_lock().lock().unwrap();
        let original = env::var_os("NEVERWRITE_KILO_ACP_BIN");
        env::remove_var("NEVERWRITE_KILO_ACP_BIN");

        let config = KiloSetupConfig {
            custom_binary_path: Some("/bin/sh".to_string()),
            auth_invalidated_at_ms: None,
        };

        let resolved = resolve_binary_command(&config);

        match original {
            Some(value) => env::set_var("NEVERWRITE_KILO_ACP_BIN", value),
            None => env::remove_var("NEVERWRITE_KILO_ACP_BIN"),
        }

        assert_eq!(resolved.program.as_deref(), Some("/bin/sh"));
        assert_eq!(resolved.source, AiRuntimeBinarySource::Custom);
    }

    #[test]
    fn resolve_binary_command_uses_env_override_when_present() {
        let _guard = test_lock().lock().unwrap();
        let original = env::var_os("NEVERWRITE_KILO_ACP_BIN");
        env::set_var("NEVERWRITE_KILO_ACP_BIN", "/bin/sh");

        let resolved = resolve_binary_command(&KiloSetupConfig::default());

        match original {
            Some(value) => env::set_var("NEVERWRITE_KILO_ACP_BIN", value),
            None => env::remove_var("NEVERWRITE_KILO_ACP_BIN"),
        }

        assert_eq!(resolved.program.as_deref(), Some("/bin/sh"));
        assert_eq!(resolved.source, AiRuntimeBinarySource::Env);
    }

    #[test]
    fn detect_auth_method_uses_active_auth_store_entries() {
        let _guard = test_lock().lock().unwrap();
        let temp_dir =
            env::temp_dir().join(format!("neverwrite-kilo-auth-tests-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(temp_dir.join("kilo")).expect("create kilo data dir");

        let original = env::var_os("XDG_DATA_HOME");
        env::set_var("XDG_DATA_HOME", &temp_dir);
        fs::write(
            temp_dir.join("kilo").join("auth.json"),
            serde_json::json!({
                "kilo": {
                    "type": "oauth",
                    "access": "access",
                    "refresh": "refresh",
                    "expires": current_time_millis() + 60_000
                }
            })
            .to_string(),
        )
        .expect("write auth.json");

        let detected = detect_auth_method(&KiloSetupConfig::default()).expect("detect auth method");

        match original {
            Some(value) => env::set_var("XDG_DATA_HOME", value),
            None => env::remove_var("XDG_DATA_HOME"),
        }
        let _ = fs::remove_dir_all(&temp_dir);

        assert_eq!(detected.as_deref(), Some(KILO_LOGIN_METHOD_ID));
    }

    #[test]
    fn detect_auth_method_uses_active_sqlite_account_state() {
        let _guard = test_lock().lock().unwrap();
        let temp_dir = env::temp_dir().join(format!(
            "neverwrite-kilo-sqlite-auth-tests-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(temp_dir.join("kilo")).expect("create kilo data dir");

        let database_path = temp_dir.join("kilo").join("kilo.db");
        let connection = Connection::open(&database_path).expect("open sqlite db");
        connection
            .execute_batch(
                r#"
                CREATE TABLE account (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL,
                    url TEXT NOT NULL,
                    access_token TEXT NOT NULL,
                    refresh_token TEXT NOT NULL,
                    token_expiry INTEGER,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL
                );
                CREATE TABLE account_state (
                    id INTEGER PRIMARY KEY NOT NULL,
                    active_account_id TEXT,
                    active_org_id TEXT
                );
                INSERT INTO account (
                    id,
                    email,
                    url,
                    access_token,
                    refresh_token,
                    token_expiry,
                    time_created,
                    time_updated
                ) VALUES (
                    'acct_1',
                    'user@example.com',
                    'https://kilo.example',
                    'access-token',
                    'refresh-token',
                    4102444800000,
                    1,
                    1
                );
                INSERT INTO account_state (id, active_account_id, active_org_id)
                VALUES (1, 'acct_1', NULL);
                "#,
            )
            .expect("seed sqlite auth state");

        let original = env::var_os("XDG_DATA_HOME");
        env::set_var("XDG_DATA_HOME", &temp_dir);

        let detected = detect_auth_method(&KiloSetupConfig::default()).expect("detect auth method");

        match original {
            Some(value) => env::set_var("XDG_DATA_HOME", value),
            None => env::remove_var("XDG_DATA_HOME"),
        }
        let _ = fs::remove_dir_all(&temp_dir);

        assert_eq!(detected.as_deref(), Some(KILO_LOGIN_METHOD_ID));
    }

    #[test]
    fn detect_auth_method_respects_invalidation_until_auth_store_changes() {
        let _guard = test_lock().lock().unwrap();
        let temp_dir = env::temp_dir().join(format!(
            "neverwrite-kilo-auth-invalidated-tests-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(temp_dir.join("kilo")).expect("create kilo data dir");

        let original = env::var_os("XDG_DATA_HOME");
        env::set_var("XDG_DATA_HOME", &temp_dir);
        fs::write(
            temp_dir.join("kilo").join("auth.json"),
            serde_json::json!({
                "kilo": {
                    "type": "api",
                    "key": "secret"
                }
            })
            .to_string(),
        )
        .expect("write auth.json");

        let modified_at_ms = fs::metadata(temp_dir.join("kilo").join("auth.json"))
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .and_then(system_time_to_millis)
            .expect("auth.json modified time");

        let detected = detect_auth_method(&KiloSetupConfig {
            custom_binary_path: None,
            auth_invalidated_at_ms: Some(modified_at_ms),
        })
        .expect("detect auth method");

        match original {
            Some(value) => env::set_var("XDG_DATA_HOME", value),
            None => env::remove_var("XDG_DATA_HOME"),
        }
        let _ = fs::remove_dir_all(&temp_dir);

        assert_eq!(detected, None);
    }

    #[test]
    fn detect_auth_method_falls_back_to_legacy_auth_when_sqlite_has_no_active_rows() {
        let _guard = test_lock().lock().unwrap();
        let temp_dir = env::temp_dir().join(format!(
            "neverwrite-kilo-auth-fallback-tests-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&temp_dir);
        fs::create_dir_all(temp_dir.join("kilo")).expect("create kilo data dir");

        let database_path = temp_dir.join("kilo").join("kilo.db");
        let connection = Connection::open(&database_path).expect("open sqlite db");
        connection
            .execute_batch(
                r#"
                CREATE TABLE account (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL,
                    url TEXT NOT NULL,
                    access_token TEXT NOT NULL,
                    refresh_token TEXT NOT NULL,
                    token_expiry INTEGER,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL
                );
                CREATE TABLE account_state (
                    id INTEGER PRIMARY KEY NOT NULL,
                    active_account_id TEXT,
                    active_org_id TEXT
                );
                CREATE TABLE control_account (
                    email TEXT NOT NULL,
                    url TEXT NOT NULL,
                    access_token TEXT NOT NULL,
                    refresh_token TEXT NOT NULL,
                    token_expiry INTEGER,
                    active INTEGER NOT NULL,
                    time_created INTEGER NOT NULL,
                    time_updated INTEGER NOT NULL,
                    PRIMARY KEY (email, url)
                );
                "#,
            )
            .expect("seed empty sqlite schema");

        fs::write(
            temp_dir.join("kilo").join("auth.json"),
            serde_json::json!({
                "kilo": {
                    "type": "oauth",
                    "access": "access",
                    "refresh": "refresh",
                    "expires": current_time_millis() + 60_000
                }
            })
            .to_string(),
        )
        .expect("write legacy auth.json");

        let original = env::var_os("XDG_DATA_HOME");
        env::set_var("XDG_DATA_HOME", &temp_dir);

        let detected = detect_auth_method(&KiloSetupConfig::default()).expect("detect auth method");

        match original {
            Some(value) => env::set_var("XDG_DATA_HOME", value),
            None => env::remove_var("XDG_DATA_HOME"),
        }
        let _ = fs::remove_dir_all(&temp_dir);

        assert_eq!(detected.as_deref(), Some(KILO_LOGIN_METHOD_ID));
    }
}
