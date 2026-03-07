use std::sync::Mutex;

use vault_ai_index::VaultIndex;
use vault_ai_types::{
    BacklinkDto, IndexedNote, NoteDetailDto, NoteDocument, NoteDto, NoteId, SearchResultDto,
};
use vault_ai_vault::{Vault, WriteTracker};

struct AppState {
    vault: Option<Vault>,
    index: Option<VaultIndex>,
    write_tracker: WriteTracker,
}

macro_rules! lock {
    ($state:expr) => {
        $state
            .lock()
            .map_err(|e| format!("Error de estado interno: {e}"))
    };
}

fn get_file_times(path: &std::path::Path) -> (u64, u64) {
    let Ok(meta) = std::fs::metadata(path) else {
        return (0, 0);
    };
    let to_secs = |t: std::time::SystemTime| {
        t.duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    };
    let modified = meta.modified().map(to_secs).unwrap_or(0);
    let created = meta.created().map(to_secs).unwrap_or(modified);
    (modified, created)
}

fn note_to_dto(n: &IndexedNote) -> NoteDto {
    let (modified_at, created_at) = get_file_times(&n.path.0);
    NoteDto {
        id: n.id.0.clone(),
        path: n.path.0.to_string_lossy().to_string(),
        title: n.title.clone(),
        modified_at,
        created_at,
    }
}

fn note_to_detail(note: &NoteDocument) -> NoteDetailDto {
    NoteDetailDto {
        id: note.id.0.clone(),
        path: note.path.0.to_string_lossy().to_string(),
        title: note.title.clone(),
        content: note.raw_markdown.clone(),
        tags: note.tags.clone(),
        links: note.links.iter().map(|l| l.target.clone()).collect(),
        frontmatter: note.frontmatter.clone(),
    }
}

#[tauri::command]
fn open_vault(path: String, state: tauri::State<Mutex<AppState>>) -> Result<Vec<NoteDto>, String> {
    let vault = Vault::open(path.into()).map_err(|e| e.to_string())?;
    let notes = vault.scan().map_err(|e| e.to_string())?;

    let dtos: Vec<NoteDto> = notes
        .iter()
        .map(|n| {
            let (modified_at, created_at) = get_file_times(&n.path.0);
            NoteDto {
                id: n.id.0.clone(),
                path: n.path.0.to_string_lossy().to_string(),
                title: n.title.clone(),
                modified_at,
                created_at,
            }
        })
        .collect();

    let index = VaultIndex::build(notes);

    let mut state = lock!(state)?;
    state.vault = Some(vault);
    state.index = Some(index);
    Ok(dtos)
}

#[tauri::command]
fn list_notes(state: tauri::State<Mutex<AppState>>) -> Result<Vec<NoteDto>, String> {
    let state = lock!(state)?;
    let index = state.index.as_ref().ok_or("No hay vault abierto")?;

    Ok(index.notes.values().map(note_to_dto).collect())
}

#[tauri::command]
fn read_note(
    note_id: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let state = lock!(state)?;
    let vault = state.vault.as_ref().ok_or("No hay vault abierto")?;
    let note = vault.read_note(&note_id).map_err(|e| e.to_string())?;

    Ok(note_to_detail(&note))
}

#[tauri::command]
fn save_note(
    note_id: String,
    content: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let mut state = lock!(state)?;
    let vault = state.vault.as_ref().ok_or("No hay vault abierto")?;

    let path = vault.id_to_path(&note_id);
    state.write_tracker.track(path);

    vault
        .save_note(&note_id, &content)
        .map_err(|e| e.to_string())?;

    let note = vault.read_note(&note_id).map_err(|e| e.to_string())?;
    let dto = note_to_detail(&note);
    if let Some(index) = state.index.as_mut() {
        index.reindex_note(note);
    }

    Ok(dto)
}

