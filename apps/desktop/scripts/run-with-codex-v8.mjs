import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
    CODEX_V8_ARTIFACT_PROFILE,
    resolveCodexV8CargoEnvironment,
} from "./codex-v8-artifacts.mjs";

function parseArgs(argv) {
    let targetTriple = null;
    let profile = CODEX_V8_ARTIFACT_PROFILE;
    let separatorIndex = -1;

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--") {
            separatorIndex = index;
            break;
        }
        if (arg === "--target" || arg === "--profile") {
            const value = argv[index + 1]?.trim();
            if (!value) {
                throw new Error(`${arg} requires a value`);
            }
            if (arg === "--target") {
                targetTriple = value;
            } else {
                profile = value;
            }
            index += 1;
            continue;
        }
        throw new Error(
            `Unknown argument "${arg}". Usage: --target <rust-target> [--profile <profile>] -- <command> [args...]`,
        );
    }

    const commandArgs =
        separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1);
    if (!targetTriple) {
        throw new Error("--target <rust-target> is required");
    }
    if (commandArgs.length === 0) {
        throw new Error("A command is required after --");
    }

    return {
        targetTriple,
        profile,
        command: commandArgs[0],
        commandArgs: commandArgs.slice(1),
    };
}

function run(command, args, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            env,
            shell: false,
            stdio: "inherit",
        });
        let settled = false;
        const forwardSignal = (signal) => {
            if (child.exitCode === null && child.signalCode === null) {
                child.kill(signal);
            }
        };
        const onSigint = () => forwardSignal("SIGINT");
        const onSigterm = () => forwardSignal("SIGTERM");
        const cleanup = () => {
            process.off("SIGINT", onSigint);
            process.off("SIGTERM", onSigterm);
        };

        process.on("SIGINT", onSigint);
        process.on("SIGTERM", onSigterm);
        child.once("error", (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        });
        child.once("exit", (code, signal) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ code, signal });
        });
    });
}

export async function main(argv = process.argv.slice(2)) {
    const { targetTriple, profile, command, commandArgs } = parseArgs(argv);
    const v8Environment = await resolveCodexV8CargoEnvironment({
        targetTriple,
        profile,
    });
    const result = await run(command, commandArgs, {
        ...process.env,
        ...v8Environment,
    });

    if (result.signal) {
        if (process.platform === "win32") {
            process.exitCode = 1;
            return;
        }
        process.kill(process.pid, result.signal);
        return;
    }
    process.exitCode = result.code ?? 1;
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    main().catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    });
}
