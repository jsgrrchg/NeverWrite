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

try {
    await fs.access(builtPath);
} catch {
    throw new Error(
        `Native backend release binary was not found after build: ${builtPath}`,
    );
}

await fs.mkdir(stagedDir, { recursive: true });
await fs.copyFile(builtPath, stagedPath);

if (process.platform !== "win32") {
    await fs.chmod(stagedPath, 0o755);
}

console.log(`Staged native backend sidecar at ${stagedPath}`);
