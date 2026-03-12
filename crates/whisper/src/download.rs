use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

use crate::manifest::{model_filename, WhisperModel};
use crate::WhisperError;

/// Downloads a whisper model to `dest_dir`, calling `on_progress(0.0..=1.0)` as data arrives.
/// If `cancel` is set to `true`, the download is aborted and the `.part` file is cleaned up.
/// Returns the final path to the downloaded file.
pub async fn download_model(
    model: &WhisperModel,
    dest_dir: &Path,
    cancel: Arc<AtomicBool>,
    on_progress: impl Fn(f64),
) -> Result<PathBuf, WhisperError> {
    tokio::fs::create_dir_all(dest_dir).await?;

    let filename = model_filename(model);
    let dest_path = dest_dir.join(&filename);
    let tmp_path = dest_dir.join(format!("{filename}.part"));

    let response = reqwest::get(model.url).await?;
    let total = response.content_length().unwrap_or(model.size_bytes);

    let mut file = tokio::fs::File::create(&tmp_path).await?;
    let mut stream = response.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp_path).await;
            return Err(WhisperError::Cancelled);
        }
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        downloaded += chunk.len() as u64;
        on_progress((downloaded as f64 / total as f64).min(1.0));
    }

    file.flush().await?;
    drop(file);

    if cancel.load(Ordering::Relaxed) {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(WhisperError::Cancelled);
    }

    if !verify_checksum(&tmp_path, model.checksum_sha256).await? {
        let _ = tokio::fs::remove_file(&tmp_path).await;
        return Err(WhisperError::ChecksumMismatch {
            model_id: model.id.to_string(),
        });
    }

    tokio::fs::rename(&tmp_path, &dest_path).await?;
    Ok(dest_path)
}

/// Verifies SHA-256 checksum of a file.
pub async fn verify_checksum(path: &Path, expected: &str) -> Result<bool, WhisperError> {
    let data = tokio::fs::read(path).await?;
    let hash = Sha256::digest(&data);
    let hex = format!("{hash:x}");
    Ok(hex == expected)
}

/// Returns paths of models already downloaded in `models_dir`.
pub async fn get_downloaded_models(models_dir: &Path) -> Vec<(String, PathBuf)> {
    let mut result = Vec::new();
    for model in crate::manifest::MODELS {
        let path = models_dir.join(model_filename(model));
        if path.exists() {
            result.push((model.id.to_string(), path));
        }
    }
    result
}
