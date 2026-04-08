import fs from "node:fs";
import path from "node:path";

import {
    BUILD_TARGET_TO_APPCAST_KEY,
    buildUpdaterReleaseAssetName,
    buildGitHubReleaseAssetUrl,
    buildPublicReleaseAssetName,
    getCanonicalAppBundleName,
    getBundledUpdaterArtifactName,
    getSignatureAssetName,
    normalizeReleaseVersion,
} from "./appcast-lib.mjs";

export const PUBLIC_DOWNLOAD_VARIANTS = [
    {
        buildTarget: "aarch64-apple-darwin",
        platformLabel: "macOS",
        architectureLabel: "Apple Silicon",
    },
    {
        buildTarget: "x86_64-apple-darwin",
        platformLabel: "macOS",
        architectureLabel: "Intel",
    },
    {
        buildTarget: "aarch64-pc-windows-msvc",
        platformLabel: "Windows",
        architectureLabel: "ARM64",
    },
    {
        buildTarget: "x86_64-pc-windows-msvc",
        platformLabel: "Windows",
        architectureLabel: "x64",
    },
];

export function targetPlatformFamily(buildTarget) {
    if (buildTarget.endsWith("-apple-darwin")) {
        return "macos";
    }
    if (buildTarget.endsWith("-pc-windows-msvc")) {
        return "windows";
    }
    throw new Error(`Unsupported build target "${buildTarget}".`);
}

export function runtimeBinaryFileName(buildTarget, baseName) {
    return targetPlatformFamily(buildTarget) === "windows"
        ? `${baseName}.exe`
        : baseName;
}

export function requiredStagedResourcePaths(buildTarget) {
    return [
        path.join("binaries", runtimeBinaryFileName(buildTarget, "codex-acp")),
        path.join(
            "embedded",
            "node",
            "bin",
            runtimeBinaryFileName(buildTarget, "node"),
        ),
        path.join("embedded", "claude-agent-acp", "dist", "index.js"),
    ];
}

export function validateStagedRuntimeResources(manifestDir, buildTarget) {
    const missing = requiredStagedResourcePaths(buildTarget).filter(
        (relativePath) => !fs.existsSync(path.join(manifestDir, relativePath)),
    );

    if (missing.length > 0) {
        throw new Error(
            `Missing staged runtime resources for ${buildTarget}: ${missing.join(", ")}.`,
        );
    }
}

function listFilesRecursively(rootDir) {
    const files = [];
    const queue = [rootDir];

    while (queue.length > 0) {
        const current = queue.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
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

function findSingleDirectory(rootDir, matcher, description) {
    const matches = fs
        .readdirSync(rootDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && matcher(entry.name))
        .map((entry) => path.join(rootDir, entry.name));

    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one ${description} in ${rootDir}, found ${matches.length}.`,
        );
    }

    return matches[0];
}

export function collectBundleArtifacts(bundleRoot, buildTarget) {
    const platformFamily = targetPlatformFamily(buildTarget);

    if (platformFamily === "macos") {
        const dmgPath = findSingleFile(
            path.join(bundleRoot, "dmg"),
            (filePath) => filePath.endsWith(".dmg"),
            "DMG bundle",
        );
        const updaterPath = findSingleFile(
            path.join(bundleRoot, "macos"),
            (filePath) => filePath.endsWith(".app.tar.gz"),
            "macOS updater archive",
        );
        const appBundlePath = findSingleDirectory(
            path.join(bundleRoot, "macos"),
            (name) => name.endsWith(".app"),
            "macOS app bundle",
        );

        return {
            manualAssetPath: dmgPath,
            updaterAssetPath: updaterPath,
            updaterSignaturePath: `${updaterPath}.sig`,
            appBundlePath,
        };
    }

    const manualAssetPath = findSingleFile(
        path.join(bundleRoot, "nsis"),
        (filePath) => filePath.endsWith(".exe"),
        "NSIS installer",
    );
    const updaterAssetPath = findSingleFile(
        path.join(bundleRoot, "nsis"),
        (filePath) => filePath.endsWith(".nsis.zip"),
        "NSIS updater archive",
    );

    return {
        manualAssetPath,
        updaterAssetPath,
        updaterSignaturePath: `${updaterAssetPath}.sig`,
        appBundlePath: null,
    };
}

export function validateMacosBundleResources(appBundlePath, buildTarget) {
    if (!appBundlePath) {
        return;
    }

    const resourcesDir = path.join(appBundlePath, "Contents", "Resources");
    const missing = requiredStagedResourcePaths(buildTarget).filter(
        (relativePath) => !fs.existsSync(path.join(resourcesDir, relativePath)),
    );

    if (missing.length > 0) {
        throw new Error(
            `Missing bundled resources inside ${appBundlePath}: ${missing.join(", ")}.`,
        );
    }
}

function validateCanonicalBundleNaming(artifacts, buildTarget) {
    const expectedUpdaterAssetName = getBundledUpdaterArtifactName(buildTarget);
    const actualUpdaterAssetName = path.basename(artifacts.updaterAssetPath);

    if (actualUpdaterAssetName !== expectedUpdaterAssetName) {
        throw new Error(
            `Unexpected updater asset name for ${buildTarget}: expected ${expectedUpdaterAssetName}, received ${actualUpdaterAssetName}.`,
        );
    }

    const expectedUpdaterSignatureName = getSignatureAssetName(
        expectedUpdaterAssetName,
    );
    const actualUpdaterSignatureName = path.basename(
        artifacts.updaterSignaturePath,
    );
    if (actualUpdaterSignatureName !== expectedUpdaterSignatureName) {
        throw new Error(
            `Unexpected updater signature asset name for ${buildTarget}: expected ${expectedUpdaterSignatureName}, received ${actualUpdaterSignatureName}.`,
        );
    }

    if (artifacts.appBundlePath) {
        const expectedAppBundleName = getCanonicalAppBundleName();
        const actualAppBundleName = path.basename(artifacts.appBundlePath);
        if (actualAppBundleName !== expectedAppBundleName) {
            throw new Error(
                `Unexpected app bundle name for ${buildTarget}: expected ${expectedAppBundleName}, received ${actualAppBundleName}.`,
            );
        }
    }
}

export function buildManualDownloadRows(version) {
    const normalizedVersion = normalizeReleaseVersion(version);
    return PUBLIC_DOWNLOAD_VARIANTS.map((variant) => ({
        ...variant,
        assetName: buildPublicReleaseAssetName(
            normalizedVersion,
            variant.buildTarget,
        ),
    }));
}

export function renderManualDownloadTable(version) {
    const rows = buildManualDownloadRows(version);
    const lines = [
        "| Platform | Architecture | Manual installer asset |",
        "| --- | --- | --- |",
    ];

    for (const row of rows) {
        lines.push(
            `| ${row.platformLabel} | ${row.architectureLabel} | \`${row.assetName}\` |`,
        );
    }

    return lines.join("\n");
}

