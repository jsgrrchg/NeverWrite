use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::UNIX_EPOCH;

use tauri::State;

use crate::AppState;

#[derive(Default)]
struct SaveSlot {
    in_progress: bool,
    latest_content: Option<String>,
}

#[derive(Clone, Debug, Eq)]
struct MapSaveSlotKey {
    vault_key: String,
    relative_path: String,
}

impl PartialEq for MapSaveSlotKey {
    fn eq(&self, other: &Self) -> bool {
        self.vault_key == other.vault_key && self.relative_path == other.relative_path
    }
}

impl Hash for MapSaveSlotKey {
    fn hash<H: Hasher>(&self, state: &mut H) {
        self.vault_key.hash(state);
        self.relative_path.hash(state);
    }
}

static MAP_SAVE_SLOTS: LazyLock<Mutex<HashMap<MapSaveSlotKey, Arc<Mutex<SaveSlot>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_mutex<'a, T>(mutex: &'a Mutex<T>) -> Result<std::sync::MutexGuard<'a, T>, String> {
    mutex
        .lock()
        .map_err(|error| format!("Internal map save state error: {error}"))
}

fn get_save_slot(key: &MapSaveSlotKey) -> Result<Arc<Mutex<SaveSlot>>, String> {
    let mut slots = lock_mutex(&MAP_SAVE_SLOTS)?;
    Ok(slots
        .entry(key.clone())
        .or_insert_with(|| Arc::new(Mutex::new(SaveSlot::default())))
        .clone())
}

fn cleanup_save_slot(key: &MapSaveSlotKey, slot: &Arc<Mutex<SaveSlot>>) -> Result<(), String> {
    let should_remove = {
        let state = lock_mutex(slot)?;
        !state.in_progress && state.latest_content.is_none()
    };

    if !should_remove {
        return Ok(());
    }

    let mut slots = lock_mutex(&MAP_SAVE_SLOTS)?;
    if slots
        .get(key)
        .is_some_and(|current| Arc::ptr_eq(current, slot))
    {
        slots.remove(key);
    }

    Ok(())
}

fn temp_map_path(path: &Path) -> Result<std::path::PathBuf, String> {
    let parent = path
        .parent()
        .ok_or_else(|| "Map path has no parent directory".to_string())?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Map file name is invalid".to_string())?;
    Ok(parent.join(format!(".{file_name}.tmp")))
}

fn write_map_atomic(path: &Path, content: &str) -> Result<(), String> {
    let temp_path = temp_map_path(path)?;
    fs::write(&temp_path, content).map_err(|error| error.to_string())?;

    if let Err(error) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(error.to_string());
    }

    Ok(())
}

#[derive(Debug, serde::Serialize)]
pub struct MapEntryDto {
    pub id: String,
    pub title: String,
    pub relative_path: String,
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct MapChangedPayload {
    pub vault_path: String,
    pub relative_path: String,
}

fn resolve_maps_vault_root(state: &AppState, vault_key: &str) -> Result<PathBuf, String> {
    let instance = state
        .vaults
        .get(vault_key)
        .ok_or("No hay vault abierto".to_string())?;
    let vault = instance
        .vault
        .as_ref()
        .ok_or("No hay vault abierto".to_string())?;
    Ok(vault.root.clone())
}

fn validate_untrusted_relative_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("Path de mapa inválido".to_string());
    }

    if raw.contains('\\') || raw.split('/').any(str::is_empty) {
        return Err("Path de mapa inválido".to_string());
    }

    let mut normalized = PathBuf::new();
    let mut has_component = false;

    for component in Path::new(raw).components() {
        match component {
            Component::Normal(value) => {
                let value = value.to_str().ok_or("Path de mapa inválido".to_string())?;
                if value == "." || value == ".." || looks_like_windows_prefix(value) {
                    return Err("Path de mapa inválido".to_string());
                }
                normalized.push(value);
                has_component = true;
            }
            Component::CurDir
            | Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_) => return Err("Path de mapa inválido".to_string()),
        }
    }

    if !has_component {
        return Err("Path de mapa inválido".to_string());
    }

    Ok(normalized)
}

