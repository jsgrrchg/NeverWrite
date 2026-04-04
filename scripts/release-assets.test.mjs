import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    buildManualDownloadRows,
    buildReleaseBody,
    collectBundleArtifacts,
    requiredStagedResourcePaths,
    runtimeBinaryFileName,
    stageReleaseAssets,
    validateMacosBundleResources,
    validateStagedRuntimeResources,
} from "./release-assets-lib.mjs";

function withTempDir(callback) {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "vaultai-release-assets-"),
    );
    try {
        callback(tempDir);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

test("runtimeBinaryFileName follows target platform conventions", () => {
    assert.equal(
        runtimeBinaryFileName("x86_64-apple-darwin", "codex-acp"),
        "codex-acp",
    );
    assert.equal(
        runtimeBinaryFileName("x86_64-pc-windows-msvc", "codex-acp"),
        "codex-acp.exe",
    );
});

test("validateStagedRuntimeResources checks bundled runtime staging inputs", () => {
    withTempDir((tempDir) => {
        for (const relativePath of requiredStagedResourcePaths(
            "x86_64-pc-windows-msvc",
        )) {
            const absolutePath = path.join(tempDir, relativePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, "ok");
        }

        assert.doesNotThrow(() =>
            validateStagedRuntimeResources(tempDir, "x86_64-pc-windows-msvc"),
        );

        fs.rmSync(path.join(tempDir, "binaries", "codex-acp.exe"));
        assert.throws(
            () =>
                validateStagedRuntimeResources(
                    tempDir,
                    "x86_64-pc-windows-msvc",
                ),
            /Missing staged runtime resources/i,
        );
    });
});

test("buildManualDownloadRows exposes the public installer set for humans", () => {
    assert.deepEqual(buildManualDownloadRows("0.2.0"), [
        {
            buildTarget: "aarch64-apple-darwin",
            platformLabel: "macOS",
            architectureLabel: "Apple Silicon",
            assetName: "VaultAI_0.2.0_macOS_AppleSilicon.dmg",
        },
        {
            buildTarget: "x86_64-apple-darwin",
            platformLabel: "macOS",
            architectureLabel: "Intel",
            assetName: "VaultAI_0.2.0_macOS_Intel.dmg",
        },
        {
            buildTarget: "aarch64-pc-windows-msvc",
            platformLabel: "Windows",
            architectureLabel: "ARM64",
            assetName: "VaultAI_0.2.0_Windows_ARM64_Setup.exe",
        },
        {
            buildTarget: "x86_64-pc-windows-msvc",
            platformLabel: "Windows",
            architectureLabel: "x64",
            assetName: "VaultAI_0.2.0_Windows_x64_Setup.exe",
        },
    ]);
});

test("buildReleaseBody distinguishes manual installers from internal updater assets", () => {
    const body = buildReleaseBody(
        "0.2.0",
        "## Added\n\n- Manual packaging polish.",
    );
    assert.match(body, /## Manual installers/);
    assert.match(body, /VaultAI_0.2.0_macOS_AppleSilicon\.dmg/);
    assert.match(body, /VaultAI_0.2.0_Windows_x64_Setup\.exe/);
    assert.match(body, /internal updater assets/i);
    assert.match(body, /## Release notes/);
});

test("collectBundleArtifacts locates macOS bundles and updater archives", () => {
    withTempDir((tempDir) => {
        const dmgDir = path.join(tempDir, "dmg");
        const macosDir = path.join(tempDir, "macos");
        fs.mkdirSync(dmgDir, { recursive: true });
        fs.mkdirSync(macosDir, { recursive: true });

        fs.writeFileSync(path.join(dmgDir, "VaultAI.dmg"), "dmg");
        fs.writeFileSync(path.join(macosDir, "VaultAI.app.tar.gz"), "tar");
        fs.writeFileSync(path.join(macosDir, "VaultAI.app.tar.gz.sig"), "sig");
        fs.mkdirSync(path.join(macosDir, "VaultAI.app"));

        const artifacts = collectBundleArtifacts(
            tempDir,
            "aarch64-apple-darwin",
        );
        assert.equal(path.basename(artifacts.manualAssetPath), "VaultAI.dmg");
        assert.equal(
            path.basename(artifacts.updaterAssetPath),
            "VaultAI.app.tar.gz",
        );
        assert.equal(
            path.basename(artifacts.updaterSignaturePath),
            "VaultAI.app.tar.gz.sig",
        );
        assert.equal(path.basename(artifacts.appBundlePath), "VaultAI.app");
    });
});

test("validateMacosBundleResources ensures resources exist inside the app bundle", () => {
    withTempDir((tempDir) => {
        const appBundlePath = path.join(tempDir, "VaultAI.app");
        const resourcesDir = path.join(appBundlePath, "Contents", "Resources");
        for (const relativePath of requiredStagedResourcePaths(
            "x86_64-apple-darwin",
        )) {
            const absolutePath = path.join(resourcesDir, relativePath);
            fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
            fs.writeFileSync(absolutePath, "ok");
        }

        assert.doesNotThrow(() =>
            validateMacosBundleResources(appBundlePath, "x86_64-apple-darwin"),
        );
    });
});

test("stageReleaseAssets renames manual installers and emits appcast metadata", () => {
    withTempDir((tempDir) => {
        const bundleRoot = path.join(tempDir, "bundle");
        const nsisDir = path.join(bundleRoot, "nsis");
        const outputDir = path.join(tempDir, "staged");
        fs.mkdirSync(nsisDir, { recursive: true });

        fs.writeFileSync(
            path.join(nsisDir, "VaultAI_0.2.0_x64-setup.exe"),
            "installer",
        );
        fs.writeFileSync(
            path.join(nsisDir, "VaultAI-setup.nsis.zip"),
            "updater",
        );
        fs.writeFileSync(
            path.join(nsisDir, "VaultAI-setup.nsis.zip.sig"),
            "sig-win-x64",
        );

        const metadata = stageReleaseAssets({
            bundleRoot,
            buildTarget: "x86_64-pc-windows-msvc",
            version: "0.2.0",
            tag: "v0.2.0",
            repoSlug: "vaultai/vaultai",
            outputDir,
        });

        assert.equal(
            metadata.manualAssetName,
            "VaultAI_0.2.0_Windows_x64_Setup.exe",
        );
        assert.equal(metadata.appcastKey, "windows-x86_64");
        assert.equal(
            metadata.updaterUrl,
            "https://github.com/vaultai/vaultai/releases/download/v0.2.0/VaultAI-setup.nsis.zip",
        );
        assert.equal(metadata.updaterSignature, "sig-win-x64");
        assert.ok(
            fs.existsSync(
                path.join(outputDir, "VaultAI_0.2.0_Windows_x64_Setup.exe"),
            ),
        );
        assert.ok(
            fs.existsSync(path.join(outputDir, "VaultAI-setup.nsis.zip")),
        );
        assert.ok(
            fs.existsSync(path.join(outputDir, "VaultAI-setup.nsis.zip.sig")),
        );
    });
});
