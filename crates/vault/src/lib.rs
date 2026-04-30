pub mod error;
mod note;
pub mod parser;
pub mod pdf;
pub mod vault;
pub mod watcher;

pub use error::VaultError;
pub use pdf::DiscoveredPdfFile;
pub use vault::{normalize_existing_vault_path, DiscoveredNoteFile, ScopedPathIntent, Vault};
pub use watcher::{start_watcher, VaultEvent, WriteTracker};
