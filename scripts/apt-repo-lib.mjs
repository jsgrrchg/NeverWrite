import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
    CANONICAL_RELEASE_PAGES_BASE_URL,
    CANONICAL_RELEASE_REPO_SLUG,
    PUBLIC_PRODUCT_NAME,
    buildDebianPackageAssetName,
    parseGitHubRepoSlug,
    normalizeReleaseVersion,
} from "./appcast-lib.mjs";

export const APT_REPOSITORY_RELATIVE_ROOT = "apt";
export const APT_RELEASE_REPOSITORY_RELATIVE_ROOT = "apt-release";
export const APT_PACKAGE_NAME = "neverwrite";
export const APT_ORIGIN = PUBLIC_PRODUCT_NAME;
export const APT_LABEL = PUBLIC_PRODUCT_NAME;
export const APT_DESCRIPTION =
    "NeverWrite desktop Debian package repository";
export const APT_DEFAULT_SUITE = "stable";
export const APT_EXACT_PATH_SUITE = "./";
export const APT_DEFAULT_CODENAME = "neverwrite-stable";
export const APT_DEFAULT_COMPONENT = "main";
export const APT_SUPPORTED_ARCHITECTURES = ["amd64", "arm64"];
export const APT_DEFAULT_BASE_URL = `${CANONICAL_RELEASE_PAGES_BASE_URL}/apt`;
export const APT_RELEASE_DOWNLOAD_BASE_URL = `https://github.com/${CANONICAL_RELEASE_REPO_SLUG}/releases/latest/download`;
export const APT_PUBLIC_KEY_FILE_NAME = "neverwrite-archive-keyring.asc";
export const APT_SOURCES_EXAMPLE_FILE_NAME = "neverwrite.sources.example";
export const APT_LAYOUT_CLASSIC = "classic";
export const APT_LAYOUT_FLAT_RELEASE = "flat-release";
export const APT_LAYOUTS = [APT_LAYOUT_CLASSIC, APT_LAYOUT_FLAT_RELEASE];

export const APT_RELEASE_CHECKSUMS = [
    { fieldName: "MD5Sum", algorithm: "md5" },
    { fieldName: "SHA1", algorithm: "sha1" },
    { fieldName: "SHA256", algorithm: "sha256" },
];
export const APT_PACKAGE_CHECKSUMS = [
    { fieldName: "MD5sum", hashKey: "MD5Sum", algorithm: "md5" },
    { fieldName: "SHA1", hashKey: "SHA1", algorithm: "sha1" },
    { fieldName: "SHA256", hashKey: "SHA256", algorithm: "sha256" },
];

const HASH_READ_BUFFER_SIZE_BYTES = 1024 * 1024;

const BUILD_TARGET_BY_DEBIAN_ARCHITECTURE = {
    amd64: "x86_64-unknown-linux-gnu",
    arm64: "aarch64-unknown-linux-gnu",
};

const CONTROL_FIELD_ORDER = [
    "Package",
    "Version",
    "Architecture",
    "Maintainer",
    "Installed-Size",
    "Depends",
    "Recommends",
    "Suggests",
    "Conflicts",
    "Replaces",
    "Provides",
    "Section",
    "Priority",
    "Homepage",
    "Description",
];

export function normalizeAptSuite(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized !== APT_DEFAULT_SUITE) {
        throw new Error(
            `Unsupported APT suite "${value}". Supported suite: ${APT_DEFAULT_SUITE}.`,
        );
    }
    return normalized;
}

export function normalizeAptComponent(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (normalized !== APT_DEFAULT_COMPONENT) {
        throw new Error(
            `Unsupported APT component "${value}". Supported component: ${APT_DEFAULT_COMPONENT}.`,
        );
    }
    return normalized;
}

export function normalizeAptLayout(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!APT_LAYOUTS.includes(normalized)) {
        throw new Error(
            `Unsupported APT layout "${value}". Supported layouts: ${APT_LAYOUTS.join(", ")}.`,
        );
    }
    return normalized;
}

export function normalizeDebianArchitecture(value) {
    const normalized = String(value ?? "").trim().toLowerCase();
    if (!APT_SUPPORTED_ARCHITECTURES.includes(normalized)) {
        throw new Error(
            `Unsupported Debian architecture "${value}". Supported architectures: ${APT_SUPPORTED_ARCHITECTURES.join(", ")}.`,
        );
    }
    return normalized;
}

export function buildDebianReleaseAssetName(version, debianArchitecture) {
    const arch = normalizeDebianArchitecture(debianArchitecture);
    return buildDebianPackageAssetName(
        normalizeReleaseVersion(version),
        BUILD_TARGET_BY_DEBIAN_ARCHITECTURE[arch],
    );
}

