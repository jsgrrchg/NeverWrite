import fs from "node:fs";
import path from "node:path";

import {
    BUILD_TARGET_TO_FEED_TARGET,
    CANONICAL_RELEASE_PAGES_BASE_URL,
    ELECTRON_BUILD_TARGETS,
    buildPublishedFeedUrl,
    describeBuildTarget,
    describeUpdaterArtifactKind,
    feedTargetForBuildTarget,
    metadataFileNameForBuildTarget,
    normalizeAppcastChannel,
} from "./electron-release-lib.mjs";

const FEED_TARGET_TO_BUILD_TARGET = Object.fromEntries(
    Object.entries(BUILD_TARGET_TO_FEED_TARGET).map(
        ([buildTarget, feedTarget]) => [feedTarget, buildTarget],
    ),
);

export const PLATFORM_VALIDATION_CASES = [
    "Clean install succeeds for the target",
    "Update from the previous version reaches this target",
    "The app resolves the correct feed for this target",
    "The app does not switch to another architecture feed",
    "A tampered checksum blocks installation",
    "Sensitive state requires inline confirmation before restart",
    "Restart completes on the new version",
];

export function resolveValidationTarget(target) {
    const normalized = typeof target === "string" ? target.trim() : "";
    if (!normalized) {
        throw new Error("Validation target must be a non-empty string.");
    }

    const buildTarget =
        BUILD_TARGET_TO_FEED_TARGET[normalized] != null
            ? normalized
            : FEED_TARGET_TO_BUILD_TARGET[normalized];
    if (!buildTarget) {
        throw new Error(
            `Unsupported validation target "${target}". Expected one of: ${[
                ...ELECTRON_BUILD_TARGETS,
                ...Object.values(BUILD_TARGET_TO_FEED_TARGET),
            ].join(", ")}.`,
        );
    }

    return {
        buildTarget,
        feedTarget: feedTargetForBuildTarget(buildTarget),
        metadataFileName: metadataFileNameForBuildTarget(buildTarget),
        updaterArtifactKind: describeUpdaterArtifactKind(buildTarget),
        ...describeBuildTarget(buildTarget),
    };
}

export function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

export function loadTargetMetadataEntries(metadataDir) {
    const absoluteDir = path.resolve(metadataDir);
    const files = fs
        .readdirSync(absoluteDir)
        .filter((fileName) => fileName.endsWith(".json"))
        .sort();

    if (files.length === 0) {
        throw new Error(
            `No target metadata JSON files found in ${absoluteDir}.`,
        );
    }

    return files.map((fileName) =>
        readJsonFile(path.join(absoluteDir, fileName)),
    );
}

function ensureUniquePerField(entries, field) {
    const seen = new Map();
    for (const entry of entries) {
        const value = entry[field];
        if (typeof value !== "string" || !value.trim()) {
            throw new Error(
                `Target metadata is missing required string field "${field}".`,
            );
        }
        const previous = seen.get(value);
        if (previous) {
            throw new Error(
                `Target metadata reuses ${field}="${value}" for both ${previous.buildTarget} and ${entry.buildTarget}.`,
            );
        }
        seen.set(value, entry);
    }
}

export function validateTargetMetadataEntries(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error("Target metadata entries must be a non-empty array.");
    }

    const byBuildTarget = new Map();
    const byFeedTarget = new Map();

    for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error("Each target metadata entry must be an object.");
        }

        const resolved = resolveValidationTarget(
            entry.buildTarget ?? entry.feedTarget,
        );
        if (byBuildTarget.has(resolved.buildTarget)) {
            throw new Error(
                `Duplicate target metadata for build target ${resolved.buildTarget}.`,
            );
        }
        if (byFeedTarget.has(resolved.feedTarget)) {
            throw new Error(
                `Duplicate target metadata for feed target ${resolved.feedTarget}.`,
            );
        }
        byBuildTarget.set(resolved.buildTarget, entry);
        byFeedTarget.set(resolved.feedTarget, entry);
    }

    const missing = ELECTRON_BUILD_TARGETS.filter(
        (buildTarget) => !byBuildTarget.has(buildTarget),
    );
    if (missing.length > 0) {
        throw new Error(
            `Target metadata is missing required build targets: ${missing.join(", ")}.`,
        );
    }

    ensureUniquePerField(entries, "feedRelativePath");
    ensureUniquePerField(entries, "updaterUrl");
    ensureUniquePerField(entries, "manualAssetName");
    return { byBuildTarget, byFeedTarget };
}

