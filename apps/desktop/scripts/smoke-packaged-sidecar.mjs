import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const executableName =
    process.platform === "win32"
        ? "neverwrite-native-backend.exe"
        : "neverwrite-native-backend";
const outputRoot =
    process.env.NEVERWRITE_ELECTRON_OUTPUT_DIR?.trim() ||
    path.join(appRoot, "dist-electron");
const distArch =
    process.env.NEVERWRITE_ELECTRON_DIST_ARCH?.trim() || process.arch;

function defaultPackagedSidecarCandidates() {
    if (process.platform === "darwin") {
        const appRelativePath = path.join(
            "NeverWrite.app",
            "Contents",
            "Resources",
            "native-backend",
            executableName,
        );
        return [
            path.join(outputRoot, `mac-${distArch}`, appRelativePath),
            path.join(outputRoot, "mac", appRelativePath),
        ];
    }

    return [
        path.join(
            outputRoot,
            `win-${distArch}-unpacked`,
            "resources",
            "native-backend",
            executableName,
        ),
        path.join(
            outputRoot,
            "win-unpacked",
            "resources",
            "native-backend",
            executableName,
        ),
        path.join(outputRoot, "native-backend", executableName),
    ];
}

async function findSidecarPath() {
    if (process.env.NEVERWRITE_PACKAGED_SIDECAR_PATH) {
        return process.env.NEVERWRITE_PACKAGED_SIDECAR_PATH;
    }

    const candidates = defaultPackagedSidecarCandidates();
    for (const candidate of candidates) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch {
            // Try the next electron-builder output name.
        }
    }

    throw new Error(
        `Packaged native backend sidecar was not found. Tried:\n${candidates
            .map((candidate) => `- ${candidate}`)
            .join("\n")}`,
    );
}

function assertExecutableMode(stats, sidecarPath) {
    if (process.platform === "win32") return;
    if ((stats.mode & 0o111) === 0) {
        throw new Error(`Packaged sidecar is not executable: ${sidecarPath}`);
    }
}

async function smokePing(sidecarPath) {
    const child = spawn(sidecarPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
    });
    const stderrChunks = [];
    let settled = false;

    child.stderr.on("data", (chunk) => {
        stderrChunks.push(String(chunk));
    });

    return new Promise((resolve, reject) => {
        const lines = readline.createInterface({ input: child.stdout });
        const timeout = setTimeout(() => {
            cleanup();
            reject(
                new Error(
                    `Timed out waiting for sidecar ping response.${formatStderr(
                        stderrChunks,
                    )}`,
                ),
            );
        }, 5000);

        function cleanup() {
            settled = true;
            clearTimeout(timeout);
            lines.close();
            child.stdin.destroy();
            if (!child.killed) child.kill("SIGTERM");
        }

        child.on("error", (error) => {
            if (settled) return;
            cleanup();
            reject(error);
        });

        child.on("exit", (code, signal) => {
            if (settled || child.killed) return;
            cleanup();
            reject(
                new Error(
                    `Sidecar exited before ping succeeded with ${
                        code ?? signal ?? "unknown status"
                    }.${formatStderr(stderrChunks)}`,
                ),
            );
        });

        lines.on("line", (line) => {
            if (settled) return;
            let message;
            try {
                message = JSON.parse(line);
            } catch (error) {
                cleanup();
                reject(new Error(`Invalid JSON response from sidecar: ${error}`));
                return;
            }

            if (message?.ok === true && message?.result?.ok === true) {
                cleanup();
                resolve();
                return;
            }

            cleanup();
            reject(new Error(`Unexpected ping response: ${line}`));
        });

        child.stdin.write('{"id":1,"command":"ping","args":{}}\n');
    });
}

function formatStderr(chunks) {
    const stderr = chunks.join("").trim();
    return stderr ? `\nStderr:\n${stderr}` : "";
}

const sidecarPath = await findSidecarPath();
const stats = await fs.stat(sidecarPath);

if (!stats.isFile()) {
    throw new Error(`Packaged sidecar path is not a file: ${sidecarPath}`);
}

assertExecutableMode(stats, sidecarPath);
await smokePing(sidecarPath);

console.log(`Packaged native backend sidecar responded to ping: ${sidecarPath}`);
