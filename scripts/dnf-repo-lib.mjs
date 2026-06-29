import path from "node:path";

import {
    CANONICAL_RELEASE_PAGES_BASE_URL,
    normalizeReleaseVersion,
    buildRpmPackageAssetName,
    parseGitHubRepoSlug,
} from "./appcast-lib.mjs";

export const DNF_REPOSITORY_RELATIVE_ROOT = "dnf";
export const DNF_PACKAGE_NAME = "neverwrite";
export const DNF_SUPPORTED_ARCHITECTURES = ["x86_64", "aarch64"];

export const BUILD_TARGET_BY_RPM_ARCHITECTURE = {
    x86_64: "x86_64-unknown-linux-gnu",
    aarch64: "aarch64-unknown-linux-gnu",
};

export function normalizeRpmArchitecture(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!DNF_SUPPORTED_ARCHITECTURES.includes(normalized)) {
        throw new Error(
            `Unsupported RPM architecture "${value}". Supported: ${DNF_SUPPORTED_ARCHITECTURES.join(", ")}.`,
        );
    }
    return normalized;
}

export function buildDnfRepoRoot(pagesDir) {
    if (typeof pagesDir !== "string" || !pagesDir.trim()) {
        throw new Error("pagesDir must be a non-empty string.");
    }
    return path.join(pagesDir, DNF_REPOSITORY_RELATIVE_ROOT);
}

export function buildRpmReleaseAssetName(version, rpmArchitecture) {
    const arch = normalizeRpmArchitecture(rpmArchitecture);
    const buildTarget = BUILD_TARGET_BY_RPM_ARCHITECTURE[arch];
    return buildRpmPackageAssetName(normalizeReleaseVersion(version), buildTarget);
}

export function buildGitHubReleaseRpmLocationPrefix(repoSlug, tag) {
    parseGitHubRepoSlug(repoSlug);
    const normalizedTag = tag.startsWith("v") ? tag : `v${normalizeReleaseVersion(tag)}`;
    return `https://github.com/${repoSlug}/releases/download/${normalizedTag}/`;
}

export function buildGitHubReleaseRpmUrl(repoSlug, tag, version, rpmArchitecture) {
    const assetName = buildRpmReleaseAssetName(version, rpmArchitecture);
    return `${buildGitHubReleaseRpmLocationPrefix(repoSlug, tag)}${encodeURIComponent(assetName)}`;
}

export const DNF_DEFAULT_BASE_URL = `${CANONICAL_RELEASE_PAGES_BASE_URL}/${DNF_REPOSITORY_RELATIVE_ROOT}`;
export const DNF_PUBLIC_KEY_FILE_NAME = "neverwrite-archive-keyring.asc";
export const DNF_REPO_EXAMPLE_FILE_NAME = "neverwrite.repo.example";

export function buildNeverWriteRepoExample(baseUrl = DNF_DEFAULT_BASE_URL) {
    const normalizedUrl = baseUrl.replace(/\/+$/, "");
    return [
        "[neverwrite]",
        "name=NeverWrite",
        `baseurl=${normalizedUrl}`,
        "enabled=1",
        "gpgcheck=1",
        "repo_gpgcheck=1",
        `gpgkey=${normalizedUrl}/${DNF_PUBLIC_KEY_FILE_NAME}`,
        "",
    ].join("\n");
}
