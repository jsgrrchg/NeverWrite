import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    DNF_SUPPORTED_ARCHITECTURES,
    DNF_REPO_EXAMPLE_FILE_NAME,
    buildDnfRepoRoot,
    buildRpmReleaseAssetName,
    buildGitHubReleaseRpmLocationPrefix,
    buildNeverWriteRepoExample,
} from "./dnf-repo-lib.mjs";
import { parseGitHubRepoSlug } from "./appcast-lib.mjs";
import { normalizeReleaseVersion } from "./appcast-lib.mjs";

function parseArgs(argv) {
    const args = {
        version: null,
        tag: null,
        releaseAssetsDir: null,
        pagesDir: null,
        repoSlug: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--version") {
            args.version = next;
            index += 1;
            continue;
        }
        if (arg === "--tag") {
            args.tag = next;
            index += 1;
            continue;
        }
        if (arg === "--release-assets-dir") {
            args.releaseAssetsDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--pages-dir") {
            args.pagesDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--repo-slug") {
            args.repoSlug = next;
            index += 1;
            continue;
        }
        throw new Error(
            `Unknown argument "${arg}". Supported: --version, --tag, --release-assets-dir, --pages-dir, --repo-slug.`,
        );
    }

    if (!args.version) throw new Error("Missing --version");
    if (!args.tag) throw new Error("Missing --tag");
    if (!args.releaseAssetsDir) throw new Error("Missing --release-assets-dir");
    if (!args.pagesDir) throw new Error("Missing --pages-dir");
    if (!args.repoSlug) throw new Error("Missing --repo-slug");

    parseGitHubRepoSlug(args.repoSlug);

    return {
        ...args,
        version: normalizeReleaseVersion(args.version),
    };
}

function findSingleReleaseAsset(releaseAssetsDir, assetName) {
    const matches = [];
    for (const entry of fs.readdirSync(releaseAssetsDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name === assetName) {
            matches.push(path.join(releaseAssetsDir, entry.name));
        }
    }
    if (matches.length !== 1) {
        throw new Error(`Expected exactly one release asset named ${assetName}, found ${matches.length}.`);
    }
    return matches[0];
}

function runCommand(command, args) {
    const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        const stderr = result.stderr?.trim();
        const stdout = result.stdout?.trim();
        throw new Error(
            [
                `${command} failed with exit code ${result.status}.`,
                stderr ? `stderr:\n${stderr}` : null,
                stdout ? `stdout:\n${stdout}` : null,
            ].filter(Boolean).join("\n"),
        );
    }
    return result.stdout;
}

function assertCreaterepoAvailable() {
    try {
        runCommand("createrepo_c", ["--version"]);
    } catch (error) {
        throw new Error(
            `createrepo_c is required to build DNF metadata from real RPM headers.\n${error.message}`,
        );
    }
}

function buildCreaterepoArgs({ repositoryDir, locationPrefix }) {
    return [
        "--checksum", "sha256",
        "--general-compress-type", "gz",
        "--no-database",
        "--simple-md-filenames",
        "--location-prefix", locationPrefix,
        repositoryDir,
    ];
}

function copyGeneratedRepodata(sourceRepositoryDir, dnfDir) {
    const sourceRepodataDir = path.join(sourceRepositoryDir, "repodata");
    const targetRepodataDir = path.join(dnfDir, "repodata");
    fs.rmSync(targetRepodataDir, { recursive: true, force: true });
    fs.cpSync(sourceRepodataDir, targetRepodataDir, { recursive: true });
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    assertCreaterepoAvailable();

    const dnfDir = buildDnfRepoRoot(args.pagesDir);
    fs.rmSync(dnfDir, { recursive: true, force: true });
    fs.mkdirSync(dnfDir, { recursive: true });

    const tempRepositoryDir = fs.mkdtempSync(path.join(os.tmpdir(), "neverwrite-dnf-repo-"));
    const indexedPackages = [];

    try {
        // createrepo_c reads the RPM headers and payload file list from local packages,
        // then we prefix package locations so DNF downloads the published GitHub assets.
        const locationPrefix = buildGitHubReleaseRpmLocationPrefix(args.repoSlug, args.tag);

        for (const arch of DNF_SUPPORTED_ARCHITECTURES) {
            const assetName = buildRpmReleaseAssetName(args.version, arch);
            const source = findSingleReleaseAsset(args.releaseAssetsDir, assetName);
            fs.copyFileSync(source, path.join(tempRepositoryDir, assetName));
            indexedPackages.push(`${assetName} (${arch})`);
        }

        runCommand("createrepo_c", buildCreaterepoArgs({
            repositoryDir: tempRepositoryDir,
            locationPrefix,
        }));

        copyGeneratedRepodata(tempRepositoryDir, dnfDir);
    } finally {
        fs.rmSync(tempRepositoryDir, { recursive: true, force: true });
    }

    fs.writeFileSync(
        path.join(dnfDir, DNF_REPO_EXAMPLE_FILE_NAME),
        buildNeverWriteRepoExample(),
        "utf8",
    );

    console.log(`DNF repository built at ${dnfDir}`);
    console.log(`Packages indexed from RPM headers: ${indexedPackages.join(", ")}`);
    console.log("repodata generated by createrepo_c");
}

main();