#[tauri::command]
fn create_note(
    path: String,
    content: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let mut state = lock!(state)?;
    let vault = state.vault.as_ref().ok_or("No hay vault abierto")?;

    let abs_path = vault.root.join(&path);
    state.write_tracker.track(abs_path);

    let note = vault
        .create_note(&path, &content)
        .map_err(|e| e.to_string())?;

    let dto = note_to_detail(&note);

    if let Some(index) = state.index.as_mut() {
        index.reindex_note(note);
    }

    Ok(dto)
}

#[tauri::command]
fn delete_note(note_id: String, state: tauri::State<Mutex<AppState>>) -> Result<(), String> {
    let mut state = lock!(state)?;
    let vault = state.vault.as_ref().ok_or("No hay vault abierto")?;

    let path = vault.id_to_path(&note_id);
    state.write_tracker.track(path);

    vault.delete_note(&note_id).map_err(|e| e.to_string())?;

    if let Some(index) = state.index.as_mut() {
        index.remove_note(&NoteId(note_id));
    }

    Ok(())
}

#[tauri::command]
fn rename_note(
    note_id: String,
    new_path: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<NoteDetailDto, String> {
    let mut state = lock!(state)?;
    let vault = state.vault.as_ref().ok_or("No hay vault abierto")?;

    let old_path = vault.id_to_path(&note_id);
    let new_abs_path = vault.root.join(&new_path);
    state.write_tracker.track(old_path);
    state.write_tracker.track(new_abs_path);

    let note = vault
        .rename_note(&note_id, &new_path)
        .map_err(|e| e.to_string())?;

    let dto = note_to_detail(&note);

    if let Some(index) = state.index.as_mut() {
        index.remove_note(&NoteId(note_id));
        index.reindex_note(note);
    }

    Ok(dto)
}

#[tauri::command]
fn search_notes(
    query: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<SearchResultDto>, String> {
    let state = lock!(state)?;
    let index = state.index.as_ref().ok_or("No hay vault abierto")?;

    Ok(index
        .search(&query)
        .into_iter()
        .map(|r| SearchResultDto {
            id: r.note.id.0.clone(),
            path: r.note.path.0.to_string_lossy().to_string(),
            title: r.note.title.clone(),
            score: r.score,
        })
        .collect())
}

#[derive(serde::Serialize)]
struct TagDto {
    tag: String,
    note_ids: Vec<String>,
}

#[tauri::command]
fn get_tags(state: tauri::State<Mutex<AppState>>) -> Result<Vec<TagDto>, String> {
    let state = lock!(state)?;
    let index = state.index.as_ref().ok_or("No hay vault abierto")?;

    let mut tags: Vec<TagDto> = index
        .tags
        .iter()
        .map(|(tag, note_ids)| TagDto {
            tag: tag.clone(),
            note_ids: note_ids.iter().map(|id| id.0.clone()).collect(),
        })
        .collect();

    tags.sort_by(|a, b| a.tag.cmp(&b.tag));
    Ok(tags)
}

#[tauri::command]
fn get_backlinks(
    note_id: String,
    state: tauri::State<Mutex<AppState>>,
) -> Result<Vec<BacklinkDto>, String> {
    let state = lock!(state)?;
    let index = state.index.as_ref().ok_or("No hay vault abierto")?;

    let id = NoteId(note_id);
    Ok(index
        .get_backlinks(&id)
        .into_iter()
        .filter_map(|bl_id| {
            let note = index.notes.get(bl_id)?;
            Some(BacklinkDto {
                id: note.id.0.clone(),
                title: note.title.clone(),
            })
        })
        .collect())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Mutex::new(AppState {
            vault: None,
            index: None,
            write_tracker: WriteTracker::new(),
        }))
        .invoke_handler(tauri::generate_handler![
            open_vault,
            list_notes,
            read_note,
            save_note,
            create_note,
            delete_note,
            rename_note,
            search_notes,
            get_backlinks,
            get_tags,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
