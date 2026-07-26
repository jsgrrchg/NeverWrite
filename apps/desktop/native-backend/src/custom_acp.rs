use std::collections::{BTreeMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use neverwrite_ai::{
    custom_runtimes::{
        calculate_custom_acp_launch_fingerprint, create_custom_acp_runtime_definition,
        is_custom_acp_runtime_id, normalize_persisted_custom_acp_runtime_definition,
        update_custom_acp_runtime_definition, validate_custom_acp_runtime_input, CustomAcpAuthMode,
        CustomAcpRuntimeDefinition, CustomAcpRuntimeDefinitionInput, MAX_CUSTOM_ACP_RUNTIME_COUNT,
    },
    AiRuntimeBinarySource, AiRuntimeSetupStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const CUSTOM_ACP_RUNTIME_STORE_VERSION: u32 = 1;
const SAFE_CUSTOM_ACP_ENV_KEYS: &[&str] = &[
    "APPDATA",
    "HOME",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
];
const USER_RUNTIME_PATHS: &[&str] = &[
    "bin",
    ".grok/bin",
    ".opencode/bin",
    ".local/bin",
    ".npm-global/bin",
    ".yarn/bin",
    ".bun/bin",
    ".deno/bin",
    ".cargo/bin",
    "Library/pnpm",
    ".volta/bin",
    ".asdf/shims",
    ".local/share/mise/shims",
];
#[cfg(not(windows))]
const SYSTEM_RUNTIME_PATHS: &[&str] = &[
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum CustomAcpExecutableVerificationState {
    Ready,
    Missing,
    NotExecutable,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CustomAcpExecutableVerification {
    state: CustomAcpExecutableVerificationState,
    command: String,
    executable_path: Option<String>,
    message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CustomAcpLaunchSnapshot {
    pub(crate) runtime_id: String,
    pub(crate) display_name: String,
    pub(crate) configured_command: String,
    pub(crate) program: PathBuf,
    pub(crate) args: Vec<String>,
    pub(crate) configured_env: BTreeMap<String, String>,
    pub(crate) env: BTreeMap<String, String>,
    pub(crate) revision: u64,
    pub(crate) launch_fingerprint: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ExecutableResolution {
    Ready(PathBuf),
    Missing,
    NotExecutable(PathBuf),
}

#[derive(Debug, Clone, Default)]
struct CustomAcpRuntimeSettings {
    runtimes: Vec<CustomAcpRuntimeDefinition>,
    deleted_runtimes: Vec<CustomAcpRuntimeDefinition>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PersistedCustomAcpRuntimeSettings<'a> {
    version: u32,
    runtimes: &'a [CustomAcpRuntimeDefinition],
    deleted_runtimes: &'a [CustomAcpRuntimeDefinition],
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedCustomAcpRuntimeCandidate {
    id: String,
    display_name: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    auth_mode: CustomAcpAuthMode,
    revision: u64,
}

impl PersistedCustomAcpRuntimeCandidate {
    fn into_definition(self) -> CustomAcpRuntimeDefinition {
        CustomAcpRuntimeDefinition {
            id: self.id,
            display_name: self.display_name,
            command: self.command,
            args: self.args,
            env: self.env,
            auth_mode: self.auth_mode,
            revision: self.revision,
            // Persisted fingerprints are deliberately ignored and recalculated.
            launch_fingerprint: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
struct CustomAcpRuntimeStore {
    path: PathBuf,
}

impl CustomAcpRuntimeStore {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn load(&self) -> Result<(CustomAcpRuntimeSettings, Vec<String>), String> {
        let raw = match std::fs::read_to_string(&self.path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok((CustomAcpRuntimeSettings::default(), Vec::new()));
            }
            Err(error) => {
                return Err(format!("Failed to read custom ACP runtime store: {error}"));
            }
        };
        let value: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(_) => {
                return Ok((
                    CustomAcpRuntimeSettings::default(),
                    vec!["Discarded malformed custom ACP runtime settings.".to_string()],
                ));
            }
        };
        Ok(normalize_persisted_settings(value))
    }

    fn save(&self, settings: &CustomAcpRuntimeSettings) -> Result<(), String> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "Custom ACP runtime store has no parent directory.".to_string())?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create custom ACP runtime directory: {error}"))?;

        let persisted = PersistedCustomAcpRuntimeSettings {
            version: CUSTOM_ACP_RUNTIME_STORE_VERSION,
            runtimes: &settings.runtimes,
            deleted_runtimes: &settings.deleted_runtimes,
        };
        let encoded = serde_json::to_vec_pretty(&persisted)
            .map_err(|error| format!("Failed to encode custom ACP runtime store: {error}"))?;
        let temp_path = temporary_store_path(&self.path);
        let result = write_store_file(&temp_path, &encoded).and_then(|_| {
            replace_store_file(&temp_path, &self.path)
                .map_err(|error| format!("Failed to replace custom ACP runtime store: {error}"))
        });
        if result.is_err() {
            let _ = std::fs::remove_file(&temp_path);
        }
        result
    }
}

#[derive(Debug, Default)]
struct CustomAcpRuntimeManagerState {
    settings: CustomAcpRuntimeSettings,
    load_error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct CustomAcpRuntimeManager {
    store: CustomAcpRuntimeStore,
    state: Arc<Mutex<CustomAcpRuntimeManagerState>>,
}

impl CustomAcpRuntimeManager {
    pub(crate) fn new(path: PathBuf) -> Self {
        let store = CustomAcpRuntimeStore::new(path);
        let (settings, load_error) = match store.load() {
            Ok((settings, diagnostics)) => {
                emit_load_diagnostics(&diagnostics);
                (settings, None)
            }
            Err(error) => (CustomAcpRuntimeSettings::default(), Some(error)),
        };
        Self {
            store,
            state: Arc::new(Mutex::new(CustomAcpRuntimeManagerState {
                settings,
                load_error,
            })),
        }
    }

    pub(crate) fn list(&self) -> Result<Vec<CustomAcpRuntimeDefinition>, String> {
        let state = self.lock_state()?;
        ensure_store_loaded(&state)?;
        Ok(state.settings.runtimes.clone())
    }

    pub(crate) fn list_deleted(&self) -> Result<Vec<CustomAcpRuntimeDefinition>, String> {
        let state = self.lock_state()?;
        ensure_store_loaded(&state)?;
        Ok(state.settings.deleted_runtimes.clone())
    }

    pub(crate) fn definition(
        &self,
        runtime_id: &str,
    ) -> Result<Option<CustomAcpRuntimeDefinition>, String> {
        validate_custom_runtime_id(runtime_id)?;
        let state = self.lock_state()?;
        ensure_store_loaded(&state)?;
        Ok(state
            .settings
            .runtimes
            .iter()
            .find(|definition| definition.id == runtime_id)
            .cloned())
    }

    pub(crate) fn setup_status(&self, runtime_id: &str) -> Result<AiRuntimeSetupStatus, String> {
        let definition = self
            .definition(runtime_id)?
            .ok_or_else(|| format!("Custom ACP runtime not found: {runtime_id}"))?;
        let resolution = resolve_executable(&definition.command);
        let (binary_ready, binary_path, message) = match resolution {
            ExecutableResolution::Ready(path) => (true, Some(path.display().to_string()), None),
            ExecutableResolution::Missing => (
                false,
                None,
                Some(format!(
                    "Custom ACP executable was not found: {}",
                    definition.command
                )),
            ),
            ExecutableResolution::NotExecutable(path) => (
                false,
                Some(path.display().to_string()),
                Some(format!(
                    "Custom ACP executable is not executable: {}",
                    definition.command
                )),
            ),
        };
        Ok(AiRuntimeSetupStatus {
            runtime_id: definition.id,
            binary_ready,
            binary_path,
            binary_source: if binary_ready {
                AiRuntimeBinarySource::Custom
            } else {
                AiRuntimeBinarySource::Missing
            },
            has_custom_binary_path: true,
            auth_ready: true,
            auth_method: Some("external".to_string()),
            auth_methods: Vec::new(),
            claude_provider_routing: None,
            has_gateway_config: false,
            has_gateway_url: false,
            onboarding_required: !binary_ready,
            message,
        })
    }

    pub(crate) fn resolve_launch(
        &self,
        runtime_id: &str,
    ) -> Result<CustomAcpLaunchSnapshot, String> {
        let definition = self
            .definition(runtime_id)?
            .ok_or_else(|| format!("Custom ACP runtime not found: {runtime_id}"))?;
        let expected_fingerprint = calculate_custom_acp_launch_fingerprint(&definition.as_input());
        if definition.launch_fingerprint != expected_fingerprint {
            return Err(format!(
                "Custom ACP runtime launch fingerprint is invalid: {runtime_id}"
            ));
        }
        let program = match resolve_executable(&definition.command) {
            ExecutableResolution::Ready(path) => path,
            ExecutableResolution::Missing => {
                return Err(format!(
                    "Custom ACP executable was not found: {}",
                    definition.command
                ));
            }
            ExecutableResolution::NotExecutable(_) => {
                return Err(format!(
                    "Custom ACP executable is not executable: {}",
                    definition.command
                ));
            }
        };
        let env = build_isolated_custom_acp_env(&program, &definition.env)?;
        Ok(CustomAcpLaunchSnapshot {
            runtime_id: definition.id,
            display_name: definition.display_name,
            configured_command: definition.command,
            program,
            args: definition.args,
            configured_env: definition.env,
            env,
            revision: definition.revision,
            launch_fingerprint: definition.launch_fingerprint,
        })
    }

    pub(crate) fn create(
        &self,
        input: CustomAcpRuntimeDefinitionInput,
    ) -> Result<CustomAcpRuntimeDefinition, String> {
        let mut state = self.lock_state()?;
        self.reload_after_load_error(&mut state)?;
        if state.settings.runtimes.len() >= MAX_CUSTOM_ACP_RUNTIME_COUNT {
            return Err(format!(
                "At most {MAX_CUSTOM_ACP_RUNTIME_COUNT} custom runtimes are supported."
            ));
        }
        let definition = create_custom_acp_runtime_definition(input, &state.settings.runtimes)?;
        if state
            .settings
            .deleted_runtimes
            .iter()
            .any(|candidate| candidate.id == definition.id)
        {
            return Err("Failed to allocate a unique custom runtime ID.".to_string());
        }
        let mut next = state.settings.clone();
        next.runtimes.push(definition.clone());
        self.store.save(&next)?;
        state.settings = next;
        Ok(definition)
    }

    pub(crate) fn update(
        &self,
        runtime_id: &str,
        input: CustomAcpRuntimeDefinitionInput,
    ) -> Result<CustomAcpRuntimeDefinition, String> {
        validate_custom_runtime_id(runtime_id)?;
        let mut state = self.lock_state()?;
        self.reload_after_load_error(&mut state)?;
        let current = state
            .settings
            .runtimes
            .iter()
            .find(|definition| definition.id == runtime_id)
            .cloned()
            .ok_or_else(|| format!("Custom ACP runtime not found: {runtime_id}"))?;
        let definition =
            update_custom_acp_runtime_definition(&current, input, &state.settings.runtimes)?;
        let mut next = state.settings.clone();
        let target = next
            .runtimes
            .iter_mut()
            .find(|candidate| candidate.id == runtime_id)
            .expect("current custom ACP runtime must exist in cloned settings");
        *target = definition.clone();
        self.store.save(&next)?;
        state.settings = next;
        Ok(definition)
    }

    pub(crate) fn delete(&self, runtime_id: &str) -> Result<CustomAcpRuntimeDefinition, String> {
        validate_custom_runtime_id(runtime_id)?;
        let mut state = self.lock_state()?;
        self.reload_after_load_error(&mut state)?;
        if state.settings.deleted_runtimes.len() >= MAX_CUSTOM_ACP_RUNTIME_COUNT {
            return Err(format!(
                "At most {MAX_CUSTOM_ACP_RUNTIME_COUNT} deleted custom runtimes can be retained. Restore one before deleting another."
            ));
        }
        let index = state
            .settings
            .runtimes
            .iter()
            .position(|definition| definition.id == runtime_id)
            .ok_or_else(|| format!("Custom ACP runtime not found: {runtime_id}"))?;
        let mut next = state.settings.clone();
        let definition = next.runtimes.remove(index);
        next.deleted_runtimes.push(definition.clone());
        self.store.save(&next)?;
        state.settings = next;
        Ok(definition)
    }

    pub(crate) fn restore(&self, runtime_id: &str) -> Result<CustomAcpRuntimeDefinition, String> {
        validate_custom_runtime_id(runtime_id)?;
        let mut state = self.lock_state()?;
        self.reload_after_load_error(&mut state)?;
        if state.settings.runtimes.len() >= MAX_CUSTOM_ACP_RUNTIME_COUNT {
            return Err(format!(
                "At most {MAX_CUSTOM_ACP_RUNTIME_COUNT} custom runtimes are supported."
            ));
        }
        let index = state
            .settings
            .deleted_runtimes
            .iter()
            .position(|definition| definition.id == runtime_id)
            .ok_or_else(|| format!("Deleted custom ACP runtime not found: {runtime_id}"))?;
        let definition = normalize_persisted_custom_acp_runtime_definition(
            state.settings.deleted_runtimes[index].clone(),
            &state.settings.runtimes,
        )?;
        let mut next = state.settings.clone();
        next.deleted_runtimes.remove(index);
        next.runtimes.push(definition.clone());
        self.store.save(&next)?;
        state.settings = next;
        Ok(definition)
    }

    pub(crate) fn verify(
        &self,
        input: CustomAcpRuntimeDefinitionInput,
    ) -> Result<CustomAcpExecutableVerification, String> {
        let input = validate_custom_acp_runtime_input(input, &[], None)?;
        Ok(verify_executable(&input.command))
    }

    fn reload_after_load_error(
        &self,
        state: &mut CustomAcpRuntimeManagerState,
    ) -> Result<(), String> {
        if state.load_error.is_none() {
            return Ok(());
        }
        let (settings, diagnostics) = self.store.load()?;
        emit_load_diagnostics(&diagnostics);
        state.settings = settings;
        state.load_error = None;
        Ok(())
    }

    fn lock_state(
        &self,
    ) -> Result<std::sync::MutexGuard<'_, CustomAcpRuntimeManagerState>, String> {
        self.state
            .lock()
            .map_err(|error| format!("Internal custom ACP runtime state error: {error}"))
    }
}

pub(crate) fn revalidate_custom_acp_launch(launch: &CustomAcpLaunchSnapshot) -> Result<(), String> {
    validate_custom_runtime_id(&launch.runtime_id)?;
    if launch.display_name.trim().is_empty()
        || launch.configured_command.trim().is_empty()
        || launch.revision == 0
        || !launch.program.is_absolute()
        || !is_executable_file(&launch.program)
    {
        return Err(format!(
            "Custom ACP runtime launch snapshot is invalid: {}",
            launch.runtime_id
        ));
    }
    let fingerprint_input = CustomAcpRuntimeDefinitionInput {
        display_name: launch.display_name.clone(),
        command: launch.configured_command.clone(),
        args: launch.args.clone(),
        env: launch.configured_env.clone(),
        auth_mode: CustomAcpAuthMode::External,
    };
    if calculate_custom_acp_launch_fingerprint(&fingerprint_input) != launch.launch_fingerprint {
        return Err(format!(
            "Custom ACP runtime launch fingerprint is invalid: {}",
            launch.runtime_id
        ));
    }
    Ok(())
}

fn validate_custom_runtime_id(runtime_id: &str) -> Result<(), String> {
    if is_custom_acp_runtime_id(runtime_id) {
        Ok(())
    } else {
        Err(format!("Invalid custom ACP runtime ID: {runtime_id}"))
    }
}

fn ensure_store_loaded(state: &CustomAcpRuntimeManagerState) -> Result<(), String> {
    match &state.load_error {
        Some(error) => Err(error.clone()),
        None => Ok(()),
    }
}

fn normalize_persisted_settings(value: Value) -> (CustomAcpRuntimeSettings, Vec<String>) {
    let Some(object) = value.as_object() else {
        return (
            CustomAcpRuntimeSettings::default(),
            vec!["Discarded malformed custom ACP runtime settings.".to_string()],
        );
    };
    if object.get("version").and_then(Value::as_u64)
        != Some(u64::from(CUSTOM_ACP_RUNTIME_STORE_VERSION))
    {
        return (
            CustomAcpRuntimeSettings::default(),
            vec!["Discarded custom ACP runtime settings with an unsupported version.".to_string()],
        );
    }
    let Some(runtime_values) = object.get("runtimes").and_then(Value::as_array) else {
        return (
            CustomAcpRuntimeSettings::default(),
            vec!["Discarded malformed custom ACP runtime settings.".to_string()],
        );
    };

    let mut diagnostics = Vec::new();
    if runtime_values.len() > MAX_CUSTOM_ACP_RUNTIME_COUNT {
        diagnostics.push(format!(
            "Discarded custom ACP runtimes beyond the supported maximum of {MAX_CUSTOM_ACP_RUNTIME_COUNT}."
        ));
    }
    let mut runtimes = Vec::new();
    let mut ids = HashSet::new();
    for (index, value) in runtime_values
        .iter()
        .take(MAX_CUSTOM_ACP_RUNTIME_COUNT)
        .enumerate()
    {
        let candidate = serde_json::from_value::<PersistedCustomAcpRuntimeCandidate>(value.clone())
            .map(PersistedCustomAcpRuntimeCandidate::into_definition)
            .and_then(|definition| {
                normalize_persisted_custom_acp_runtime_definition(definition, &runtimes)
                    .map_err(serde::de::Error::custom)
            });
        match candidate {
            Ok(definition) if ids.insert(definition.id.clone()) => runtimes.push(definition),
            _ => diagnostics.push(format!(
                "Discarded malformed custom ACP runtime at index {index}."
            )),
        }
    }

    let deleted_values = match object.get("deletedRuntimes") {
        None => &[][..],
        Some(value) => match value.as_array() {
            Some(values) => values.as_slice(),
            None => {
                diagnostics
                    .push("Discarded malformed deleted custom ACP runtime settings.".to_string());
                &[]
            }
        },
    };
    if deleted_values.len() > MAX_CUSTOM_ACP_RUNTIME_COUNT {
        diagnostics.push(format!(
            "Discarded deleted custom ACP runtimes beyond the supported maximum of {MAX_CUSTOM_ACP_RUNTIME_COUNT}."
        ));
    }
    let mut deleted_runtimes = Vec::new();
    for (index, value) in deleted_values
        .iter()
        .take(MAX_CUSTOM_ACP_RUNTIME_COUNT)
        .enumerate()
    {
        let candidate = serde_json::from_value::<PersistedCustomAcpRuntimeCandidate>(value.clone())
            .map(PersistedCustomAcpRuntimeCandidate::into_definition)
            .and_then(|definition| {
                normalize_persisted_custom_acp_runtime_definition(definition, &[])
                    .map_err(serde::de::Error::custom)
            });
        match candidate {
            Ok(definition) if ids.insert(definition.id.clone()) => {
                deleted_runtimes.push(definition)
            }
            _ => diagnostics.push(format!(
                "Discarded malformed deleted custom ACP runtime at index {index}."
            )),
        }
    }

    (
        CustomAcpRuntimeSettings {
            runtimes,
            deleted_runtimes,
        },
        diagnostics,
    )
}

fn emit_load_diagnostics(diagnostics: &[String]) {
    for diagnostic in diagnostics {
        eprintln!("Custom ACP runtime catalog: {diagnostic}");
    }
}

fn temporary_store_path(target: &Path) -> PathBuf {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    target.with_extension(format!("json.tmp-{}-{suffix}", std::process::id()))
}

fn write_store_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("Failed to create custom ACP runtime store: {error}"))?;
    file.write_all(bytes)
        .map_err(|error| format!("Failed to write custom ACP runtime store: {error}"))?;
    file.flush()
        .map_err(|error| format!("Failed to flush custom ACP runtime store: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Failed to sync custom ACP runtime store: {error}"))
}

#[cfg(windows)]
fn replace_store_file(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(target_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    std::fs::rename(temp_path, target_path)
}

#[cfg(not(windows))]
fn replace_store_file(temp_path: &Path, target_path: &Path) -> std::io::Result<()> {
    std::fs::rename(temp_path, target_path)
}

fn verify_executable(command: &str) -> CustomAcpExecutableVerification {
    match resolve_executable(command) {
        ExecutableResolution::Missing => CustomAcpExecutableVerification {
            state: CustomAcpExecutableVerificationState::Missing,
            command: command.to_string(),
            executable_path: None,
            message: Some(format!("Custom ACP executable was not found: {command}")),
        },
        ExecutableResolution::NotExecutable(path) => CustomAcpExecutableVerification {
            state: CustomAcpExecutableVerificationState::NotExecutable,
            command: command.to_string(),
            executable_path: Some(path.display().to_string()),
            message: Some(format!(
                "Custom ACP executable is not executable: {command}"
            )),
        },
        ExecutableResolution::Ready(path) => CustomAcpExecutableVerification {
            state: CustomAcpExecutableVerificationState::Ready,
            command: command.to_string(),
            executable_path: Some(path.display().to_string()),
            message: None,
        },
    }
}

fn resolve_executable(command: &str) -> ExecutableResolution {
    let home = runtime_home_dir();
    resolve_executable_with_home(command, home.as_deref())
}

fn resolve_executable_with_home(command: &str, home: Option<&Path>) -> ExecutableResolution {
    let raw_path = PathBuf::from(command);
    let base_candidates =
        if raw_path.is_absolute() || command.contains('/') || command.contains('\\') {
            let path = if raw_path.is_absolute() {
                raw_path
            } else {
                match std::env::current_dir() {
                    Ok(current_dir) => current_dir.join(raw_path),
                    Err(_) => return ExecutableResolution::Missing,
                }
            };
            vec![path]
        } else {
            controlled_runtime_path_entries(None, home)
                .into_iter()
                .map(|entry| entry.join(command))
                .collect()
        };

    let mut first_non_executable = None;
    for candidate in base_candidates
        .into_iter()
        .flat_map(executable_path_candidates)
    {
        if !candidate.is_file() {
            continue;
        }
        let candidate = std::fs::canonicalize(&candidate).unwrap_or(candidate);
        if is_executable_file(&candidate) {
            return ExecutableResolution::Ready(candidate);
        }
        first_non_executable.get_or_insert(candidate);
    }
    first_non_executable
        .map(ExecutableResolution::NotExecutable)
        .unwrap_or(ExecutableResolution::Missing)
}

fn runtime_home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .filter(|home| !home.is_empty())
        .map(PathBuf::from)
}

fn controlled_runtime_path_entries(executable: Option<&Path>, home: Option<&Path>) -> Vec<PathBuf> {
    let mut entries = Vec::new();
    if let Some(parent) = executable.and_then(Path::parent) {
        entries.push(parent.to_path_buf());
    }
    if let Some(home) = home {
        entries.extend(USER_RUNTIME_PATHS.iter().map(|entry| home.join(entry)));
    }
    #[cfg(not(windows))]
    entries.extend(SYSTEM_RUNTIME_PATHS.iter().map(PathBuf::from));
    #[cfg(windows)]
    if let Some(system_root) = std::env::var_os("SystemRoot").map(PathBuf::from) {
        entries.push(system_root.join("System32"));
        entries.push(system_root);
    }

    let mut seen = HashSet::new();
    entries.retain(|entry| seen.insert(entry.clone()));
    entries
}

fn build_isolated_custom_acp_env(
    executable: &Path,
    configured_env: &BTreeMap<String, String>,
) -> Result<BTreeMap<String, String>, String> {
    let mut env = BTreeMap::new();
    for key in SAFE_CUSTOM_ACP_ENV_KEYS {
        if let Ok(value) = std::env::var(key) {
            if !value.is_empty() {
                env.insert((*key).to_string(), value);
            }
        }
    }
    #[cfg(windows)]
    if let Ok(value) = std::env::var("PATHEXT") {
        if !value.is_empty() {
            env.insert("PATHEXT".to_string(), value);
        }
    }
    let home = runtime_home_dir();
    let path = std::env::join_paths(controlled_runtime_path_entries(
        Some(executable),
        home.as_deref(),
    ))
    .map_err(|error| format!("Failed to build custom ACP runtime PATH: {error}"))?
    .into_string()
    .map_err(|_| "Custom ACP runtime PATH contains non-Unicode text.".to_string())?;
    env.insert("PATH".to_string(), path);
    env.extend(configured_env.clone());
    Ok(env)
}

fn executable_path_candidates(candidate: PathBuf) -> Vec<PathBuf> {
    #[cfg(windows)]
    {
        if candidate.extension().is_some() {
            return vec![candidate];
        }
        // Batch and command shims require cmd.exe and are intentionally not
        // accepted as direct custom ACP executables.
        let mut candidates = vec![candidate.clone()];
        candidates.extend(
            ["COM", "EXE"]
                .into_iter()
                .map(|extension| candidate.with_extension(extension)),
        );
        candidates
    }
    #[cfg(not(windows))]
    {
        vec![candidate]
    }
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;

    path.metadata()
        .map(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(windows)]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
        && path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| {
                matches!(extension.to_ascii_lowercase().as_str(), "exe" | "com")
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    use neverwrite_ai::custom_runtimes::create_custom_acp_runtime_definition_with_id;

    fn input(name: &str, command: &str) -> CustomAcpRuntimeDefinitionInput {
        CustomAcpRuntimeDefinitionInput {
            display_name: name.to_string(),
            command: command.to_string(),
            args: vec!["--stdio".to_string()],
            env: BTreeMap::from([("AGENT_COLOR".to_string(), "blue".to_string())]),
            auth_mode: CustomAcpAuthMode::External,
        }
    }

    fn manager(path: &Path) -> CustomAcpRuntimeManager {
        CustomAcpRuntimeManager::new(path.to_path_buf())
    }

    #[test]
    fn crud_persists_and_restore_preserves_identity() {
        let temp = tempfile::tempdir().unwrap();
        let store_path = temp.path().join("ai/custom-acp-runtimes.json");
        let catalog = manager(&store_path);
        let created = catalog.create(input("Local agent", "agent-acp")).unwrap();

        let mut updated_input = created.as_input();
        updated_input.display_name = "Renamed agent".to_string();
        let updated = catalog.update(&created.id, updated_input).unwrap();
        assert_eq!(updated.id, created.id);
        assert_eq!(updated.revision, 2);
        assert_eq!(updated.launch_fingerprint, created.launch_fingerprint);

        let deleted = catalog.delete(&created.id).unwrap();
        assert_eq!(deleted.id, created.id);
        assert!(catalog.list().unwrap().is_empty());
        assert_eq!(catalog.list_deleted().unwrap(), vec![deleted.clone()]);

        let restored = catalog.restore(&created.id).unwrap();
        assert_eq!(restored, deleted);
        assert_eq!(catalog.list().unwrap(), vec![restored.clone()]);
        assert!(catalog.list_deleted().unwrap().is_empty());

        let reloaded = manager(&store_path);
        assert_eq!(reloaded.list().unwrap(), vec![restored]);
    }

    #[test]
    fn malformed_entries_are_discarded_and_fingerprints_are_recalculated() {
        let temp = tempfile::tempdir().unwrap();
        let store_path = temp.path().join("custom-acp-runtimes.json");
        let valid = create_custom_acp_runtime_definition_with_id(
            input("Valid", "agent-acp"),
            &[],
            "123e4567-e89b-12d3-a456-426614174000".to_string(),
        )
        .unwrap();
        let expected_fingerprint = valid.launch_fingerprint.clone();
        let mut valid_value = serde_json::to_value(valid).unwrap();
        valid_value["launchFingerprint"] = Value::String("forged".to_string());
        let malformed = serde_json::json!({
            "id": "custom:not-a-uuid",
            "displayName": "Invalid",
            "command": "agent-acp",
            "args": [],
            "env": {},
            "authMode": "external",
            "revision": 1,
            "launchFingerprint": "forged"
        });
        std::fs::write(
            &store_path,
            serde_json::to_vec(&serde_json::json!({
                "version": 1,
                "runtimes": [valid_value, malformed],
                "deletedRuntimes": "invalid"
            }))
            .unwrap(),
        )
        .unwrap();

        let manager = manager(&store_path);
        let loaded = manager.list().unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].launch_fingerprint, expected_fingerprint);
        assert!(manager.list_deleted().unwrap().is_empty());
    }

    #[test]
    fn malformed_root_loads_as_empty_and_can_be_recovered() {
        let temp = tempfile::tempdir().unwrap();
        let store_path = temp.path().join("custom-acp-runtimes.json");
        std::fs::write(&store_path, "not json").unwrap();

        let catalog = manager(&store_path);
        assert!(catalog.list().unwrap().is_empty());
        let created = catalog.create(input("Recovered", "agent-acp")).unwrap();
        let reloaded = manager(&store_path);
        assert_eq!(reloaded.list().unwrap(), vec![created]);
    }

    #[test]
    fn failed_atomic_save_does_not_commit_memory_state() {
        let temp = tempfile::tempdir().unwrap();
        let store_path = temp.path().join("custom-acp-runtimes.json");
        let manager = manager(&store_path);
        std::fs::create_dir(&store_path).unwrap();

        assert!(manager.create(input("Agent", "agent-acp")).is_err());
        assert!(manager.list().unwrap().is_empty());
    }

    #[test]
    fn active_and_deleted_capacities_are_enforced() {
        let temp = tempfile::tempdir().unwrap();
        let active_path = temp.path().join("active.json");
        let active = manager(&active_path);
        for index in 0..MAX_CUSTOM_ACP_RUNTIME_COUNT {
            active
                .create(input(&format!("Active {index}"), "agent-acp"))
                .unwrap();
        }
        assert!(active.create(input("Too many", "agent-acp")).is_err());

        let deleted_path = temp.path().join("deleted.json");
        let deleted = manager(&deleted_path);
        for index in 0..MAX_CUSTOM_ACP_RUNTIME_COUNT {
            let definition = deleted
                .create(input(&format!("Deleted {index}"), "agent-acp"))
                .unwrap();
            deleted.delete(&definition.id).unwrap();
        }
        let retained = deleted.create(input("Retained", "agent-acp")).unwrap();
        assert!(deleted.delete(&retained.id).is_err());
        assert_eq!(deleted.list().unwrap(), vec![retained]);
    }

    #[test]
    fn restore_rejects_duplicate_name_and_active_capacity() {
        let temp = tempfile::tempdir().unwrap();
        let duplicate_path = temp.path().join("duplicate.json");
        let duplicate = manager(&duplicate_path);
        let first = duplicate.create(input("Agent", "one-acp")).unwrap();
        duplicate.delete(&first.id).unwrap();
        duplicate.create(input("Agent", "two-acp")).unwrap();
        assert!(duplicate.restore(&first.id).is_err());

        let capacity_path = temp.path().join("capacity.json");
        let capacity = manager(&capacity_path);
        let deleted = capacity.create(input("Deleted", "agent-acp")).unwrap();
        capacity.delete(&deleted.id).unwrap();
        for index in 0..MAX_CUSTOM_ACP_RUNTIME_COUNT {
            capacity
                .create(input(&format!("Active {index}"), "agent-acp"))
                .unwrap();
        }
        assert!(capacity.restore(&deleted.id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn resolves_command_names_from_the_controlled_runtime_path() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join(".local/bin/agent-acp");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(
            resolve_executable_with_home("agent-acp", Some(temp.path())),
            ExecutableResolution::Ready(std::fs::canonicalize(executable).unwrap())
        );
    }

    #[cfg(unix)]
    #[test]
    fn launch_snapshot_is_isolated_and_immutable_after_catalog_changes() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let store_path = temp.path().join("custom-acp-runtimes.json");
        let executable = temp.path().join("agent-acp");
        std::fs::write(&executable, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let manager = manager(&store_path);
        let mut definition_input = input("Agent", &executable.display().to_string());
        definition_input.args = vec!["--literal".to_string(), "; touch must-not-run".to_string()];
        definition_input.env = BTreeMap::from([
            ("AGENT_COLOR".to_string(), "blue".to_string()),
            ("AGENT_MODE".to_string(), "review".to_string()),
        ]);
        let definition = manager.create(definition_input).unwrap();
        let launch = manager.resolve_launch(&definition.id).unwrap();

        assert!(launch.program.is_absolute());
        assert_eq!(launch.args, ["--literal", "; touch must-not-run"]);
        assert_eq!(
            launch.env.get("AGENT_COLOR").map(String::as_str),
            Some("blue")
        );
        assert_eq!(
            launch.env.get("AGENT_MODE").map(String::as_str),
            Some("review")
        );
        assert!(launch.env.contains_key("PATH"));
        for key in launch.env.keys() {
            assert!(
                *key == "PATH"
                    || SAFE_CUSTOM_ACP_ENV_KEYS.contains(&key.as_str())
                    || matches!(key.as_str(), "AGENT_COLOR" | "AGENT_MODE")
                    || cfg!(windows) && key == "PATHEXT",
                "unexpected inherited environment key: {key}"
            );
        }
        revalidate_custom_acp_launch(&launch).unwrap();

        let mut changed = definition.as_input();
        changed.command = "/missing/changed-agent-acp".to_string();
        manager.update(&definition.id, changed).unwrap();
        manager.delete(&definition.id).unwrap();

        revalidate_custom_acp_launch(&launch).unwrap();
        assert_eq!(launch.program, std::fs::canonicalize(executable).unwrap());
        assert!(manager.resolve_launch(&definition.id).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn custom_launches_do_not_share_configured_environment() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let store_path = temp.path().join("custom-acp-runtimes.json");
        let executable = temp.path().join("agent-acp");
        std::fs::write(&executable, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let manager = manager(&store_path);
        let mut first_input = input("First", &executable.display().to_string());
        first_input.env = BTreeMap::from([("FIRST_ONLY".to_string(), "one".to_string())]);
        let first = manager.create(first_input).unwrap();
        let mut second_input = input("Second", &executable.display().to_string());
        second_input.env = BTreeMap::from([("SECOND_ONLY".to_string(), "two".to_string())]);
        let second = manager.create(second_input).unwrap();

        let first_launch = manager.resolve_launch(&first.id).unwrap();
        let second_launch = manager.resolve_launch(&second.id).unwrap();
        assert_eq!(
            first_launch.env.get("FIRST_ONLY").map(String::as_str),
            Some("one")
        );
        assert!(!first_launch.env.contains_key("SECOND_ONLY"));
        assert_eq!(
            second_launch.env.get("SECOND_ONLY").map(String::as_str),
            Some("two")
        );
        assert!(!second_launch.env.contains_key("FIRST_ONLY"));
    }

    #[test]
    fn invalid_identity_and_fingerprint_block_launch_resolution() {
        let temp = tempfile::tempdir().unwrap();
        let store_path = temp.path().join("custom-acp-runtimes.json");
        let manager = manager(&store_path);
        assert!(manager.resolve_launch("custom:not-a-uuid").is_err());
        let definition = manager.create(input("Agent", "agent-acp")).unwrap();
        manager.state.lock().unwrap().settings.runtimes[0].launch_fingerprint =
            "forged".to_string();

        let error = manager.resolve_launch(&definition.id).unwrap_err();
        assert!(error.contains("fingerprint is invalid"));
    }

    #[cfg(unix)]
    #[test]
    fn setup_status_requires_an_executable_but_not_internal_authentication() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let store_path = temp.path().join("custom-acp-runtimes.json");
        let executable = temp.path().join("agent-acp");
        std::fs::write(&executable, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let manager = manager(&store_path);
        let ready = manager
            .create(input("Ready", &executable.display().to_string()))
            .unwrap();
        let missing = manager
            .create(input("Missing", "/missing/custom-agent-acp"))
            .unwrap();

        let ready_status = manager.setup_status(&ready.id).unwrap();
        assert!(ready_status.binary_ready);
        assert!(ready_status.auth_ready);
        assert_eq!(ready_status.auth_method.as_deref(), Some("external"));
        assert!(ready_status.auth_methods.is_empty());
        assert!(!ready_status.onboarding_required);

        let missing_status = manager.setup_status(&missing.id).unwrap();
        assert!(!missing_status.binary_ready);
        assert!(missing_status.auth_ready);
        assert!(missing_status.onboarding_required);
    }

    #[cfg(unix)]
    #[test]
    fn verify_checks_executable_without_starting_it() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().unwrap();
        let store_path = temp.path().join("custom-acp-runtimes.json");
        let executable = temp.path().join("agent-acp");
        let marker = temp.path().join("should-not-exist");
        std::fs::write(
            &executable,
            format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
        )
        .unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
        let manager = manager(&store_path);

        let verification = manager
            .verify(input("Agent", &executable.display().to_string()))
            .unwrap();
        assert_eq!(
            verification.state,
            CustomAcpExecutableVerificationState::Ready
        );
        assert!(!marker.exists());

        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o644)).unwrap();
        let verification = manager
            .verify(input("Agent", &executable.display().to_string()))
            .unwrap();
        assert_eq!(
            verification.state,
            CustomAcpExecutableVerificationState::NotExecutable
        );
    }
}
