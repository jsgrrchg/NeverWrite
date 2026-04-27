import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const stageScriptPath = path.join(
    repoRoot,
    "apps/desktop/scripts/stage-electron-release-assets.mjs",
);

function withTempDir(run) {
    const tempDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "neverwrite-electron-stage-assets-"),
    );
    try {
        run(tempDir);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function writeFile(filePath, contents) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, contents);
}

test("stage-electron-release-assets rewrites macOS feed metadata", () => {
    withTempDir((tempDir) => {
        const distDir = path.join(tempDir, "dist");
        const outputDir = path.join(tempDir, "staged");
        const metadataOut = path.join(
            tempDir,
            "metadata",
            "darwin-universal.json",
        );

        writeFile(path.join(distDir, "NeverWrite.dmg"), "manual");
        writeFile(path.join(distDir, "NeverWrite.zip"), "updater");
        writeFile(path.join(distDir, "NeverWrite.zip.blockmap"), "blockmap");
        writeFile(
            path.join(distDir, "latest-mac.yml"),
            [
                "version: 0.2.0",
                "path: NeverWrite.zip",
                "sha512: original",
                "files:",
                "  - url: NeverWrite.zip",
                "    sha512: original",
                "  - url: NeverWrite.dmg",
                "    sha512: manual",
                "",
            ].join("\n"),
        );

        execFileSync(
            process.execPath,
            [
                stageScriptPath,
                "--dist-dir",
                distDir,
                "--target",
                "universal-apple-darwin",
                "--version",
                "0.2.0",
                "--tag",
                "v0.2.0",
                "--repo",
                "jsgrrchg/NeverWrite",
                "--output-dir",
                outputDir,
                "--metadata-out",
                metadataOut,
            ],
            {
                cwd: repoRoot,
                stdio: "pipe",
            },
        );

        const metadata = JSON.parse(fs.readFileSync(metadataOut, "utf8"));
        const rewrittenFeed = fs.readFileSync(
            path.join(outputDir, "feeds", "darwin-universal", "latest-mac.yml"),
            "utf8",
        );

        assert.equal(
            metadata.feedRelativePath,
            "darwin-universal/latest-mac.yml",
        );
        assert.equal(
            metadata.updaterAssetName,
            "NeverWrite_0.2.0_macOS_Universal.zip",
        );
        assert.equal(metadata.manualAssetSizeBytes, 6);
        assert.equal(metadata.updaterAssetSizeBytes, 7);
        assert.equal(metadata.updaterBlockmapSizeBytes, 8);
        assert.match(
            rewrittenFeed,
            /https:\/\/github\.com\/jsgrrchg\/NeverWrite\/releases\/download\/v0\.2\.0\/NeverWrite_0\.2\.0_macOS_Universal\.zip/,
        );
        assert.match(
            rewrittenFeed,
            /files:\n\s+- url: https:\/\/github\.com\/jsgrrchg\/NeverWrite\/releases\/download\/v0\.2\.0\/NeverWrite_0\.2\.0_macOS_Universal\.zip/,
        );
        assert.match(
            rewrittenFeed,
            /\n\s+- url: https:\/\/github\.com\/jsgrrchg\/NeverWrite\/releases\/download\/v0\.2\.0\/NeverWrite_0\.2\.0_macOS_Universal\.dmg/,
        );
        assert.doesNotMatch(
            rewrittenFeed,
            /\n\s+- url: NeverWrite\.zip/,
        );
        assert.doesNotMatch(
            rewrittenFeed,
            /\n\s+- url: NeverWrite\.dmg/,
        );
    });
});

test("stage-electron-release-assets keeps Windows metadata target-specific", () => {
    withTempDir((tempDir) => {
        const distDir = path.join(tempDir, "dist");
        const outputDir = path.join(tempDir, "staged");
        const metadataOut = path.join(tempDir, "metadata", "windows-x64.json");

        writeFile(path.join(distDir, "win-unpacked", "NeverWrite.exe"), "app");
        writeFile(
            path.join(
                distDir,
                "win-unpacked",
                "resources",
                "native-backend",
                "neverwrite-native-backend.exe",
            ),
            "backend",
        );
        writeFile(
            path.join(
                distDir,
                "win-unpacked",
                "resources",
                "native-backend",
                "binaries",
                "codex-acp.exe",
            ),
            "codex",
        );
        writeFile(
            path.join(
                distDir,
                "win-unpacked",
                "resources",
                "native-backend",
                "embedded",
                "node",
                "node.exe",
            ),
            "node",
        );
        writeFile(path.join(distDir, "NeverWrite Setup.exe"), "installer");
        writeFile(
            path.join(distDir, "NeverWrite Setup.exe.blockmap"),
            "blockmap",
        );
        writeFile(
            path.join(distDir, "latest.yml"),
            [
                "version: 0.2.0",
                "path: NeverWrite Setup.exe",
                "sha512: original",
                "files:",
                "  - url: NeverWrite Setup.exe",
                "    sha512: original",
                "",
            ].join("\n"),
        );

        execFileSync(
            process.execPath,
            [
                stageScriptPath,
                "--dist-dir",
                distDir,
                "--target",
                "x86_64-pc-windows-msvc",
                "--version",
                "0.2.0",
                "--tag",
                "v0.2.0",
                "--repo",
                "jsgrrchg/NeverWrite",
                "--output-dir",
                outputDir,
                "--metadata-out",
                metadataOut,
            ],
            {
                cwd: repoRoot,
                stdio: "pipe",
            },
        );

        const metadata = JSON.parse(fs.readFileSync(metadataOut, "utf8"));

        assert.equal(metadata.feedTarget, "windows-x64");
        assert.equal(metadata.metadataFileName, "latest.yml");
        assert.equal(
            metadata.updaterAssetName,
            "NeverWrite_0.2.0_Windows_x64_Setup.exe",
        );
        assert.equal(
            metadata.updaterBlockmapAssetName,
            "NeverWrite_0.2.0_Windows_x64_Setup.exe.blockmap",
        );
        assert.equal(metadata.feedRelativePath, "windows-x64/latest.yml");
    });
});
