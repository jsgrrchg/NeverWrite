import test from "node:test";
import assert from "node:assert/strict";

import {
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
                tauriConf: "0.2",
                cargoToml: "0.2.1",
            },
            "0.2.0",
        ),
        [
            'tauriConf version "0.2" is not strict semver (X.Y.Z).',
            "Desktop versions do not match: package.json=0.2.0, tauri.conf.json=0.2, Cargo.toml=0.2.1.",
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
            'tauri.conf.json productName must be "NeverWrite", received "OldProduct".',
            'tauri.conf.json identifier must be "com.neverwrite", received "com.oldproduct".',
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
