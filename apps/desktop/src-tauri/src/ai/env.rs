use std::{
    collections::HashSet,
    env,
    ffi::OsString,
    path::{Path, PathBuf},
};

pub fn preferred_path_entries() -> Vec<PathBuf> {
    let mut entries = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default();

    append_platform_tool_dirs(&mut entries);
    dedupe_paths(entries)
}

pub fn preferred_path_value() -> Option<OsString> {
    let entries = preferred_path_entries();
    if entries.is_empty() {
        return None;
    }

    env::join_paths(entries).ok()
}

pub fn inherited_path_value() -> Option<OsString> {
    env::var_os("PATH")
}

fn append_platform_tool_dirs(entries: &mut Vec<PathBuf>) {
    if let Some(home) = home_dir() {
        entries.push(home.join(".cargo/bin"));
        entries.push(home.join(".local/bin"));
    }

    #[cfg(target_os = "macos")]
    {
        entries.extend(
            [
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/usr/local/sbin",
                "/opt/local/bin",
                "/opt/local/sbin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ]
            .into_iter()
            .map(PathBuf::from),
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        entries.extend(
            [
                "/usr/local/bin",
                "/usr/local/sbin",
                "/usr/bin",
                "/bin",
                "/usr/sbin",
                "/sbin",
            ]
            .into_iter()
            .map(PathBuf::from),
        );
    }
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut seen = HashSet::<OsString>::new();
    let mut deduped = Vec::new();

    for path in paths {
        let key = path.as_os_str().to_os_string();
        if seen.insert(key) {
            deduped.push(path);
        }
    }

    deduped
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env::var_os("USERPROFILE").map(PathBuf::from)
    }

    #[cfg(not(target_os = "windows"))]
    {
        env::var_os("HOME").map(PathBuf::from)
    }
}

pub fn find_program_on_preferred_path(program: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(program);
    if candidate.is_absolute() {
        return candidate.exists().then_some(candidate);
    }

    for directory in preferred_path_entries() {
        for candidate in executable_candidates(&directory, program) {
            if candidate.exists() && candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn executable_candidates(directory: &Path, program: &str) -> Vec<PathBuf> {
    let base = directory.join(program);

    #[cfg(target_os = "windows")]
    {
        let mut candidates = vec![base.clone()];
        let has_extension = Path::new(program).extension().is_some();

        if !has_extension {
            for extension in windows_path_extensions() {
                let normalized = extension.trim();
                if normalized.is_empty() {
                    continue;
                }
                let ext = normalized.strip_prefix('.').unwrap_or(normalized);
                candidates.push(directory.join(format!("{program}.{ext}")));
            }

            if !candidates.iter().any(|candidate| {
                candidate
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("exe"))
            }) {
                candidates.push(directory.join(format!("{program}.exe")));
            }
        }

        return candidates;
    }

    #[cfg(not(target_os = "windows"))]
    {
        vec![base]
    }
}

#[cfg(target_os = "windows")]
fn windows_path_extensions() -> Vec<String> {
    env::var_os("PATHEXT")
        .and_then(|value| value.into_string().ok())
        .map(|raw| {
            raw.split(';')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    #[cfg(target_os = "macos")]
    #[test]
    fn preferred_path_entries_append_homebrew_bin_when_missing() {
        let _guard = ENV_LOCK.lock().unwrap();
        let original_path = env::var_os("PATH");

        env::set_var("PATH", "/usr/bin:/bin");

        let entries = preferred_path_entries();

        match original_path {
            Some(value) => env::set_var("PATH", value),
            None => env::remove_var("PATH"),
        }

        assert!(entries
            .iter()
            .any(|path| path == Path::new("/opt/homebrew/bin")));
    }
}
