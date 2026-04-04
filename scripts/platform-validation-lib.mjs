import fs from "node:fs";
import path from "node:path";

import {
    BUILD_TARGET_TO_APPCAST_KEY,
    V1_BUILD_TARGETS,
    buildChannelAppcastUrl,
    describeUpdaterArtifactKind,
} from "./appcast-lib.mjs";
import {
    PUBLIC_DOWNLOAD_VARIANTS,
    requiredStagedResourcePaths,
} from "./release-assets-lib.mjs";

const APPCAST_KEY_TO_BUILD_TARGET = Object.fromEntries(
    Object.entries(BUILD_TARGET_TO_APPCAST_KEY).map(
        ([buildTarget, appcastKey]) => [appcastKey, buildTarget],
    ),
);

export const PLATFORM_VALIDATION_CASES = [
    "Clean install succeeds for the target",
    "Update from the previous version reaches this target",
    "The app reports the correct target before install",
    "The app does not switch to another architecture asset",
    "An invalid signature blocks installation",
    "Sensitive state requires inline confirmation before restart",
    "Restart completes on the new version",
];

function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}

export function resolveValidationTarget(target) {
    const normalized = typeof target === "string" ? target.trim() : "";
    if (!normalized) {
        throw new Error("Validation target must be a non-empty string.");
    }

    const buildTarget =
        BUILD_TARGET_TO_APPCAST_KEY[normalized] != null
            ? normalized
            : APPCAST_KEY_TO_BUILD_TARGET[normalized];
    if (!buildTarget) {
        throw new Error(
            `Unsupported validation target "${target}". Expected one of: ${[
                ...V1_BUILD_TARGETS,
                ...Object.values(BUILD_TARGET_TO_APPCAST_KEY),
            ].join(", ")}.`,
        );
    }

    const appcastKey = BUILD_TARGET_TO_APPCAST_KEY[buildTarget];
    const variant = PUBLIC_DOWNLOAD_VARIANTS.find(
        (entry) => entry.buildTarget === buildTarget,
    );
    if (!variant) {
        throw new Error(`Missing public download variant for ${buildTarget}.`);
    }

    return {
        buildTarget,
        appcastKey,
        platformLabel: variant.platformLabel,
        architectureLabel: variant.architectureLabel,
        updaterArtifactKind: describeUpdaterArtifactKind(buildTarget),
        embeddedResourcePaths: requiredStagedResourcePaths(buildTarget),
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
    const byAppcastKey = new Map();

    for (const entry of entries) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error("Each target metadata entry must be an object.");
        }
        const resolved = resolveValidationTarget(
            entry.buildTarget ?? entry.appcastKey,
        );
        if (byBuildTarget.has(resolved.buildTarget)) {
            throw new Error(
                `Duplicate target metadata for build target ${resolved.buildTarget}.`,
            );
        }
        if (byAppcastKey.has(resolved.appcastKey)) {
            throw new Error(
                `Duplicate target metadata for appcast key ${resolved.appcastKey}.`,
            );
        }
        byBuildTarget.set(resolved.buildTarget, entry);
        byAppcastKey.set(resolved.appcastKey, entry);
    }

    const missing = V1_BUILD_TARGETS.filter(
        (buildTarget) => !byBuildTarget.has(buildTarget),
    );
    if (missing.length > 0) {
        throw new Error(
            `Target metadata is missing required build targets: ${missing.join(", ")}.`,
        );
    }

    ensureUniquePerField(entries, "updaterUrl");
    ensureUniquePerField(entries, "updaterAssetName");
    return { byBuildTarget, byAppcastKey };
}

export function buildAppcastPlatformsFromTargetMetadata(entries) {
    const { byBuildTarget } = validateTargetMetadataEntries(entries);

    return Object.fromEntries(
        V1_BUILD_TARGETS.map((buildTarget) => {
            const target = resolveValidationTarget(buildTarget);
            const metadata = byBuildTarget.get(buildTarget);

            return [
                target.appcastKey,
                {
                    url: metadata.updaterUrl,
                    signature: metadata.updaterSignature,
                },
            ];
        }),
    );
}