export function buildPlatformValidationMatrix({
    version,
    tag,
    channel,
    pagesBaseUrl = CANONICAL_RELEASE_PAGES_BASE_URL,
    metadataEntries,
}) {
    const normalizedChannel = normalizeAppcastChannel(channel);
    const { byBuildTarget } = validateTargetMetadataEntries(metadataEntries);

    return ELECTRON_BUILD_TARGETS.map((buildTarget) => {
        const target = resolveValidationTarget(buildTarget);
        const metadata = byBuildTarget.get(buildTarget);

        return {
            version,
            tag,
            channel: normalizedChannel,
            feedUrl: buildPublishedFeedUrl(
                pagesBaseUrl,
                normalizedChannel,
                buildTarget,
            ),
            ...target,
            manualAssetName: metadata.manualAssetName,
            updaterAssetName: metadata.updaterAssetName,
            updaterBlockmapAssetName: metadata.updaterBlockmapAssetName,
            updaterUrl: metadata.updaterUrl,
            feedRelativePath: metadata.feedRelativePath,
        };
    });
}

export function tamperFeedChecksum(feedContents) {
    if (typeof feedContents !== "string" || !feedContents.trim()) {
        throw new Error("Feed contents must be a non-empty string.");
    }

    const tampered = feedContents.replace(
        /^(\s*sha512:\s*).+$/m,
        "$1tampered",
    );
    if (tampered === feedContents) {
        throw new Error("Could not locate sha512 entry to tamper in feed.");
    }
    return tampered;
}

export function renderPlatformValidationChecklist({
    rows,
    channel,
    version,
    tag,
}) {
    if (!Array.isArray(rows) || rows.length === 0) {
        throw new Error("Checklist rows must be a non-empty array.");
    }

    const lines = [
        "# Platform Validation Checklist",
        "",
        `Release under test: \`${tag}\``,
        `Version: \`${version}\``,
        `Channel: \`${channel}\``,
        "",
        "Use the generated fixtures with a local loopback server for manual updater validation.",
        "",
        "## Matrix",
        "",
        "| Target | Platform | Architecture | Feed target | Manual installer | Updater asset |",
        "| --- | --- | --- | --- | --- | --- |",
    ];

    for (const row of rows) {
        lines.push(
            `| \`${row.buildTarget}\` | ${row.platformLabel} | ${row.architectureLabel} | \`${row.feedTarget}\` | \`${row.manualAssetName}\` | \`${row.updaterAssetName}\` |`,
        );
    }

    lines.push("", "## Global Procedure", "");
    lines.push(
        "1. Install the previous public version for the target, or perform a clean install when validating first-run packaging.",
    );
    lines.push(
        "2. Serve `fixtures/` from this pack on `127.0.0.1` and point the app to the loopback target feed for the same architecture.",
    );
    lines.push(
        "3. Confirm `Settings > Updates` reports the expected target before installing anything.",
    );
    lines.push(
        "4. Run the valid feed once, then switch to the invalid-checksum fixture for the same target and confirm install is blocked.",
    );
    lines.push(
        "5. Repeat with an unsaved editor tab or pending agent work and confirm the inline confirmation gate appears before restart.",
    );
    lines.push(
        "6. Complete one successful install and verify the app restarts on the new version.",
    );

    for (const row of rows) {
        lines.push("", `## ${row.platformLabel} ${row.architectureLabel}`, "");
        lines.push(`Published feed: \`${row.feedUrl}\``);
        lines.push(`Feed target: \`${row.feedTarget}\``);
        lines.push(`Manual installer: \`${row.manualAssetName}\``);
        lines.push(`Updater asset: \`${row.updaterAssetName}\``);
        lines.push(
            `Invalid-checksum fixture: \`fixtures/${row.feedTarget}/invalid-checksum/${channel}/${row.metadataFileName}\``,
        );
        lines.push(
            `Expected updater artifact family: ${row.updaterArtifactKind}`,
        );
        lines.push("");
        lines.push("Checks:");
        for (const item of PLATFORM_VALIDATION_CASES) {
            lines.push(`- [ ] ${item}`);
        }
    }

    return `${lines.join("\n")}\n`;
}
