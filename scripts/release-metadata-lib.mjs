import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, "..");

export const DESKTOP_PACKAGE_JSON_PATH = path.join(
    REPO_ROOT,
    "apps/desktop/package.json",
);
export const DESKTOP_PACKAGE_LOCK_PATH = path.join(
    REPO_ROOT,
    "apps/desktop/package-lock.json",
);
export const DESKTOP_ELECTRON_BUILDER_CONFIG_PATH = path.join(
    REPO_ROOT,
    "apps/desktop/electron-builder.config.mjs",
);
export const DESKTOP_NATIVE_BACKEND_CARGO_TOML_PATH = path.join(
    REPO_ROOT,
    "apps/desktop/native-backend/Cargo.toml",
);
export const WEB_CLIPPER_PACKAGE_JSON_PATH = path.join(
    REPO_ROOT,
    "apps/web-clipper/package.json",
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
    const packageLock = readJsonFile(DESKTOP_PACKAGE_LOCK_PATH);
    const webClipperPackageJson = readJsonFile(WEB_CLIPPER_PACKAGE_JSON_PATH);
    const nativeBackendCargoToml = readFile(
        DESKTOP_NATIVE_BACKEND_CARGO_TOML_PATH,
    );

    return {
        packageJson: packageJson.version,
        packageLock: packageLock.version,
        packageLockRoot: packageLock.packages?.[""]?.version,
        nativeBackendCargo: readCargoPackageVersion(nativeBackendCargoToml),
        webClipperPackageJson: webClipperPackageJson.version,
    };
}

export async function readDesktopReleaseIdentity() {
    const electronBuilder = await readElectronBuilderConfig();

    return {
        productName: electronBuilder.productName,
        identifier: electronBuilder.appId,
    };
}

export async function readElectronBuilderConfig() {
    const moduleUrl = `${pathToFileURL(DESKTOP_ELECTRON_BUILDER_CONFIG_PATH).href}?cacheBust=${fs.statSync(DESKTOP_ELECTRON_BUILDER_CONFIG_PATH).mtimeMs}`;
    const module = await import(moduleUrl);
    return module.default;
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
        `Could not find [package] version in ${DESKTOP_NATIVE_BACKEND_CARGO_TOML_PATH}.`,
    );
}

export function collectVersionIssues(
    {
        packageJson,
        packageLock,
        packageLockRoot,
        nativeBackendCargo,
        webClipperPackageJson,
    },
    tagVersion,
) {
    const issues = [];
    const versions = [
        packageJson,
        packageLock,
        packageLockRoot,
        nativeBackendCargo,
        webClipperPackageJson,
    ];

    for (const [sourceName, value] of Object.entries({
        packageJson,
        packageLock,
        packageLockRoot,
        nativeBackendCargo,
        webClipperPackageJson,
    })) {
        if (!isStrictSemver(value)) {
            issues.push(
                `${sourceName} version "${value}" is not strict semver (X.Y.Z).`,
            );
        }
    }

    if (new Set(versions).size !== 1) {
        issues.push(
            `Release versions do not match: package.json=${packageJson}, package-lock.json=${packageLock}, package-lock root=${packageLockRoot}, native-backend/Cargo.toml=${nativeBackendCargo}, web-clipper/package.json=${webClipperPackageJson}.`,
        );
    }

    if (tagVersion && packageJson !== tagVersion) {
        issues.push(
            `Release version ${packageJson} does not match release tag version ${tagVersion}.`,
        );
    }

    return issues;
}

export function collectReleaseIdentityIssues({ productName, identifier }) {
    const issues = [];

    if (productName !== EXPECTED_DESKTOP_PRODUCT_NAME) {
        issues.push(
            `electron-builder.config.mjs productName must be "${EXPECTED_DESKTOP_PRODUCT_NAME}", received "${productName}".`,
        );
    }

    if (identifier !== EXPECTED_DESKTOP_IDENTIFIER) {
        issues.push(
            `electron-builder.config.mjs appId must be "${EXPECTED_DESKTOP_IDENTIFIER}", received "${identifier}".`,
        );
    }

    return issues;
}

export function collectElectronBuildIssues(config) {
    const issues = [];

    if (!config || typeof config !== "object" || Array.isArray(config)) {
        return ["electron-builder.config.mjs must export a configuration object."];
    }

    const protocols = Array.isArray(config.protocols) ? config.protocols : [];
    const hasNeverWriteProtocol = protocols.some((entry) =>
        Array.isArray(entry?.schemes) && entry.schemes.includes("neverwrite"),
    );
    if (!hasNeverWriteProtocol) {
        issues.push(
            'electron-builder.config.mjs must register the "neverwrite" protocol.',
        );
    }

    const extraResources = Array.isArray(config.extraResources)
        ? config.extraResources
        : [];
    const hasNativeBackendResource = extraResources.some(
        (entry) =>
            entry?.from === "out/native-backend" && entry?.to === "native-backend",
    );
    if (!hasNativeBackendResource) {
        issues.push(
            'electron-builder.config.mjs must stage "out/native-backend" into the packaged "native-backend" resources directory.',
        );
    }

    if (config.mac?.minimumSystemVersion !== "12.0") {
        issues.push(
            'electron-builder.config.mjs mac.minimumSystemVersion must be "12.0".',
        );
    }

    if (
        typeof config.artifactName !== "string" ||
        !config.artifactName.includes("${arch}")
    ) {
        issues.push(
            'electron-builder.config.mjs artifactName must include "${arch}" to avoid multi-architecture asset collisions.',
        );
    }

    if (typeof config.afterPack !== "string" || !config.afterPack.trim()) {
        issues.push(
            "electron-builder.config.mjs must configure afterPack bundle verification.",
        );
    }

    const macTargets = new Set(
        (config.mac?.target ?? []).flatMap((entry) =>
            typeof entry === "string" ? [entry] : [entry?.target].filter(Boolean),
        ),
    );
    for (const expectedTarget of ["dmg", "zip"]) {
        if (!macTargets.has(expectedTarget)) {
            issues.push(
                `electron-builder.config.mjs mac.target must include "${expectedTarget}".`,
            );
        }
    }

    const winTargets = new Set(
        (config.win?.target ?? []).flatMap((entry) =>
            typeof entry === "string" ? [entry] : [entry?.target].filter(Boolean),
        ),
    );
    if (!winTargets.has("nsis")) {
        issues.push(
            'electron-builder.config.mjs win.target must include "nsis".',
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
