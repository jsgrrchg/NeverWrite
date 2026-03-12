use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::write_json_atomic;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct WhisperModelDto {
    pub id: String,
    pub label: String,
    pub size_bytes: u64,
    pub recommended: bool,
    pub downloaded: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WhisperStatusDto {
    pub selected_model: String,
    pub enabled: bool,
    pub downloaded_models: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct WhisperTranscriptionDto {
    pub text: String,
    pub language: Option<String>,
    pub duration_ms: u64,
}

// ---------------------------------------------------------------------------
// Persisted config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WhisperConfig {
    selected_model: String,
    enabled: bool,
}

impl Default for WhisperConfig {
    fn default() -> Self {
        Self {
            selected_model: "base".to_string(),
            enabled: true,
        }
    }
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("ai").join("whisper.json"))
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(base.join("whisper").join("models"))
}

fn load_config(app: &AppHandle) -> WhisperConfig {
    let path = match config_path(app) {
        Ok(p) => p,
        Err(_) => return WhisperConfig::default(),
    };
    std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn save_config(app: &AppHandle, config: &WhisperConfig) -> Result<(), String> {
    let path = config_path(app)?;
    write_json_atomic(&path, config)
}

fn downloaded_model_ids(app: &AppHandle) -> Vec<String> {
    let dir = match models_dir(app) {
        Ok(d) => d,
        Err(_) => return Vec::new(),
    };
    vault_ai_whisper::manifest::MODELS
        .iter()
        .filter(|m| {
            dir.join(vault_ai_whisper::manifest::model_filename(m))
                .exists()
        })
        .map(|m| m.id.to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Shared cancel token for downloads
// ---------------------------------------------------------------------------

pub struct WhisperDownloadCancel(pub std::sync::Mutex<Option<Arc<AtomicBool>>>);

impl WhisperDownloadCancel {
    pub fn new() -> Self {
        Self(std::sync::Mutex::new(None))
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[derive(Clone, Serialize)]
struct DownloadProgressPayload {
    model_id: String,
    progress: f64,
}

#[derive(Clone, Serialize)]
struct DownloadCompletePayload {
    model_id: String,
}

#[derive(Clone, Serialize)]
struct DownloadErrorPayload {
    model_id: String,
    error: String,
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn whisper_list_models(app: AppHandle) -> Vec<WhisperModelDto> {
    let downloaded = downloaded_model_ids(&app);
    vault_ai_whisper::manifest::MODELS
        .iter()
        .map(|m| WhisperModelDto {
            id: m.id.to_string(),
            label: m.label.to_string(),
            size_bytes: m.size_bytes,
            recommended: m.recommended,
            downloaded: downloaded.contains(&m.id.to_string()),
        })
        .collect()
}

#[tauri::command]
pub fn whisper_get_status(app: AppHandle) -> WhisperStatusDto {
    let config = load_config(&app);
    WhisperStatusDto {
        selected_model: config.selected_model,
        enabled: config.enabled,
        downloaded_models: downloaded_model_ids(&app),
    }
}

#[tauri::command]
pub async fn whisper_download_model(
    model_id: String,
    app: AppHandle,
    cancel_state: State<'_, WhisperDownloadCancel>,
) -> Result<(), String> {
    let model = vault_ai_whisper::manifest::find_model(&model_id)
        .ok_or_else(|| format!("Unknown model: {model_id}"))?;

    let dest = models_dir(&app)?;

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut guard = cancel_state.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(cancel.clone());
    }

    let app_clone = app.clone();
    let model_id_clone = model_id.clone();
    let cancel_clone = cancel.clone();

    let result = tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Handle::current();
        rt.block_on(async {
            vault_ai_whisper::download::download_model(model, &dest, cancel_clone, |progress| {
                let _ = app_clone.emit(
                    "whisper://download-progress",
                    DownloadProgressPayload {
                        model_id: model_id_clone.clone(),
                        progress,
                    },
                );
            })
            .await
        })
    })
    .await
    .map_err(|e| e.to_string())?;

    // Clear cancel token
    {
        let mut guard = cancel_state.0.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    match result {
        Ok(_) => {
            let _ = app.emit(
                "whisper://download-complete",
                DownloadCompletePayload {
                    model_id: model_id.clone(),
                },
            );
            Ok(())
        }
        Err(e) => {
            let error_msg = e.to_string();
            let _ = app.emit(
                "whisper://download-error",
                DownloadErrorPayload {
                    model_id,
                    error: error_msg.clone(),
                },
            );
            Err(error_msg)
        }
    }
}

#[tauri::command]
pub fn whisper_delete_model(model_id: String, app: AppHandle) -> Result<(), String> {
    let model = vault_ai_whisper::manifest::find_model(&model_id)
        .ok_or_else(|| format!("Unknown model: {model_id}"))?;

    let dir = models_dir(&app)?;
    let path = dir.join(vault_ai_whisper::manifest::model_filename(model));

    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn whisper_set_selected_model(model_id: String, app: AppHandle) -> Result<(), String> {
    vault_ai_whisper::manifest::find_model(&model_id)
        .ok_or_else(|| format!("Unknown model: {model_id}"))?;

    let mut config = load_config(&app);
    config.selected_model = model_id;
    save_config(&app, &config)
}

/// Maximum audio file size in bytes (25 MB).
const MAX_AUDIO_FILE_SIZE: u64 = 25 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct WhisperAudioInfoDto {
    pub size_bytes: u64,
    pub too_large: bool,
    pub max_size_bytes: u64,
}

#[tauri::command]
pub fn whisper_check_audio_file(audio_path: String) -> Result<WhisperAudioInfoDto, String> {
    let path = PathBuf::from(&audio_path);
    let metadata = std::fs::metadata(&path)
        .map_err(|e| format!("Cannot read file '{}': {}", audio_path, e))?;
    let size_bytes = metadata.len();
    Ok(WhisperAudioInfoDto {
        size_bytes,
        too_large: size_bytes > MAX_AUDIO_FILE_SIZE,
        max_size_bytes: MAX_AUDIO_FILE_SIZE,
    })
}

#[tauri::command]
pub async fn whisper_transcribe(
    audio_path: String,
    app: AppHandle,
) -> Result<WhisperTranscriptionDto, String> {
    let config = load_config(&app);
    if !config.enabled {
        return Err("Whisper transcription is disabled".to_string());
    }

    let model = vault_ai_whisper::manifest::find_model(&config.selected_model)
        .ok_or_else(|| format!("Unknown model: {}", config.selected_model))?;

    let dir = models_dir(&app)?;
    let model_path = dir.join(vault_ai_whisper::manifest::model_filename(model));

    if !model_path.exists() {
        return Err(format!(
            "Model '{}' is not downloaded. Please download it first.",
            config.selected_model
        ));
    }

    // Check file size
    let audio = PathBuf::from(&audio_path);
    let metadata =
        std::fs::metadata(&audio).map_err(|e| format!("Cannot read audio file: {}", e))?;
    if metadata.len() > MAX_AUDIO_FILE_SIZE {
        return Err(format!(
            "Audio file is too large ({:.1} MB). Maximum allowed size is {:.0} MB.",
            metadata.len() as f64 / (1024.0 * 1024.0),
            MAX_AUDIO_FILE_SIZE as f64 / (1024.0 * 1024.0)
        ));
    }

    let result =
        tokio::task::spawn_blocking(move || vault_ai_whisper::transcribe(&audio, &model_path))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| {
                let msg = e.to_string();
                if msg.contains("Whisper") || msg.contains("model") {
                    format!("Transcription failed — the model file may be corrupted. Try deleting and re-downloading it. ({})", msg)
                } else {
                    format!("Transcription failed: {}", msg)
                }
            })?;

    Ok(WhisperTranscriptionDto {
        text: result.text,
        language: result.language,
        duration_ms: result.duration_ms,
    })
}

#[tauri::command]
pub fn whisper_set_enabled(enabled: bool, app: AppHandle) -> Result<(), String> {
    let mut config = load_config(&app);
    config.enabled = enabled;
    save_config(&app, &config)
}

#[tauri::command]
pub fn whisper_cancel_download(
    cancel_state: State<'_, WhisperDownloadCancel>,
) -> Result<(), String> {
    let guard = cancel_state.0.lock().map_err(|e| e.to_string())?;
    if let Some(cancel) = guard.as_ref() {
        cancel.store(true, Ordering::Relaxed);
    }
    Ok(())
}