fn looks_like_windows_prefix(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn normalize_map_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let normalized = validate_untrusted_relative_path(relative_path)?;
    let is_excalidraw = normalized
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("excalidraw"));
    if !is_excalidraw {
        return Err("Path de mapa inválido".to_string());
    }

    Ok(normalized)
}

fn normalize_map_relative_path_string(relative_path: &str) -> Result<String, String> {
    Ok(normalize_map_relative_path(relative_path)?
        .to_string_lossy()
        .to_string())
}

fn resolve_map_relative_path(
    vault_root: &Path,
    relative_path: &str,
) -> Result<(String, PathBuf), String> {
    let normalized_relative_path = normalize_map_relative_path_string(relative_path)?;
    Ok((
        normalized_relative_path.clone(),
        vault_root.join(&normalized_relative_path),
    ))
}

fn validate_map_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Nombre de mapa inválido".to_string());
    }

    let normalized = validate_untrusted_relative_path(trimmed)
        .map_err(|_| "Nombre de mapa inválido".to_string())?;
    if normalized.components().count() != 1 {
        return Err("Nombre de mapa inválido".to_string());
    }

    let file_name = normalized
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or("Nombre de mapa inválido".to_string())?;
    let file_name = file_name
        .strip_suffix(".excalidraw")
        .unwrap_or(file_name)
        .trim();
    if file_name.is_empty() || file_name == "." || file_name == ".." {
        return Err("Nombre de mapa inválido".to_string());
    }

    Ok(file_name.to_string())
}

fn build_map_entry(vault_root: &Path, path: &Path) -> Option<(MapEntryDto, u64)> {
    let relative_path = path
        .strip_prefix(vault_root)
        .ok()?
        .to_string_lossy()
        .to_string();
    let id = Path::new(&relative_path)
        .with_extension("")
        .to_string_lossy()
        .to_string();
    let title = path.file_stem()?.to_string_lossy().to_string();
    let mtime = fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    Some((
        MapEntryDto {
            id,
            title,
            relative_path,
        },
        mtime,
    ))
}

fn build_map_save_slot_key(vault_key: &str, relative_path: &str) -> MapSaveSlotKey {
    MapSaveSlotKey {
        vault_key: vault_key.to_string(),
        relative_path: relative_path.to_string(),
    }
}

fn list_maps_for_vault(vault_root: &Path) -> Vec<MapEntryDto> {
    let mut entries = Vec::new();
    collect_excalidraw_files(vault_root, vault_root, &mut entries);
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    entries.into_iter().map(|(dto, _)| dto).collect()
}

fn read_map_for_vault(vault_root: &Path, relative_path: &str) -> Result<String, String> {
    let (_, path) = resolve_map_relative_path(vault_root, relative_path)?;
    fs::read_to_string(path).map_err(|error| error.to_string())
}

fn save_map_for_vault(
    vault_root: &Path,
    vault_key: &str,
    relative_path: &str,
    content: String,
) -> Result<(), String> {
    let (normalized_relative_path, resolved_path) =
        resolve_map_relative_path(vault_root, relative_path)?;
    let slot_key = build_map_save_slot_key(vault_key, &normalized_relative_path);
    let slot = get_save_slot(&slot_key)?;

    {
        let mut state = lock_mutex(&slot)?;
        state.latest_content = Some(content);
        if state.in_progress {
            return Ok(());
        }
        state.in_progress = true;
    }

    loop {
        let next_content = {
            let mut state = lock_mutex(&slot)?;
            match state.latest_content.take() {
                Some(content) => content,
                None => {
                    state.in_progress = false;
                    drop(state);
                    let _ = cleanup_save_slot(&slot_key, &slot);
                    return Ok(());
                }
            }
        };

        if let Err(error) = write_map_atomic(&resolved_path, &next_content) {
            let mut state = lock_mutex(&slot)?;
            if state.latest_content.is_none() {
                state.latest_content = Some(next_content);
            }
            state.in_progress = false;
            return Err(error);
        }
    }
}

