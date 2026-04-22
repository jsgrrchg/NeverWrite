import { spawn } from "node:child_process";

const targets = ["main", "preload", "renderer"];

function run(command, args, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            env: { ...process.env, ...env },
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

for (const target of targets) {
    await run(
        "npx",
        ["vite", "build", "--config", "electron.vite.config.ts"],
        { NEVERWRITE_ELECTRON_TARGET: target },
    );
}
