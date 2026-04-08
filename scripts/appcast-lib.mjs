import fs from "node:fs";
import path from "node:path";

import {
    CHANGELOG_PATH,
    REPO_ROOT,
    getChangelogEntry,
    normalizeReleaseTag,
    readFile,
} from "./release-metadata-lib.mjs";

export const DEFAULT_APPCAST_CHANNEL = "stable";
export const APPCAST_CHANNELS = ["stable", "beta", "nightly"];
export const PUBLIC_PRODUCT_NAME = "NeverWrite";
export const CANONICAL_RELEASE_REPO_SLUG = "jsgrrchg/NeverWrite";
export const V1_BUILD_TARGETS = [
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-pc-windows-msvc",
    "x86_64-pc-windows-msvc",
];
export const V1_APPCAST_KEYS = [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-aarch64",
    "windows-x86_64",
];
export const BUILD_TARGET_TO_APPCAST_KEY = {
    "aarch64-apple-darwin": "darwin-aarch64",
    "x86_64-apple-darwin": "darwin-x86_64",
    "aarch64-pc-windows-msvc": "windows-aarch64",
    "x86_64-pc-windows-msvc": "windows-x86_64",
};
export const APPCAST_OUTPUT_ROOT = path.join(REPO_ROOT, "dist", "appcast");

export function normalizeReleaseVersion(value) {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error("Release version must be a non-empty string.");
    }
    const normalized = value.startsWith("v")
        ? normalizeReleaseTag(value)
        : value;
    if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
        throw new Error(
            `Invalid release version "${value}". Expected X.Y.Z or tag vX.Y.Z.`,
        );
    }
    return normalized;
}

export function normalizeAppcastChannel(channel) {
    if (typeof channel !== "string" || !channel.trim()) {
        throw new Error(
            `Unsupported appcast channel "${channel}". Supported channels: ${APPCAST_CHANNELS.join(", ")}.`,
        );
    }
    const normalized = channel.trim().toLowerCase();
    if (!APPCAST_CHANNELS.includes(normalized)) {
        throw new Error(
            `Unsupported appcast channel "${channel}". Supported channels: ${APPCAST_CHANNELS.join(", ")}.`,
        );
    }
    return normalized;
}

export function getAppcastPublishPath(channel) {
    return `${normalizeAppcastChannel(channel)}/latest.json`;
}

export function getDefaultAppcastOutputPath(channel) {
    return path.join(APPCAST_OUTPUT_ROOT, getAppcastPublishPath(channel));
}

export function parseGitHubRepoSlug(repoSlug) {
    const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repoSlug);
    if (!match) {
        throw new Error(
            `Invalid GitHub repository slug "${repoSlug}". Expected owner/repo.`,
        );
    }

    return { owner: match[1], repo: match[2] };
}

export function buildGitHubPagesBaseUrl(repoSlug) {
    const { owner, repo } = parseGitHubRepoSlug(repoSlug);
    return `https://${owner}.github.io/${repo}`;
}

export const CANONICAL_RELEASE_PAGES_BASE_URL = buildGitHubPagesBaseUrl(
    CANONICAL_RELEASE_REPO_SLUG,
);

export function buildChannelAppcastUrl(baseUrl, channel) {
    const publishPath = getAppcastPublishPath(channel);
    return `${baseUrl.replace(/\/+$/, "")}/${publishPath}`;
}

export function buildGitHubReleaseAssetUrl(repoSlug, tag, assetName) {
    parseGitHubRepoSlug(repoSlug);
    const normalizedTag = tag.startsWith("v")
        ? tag
        : `v${normalizeReleaseVersion(tag)}`;
    return `https://github.com/${repoSlug}/releases/download/${normalizedTag}/${encodeURIComponent(assetName)}`;
}

export function buildPublicReleaseAssetName(version, buildTarget) {
    const normalizedVersion = normalizeReleaseVersion(version);
    switch (buildTarget) {
        case "aarch64-apple-darwin":
            return `${PUBLIC_PRODUCT_NAME}_${normalizedVersion}_macOS_AppleSilicon.dmg`;
        case "x86_64-apple-darwin":
            return `${PUBLIC_PRODUCT_NAME}_${normalizedVersion}_macOS_Intel.dmg`;
        case "aarch64-pc-windows-msvc":
            return `${PUBLIC_PRODUCT_NAME}_${normalizedVersion}_Windows_ARM64_Setup.exe`;
        case "x86_64-pc-windows-msvc":
            return `${PUBLIC_PRODUCT_NAME}_${normalizedVersion}_Windows_x64_Setup.exe`;
        default:
            throw new Error(`Unsupported build target "${buildTarget}".`);
    }
}

export function getCanonicalAppBundleName() {
    return `${PUBLIC_PRODUCT_NAME}.app`;
}

export function getBundledUpdaterArtifactName(buildTarget) {
    switch (buildTarget) {
        case "aarch64-apple-darwin":
        case "x86_64-apple-darwin":
            return `${PUBLIC_PRODUCT_NAME}.app.tar.gz`;
        case "aarch64-pc-windows-msvc":
        case "x86_64-pc-windows-msvc":
            return `${PUBLIC_PRODUCT_NAME}-setup.nsis.zip`;
        default:
            throw new Error(`Unsupported build target "${buildTarget}".`);
    }
}