fn create_map_for_vault(vault_root: &Path, name: &str) -> Result<MapEntryDto, String> {
    let safe_name = validate_map_name(name)?;
    let maps_dir = vault_root.join("Excalidraw");
    if !maps_dir.is_dir() {
        fs::create_dir_all(&maps_dir).map_err(|error| error.to_string())?;
    }

    let mut file_path = maps_dir.join(format!("{safe_name}.excalidraw"));
    let mut counter = 2u32;
    while file_path.exists() {
        file_path = maps_dir.join(format!("{safe_name} ({counter}).excalidraw"));
        counter += 1;
    }

    let empty = r#"{"type":"excalidraw","version":2,"elements":[],"appState":{"viewBackgroundColor":"transparent"},"files":{}}"#;
    fs::write(&file_path, empty).map_err(|error| error.to_string())?;

    build_map_entry(vault_root, &file_path)
        .map(|(entry, _)| entry)
        .ok_or("No se pudo construir la metadata del mapa".to_string())
}

fn delete_map_for_vault(vault_root: &Path, relative_path: &str) -> Result<(), String> {
    let (_, path) = resolve_map_relative_path(vault_root, relative_path)?;
    fs::remove_file(path).map_err(|error| error.to_string())
}

fn collect_excalidraw_files(dir: &Path, vault_root: &Path, out: &mut Vec<(MapEntryDto, u64)>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_excalidraw_files(&path, vault_root, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("excalidraw"))
        {
            if let Some(entry) = build_map_entry(vault_root, &path) {
                out.push(entry);
            }
        }
    }
}

#[tauri::command]
pub fn list_maps(
    vault_path: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<Vec<MapEntryDto>, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_maps_vault_root(&state, &vault_path)?;
    Ok(list_maps_for_vault(&vault_root))
}

#[tauri::command]
pub fn read_map(
    vault_path: String,
    relative_path: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<String, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_maps_vault_root(&state, &vault_path)?;
    read_map_for_vault(&vault_root, &relative_path)
}

#[tauri::command]
pub fn save_map(
    vault_path: String,
    relative_path: String,
    content: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_maps_vault_root(&state, &vault_path)?;
    save_map_for_vault(&vault_root, &vault_path, &relative_path, content)
}

#[tauri::command]
pub fn create_map(
    vault_path: String,
    name: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<MapEntryDto, String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_maps_vault_root(&state, &vault_path)?;
    create_map_for_vault(&vault_root, &name)
}

#[tauri::command]
pub fn delete_map(
    vault_path: String,
    relative_path: String,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_maps_vault_root(&state, &vault_path)?;
    delete_map_for_vault(&vault_root, &relative_path)
}

