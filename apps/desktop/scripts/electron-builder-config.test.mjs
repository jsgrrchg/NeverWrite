import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import config from "../electron-builder.config.mjs";
import packageJson from "../package.json" with { type: "json" };
import verifyElectronBundle, {
    REQUIRED_RESOURCE_PATHS,
    verifyPackagedResources,
} from "./verify-electron-bundle.mjs";

const require = createRequire(import.meta.url);
const minimatch = require("minimatch");
const { validateConfiguration } = require("app-builder-lib/out/util/config/config");

test("electron-builder config matches the installed schema", async () => {
    await assert.doesNotReject(() => validateConfiguration(config));
});

test("macOS universal x64ArchFiles covers packaged native binaries", () => {
    const pattern = config.mac.x64ArchFiles;

    assert.equal(typeof pattern, "string");
    assert.equal(
        minimatch(
            "Contents/Resources/native-backend/binaries/codex-acp",
            pattern,
        ),
        true,
    );
    assert.equal(
        minimatch(
            "Contents/Resources/native-backend/binaries/codex-code-mode-host",
            pattern,
        ),
        true,
    );
    assert.equal(
        config.mac.binaries.includes(
            "Contents/Resources/native-backend/binaries/codex-code-mode-host",
        ),
        true,
    );
    assert.equal(
        minimatch(
            "Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node",
            pattern,
        ),
        true,
    );
    assert.equal(
        minimatch(
            "Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/canvas-darwin-x64/skia.darwin-x64.node",
            pattern,
        ),
        true,
    );
    assert.equal(
        minimatch(
            "Contents/Resources/app.asar.unpacked/node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node",
            pattern,
        ),
        false,
    );
});

test("Codex runtime resources remain outside app.asar", () => {
    assert.deepEqual(config.files, ["out/electron/**/*", "package.json"]);
    assert.deepEqual(config.extraResources[0], {
        from: "out/native-backend",
        to: "native-backend",
        filter: ["**/*"],
    });
});

async function writeResourceFixture(
    platform,
    missingRelativePath = null,
    resourcesDir = null,
) {
    if (!resourcesDir) {
        resourcesDir = await fs.mkdtemp(
            path.join(os.tmpdir(), `neverwrite-${platform}-resources-`),
        );
    }
    for (const relativePath of REQUIRED_RESOURCE_PATHS[platform]) {
        if (relativePath === missingRelativePath) continue;
        const absolutePath = path.join(resourcesDir, relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, "fixture");
        await fs.chmod(absolutePath, 0o755);
    }
    return resourcesDir;
}

test("resource verification accepts complete Codex runtime fixtures on every platform", async () => {
    for (const platform of ["darwin", "win32", "linux"]) {
        const resourcesDir = await writeResourceFixture(platform);
        try {
            assert.doesNotThrow(() =>
                verifyPackagedResources(
                    { electronPlatformName: platform },
                    resourcesDir,
                ),
            );
        } finally {
            await fs.rm(resourcesDir, { recursive: true, force: true });
        }
    }
});

test("resource verification fails when only the code-mode host is missing", async () => {
    const missingPath = "native-backend/binaries/codex-code-mode-host";
    const appOutDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "neverwrite-linux-package-"),
    );
    const resourcesDir = await writeResourceFixture(
        "linux",
        missingPath,
        path.join(appOutDir, "resources"),
    );
    try {
        await assert.rejects(
            verifyElectronBundle({
                electronPlatformName: "linux",
                appOutDir,
            }),
            /codex-code-mode-host/,
        );
    } finally {
        await fs.rm(appOutDir, { recursive: true, force: true });
    }
});

test("desktop app icons are wired for all packaged platforms", () => {
    assert.equal(config.mac.icon, "build/icons/icon.icns");
    assert.equal(config.win.icon, "build/icons/icon.ico");
    assert.equal(config.linux.icon, "build/icons/icon.png");
    assert.deepEqual(config.linux.target, ["AppImage", "deb", "rpm"]);
    assert.equal(config.nsis.installerIcon, "build/icons/icon.ico");
    assert.equal(config.nsis.uninstallerIcon, "build/icons/icon.ico");
    assert.equal(config.nsis.installerHeaderIcon, "build/icons/icon.ico");
});

test("Debian package metadata is stable for Ubuntu/Debian releases", () => {
    assert.equal(packageJson.homepage, "https://github.com/jsgrrchg/NeverWrite");
    assert.equal(config.deb.packageName, "neverwrite");
    assert.equal(config.deb.packageCategory, "utils");
    assert.equal(config.deb.priority, "optional");
    assert.equal(
        config.deb.maintainer,
        "NeverWrite Maintainers <jsgrrchg@users.noreply.github.com>",
    );
    assert.equal(config.deb.artifactName, "${productName}-${version}-${arch}.deb");
    assert.equal(config.deb.publish, null);
    assert.equal(config.deb.synopsis, "AI-powered writing workspace");
});

test("RPM package metadata is stable for Fedora/RHEL releases", () => {
    assert.equal(config.rpm.packageName, "neverwrite");
    assert.equal(
        config.rpm.maintainer,
        "NeverWrite Maintainers <jsgrrchg@users.noreply.github.com>",
    );
    assert.equal(config.rpm.artifactName, "${productName}-${version}-${arch}.rpm");
    assert.equal(config.rpm.publish, null);
});
