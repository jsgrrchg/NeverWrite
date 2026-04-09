use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

use neverwrite_types::{NoteId, NotePath, PdfDocument};
use serde::{Deserialize, Serialize};

use crate::error::VaultError;

const PDF_EXTRACTION_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredPdfFile {
    pub id: String,
    pub path: PathBuf,
    pub modified_at: u64,
    pub created_at: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PdfCacheEntry {
    relative_path: String,
    modified_at: u64,
    size: u64,
    page_count: usize,
    pages: Vec<String>,
}

fn cache_key(relative_path: &str, modified_at: u64, size: u64) -> String {
    let mut hasher = DefaultHasher::new();
    relative_path.hash(&mut hasher);
    modified_at.hash(&mut hasher);
    size.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn cache_dir(vault_root: &Path) -> PathBuf {
    vault_root.join(".neverwrite-cache").join("pdf")
}

fn load_from_cache(
    vault_root: &Path,
    relative_path: &str,
    modified_at: u64,
    size: u64,
) -> Option<PdfCacheEntry> {
    let key = cache_key(relative_path, modified_at, size);
    let path = cache_dir(vault_root).join(format!("{key}.json"));
    let bytes = std::fs::read(path).ok()?;
    let entry: PdfCacheEntry = serde_json::from_slice(&bytes).ok()?;
    // Validate fingerprint matches
    if entry.relative_path == relative_path
        && entry.modified_at == modified_at
        && entry.size == size
    {
        Some(entry)
    } else {
        None
    }
}

fn save_to_cache(vault_root: &Path, entry: &PdfCacheEntry) {
    let key = cache_key(&entry.relative_path, entry.modified_at, entry.size);
    let dir = cache_dir(vault_root);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let path = dir.join(format!("{key}.json"));
    let bytes = match serde_json::to_vec(entry) {
        Ok(b) => b,
        Err(_) => return,
    };
    let _ = std::fs::write(path, bytes);
}

fn system_time_to_secs(t: std::time::SystemTime) -> u64 {
    t.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn run_with_timeout<T, F>(timeout: Duration, task_name: &str, task: F) -> Result<T, VaultError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    let (sender, receiver) = mpsc::channel();

    std::thread::spawn(move || {
        let _ = sender.send(task());
    });

    match receiver.recv_timeout(timeout) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(VaultError::PdfExtraction(error)),
        Err(mpsc::RecvTimeoutError::Timeout) => Err(VaultError::PdfExtraction(format!(
            "{task_name} timed out after {}s",
            timeout.as_secs()
        ))),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(VaultError::PdfExtraction(format!(
            "{task_name} worker disconnected unexpectedly"
        ))),
    }
}

/// Extract text from a PDF. Uses cache if valid, otherwise extracts and caches.
pub fn extract_pdf_text(
    vault_root: &Path,
    pdf_path: &Path,
    relative_id: &str,
) -> Result<PdfDocument, VaultError> {
    let metadata =
        std::fs::metadata(pdf_path).map_err(|e| VaultError::PdfExtraction(e.to_string()))?;
    let modified_at = metadata.modified().map(system_time_to_secs).unwrap_or(0);
    let size = metadata.len();

    let title = pdf_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled")
        .to_string();

    // Try cache first
    if let Some(cached) = load_from_cache(vault_root, relative_id, modified_at, size) {
        return Ok(PdfDocument {
            id: NoteId(relative_id.to_string()),
            path: NotePath(pdf_path.to_path_buf()),
            title,
            page_count: cached.page_count,
            extracted_pages: cached.pages,
        });
    }

    // Extract from PDF
    let bytes = std::fs::read(pdf_path).map_err(|e| VaultError::PdfExtraction(e.to_string()))?;
    let pages = run_with_timeout(PDF_EXTRACTION_TIMEOUT, "PDF extraction", move || {
        pdf_extract::extract_text_from_mem_by_pages(&bytes).map_err(|e| e.to_string())
    })?;
    let page_count = pages.len();

    // Cache the result
    save_to_cache(
        vault_root,
        &PdfCacheEntry {
            relative_path: relative_id.to_string(),
            modified_at,
            size,
            page_count,
            pages: pages.clone(),
        },
    );

    Ok(PdfDocument {
        id: NoteId(relative_id.to_string()),
        path: NotePath(pdf_path.to_path_buf()),
        title,
        page_count,
        extracted_pages: pages,
    })
}

/// Result of a batch PDF extraction.
pub struct PdfBatchResult {
    pub documents: Vec<PdfDocument>,
    pub failures: Vec<PdfExtractionFailure>,
}

/// A single PDF that failed to extract.
pub struct PdfExtractionFailure {
    pub id: String,
    pub error: String,
}

/// Batch extract PDFs with progress callback.
pub fn extract_pdf_batch(
    vault_root: &Path,
    pdf_files: &[DiscoveredPdfFile],
    mut on_progress: impl FnMut(usize),
) -> PdfBatchResult {
    let mut documents = Vec::new();
    let mut failures = Vec::new();
    for (i, file) in pdf_files.iter().enumerate() {
        match extract_pdf_text(vault_root, &file.path, &file.id) {
            Ok(doc) => documents.push(doc),
            Err(e) => {
                eprintln!("[pdf] Failed to extract {}: {e}", file.id);
                failures.push(PdfExtractionFailure {
                    id: file.id.clone(),
                    error: e.to_string(),
                });
            }
        }
        on_progress(i + 1);
    }
    PdfBatchResult {
        documents,
        failures,
    }
}

#[cfg(test)]
mod tests {
    use super::run_with_timeout;
    use std::time::Duration;

    #[test]
    fn run_with_timeout_returns_task_result() {
        let result = run_with_timeout(Duration::from_millis(50), "PDF extraction", || Ok(42));

        assert_eq!(result.unwrap(), 42);
    }

    #[test]
    fn run_with_timeout_returns_timeout_error() {
        let result = run_with_timeout(Duration::from_millis(10), "PDF extraction", || {
            std::thread::sleep(Duration::from_millis(50));
            Ok::<_, String>(())
        });

        let error = result.unwrap_err().to_string();
        assert!(error.contains("timed out"));
    }
}
