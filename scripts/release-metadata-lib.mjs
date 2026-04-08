import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, "..");

export const DESKTOP_PACKAGE_JSON_PATH = path.join(
    REPO_ROOT,
    "apps/desktop/package.json",
);
export const DESKTOP_TAURI_CONF_PATH = path.join(
    REPO_ROOT,
    "apps/desktop/src-tauri/tauri.conf.json",
);
export const DESKTOP_CARGO_TOML_PATH = path.join(
    REPO_ROOT,
    "apps/desktop/src-tauri/Cargo.toml",
);
export const CHANGELOG_PATH = path.join(REPO_ROOT, "CHANGELOG.md");

const STRICT_SEMVER_RE = /^\d+\.\d+\.\d+$/;
const RELEASE_TAG_RE = /^v(\d+\.\d+\.\d+)$/;
const EXPECTED_DESKTOP_PRODUCT_NAME = "NeverWrite";
const EXPECTED_DESKTOP_IDENTIFIER = "com.neverwrite";

export function isStrictSemver(value) {
    return STRICT_SEMVER_RE.test(value);
}

export function normalizeReleaseTag(tag) {
    const match = RELEASE_TAG_RE.exec(tag);
    if (!match) {
        throw new Error(
            `Invalid release tag "${tag}". Expected format vX.Y.Z, for example v0.2.0.`,
        );
    }

    return match[1];
}

export function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function readFile(filePath) {
    return fs.readFileSync(filePath, "utf8");
}

export function readDesktopVersions() {
    const packageJson = readJsonFile(DESKTOP_PACKAGE_JSON_PATH);
    const tauriConf = readJsonFile(DESKTOP_TAURI_CONF_PATH);
    const cargoToml = readFile(DESKTOP_CARGO_TOML_PATH);

    return {
        packageJson: packageJson.version,
        tauriConf: tauriConf.version,
        cargoToml: readCargoPackageVersion(cargoToml),
    };
}

export function readDesktopReleaseIdentity() {
    const tauriConf = readJsonFile(DESKTOP_TAURI_CONF_PATH);

    return {
        productName: tauriConf.productName,
        identifier: tauriConf.identifier,
    };
}

export function readCargoPackageVersion(cargoTomlText) {
    let currentSection = "";

    for (const rawLine of cargoTomlText.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }

        const sectionMatch = /^\[(.+)]$/.exec(line);
        if (sectionMatch) {
            currentSection = sectionMatch[1];
            continue;
        }

        if (currentSection !== "package") {
            continue;
        }

        const versionMatch = /^version\s*=\s*"([^"]+)"$/.exec(line);
        if (versionMatch) {
            return versionMatch[1];
        }
    }

    throw new Error(
        `Could not find [package] version in ${DESKTOP_CARGO_TOML_PATH}.`,
    );
}

export function collectVersionIssues(
    { packageJson, tauriConf, cargoToml },
    tagVersion,
) {
    const issues = [];
    const versions = [packageJson, tauriConf, cargoToml];

    for (const [sourceName, value] of Object.entries({
        packageJson,
        tauriConf,
        cargoToml,
    })) {
        if (!isStrictSemver(value)) {
            issues.push(
                `${sourceName} version "${value}" is not strict semver (X.Y.Z).`,
            );
        }
    }

    if (new Set(versions).size !== 1) {
        issues.push(
            `Desktop versions do not match: package.json=${packageJson}, tauri.conf.json=${tauriConf}, Cargo.toml=${cargoToml}.`,
        );
    }

    if (tagVersion && packageJson !== tagVersion) {
        issues.push(
            `Desktop version ${packageJson} does not match release tag version ${tagVersion}.`,
        );
    }

    return issues;
}

export function collectReleaseIdentityIssues({ productName, identifier }) {
    const issues = [];

    if (productName !== EXPECTED_DESKTOP_PRODUCT_NAME) {
        issues.push(
            `tauri.conf.json productName must be "${EXPECTED_DESKTOP_PRODUCT_NAME}", received "${productName}".`,
        );
    }

    if (identifier !== EXPECTED_DESKTOP_IDENTIFIER) {
        issues.push(
            `tauri.conf.json identifier must be "${EXPECTED_DESKTOP_IDENTIFIER}", received "${identifier}".`,
        );
    }

    return issues;
}

export function parseChangelogEntries(markdown) {
    const lines = markdown.split(/\r?\n/);
    const entries = [];
    let currentEntry = null;

    for (const line of lines) {
        const headingMatch = /^## \[([^\]]+)](?:\s*-\s*.+)?\s*$/.exec(line);
        if (headingMatch) {
            if (currentEntry) {
                currentEntry.notes = trimNotes(currentEntry.lines.join("\n"));
                delete currentEntry.lines;
                entries.push(currentEntry);
            }

            currentEntry = {
                version: headingMatch[1],
                lines: [],
            };
            continue;
        }

        if (currentEntry) {
            currentEntry.lines.push(line);
        }
    }

    if (currentEntry) {
        currentEntry.notes = trimNotes(currentEntry.lines.join("\n"));
        delete currentEntry.lines;
        entries.push(currentEntry);
    }

    return entries;
}

export function getChangelogEntry(markdown, version) {
    return (
        parseChangelogEntries(markdown).find(
            (entry) => entry.version === version,
        ) ?? null
    );
}

function trimNotes(value) {
    return value.replace(/^\s+|\s+$/g, "");
}
