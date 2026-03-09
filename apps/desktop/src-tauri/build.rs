use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    stage_codex_runtime();
    tauri_build::build()
}

fn stage_codex_runtime() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR missing"));
    let binaries_dir = manifest_dir.join("binaries");
    let binary_name = if cfg!(target_os = "windows") {
        "codex-acp.exe"
    } else {
        "codex-acp"
    };
    let destination = binaries_dir.join(binary_name);

    let candidates = candidate_paths(&manifest_dir, binary_name);
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
                "failed to stage codex runtime from {} to {}: {error}",
                source.display(),
                destination.display()
            );
        }

        println!(
            "cargo:warning=Staged codex runtime from {}",
            source.display()
        );
        return;
    }

    println!(
        "cargo:warning=No prebuilt codex runtime found. Expected one of: {}",
        format_candidates(&candidate_paths(&manifest_dir, binary_name))
    );
}

fn candidate_paths(manifest_dir: &Path, binary_name: &str) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    if let Ok(path) = env::var("VAULTAI_CODEX_ACP_BUNDLE_BIN") {
        candidates.push(PathBuf::from(path));
    }

    if let Ok(path) = env::var("VAULTAI_CODEX_ACP_BIN") {
        candidates.push(PathBuf::from(path));
    }

    let vendor_dir = manifest_dir.join("../../../vendor/codex-acp");
    candidates.push(vendor_dir.join("target/release").join(binary_name));
    candidates.push(vendor_dir.join("target/debug").join(binary_name));

    candidates
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
