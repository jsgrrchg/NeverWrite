import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isWindows } from "./common.mjs";
import {
    signalExitCode,
    terminateChild,
    FORCED_EXIT_TIMEOUT_MS,
} from "./graceful-shutdown.mjs";


const rootDir = fileURLToPath(new URL("..", import.meta.url));
const rendererUrl = "http://127.0.0.1:5174";

let vite = null;
let electron = null;
let shuttingDown = false;

function run(command, args, options = {}) {
    const child = spawn(command, args, {
        cwd: rootDir,
        env: { ...process.env, ...(options.env ?? {}) },
        stdio: options.stdio ?? "inherit",
        detached: !isWindows && options.detached === true,
        shell: isWindows,
    });
    child.__neverwriteDetached = options.detached === true;
    return child;
}

function shutdown(exitCode = 0) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;
    process.exitCode = exitCode;
    terminateChild(electron, { pidOnly: true });
    terminateChild(vite, { pidOnly: false });

    setTimeout(() => {
        process.exit(exitCode);
    }, FORCED_EXIT_TIMEOUT_MS).unref();
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
        timer.unref();
    });
}
process.on("SIGINT", () => shutdown(signalExitCode("SIGINT")));
process.on("SIGTERM", () => shutdown(signalExitCode("SIGTERM")));
process.once("exit", () => {
    terminateChild(electron, { pidOnly: true });
    terminateChild(vite, { pidOnly: false });
});
process.on("uncaughtException", (error) => {
    console.error(error);
    shutdown(1);
});
process.on("unhandledRejection", (error) => {
    console.error(error);
    shutdown(1);
});

async function main() {
    await runOnce(
        "cargo",
        ["build", "-p", "neverwrite-native-backend"],
    );

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

    vite = run(
        "npx",
        ["vite", "--config", "electron.vite.config.ts", "--host", "127.0.0.1"],
        {
            detached: true,
            env: { NEVERWRITE_ELECTRON_TARGET: "renderer" },
            stdio: ["ignore", "inherit", "inherit"],
        },
    );

    vite.on("exit", (code) => {
        if (shuttingDown) return;
        shutdown(code ?? 1);
    });
    vite.on("error", () => shutdown(1));

    await waitForRenderer();

    const electronBin = isWindows
        ? path.join(rootDir, "node_modules", ".bin", "electron.cmd")
        : path.join(rootDir, "node_modules", ".bin", "electron");

    electron = run(electronBin, ["."], {
        detached: true,
        env: {
            ELECTRON_RENDERER_URL: rendererUrl,
        },
        stdio: ["ignore", "inherit", "inherit"],
    });

    electron.on("error", () => shutdown(1));
    electron.on("exit", (code) => {
        shutdown(code ?? 0);
    });
}

void main().catch((error) => {
    console.error(error);
    shutdown(1);
});