export function parseDebianReleaseAssetName(fileName) {
    const normalizedName = String(fileName ?? "");
    const match = new RegExp(
        `^${PUBLIC_PRODUCT_NAME}-(\\d+\\.\\d+\\.\\d+)-(amd64|arm64)\\.deb$`,
    ).exec(normalizedName);
    if (!match) {
        return null;
    }
    return {
        version: match[1],
        architecture: normalizeDebianArchitecture(match[2]),
    };
}

export function buildAptPoolPackageName(version, debianArchitecture) {
    const normalizedVersion = normalizeReleaseVersion(version);
    const arch = normalizeDebianArchitecture(debianArchitecture);
    return `${APT_PACKAGE_NAME}_${normalizedVersion}_${arch}.deb`;
}

export function buildAptPoolPackagePath(version, debianArchitecture) {
    return path.posix.join(
        "pool",
        "main",
        "n",
        APT_PACKAGE_NAME,
        buildAptPoolPackageName(version, debianArchitecture),
    );
}

export function getAptBinaryPackagesPath(debianArchitecture) {
    const arch = normalizeDebianArchitecture(debianArchitecture);
    return path.posix.join(
        "dists",
        APT_DEFAULT_SUITE,
        APT_DEFAULT_COMPONENT,
        `binary-${arch}`,
        "Packages",
    );
}

export function getAptBinaryPackagesGzipPath(debianArchitecture) {
    return `${getAptBinaryPackagesPath(debianArchitecture)}.gz`;
}

export function getAptRepositoryRoot(pagesDir) {
    if (typeof pagesDir !== "string" || !pagesDir.trim()) {
        throw new Error("pagesDir must be a non-empty string.");
    }
    return path.join(pagesDir, APT_REPOSITORY_RELATIVE_ROOT);
}

export function getAptReleaseRepositoryRoot(rootDir) {
    if (typeof rootDir !== "string" || !rootDir.trim()) {
        throw new Error("rootDir must be a non-empty string.");
    }
    return path.join(rootDir, APT_RELEASE_REPOSITORY_RELATIVE_ROOT);
}

export function normalizeAptBaseUrl(baseUrl) {
    const normalized = String(baseUrl ?? "").trim().replace(/\/+$/, "");
    if (!normalized) {
        throw new Error("APT base URL must be a non-empty string.");
    }
    if (!/^https?:\/\//i.test(normalized) && !normalized.startsWith("file:")) {
        throw new Error(
            `APT base URL must be an http(s) or file URL, received "${baseUrl}".`,
        );
    }
    return normalized;
}

export function buildGitHubReleaseDownloadBaseUrl(repoSlug, tag = "latest") {
    parseGitHubRepoSlug(repoSlug);
    const normalizedTag = String(tag ?? "").trim();
    if (normalizedTag === "latest") {
        return `https://github.com/${repoSlug}/releases/latest/download`;
    }
    const releaseTag = normalizedTag.startsWith("v")
        ? normalizedTag
        : `v${normalizeReleaseVersion(normalizedTag)}`;
    return `https://github.com/${repoSlug}/releases/download/${releaseTag}`;
}

export function buildNeverWriteSourcesExample(
    baseUrl = APT_DEFAULT_BASE_URL,
    {
        suite = APT_DEFAULT_SUITE,
        component = APT_DEFAULT_COMPONENT,
    } = {},
) {
    const lines = [
        "Types: deb",
        `URIs: ${normalizeAptBaseUrl(baseUrl)}`,
        `Suites: ${suite}`,
    ];

    if (component) {
        lines.push(`Components: ${component}`);
    }

    lines.push(
        `Architectures: ${APT_SUPPORTED_ARCHITECTURES.join(" ")}`,
        `Signed-By: /etc/apt/keyrings/${APT_PACKAGE_NAME}.asc`,
        "",
    );

    return lines.join("\n");
}

export function parseDebianControlStanza(input) {
    const fields = [];
    let current = null;

    for (const rawLine of String(input ?? "").replace(/\r\n/g, "\n").split("\n")) {
        if (!rawLine) {
            current = null;
            continue;
        }

        if (/^\s/.test(rawLine)) {
            if (!current) {
                throw new Error(
                    `Invalid Debian control continuation without a field: ${rawLine}`,
                );
            }
            current.value = `${current.value}\n${rawLine}`;
            continue;
        }

        const separatorIndex = rawLine.indexOf(":");
        if (separatorIndex <= 0) {
            throw new Error(`Invalid Debian control field: ${rawLine}`);
        }

        current = {
            name: rawLine.slice(0, separatorIndex),
            value: rawLine.slice(separatorIndex + 1).replace(/^ /, ""),
        };
        fields.push(current);
    }

    return fields;
}

export function getDebianControlField(fields, fieldName) {
    const wanted = fieldName.toLowerCase();
    return (
        fields.find((field) => field.name.toLowerCase() === wanted)?.value ??
        null
    );
}

export function renderDebianControlFields(fields) {
    return `${fields
        .map((field) => `${field.name}: ${field.value}`)
        .join("\n")}\n`;
}

