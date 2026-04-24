import { spawn } from "node:child_process";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = path.resolve(appRoot, "..", "..");
const stagedDir = path.join(appRoot, "out", "native-backend");
const binariesDir = path.join(stagedDir, "binaries");
const embeddedDir = path.join(stagedDir, "embedded");
const embeddedAssetsDir = path.join(appRoot, "embedded");
const vendorClaudeEmbeddedDir = path.join(
    workspaceRoot,
    "vendor",
    "Claude-agent-acp-upstream",
);
const MAC_UNIVERSAL_TARGET = "universal-apple-darwin";
const MAC_UNIVERSAL_COMPONENT_TARGETS = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
];

function parseArgs(argv) {
    const args = {
        target: process.env.NEVERWRITE_ELECTRON_RELEASE_TARGET?.trim() || null,
        skipBuild: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--target") {
            args.target = next;
            index += 1;
            continue;
        }
        if (arg === "--skip-build") {
            args.skipBuild = true;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --target <rust-target|universal-apple-darwin>, --skip-build.`,
        );
    }

    return args;
}

function run(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            stdio: "inherit",
            shell: process.platform === "win32",
        });
        child.on("error", reject);
        child.on("exit", (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    signal
                        ? `${command} ${args.join(" ")} terminated with ${signal}`
                        : `${command} ${args.join(" ")} exited with ${code}`,
                ),
            );
        });
    });
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

function resolveHostRustTarget() {
    if (process.platform === "darwin" && process.arch === "arm64") {
        return "aarch64-apple-darwin";
    }
    if (process.platform === "darwin" && process.arch === "x64") {
        return "x86_64-apple-darwin";
    }
    if (process.platform === "win32" && process.arch === "arm64") {
        return "aarch64-pc-windows-msvc";
    }
    if (process.platform === "win32" && process.arch === "x64") {
        return "x86_64-pc-windows-msvc";
    }

    throw new Error(
        `Unsupported host platform for Electron sidecar staging: ${process.platform}/${process.arch}`,
    );
}

function executableNameForTarget(baseName, targetTriple) {
    return targetTriple.includes("windows") ? `${baseName}.exe` : baseName;
}

function isMacUniversalTarget(targetTriple) {
    return targetTriple === MAC_UNIVERSAL_TARGET;
}

function envSuffixForTarget(targetTriple) {
    if (targetTriple === "aarch64-apple-darwin") return "ARM64";
    if (targetTriple === "x86_64-apple-darwin") return "X64";
    if (targetTriple === "aarch64-pc-windows-msvc") return "ARM64";
    if (targetTriple === "x86_64-pc-windows-msvc") return "X64";
    throw new Error(`Unsupported target for environment suffix: ${targetTriple}`);
}

async function resolveBuiltBinary({
    envKeys,
    fallbackPath,
    description,
}) {
    for (const envKey of envKeys) {
        const configuredPath = process.env[envKey]?.trim();
        if (!configuredPath) {
            continue;
        }
        if (!(await pathExists(configuredPath))) {
            throw new Error(
                `${description} override path from ${envKey} does not exist: ${configuredPath}`,
            );
        }
        return configuredPath;
    }

    if (!(await pathExists(fallbackPath))) {
        throw new Error(`${description} binary was not found: ${fallbackPath}`);
    }

    return fallbackPath;
}

function nodeSourceFromBinary(configuredNodeBinary) {
    const sourceDir = path.dirname(configuredNodeBinary);
    if (configuredNodeBinary.endsWith(".exe")) {
        return { kind: "portable-bin-directory", sourcePath: sourceDir };
    }

    return {
        kind: "directory",
        sourcePath: path.resolve(sourceDir, ".."),
    };
}

async function resolveEmbeddedNodeSource(targetTriple) {
    if (isMacUniversalTarget(targetTriple)) {
        const arm64Binary = process.env.NEVERWRITE_EMBEDDED_NODE_BIN_ARM64?.trim();
        const x64Binary = process.env.NEVERWRITE_EMBEDDED_NODE_BIN_X64?.trim();

        if (!arm64Binary || !x64Binary) {
            throw new Error(
                "Universal macOS packaging requires NEVERWRITE_EMBEDDED_NODE_BIN_ARM64 and NEVERWRITE_EMBEDDED_NODE_BIN_X64.",
            );
        }
        for (const [label, binaryPath] of [
            ["arm64", arm64Binary],
            ["x64", x64Binary],
        ]) {
            if (!(await pathExists(binaryPath))) {
                throw new Error(
                    `Configured ${label} embedded Node binary does not exist: ${binaryPath}`,
                );
            }
        }

        return {
            kind: "universal-directory",
            arm64Binary,
            x64Binary,
            sourcePath: nodeSourceFromBinary(arm64Binary).sourcePath,
        };
    }

    const configuredNodeBinary = process.env.NEVERWRITE_EMBEDDED_NODE_BIN?.trim();
    if (!configuredNodeBinary) {
        return {
            kind: "directory",
            sourcePath: path.join(embeddedAssetsDir, "node"),
        };
    }

    return nodeSourceFromBinary(configuredNodeBinary);
}

async function resolveClaudeEmbeddedSource() {
    const configuredSource = process.env.NEVERWRITE_CLAUDE_EMBEDDED_DIR?.trim();
    if (configuredSource) {
        if (!(await pathExists(configuredSource))) {
            throw new Error(
                `Configured Claude embedded runtime directory does not exist: ${configuredSource}`,
            );
        }
        return configuredSource;
    }

    const sourceCandidates = [
        path.join(embeddedAssetsDir, "claude-agent-acp"),
        vendorClaudeEmbeddedDir,
    ];

    for (const sourceCandidate of sourceCandidates) {
        if (await pathExists(sourceCandidate)) {
            return sourceCandidate;
        }
    }

    throw new Error(
        `Claude embedded runtime was not found. Checked:\n${sourceCandidates
            .map((candidate) => `- ${candidate}`)
            .join("\n")}`,
    );
}

async function stageEmbeddedNodeRuntime(nodeSource) {
    const destinationNodeRoot = path.join(embeddedDir, "node");

    if (nodeSource.kind === "directory") {
        await fs.cp(nodeSource.sourcePath, destinationNodeRoot, {
            recursive: true,
        });
        return;
    }

    const destinationBinDir = path.join(destinationNodeRoot, "bin");
    await fs.mkdir(destinationBinDir, { recursive: true });
    const entries = await fs.readdir(nodeSource.sourcePath, {
        withFileTypes: true,
    });
    for (const entry of entries) {
        if (!entry.isFile()) {
            continue;
        }
        await fs.copyFile(
            path.join(nodeSource.sourcePath, entry.name),
            path.join(destinationBinDir, entry.name),
        );
    }
}

async function lipoCreate(inputPaths, outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await run("lipo", ["-create", ...inputPaths, "-output", outputPath], appRoot);
}

async function stageUniversalEmbeddedNodeRuntime(nodeSource) {
    const destinationNodeRoot = path.join(embeddedDir, "node");
    await fs.cp(nodeSource.sourcePath, destinationNodeRoot, {
        recursive: true,
    });
    await lipoCreate(
        [nodeSource.arm64Binary, nodeSource.x64Binary],
        path.join(destinationNodeRoot, "bin", "node"),
    );
}

async function ensureExecutableIfNeeded(filePath) {
    if (filePath.endsWith(".exe")) {
        return;
    }
    await fs.chmod(filePath, 0o755);
}

function isWithinDirectory(filePath, directoryPath) {
    const absoluteFilePath = path.resolve(filePath);
    const absoluteDirectoryPath = path.resolve(directoryPath);
    return (
        absoluteFilePath === absoluteDirectoryPath ||
        absoluteFilePath.startsWith(`${absoluteDirectoryPath}${path.sep}`)
    );
}

async function materializeStagingSource(filePath) {
    if (!isWithinDirectory(filePath, stagedDir)) {
        return filePath;
    }

    const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "neverwrite-electron-stage-"),
    );
    const cachedPath = path.join(tempDir, path.basename(filePath));
    await fs.copyFile(filePath, cachedPath);
    return cachedPath;
}

function nativeBackendPathForTarget(targetTriple) {
    return path.join(
        workspaceRoot,
        "target",
        targetTriple,
        "release",
        executableNameForTarget("neverwrite-native-backend", targetTriple),
    );
}

function codexPathForTarget(targetTriple) {
    return path.join(
        workspaceRoot,
        "vendor",
        "codex-acp",
        "target",
        targetTriple,
        "release",
        executableNameForTarget("codex-acp", targetTriple),
    );
}

function targetSpecificEnvKey(baseEnvKey, targetTriple) {
    return `${baseEnvKey}_${envSuffixForTarget(targetTriple)}`;
}

async function buildNativeBackendForTarget(targetTriple) {
    await run(
        "cargo",
        [
            "build",
            "-p",
            "neverwrite-native-backend",
            "--release",
            "--target",
            targetTriple,
            "--quiet",
        ],
        workspaceRoot,
    );
}

async function buildCodexForTarget(targetTriple) {
    await run(
        "cargo",
        [
            "build",
            "--manifest-path",
            path.join(workspaceRoot, "vendor", "codex-acp", "Cargo.toml"),
            "--release",
            "--target",
            targetTriple,
            "--quiet",
        ],
        workspaceRoot,
    );
}

async function resolveSingleTargetRuntimeBinary({
    targetTriple,
    baseEnvKey,
    fallbackPath,
    description,
}) {
    return resolveBuiltBinary({
        envKeys: [targetSpecificEnvKey(baseEnvKey, targetTriple), baseEnvKey],
        fallbackPath,
        description,
    });
}

async function buildOrResolveUniversalRuntimeBinary({
    baseEnvKey,
    description,
    fallbackPathForTarget,
    buildForTarget,
}) {
    const configuredUniversalPath = process.env[baseEnvKey]?.trim();
    if (configuredUniversalPath) {
        if (!(await pathExists(configuredUniversalPath))) {
            throw new Error(
                `${description} universal override path from ${baseEnvKey} does not exist: ${configuredUniversalPath}`,
            );
        }
        return materializeStagingSource(configuredUniversalPath);
    }

    const inputPaths = [];
    for (const componentTarget of MAC_UNIVERSAL_COMPONENT_TARGETS) {
        const envKey = targetSpecificEnvKey(baseEnvKey, componentTarget);
        if (!args.skipBuild && !process.env[envKey]?.trim()) {
            await buildForTarget(componentTarget);
        }
        inputPaths.push(
            await resolveBuiltBinary({
                envKeys: [envKey],
                fallbackPath: fallbackPathForTarget(componentTarget),
                description: `${description} ${componentTarget}`,
            }),
        );
    }

    return inputPaths;
}

const args = parseArgs(process.argv.slice(2));
const targetTriple = args.target ?? resolveHostRustTarget();
const nativeBackendName = executableNameForTarget(
    "neverwrite-native-backend",
    targetTriple,
);
const codexBinaryName = executableNameForTarget("codex-acp", targetTriple);
const stagedPath = path.join(stagedDir, nativeBackendName);
const isUniversalMac = isMacUniversalTarget(targetTriple);

let stagingNativeBackendPath;
let stagingCodexPath;

if (isUniversalMac) {
    stagingNativeBackendPath = await buildOrResolveUniversalRuntimeBinary({
        baseEnvKey: "NEVERWRITE_NATIVE_BACKEND_BUNDLE_BIN",
        description: "Native backend",
        fallbackPathForTarget: nativeBackendPathForTarget,
        buildForTarget: buildNativeBackendForTarget,
    });
    stagingCodexPath = await buildOrResolveUniversalRuntimeBinary({
        baseEnvKey: "NEVERWRITE_CODEX_ACP_BUNDLE_BIN",
        description: "Codex ACP",
        fallbackPathForTarget: codexPathForTarget,
        buildForTarget: buildCodexForTarget,
    });
} else {
    if (
        !args.skipBuild &&
        !process.env.NEVERWRITE_NATIVE_BACKEND_BUNDLE_BIN?.trim() &&
        !process.env[
            targetSpecificEnvKey("NEVERWRITE_NATIVE_BACKEND_BUNDLE_BIN", targetTriple)
        ]?.trim()
    ) {
        await buildNativeBackendForTarget(targetTriple);
    }

    if (
        !args.skipBuild &&
        !process.env.NEVERWRITE_CODEX_ACP_BUNDLE_BIN?.trim() &&
        !process.env[
            targetSpecificEnvKey("NEVERWRITE_CODEX_ACP_BUNDLE_BIN", targetTriple)
        ]?.trim()
    ) {
        await buildCodexForTarget(targetTriple);
    }

    stagingNativeBackendPath = await materializeStagingSource(
        await resolveSingleTargetRuntimeBinary({
            targetTriple,
            baseEnvKey: "NEVERWRITE_NATIVE_BACKEND_BUNDLE_BIN",
            fallbackPath: nativeBackendPathForTarget(targetTriple),
            description: "Native backend",
        }),
    );
    stagingCodexPath = await materializeStagingSource(
        await resolveSingleTargetRuntimeBinary({
            targetTriple,
            baseEnvKey: "NEVERWRITE_CODEX_ACP_BUNDLE_BIN",
            fallbackPath: codexPathForTarget(targetTriple),
            description: "Codex ACP",
        }),
    );
}

const nodeSource = await resolveEmbeddedNodeSource(targetTriple);
const claudeEmbeddedSource = await resolveClaudeEmbeddedSource();

// Electron release jobs must stage binaries for the requested target explicitly.
// Reusing host binaries here would silently create a mismatched bundle.
await fs.rm(stagedDir, { recursive: true, force: true });
await fs.mkdir(stagedDir, { recursive: true });
if (Array.isArray(stagingNativeBackendPath)) {
    await lipoCreate(stagingNativeBackendPath, stagedPath);
} else {
    await fs.copyFile(stagingNativeBackendPath, stagedPath);
}
await fs.mkdir(binariesDir, { recursive: true });
if (Array.isArray(stagingCodexPath)) {
    await lipoCreate(stagingCodexPath, path.join(binariesDir, codexBinaryName));
} else {
    await fs.copyFile(stagingCodexPath, path.join(binariesDir, codexBinaryName));
}
await fs.mkdir(embeddedDir, { recursive: true });
if (nodeSource.kind === "universal-directory") {
    await stageUniversalEmbeddedNodeRuntime(nodeSource);
} else {
    await stageEmbeddedNodeRuntime(nodeSource);
}
await fs.cp(claudeEmbeddedSource, path.join(embeddedDir, "claude-agent-acp"), {
    recursive: true,
});

await ensureExecutableIfNeeded(stagedPath);
await ensureExecutableIfNeeded(path.join(binariesDir, codexBinaryName));

const stagedNodeBinary = path.join(
    embeddedDir,
    "node",
    "bin",
    executableNameForTarget("node", targetTriple),
);
if (await pathExists(stagedNodeBinary)) {
    await ensureExecutableIfNeeded(stagedNodeBinary);
}

console.log(`Staged native backend sidecar at ${stagedPath}`);
console.log(`Staged Electron ACP resources at ${stagedDir}`);
