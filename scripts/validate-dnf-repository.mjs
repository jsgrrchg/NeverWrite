import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
    DNF_PUBLIC_KEY_FILE_NAME,
    DNF_REPO_EXAMPLE_FILE_NAME,
    DNF_SUPPORTED_ARCHITECTURES,
    DNF_PACKAGE_NAME,
    buildRpmReleaseAssetName,
} from "./dnf-repo-lib.mjs";
import { normalizeReleaseVersion } from "./appcast-lib.mjs";

function parseArgs(argv) {
    const args = { dnfDir: null, version: null, skipSignatureCheck: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;
        if (arg === "--dnf-dir") { args.dnfDir = path.resolve(next); index += 1; continue; }
        if (arg === "--version") { args.version = next; index += 1; continue; }
        if (arg === "--skip-signature-check") { args.skipSignatureCheck = true; continue; }
        throw new Error(`Unknown argument "${arg}".`);
    }
    if (!args.dnfDir) throw new Error("Missing --dnf-dir");
    return { ...args, version: args.version ? normalizeReleaseVersion(args.version) : null };
}

function assertFileExists(filePath, label) {
    if (!fs.existsSync(filePath)) throw new Error(`Missing ${label}: ${filePath}`);
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

    return files.sort();
}

function validateNoPackageBinaries(dnfDir) {
    const packageBinary = listFilesRecursively(dnfDir).find((filePath) =>
        filePath.endsWith(".rpm") || filePath.endsWith(".deb"),
    );

    if (packageBinary) {
        throw new Error(
            `DNF repository must keep package binaries on GitHub Releases, not in repository metadata: ${packageBinary}`,
        );
    }
}

function validateRepomd(dnfDir) {
    const repomdPath = path.join(dnfDir, "repodata", "repomd.xml");
    assertFileExists(repomdPath, "repomd.xml");

    const content = fs.readFileSync(repomdPath, "utf8");
    if (!content.includes('<repomd xmlns="http://linux.duke.edu/metadata/repo"')) {
        throw new Error("repomd.xml has invalid root element");
    }
    if (!content.includes('<data type="primary">')) {
        throw new Error("repomd.xml missing primary data reference");
    }

    const locationMatch = content.match(/<location href="repodata\/([^"]+)"/);
    if (!locationMatch) {
        throw new Error("repomd.xml missing location href");
    }

    const checksumMatch = content.match(/<checksum type="sha256">([a-f0-9]{64})<\/checksum>/);
    if (!checksumMatch) {
        throw new Error("repomd.xml missing SHA256 checksum");
    }

    return content;
}

