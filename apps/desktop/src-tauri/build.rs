use std::{
    collections::{BTreeSet, VecDeque},
    env, fs, io,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

const CLAUDE_VENDOR_DIR: &str = "../../../vendor/Claude-agent-acp-upstream";
const EMBEDDED_ROOT: &str = "embedded";
const EMBEDDED_CLAUDE_DIR: &str = "claude-agent-acp";
const EMBEDDED_NODE_DIR: &str = "node";

fn main() {
    stage_runtime(RuntimeStageSpec {
        label: "codex",
        env_bundle_key: "VAULTAI_CODEX_ACP_BUNDLE_BIN",
        env_runtime_key: "VAULTAI_CODEX_ACP_BIN",
        vendor_dir: "../../../vendor/codex-acp",
        binary_name: runtime_binary_name("codex-acp"),
    });
    stage_embedded_claude_runtime();
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

    let Some(source) = candidates.into_iter().find(|path| path.exists()) else {
        println!(
            "cargo:warning=No prebuilt {} runtime found. Expected one of: {}",
            spec.label,
            format_candidates(&candidate_paths(&manifest_dir, &spec))
        );
        return;
    };

    stage_from_source(&spec, &binaries_dir, &source, &destination);
}

fn stage_embedded_claude_runtime() {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR missing"));
    let vendor_root = manifest_dir.join(CLAUDE_VENDOR_DIR);
    let embedded_root = manifest_dir.join(EMBEDDED_ROOT);
    let embedded_claude_root = embedded_root.join(EMBEDDED_CLAUDE_DIR);
    let embedded_node_root = embedded_root.join(EMBEDDED_NODE_DIR);
    let legacy_binary = manifest_dir
        .join("binaries")
        .join(runtime_binary_name("claude-agent-acp"));

    println!("cargo:rerun-if-env-changed=VAULTAI_EMBEDDED_NODE_BIN");
    println!(
        "cargo:rerun-if-changed={}",
        vendor_root.join("package.json").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        vendor_root.join("dist").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        vendor_root.join("node_modules").display()
    );

    if legacy_binary.exists() {
        let _ = fs::remove_file(&legacy_binary);
    }

    stage_embedded_node_runtime(&embedded_node_root);
    stage_embedded_claude_project(&vendor_root, &embedded_claude_root);
}

fn stage_embedded_node_runtime(destination_root: &Path) {
    if destination_root.exists() {
        fs::remove_dir_all(destination_root).unwrap_or_else(|error| {
            panic!(
                "failed to clear embedded node runtime {}: {error}",
                destination_root.display()
            )
        });
    }

    let source_node = resolve_node_binary();
    let node_root = source_node
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| panic!("unexpected node binary path: {}", source_node.display()))
        .to_path_buf();

    println!("cargo:rerun-if-changed={}", source_node.display());

    let destination_node =
        destination_root
            .join("bin")
            .join(source_node.file_name().unwrap_or_else(|| {
                panic!(
                    "node binary is missing a file name: {}",
                    source_node.display()
                )
            }));
    copy_file(&source_node, &destination_node);
    ensure_executable_if_needed(&destination_node);

    let mut queue = VecDeque::from([(source_node.clone(), destination_node.clone())]);
    let mut seen = BTreeSet::new();
    seen.insert(source_node);

    while let Some((source_path, destination_path)) = queue.pop_front() {
        let source_path = fs::canonicalize(&source_path).unwrap_or(source_path);
        let destination_bucket = destination_path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .unwrap_or_default()
            .to_string();

        if destination_bucket == "lib" {
            set_install_name_id(&destination_path);
        }

        for dependency in dylib_dependencies(&source_path) {
            if is_system_dependency(&dependency) {
                continue;
            }

            let resolved = resolve_dynamic_dependency(&source_path, &dependency, &node_root)
                .unwrap_or_else(|| {
                    panic!(
                        "failed to resolve embedded node dependency {dependency} referenced by {}",
                        source_path.display()
                    )
                });
            let resolved = fs::canonicalize(&resolved).unwrap_or(resolved);
            if resolved == source_path {
                continue;
            }

            println!("cargo:rerun-if-changed={}", resolved.display());

            let file_name = resolved.file_name().unwrap_or_else(|| {
                panic!(
                    "resolved dependency is missing a file name: {}",
                    resolved.display()
                )
            });
            let destination_dependency = destination_root.join("lib").join(file_name);

            if !destination_dependency.exists() {
                copy_file(&resolved, &destination_dependency);
                ensure_executable_if_needed(&destination_dependency);
            }

            let replacement = if destination_bucket == "bin" {
                format!("@executable_path/../lib/{}", file_name.to_string_lossy())
            } else {
                format!("@loader_path/{}", file_name.to_string_lossy())
            };
            change_install_name(&destination_path, &dependency, &replacement);

            if seen.insert(resolved.clone()) {
                queue.push_back((resolved, destination_dependency));
            }
        }
    }

    codesign_tree(destination_root);
}

