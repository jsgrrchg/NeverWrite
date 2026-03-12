pub mod download;
pub mod manifest;

mod audio;

use std::path::Path;

use serde::Serialize;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

#[derive(Debug, thiserror::Error)]
pub enum WhisperError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Download failed: {0}")]
    Download(#[from] reqwest::Error),

    #[error("Checksum mismatch for model '{model_id}'")]
    ChecksumMismatch { model_id: String },

    #[error("Whisper error: {0}")]
    Whisper(String),

    #[error("Audio decode error: {0}")]
    AudioDecode(String),

    #[error("Model not found: {model_id}")]
    ModelNotFound { model_id: String },

    #[error("Download cancelled")]
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
pub struct TranscriptionResult {
    pub text: String,
    pub language: Option<String>,
    pub duration_ms: u64,
}

/// Transcribes an audio file using the whisper model at `model_path`.
///
/// Accepts WAV, MP3, OGG, and FLAC files. Audio is automatically decoded,
/// converted to mono, and resampled to 16 kHz before transcription.
pub fn transcribe(
    audio_path: &Path,
    model_path: &Path,
) -> Result<TranscriptionResult, WhisperError> {
    let samples = audio::decode_to_mono_16k(audio_path)?;
    let duration_ms = (samples.len() as f64 / 16_000.0 * 1000.0) as u64;

    let model_str = model_path
        .to_str()
        .ok_or_else(|| WhisperError::Whisper("Model path contains invalid UTF-8".to_string()))?;

    let ctx = WhisperContext::new_with_params(model_str, WhisperContextParameters::default())
        .map_err(|e| WhisperError::Whisper(e.to_string()))?;

    let mut state = ctx
        .create_state()
        .map_err(|e| WhisperError::Whisper(e.to_string()))?;

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    let cpus = std::thread::available_parallelism()
        .map(|n| n.get() as i32)
        .unwrap_or(4)
        .min(8);
    params.set_n_threads(cpus);
    params.set_language(None); // auto-detect
    params.set_print_realtime(false);
    params.set_print_progress(false);
    params.set_translate(false);

    state
        .full(params, &samples)
        .map_err(|e| WhisperError::Whisper(e.to_string()))?;

    let n_segments = state.full_n_segments();

    let mut text = String::new();
    for i in 0..n_segments {
        if let Some(segment) = state.get_segment(i) {
            if let Ok(s) = segment.to_str() {
                text.push_str(s);
            }
        }
    }

    let lang_id = state.full_lang_id_from_state();
    let language = whisper_rs::get_lang_str(lang_id).map(|s| s.to_string());

    Ok(TranscriptionResult {
        text: text.trim().to_string(),
        language,
        duration_ms,
    })
}
