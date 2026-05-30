import fs from "node:fs";
import path from "node:path";

import {
    DNF_SUPPORTED_ARCHITECTURES,
    DNF_REPO_EXAMPLE_FILE_NAME,
    buildDnfRepoRoot,
    buildRpmReleaseAssetName,
    buildGitHubReleaseRpmUrl,
    buildNeverWriteRepoExample,
    buildPrimaryXml,
    buildFilelistsXml,
    buildOtherXml,
    buildRepomdXml,
    getContentHashes,
    getFileHashes,
    gzipContent,
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

function writeCompressedMetadata(repodataDir, relativePath, content) {
    const absolutePath = path.join(repodataDir, relativePath);
    fs.writeFileSync(absolutePath, gzipContent(content));

    return {
        relativePath,
        absolutePath,
        sizeBytes: fs.statSync(absolutePath).size,
        openSizeBytes: Buffer.byteLength(content, "utf8"),
        hashes: getFileHashes(absolutePath),
        openHashes: getContentHashes(content),
    };
}

function main() {
    const args = parseArgs(process.argv.slice(2));

    const dnfDir = buildDnfRepoRoot(args.pagesDir);
    fs.mkdirSync(dnfDir, { recursive: true });

    // Collect RPM packages
    const packages = [];
    for (const arch of DNF_SUPPORTED_ARCHITECTURES) {
        const assetName = buildRpmReleaseAssetName(args.version, arch);
        const source = findSingleReleaseAsset(args.releaseAssetsDir, assetName);
        const locationUrl = buildGitHubReleaseRpmUrl(
            args.repoSlug, args.tag, args.version, arch,
        );
        const sizeBytes = fs.statSync(source).size;
        const hashes = getFileHashes(source);

        packages.push({
            name: "neverwrite",
            arch,
            version: args.version,
            locationUrl,
            sourcePath: source,
            sizeBytes,
            hashes,
        });
    }

    // Build repodata
    const repodataDir = path.join(dnfDir, "repodata");
    fs.mkdirSync(repodataDir, { recursive: true });

    const metadataFiles = [
        writeCompressedMetadata(
            repodataDir,
            "primary.xml.gz",
            buildPrimaryXml({ packages }),
        ),
        writeCompressedMetadata(
            repodataDir,
            "filelists.xml.gz",
            buildFilelistsXml({ packages }),
        ),
        writeCompressedMetadata(
            repodataDir,
            "other.xml.gz",
            buildOtherXml({ packages }),
        ),
    ];

    const repomdXml = buildRepomdXml({ files: metadataFiles });
    const repomdPath = path.join(repodataDir, "repomd.xml");
    fs.writeFileSync(repomdPath, repomdXml, "utf8");

    // Write repo example file
    fs.writeFileSync(
        path.join(dnfDir, DNF_REPO_EXAMPLE_FILE_NAME),
        buildNeverWriteRepoExample(),
        "utf8",
    );

    console.log(`DNF repository built at ${dnfDir}`);
    console.log(`Packages indexed: ${packages.map((p) => `${p.name}-${p.version}.${p.arch}`).join(", ")}`);
    console.log(`repodata: repomd.xml, primary.xml.gz, filelists.xml.gz, other.xml.gz`);
}

main();
