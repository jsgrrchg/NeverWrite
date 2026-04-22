import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const rendererUrl = "http://127.0.0.1:5174";

function run(command, args, options = {}) {
    const child = spawn(command, args, {
        cwd: rootDir,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: options.stdio ?? "inherit",
        shell: process.platform === "win32",
    });
    return child;
}

function runOnce(command, args, env = {}) {
    return new Promise((resolve, reject) => {
        const child = run(command, args, { env });
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

function waitForRenderer() {
    return new Promise((resolve, reject) => {
        const startedAt = Date.now();
        const timer = setInterval(() => {
            const request = http.get(rendererUrl, (response) => {
                response.resume();
                clearInterval(timer);
                resolve();
            });
            request.on("error", () => {
                if (Date.now() - startedAt > 30000) {
                    clearInterval(timer);
                    reject(new Error("Timed out waiting for Vite dev server."));
                }
            });
            request.setTimeout(1000, () => request.destroy());
        }, 250);
    });
}

await runOnce(
    "npx",
    ["vite", "build", "--config", "electron.vite.config.ts"],
    { NEVERWRITE_ELECTRON_TARGET: "main" },
);
await runOnce(
    "npx",
    ["vite", "build", "--config", "electron.vite.config.ts"],
    { NEVERWRITE_ELECTRON_TARGET: "preload" },
);

const vite = run(
    "npx",
    ["vite", "--config", "electron.vite.config.ts", "--host", "127.0.0.1"],
    { env: { NEVERWRITE_ELECTRON_TARGET: "renderer" } },
);

await waitForRenderer();

const electronBin =
    process.platform === "win32"
        ? path.join(rootDir, "node_modules", ".bin", "electron.cmd")
        : path.join(rootDir, "node_modules", ".bin", "electron");

const electron = run(electronBin, ["."], {
    env: {
        ELECTRON_RENDERER_URL: rendererUrl,
    },
});

function shutdown() {
    vite.kill();
    electron.kill();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

electron.on("exit", (code) => {
    vite.kill();
    process.exit(code ?? 0);
});
