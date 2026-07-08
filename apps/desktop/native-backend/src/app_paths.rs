use std::path::PathBuf;

const APP_DIR_NAME: &str = "NeverWrite";

pub(crate) fn app_data_dir() -> PathBuf {
    if let Ok(path) = std::env::var("NEVERWRITE_APP_DATA_DIR") {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    platform_app_data_dir()
}

#[cfg(target_os = "macos")]
fn platform_app_data_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| {
            home.join("Library")
                .join("Application Support")
                .join(APP_DIR_NAME)
        })
        .unwrap_or_else(fallback_app_data_dir)
}

#[cfg(target_os = "windows")]
fn platform_app_data_dir() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .map(|appdata| appdata.join(APP_DIR_NAME))
        .unwrap_or_else(fallback_app_data_dir)
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_app_data_dir() -> PathBuf {
    if let Some(xdg_data_home) = std::env::var_os("XDG_DATA_HOME") {
        return PathBuf::from(xdg_data_home).join(APP_DIR_NAME);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local").join("share").join(APP_DIR_NAME))
        .unwrap_or_else(fallback_app_data_dir)
}

fn fallback_app_data_dir() -> PathBuf {
    std::env::temp_dir().join(APP_DIR_NAME)
}
