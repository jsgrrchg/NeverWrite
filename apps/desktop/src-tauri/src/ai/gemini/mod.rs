mod adapter;
mod client;
mod process;
mod setup;

pub use adapter::GeminiRuntimeAdapter;
pub use client::{GeminiRuntimeHandle, GeminiSessionState};
pub use process::GeminiRuntime;
pub use setup::{
    clear_authenticated_method, mark_authenticated_method, save_setup_config, GeminiSetupInput,
};