fn stage_embedded_claude_project(source_root: &Path, destination_root: &Path) {
    if destination_root.exists() {
        fs::remove_dir_all(destination_root).unwrap_or_else(|error| {
            panic!(
                "failed to clear embedded Claude runtime {}: {error}",
                destination_root.display()
            )
        });
    }

    copy_file(
        &source_root.join("package.json"),
        &destination_root.join("package.json"),
    );
    copy_dir_recursive(&source_root.join("dist"), &destination_root.join("dist"));

    let source_root = fs::canonicalize(source_root).unwrap_or_else(|_| source_root.to_path_buf());

    let dependency_roots = npm_runtime_dependency_paths(&source_root)
        .unwrap_or_else(|_| fallback_runtime_dependency_paths(&source_root));

    for dependency_root in dependency_roots {
        let relative = dependency_root
            .strip_prefix(&source_root)
            .unwrap_or_else(|_| {
                panic!(
                    "runtime dependency {} is not inside {}",
                    dependency_root.display(),
                    source_root.display()
                )
            });
        copy_dir_recursive(&dependency_root, &destination_root.join(relative));
    }

    codesign_tree(destination_root);
}

fn npm_runtime_dependency_paths(source_root: &Path) -> io::Result<Vec<PathBuf>> {
    let normalized_source_root =
        fs::canonicalize(source_root).unwrap_or_else(|_| source_root.to_path_buf());
    let output = Command::new("npm")
        .args(["ls", "--omit=dev", "--parseable", "--all"])
        .current_dir(source_root)
        .output()?;

    if !output.status.success() {
        return Err(io::Error::other(format!(
            "npm ls failed with status {}",
            output.status
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(PathBuf::from)
        .map(|path| fs::canonicalize(&path).unwrap_or(path))
        .filter(|path| path != &normalized_source_root)
        .collect())
}

fn fallback_runtime_dependency_paths(source_root: &Path) -> Vec<PathBuf> {
    vec![
        source_root
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("sdk"),
        source_root
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-agent-sdk"),
        source_root
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-code"),
        source_root.join("node_modules").join("zod"),
        source_root
            .join("node_modules")
            .join("@img")
            .join("sharp-darwin-arm64"),
        source_root
            .join("node_modules")
            .join("@img")
            .join("sharp-libvips-darwin-arm64"),
    ]
    .into_iter()
    .filter(|path| path.exists())
    .collect()
}

fn resolve_node_binary() -> PathBuf {
    if let Ok(value) = env::var("VAULTAI_EMBEDDED_NODE_BIN") {
        let path = PathBuf::from(value);
        if path.exists() {
            return fs::canonicalize(&path).unwrap_or(path);
        }
        panic!(
            "VAULTAI_EMBEDDED_NODE_BIN points to a missing file: {}",
            path.display()
        );
    }

    let path = find_program("node").unwrap_or_else(|| panic!("failed to locate node in PATH"));
    fs::canonicalize(&path).unwrap_or(path)
}

fn dylib_dependencies(path: &Path) -> Vec<String> {
    let output = Command::new("otool")
        .args(["-L", path.to_string_lossy().as_ref()])
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "failed to inspect dylib dependencies for {}: {error}",
                path.display()
            )
        });

    if !output.status.success() {
        panic!(
            "otool -L failed for {} with status {}",
            path.display(),
            output.status
        );
    }

    String::from_utf8_lossy(&output.stdout)
        .lines()
        .skip(1)
        .filter_map(|line| line.trim().split(" (").next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn resolve_dynamic_dependency(
    source_path: &Path,
    dependency: &str,
    node_root: &Path,
) -> Option<PathBuf> {
    if dependency.starts_with("@rpath/") {
        let file_name = dependency.trim_start_matches("@rpath/");
        let source_local = source_path.parent().map(|parent| parent.join(file_name));
        if let Some(path) = source_local.filter(|path| path.exists()) {
            return Some(path);
        }
        let node_local = node_root.join("lib").join(file_name);
        if node_local.exists() {
            return Some(node_local);
        }
        return find_library_by_name(Path::new(file_name).file_name()?.to_str()?);
    }

    if dependency.starts_with("@loader_path/") {
        let relative = dependency.trim_start_matches("@loader_path/");
        let source_local = source_path.parent().map(|parent| parent.join(relative));
        if let Some(path) = source_local.filter(|path| path.exists()) {
            return Some(path);
        }
        return find_library_by_name(Path::new(relative).file_name()?.to_str()?);
    }

    let candidate = PathBuf::from(dependency);
    if candidate.exists() {
        return Some(candidate);
    }

    find_library_by_name(candidate.file_name()?.to_str()?)
}

fn is_system_dependency(path: &str) -> bool {
    path.starts_with("/System/Library/") || path.starts_with("/usr/lib/")
}

fn find_library_by_name(file_name: &str) -> Option<PathBuf> {
    let direct_candidates = [
        PathBuf::from("/opt/homebrew/lib").join(file_name),
        PathBuf::from("/usr/local/lib").join(file_name),
    ];
    for candidate in direct_candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    for root in ["/opt/homebrew/Cellar", "/usr/local/Cellar"] {
        let command = format!("find {root} -path '*/{file_name}' -print -quit 2>/dev/null");
        let output = Command::new("sh").args(["-c", &command]).output().ok()?;
        if !output.status.success() {
            continue;
        }
        let candidate = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !candidate.is_empty() {
            return Some(PathBuf::from(candidate));
        }
    }

    None
}

fn set_install_name_id(path: &Path) {
    let file_name = path
        .file_name()
        .unwrap_or_else(|| panic!("failed to determine install name for {}", path.display()));
    let id = format!("@loader_path/{}", file_name.to_string_lossy());
    run_install_name_tool(["-id", &id], path);
}

fn change_install_name(path: &Path, old: &str, new: &str) {
    if old == new {
        return;
    }
    run_install_name_tool(["-change", old, new], path);
}

fn run_install_name_tool<const N: usize>(args: [&str; N], path: &Path) {
    let status = Command::new("install_name_tool")
        .args(args)
        .arg(path)
        .status()
        .unwrap_or_else(|error| {
            panic!(
                "failed to run install_name_tool for {}: {error}",
                path.display()
            )
        });

    if !status.success() {
        panic!(
            "install_name_tool failed for {} with status {}",
            path.display(),
            status
        );
    }
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

fn copy_dir_recursive(source: &Path, destination: &Path) {
    let entries = fs::read_dir(source)
        .unwrap_or_else(|error| panic!("failed to read directory {}: {error}", source.display()));
    fs::create_dir_all(destination).unwrap_or_else(|error| {
        panic!(
            "failed to create directory {}: {error}",
            destination.display()
        )
    });

    for entry in entries {
        let entry = entry.unwrap_or_else(|error| {
            panic!("failed to read entry inside {}: {error}", source.display())
        });
        let path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if path.is_dir() {
            copy_dir_recursive(&path, &destination_path);
        } else if path.is_file() {
            copy_file(&path, &destination_path);
        }
    }
}

fn copy_file(source: &Path, destination: &Path) {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).unwrap_or_else(|error| {
            panic!(
                "failed to create parent directory {}: {error}",
                parent.display()
            )
        });
    }

    if files_match(source, destination) {
        return;
    }

    fs::copy(source, destination).unwrap_or_else(|error| {
        panic!(
            "failed to copy {} to {}: {error}",
            source.display(),
            destination.display()
        )
    });
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

fn codesign_tree(root: &Path) {
    #[cfg(target_os = "macos")]
    {
        let mut files = Vec::new();
        collect_signable_files(root, &mut files);
        files.sort();
        for path in files {
            codesign_path(&path);
        }
    }
}

#[cfg(target_os = "macos")]
fn collect_signable_files(root: &Path, output: &mut Vec<PathBuf>) {
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_signable_files(&path, output);
            continue;
        }
        if is_macho_binary(&path) {
            output.push(path);
        }
    }
}

#[cfg(target_os = "macos")]
fn is_macho_binary(path: &Path) -> bool {
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut magic = [0_u8; 4];
    if file.read_exact(&mut magic).is_err() {
        return false;
    }

    matches!(
        magic,
        [0xfe, 0xed, 0xfa, 0xce]
            | [0xfe, 0xed, 0xfa, 0xcf]
            | [0xce, 0xfa, 0xed, 0xfe]
            | [0xcf, 0xfa, 0xed, 0xfe]
            | [0xca, 0xfe, 0xba, 0xbe]
            | [0xca, 0xfe, 0xba, 0xbf]
    )
}

#[cfg(target_os = "macos")]
fn codesign_path(path: &Path) {
    let status = Command::new("codesign")
        .args(["--force", "--sign", "-", "--timestamp=none"])
        .arg(path)
        .status()
        .unwrap_or_else(|error| panic!("failed to codesign {}: {error}", path.display()));

    if !status.success() {
        panic!(
            "codesign failed for {} with status {}",
            path.display(),
            status
        );
    }
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