export function buildReleaseBody(version, releaseNotes) {
    const notes = typeof releaseNotes === "string" ? releaseNotes.trim() : "";

    return [
        "## Manual installers",
        "",
        "Choose the installer that matches your machine:",
        "",
        renderManualDownloadTable(version),
        "",
        "Updater artifacts are also attached to the release for in-app updates.",
        "Files ending in `.app.tar.gz`, `.nsis.zip`, or `.sig` are internal updater assets and are not intended for manual installation.",
        "",
        "## Release notes",
        "",
        notes || "_No release notes were published for this version._",
        "",
    ].join("\n");
}

export function stageReleaseAssets({
    bundleRoot,
    buildTarget,
    version,
    tag,
    repoSlug,
    outputDir,
}) {
    const artifacts = collectBundleArtifacts(bundleRoot, buildTarget);

    if (!fs.existsSync(artifacts.updaterSignaturePath)) {
        throw new Error(
            `Missing updater signature for ${buildTarget}: ${artifacts.updaterSignaturePath}`,
        );
    }

    if (targetPlatformFamily(buildTarget) === "macos") {
        validateMacosBundleResources(artifacts.appBundlePath, buildTarget);
    }
    validateCanonicalBundleNaming(artifacts, buildTarget);

    fs.mkdirSync(outputDir, { recursive: true });

    const manualAssetName = buildPublicReleaseAssetName(version, buildTarget);
    const updaterAssetName = buildUpdaterReleaseAssetName(version, buildTarget);
    const updaterSignatureAssetName = getSignatureAssetName(updaterAssetName);

    const stagedManualAssetPath = path.join(outputDir, manualAssetName);
    const stagedUpdaterAssetPath = path.join(outputDir, updaterAssetName);
    const stagedUpdaterSignaturePath = path.join(
        outputDir,
        updaterSignatureAssetName,
    );

    fs.copyFileSync(artifacts.manualAssetPath, stagedManualAssetPath);
    fs.copyFileSync(artifacts.updaterAssetPath, stagedUpdaterAssetPath);
    fs.copyFileSync(artifacts.updaterSignaturePath, stagedUpdaterSignaturePath);

    return {
        tag,
        version,
        buildTarget,
        appcastKey: BUILD_TARGET_TO_APPCAST_KEY[buildTarget],
        manualAssetName,
        updaterAssetName,
        updaterSignatureAssetName,
        updaterUrl: buildGitHubReleaseAssetUrl(repoSlug, tag, updaterAssetName),
        updaterSignature: fs
            .readFileSync(artifacts.updaterSignaturePath, "utf8")
            .trim(),
    };
}
