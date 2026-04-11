use std::{
    collections::{BTreeSet, HashSet, VecDeque},
    env,
    ffi::OsString,
    fs, io,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    thread,
    time::Duration,
};

const CLAUDE_VENDOR_DIR: &str = "../../../vendor/Claude-agent-acp-upstream";
const EMBEDDED_ROOT: &str = "embedded";
const EMBEDDED_CLAUDE_DIR: &str = "claude-agent-acp";
const EMBEDDED_NODE_DIR: &str = "node";
const CODEX_ACP_BUNDLE_BIN_ENV_VARS: [&str; 1] = ["NEVERWRITE_CODEX_ACP_BUNDLE_BIN"];
const CODEX_ACP_BIN_ENV_VARS: [&str; 1] = ["NEVERWRITE_CODEX_ACP_BIN"];
const EMBEDDED_NODE_BIN_ENV_VARS: [&str; 1] = ["NEVERWRITE_EMBEDDED_NODE_BIN"];

fn main() {
    println!("cargo:rerun-if-env-changed=PATH");
    println!("cargo:rerun-if-env-changed=HOME");
    println!("cargo:rerun-if-env-changed=USERPROFILE");
    println!("cargo:rerun-if-env-changed=PATHEXT");

    stage_runtime(RuntimeStageSpec {
        label: "codex",
        env_bundle_keys: &CODEX_ACP_BUNDLE_BIN_ENV_VARS,
        env_runtime_keys: &CODEX_ACP_BIN_ENV_VARS,
        vendor_dir: "../../../vendor/codex-acp",
        binary_name: runtime_binary_name("codex-acp"),
    });
    stage_embedded_claude_runtime();
    tauri_build::build()
}

struct RuntimeStageSpec<'a> {
    label: &'a str,
    env_bundle_keys: &'a [&'a str],
    env_runtime_keys: &'a [&'a str],
    vendor_dir: &'a str,
    binary_name: &'a str,
}

fn stage_runtime(spec: RuntimeStageSpec<'_>) {
    let manifest_dir =
        PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR missing"));
    let workspace_root = manifest_dir.join("../../..");
    let binaries_dir = manifest_dir.join("binaries");
    let destination = binaries_dir.join(spec.binary_name);

    for key in spec.env_bundle_keys {
        println!("cargo:rerun-if-env-changed={key}");
    }
    for key in spec.env_runtime_keys {
        println!("cargo:rerun-if-env-changed={key}");
    }
    println!("cargo:rerun-if-env-changed=CARGO");

    let vendor_dir = manifest_dir.join(spec.vendor_dir);
    let candidates = candidate_paths(&manifest_dir, &workspace_root, &spec);
    for candidate in &candidates {
        println!("cargo:rerun-if-changed={}", candidate.display());
    }
    println!(
        "cargo:rerun-if-changed={}",
        vendor_dir.join("Cargo.toml").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        vendor_dir.join("Cargo.lock").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        vendor_dir.join("src").display()
    );

    let source = resolve_runtime_source(
        &manifest_dir,
        &workspace_root,
        &destination,
        &spec,
        &candidates,
    );

    if let Some(source) = source {
        stage_from_source(&spec, &binaries_dir, &source, &destination);
        return;
    }

    println!(
        "cargo:warning=No usable {} runtime found. Expected one of: {}",
        spec.label,
        format_candidates(&candidate_paths(&manifest_dir, &workspace_root, &spec))
    );
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

    for key in EMBEDDED_NODE_BIN_ENV_VARS {
        println!("cargo:rerun-if-env-changed={key}");
    }
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

    ensure_npm_dependencies(&vendor_root);
    stage_embedded_node_runtime(&embedded_node_root);
    stage_embedded_claude_project(&vendor_root, &embedded_claude_root);
    validate_embedded_claude_runtime(&embedded_node_root, &embedded_claude_root);
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
    println!("cargo:rerun-if-changed={}", source_node.display());

    if cargo_target_os() == "macos" {
        stage_macos_embedded_node_runtime(destination_root, &source_node);
    } else {
        stage_portable_embedded_node_runtime(destination_root, &source_node);
    }

    codesign_tree(destination_root);
}

