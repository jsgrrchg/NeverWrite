use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    stage_runtime(RuntimeStageSpec {
        label: "codex",
        env_bundle_key: "VAULTAI_CODEX_ACP_BUNDLE_BIN",
        env_runtime_key: "VAULTAI_CODEX_ACP_BIN",
        vendor_dir: "../../../vendor/codex-acp",
        binary_name: runtime_binary_name("codex-acp"),
    });
    stage_runtime(RuntimeStageSpec {
        label: "claude",
        env_bundle_key: "VAULTAI_CLAUDE_ACP_BUNDLE_BIN",
        env_runtime_key: "VAULTAI_CLAUDE_ACP_BIN",
        vendor_dir: "../../../vendor/Claude-agent-acp-upstream",
        binary_name: runtime_binary_name("claude-agent-acp"),
    });
    tauri_build::build()
}

struct RuntimeStageSpec<'a> {
    label: &'a str,
    env_bundle_key: &'a str,
    env_runtime_key: &'a str,
    vendor_dir: &'a str,
    binary_name: &'a str,
}

fn stage_runtime(spec: RuntimeStageSpec<'_>) {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR missing"));
    let binaries_dir = manifest_dir.join("binaries");
    let destination = binaries_dir.join(spec.binary_name);

    println!("cargo:rerun-if-env-changed={}", spec.env_bundle_key);
    println!("cargo:rerun-if-env-changed={}", spec.env_runtime_key);

    let candidates = candidate_paths(&manifest_dir, &spec);
    for candidate in &candidates {
        println!("cargo:rerun-if-changed={}", candidate.display());
    }

    let selected = candidates.into_iter().find(|path| path.exists());

    if let Some(source) = selected {
        if let Err(error) = fs::create_dir_all(&binaries_dir) {
            panic!(
                "failed to create binaries directory {}: {error}",
                binaries_dir.display()
            );
        }

        if files_match(&source, &destination) {
            return;
        }

        if let Err(error) = fs::copy(&source, &destination) {
            panic!(
                "failed to stage {} runtime from {} to {}: {error}",
                spec.label,
                source.display(),
                destination.display()
            );
        }

        ensure_executable_if_needed(&destination);

        println!(
            "cargo:warning=Staged {} runtime from {}",
            spec.label,
            source.display()
        );
        return;
    }

    if destination.exists() {
        return;
    }

    println!(
        "cargo:warning=No prebuilt {} runtime found. Expected one of: {}",
        spec.label,
        format_candidates(&candidate_paths(&manifest_dir, &spec))
    );
}

fn candidate_paths(manifest_dir: &Path, spec: &RuntimeStageSpec<'_>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(path) = env::var(spec.env_bundle_key) {
        candidates.push(PathBuf::from(path));
    }

    if let Ok(path) = env::var(spec.env_runtime_key) {
        candidates.push(PathBuf::from(path));
    }

    let vendor_dir = manifest_dir.join(spec.vendor_dir);
    candidates.push(vendor_dir.join("target/release").join(spec.binary_name));
    candidates.push(vendor_dir.join("target/debug").join(spec.binary_name));
    if let Some(path) = find_program(spec.binary_name) {
        candidates.push(path);
    }

    candidates
}

fn runtime_binary_name(base: &'static str) -> &'static str {
    if cfg!(target_os = "windows") {
        if base == "codex-acp" {
            "codex-acp.exe"
        } else {
            "claude-agent-acp.exe"
        }
    } else if base == "codex-acp" {
        "codex-acp"
    } else {
        "claude-agent-acp"
    }
}

fn files_match(source: &Path, destination: &Path) -> bool {
    let Ok(source_meta) = fs::metadata(source) else {
        return false;
    };
    let Ok(destination_meta) = fs::metadata(destination) else {
        return false;
    };

    source_meta.len() == destination_meta.len()
}

fn format_candidates(candidates: &[PathBuf]) -> String {
    candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ")
}

fn find_program(program: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(program);
    if candidate.is_absolute() {
        return candidate.exists().then_some(candidate);
    }

    let paths = env::var_os("PATH")?;
    env::split_paths(&paths)
        .map(|path| path.join(program))
        .find(|path| path.exists() && path.is_file())
}

#[cfg(unix)]
fn ensure_executable_if_needed(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if let Ok(metadata) = fs::metadata(path) {
        let mut permissions = metadata.permissions();
        let mode = permissions.mode();
        permissions.set_mode(mode | 0o755);
        let _ = fs::set_permissions(path, permissions);
    }
}

#[cfg(not(unix))]
fn ensure_executable_if_needed(_path: &Path) {}
