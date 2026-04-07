// Shared utilities for AI runtime clients (Claude, Codex, Gemini).

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tokio::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Prevents the child process from spawning a visible console window on Windows.
/// No-op on other platforms.
pub fn configure_background_process(command: &mut Command) {
    #[cfg(windows)]
    {
        command.as_std_mut().creation_flags(CREATE_NO_WINDOW);
    }
    // Suppress unused-parameter warning on non-Windows builds.
    let _ = command;
}
