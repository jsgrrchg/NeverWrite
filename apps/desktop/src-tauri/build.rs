use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    stage_runtime(RuntimeStageSpec {
        label: "codex",
        env_bundle_key: "VAULTAI_CODEX_ACP_BUNDLE_BIN",
        env_runtime_key: "VAULTAI_CODEX_ACP_BIN",
        vendor_dir: "../../../vendor/codex-acp",
        binary_name: runtime_binary_name("codex-acp"),
        bun_compile_entry: None,
    });
    stage_runtime(RuntimeStageSpec {
        label: "claude",
        env_bundle_key: "VAULTAI_CLAUDE_ACP_BUNDLE_BIN",
        env_runtime_key: "VAULTAI_CLAUDE_ACP_BIN",
        vendor_dir: "../../../vendor/Claude-agent-acp-upstream",
        binary_name: runtime_binary_name("claude-agent-acp"),
        bun_compile_entry: Some("dist/index.js"),
    });
    tauri_build::build()
}

struct RuntimeStageSpec<'a> {
    label: &'a str,
    env_bundle_key: &'a str,
    env_runtime_key: &'a str,
    vendor_dir: &'a str,
    binary_name: &'a str,
    /// When set, the binary is compiled from this JS entry via `bun build --compile`
    /// if no pre-built candidate is found.
    bun_compile_entry: Option<&'a str>,
}

fn stage_runtime(spec: RuntimeStageSpec<'_>) {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR missing"));
    let binaries_dir = manifest_dir.join("binaries");
    let destination = binaries_dir.join(spec.binary_name);
    let vendor_dir = manifest_dir.join(spec.vendor_dir);

    println!("cargo:rerun-if-env-changed={}", spec.env_bundle_key);
    println!("cargo:rerun-if-env-changed={}", spec.env_runtime_key);

    let candidates = candidate_paths(&manifest_dir, &spec);
    for candidate in &candidates {
        println!("cargo:rerun-if-changed={}", candidate.display());
    }

    // Watch the JS entry point so cargo rebuilds when it changes.
    if let Some(entry) = spec.bun_compile_entry {
        let entry_path = vendor_dir.join(entry);
        println!("cargo:rerun-if-changed={}", entry_path.display());
    }

    let selected = candidates.into_iter().find(|path| path.exists());

    if let Some(source) = selected {
        stage_from_source(&spec, &binaries_dir, &source, &destination);
        return;
    }

    // No pre-built candidate found — try compiling with bun if configured.
    if let Some(entry) = spec.bun_compile_entry {
        let entry_path = vendor_dir.join(entry);
        if entry_path.exists() {
            if let Some(compiled) =
                bun_compile(&spec.label, &entry_path, &binaries_dir, spec.binary_name)
            {
                if compiled != destination {
                    stage_from_source(&spec, &binaries_dir, &compiled, &destination);
                } else {
                    ensure_executable_if_needed(&destination);
                    println!(
                        "cargo:warning=Compiled {} runtime with bun from {}",
                        spec.label,
                        entry_path.display()
                    );
                }
                return;
            }
        }
    }

    if destination.exists() {
        return;
    }

    println!(
        "cargo:warning=No prebuilt {} runtime found. Expected one of: {}",
        spec.label,
        format_candidates(&candidate_paths(
            &manifest_dir,
            &RuntimeStageSpec {
                label: spec.label,
                env_bundle_key: spec.env_bundle_key,
                env_runtime_key: spec.env_runtime_key,
                vendor_dir: spec.vendor_dir,
                binary_name: spec.binary_name,
                bun_compile_entry: spec.bun_compile_entry,
            }
        ))
    );
}

fn stage_from_source(
    spec: &RuntimeStageSpec<'_>,
    binaries_dir: &Path,
    source: &Path,
    destination: &Path,
) {
    if let Err(error) = fs::create_dir_all(binaries_dir) {
        panic!(
            "failed to create binaries directory {}: {error}",
            binaries_dir.display()
        );
    }

    if files_match(source, destination) {
        return;
    }

    if source == destination {
        return;
    }

    if let Err(error) = fs::copy(source, destination) {
        panic!(
            "failed to stage {} runtime from {} to {}: {error}",
            spec.label,
            source.display(),
            destination.display()
        );
    }

    ensure_executable_if_needed(destination);

    println!(
        "cargo:warning=Staged {} runtime from {}",
        spec.label,
        source.display()
    );
}

/// Compile a JS entry point into a standalone binary using `bun build --compile`.
fn bun_compile(label: &str, entry: &Path, out_dir: &Path, binary_name: &str) -> Option<PathBuf> {
    let bun = find_program("bun")?;

    if let Err(error) = fs::create_dir_all(out_dir) {
        println!("cargo:warning=Failed to create output dir for {label} bun compile: {error}");
        return None;
    }

    let outfile = out_dir.join(binary_name);

    let status = Command::new(&bun)
        .arg("build")
        .arg(entry)
        .arg("--compile")
        .arg("--outfile")
        .arg(&outfile)
        .current_dir(entry.parent().unwrap_or(Path::new(".")))
        .status();

    match status {
        Ok(s) if s.success() => {
            ensure_executable_if_needed(&outfile);
            println!(
                "cargo:warning=Compiled {label} runtime with bun from {}",
                entry.display()
            );
            Some(outfile)
        }
        Ok(s) => {
            println!("cargo:warning=bun compile for {label} exited with {s}, falling back");
            None
        }
        Err(error) => {
            println!("cargo:warning=Failed to run bun compile for {label}: {error}");
            None
        }
    }
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
