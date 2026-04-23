import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = path.resolve(appRoot, "..", "..");
const executableName =
    process.platform === "win32"
        ? "neverwrite-native-backend.exe"
        : "neverwrite-native-backend";
const builtPath = path.join(
    workspaceRoot,
    "target",
    "release",
    executableName,
);
const stagedDir = path.join(appRoot, "out", "native-backend");
const stagedPath = path.join(stagedDir, executableName);
const binariesDir = path.join(stagedDir, "binaries");
const embeddedDir = path.join(stagedDir, "embedded");
const codexBinaryName =
    process.platform === "win32" ? "codex-acp.exe" : "codex-acp";
const codexReleasePath = path.join(
    workspaceRoot,
    "vendor",
    "codex-acp",
    "target",
    "release",
    codexBinaryName,
);
const tauriEmbeddedDir = path.join(appRoot, "src-tauri", "embedded");

function run(command, args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd,
            stdio: "inherit",
            shell: process.platform === "win32",
        });
        child.on("error", reject);
        child.on("exit", (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(`${command} ${args.join(" ")} exited with ${code}`));
        });
    });
}

await run(
    "cargo",
    ["build", "-p", "neverwrite-native-backend", "--release"],
    workspaceRoot,
);

await run(
    "cargo",
    [
        "build",
        "--manifest-path",
        path.join(workspaceRoot, "vendor", "codex-acp", "Cargo.toml"),
        "--release",
    ],
    workspaceRoot,
);

try {
    await fs.access(builtPath);
} catch {
    throw new Error(
        `Native backend release binary was not found after build: ${builtPath}`,
    );
}

await fs.mkdir(stagedDir, { recursive: true });
await fs.copyFile(builtPath, stagedPath);
await fs.mkdir(binariesDir, { recursive: true });
await fs.copyFile(codexReleasePath, path.join(binariesDir, codexBinaryName));

await fs.rm(embeddedDir, { recursive: true, force: true });
await fs.mkdir(embeddedDir, { recursive: true });
await fs.cp(
    path.join(tauriEmbeddedDir, "node"),
    path.join(embeddedDir, "node"),
    { recursive: true },
);
await fs.cp(
    path.join(tauriEmbeddedDir, "claude-agent-acp"),
    path.join(embeddedDir, "claude-agent-acp"),
    { recursive: true },
);

if (process.platform !== "win32") {
    await fs.chmod(stagedPath, 0o755);
    await fs.chmod(path.join(binariesDir, codexBinaryName), 0o755);
}

console.log(`Staged native backend sidecar at ${stagedPath}`);
console.log(`Staged Electron ACP resources at ${stagedDir}`);
