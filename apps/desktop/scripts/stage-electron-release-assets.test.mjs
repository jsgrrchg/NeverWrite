import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { parseDocument } from "yaml";

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

function sha512Base64(contents) {
    return crypto.createHash("sha512").update(contents).digest("base64");
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
        assert.equal(rewrittenFeed.includes(sha512Base64("updater")), true);
        assert.equal(rewrittenFeed.includes(sha512Base64("manual")), true);
        assert.doesNotMatch(
            rewrittenFeed,
            /\n\s+- url: NeverWrite\.zip/,
        );
        assert.doesNotMatch(
            rewrittenFeed,
            /\n\s+- url: NeverWrite\.dmg/,
        );
        assert.doesNotMatch(rewrittenFeed, /sha512: original/);
        assert.doesNotMatch(rewrittenFeed, /sha512: manual/);
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

test("stage-electron-release-assets stages Linux AppImage feeds", () => {
    withTempDir((tempDir) => {
        const distDir = path.join(tempDir, "dist");
        const outputDir = path.join(tempDir, "staged");
        const metadataOut = path.join(tempDir, "metadata", "linux-x64.json");

        writeFile(path.join(distDir, "linux-unpacked", "neverwrite"), "app");
        writeFile(
            path.join(
                distDir,
                "linux-unpacked",
                "resources",
                "native-backend",
                "neverwrite-native-backend",
            ),
            "backend",
        );
        writeFile(
            path.join(
                distDir,
                "linux-unpacked",
                "resources",
                "native-backend",
                "binaries",
                "codex-acp",
            ),
            "codex",
        );
        writeFile(
            path.join(
                distDir,
                "linux-unpacked",
                "resources",
                "native-backend",
                "embedded",
                "node",
                "bin",
                "node",
            ),
            "node",
        );
        writeFile(
            path.join(distDir, "NeverWrite-0.2.0-x86_64.AppImage"),
            "appimage",
        );
        writeFile(
            path.join(distDir, "latest-linux.yml"),
            [
                "version: 0.2.0",
                "path: NeverWrite-0.2.0-x64.AppImage",
                "sha512: original",
                "files:",
                "  - url: NeverWrite-0.2.0-x64.AppImage",
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
                "x86_64-unknown-linux-gnu",
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
            path.join(outputDir, "feeds", "linux-x64", "latest-linux.yml"),
            "utf8",
        );

        assert.equal(metadata.feedTarget, "linux-x64");
        assert.equal(metadata.metadataFileName, "latest-linux.yml");
        assert.equal(metadata.manualAssetName, "NeverWrite-0.2.0-x64.AppImage");
        assert.equal(metadata.updaterAssetName, "NeverWrite-0.2.0-x64.AppImage");
        assert.equal(metadata.updaterBlockmapAssetName, null);
        assert.equal(metadata.updaterBlockmapSizeBytes, 0);
        assert.equal(metadata.feedRelativePath, "linux-x64/latest-linux.yml");
        assert.deepEqual(metadata.feedAliasRelativePaths, []);
        assert.equal(
            fs.existsSync(
                path.join(outputDir, "NeverWrite-0.2.0-x64.AppImage.blockmap"),
            ),
            false,
        );
        assert.match(
            rewrittenFeed,
            /https:\/\/github\.com\/jsgrrchg\/NeverWrite\/releases\/download\/v0\.2\.0\/NeverWrite-0\.2\.0-x64\.AppImage/,
        );
    });
});

test("stage-electron-release-assets synthesizes missing Linux AppImage feeds", () => {
    withTempDir((tempDir) => {
        const distDir = path.join(tempDir, "dist");
        const outputDir = path.join(tempDir, "staged");
        const metadataOut = path.join(tempDir, "metadata", "linux-arm64.json");
        const appImageContents = "arm64 appimage";
        const appImageSha512 = sha512Base64(appImageContents);

        writeFile(
            path.join(distDir, "NeverWrite-0.2.0-arm64.AppImage"),
            appImageContents,
        );

        execFileSync(
            process.execPath,
            [
                stageScriptPath,
                "--dist-dir",
                distDir,
                "--target",
                "aarch64-unknown-linux-gnu",
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
            path.join(outputDir, "feeds", "linux-arm64", "latest-linux.yml"),
            "utf8",
        );

        assert.equal(metadata.feedTarget, "linux-arm64");
        assert.equal(metadata.metadataFileName, "latest-linux.yml");
        assert.equal(metadata.manualAssetName, "NeverWrite-0.2.0-arm64.AppImage");
        assert.equal(metadata.updaterAssetName, "NeverWrite-0.2.0-arm64.AppImage");
        assert.equal(metadata.updaterBlockmapAssetName, null);
        assert.equal(metadata.updaterBlockmapSizeBytes, 0);
        assert.equal(metadata.feedRelativePath, "linux-arm64/latest-linux.yml");
        assert.deepEqual(metadata.feedAliasRelativePaths, [
            "linux-arm64/latest-linux-arm64.yml",
        ]);

        const aliasFeed = fs.readFileSync(
            path.join(outputDir, "feeds", "linux-arm64", "latest-linux-arm64.yml"),
            "utf8",
        );
        assert.equal(aliasFeed, rewrittenFeed);

        const feedDocument = parseDocument(rewrittenFeed);
        const updaterUrl =
            "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.2.0/NeverWrite-0.2.0-arm64.AppImage";
        assert.equal(feedDocument.get("version"), "0.2.0");
        assert.equal(
            Number.isNaN(Date.parse(feedDocument.get("releaseDate"))),
            false,
        );
        assert.equal(feedDocument.get("path"), updaterUrl);
        assert.equal(feedDocument.get("sha512"), appImageSha512);

        const files = feedDocument.get("files", true);
        assert.equal(files.items.length, 1);
        assert.equal(files.items[0].get("url"), updaterUrl);
        assert.equal(files.items[0].get("sha512"), appImageSha512);
        assert.equal(files.items[0].get("size"), 14);
    });
});

test("stage-electron-release-assets requires generated Linux x64 feeds", () => {
    withTempDir((tempDir) => {
        const distDir = path.join(tempDir, "dist");
        const outputDir = path.join(tempDir, "staged");
        const metadataOut = path.join(tempDir, "metadata", "linux-x64.json");

        writeFile(
            path.join(distDir, "NeverWrite-0.2.0-x86_64.AppImage"),
            "x64 appimage",
        );

        assert.throws(
            () =>
                execFileSync(
                    process.execPath,
                    [
                        stageScriptPath,
                        "--dist-dir",
                        distDir,
                        "--target",
                        "x86_64-unknown-linux-gnu",
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
                ),
            /Expected exactly one latest-linux\.yml feed/,
        );
    });
});
