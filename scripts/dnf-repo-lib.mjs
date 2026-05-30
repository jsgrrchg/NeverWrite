import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import {
    CANONICAL_RELEASE_PAGES_BASE_URL,
    normalizeReleaseVersion,
    buildRpmPackageAssetName,
    buildGitHubReleaseAssetUrl,
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

export function buildGitHubReleaseRpmUrl(repoSlug, tag, version, rpmArchitecture) {
    const normalizedTag = tag.startsWith("v") ? tag : `v${normalizeReleaseVersion(tag)}`;
    const assetName = buildRpmReleaseAssetName(version, rpmArchitecture);
    return buildGitHubReleaseAssetUrl(repoSlug, normalizedTag, assetName);
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

const HASH_READ_BUFFER_SIZE_BYTES = 1024 * 1024;

export function hashFile(filePath, algorithm) {
    const hash = crypto.createHash(algorithm);
    const buffer = Buffer.allocUnsafe(HASH_READ_BUFFER_SIZE_BYTES);
    const fd = fs.openSync(filePath, "r");
    try {
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
            if (bytesRead > 0) {
                hash.update(buffer.subarray(0, bytesRead));
            }
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest("hex");
}

export function getFileHashes(filePath) {
    return {
        md5: hashFile(filePath, "md5"),
        sha1: hashFile(filePath, "sha1"),
        sha256: hashFile(filePath, "sha256"),
    };
}

export function getContentHashes(content) {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
    return {
        md5: crypto.createHash("md5").update(buffer).digest("hex"),
        sha1: crypto.createHash("sha1").update(buffer).digest("hex"),
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
}

export function gzipContent(input) {
    return zlib.gzipSync(Buffer.from(input, "utf8"), { level: 9, mtime: 0 });
}

export function xmlEscape(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}

export function buildPrimaryXml({ packages }) {
    const now = new Date().toUTCString();
    const entries = packages.map((pkg) => {
        return `  <package type="rpm">
    <name>${xmlEscape(pkg.name)}</name>
    <arch>${xmlEscape(pkg.arch)}</arch>
    <version epoch="0" ver="${xmlEscape(pkg.version)}" rel="1"/>
    <checksum type="sha256" pkgid="YES">${pkg.hashes.sha256}</checksum>
    <summary>NeverWrite desktop knowledge workspace</summary>
    <description>NeverWrite is a local-first knowledge workspace for power users.</description>
    <packager>NeverWrite Team</packager>
    <url>https://neverwrite.app</url>
    <time file="${Math.floor(Date.now() / 1000)}" build="${Math.floor(Date.now() / 1000)}"/>
    <size package="${pkg.sizeBytes}" installed="${pkg.sizeBytes * 3}" archive="${pkg.sizeBytes}"/>
    <location href="${xmlEscape(pkg.locationUrl)}"/>
    <format>
      <rpm:license>MIT</rpm:license>
      <rpm:vendor>NeverWrite</rpm:vendor>
      <rpm:group>Applications/Editors</rpm:group>
      <rpm:requires>
        <rpm:entry name="glibc"/>
      </rpm:requires>
    </format>
  </package>`;
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<metadata xmlns="http://linux.duke.edu/metadata/common" xmlns:rpm="http://linux.duke.edu/metadata/rpm" packages="${packages.length}">
${entries.join("\n")}
</metadata>`;
}

export function buildFilelistsXml({ packages }) {
    const entries = packages.map((pkg) => `  <package pkgid="${pkg.hashes.sha256}" name="${xmlEscape(pkg.name)}" arch="${xmlEscape(pkg.arch)}">
    <version epoch="0" ver="${xmlEscape(pkg.version)}" rel="1"/>
  </package>`);

    return `<?xml version="1.0" encoding="UTF-8"?>
<filelists xmlns="http://linux.duke.edu/metadata/filelists" packages="${packages.length}">
${entries.join("\n")}
</filelists>`;
}

export function buildOtherXml({ packages }) {
    const entries = packages.map((pkg) => `  <package pkgid="${pkg.hashes.sha256}" name="${xmlEscape(pkg.name)}" arch="${xmlEscape(pkg.arch)}">
    <version epoch="0" ver="${xmlEscape(pkg.version)}" rel="1"/>
  </package>`);

    return `<?xml version="1.0" encoding="UTF-8"?>
<otherdata xmlns="http://linux.duke.edu/metadata/other" packages="${packages.length}">
${entries.join("\n")}
</otherdata>`;
}

export function buildRepomdXml({ files }) {
    const now = new Date().toUTCString();
    const entries = files.map((file) => {
        const typeMap = {
            "primary.xml.gz": "primary",
            "filelists.xml.gz": "filelists",
            "other.xml.gz": "other",
        };
        const type = typeMap[file.relativePath] || "primary";
        return `  <data type="${type}">
    <checksum type="sha256">${file.hashes.sha256}</checksum>
    <open-checksum type="sha256">${file.openHashes.sha256}</open-checksum>
    <location href="repodata/${xmlEscape(file.relativePath)}"/>
    <timestamp>${Math.floor(Date.now() / 1000)}</timestamp>
    <size>${file.sizeBytes}</size>
    <open-size>${file.openSizeBytes}</open-size>
  </data>`;
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<repomd xmlns="http://linux.duke.edu/metadata/repo" xmlns:rpm="http://linux.duke.edu/metadata/rpm">
${entries.join("\n")}
</repomd>`;
}