export function buildPlatformValidationMatrix({
    version,
    tag,
    channel,
    appcastBaseUrl,
    manifest,
    metadataEntries,
}) {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
        throw new Error("Appcast manifest must be an object.");
    }
    const { byBuildTarget } = validateTargetMetadataEntries(metadataEntries);
    const feedUrl =
        typeof appcastBaseUrl === "string" && appcastBaseUrl.trim()
            ? buildChannelAppcastUrl(appcastBaseUrl, channel)
            : null;

    return V1_BUILD_TARGETS.map((buildTarget) => {
        const target = resolveValidationTarget(buildTarget);
        const metadata = byBuildTarget.get(buildTarget);
        const manifestPlatform = manifest.platforms?.[target.appcastKey];
        if (!manifestPlatform) {
            throw new Error(
                `Appcast manifest is missing platform entry ${target.appcastKey}.`,
            );
        }
        if (manifestPlatform.url !== metadata.updaterUrl) {
            throw new Error(
                `Appcast URL mismatch for ${target.appcastKey}: manifest=${manifestPlatform.url} metadata=${metadata.updaterUrl}.`,
            );
        }
        if (manifestPlatform.signature !== metadata.updaterSignature) {
            throw new Error(
                `Appcast signature mismatch for ${target.appcastKey}.`,
            );
        }

        return {
            version,
            tag,
            channel,
            feedUrl,
            ...target,
            manualAssetName: metadata.manualAssetName,
            updaterAssetName: metadata.updaterAssetName,
            updaterSignatureAssetName: metadata.updaterSignatureAssetName,
            updaterUrl: metadata.updaterUrl,
        };
    });
}

export function createInvalidSignatureManifest(manifest, appcastKey) {
    const target = resolveValidationTarget(appcastKey);
    const next = cloneJson(manifest);
    const previous = next.platforms?.[target.appcastKey]?.signature;
    if (typeof previous !== "string" || !previous.trim()) {
        throw new Error(
            `Cannot tamper signature for ${target.appcastKey}: signature is missing.`,
        );
    }
    next.platforms[target.appcastKey].signature = `${previous.trim()}tampered`;
    return next;
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
        "| Target | Platform | Architecture | Appcast key | Manual installer | Updater asset |",
        "| --- | --- | --- | --- | --- | --- |",
    ];

    for (const row of rows) {
        lines.push(
            `| \`${row.buildTarget}\` | ${row.platformLabel} | ${row.architectureLabel} | \`${row.appcastKey}\` | \`${row.manualAssetName}\` | \`${row.updaterAssetName}\` |`,
        );
    }

    lines.push("", "## Global Procedure", "");
    lines.push(
        "1. Install the previous public version for the target, or perform a clean install when validating first-run packaging.",
    );
    lines.push(
        "2. Serve `fixtures/` from this pack on `127.0.0.1` and point the app to the loopback `stable/latest.json` feed.",
    );
    lines.push(
        "3. Confirm `Settings > Updates` reports the expected target before installing anything.",
    );
    lines.push(
        "4. Run the valid feed once, then switch to the invalid-signature fixture for the same target and confirm install is blocked.",
    );
    lines.push(
        "5. Repeat with an unsaved editor tab or pending agent work and confirm the inline confirmation gate appears before restart.",
    );
    lines.push(
        "6. Complete one successful install and verify the app restarts on the new version.",
    );

    for (const row of rows) {
        lines.push("", `## ${row.platformLabel} ${row.architectureLabel}`, "");
        if (row.feedUrl) {
            lines.push(`Published feed: \`${row.feedUrl}\``);
            lines.push("");
        }
        lines.push(`Manual installer: \`${row.manualAssetName}\``);
        lines.push(`Updater asset: \`${row.updaterAssetName}\``);
        lines.push(`Target in UI: \`${row.appcastKey}\``);
        lines.push(
            `Invalid-signature fixture: \`fixtures/${row.appcastKey}/invalid-signature/${channel}/latest.json\``,
        );
        lines.push(
            `Expected updater artifact family: ${row.updaterArtifactKind}`,
        );
        lines.push("");
        lines.push("Checks:");
        for (const item of PLATFORM_VALIDATION_CASES) {
            lines.push(`- [ ] ${item}`);
        }
        if (row.buildTarget === "aarch64-pc-windows-msvc") {
            lines.push(
                "- [ ] Validate the embedded runtime files for Windows ARM64 explicitly.",
            );
            lines.push("Expected embedded resources:");
            for (const resourcePath of row.embeddedResourcePaths) {
                lines.push(`- \`${resourcePath}\``);
            }
        }
    }

    return `${lines.join("\n")}\n`;
}
