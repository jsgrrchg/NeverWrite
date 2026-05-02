import test from "node:test";
import assert from "node:assert/strict";

import {
    collectElectronBuildIssues,
    collectReleaseIdentityIssues,
    collectVersionIssues,
    getChangelogEntry,
    normalizeReleaseTag,
    parseChangelogEntries,
    readCargoPackageVersion,
} from "./release-metadata-lib.mjs";

test("normalizeReleaseTag accepts vX.Y.Z tags", () => {
    assert.equal(normalizeReleaseTag("v1.2.3"), "1.2.3");
});

test("normalizeReleaseTag rejects non-release tags", () => {
    assert.throws(() => normalizeReleaseTag("1.2.3"), /Expected format vX.Y.Z/);
    assert.throws(() => normalizeReleaseTag("v1.2"), /Expected format vX.Y.Z/);
});

test("readCargoPackageVersion reads the package version only", () => {
    const cargoToml = `
[package]
name = "neverwrite-desktop"
version = "0.2.0"

[dependencies]
foo = { version = "1" }
`;

    assert.equal(readCargoPackageVersion(cargoToml), "0.2.0");
});

test("collectVersionIssues reports mismatches and invalid semver", () => {
    assert.deepEqual(
        collectVersionIssues(
            {
                packageJson: "0.2.0",
                packageLock: "0.2.0",
                packageLockRoot: "0.2.0",
                nativeBackendCargo: "0.2",
                webClipperPackageJson: "0.2.0",
            },
            "0.2.0",
        ),
        [
            'nativeBackendCargo version "0.2" is not strict semver (X.Y.Z).',
            "Release versions do not match: package.json=0.2.0, package-lock.json=0.2.0, package-lock root=0.2.0, native-backend/Cargo.toml=0.2, web-clipper/package.json=0.2.0.",
        ],
    );
});

test("collectVersionIssues reports stale package-lock versions", () => {
    assert.deepEqual(
        collectVersionIssues(
            {
                packageJson: "0.2.0",
                packageLock: "0.1.0",
                packageLockRoot: "0.1.0",
                nativeBackendCargo: "0.2.0",
                webClipperPackageJson: "0.2.0",
            },
            "0.2.0",
        ),
        [
            "Release versions do not match: package.json=0.2.0, package-lock.json=0.1.0, package-lock root=0.1.0, native-backend/Cargo.toml=0.2.0, web-clipper/package.json=0.2.0.",
        ],
    );
});

test("collectVersionIssues reports stale web clipper versions", () => {
    assert.deepEqual(
        collectVersionIssues(
            {
                packageJson: "0.2.0",
                packageLock: "0.2.0",
                packageLockRoot: "0.2.0",
                nativeBackendCargo: "0.2.0",
                webClipperPackageJson: "0.1.0",
            },
            "0.2.0",
        ),
        [
            "Release versions do not match: package.json=0.2.0, package-lock.json=0.2.0, package-lock root=0.2.0, native-backend/Cargo.toml=0.2.0, web-clipper/package.json=0.1.0.",
        ],
    );
});

test("collectReleaseIdentityIssues enforces the NeverWrite desktop identity", () => {
    assert.deepEqual(
        collectReleaseIdentityIssues({
            productName: "OldProduct",
            identifier: "com.oldproduct",
        }),
        [
            'electron-builder.config.mjs productName must be "NeverWrite", received "OldProduct".',
            'electron-builder.config.mjs appId must be "com.neverwrite", received "com.oldproduct".',
        ],
    );
});

test("collectElectronBuildIssues validates the Electron release contract", () => {
    assert.deepEqual(
        collectElectronBuildIssues({
            artifactName: "${productName}-${version}-${os}-${arch}.${ext}",
            afterPack: "scripts/verify-electron-bundle.mjs",
            protocols: [{ schemes: ["neverwrite"] }],
            extraResources: [
                {
                    from: "out/native-backend",
                    to: "native-backend",
                },
            ],
            mac: {
                minimumSystemVersion: "12.0",
                target: [{ target: "dmg" }, { target: "zip" }],
            },
            win: {
                target: [{ target: "nsis" }],
            },
        }),
        [],
    );

    assert.deepEqual(
        collectElectronBuildIssues({
            artifactName: "${productName}-${version}.${ext}",
            protocols: [],
            extraResources: [],
            mac: {
                minimumSystemVersion: "11.0",
                target: ["dmg"],
            },
            win: {
                target: [],
            },
        }),
        [
            'electron-builder.config.mjs must register the "neverwrite" protocol.',
            'electron-builder.config.mjs must stage "out/native-backend" into the packaged "native-backend" resources directory.',
            'electron-builder.config.mjs mac.minimumSystemVersion must be "12.0".',
            'electron-builder.config.mjs artifactName must include "${arch}" to avoid multi-architecture asset collisions.',
            "electron-builder.config.mjs must configure afterPack bundle verification.",
            'electron-builder.config.mjs mac.target must include "zip".',
            'electron-builder.config.mjs win.target must include "nsis".',
        ],
    );
});

test("parseChangelogEntries extracts bracketed release sections", () => {
    const changelog = `
# Changelog

## Format

Ignored section

## [0.2.0]

### Added

- New thing

## [0.1.0] - 2026-04-01

- Older thing
`;

    const entries = parseChangelogEntries(changelog);

    assert.deepEqual(entries, [
        {
            version: "0.2.0",
            notes: "### Added\n\n- New thing",
        },
        {
            version: "0.1.0",
            notes: "- Older thing",
        },
    ]);
});

test("getChangelogEntry returns the exact requested version", () => {
    const changelog = `
## [0.2.0]

- New thing

## [0.2.1]

- Hotfix
`;

    assert.deepEqual(getChangelogEntry(changelog, "0.2.1"), {
        version: "0.2.1",
        notes: "- Hotfix",
    });
    assert.equal(getChangelogEntry(changelog, "0.3.0"), null);
});
