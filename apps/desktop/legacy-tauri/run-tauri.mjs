import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");
const tauriBin = path.join(
    appRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "tauri.cmd" : "tauri",
);

if (!existsSync(tauriBin)) {
    console.error(`Tauri CLI not found at ${tauriBin}`);
    process.exit(1);
}

const args = process.argv.slice(2);
const hasExplicitConfig = args.includes("--config") || args.includes("-c");
const separatorIndex = args.indexOf("--");
const commandArgs =
    separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
const devIndex = commandArgs.findIndex((arg) => arg === "dev");

const finalArgs =
    devIndex >= 0 && !hasExplicitConfig
        ? [
              ...args.slice(0, devIndex + 1),
              "--config",
              "src-tauri/tauri.dev.conf.json",
              ...args.slice(devIndex + 1),
          ]
        : args;

const child = spawn(tauriBin, finalArgs, {
    cwd: appRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
});

child.on("exit", (code, signal) => {
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exit(code ?? 0);
});
