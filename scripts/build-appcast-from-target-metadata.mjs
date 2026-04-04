import fs from "node:fs";
import path from "node:path";

import {
    DEFAULT_APPCAST_CHANNEL,
    createStaticAppcastManifest,
    getDefaultAppcastOutputPath,
    readNotesForVersion,
    serializeAppcastManifest,
} from "./appcast-lib.mjs";
import { buildAppcastPlatformsFromTargetMetadata } from "./platform-validation-lib.mjs";

function parseArgs(argv) {
    const args = {
        version: null,
        channel: DEFAULT_APPCAST_CHANNEL,
        pubDate: null,
        metadataDir: null,
        notesFile: null,
        output: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--version") {
            args.version = next;
            index += 1;
            continue;
        }
        if (arg === "--channel") {
            args.channel = next;
            index += 1;
            continue;
        }
        if (arg === "--pub-date") {
            args.pubDate = next;
            index += 1;
            continue;
        }
        if (arg === "--metadata-dir") {
            args.metadataDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--notes-file") {
            args.notesFile = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--output") {
            args.output = path.resolve(next);
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --version, --channel, --pub-date, --metadata-dir, --notes-file, --output.`,
        );
    }

    if (!args.version) {
        throw new Error("Missing required argument --version <X.Y.Z-or-tag>.");
    }
    if (!args.pubDate) {
        throw new Error("Missing required argument --pub-date <RFC3339>.");
    }
    if (!args.metadataDir) {
        throw new Error(
            "Missing required argument --metadata-dir <directory>.",
        );
    }

    return args;
}

function loadTargetMetadata(metadataDir) {
    const files = fs
        .readdirSync(metadataDir)
        .filter((fileName) => fileName.endsWith(".json"))
        .sort();

    if (files.length === 0) {
        throw new Error(
            `No target metadata JSON files found in ${metadataDir}.`,
        );
    }

    return files.map((fileName) =>
        JSON.parse(fs.readFileSync(path.join(metadataDir, fileName), "utf8")),
    );
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const metadataEntries = loadTargetMetadata(args.metadataDir);
    const platforms = buildAppcastPlatformsFromTargetMetadata(metadataEntries);

    const notes = readNotesForVersion(args.version, args.notesFile);
    const manifest = createStaticAppcastManifest({
        version: args.version,
        notes,
        pubDate: args.pubDate,
        platforms,
    });

    const outputPath = args.output ?? getDefaultAppcastOutputPath(args.channel);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, serializeAppcastManifest(manifest), "utf8");
    console.log(`Appcast manifest written to ${outputPath}`);
}

main();
