import test from "node:test";
import assert from "node:assert/strict";

import {
    CANONICAL_RELEASE_PAGES_BASE_URL,
    CANONICAL_RELEASE_REPO_SLUG,
    buildUpdaterReleaseAssetName,
    buildChannelAppcastUrl,
    buildGitHubPagesBaseUrl,
    buildPublicReleaseAssetName,
    createStaticAppcastManifest,
    describeUpdaterArtifactKind,
    getCanonicalAppBundleName,
    getBundledUpdaterArtifactName,
    getAppcastPublishPath,
    getSignatureAssetName,
    normalizePlatformEntries,
} from "./appcast-lib.mjs";

test("buildGitHubPagesBaseUrl returns the project pages base URL", () => {
    assert.equal(
        buildGitHubPagesBaseUrl(CANONICAL_RELEASE_REPO_SLUG),
        CANONICAL_RELEASE_PAGES_BASE_URL,
    );
});

test("getAppcastPublishPath returns channel/latest.json", () => {
    assert.equal(getAppcastPublishPath("stable"), "stable/latest.json");
    assert.equal(getAppcastPublishPath("beta"), "beta/latest.json");
});

test("buildChannelAppcastUrl joins the public base url and channel path", () => {
    assert.equal(
        buildChannelAppcastUrl(
            `${CANONICAL_RELEASE_PAGES_BASE_URL}/`,
            "stable",
        ),
        `${CANONICAL_RELEASE_PAGES_BASE_URL}/stable/latest.json`,
    );
});

test("buildPublicReleaseAssetName uses the human-facing naming convention", () => {
    assert.equal(
        buildPublicReleaseAssetName("0.2.0", "universal-apple-darwin"),
        "NeverWrite_0.2.0_macOS_Universal.dmg",
    );
    assert.equal(
        buildPublicReleaseAssetName("0.2.0", "x86_64-pc-windows-msvc"),
        "NeverWrite_0.2.0_Windows_x64_Setup.exe",
    );
});

test("describeUpdaterArtifactKind documents updater archive families", () => {
    assert.equal(
        describeUpdaterArtifactKind("universal-apple-darwin"),
        "macOS updater archive (.app.tar.gz)",
    );
    assert.equal(
        describeUpdaterArtifactKind("aarch64-pc-windows-msvc"),
        "Windows updater archive (.nsis.zip)",
    );
    assert.equal(
        getSignatureAssetName("NeverWrite.app.tar.gz"),
        "NeverWrite.app.tar.gz.sig",
    );
});

test("canonical bundle and updater artifact names are fixed for v1 release automation", () => {
    assert.equal(getCanonicalAppBundleName(), "NeverWrite.app");
    assert.equal(
        getBundledUpdaterArtifactName("universal-apple-darwin"),
        "NeverWrite.app.tar.gz",
    );
    assert.equal(
        getBundledUpdaterArtifactName("x86_64-pc-windows-msvc"),
        "NeverWrite-setup.nsis.zip",
    );
    assert.equal(
        buildUpdaterReleaseAssetName("0.2.0", "universal-apple-darwin"),
        "NeverWrite_0.2.0_macOS_Universal.app.tar.gz",
    );
    assert.equal(
        buildUpdaterReleaseAssetName("0.2.0", "x86_64-pc-windows-msvc"),
        "NeverWrite_0.2.0_Windows_x64.nsis.zip",
    );
});

test("normalizePlatformEntries accepts build targets and emits appcast keys", () => {
    assert.deepEqual(
        normalizePlatformEntries({
            "universal-apple-darwin": {
                url: "https://example.com/macos-universal.tar.gz",
                signature: "sig-a",
            },
            "x86_64-pc-windows-msvc": {
                url: "https://example.com/windows-x64.zip",
                signature: "sig-b",
            },
        }),
        {
            "darwin-universal": {
                url: "https://example.com/macos-universal.tar.gz",
                signature: "sig-a",
            },
            "windows-x86_64": {
                url: "https://example.com/windows-x64.zip",
                signature: "sig-b",
            },
        },
    );
});

test("createStaticAppcastManifest requires all v1 platform keys and preserves order", () => {
    const manifest = createStaticAppcastManifest({
        version: "v0.2.0",
        notes: "## Added\n\n- Multi-target appcast.",
        pubDate: "2026-04-04T18:00:00Z",
        platforms: {
            "x86_64-pc-windows-msvc": {
                url: "https://example.com/windows-x64.zip",
                signature: "sig-wx64",
            },
            "universal-apple-darwin": {
                url: "https://example.com/macos-universal.tar.gz",
                signature: "sig-muniv",
            },
            "aarch64-pc-windows-msvc": {
                url: "https://example.com/windows-arm64.zip",
                signature: "sig-warm",
            },
        },
    });

    assert.deepEqual(Object.keys(manifest.platforms), [
        "darwin-universal",
        "windows-aarch64",
        "windows-x86_64",
    ]);
    assert.equal(manifest.version, "0.2.0");
    assert.equal(manifest.pub_date, "2026-04-04T18:00:00Z");
});

test("createStaticAppcastManifest rejects missing v1 platforms", () => {
    assert.throws(
        () =>
            createStaticAppcastManifest({
                version: "0.2.0",
                notes: "- notes",
                pubDate: "2026-04-04T18:00:00Z",
                platforms: {
                    "darwin-universal": {
                        url: "https://example.com/macos-universal.tar.gz",
                        signature: "sig",
                    },
                },
            }),
        /missing required v1 platforms/i,
    );
});
