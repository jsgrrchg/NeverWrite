use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use notify::{
    event::{ModifyKind, RenameMode},
    Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};

use crate::error::VaultError;
use crate::vault::path_is_ignored;

/// Rastrea archivos escritos por la app para distinguirlos de cambios externos.
#[derive(Debug, Clone)]
pub struct WriteTracker {
    written: Arc<Mutex<HashSet<PathBuf>>>,
}

impl WriteTracker {
    pub fn new() -> Self {
        WriteTracker {
            written: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    /// Registra un path como escrito por la app.
    pub fn track(&self, path: PathBuf) {
        self.written.lock().unwrap().insert(path);
    }

    /// Verifica si un cambio es propio (y lo remueve del set). Retorna true si era propio.
    pub fn consume(&self, path: &PathBuf) -> bool {
        self.written.lock().unwrap().remove(path)
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
                    if !write_tracker.consume(path) {
                        on_event(VaultEvent::FileCreated(path.clone()));
                    }
                }
            }
            // Rename events: on macOS (FSEvents) these fire as Modify(Name)
            // for both the old and new paths. We check if the file still exists
            // to distinguish source (delete) from destination (create).
            EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
                if paths.len() >= 2 {
                    let from_consumed = write_tracker.consume(paths[0]);
                    let to_consumed = write_tracker.consume(paths[1]);
                    if !from_consumed && !to_consumed {
                        on_event(VaultEvent::FileRenamed {
                            from: paths[0].clone(),
                            to: paths[1].clone(),
                        });
                    }
                }
            }
            EventKind::Modify(ModifyKind::Name(_)) => {
                for path in paths {
                    if write_tracker.consume(path) {
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
                    if !write_tracker.consume(path) {
                        on_event(VaultEvent::FileModified(path.clone()));
                    }
                }
            }
            EventKind::Remove(_) => {
                for path in paths {
                    if !write_tracker.consume(path) {
                        on_event(VaultEvent::FileDeleted(path.clone()));
                    }
                }
            }
            _ => {}
        }
    })?;

    watcher.watch(&root, RecursiveMode::Recursive)?;
    Ok(watcher)
}
