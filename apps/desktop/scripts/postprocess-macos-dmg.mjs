import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function parseArgs(argv) {
    const args = {
        distDir: null,
        requireNotarization: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--dist-dir") {
            args.distDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--require-notarization") {
            args.requireNotarization = true;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --dist-dir, --require-notarization.`,
        );
    }

    if (!args.distDir) {
        throw new Error("Missing required argument --dist-dir.");
    }

    return args;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: options.stdio ?? "pipe",
    });

    if (result.status === 0) {
        return result;
    }

    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
        `${command} ${args.join(" ")} failed with exit code ${result.status}.\n${output}`,
    );
}

function listFilesRecursively(rootDir) {
    const files = [];
    const queue = [rootDir];

    while (queue.length > 0) {
        const current = queue.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolutePath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(absolutePath);
            } else if (entry.isFile()) {
                files.push(absolutePath);
            }
        }
    }

    return files;
}

function findSingleFile(rootDir, matcher, description) {
    const matches = listFilesRecursively(rootDir).filter(matcher);
    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one ${description} in ${rootDir}, found ${matches.length}.`,
        );
    }
    return matches[0];
}

function findPackagedApp(distDir) {
    const candidates = [
        path.join(distDir, "mac-universal", "NeverWrite.app"),
        path.join(distDir, "mac", "NeverWrite.app"),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    throw new Error(`Could not find packaged NeverWrite.app in ${distDir}.`);
}

function removeIfExists(filePath) {
    fs.rmSync(filePath, { recursive: true, force: true });
}

function assertElectronFrameworkBinary(appPath) {
    const frameworkBinary = path.join(
        appPath,
        "Contents",
        "Frameworks",
        "Electron Framework.framework",
        "Versions",
        "A",
        "Electron Framework",
    );

    if (!fs.existsSync(frameworkBinary)) {
        throw new Error(
            `Mounted DMG is missing the Electron framework binary: ${frameworkBinary}`,
        );
    }
}

function attachDmg(dmgPath, mountPoint) {
    fs.mkdirSync(mountPoint, { recursive: true });
    run("hdiutil", [
        "attach",
        "-nobrowse",
        "-readonly",
        "-mountpoint",
        mountPoint,
        dmgPath,
    ]);
}

function detachDmg(mountPoint) {
    const result = spawnSync("hdiutil", ["detach", mountPoint], {
        encoding: "utf8",
        stdio: "pipe",
    });

    if (result.status !== 0) {
        spawnSync("hdiutil", ["detach", "-force", mountPoint], {
            encoding: "utf8",
            stdio: "pipe",
        });
    }
}

function validateMountedApp(appPath, requireNotarization) {
    assertElectronFrameworkBinary(appPath);
    run("codesign", [
        "--verify",
        "--deep",
        "--strict",
        "--verbose=2",
        appPath,
    ]);

    if (!requireNotarization) {
        return;
    }

    run("stapler", ["validate", appPath]);
    run("spctl", ["-a", "-vv", "-t", "execute", appPath]);
}

function validateDmg(dmgPath, requireNotarization) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "neverwrite-dmg-"));
    const mountPoint = path.join(tempDir, "mount");

    try {
        attachDmg(dmgPath, mountPoint);
        const appPath = path.join(mountPoint, "NeverWrite.app");
        if (!fs.existsSync(appPath)) {
            throw new Error(`Mounted DMG is missing NeverWrite.app: ${appPath}`);
        }
        validateMountedApp(appPath, requireNotarization);
    } finally {
        detachDmg(mountPoint);
        removeIfExists(tempDir);
    }
}

function rebuildDmg({ appPath, dmgPath }) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "neverwrite-dmg-"));
    const dmgRoot = path.join(tempDir, "root");
    const rebuiltDmgPath = path.join(tempDir, path.basename(dmgPath));
    const volumeName = path.basename(dmgPath, ".dmg").replace(/-/g, " ");

    try {
        fs.mkdirSync(dmgRoot, { recursive: true });
        run("ditto", [
            "--rsrc",
            "--extattr",
            "--acl",
            appPath,
            path.join(dmgRoot, "NeverWrite.app"),
        ]);
        fs.symlinkSync("/Applications", path.join(dmgRoot, "Applications"));
        run("hdiutil", [
            "create",
            "-volname",
            volumeName,
            "-srcfolder",
            dmgRoot,
            "-ov",
            "-format",
            "UDZO",
            rebuiltDmgPath,
        ]);
        fs.copyFileSync(rebuiltDmgPath, dmgPath);
    } finally {
        removeIfExists(tempDir);
    }
}

function main() {
    if (process.platform !== "darwin") {
        throw new Error("macOS DMG post-processing must run on macOS.");
    }

    const args = parseArgs(process.argv.slice(2));
    const appPath = findPackagedApp(args.distDir);
    const dmgPath = findSingleFile(
        args.distDir,
        (filePath) => filePath.endsWith(".dmg"),
        "DMG installer",
    );

    rebuildDmg({ appPath, dmgPath });
    validateDmg(dmgPath, args.requireNotarization);

    console.log(`Rebuilt and validated macOS DMG: ${dmgPath}`);
}

main();