export function hashFile(filePath, algorithm) {
    const hash = crypto.createHash(algorithm);
    const buffer = Buffer.allocUnsafe(HASH_READ_BUFFER_SIZE_BYTES);
    const fileDescriptor = fs.openSync(filePath, "r");

    try {
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(
                fileDescriptor,
                buffer,
                0,
                buffer.length,
                null,
            );
            if (bytesRead > 0) {
                hash.update(buffer.subarray(0, bytesRead));
            }
        } while (bytesRead > 0);
    } finally {
        fs.closeSync(fileDescriptor);
    }

    return hash.digest("hex");
}

export function getFileHashes(filePath) {
    return Object.fromEntries(
        APT_RELEASE_CHECKSUMS.map(({ fieldName, algorithm }) => [
            fieldName,
            hashFile(filePath, algorithm),
        ]),
    );
}

export function renderPackagesStanza({
    controlFields,
    filename,
    sizeBytes,
    hashes,
}) {
    const generatedFieldNames = new Set([
        "filename",
        "size",
        "md5sum",
        "sha1",
        "sha256",
    ]);
    const existingFields = controlFields.filter(
        (field) => !generatedFieldNames.has(field.name.toLowerCase()),
    );
    const fieldsByName = new Map(
        existingFields.map((field) => [field.name.toLowerCase(), field]),
    );
    const orderedFields = [];

    for (const name of CONTROL_FIELD_ORDER) {
        const field = fieldsByName.get(name.toLowerCase());
        if (field) {
            orderedFields.push(field);
            fieldsByName.delete(name.toLowerCase());
        }
    }

    orderedFields.push(
        ...[...fieldsByName.values()].sort((a, b) =>
            a.name.localeCompare(b.name),
        ),
        { name: "Filename", value: filename },
        { name: "Size", value: String(sizeBytes) },
        ...APT_PACKAGE_CHECKSUMS.map(({ fieldName, hashKey }) => ({
            name: fieldName,
            value: hashes[hashKey],
        })),
    );

    return renderDebianControlFields(orderedFields);
}

export function buildAptReleaseContent({
    suite = APT_DEFAULT_SUITE,
    codename = APT_DEFAULT_CODENAME,
    component = APT_DEFAULT_COMPONENT,
    architectures = APT_SUPPORTED_ARCHITECTURES,
    files,
    generatedAt = new Date(),
}) {
    const normalizedSuite = normalizeAptSuite(suite);
    const normalizedComponent = component
        ? normalizeAptComponent(component)
        : null;
    const normalizedArchitectures = architectures.map((arch) =>
        normalizeDebianArchitecture(arch),
    );
    const sortedFiles = [...files].sort((a, b) =>
        a.relativePath.localeCompare(b.relativePath),
    );
    const lines = [
        `Origin: ${APT_ORIGIN}`,
        `Label: ${APT_LABEL}`,
        `Suite: ${normalizedSuite}`,
        `Codename: ${codename}`,
        `Date: ${generatedAt.toUTCString()}`,
        `Architectures: ${normalizedArchitectures.join(" ")}`,
        `Description: ${APT_DESCRIPTION}`,
    ];

    if (normalizedComponent) {
        lines.splice(7, 0, `Components: ${normalizedComponent}`);
    }

    for (const { fieldName } of APT_RELEASE_CHECKSUMS) {
        lines.push(`${fieldName}:`);
        for (const file of sortedFiles) {
            lines.push(
                ` ${file.hashes[fieldName]} ${String(file.sizeBytes).padStart(16, " ")} ${file.relativePath}`,
            );
        }
    }

    return `${lines.join("\n")}\n`;
}

export function listFilesRecursively(rootDir) {
    const files = [];
    const queue = [rootDir];

    while (queue.length > 0) {
        const current = queue.pop();
        if (!fs.existsSync(current)) {
            continue;
        }
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolutePath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(absolutePath);
            } else if (entry.isFile()) {
                files.push(absolutePath);
            }
        }
    }

    return files.sort();
}

export function parseAptPoolPackageFileName(fileName) {
    const match = new RegExp(
        `^${APT_PACKAGE_NAME}_(\\d+\\.\\d+\\.\\d+)_(amd64|arm64)\\.deb$`,
    ).exec(fileName);
    if (!match) {
        return null;
    }
    return {
        version: match[1],
        architecture: normalizeDebianArchitecture(match[2]),
    };
}

export function compareReleaseVersionsDescending(left, right) {
    const leftParts = normalizeReleaseVersion(left).split(".").map(Number);
    const rightParts = normalizeReleaseVersion(right).split(".").map(Number);

    for (let index = 0; index < 3; index += 1) {
        if (leftParts[index] !== rightParts[index]) {
            return rightParts[index] - leftParts[index];
        }
    }

    return 0;
}
