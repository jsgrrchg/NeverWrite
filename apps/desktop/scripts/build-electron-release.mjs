import { spawn } from "node:child_process";

function parseArgs(argv) {
    const args = {
        platform: null,
        arch: null,
        dir: false,
        publish: "never",
        unsigned: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--platform") {
            args.platform = next;
            index += 1;
            continue;
        }
        if (arg === "--arch") {
            args.arch = next;
            index += 1;
            continue;
        }
        if (arg === "--publish") {
            args.publish = next;
            index += 1;
            continue;
        }
        if (arg === "--dir") {
            args.dir = true;
            continue;
        }
        if (arg === "--unsigned") {
            args.unsigned = true;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --platform <mac|win>, --arch <universal|x64|arm64>, --publish <mode>, --dir, --unsigned.`,
        );
    }

    return args;
}

function normalizePlatform(platform) {
    if (platform) {
        return platform;
    }

    if (process.platform === "darwin") {
        return "mac";
    }
    if (process.platform === "win32") {
        return "win";
    }

    throw new Error(
        `Unsupported host platform for Electron release packaging: ${process.platform}`,
    );
}

function normalizeArch(platform, arch) {
    if (arch) {
        return arch;
    }

    if (platform === "mac") {
        return "universal";
    }

    if (process.arch === "arm64" || process.arch === "x64") {
        return process.arch;
    }

    throw new Error(
        `Unsupported host architecture for Electron release packaging: ${process.arch}`,
    );
}

function resolveRustTarget(platform, arch) {
    if (platform === "mac" && arch === "universal") {
        return "universal-apple-darwin";
    }
    if (platform === "mac" && arch === "arm64") {
        return "aarch64-apple-darwin";
    }
    if (platform === "mac" && arch === "x64") {
        return "x86_64-apple-darwin";
    }
    if (platform === "win" && arch === "arm64") {
        return "aarch64-pc-windows-msvc";
    }
    if (platform === "win" && arch === "x64") {
        return "x86_64-pc-windows-msvc";
    }

    throw new Error(
        `Unsupported Electron release target combination: platform=${platform}, arch=${arch}.`,
    );
}

function run(command, args, env = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            env: { ...process.env, ...env },
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

function buildElectronBuilderArgs(args) {
    const result = ["electron-builder", "--config", "electron-builder.config.mjs"];

    if (args.dir) {
        result.push("--dir");
    }
    if (args.publish) {
        result.push("--publish", args.publish);
    }
    if (args.platform === "mac") {
        result.push("--mac");
    } else if (args.platform === "win") {
        result.push("--win");
    }
    if (args.arch === "x64") {
        result.push("--x64");
    } else if (args.arch === "arm64") {
        result.push("--arm64");
    } else if (args.arch === "universal") {
        result.push("--universal");
    }

    return result;
}

const args = parseArgs(process.argv.slice(2));
const normalizedPlatform = normalizePlatform(args.platform);
const normalizedArch = normalizeArch(normalizedPlatform, args.arch);
const rustTarget = resolveRustTarget(normalizedPlatform, normalizedArch);
const builderEnv = {};

if (args.unsigned) {
    builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
}

await run("npm", ["run", "electron:build"]);
await run("npm", [
    "run",
    "electron:sidecar:stage",
    "--",
    "--target",
    rustTarget,
]);
await run(
    "npx",
    buildElectronBuilderArgs({
        ...args,
        platform: normalizedPlatform,
        arch: normalizedArch,
    }),
    builderEnv,
);
