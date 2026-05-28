import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
    buildRpmPackageAssetName,
    normalizeReleaseVersion,
    rpmArchForBuildTarget,
} from "../../../scripts/electron-release-lib.mjs";

function parseArgs(argv) {
    const args = {
        stagedAssetsDir: null,
        buildTarget: null,
        version: null,
        skipInstall: false,
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

function main() {
    const args = parseArgs(process.argv.slice(2));
    assertRpmAvailable();

    const expectedAssetName = buildRpmPackageAssetName(args.version, args.buildTarget);
    const rpmPath = findRpmPackage(args.stagedAssetsDir, expectedAssetName);

    const expectedArch = rpmArchForBuildTarget(args.buildTarget);

    runCommand("rpm", ["-K", rpmPath]);
    const info = runCommand("rpm", ["-qip", rpmPath]);
    const files = runCommand("rpm", ["-qlp", rpmPath]);

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
