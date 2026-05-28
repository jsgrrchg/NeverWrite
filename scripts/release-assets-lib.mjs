import fs from "node:fs";
import path from "node:path";

import {
    BUILD_TARGET_TO_APPCAST_KEY,
    buildDebianPackageAssetName,
    buildRpmPackageAssetName,
    buildUpdaterReleaseAssetName,
    debianArchForBuildTarget,
    rpmArchForBuildTarget,
    buildGitHubReleaseAssetUrl,
    buildPublicReleaseAssetName,
    getCanonicalAppBundleName,
    getBundledUpdaterArtifactName,
    getSignatureAssetName,
    normalizeReleaseVersion,
} from "./appcast-lib.mjs";

export const PUBLIC_DOWNLOAD_VARIANTS = [
    {
        buildTarget: "universal-apple-darwin",
        platformLabel: "macOS",
        architectureLabel: "Universal",
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
    {
        buildTarget: "aarch64-unknown-linux-gnu",
        platformLabel: "Linux",
        architectureLabel: "ARM64",
    },
    {
        buildTarget: "x86_64-unknown-linux-gnu",
        platformLabel: "Linux",
        architectureLabel: "x64",
    },
    {
        buildTarget: "aarch64-unknown-linux-gnu",
        platformLabel: "Linux Fedora/RHEL",
        architectureLabel: "ARM64",
    },
    {
        buildTarget: "x86_64-unknown-linux-gnu",
        platformLabel: "Linux Fedora/RHEL",
        architectureLabel: "x64",
    },
];

export const WEB_CLIPPER_RELEASE_BROWSERS = ["chrome", "firefox"];

export function targetPlatformFamily(buildTarget) {
    if (buildTarget.endsWith("-apple-darwin")) {
        return "macos";
    }
    if (buildTarget.endsWith("-pc-windows-msvc")) {
        return "windows";
    }
    if (buildTarget.endsWith("-unknown-linux-gnu")) {
        return "linux";
    }
    throw new Error(`Unsupported build target "${buildTarget}".`);
}

export function buildWebClipperReleaseAssetName(version, browser) {
    const normalizedVersion = normalizeReleaseVersion(version);
    if (!WEB_CLIPPER_RELEASE_BROWSERS.includes(browser)) {
        throw new Error(
            `Unsupported web clipper browser "${browser}". Expected one of: ${WEB_CLIPPER_RELEASE_BROWSERS.join(", ")}.`,
        );
    }
    return `NeverWrite-Web-Clipper-v${normalizedVersion}-${browser}-mv3.zip`;
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
        ...(variant.platformLabel === "Linux Fedora/RHEL"
            ? {
                  architectureLabel: rpmArchForBuildTarget(
                      variant.buildTarget,
                  ),
                  recommendedAssetName: buildRpmPackageAssetName(
                      normalizedVersion,
                      variant.buildTarget,
                  ),
                  portableAssetName: null,
              }
            : targetPlatformFamily(variant.buildTarget) === "linux"
              ? {
                    platformLabel: "Linux Ubuntu/Debian",
                    architectureLabel: debianArchForBuildTarget(
                        variant.buildTarget,
                    ),
                    recommendedAssetName: buildDebianPackageAssetName(
                        normalizedVersion,
                        variant.buildTarget,
                    ),
                    portableAssetName: buildPublicReleaseAssetName(
                        normalizedVersion,
                        variant.buildTarget,
                    ),
                }
              : {
                    recommendedAssetName: buildPublicReleaseAssetName(
                        normalizedVersion,
                        variant.buildTarget,
                    ),
                    portableAssetName: null,
                }),
    }));
}

export function renderManualDownloadTable(version) {
    const rows = buildManualDownloadRows(version);
    const lines = [
        "| Platform | Architecture | Recommended installer | Portable option |",
        "| --- | --- | --- | --- |",
    ];

    for (const row of rows) {
        const portableAssetLabel = row.portableAssetName
            ? `\`${row.portableAssetName}\``
            : "_Not applicable_";
        lines.push(
            `| ${row.platformLabel} | ${row.architectureLabel} | \`${row.recommendedAssetName}\` | ${portableAssetLabel} |`,
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
        "For Ubuntu/Debian, use the `.deb` package directly or configure the NeverWrite APT repository for future system updates.",
        "APT repository setup:",
        "",
        "```bash",
        "sudo install -d -m 0755 /etc/apt/keyrings",
        "curl -fsSL https://jsgrrchg.github.io/NeverWrite/apt/neverwrite-archive-keyring.asc \\",
        "  | sudo tee /etc/apt/keyrings/neverwrite.asc >/dev/null",
        "sudo chmod 0644 /etc/apt/keyrings/neverwrite.asc",
        "sudo tee /etc/apt/sources.list.d/neverwrite.sources >/dev/null <<'EOF'",
        "Types: deb",
        "URIs: https://jsgrrchg.github.io/NeverWrite/apt",
        "Suites: stable",
        "Components: main",
        "Architectures: amd64 arm64",
        "Signed-By: /etc/apt/keyrings/neverwrite.asc",
        "EOF",
        "sudo apt update",
        "sudo apt install neverwrite",
        "```",
        "",
        "For Fedora/RHEL, use the `.rpm` package directly or configure the NeverWrite DNF repository for future system updates.",
        "DNF repository setup:",
        "",
        "```bash",
        "sudo dnf config-manager --add-repo https://jsgrrchg.github.io/NeverWrite/dnf/neverwrite.repo.example",
        "sudo rpm --import https://jsgrrchg.github.io/NeverWrite/dnf/neverwrite-archive-keyring.asc",
        "sudo dnf install neverwrite",
        "```",
        "",
        "For other Linux distributions or portable use, download the AppImage.",
        "",
        "Updater artifacts are also attached to the release for in-app updates.",
        "Files ending in `.app.tar.gz`, `.nsis.zip`, `.blockmap`, or `.sig` are internal updater assets and are not intended for manual installation.",
        "",
        "## Browser extensions",
        "",
        "Chrome MV3 manual install asset:",
        "",
        `\`${buildWebClipperReleaseAssetName(version, "chrome")}\``,
        "",
        "Download the zip, unzip it, open `chrome://extensions`, enable Developer mode, and choose `Load unpacked`.",
        "",
        "Firefox MV3 build artifact:",
        "",
        `\`${buildWebClipperReleaseAssetName(version, "firefox")}\``,
        "",
        "This artifact is attached for testing and release traceability. Normal Firefox Release/Beta installation requires a Mozilla-signed package through AMO or self-distribution signing.",
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