#[tauri::command]
pub fn notify_map_changed(
    vault_path: String,
    relative_path: String,
    app: tauri::AppHandle,
    state: State<'_, Mutex<AppState>>,
) -> Result<(), String> {
    use tauri::Emitter;

    let state = state
        .lock()
        .map_err(|error| format!("Error de estado interno: {error}"))?;
    let vault_root = resolve_maps_vault_root(&state, &vault_path)?;
    let (normalized_relative_path, _) = resolve_map_relative_path(&vault_root, &relative_path)?;

    app.emit(
        "map-external-change",
        MapChangedPayload {
            vault_path,
            relative_path: normalized_relative_path,
        },
    )
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, Ordering};

    use neverwrite_vault::Vault;

    use crate::VaultInstance;

    static NEXT_TEST_ID: AtomicU64 = AtomicU64::new(0);

    fn make_map_test_root(label: &str) -> PathBuf {
        let unique_id = NEXT_TEST_ID.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "neverwrite-maps-test-{label}-{}-{}-{unique_id}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ))
    }

    fn make_open_vault_state(vault_key: &str) -> (PathBuf, AppState) {
        let dir = make_map_test_root("root");
        fs::create_dir_all(dir.join("Excalidraw")).unwrap();
        let vault = Vault::open(dir.clone()).unwrap();
        let root = vault.root.clone();
        let mut instance = VaultInstance::new();
        instance.vault = Some(vault);

        let mut state = AppState::new();
        state.vaults.insert(vault_key.to_string(), instance);
        (root, state)
    }

    #[test]
    fn resolve_maps_vault_root_returns_open_vault_root() {
        let (dir, state) = make_open_vault_state("/vault-a");
        let resolved =
            resolve_maps_vault_root(&state, "/vault-a").expect("vault root should resolve");
        assert_eq!(resolved, dir);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn resolve_maps_vault_root_rejects_unknown_vault_key() {
        let (dir, state) = make_open_vault_state("/vault-a");
        let error = resolve_maps_vault_root(&state, "/vault-b")
            .expect_err("unknown vault key should be rejected");
        assert_eq!(error, "No hay vault abierto");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn read_map_rejects_traversal() {
        let (dir, _state) = make_open_vault_state("/vault-a");
        fs::write(dir.join("Excalidraw/safe.excalidraw"), "{}").unwrap();

        let error = read_map_for_vault(&dir, "../outside.excalidraw")
            .expect_err("traversal should be rejected");
        assert_eq!(error, "Path de mapa inválido");

        let error = read_map_for_vault(&dir, "..\\\\outside.excalidraw")
            .expect_err("windows traversal should be rejected");
        assert_eq!(error, "Path de mapa inválido");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn save_map_rejects_traversal_without_writing_outside_vault() {
        let (dir, _state) = make_open_vault_state("/vault-a");
        let outside = dir
            .parent()
            .unwrap()
            .join(format!("outside-{}.excalidraw", std::process::id()));
        let _ = fs::remove_file(&outside);

        let error = save_map_for_vault(&dir, "/vault-a", "../outside.excalidraw", "{}".to_string())
            .expect_err("traversal should be rejected");
        assert_eq!(error, "Path de mapa inválido");
        assert!(!outside.exists());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn delete_map_rejects_traversal() {
        let (dir, _state) = make_open_vault_state("/vault-a");
        let error = delete_map_for_vault(&dir, "../outside.excalidraw")
            .expect_err("traversal should be rejected");
        assert_eq!(error, "Path de mapa inválido");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn create_map_rejects_invalid_names() {
        let (dir, _state) = make_open_vault_state("/vault-a");

        for invalid in [
            "",
            "../evil",
            "..\\\\evil",
            "nested/evil",
            "nested\\\\evil",
            ".",
            "..",
        ] {
            let error = create_map_for_vault(&dir, invalid)
                .expect_err("invalid map name should be rejected");
            assert_eq!(error, "Nombre de mapa inválido");
        }

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn create_map_creates_under_excalidraw_directory() {
        let (dir, _state) = make_open_vault_state("/vault-a");

        let entry =
            create_map_for_vault(&dir, "Architecture").expect("valid map should be created");
        let listed_maps = list_maps_for_vault(&dir);

        assert_eq!(entry.id, "Excalidraw/Architecture");
        assert_eq!(entry.relative_path, "Excalidraw/Architecture.excalidraw");
        assert!(listed_maps
            .iter()
            .any(|map| map.relative_path == entry.relative_path));
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn list_maps_returns_only_vault_scoped_excalidraw_files() {
        let (dir, _state) = make_open_vault_state("/vault-a");
        fs::create_dir_all(dir.join("Projects")).unwrap();
        fs::write(dir.join("Projects").join("Diagram.excalidraw"), "{}").unwrap();
        fs::write(dir.join("Projects").join("Notes.md"), "# note").unwrap();

        let maps = list_maps_for_vault(&dir);

        assert_eq!(maps.len(), 1);
        assert_eq!(maps[0].relative_path, "Projects/Diagram.excalidraw");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn build_map_save_slot_key_keeps_vault_and_relative_path_boundaries_distinct() {
        let left = build_map_save_slot_key("/vault:a", "b.excalidraw");
        let right = build_map_save_slot_key("/vault", "a:b.excalidraw");

        assert_ne!(left, right);
    }
}
