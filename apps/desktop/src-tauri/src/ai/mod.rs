pub mod auth_terminal;
pub(crate) mod catalog;
pub mod claude;
pub mod codex;
pub mod commands;
pub mod emit;
pub(crate) mod env;
pub mod gemini;
pub mod kilo;
pub mod manager;
pub mod persistence;
pub mod runtime;
pub(crate) mod secret_store;
pub(crate) mod shared;

pub use manager::AiManager;
