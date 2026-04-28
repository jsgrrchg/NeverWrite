import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

import config from "../electron-builder.config.mjs";

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
