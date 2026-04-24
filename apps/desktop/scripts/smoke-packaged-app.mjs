import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL("..", import.meta.url));
const outputRoot =
    process.env.NEVERWRITE_ELECTRON_OUTPUT_DIR?.trim() ||
    path.join(appRoot, "dist-electron");
const distArch =
    process.env.NEVERWRITE_ELECTRON_DIST_ARCH?.trim() || process.arch;

function defaultPackagedExecutableCandidates() {
    if (process.platform === "darwin") {
        const appRelativePath = path.join(
            "NeverWrite.app",
            "Contents",
            "MacOS",
            "NeverWrite",
        );
        return [
            path.join(outputRoot, `mac-${distArch}`, appRelativePath),
            path.join(outputRoot, "mac", appRelativePath),
        ];
    }

    if (process.platform === "win32") {
        return [
            path.join(outputRoot, `win-${distArch}-unpacked`, "NeverWrite.exe"),
            path.join(outputRoot, "win-unpacked", "NeverWrite.exe"),
        ];
    }

    throw new Error(
        `Packaged app smoke is not supported on ${process.platform}.`,
    );
}

async function findExecutablePath() {
    if (process.env.NEVERWRITE_PACKAGED_APP_EXECUTABLE) {
        return process.env.NEVERWRITE_PACKAGED_APP_EXECUTABLE;
    }

    const candidates = defaultPackagedExecutableCandidates();
    for (const candidate of candidates) {
        try {
            await fs.access(candidate);
            return candidate;
        } catch {
            // Try the next electron-builder output name.
        }
    }

    throw new Error(
        `Packaged app executable was not found. Tried:\n${candidates
            .map((candidate) => `- ${candidate}`)
            .join("\n")}`,
    );
}

function assertExecutableMode(stats, executablePath) {
    if (process.platform === "win32") return;
    if ((stats.mode & 0o111) === 0) {
        throw new Error(`Packaged app is not executable: ${executablePath}`);
    }
}

async function smokeLaunch(executablePath) {
    const child = spawn(executablePath, ["-e", "process.exit(0)"], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let settled = false;

    child.stdout.on("data", (chunk) => stdoutChunks.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(String(chunk)));

    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            settled = true;
            if (!child.killed) child.kill("SIGTERM");
            reject(
                new Error(
                    `Timed out waiting for packaged app smoke.${formatOutput(
                        stdoutChunks,
                        stderrChunks,
                    )}`,
                ),
            );
        }, 5000);

        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
        });

        child.on("exit", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (code === 0) {
                resolve();
                return;
            }
            reject(
                new Error(
                    `Packaged app executable failed to start with ${
                        code ?? signal ?? "unknown status"
                    }.${formatOutput(stdoutChunks, stderrChunks)}`,
                ),
            );
        });
    });
}

function formatOutput(stdoutChunks, stderrChunks) {
    const stdout = stdoutChunks.join("").trim();
    const stderr = stderrChunks.join("").trim();
    const parts = [];
    if (stdout) parts.push(`Stdout:\n${stdout}`);
    if (stderr) parts.push(`Stderr:\n${stderr}`);
    return parts.length ? `\n${parts.join("\n\n")}` : "";
}

const executablePath = await findExecutablePath();
const stats = await fs.stat(executablePath);

if (!stats.isFile()) {
    throw new Error(`Packaged app executable path is not a file: ${executablePath}`);
}

assertExecutableMode(stats, executablePath);
await smokeLaunch(executablePath);

console.log(`Packaged app executable launched successfully: ${executablePath}`);
