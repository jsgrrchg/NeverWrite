pub mod error;
mod note;
pub mod parser;
pub mod vault;
pub mod watcher;

pub use error::VaultError;
pub use vault::Vault;
pub use watcher::{start_watcher, VaultEvent, WriteTracker};
