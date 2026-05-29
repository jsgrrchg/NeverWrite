import test from "node:test";
import assert from "node:assert/strict";

import {
    APT_DEFAULT_BASE_URL,
    buildAptPoolPackageName,
    buildAptPoolPackagePath,
    buildAptReleaseContent,
    buildDebianReleaseAssetName,
    buildGitHubReleaseDebUrl,
    buildNeverWriteSourcesExample,
    compareReleaseVersionsDescending,
    getAptBinaryPackagesGzipPath,
    getAptBinaryPackagesPath,
    isUrlFilename,
    normalizeAptComponent,
    normalizeAptSuite,
    normalizeDebianArchitecture,
    parseAptPoolPackageFileName,
    parseDebianControlStanza,
    renderPackagesStanza,
} from "./apt-repo-lib.mjs";

test("APT package paths use Debian pool conventions", () => {
    assert.equal(
        buildAptPoolPackageName("0.2.8", "amd64"),
        "neverwrite_0.2.8_amd64.deb",
    );
    assert.equal(
        buildAptPoolPackagePath("0.2.8", "arm64"),
        "pool/main/n/neverwrite/neverwrite_0.2.8_arm64.deb",
    );
});

test("APT binary package paths are scoped by architecture", () => {
    assert.equal(
        getAptBinaryPackagesPath("amd64"),
        "dists/stable/main/binary-amd64/Packages",
    );
    assert.equal(
        getAptBinaryPackagesGzipPath("arm64"),
        "dists/stable/main/binary-arm64/Packages.gz",
    );
});

test("Debian release asset names match GitHub Release assets", () => {
    assert.equal(
        buildDebianReleaseAssetName("0.2.8", "amd64"),
        "NeverWrite-0.2.8-amd64.deb",
    );
    assert.equal(
        buildDebianReleaseAssetName("0.2.8", "arm64"),
        "NeverWrite-0.2.8-arm64.deb",
    );
});

test("APT config normalizers reject unsupported repository dimensions", () => {
    assert.equal(normalizeAptSuite("stable"), "stable");
    assert.equal(normalizeAptComponent("main"), "main");
    assert.equal(normalizeDebianArchitecture("amd64"), "amd64");
    assert.throws(() => normalizeAptSuite("testing"), /Unsupported APT suite/i);
    assert.throws(() => normalizeAptComponent("contrib"), /Unsupported APT component/i);
    assert.throws(() => normalizeDebianArchitecture("riscv64"), /Unsupported Debian architecture/i);
});

test("NeverWrite Deb822 source example uses the public APT endpoint", () => {
    const source = buildNeverWriteSourcesExample();
    assert.match(source, new RegExp(`URIs: ${APT_DEFAULT_BASE_URL}`));
    assert.match(source, /Suites: stable/);
    assert.match(source, /Components: main/);
    assert.match(source, /Architectures: amd64 arm64/);
    assert.match(source, /Signed-By: \/etc\/apt\/keyrings\/neverwrite\.asc/);
});

test("Debian control parsing preserves multiline descriptions", () => {
    const fields = parseDebianControlStanza([
        "Package: neverwrite",
        "Version: 0.2.8",
        "Description: NeverWrite desktop",
        " poweruser writing app",
        "",
    ].join("\n"));

    assert.equal(fields.length, 3);
    assert.equal(fields[2].value, "NeverWrite desktop\n poweruser writing app");
});

test("Packages stanzas append repository filename and checksums", () => {
    const stanza = renderPackagesStanza({
        controlFields: parseDebianControlStanza([
            "Package: neverwrite",
            "Version: 0.2.8",
            "Architecture: amd64",
            "Description: NeverWrite desktop",
            "",
        ].join("\n")),
        filename: "pool/main/n/neverwrite/neverwrite_0.2.8_amd64.deb",
        sizeBytes: 1234,
        hashes: {
            MD5Sum: "a".repeat(32),
            SHA1: "b".repeat(40),
            SHA256: "c".repeat(64),
        },
    });

    assert.match(stanza, /^Package: neverwrite/m);
    assert.match(stanza, /^Filename: pool\/main\/n\/neverwrite\/neverwrite_0\.2\.8_amd64\.deb/m);
    assert.match(stanza, /^Size: 1234/m);
    assert.match(stanza, /^MD5sum: a{32}$/m);
    assert.match(stanza, /^SHA256: c{64}$/m);
});

test("Release file includes suite, architectures, components, and checksums", () => {
    const release = buildAptReleaseContent({
        files: [
            {
                relativePath: "main/binary-amd64/Packages",
                sizeBytes: 10,
                hashes: {
                    MD5Sum: "a".repeat(32),
                    SHA1: "b".repeat(40),
                    SHA256: "c".repeat(64),
                },
            },
        ],
        generatedAt: new Date("2026-05-24T12:00:00Z"),
    });

    assert.match(release, /^Origin: NeverWrite$/m);
    assert.match(release, /^Suite: stable$/m);
    assert.match(release, /^Codename: neverwrite-stable$/m);
    assert.match(release, /^Architectures: amd64 arm64$/m);
    assert.match(release, /^Components: main$/m);
    assert.match(release, /^SHA256:/m);
    assert.match(release, /main\/binary-amd64\/Packages/);
});

test("APT pool file parser and version sorter support retention", () => {
    assert.deepEqual(parseAptPoolPackageFileName("neverwrite_0.2.8_amd64.deb"), {
        version: "0.2.8",
        architecture: "amd64",
    });
    assert.equal(parseAptPoolPackageFileName("NeverWrite-0.2.8-amd64.deb"), null);
    assert.deepEqual(
        ["0.2.8", "0.3.0", "0.2.10"].sort(compareReleaseVersionsDescending),
        ["0.3.0", "0.2.10", "0.2.8"],
    );
});

test("buildGitHubReleaseDebUrl builds correct GitHub Release download URL", () => {
    const url = buildGitHubReleaseDebUrl(
        "jsgrrchg/NeverWrite",
        "v0.3.0",
        "0.3.0",
        "amd64",
    );
    assert.equal(
        url,
        "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.3.0/NeverWrite-0.3.0-amd64.deb",
    );
});

test("buildGitHubReleaseDebUrl handles version-only tag input", () => {
    const url = buildGitHubReleaseDebUrl(
        "jsgrrchg/NeverWrite",
        "0.3.0",
        "0.3.0",
        "arm64",
    );
    assert.equal(
        url,
        "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.3.0/NeverWrite-0.3.0-arm64.deb",
    );
});

test("isUrlFilename detects http and https filenames", () => {
    assert.equal(
        isUrlFilename("https://github.com/jsgrrchg/NeverWrite/releases/download/v0.3.0/NeverWrite-0.3.0-amd64.deb"),
        true,
    );
    assert.equal(
        isUrlFilename("http://example.com/pkg.deb"),
        true,
    );
    assert.equal(
        isUrlFilename("pool/main/n/neverwrite/neverwrite_0.3.0_amd64.deb"),
        false,
    );
    assert.equal(isUrlFilename(null), false);
    assert.equal(isUrlFilename(undefined), false);
    assert.equal(isUrlFilename(""), false);
});
