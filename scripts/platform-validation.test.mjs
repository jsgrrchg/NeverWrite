import assert from "node:assert/strict";
import test from "node:test";

import {
    buildPlatformValidationMatrix,
    renderPlatformValidationChecklist,
    resolveValidationTarget,
    tamperFeedChecksum,
    validateTargetMetadataEntries,
} from "./platform-validation-lib.mjs";

function buildMetadataEntries() {
    return [
        {
            buildTarget: "universal-apple-darwin",
            feedTarget: "darwin-universal",
            metadataFileName: "latest-mac.yml",
            feedRelativePath: "darwin-universal/latest-mac.yml",
            manualAssetName: "NeverWrite_0.2.0_macOS_Universal.dmg",
            updaterAssetName: "NeverWrite_0.2.0_macOS_Universal.zip",
            updaterBlockmapAssetName:
                "NeverWrite_0.2.0_macOS_Universal.zip.blockmap",
            updaterUrl:
                "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_macOS_Universal.zip",
        },
        {
            buildTarget: "aarch64-pc-windows-msvc",
            feedTarget: "windows-arm64",
            metadataFileName: "latest.yml",
            feedRelativePath: "windows-arm64/latest.yml",
            manualAssetName: "NeverWrite_0.2.0_Windows_ARM64_Setup.exe",
            updaterAssetName: "NeverWrite_0.2.0_Windows_ARM64_Setup.exe",
            updaterBlockmapAssetName:
                "NeverWrite_0.2.0_Windows_ARM64_Setup.exe.blockmap",
            updaterUrl:
                "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_Windows_ARM64_Setup.exe",
        },
        {
            buildTarget: "x86_64-pc-windows-msvc",
            feedTarget: "windows-x64",
            metadataFileName: "latest.yml",
            feedRelativePath: "windows-x64/latest.yml",
            manualAssetName: "NeverWrite_0.2.0_Windows_x64_Setup.exe",
            updaterAssetName: "NeverWrite_0.2.0_Windows_x64_Setup.exe",
            updaterBlockmapAssetName:
                "NeverWrite_0.2.0_Windows_x64_Setup.exe.blockmap",
            updaterUrl:
                "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite_0.2.0_Windows_x64_Setup.exe",
        },
    ];
}

test("resolveValidationTarget accepts build targets and feed targets", () => {
    assert.deepEqual(resolveValidationTarget("universal-apple-darwin"), {
        buildTarget: "universal-apple-darwin",
        feedTarget: "darwin-universal",
        metadataFileName: "latest-mac.yml",
        platformLabel: "macOS",
        architectureLabel: "Universal",
        updaterArtifactKind: "macOS updater archive (.zip)",
    });
    assert.equal(
        resolveValidationTarget("windows-x64").buildTarget,
        "x86_64-pc-windows-msvc",
    );
});

test("validateTargetMetadataEntries rejects duplicate updater URLs", () => {
    const duplicated = buildMetadataEntries();
    duplicated[1] = {
        ...duplicated[1],
        updaterUrl: duplicated[0].updaterUrl,
    };

    assert.throws(
        () => validateTargetMetadataEntries(duplicated),
        /reuses updaterUrl/i,
    );
});

test("validateTargetMetadataEntries rejects incomplete target coverage", () => {
    assert.throws(
        () => validateTargetMetadataEntries(buildMetadataEntries().slice(0, 2)),
        /missing required build targets/i,
    );
});

test("buildPlatformValidationMatrix aligns feed URLs with target metadata", () => {
    const rows = buildPlatformValidationMatrix({
        version: "0.2.0",
        tag: "v0.2.0",
        channel: "stable",
        pagesBaseUrl: "https://jsgrrchg.github.io/NeverWrite",
        metadataEntries: buildMetadataEntries(),
    });

    assert.equal(rows.length, 3);
    assert.equal(rows[0].buildTarget, "universal-apple-darwin");
    assert.equal(
        rows[0].feedUrl,
        "https://jsgrrchg.github.io/NeverWrite/stable/darwin-universal/latest-mac.yml",
    );
    assert.equal(rows[2].feedTarget, "windows-x64");
    assert.equal(
        rows[2].updaterAssetName,
        "NeverWrite_0.2.0_Windows_x64_Setup.exe",
    );
});

test("tamperFeedChecksum only modifies the sha512 line", () => {
    const tampered = tamperFeedChecksum(`
version: 0.2.0
path: https://example.com/NeverWrite.zip
sha512: original
releaseDate: 2026-04-04T12:00:00.000Z
`);

    assert.match(tampered, /sha512: tampered/);
    assert.match(tampered, /version: 0\.2\.0/);
});

test("renderPlatformValidationChecklist includes invalid-checksum fixtures", () => {
    const markdown = renderPlatformValidationChecklist({
        rows: buildPlatformValidationMatrix({
            version: "0.2.0",
            tag: "v0.2.0",
            channel: "stable",
            pagesBaseUrl: "https://jsgrrchg.github.io/NeverWrite",
            metadataEntries: buildMetadataEntries(),
        }),
        channel: "stable",
        version: "0.2.0",
        tag: "v0.2.0",
    });

    assert.match(
        markdown,
        /fixtures\/darwin-universal\/invalid-checksum\/stable\/latest-mac\.yml/,
    );
    assert.match(
        markdown,
        /The app does not switch to another architecture feed/,
    );
});