function validateRepomdSignature(dnfDir) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "neverwrite-dnf-gpg-"));
    const keyringPath = path.join(tempDir, "neverwrite-keyring.gpg");
    const publicKeyPath = path.join(dnfDir, DNF_PUBLIC_KEY_FILE_NAME);
    const repomdPath = path.join(dnfDir, "repodata", "repomd.xml");
    const repomdAscPath = path.join(dnfDir, "repodata", "repomd.xml.asc");

    try {
        childProcess.spawnSync("gpg", ["--batch", "--yes", "--no-default-keyring", "--keyring", keyringPath, "--import", publicKeyPath], { encoding: "utf8" });
        const verifyResult = childProcess.spawnSync("gpg", ["--batch", "--no-default-keyring", "--keyring", keyringPath, "--verify", repomdAscPath, repomdPath], { encoding: "utf8" });
        if (verifyResult.status !== 0) {
            throw new Error(`GPG signature verification failed:\n${verifyResult.stderr}`);
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function validatePrimaryXml(dnfDir, version) {
    const primaryGzPath = path.join(dnfDir, "repodata", "primary.xml.gz");
    assertFileExists(primaryGzPath, "primary.xml.gz");

    const inflated = zlib.gunzipSync(fs.readFileSync(primaryGzPath));
    const content = inflated.toString("utf8");

    if (!content.includes('<package type="rpm">')) {
        throw new Error("primary.xml missing package entries");
    }
    if (!content.includes(`<name>${DNF_PACKAGE_NAME}</name>`)) {
        throw new Error(`primary.xml missing package name "${DNF_PACKAGE_NAME}"`);
    }
    if (!content.includes("<rpm:provides>")) {
        throw new Error("primary.xml missing RPM provides metadata from package headers");
    }
    if (!content.includes("<rpm:requires>")) {
        throw new Error("primary.xml missing RPM requires metadata from package headers");
    }
    if (!content.includes("<rpm:header-range ")) {
        throw new Error("primary.xml missing RPM header range metadata");
    }

    const packageCount = (content.match(/<package type="rpm">/g) ?? []).length;
    if (packageCount !== DNF_SUPPORTED_ARCHITECTURES.length) {
        throw new Error(
            `primary.xml must contain exactly ${DNF_SUPPORTED_ARCHITECTURES.length} RPM packages, found ${packageCount}.`,
        );
    }

    for (const arch of DNF_SUPPORTED_ARCHITECTURES) {
        if (!content.includes(`<arch>${arch}</arch>`)) {
            throw new Error(`primary.xml missing ${arch} package metadata`);
        }
        if (version && !content.includes(`<version epoch="0" ver="${version}"`)) {
            throw new Error(`primary.xml missing version ${version}`);
        }

        const expectedAssetName = version
            ? buildRpmReleaseAssetName(version, arch)
            : null;
        const assetPattern = expectedAssetName
            ? escapeRegExp(expectedAssetName)
            : "[^/]+\\.rpm";
        const locationMatch = content.match(
            new RegExp(
                `<location href="(https?:\\/\\/[^"]*\\/releases\\/download\\/[^"]*\\/${assetPattern})"`,
            ),
        );
        if (!locationMatch) {
            throw new Error(
                expectedAssetName
                    ? `primary.xml missing GitHub Release location for ${expectedAssetName}`
                    : "primary.xml missing GitHub Release location href",
            );
        }
        try {
            new URL(locationMatch[1]);
        } catch {
            throw new Error(`primary.xml has invalid location URL: ${locationMatch[1]}`);
        }
    }
}

function validateFilelistsXml(dnfDir) {
    const filelistsGzPath = path.join(dnfDir, "repodata", "filelists.xml.gz");
    assertFileExists(filelistsGzPath, "filelists.xml.gz");

    const inflated = zlib.gunzipSync(fs.readFileSync(filelistsGzPath));
    const content = inflated.toString("utf8");
    if (!content.includes(`name="${DNF_PACKAGE_NAME}"`)) {
        throw new Error(`filelists.xml missing package name "${DNF_PACKAGE_NAME}"`);
    }
    if (!/<file(?:\s|>)/.test(content)) {
        throw new Error("filelists.xml missing installed file entries from RPM payload");
    }
}

function validateRepoExample(dnfDir) {
    const examplePath = path.join(dnfDir, DNF_REPO_EXAMPLE_FILE_NAME);
    assertFileExists(examplePath, "repo example file");
    const content = fs.readFileSync(examplePath, "utf8");
    if (!content.includes("[neverwrite]")) throw new Error("repo example missing [neverwrite] header");
    if (!content.includes("gpgcheck=1")) throw new Error("repo example missing gpgcheck=1");
    if (!content.includes("repo_gpgcheck=1")) throw new Error("repo example missing repo_gpgcheck=1");
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    assertFileExists(args.dnfDir, "DNF repository root");
    assertFileExists(path.join(args.dnfDir, "repodata"), "repodata directory");
    assertFileExists(path.join(args.dnfDir, "repodata", "repomd.xml"), "repomd.xml");
    assertFileExists(path.join(args.dnfDir, "repodata", "repomd.xml.asc"), "repomd.xml.asc");

    validateNoPackageBinaries(args.dnfDir);
    validateRepoExample(args.dnfDir);
    validateRepomd(args.dnfDir);
    validatePrimaryXml(args.dnfDir, args.version);
    validateFilelistsXml(args.dnfDir);

    if (!args.skipSignatureCheck) {
        validateRepomdSignature(args.dnfDir);
    }

    console.log(`DNF repository is valid${args.version ? ` for version ${args.version}` : ""}.`);
}

main();
