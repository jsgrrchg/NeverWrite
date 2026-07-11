import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
    buildRpmPackageAssetName,
    normalizeReleaseVersion,
    rpmArchForBuildTarget,
} from "../../../scripts/electron-release-lib.mjs";

const REQUIRED_CODEX_RUNTIME_PATHS = [
    "/native-backend/binaries/codex-acp",
    "/native-backend/binaries/codex-code-mode-host",
];

function parseArgs(argv) {
    const args = {
        stagedAssetsDir: null,
        buildTarget: null,
        version: null,
        skipInstall: false,
        requireSignature: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;
        if (arg === "--staged-assets-dir") {
            args.stagedAssetsDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--target") {
            args.buildTarget = next;
            index += 1;
            continue;
        }
        if (arg === "--version") {
            args.version = next;
            index += 1;
            continue;
        }
        if (arg === "--skip-install") {
            args.skipInstall = true;
            continue;
        }
        if (arg === "--require-signature") {
            args.requireSignature = true;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    if (!args.stagedAssetsDir) throw new Error("Missing --staged-assets-dir");
    if (!args.buildTarget) throw new Error("Missing --target");
    if (!args.version) throw new Error("Missing --version");
    return { ...args, version: normalizeReleaseVersion(args.version) };
}

function findRpmPackage(stagedAssetsDir, assetName) {
    const matches = [];
    for (const entry of fs.readdirSync(stagedAssetsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name === assetName) {
            matches.push(path.join(stagedAssetsDir, entry.name));
        }
    }
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one RPM package named ${assetName}, found ${matches.length}.`);
    }
    return matches[0];
}

function runCommand(command, args, options = {}) {
    const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
        ...options,
    });
    if (result.status !== 0) {
        throw new Error(
            `Command failed: ${command} ${args.join(" ")}\n${result.stderr?.trim() || result.stdout?.trim()}`,
        );
    }
    return result.stdout ?? "";
}

function assertRpmAvailable() {
    runCommand("rpm", ["--version"]);
}

function assertRpmSignature(rpmPath) {
    const output = runCommand("rpm", ["-Kv", rpmPath]);
    if (!/signature/i.test(output)) {
        throw new Error(`RPM package is not signed: ${rpmPath}\n${output}`);
    }
    if (/(not ok|nokey|nottrusted|missing keys|bad)/i.test(output)) {
        throw new Error(`RPM package signature check failed: ${rpmPath}\n${output}`);
    }
}

function assertRuntimeContents(files) {
    for (const runtimePath of REQUIRED_CODEX_RUNTIME_PATHS) {
        if (!files.includes(runtimePath)) {
            throw new Error(
                `RPM package is missing required Codex runtime binary: ${runtimePath}`,
            );
        }
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    assertRpmAvailable();

    const expectedAssetName = buildRpmPackageAssetName(args.version, args.buildTarget);
    const rpmPath = findRpmPackage(args.stagedAssetsDir, expectedAssetName);

    const expectedArch = rpmArchForBuildTarget(args.buildTarget);

    runCommand("rpm", ["-K", rpmPath]);
    if (args.requireSignature) {
        assertRpmSignature(rpmPath);
    }
    const info = runCommand("rpm", ["-qip", rpmPath]);
    const files = runCommand("rpm", ["-qlp", rpmPath]);
    assertRuntimeContents(files);

    const nameMatch = info.match(/^Name\s*:\s*(\S+)/m);
    if (!nameMatch || nameMatch[1] !== "neverwrite") {
        throw new Error(`RPM package name is not "neverwrite": ${info}`);
    }

    const archMatch = info.match(/^Architecture\s*:\s*(\S+)/m);
    if (!archMatch || archMatch[1] !== expectedArch) {
        throw new Error(
            `RPM architecture mismatch: expected ${expectedArch}, got ${archMatch ? archMatch[1] : "missing"}`,
        );
    }

    console.log(`RPM package validated: ${rpmPath}`);
    console.log(`  Name: neverwrite`);
    console.log(`  Architecture: ${expectedArch}`);
    console.log(`  Version: ${args.version}`);
    console.log(`  Package info:\n${info}`);
    console.log(`  File list:\n${files}`);
}

main();
