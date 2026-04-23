import fs from "node:fs";
import path from "node:path";

import {
    CANONICAL_RELEASE_PAGES_BASE_URL,
    normalizeReleaseVersion,
} from "./electron-release-lib.mjs";
import {
    buildPlatformValidationMatrix,
    loadTargetMetadataEntries,
    renderPlatformValidationChecklist,
    tamperFeedChecksum,
} from "./platform-validation-lib.mjs";

function parseArgs(argv) {
    const args = {
        version: null,
        tag: null,
        channel: "stable",
        metadataDir: null,
        feedsDir: null,
        outputDir: null,
        pagesBaseUrl: CANONICAL_RELEASE_PAGES_BASE_URL,
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
        if (arg === "--channel") {
            args.channel = next;
            index += 1;
            continue;
        }
        if (arg === "--feeds-dir") {
            args.feedsDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--metadata-dir") {
            args.metadataDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--output-dir") {
            args.outputDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--pages-base-url") {
            args.pagesBaseUrl = next;
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --version, --tag, --channel, --feeds-dir, --metadata-dir, --output-dir, --pages-base-url.`,
        );
    }

    if (!args.version) {
        throw new Error("Missing required argument --version <X.Y.Z-or-tag>.");
    }
    if (!args.tag) {
        throw new Error("Missing required argument --tag <vX.Y.Z>.");
    }
    if (!args.metadataDir) {
        throw new Error(
            "Missing required argument --metadata-dir <directory>.",
        );
    }
    if (!args.feedsDir) {
        throw new Error("Missing required argument --feeds-dir <directory>.");
    }
    if (!args.outputDir) {
        throw new Error("Missing required argument --output-dir <directory>.");
    }

    args.version = normalizeReleaseVersion(args.version);
    return args;
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function copyFeedFixture(sourcePath, destinationPath) {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const metadataEntries = loadTargetMetadataEntries(args.metadataDir);
    const rows = buildPlatformValidationMatrix({
        version: args.version,
        tag: args.tag,
        channel: args.channel,
        pagesBaseUrl: args.pagesBaseUrl,
        metadataEntries,
    });

    fs.mkdirSync(args.outputDir, { recursive: true });
    writeJson(path.join(args.outputDir, "validation-matrix.json"), rows);
    fs.writeFileSync(
        path.join(args.outputDir, "checklist.md"),
        renderPlatformValidationChecklist({
            rows,
            channel: args.channel,
            version: args.version,
            tag: args.tag,
        }),
        "utf8",
    );

    for (const row of rows) {
        const sourceFeedPath = path.join(args.feedsDir, row.feedRelativePath);
        const validFeedPath = path.join(
            args.outputDir,
            "fixtures",
            "valid",
            args.channel,
            row.feedTarget,
            row.metadataFileName,
        );
        copyFeedFixture(sourceFeedPath, validFeedPath);

        const invalidChecksumPath = path.join(
            args.outputDir,
            "fixtures",
            row.feedTarget,
            "invalid-checksum",
            args.channel,
            row.metadataFileName,
        );
        fs.mkdirSync(path.dirname(invalidChecksumPath), { recursive: true });
        fs.writeFileSync(
            invalidChecksumPath,
            tamperFeedChecksum(fs.readFileSync(sourceFeedPath, "utf8")),
            "utf8",
        );
    }

    console.log(`Platform validation pack written to ${args.outputDir}`);
}

main();