fn stage_macos_embedded_node_runtime(destination_root: &Path, source_node: &Path) {
    let node_root = source_node
        .parent()
        .and_then(Path::parent)
        .unwrap_or_else(|| panic!("unexpected node binary path: {}", source_node.display()))
        .to_path_buf();

    let destination_node =
        destination_root
            .join("bin")
            .join(source_node.file_name().unwrap_or_else(|| {
                panic!(
                    "node binary is missing a file name: {}",
                    source_node.display()
                )
            }));
    copy_file(source_node, &destination_node);
    ensure_executable_if_needed(&destination_node);

    let mut queue = VecDeque::from([(source_node.to_path_buf(), destination_node.clone())]);
    let mut seen = BTreeSet::new();
    seen.insert(source_node.to_path_buf());

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
}

fn stage_portable_embedded_node_runtime(destination_root: &Path, source_node: &Path) {
    if cargo_target_os() == "windows"
        && source_node
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case("exe"))
            != Some(true)
    {
        panic!(
            "Windows bundles require a Windows node.exe. Build on Windows or set NEVERWRITE_EMBEDDED_NODE_BIN to a Windows Node runtime. Got {}",
            source_node.display()
        );
    }

    let destination_bin = destination_root.join("bin");
    let destination_node = destination_bin.join(node_binary_name_for_target());
    copy_file(source_node, &destination_node);
    ensure_executable_if_needed(&destination_node);

    let source_dir = source_node.parent().unwrap_or_else(|| {
        panic!(
            "node binary is missing a parent directory: {}",
            source_node.display()
        )
    });

    for entry in fs::read_dir(source_dir).unwrap_or_else(|error| {
        panic!(
            "failed to inspect embedded node source directory {}: {error}",
            source_dir.display()
        )
    }) {
        let entry = entry.unwrap_or_else(|error| {
            panic!(
                "failed to read entry inside embedded node source directory {}: {error}",
                source_dir.display()
            )
        });
        let path = entry.path();
        if path == source_node {
            continue;
        }

        if !should_copy_portable_node_runtime_entry(&path) {
            continue;
        }

        println!("cargo:rerun-if-changed={}", path.display());
        copy_file(&path, &destination_bin.join(entry.file_name()));
    }
}