export function buildUpdaterReleaseAssetName(version, buildTarget) {
    const normalizedVersion = normalizeReleaseVersion(version);

    switch (buildTarget) {
        case "aarch64-apple-darwin":
            return `${PUBLIC_PRODUCT_NAME}_${normalizedVersion}_macOS_AppleSilicon.app.tar.gz`;
        case "x86_64-apple-darwin":
            return `${PUBLIC_PRODUCT_NAME}_${normalizedVersion}_macOS_Intel.app.tar.gz`;
        case "aarch64-pc-windows-msvc":
            return `${PUBLIC_PRODUCT_NAME}_${normalizedVersion}_Windows_ARM64.nsis.zip`;
        case "x86_64-pc-windows-msvc":
            return `${PUBLIC_PRODUCT_NAME}_${normalizedVersion}_Windows_x64.nsis.zip`;
        default:
            throw new Error(`Unsupported build target "${buildTarget}".`);
    }
}

export function describeUpdaterArtifactKind(buildTarget) {
    switch (buildTarget) {
        case "aarch64-apple-darwin":
        case "x86_64-apple-darwin":
            return "macOS updater archive (.app.tar.gz)";
        case "aarch64-pc-windows-msvc":
        case "x86_64-pc-windows-msvc":
            return "Windows updater archive (.nsis.zip)";
        default:
            throw new Error(`Unsupported build target "${buildTarget}".`);
    }
}

export function getSignatureAssetName(archiveName) {
    return `${archiveName}.sig`;
}

export function readNotesForVersion(version, notesFilePath = null) {
    if (notesFilePath) {
        const notes = fs.readFileSync(notesFilePath, "utf8").trim();
        if (!notes) {
            throw new Error(`Notes file ${notesFilePath} is empty.`);
        }
        return notes;
    }

    const normalizedVersion = normalizeReleaseVersion(version);
    const changelog = readFile(CHANGELOG_PATH);
    const changelogEntry = getChangelogEntry(changelog, normalizedVersion);
    if (!changelogEntry) {
        throw new Error(
            `CHANGELOG.md does not contain a release entry for ${normalizedVersion}.`,
        );
    }

    return changelogEntry.notes;
}

export function normalizePlatformEntries(platformsInput) {
    if (
        !platformsInput ||
        typeof platformsInput !== "object" ||
        Array.isArray(platformsInput)
    ) {
        throw new Error(
            "Platform entries must be a JSON object keyed by build target or appcast key.",
        );
    }

    const normalized = {};

    for (const [sourceKey, value] of Object.entries(platformsInput)) {
        const targetKey = BUILD_TARGET_TO_APPCAST_KEY[sourceKey] ?? sourceKey;
        if (!V1_APPCAST_KEYS.includes(targetKey)) {
            throw new Error(
                `Unsupported platform key "${sourceKey}". Expected one of the v1 build targets or appcast keys.`,
            );
        }

        if (!value || typeof value !== "object" || Array.isArray(value)) {
            throw new Error(`Platform entry "${sourceKey}" must be an object.`);
        }

        const { url, signature } = value;
        if (typeof url !== "string" || !url.trim()) {
            throw new Error(
                `Platform entry "${sourceKey}" must define a non-empty url.`,
            );
        }
        if (typeof signature !== "string" || !signature.trim()) {
            throw new Error(
                `Platform entry "${sourceKey}" must define a non-empty signature.`,
            );
        }

        let parsedUrl;
        try {
            parsedUrl = new URL(url);
        } catch (error) {
            throw new Error(
                `Platform entry "${sourceKey}" has an invalid url: ${error.message}`,
            );
        }

        if (parsedUrl.protocol !== "https:") {
            throw new Error(
                `Platform entry "${sourceKey}" must use https. Received ${parsedUrl.protocol}`,
            );
        }

        if (normalized[targetKey]) {
            throw new Error(
                `Platform key "${targetKey}" was defined more than once after normalization.`,
            );
        }

        normalized[targetKey] = {
            url: parsedUrl.toString(),
            signature: signature.trim(),
        };
    }

    return normalized;
}

export function validatePubDate(pubDate) {
    if (typeof pubDate !== "string" || !pubDate.trim()) {
        throw new Error("pubDate must be a non-empty RFC 3339 string.");
    }

    const parsed = new Date(pubDate);
    if (Number.isNaN(parsed.getTime())) {
        throw new Error(
            `Invalid pubDate "${pubDate}". Expected RFC 3339 date-time.`,
        );
    }

    if (!/[tT]/.test(pubDate) || !/(Z|[+-]\d{2}:\d{2})$/.test(pubDate)) {
        throw new Error(
            `Invalid pubDate "${pubDate}". Expected RFC 3339 date-time.`,
        );
    }

    return pubDate;
}

export function createStaticAppcastManifest({
    version,
    notes,
    pubDate,
    platforms,
    requireV1Targets = true,
}) {
    const normalizedVersion = normalizeReleaseVersion(version);
    const normalizedPlatforms = normalizePlatformEntries(platforms);

    if (typeof notes !== "string") {
        throw new Error("Release notes must be a Markdown string.");
    }

    if (requireV1Targets) {
        const missingTargets = V1_APPCAST_KEYS.filter(
            (key) => !normalizedPlatforms[key],
        );
        if (missingTargets.length > 0) {
            throw new Error(
                `Appcast manifest is missing required v1 platforms: ${missingTargets.join(", ")}.`,
            );
        }
    }

    const orderedPlatforms = {};
    for (const key of V1_APPCAST_KEYS) {
        if (normalizedPlatforms[key]) {
            orderedPlatforms[key] = normalizedPlatforms[key];
        }
    }

    for (const [key, value] of Object.entries(normalizedPlatforms)) {
        if (!orderedPlatforms[key]) {
            orderedPlatforms[key] = value;
        }
    }

    return {
        version: normalizedVersion,
        notes: notes.trim(),
        pub_date: validatePubDate(pubDate),
        platforms: orderedPlatforms,
    };
}

export function serializeAppcastManifest(manifest) {
    return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function readPlatformsFile(filePath) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return normalizePlatformEntries(parsed);
}
