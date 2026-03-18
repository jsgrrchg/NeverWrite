use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::UNIX_EPOCH;

#[derive(Default)]
struct SaveSlot {
    in_progress: bool,
    latest_content: Option<String>,
}

static MAP_SAVE_SLOTS: LazyLock<Mutex<HashMap<String, Arc<Mutex<SaveSlot>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_mutex<'a, T>(mutex: &'a Mutex<T>) -> Result<std::sync::MutexGuard<'a, T>, String> {
    mutex
        .lock()
        .map_err(|error| format!("Internal map save state error: {error}"))
}

fn get_save_slot(path: &str) -> Result<Arc<Mutex<SaveSlot>>, String> {
    let mut slots = lock_mutex(&MAP_SAVE_SLOTS)?;
    Ok(slots
        .entry(path.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(SaveSlot::default())))
        .clone())
}

fn cleanup_save_slot(path: &str, slot: &Arc<Mutex<SaveSlot>>) -> Result<(), String> {
    let should_remove = {
        let state = lock_mutex(slot)?;
        !state.in_progress && state.latest_content.is_none()
    };

    if !should_remove {
        return Ok(());
    }

    let mut slots = lock_mutex(&MAP_SAVE_SLOTS)?;
    if slots
        .get(path)
        .is_some_and(|current| Arc::ptr_eq(current, slot))
    {
        slots.remove(path);
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

#[derive(serde::Serialize)]
pub struct MapEntryDto {
    pub id: String,
    pub title: String,
    pub path: String,
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
            let abs = path.to_string_lossy().to_string();
            let rel = path
                .strip_prefix(vault_root)
                .unwrap_or(&path)
                .with_extension("")
                .to_string_lossy()
                .to_string();
            let title = path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            let mtime = fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            out.push((
                MapEntryDto {
                    id: rel,
                    title,
                    path: abs,
                },
                mtime,
            ));
        }
    }
}

#[tauri::command]
pub fn list_maps(vault_path: String) -> Result<Vec<MapEntryDto>, String> {
    let root = Path::new(&vault_path);
    if !root.is_dir() {
        return Err("Vault path is not a directory".into());
    }
    let mut entries = Vec::new();
    collect_excalidraw_files(root, root, &mut entries);
    entries.sort_by(|a, b| b.1.cmp(&a.1));
    Ok(entries.into_iter().map(|(dto, _)| dto).collect())
}

#[tauri::command]
pub fn read_map(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_map(path: String, content: String) -> Result<(), String> {
    let slot = get_save_slot(&path)?;

    {
        let mut state = lock_mutex(&slot)?;
        state.latest_content = Some(content);
        if state.in_progress {
            return Ok(());
        }
        state.in_progress = true;
    }

    let path_ref = Path::new(&path);

    loop {
        let next_content = {
            let mut state = lock_mutex(&slot)?;
            match state.latest_content.take() {
                Some(content) => content,
                None => {
                    state.in_progress = false;
                    drop(state);
                    let _ = cleanup_save_slot(&path, &slot);
                    return Ok(());
                }
            }
        };

        if let Err(error) = write_map_atomic(path_ref, &next_content) {
            let mut state = lock_mutex(&slot)?;
            if state.latest_content.is_none() {
                state.latest_content = Some(next_content);
            }
            state.in_progress = false;
            return Err(error);
        }
    }
}

#[tauri::command]
pub fn create_map(vault_path: String, name: String) -> Result<MapEntryDto, String> {
    let root = Path::new(&vault_path);
    let maps_dir = root.join("Excalidraw");
    if !maps_dir.is_dir() {
        fs::create_dir_all(&maps_dir).map_err(|e| e.to_string())?;
    }
    let mut file_path = maps_dir.join(format!("{name}.excalidraw"));

    // Avoid duplicate names
    let mut counter = 2u32;
    while file_path.exists() {
        file_path = maps_dir.join(format!("{name} ({counter}).excalidraw"));
        counter += 1;
    }

    let empty = r#"{"type":"excalidraw","version":2,"elements":[],"appState":{"viewBackgroundColor":"transparent"},"files":{}}"#;
    fs::write(&file_path, empty).map_err(|e| e.to_string())?;

    let abs = file_path.to_string_lossy().to_string();
    let rel = file_path
        .strip_prefix(root)
        .unwrap_or(&file_path)
        .with_extension("")
        .to_string_lossy()
        .to_string();
    let title = file_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    Ok(MapEntryDto {
        id: rel,
        title,
        path: abs,
    })
}

#[tauri::command]
pub fn delete_map(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notify_map_changed(path: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    app.emit("map-external-change", path)
        .map_err(|e| e.to_string())
}