fn ensure_npm_dependencies(vendor_root: &Path) {
    if vendor_root.join("node_modules").exists() {
        return;
    }

    println!("cargo:warning=Installing Claude ACP npm dependencies...");
    let status = Command::new("npm")
        .args(["install", "--omit=dev"])
        .current_dir(vendor_root)
        .status()
        .unwrap_or_else(|error| {
            panic!(
                "failed to run npm install in {}: {error}",
                vendor_root.display()
            )
        });

    if !status.success() {
        panic!(
            "npm install failed in {} with status {}",
            vendor_root.display(),
            status
        );
    }
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

fn validate_embedded_claude_runtime(embedded_node_root: &Path, embedded_claude_root: &Path) {
    let required_paths = [
        embedded_node_root
            .join("bin")
            .join(node_binary_name_for_target()),
        embedded_claude_root.join("package.json"),
        embedded_claude_root.join("dist").join("index.js"),
        embedded_claude_root
            .join("node_modules")
            .join("@agentclientprotocol")
            .join("sdk"),
        embedded_claude_root
            .join("node_modules")
            .join("@anthropic-ai")
            .join("claude-agent-sdk"),
        embedded_claude_root.join("node_modules").join("zod"),
    ];

    for path in required_paths {
        if !path.exists() {
            panic!(
                "embedded Claude runtime is incomplete for {}-{}: missing {}",
                cargo_target_os(),
                cargo_target_arch(),
                path.display()
            );
        }
    }

    for path in target_optional_dependency_paths(embedded_claude_root) {
        if !path.exists() {
            panic!(
                "embedded Claude runtime is missing target dependency {} for {}-{}",
                path.display(),
                cargo_target_os(),
                cargo_target_arch()
            );
        }
    }
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
    let mut paths = vec![
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
    ];

    paths.extend(target_optional_dependency_paths(source_root));
    paths.into_iter().filter(|path| path.exists()).collect()
}

fn resolve_node_binary() -> PathBuf {
    for key in EMBEDDED_NODE_BIN_ENV_VARS {
        if let Ok(value) = env::var(key) {
            let path = PathBuf::from(value);
            if path.exists() {
                return fs::canonicalize(&path).unwrap_or(path);
            }
            panic!("{key} points to a missing file: {}", path.display());
        }
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
    const MAX_ATTEMPTS: usize = 3;

    for attempt in 1..=MAX_ATTEMPTS {
        let output = Command::new("install_name_tool")
            .args(args)
            .arg(path)
            .output()
            .unwrap_or_else(|error| {
                panic!(
                    "failed to run install_name_tool for {}: {error}",
                    path.display()
                )
            });

        if output.status.success() {
            return;
        }

        if attempt < MAX_ATTEMPTS {
            // `install_name_tool` can sporadically fail on freshly copied Mach-O files
            // during staging, so give the filesystem a moment and retry.
            thread::sleep(Duration::from_millis(50));
            continue;
        }

        let stderr = String::from_utf8_lossy(&output.stderr);
        panic!(
            "install_name_tool failed for {} with status {}: {}",
            path.display(),
            output.status,
            stderr.trim()
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

fn resolve_runtime_source(
    manifest_dir: &Path,
    workspace_root: &Path,
    destination: &Path,
    spec: &RuntimeStageSpec<'_>,
    candidates: &[PathBuf],
) -> Option<PathBuf> {
    for key in spec
        .env_bundle_keys
        .iter()
        .chain(spec.env_runtime_keys.iter())
        .copied()
    {
        if let Ok(path) = env::var(key) {
            let source = PathBuf::from(path);
            if source.exists() {
                return Some(source);
            }
        }
    }

    // In dev we prefer the staged/local runtime so frontend-only edits do not
    // trigger a full rebuild of the embedded ACP on every desktop restart.
    if cargo_profile() != "release" {
        if destination.exists() {
            println!(
                "cargo:warning=Reusing staged {} runtime at {} for dev build.",
                spec.label,
                destination.display()
            );
            return Some(destination.to_path_buf());
        }

        if let Some(source) = candidates.iter().find(|path| path.exists()) {
            println!(
                "cargo:warning=Reusing existing {} runtime at {} for dev build.",
                spec.label,
                source.display()
            );
            return Some(source.clone());
        }
    }

    if spec.label == "codex" {
        match build_vendor_runtime(manifest_dir, spec) {
            Ok(Some(source)) => return Some(source),
            Ok(None) => {}
            Err(error) => {
                if destination.exists() {
                    println!(
                        "cargo:warning=Failed to rebuild {} runtime ({}). Reusing staged binary at {}.",
                        spec.label,
                        error,
                        destination.display()
                    );
                    return Some(destination.to_path_buf());
                }

                panic!(
                    "failed to rebuild {} runtime and no staged fallback exists: {}",
                    spec.label, error
                );
            }
        }
    }

    if let Some(source) = candidates.iter().find(|path| path.exists()) {
        return Some(source.clone());
    }

    if destination.exists() {
        println!(
            "cargo:warning=Reusing staged {} runtime at {} because no fresher source was found. Checked: {}",
            spec.label,
            destination.display(),
            format_candidates(&candidate_paths(manifest_dir, workspace_root, spec))
        );
        return Some(destination.to_path_buf());
    }

    None
}

fn build_vendor_runtime(
    manifest_dir: &Path,
    spec: &RuntimeStageSpec<'_>,
) -> Result<Option<PathBuf>, String> {
    let vendor_dir = manifest_dir.join(spec.vendor_dir);
    let manifest_path = vendor_dir.join("Cargo.toml");
    if !manifest_path.exists() {
        return Ok(None);
    }

    let cargo_bin = env::var("CARGO").unwrap_or_else(|_| "cargo".to_string());
    let mut command = Command::new(cargo_bin);
    command
        .arg("build")
        .arg("--manifest-path")
        .arg(&manifest_path)
        .arg("--bin")
        .arg(binary_stem(spec.binary_name))
        .current_dir(&vendor_dir);

    if cargo_profile() == "release" {
        command.arg("--release");
    }

    let output = command
        .output()
        .map_err(|error| format!("failed to launch cargo build: {error}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let detail = if !stderr.is_empty() {
            stderr
        } else if !stdout.is_empty() {
            stdout
        } else {
            format!("cargo exited with status {}", output.status)
        };
        return Err(detail);
    }

    let built_path = vendor_dir
        .join("target")
        .join(cargo_profile())
        .join(spec.binary_name);
    if built_path.exists() {
        println!(
            "cargo:warning=Built {} runtime from source at {}",
            spec.label,
            built_path.display()
        );
        return Ok(Some(built_path));
    }

    Err(format!(
        "cargo build succeeded but {} was not produced at {}",
        spec.binary_name,
        built_path.display()
    ))
}

fn candidate_paths(
    manifest_dir: &Path,
    workspace_root: &Path,
    spec: &RuntimeStageSpec<'_>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    for key in spec.env_bundle_keys {
        if let Ok(path) = env::var(key) {
            candidates.push(PathBuf::from(path));
        }
    }

    for key in spec.env_runtime_keys {
        if let Ok(path) = env::var(key) {
            candidates.push(PathBuf::from(path));
        }
    }

    let vendor_dir = manifest_dir.join(spec.vendor_dir);
    candidates.push(vendor_dir.join("target/release").join(spec.binary_name));
    candidates.push(vendor_dir.join("target/debug").join(spec.binary_name));
    candidates.push(
        workspace_root
            .join("target/release/binaries")
            .join(spec.binary_name),
    );
    candidates.push(
        workspace_root
            .join("target/debug/binaries")
            .join(spec.binary_name),
    );
    candidates.push(workspace_root.join("target/release").join(spec.binary_name));
    candidates.push(workspace_root.join("target/debug").join(spec.binary_name));
    if let Some(path) = find_program(spec.binary_name) {
        candidates.push(path);
    }

    candidates
}

fn binary_stem(binary_name: &str) -> &str {
    binary_name.strip_suffix(".exe").unwrap_or(binary_name)
}

fn cargo_profile() -> String {
    env::var("PROFILE").unwrap_or_else(|_| "debug".to_string())
}

fn runtime_binary_name(base: &'static str) -> &'static str {
    if cargo_target_os() == "windows" {
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

    for directory in preferred_path_entries() {
        for candidate in executable_candidates(&directory, program) {
            if candidate.exists() && candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

fn preferred_path_entries() -> Vec<PathBuf> {
    let mut entries = env::var_os("PATH")
        .map(|paths| env::split_paths(&paths).collect::<Vec<_>>())
        .unwrap_or_default();

    if let Some(home) = home_dir() {
        entries.push(home.join(".cargo/bin"));
        entries.push(home.join(".local/bin"));
    }

    #[cfg(target_os = "macos")]
    {
        // GUI-launched builds often miss Homebrew paths, so stage/runtime discovery
        // must add the common tool directories explicitly.
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

    dedupe_paths(entries)
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

fn cargo_target_os() -> String {
    env::var("CARGO_CFG_TARGET_OS").unwrap_or_else(|_| env::consts::OS.to_string())
}

fn cargo_target_arch() -> String {
    env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_else(|_| env::consts::ARCH.to_string())
}

fn cargo_target_env() -> Option<String> {
    env::var("CARGO_CFG_TARGET_ENV").ok()
}

fn node_binary_name_for_target() -> &'static str {
    if cargo_target_os() == "windows" {
        "node.exe"
    } else {
        "node"
    }
}

fn should_copy_portable_node_runtime_entry(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };

    let lower = file_name.to_ascii_lowercase();
    lower.ends_with(".dll")
        || lower.ends_with(".dat")
        || lower.ends_with(".so")
        || lower.contains(".so.")
}

fn target_optional_dependency_paths(root: &Path) -> Vec<PathBuf> {
    let img_root = root.join("node_modules").join("@img");
    let target_os = cargo_target_os();
    let target_arch = cargo_target_arch();
    let npm_arch = match target_arch.as_str() {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "arm" => "arm",
        other => other,
    };

    match target_os.as_str() {
        "windows" => vec![img_root.join(format!("sharp-win32-{npm_arch}"))],
        "macos" => vec![
            img_root.join(format!("sharp-darwin-{npm_arch}")),
            img_root.join(format!("sharp-libvips-darwin-{npm_arch}")),
        ],
        "linux" => {
            let libc_variant = if cargo_target_env().as_deref() == Some("musl") {
                "linuxmusl"
            } else {
                "linux"
            };
            let mut paths = vec![img_root.join(format!("sharp-{libc_variant}-{npm_arch}"))];
            if libc_variant != "windows" {
                paths.push(img_root.join(format!("sharp-libvips-{libc_variant}-{npm_arch}")));
            }
            paths
        }
        _ => Vec::new(),
    }
}

fn executable_candidates(directory: &Path, program: &str) -> Vec<PathBuf> {
    let base = directory.join(program);
    if cargo_target_os() == "windows" {
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
        candidates
    } else {
        vec![base]
    }
}

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
