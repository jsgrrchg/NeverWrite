import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

import {
    buildElectronBlockmapAssetName,
    buildElectronUpdaterAssetName,
    buildGitHubReleaseAssetUrl,
    buildPublicReleaseAssetName,
    feedTargetForBuildTarget,
    metadataFileNameForBuildTarget,
} from "../../../scripts/electron-release-lib.mjs";

function parseArgs(argv) {
    const args = {
        distDir: null,
        target: null,
        version: null,
        tag: null,
        repo: null,
        outputDir: null,
        metadataOut: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--dist-dir") {
            args.distDir = path.resolve(next);
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
            `Unknown argument "${arg}". Supported args: --dist-dir, --target, --version, --tag, --repo, --output-dir, --metadata-out.`,
        );
    }

    for (const key of [
        "distDir",
        "target",
        "version",
        "tag",
        "repo",
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

function stripSuffix(value, suffix) {
    if (!value.endsWith(suffix)) {
        throw new Error(`Expected "${value}" to end with "${suffix}".`);
    }
    return value.slice(0, -suffix.length);
}

function collectArtifacts(distDir, buildTarget) {
    const metadataFileName = metadataFileNameForBuildTarget(buildTarget);
    const feedPath = findSingleFile(
        distDir,
        (filePath) => path.basename(filePath) === metadataFileName,
        `${metadataFileName} feed`,
    );

    if (buildTarget.endsWith("-apple-darwin")) {
        return {
            feedPath,
            manualAssetPath: findSingleFile(
                distDir,
                (filePath) => filePath.endsWith(".dmg"),
                "DMG installer",
            ),
            updaterAssetPath: findSingleFile(
                distDir,
                (filePath) =>
                    filePath.endsWith(".zip") && !filePath.endsWith(".zip.blockmap"),
                "zip updater archive",
            ),
            blockmapPath: findSingleFile(
                distDir,
                (filePath) => filePath.endsWith(".zip.blockmap"),
                "zip blockmap",
            ),
        };
    }

    const blockmapPath = findSingleFile(
        distDir,
        (filePath) => filePath.endsWith(".exe.blockmap"),
        "Windows installer blockmap",
    );
    const installerPath = stripSuffix(blockmapPath, ".blockmap");
    if (!fs.existsSync(installerPath)) {
        throw new Error(
            `Expected Windows installer next to blockmap at ${installerPath}.`,
        );
    }

    return {
        feedPath,
        manualAssetPath: installerPath,
        updaterAssetPath: installerPath,
        blockmapPath,
    };
}

function copyIfNeeded(sourcePath, destinationPath) {
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (sourcePath === destinationPath) {
        return;
    }
    fs.copyFileSync(sourcePath, destinationPath);
}

function toPosixRelativePath(...segments) {
    return segments.join("/");
}

function fileSizeInBytes(filePath) {
    return fs.statSync(filePath).size;
}

function rewriteFeed({
    sourceFeedPath,
    buildTarget,
    version,
    tag,
    repoSlug,
    outputDir,
}) {
    const manualAssetName = buildPublicReleaseAssetName(version, buildTarget);
    const updaterAssetName = buildElectronUpdaterAssetName(version, buildTarget);
    const blockmapAssetName = buildElectronBlockmapAssetName(version, buildTarget);
    const manualAssetUrl = buildGitHubReleaseAssetUrl(
        repoSlug,
        tag,
        manualAssetName,
    );
    const updaterUrl = buildGitHubReleaseAssetUrl(repoSlug, tag, updaterAssetName);
    const blockmapUrl = buildGitHubReleaseAssetUrl(
        repoSlug,
        tag,
        blockmapAssetName,
    );
    const metadataFileName = metadataFileNameForBuildTarget(buildTarget);
    const feedTarget = feedTargetForBuildTarget(buildTarget);
    const destinationFeedPath = path.join(
        outputDir,
        "feeds",
        feedTarget,
        metadataFileName,
    );
    const document = parseDocument(fs.readFileSync(sourceFeedPath, "utf8"));
    const publishedAssetUrls = {
        manualAssetUrl,
        updaterUrl,
        blockmapUrl,
    };

    document.set("path", updaterUrl);
    const files = document.get("files");
    if (files?.items) {
        for (const item of files.items) {
            if (item?.has?.("url")) {
                item.set(
                    "url",
                    resolvePublishedAssetUrl(item.get("url"), publishedAssetUrls),
                );
            }
            if (item?.has?.("path")) {
                item.set(
                    "path",
                    resolvePublishedAssetUrl(item.get("path"), publishedAssetUrls),
                );
            }
        }
    }
    const packages = document.get("packages");
    if (packages?.items) {
        for (const item of packages.items) {
            if (item?.value?.has("path")) {
                item.value.set(
                    "path",
                    resolvePublishedAssetUrl(
                        item.value.get("path"),
                        publishedAssetUrls,
                    ),
                );
            }
        }
    }

    fs.mkdirSync(path.dirname(destinationFeedPath), { recursive: true });
    fs.writeFileSync(destinationFeedPath, document.toString(), "utf8");

    return {
        feedTarget,
        metadataFileName,
        destinationFeedPath,
        updaterUrl,
    };
}

function resolvePublishedAssetUrl(sourceValue, publishedAssetUrls) {
    if (typeof sourceValue !== "string") {
        return publishedAssetUrls.updaterUrl;
    }

    const normalizedValue = sourceValue.toLowerCase();
    if (normalizedValue.endsWith(".dmg")) {
        return publishedAssetUrls.manualAssetUrl;
    }
    if (normalizedValue.endsWith(".blockmap")) {
        return publishedAssetUrls.blockmapUrl;
    }

    return publishedAssetUrls.updaterUrl;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const artifacts = collectArtifacts(args.distDir, args.target);

    fs.mkdirSync(args.outputDir, { recursive: true });

    const manualAssetName = buildPublicReleaseAssetName(args.version, args.target);
    const updaterAssetName = buildElectronUpdaterAssetName(args.version, args.target);
    const blockmapAssetName = buildElectronBlockmapAssetName(
        args.version,
        args.target,
    );
    const feed = rewriteFeed({
        sourceFeedPath: artifacts.feedPath,
        buildTarget: args.target,
        version: args.version,
        tag: args.tag,
        repoSlug: args.repo,
        outputDir: args.outputDir,
    });

    copyIfNeeded(
        artifacts.manualAssetPath,
        path.join(args.outputDir, manualAssetName),
    );
    copyIfNeeded(
        artifacts.updaterAssetPath,
        path.join(args.outputDir, updaterAssetName),
    );
    copyIfNeeded(
        artifacts.blockmapPath,
        path.join(args.outputDir, blockmapAssetName),
    );

    const metadata = {
        tag: args.tag,
        version: args.version,
        buildTarget: args.target,
        feedTarget: feed.feedTarget,
        metadataFileName: feed.metadataFileName,
        feedRelativePath: toPosixRelativePath(
            feed.feedTarget,
            feed.metadataFileName,
        ),
        manualAssetName,
        manualAssetSizeBytes: fileSizeInBytes(
            path.join(args.outputDir, manualAssetName),
        ),
        updaterAssetName,
        updaterAssetSizeBytes: fileSizeInBytes(
            path.join(args.outputDir, updaterAssetName),
        ),
        updaterBlockmapAssetName: blockmapAssetName,
        updaterBlockmapSizeBytes: fileSizeInBytes(
            path.join(args.outputDir, blockmapAssetName),
        ),
        updaterUrl: feed.updaterUrl,
    };

    fs.mkdirSync(path.dirname(args.metadataOut), { recursive: true });
    fs.writeFileSync(
        args.metadataOut,
        `${JSON.stringify(metadata, null, 2)}\n`,
        "utf8",
    );

    console.log(
        `Staged Electron release assets for ${args.target} in ${args.outputDir}`,
    );
    console.log(`Metadata written to ${args.metadataOut}`);
}

main();
