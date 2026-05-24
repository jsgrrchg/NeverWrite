import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import config from "../electron-builder.config.mjs";
import packageJson from "../package.json" with { type: "json" };

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

test("desktop app icons are wired for all packaged platforms", () => {
    assert.equal(config.mac.icon, "build/icons/icon.icns");
    assert.equal(config.win.icon, "build/icons/icon.ico");
    assert.equal(config.linux.icon, "build/icons/icon.png");
    assert.deepEqual(config.linux.target, ["AppImage", "deb"]);
    assert.equal(config.nsis.installerIcon, "build/icons/icon.ico");
    assert.equal(config.nsis.uninstallerIcon, "build/icons/icon.ico");
    assert.equal(config.nsis.installerHeaderIcon, "build/icons/icon.ico");
});

test("Debian package metadata is stable for Ubuntu/Debian releases", () => {
    assert.equal(packageJson.homepage, "https://github.com/jsgrrchg/NeverWrite");
    assert.equal(config.deb.packageName, "neverwrite");
    assert.equal(config.deb.packageCategory, "utils");
    assert.equal(config.deb.priority, "optional");
    assert.equal(config.deb.artifactName, "${productName}-${version}-${arch}.deb");
    assert.equal(config.deb.publish, null);
    assert.equal(config.deb.synopsis, "AI-powered writing workspace");
});
