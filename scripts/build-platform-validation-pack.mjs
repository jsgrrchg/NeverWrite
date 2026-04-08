import fs from "node:fs";
import path from "node:path";

import {
    CANONICAL_RELEASE_PAGES_BASE_URL,
    normalizeAppcastChannel,
    normalizeReleaseVersion,
} from "./appcast-lib.mjs";
import {
    buildPlatformValidationMatrix,
    createInvalidSignatureManifest,
    loadTargetMetadataEntries,
    readJsonFile,
    renderPlatformValidationChecklist,
} from "./platform-validation-lib.mjs";

function parseArgs(argv) {
    const args = {
        version: null,
        tag: null,
        channel: "stable",
        appcast: null,
        metadataDir: null,
        outputDir: null,
        appcastBaseUrl: CANONICAL_RELEASE_PAGES_BASE_URL,
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
        if (arg === "--appcast") {
            args.appcast = path.resolve(next);
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
            args.appcastBaseUrl = next;
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --version, --tag, --channel, --appcast, --metadata-dir, --output-dir, --pages-base-url.`,
        );
    }

    if (!args.version) {
        throw new Error("Missing required argument --version <X.Y.Z-or-tag>.");
    }
    if (!args.tag) {
        throw new Error("Missing required argument --tag <vX.Y.Z>.");
    }
    if (!args.appcast) {
        throw new Error(
            "Missing required argument --appcast <path-to-latest.json>.",
        );
    }
    if (!args.metadataDir) {
        throw new Error(
            "Missing required argument --metadata-dir <directory>.",
        );
    }
    if (!args.outputDir) {
        throw new Error("Missing required argument --output-dir <directory>.");
    }

    args.version = normalizeReleaseVersion(args.version);
    args.channel = normalizeAppcastChannel(args.channel);
    return args;
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const manifest = readJsonFile(args.appcast);
    const metadataEntries = loadTargetMetadataEntries(args.metadataDir);
    const rows = buildPlatformValidationMatrix({
        version: args.version,
        tag: args.tag,
        channel: args.channel,
        appcastBaseUrl: args.appcastBaseUrl,
        manifest,
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

    const validFixturePath = path.join(
        args.outputDir,
        "fixtures",
        "valid",
        args.channel,
        "latest.json",
    );
    writeJson(validFixturePath, manifest);

    for (const row of rows) {
        const invalidSignaturePath = path.join(
            args.outputDir,
            "fixtures",
            row.appcastKey,
            "invalid-signature",
            args.channel,
            "latest.json",
        );
        writeJson(
            invalidSignaturePath,
            createInvalidSignatureManifest(manifest, row.appcastKey),
        );
    }

    console.log(`Platform validation pack written to ${args.outputDir}`);
}

main();
