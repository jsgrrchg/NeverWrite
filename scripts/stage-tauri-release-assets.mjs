import fs from "node:fs";
import path from "node:path";

import { CANONICAL_RELEASE_REPO_SLUG } from "./appcast-lib.mjs";
import {
    stageReleaseAssets,
    validateStagedRuntimeResources,
} from "./release-assets-lib.mjs";

function parseArgs(argv) {
    const args = {
        manifestDir: path.resolve("apps/desktop/src-tauri"),
        bundleRoot: null,
        target: null,
        version: null,
        tag: null,
        repo: CANONICAL_RELEASE_REPO_SLUG,
        outputDir: null,
        metadataOut: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--manifest-dir") {
            args.manifestDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--bundle-root") {
            args.bundleRoot = path.resolve(next);
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
        if (arg === "--tag") {
            args.tag = next;
            index += 1;
            continue;
        }
        if (arg === "--repo") {
            args.repo = next;
            index += 1;
            continue;
        }
        if (arg === "--output-dir") {
            args.outputDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--metadata-out") {
            args.metadataOut = path.resolve(next);
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --manifest-dir, --bundle-root, --target, --version, --tag, --repo, --output-dir, --metadata-out.`,
        );
    }

    for (const key of [
        "bundleRoot",
        "target",
        "version",
        "tag",
        "outputDir",
        "metadataOut",
    ]) {
        if (!args[key]) {
            throw new Error(
                `Missing required argument --${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}.`,
            );
        }
    }

    return args;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    validateStagedRuntimeResources(args.manifestDir, args.target);

    const metadata = stageReleaseAssets({
        bundleRoot: args.bundleRoot,
        buildTarget: args.target,
        version: args.version,
        tag: args.tag,
        repoSlug: args.repo,
        outputDir: args.outputDir,
    });

    fs.mkdirSync(path.dirname(args.metadataOut), { recursive: true });
    fs.writeFileSync(
        `${args.metadataOut}`,
        `${JSON.stringify(metadata, null, 2)}\n`,
        "utf8",
    );

    console.log(
        `Staged release assets for ${args.target} in ${args.outputDir}`,
    );
    console.log(`Metadata written to ${args.metadataOut}`);
}

main();
