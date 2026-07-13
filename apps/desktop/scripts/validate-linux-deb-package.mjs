import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
    buildDebianPackageAssetName,
    debianArchForBuildTarget,
} from "../../../scripts/electron-release-lib.mjs";

const LARGE_COMMAND_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;
const REQUIRED_CODEX_RUNTIME_PATHS = [
    "/native-backend/binaries/codex-acp",
    "/native-backend/binaries/codex-code-mode-host",
];

function parseArgs(argv) {
    const args = {
        stagedAssetsDir: null,
        target: null,
        version: null,
        install: false,
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
            args.target = next;
            index += 1;
            continue;
        }
        if (arg === "--version") {
            args.version = next;
            index += 1;
            continue;
        }
        if (arg === "--install") {
            args.install = true;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --staged-assets-dir, --target, --version, --install.`,
        );
    }

    for (const key of ["stagedAssetsDir", "target", "version"]) {
        if (!args[key]) {
            throw new Error(
                `Missing required argument --${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}.`,
            );
        }
    }

    return args;
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        maxBuffer: options.maxBuffer,
        stdio: options.capture ? "pipe" : "inherit",
    });

    if (options.capture && options.echo !== false) {
        process.stdout.write(result.stdout ?? "");
        process.stderr.write(result.stderr ?? "");
    }

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`);
    }

    return result.stdout ?? "";
}

function assertMatches(contents, pattern, description) {
    if (!pattern.test(contents)) {
        throw new Error(`Debian package validation failed: ${description}.`);
    }
}

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function validatePackageMetadata({ debPath, debArch, version }) {
    const info = run("dpkg-deb", ["--info", debPath], { capture: true });
    const contents = run("dpkg-deb", ["--contents", debPath], {
        capture: true,
        echo: false,
        // Large Electron packages can contain enough files to exceed Node's
        // default spawnSync output buffer while listing package contents.
        maxBuffer: LARGE_COMMAND_OUTPUT_MAX_BUFFER,
    });

    assertMatches(info, /^[\t ]*Package: neverwrite$/m, "package name is not neverwrite");
    assertMatches(
        info,
        new RegExp(`^[\\t ]*Version: ${escapeRegex(version)}$`, "m"),
        `package version is not ${version}`,
    );
    assertMatches(
        info,
        new RegExp(`^[\\t ]*Architecture: ${escapeRegex(debArch)}$`, "m"),
        `package architecture is not ${debArch}`,
    );
    assertMatches(
        contents,
        /\/usr\/bin\/neverwrite$|\/opt\/NeverWrite\/neverwrite$/m,
        "launcher or app binary is missing",
    );
    assertMatches(
        contents,
        /\/usr\/share\/applications\/.*\.desktop$/m,
        "desktop entry is missing",
    );
    assertMatches(
        contents,
        /\/usr\/share\/icons\/|\/usr\/share\/pixmaps\//m,
        "desktop icon is missing",
    );
    for (const runtimePath of REQUIRED_CODEX_RUNTIME_PATHS) {
        assertMatches(
            contents,
            new RegExp(
                `^-rwx\\S*\\s+.*${escapeRegex(runtimePath)}$`,
                "m",
            ),
            `Codex runtime binary is missing or not executable: ${runtimePath}`,
        );
    }
}

function queryInstalledPackage() {
    const query = run(
        "dpkg-query",
        [
            "-W",
            "-f=${binary:Package}\t${Architecture}\t${Version}\n",
            "neverwrite",
        ],
        { capture: true },
    ).trim();
    const [packageName, architecture, version] = query.split(/\t/);
    return { packageName, architecture, version };
}

function validateInstalledPackage({ debPath, debArch, version }) {
    const nativeArch = run("dpkg", ["--print-architecture"], { capture: true }).trim();
    if (nativeArch !== debArch) {
        console.log(
            `Skipping install smoke for ${debArch} package on ${nativeArch} runner.`,
        );
        return;
    }

    let installed = false;

    try {
        run("sudo", ["apt-get", "install", "-y", debPath]);
        installed = true;

        const installedPackage = queryInstalledPackage();
        if (
            installedPackage.packageName !== "neverwrite" &&
            installedPackage.packageName !== `neverwrite:${debArch}`
        ) {
            throw new Error(
                `Expected package neverwrite:${debArch}, received ${installedPackage.packageName}.`,
            );
        }
        if (installedPackage.architecture !== debArch) {
            throw new Error(
                `Expected installed architecture ${debArch}, received ${installedPackage.architecture}.`,
            );
        }
        if (installedPackage.version !== version) {
            throw new Error(
                `Expected installed version ${version}, received ${installedPackage.version}.`,
            );
        }

        // This verifies packaging registered the launcher without executing
        // foreign-architecture binaries on amd64 runners.
        run("sh", ["-lc", "command -v neverwrite"]);
    } finally {
        if (installed) {
            run("sudo", ["apt-get", "remove", "-y", "neverwrite"]);
        }
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const debArch = debianArchForBuildTarget(args.target);
    const debAssetName = buildDebianPackageAssetName(args.version, args.target);
    const debPath = path.join(args.stagedAssetsDir, debAssetName);

    if (!fs.existsSync(debPath)) {
        throw new Error(`Missing staged Debian package: ${debPath}`);
    }

    validatePackageMetadata({
        debPath,
        debArch,
        version: args.version,
    });

    if (args.install) {
        validateInstalledPackage({
            debPath,
            debArch,
            version: args.version,
        });
    }

    console.log(`Validated Debian package ${debAssetName}.`);
}

main();
