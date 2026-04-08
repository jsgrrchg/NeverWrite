import assert from "node:assert/strict";
import test from "node:test";

import {
    buildAppcastPlatformsFromTargetMetadata,
    buildPlatformValidationMatrix,
    createInvalidSignatureManifest,
    renderPlatformValidationChecklist,
    resolveValidationTarget,
    validateTargetMetadataEntries,
} from "./platform-validation-lib.mjs";

function buildManifest() {
    return {
        version: "0.2.0",
        notes: "## Added\n\n- Test release.",
        pub_date: "2026-04-04T18:00:00Z",
        platforms: {
            "darwin-aarch64": {
                url: "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_macOS_AppleSilicon.app.tar.gz",
                signature: "sig-darwin-arm64",
            },
            "darwin-x86_64": {
                url: "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_macOS_Intel.app.tar.gz",
                signature: "sig-darwin-x64",
            },
            "windows-aarch64": {
                url: "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_Windows_ARM64.nsis.zip",
                signature: "sig-win-arm64",
            },
            "windows-x86_64": {
                url: "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_Windows_x64.nsis.zip",
                signature: "sig-win-x64",
            },
        },
    };
}

function buildMetadataEntries() {
    return [
        {
            buildTarget: "aarch64-apple-darwin",
            appcastKey: "darwin-aarch64",
            manualAssetName: "NeverWrite_0.2.0_macOS_AppleSilicon.dmg",
            updaterAssetName: "NeverWrite_0.2.0_macOS_AppleSilicon.app.tar.gz",
            updaterSignatureAssetName:
                "NeverWrite_0.2.0_macOS_AppleSilicon.app.tar.gz.sig",
            updaterUrl:
                "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_macOS_AppleSilicon.app.tar.gz",
            updaterSignature: "sig-darwin-arm64",
        },
        {
            buildTarget: "x86_64-apple-darwin",
            appcastKey: "darwin-x86_64",
            manualAssetName: "NeverWrite_0.2.0_macOS_Intel.dmg",
            updaterAssetName: "NeverWrite_0.2.0_macOS_Intel.app.tar.gz",
            updaterSignatureAssetName:
                "NeverWrite_0.2.0_macOS_Intel.app.tar.gz.sig",
            updaterUrl:
                "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_macOS_Intel.app.tar.gz",
            updaterSignature: "sig-darwin-x64",
        },
        {
            buildTarget: "aarch64-pc-windows-msvc",
            appcastKey: "windows-aarch64",
            manualAssetName: "NeverWrite_0.2.0_Windows_ARM64_Setup.exe",
            updaterAssetName: "NeverWrite_0.2.0_Windows_ARM64.nsis.zip",
            updaterSignatureAssetName:
                "NeverWrite_0.2.0_Windows_ARM64.nsis.zip.sig",
            updaterUrl:
                "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_Windows_ARM64.nsis.zip",
            updaterSignature: "sig-win-arm64",
        },
        {
            buildTarget: "x86_64-pc-windows-msvc",
            appcastKey: "windows-x86_64",
            manualAssetName: "NeverWrite_0.2.0_Windows_x64_Setup.exe",
            updaterAssetName: "NeverWrite_0.2.0_Windows_x64.nsis.zip",
            updaterSignatureAssetName:
                "NeverWrite_0.2.0_Windows_x64.nsis.zip.sig",
            updaterUrl:
                "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_Windows_x64.nsis.zip",
            updaterSignature: "sig-win-x64",
        },
    ];
}

test("resolveValidationTarget accepts build targets and appcast keys", () => {
    assert.deepEqual(resolveValidationTarget("aarch64-apple-darwin"), {
        buildTarget: "aarch64-apple-darwin",
        appcastKey: "darwin-aarch64",
        platformLabel: "macOS",
        architectureLabel: "Apple Silicon",
        updaterArtifactKind: "macOS updater archive (.app.tar.gz)",
        embeddedResourcePaths: [
            "binaries/codex-acp",
            "embedded/node/bin/node",
            "embedded/claude-agent-acp/dist/index.js",
        ],
    });
    assert.equal(
        resolveValidationTarget("windows-x86_64").buildTarget,
        "x86_64-pc-windows-msvc",
    );
});

test("validateTargetMetadataEntries rejects duplicate updater assets", () => {
    const duplicated = buildMetadataEntries();
    duplicated[1] = {
        ...duplicated[1],
        updaterAssetName: duplicated[0].updaterAssetName,
    };

    assert.throws(
        () => validateTargetMetadataEntries(duplicated),
        /reuses updaterAssetName/i,
    );
});

test("buildAppcastPlatformsFromTargetMetadata preserves the canonical v1 key order", () => {
    const platforms = buildAppcastPlatformsFromTargetMetadata(
        buildMetadataEntries(),
    );

    assert.deepEqual(Object.keys(platforms), [
        "darwin-aarch64",
        "darwin-x86_64",
        "windows-aarch64",
        "windows-x86_64",
    ]);
    assert.equal(
        platforms["windows-x86_64"].url,
        "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_Windows_x64.nsis.zip",
    );
});

test("buildPlatformValidationMatrix aligns manifest and target metadata", () => {
    const rows = buildPlatformValidationMatrix({
        version: "0.2.0",
        tag: "v0.2.0",
        channel: "stable",
        appcastBaseUrl: "https://jsgrrchg.github.io/NeverWrite",
        manifest: buildManifest(),
        metadataEntries: buildMetadataEntries(),
    });

    assert.equal(rows.length, 4);
    assert.equal(rows[0].buildTarget, "aarch64-apple-darwin");
    assert.equal(
        rows[0].feedUrl,
        "https://jsgrrchg.github.io/NeverWrite/stable/latest.json",
    );
    assert.equal(rows[3].appcastKey, "windows-x86_64");
});

test("createInvalidSignatureManifest only tampers the requested platform", () => {
    const manifest = buildManifest();
    const tampered = createInvalidSignatureManifest(manifest, "windows-x86_64");

    assert.equal(
        tampered.platforms["windows-x86_64"].signature,
        "sig-win-x64tampered",
    );
    assert.equal(
        tampered.platforms["windows-aarch64"].signature,
        manifest.platforms["windows-aarch64"].signature,
    );
});

test("renderPlatformValidationChecklist includes invalid signature fixtures", () => {
    const rows = buildPlatformValidationMatrix({
        version: "0.2.0",
        tag: "v0.2.0",
        channel: "stable",
        appcastBaseUrl: "https://jsgrrchg.github.io/NeverWrite",
        manifest: buildManifest(),
        metadataEntries: buildMetadataEntries(),
    });

    const markdown = renderPlatformValidationChecklist({
        rows,
        channel: "stable",
        version: "0.2.0",
        tag: "v0.2.0",
    });

    assert.match(
        markdown,
        /fixtures\/darwin-aarch64\/invalid-signature\/stable\/latest\.json/,
    );
    assert.match(
        markdown,
        /Validate the embedded runtime files for Windows ARM64 explicitly/,
    );
});
