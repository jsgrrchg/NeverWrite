import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
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
const DEFAULT_SMOKE_TIMEOUT_MS = 15000;
const configuredSmokeTimeoutMs = Number(
    process.env.NEVERWRITE_PACKAGED_SIDECAR_SMOKE_TIMEOUT_MS,
);
const smokeTimeoutMs =
    Number.isFinite(configuredSmokeTimeoutMs) && configuredSmokeTimeoutMs > 0
        ? configuredSmokeTimeoutMs
        : DEFAULT_SMOKE_TIMEOUT_MS;

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

    if (process.platform === "linux") {
        return [
            path.join(
                outputRoot,
                `linux-${distArch}-unpacked`,
                "resources",
                "native-backend",
                executableName,
            ),
            path.join(
                outputRoot,
                "linux-unpacked",
                "resources",
                "native-backend",
                executableName,
            ),
            path.join(outputRoot, "native-backend", executableName),
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

function assertExecutableMode(stats, executablePath, description) {
    if (process.platform === "win32") return;
    if ((stats.mode & 0o111) === 0) {
        throw new Error(`Packaged ${description} is not executable: ${executablePath}`);
    }
}

async function findCodeModeHostPath(sidecarPath) {
    const hostName =
        process.platform === "win32"
            ? "codex-code-mode-host.exe"
            : "codex-code-mode-host";
    const hostPath = path.join(path.dirname(sidecarPath), "binaries", hostName);

    let stats;
    try {
        stats = await fs.stat(hostPath);
    } catch (error) {
        if (error?.code === "ENOENT") {
            throw new Error(`Packaged Codex code-mode host is missing: ${hostPath}`);
        }
        throw new Error(
            `Could not inspect packaged Codex code-mode host: ${hostPath}`,
            { cause: error },
        );
    }
    if (!stats.isFile()) {
        throw new Error(`Packaged Codex code-mode host is not a file: ${hostPath}`);
    }
    assertExecutableMode(stats, hostPath, "Codex code-mode host");
    return hostPath;
}

async function findCodexAcpPath(sidecarPath) {
    const acpName = process.platform === "win32" ? "codex-acp.exe" : "codex-acp";
    const acpPath = path.join(path.dirname(sidecarPath), "binaries", acpName);

    let stats;
    try {
        stats = await fs.stat(acpPath);
    } catch (error) {
        if (error?.code === "ENOENT") {
            throw new Error(`Packaged Codex ACP runtime is missing: ${acpPath}`);
        }
        throw new Error(`Could not inspect packaged Codex ACP runtime: ${acpPath}`, {
            cause: error,
        });
    }
    if (!stats.isFile()) {
        throw new Error(`Packaged Codex ACP runtime is not a file: ${acpPath}`);
    }
    assertExecutableMode(stats, acpPath, "Codex ACP runtime");
    return acpPath;
}

async function smokeCodeModeHost(hostPath) {
    const child = spawn(hostPath, [], { stdio: ["pipe", "ignore", "pipe"] });
    const stderrChunks = [];
    let settled = false;

    child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

    await new Promise((resolve, reject) => {
        const startupTimer = setTimeout(() => {
            cleanup();
            resolve();
        }, Math.min(smokeTimeoutMs, 1_000));

        function cleanup() {
            if (settled) return;
            settled = true;
            clearTimeout(startupTimer);
            child.stdin.end();
            if (!child.killed) child.kill("SIGTERM");
        }

        child.on("error", (error) => {
            if (settled) return;
            cleanup();
            reject(
                new Error(`Packaged Codex code-mode host could not start: ${hostPath}`, {
                    cause: error,
                }),
            );
        });
        child.on("exit", (code, signal) => {
            if (settled) return;
            cleanup();
            reject(
                new Error(
                    `Packaged Codex code-mode host exited before startup (${code ?? signal ?? "unknown"}).${formatStderr(stderrChunks)}`,
                ),
            );
        });
    });
}

async function smokeCodexAcp(acpPath) {
    // Keep the smoke isolated from a developer's login and persisted Codex state.
    const codexHome = await fs.mkdtemp(
        path.join(os.tmpdir(), "neverwrite-codex-acp-smoke-"),
    );
    const child = spawn(acpPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CODEX_HOME: codexHome },
    });
    const stderrChunks = [];
    let settled = false;

    child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

    try {
        await new Promise((resolve, reject) => {
            const lines = readline.createInterface({ input: child.stdout });
            const timeout = setTimeout(() => {
                cleanup();
                reject(
                    new Error(
                        `Timed out waiting for packaged Codex ACP initialization.${formatStderr(stderrChunks)}`,
                    ),
                );
            }, smokeTimeoutMs);

            function cleanup() {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                lines.close();
                child.stdin.destroy();
                if (!child.killed) child.kill("SIGTERM");
            }

            child.on("error", (error) => {
                if (settled) return;
                cleanup();
                reject(
                    new Error(`Packaged Codex ACP runtime could not start: ${acpPath}`, {
                        cause: error,
                    }),
                );
            });
            child.on("exit", (code, signal) => {
                if (settled || child.killed) return;
                cleanup();
                reject(
                    new Error(
                        `Packaged Codex ACP runtime exited before initialization (${code ?? signal ?? "unknown"}).${formatStderr(stderrChunks)}`,
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
                    reject(
                        new Error(
                            `Invalid JSON response from packaged Codex ACP runtime: ${error}`,
                        ),
                    );
                    return;
                }

                if (
                    message?.id === 1 &&
                    message?.result?.agentInfo?.name === "codex-acp" &&
                    message?.result?.protocolVersion === 1
                ) {
                    cleanup();
                    resolve();
                    return;
                }

                cleanup();
                reject(
                    new Error(
                        `Unexpected Codex ACP initialization response: ${line}`,
                    ),
                );
            });

            child.stdin.write(
                `${JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "initialize",
                    params: {
                        protocolVersion: 1,
                        clientCapabilities: {},
                        clientInfo: {
                            name: "NeverWrite packaging smoke",
                            version: "0.0.0",
                        },
                    },
                })}\n`,
            );
        });
    } finally {
        if (child.exitCode === null) {
            await new Promise((resolve) => child.once("exit", resolve));
        }
        await fs.rm(codexHome, { recursive: true, force: true });
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
        }, smokeTimeoutMs);

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

assertExecutableMode(stats, sidecarPath, "sidecar");
const codexAcpPath = await findCodexAcpPath(sidecarPath);
const codeModeHostPath = await findCodeModeHostPath(sidecarPath);
await smokeCodexAcp(codexAcpPath);
await smokeCodeModeHost(codeModeHostPath);
await smokePing(sidecarPath);

console.log(`Packaged Codex ACP runtime initialized: ${codexAcpPath}`);
console.log(`Packaged Codex code-mode host started: ${codeModeHostPath}`);
console.log(`Packaged native backend sidecar responded to ping: ${sidecarPath}`);
