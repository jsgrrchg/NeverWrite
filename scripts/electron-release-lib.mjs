import {
    CANONICAL_RELEASE_PAGES_BASE_URL,
    CANONICAL_RELEASE_REPO_SLUG,
    buildGitHubReleaseAssetUrl,
    buildPublicReleaseAssetName,
    normalizeAppcastChannel,
    normalizeReleaseVersion,
} from "./appcast-lib.mjs";

export {
    CANONICAL_RELEASE_PAGES_BASE_URL,
    CANONICAL_RELEASE_REPO_SLUG,
    buildGitHubReleaseAssetUrl,
    buildPublicReleaseAssetName,
    normalizeAppcastChannel,
    normalizeReleaseVersion,
};

export const ELECTRON_BUILD_TARGETS = [
    "universal-apple-darwin",
    "aarch64-pc-windows-msvc",
    "x86_64-pc-windows-msvc",
];

export const BUILD_TARGET_TO_FEED_TARGET = {
    "universal-apple-darwin": "darwin-universal",
    "aarch64-pc-windows-msvc": "windows-arm64",
    "x86_64-pc-windows-msvc": "windows-x64",
};

export function feedTargetForBuildTarget(buildTarget) {
    const feedTarget = BUILD_TARGET_TO_FEED_TARGET[buildTarget];
    if (!feedTarget) {
        throw new Error(`Unsupported build target "${buildTarget}".`);
    }
    return feedTarget;
}

export function metadataFileNameForBuildTarget(buildTarget) {
    if (buildTarget.endsWith("-apple-darwin")) {
        return "latest-mac.yml";
    }
    if (buildTarget.endsWith("-pc-windows-msvc")) {
        return "latest.yml";
    }
    throw new Error(`Unsupported build target "${buildTarget}".`);
}

export function buildElectronUpdaterAssetName(version, buildTarget) {
    const normalizedVersion = normalizeReleaseVersion(version);

    switch (buildTarget) {
        case "universal-apple-darwin":
            return `NeverWrite_${normalizedVersion}_macOS_Universal.zip`;
        case "aarch64-pc-windows-msvc":
            return `NeverWrite_${normalizedVersion}_Windows_ARM64_Setup.exe`;
        case "x86_64-pc-windows-msvc":
            return `NeverWrite_${normalizedVersion}_Windows_x64_Setup.exe`;
        default:
            throw new Error(`Unsupported build target "${buildTarget}".`);
    }
}

export function buildElectronBlockmapAssetName(version, buildTarget) {
    return `${buildElectronUpdaterAssetName(version, buildTarget)}.blockmap`;
}

export function buildFeedPublishPath(channel, buildTarget) {
    const normalizedChannel = normalizeAppcastChannel(channel);
    return `${normalizedChannel}/${feedTargetForBuildTarget(buildTarget)}/${metadataFileNameForBuildTarget(buildTarget)}`;
}

export function buildPublishedFeedUrl(baseUrl, channel, buildTarget) {
    const root = baseUrl.replace(/\/+$/, "");
    return `${root}/${buildFeedPublishPath(channel, buildTarget)}`;
}

export function describeBuildTarget(buildTarget) {
    switch (buildTarget) {
        case "universal-apple-darwin":
            return {
                platformLabel: "macOS",
                architectureLabel: "Universal",
            };
        case "aarch64-pc-windows-msvc":
            return {
                platformLabel: "Windows",
                architectureLabel: "ARM64",
            };
        case "x86_64-pc-windows-msvc":
            return {
                platformLabel: "Windows",
                architectureLabel: "x64",
            };
        default:
            throw new Error(`Unsupported build target "${buildTarget}".`);
    }
}

export function describeUpdaterArtifactKind(buildTarget) {
    if (buildTarget.endsWith("-apple-darwin")) {
        return "macOS updater archive (.zip)";
    }
    if (buildTarget.endsWith("-pc-windows-msvc")) {
        return "Windows installer (.exe)";
    }
    throw new Error(`Unsupported build target "${buildTarget}".`);
}
