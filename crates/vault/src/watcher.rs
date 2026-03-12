use std::collections::{hash_map::DefaultHasher, HashMap};
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{
    event::{ModifyKind, RenameMode},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};

use crate::error::VaultError;
use crate::vault::path_is_ignored;

/// Rastrea archivos escritos por la app para distinguirlos de cambios externos.
#[derive(Debug, Clone)]
pub struct WriteTracker {
    written: Arc<Mutex<HashMap<PathBuf, TrackedWrite>>>,
}

#[derive(Debug, Clone)]
struct TrackedWrite {
    kind: TrackedWriteKind,
    tracked_at: Instant,
}

#[derive(Debug, Clone)]
enum TrackedWriteKind {
    Content { hash: u64 },
    Any,
}

impl WriteTracker {
    pub fn new() -> Self {
        WriteTracker {
            written: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Registra un archivo escrito por la app, junto con la firma del contenido esperado.
    pub fn track_content(&self, path: PathBuf, content: &str) {
        self.track_entry(
            path,
            TrackedWriteKind::Content {
                hash: hash_bytes(content.as_bytes()),
            },
        );
    }

    /// Registra un path que puede producir eventos propios sin contenido legible
    /// (delete/rename). Se ignoran por una ventana corta.
    pub fn track_any(&self, path: PathBuf) {
        self.track_entry(path, TrackedWriteKind::Any);
    }

    fn track_entry(&self, path: PathBuf, kind: TrackedWriteKind) {
        let mut written = self.written.lock().unwrap();
        prune_expired(&mut written);
        written.insert(
            path,
            TrackedWrite {
                kind,
                tracked_at: Instant::now(),
            },
        );
    }

    pub fn has_recent_match(&self, path: &PathBuf, current_hash: Option<u64>) -> bool {
        let mut written = self.written.lock().unwrap();
        prune_expired(&mut written);

        let Some(entry) = written.get(path) else {
            return false;
        };

        match (&entry.kind, current_hash) {
            (TrackedWriteKind::Any, _) => true,
            (TrackedWriteKind::Content { hash }, Some(current_hash)) => *hash == current_hash,
            (TrackedWriteKind::Content { .. }, None) => false,
        }
    }
}

const SELF_WRITE_WINDOW: Duration = Duration::from_secs(2);

fn prune_expired(written: &mut HashMap<PathBuf, TrackedWrite>) {
    written.retain(|_, entry| entry.tracked_at.elapsed() <= SELF_WRITE_WINDOW);
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::{hash_bytes, WriteTracker};
    use std::path::PathBuf;

    #[test]
    fn content_tracking_matches_only_same_content() {
        let tracker = WriteTracker::new();
        let path = PathBuf::from("note.md");

        tracker.track_content(path.clone(), "alpha");

        assert!(tracker.has_recent_match(&path, Some(hash_bytes(b"alpha"))));
        assert!(!tracker.has_recent_match(&path, Some(hash_bytes(b"beta"))));
    }

    #[test]
    fn any_tracking_matches_delete_and_rename_events() {
        let tracker = WriteTracker::new();
        let path = PathBuf::from("note.md");

        tracker.track_any(path.clone());

        assert!(tracker.has_recent_match(&path, None));
        assert!(tracker.has_recent_match(&path, Some(hash_bytes(b"anything"))));
    }
}

/// Evento externo detectado por el watcher.
#[derive(Debug, Clone)]
pub enum VaultEvent {
    FileCreated(PathBuf),
    FileModified(PathBuf),
    FileDeleted(PathBuf),
    FileRenamed { from: PathBuf, to: PathBuf },
}

/// Inicia el file watcher en el directorio del vault.
/// `on_event` se llama solo para cambios externos (no hechos por la app).
pub fn start_watcher(
    root: PathBuf,
    write_tracker: WriteTracker,
    on_event: impl Fn(VaultEvent) + Send + 'static,
) -> Result<RecommendedWatcher, VaultError> {
    let watch_root = root.clone();
    let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        let Ok(event) = res else { return };

        // Solo nos interesan archivos .md
        let paths: Vec<&PathBuf> = event
            .paths
            .iter()
            .filter(|path| !path_is_ignored(&watch_root, path))
            .filter(|path| path.extension().is_some_and(|ext| ext == "md"))
            .collect();

        if paths.is_empty() {
            return;
        }

        match event.kind {
            EventKind::Create(_) => {
                for path in paths {
                    let current_hash = std::fs::read(path).ok().map(|content| hash_bytes(&content));
                    if write_tracker.has_recent_match(path, current_hash) {
                        continue;
                    }
                    on_event(VaultEvent::FileCreated(path.clone()));
                }
            }
            // Rename events: on macOS (FSEvents) these fire as Modify(Name)
            // for both the old and new paths. We check if the file still exists
            // to distinguish source (delete) from destination (create).
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                if paths.len() >= 2 {
                    let from_ignored = write_tracker.has_recent_match(paths[0], None);
                    let to_ignored = write_tracker.has_recent_match(paths[1], None);
                    if from_ignored || to_ignored {
                        return;
                    }
                    on_event(VaultEvent::FileRenamed {
                        from: paths[0].clone(),
                        to: paths[1].clone(),
                    });
                }
            }
            EventKind::Modify(ModifyKind::Name(_)) => {
                for path in paths {
                    let should_ignore = if path.exists() {
                        let current_hash =
                            std::fs::read(path).ok().map(|content| hash_bytes(&content));
                        write_tracker.has_recent_match(path, current_hash)
                    } else {
                        write_tracker.has_recent_match(path, None)
                    };
                    if should_ignore {
                        continue;
                    }
                    if path.exists() {
                        on_event(VaultEvent::FileCreated(path.clone()));
                    } else {
                        on_event(VaultEvent::FileDeleted(path.clone()));
                    }
                }
            }
            EventKind::Modify(_) => {
                for path in paths {
                    let current_hash = std::fs::read(path).ok().map(|content| hash_bytes(&content));
                    if write_tracker.has_recent_match(path, current_hash) {
                        continue;
                    }
                    on_event(VaultEvent::FileModified(path.clone()));
                }
            }
            EventKind::Remove(_) => {
                for path in paths {
                    if write_tracker.has_recent_match(path, None) {
                        continue;
                    }
                    on_event(VaultEvent::FileDeleted(path.clone()));
                }
            }
            _ => {}
        }
    })?;

    watcher.watch(&root, RecursiveMode::Recursive)?;
    Ok(watcher)
}
