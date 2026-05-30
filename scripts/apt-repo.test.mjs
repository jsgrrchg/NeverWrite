import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import {
    APT_DEFAULT_BASE_URL,
    APT_PUBLIC_KEY_FILE_NAME,
    APT_SOURCES_EXAMPLE_FILE_NAME,
    APT_SUPPORTED_ARCHITECTURES,
    buildAptPoolPackageName,
    buildAptPoolPackagePath,
    buildAptReleaseContent,
    buildDebianReleaseAssetName,
    buildNeverWriteSourcesExample,
    compareReleaseVersionsDescending,
    getAptBinaryPackagesGzipPath,
    getAptBinaryPackagesPath,
    getFileHashes,
    normalizeAptComponent,
    normalizeAptSuite,
    normalizeDebianArchitecture,
    parseAptPoolPackageFileName,
    parseDebianControlStanza,
    renderPackagesStanza,
} from "./apt-repo-lib.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const VALIDATE_APT_REPOSITORY_SCRIPT = path.join(
    SCRIPTS_DIR,
    "validate-apt-repository.mjs",
);

function writeFixtureAptRepository({ filenamesByArchitecture = {} } = {}) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "neverwrite-apt-test-"));
    const aptDir = path.join(rootDir, "apt");
    const suiteDir = path.join(aptDir, "dists", "stable");
    const releaseFiles = [];

    fs.mkdirSync(aptDir, { recursive: true });
    fs.writeFileSync(
        path.join(aptDir, APT_PUBLIC_KEY_FILE_NAME),
        "fixture public key\n",
        "utf8",
    );
    fs.writeFileSync(
        path.join(aptDir, APT_SOURCES_EXAMPLE_FILE_NAME),
        buildNeverWriteSourcesExample("file:///tmp/neverwrite-apt"),
        "utf8",
    );

    for (const architecture of APT_SUPPORTED_ARCHITECTURES) {
        const packageRelativePath = buildAptPoolPackagePath("0.3.0", architecture);
        const packagePath = path.join(aptDir, packageRelativePath);
        const packageBytes = Buffer.from(`fixture package ${architecture}\n`);
        fs.mkdirSync(path.dirname(packagePath), { recursive: true });
        fs.writeFileSync(packagePath, packageBytes);

        const packagesRelativePath = getAptBinaryPackagesPath(architecture);
        const packagesPath = path.join(aptDir, packagesRelativePath);
        const packagesContent = renderPackagesStanza({
            controlFields: parseDebianControlStanza([
                "Package: neverwrite",
                "Version: 0.3.0",
                `Architecture: ${architecture}`,
                "Description: NeverWrite desktop",
                "",
            ].join("\n")),
            filename: filenamesByArchitecture[architecture] ?? packageRelativePath,
            sizeBytes: packageBytes.length,
            hashes: getFileHashes(packagePath),
        });

        fs.mkdirSync(path.dirname(packagesPath), { recursive: true });
        fs.writeFileSync(packagesPath, packagesContent, "utf8");
        fs.writeFileSync(
            path.join(aptDir, getAptBinaryPackagesGzipPath(architecture)),
            zlib.gzipSync(Buffer.from(packagesContent, "utf8")),
        );
    }

    for (const relativePath of [
        ...APT_SUPPORTED_ARCHITECTURES.map((architecture) =>
            getAptBinaryPackagesPath(architecture),
        ),
        ...APT_SUPPORTED_ARCHITECTURES.map((architecture) =>
            getAptBinaryPackagesGzipPath(architecture),
        ),
    ]) {
        const absolutePath = path.join(aptDir, relativePath);
        releaseFiles.push({
            relativePath: relativePath.replace("dists/stable/", ""),
            sizeBytes: fs.statSync(absolutePath).size,
            hashes: getFileHashes(absolutePath),
        });
    }

    fs.mkdirSync(suiteDir, { recursive: true });
    fs.writeFileSync(
        path.join(suiteDir, "Release"),
        buildAptReleaseContent({ files: releaseFiles }),
        "utf8",
    );
    fs.writeFileSync(path.join(suiteDir, "InRelease"), "fixture inrelease\n", "utf8");
    fs.writeFileSync(path.join(suiteDir, "Release.gpg"), "fixture signature\n", "utf8");

    return { rootDir, aptDir };
}

function validateFixtureAptRepository(aptDir) {
    return childProcess.spawnSync(
        process.execPath,
        [
            VALIDATE_APT_REPOSITORY_SCRIPT,
            "--apt-dir",
            aptDir,
            "--version",
            "0.3.0",
            "--skip-signature-check",
        ],
        {
            encoding: "utf8",
        },
    );
}

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

test("APT repository validator accepts local pool package filenames", (t) => {
    const { rootDir, aptDir } = writeFixtureAptRepository();
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

    const result = validateFixtureAptRepository(aptDir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /APT repository is valid for version 0\.3\.0/);
});

test("APT repository validator rejects package Filename URLs", (t) => {
    const { rootDir, aptDir } = writeFixtureAptRepository({
        filenamesByArchitecture: {
            amd64: "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.3.0/NeverWrite-0.3.0-amd64.deb",
        },
    });
    t.after(() => fs.rmSync(rootDir, { recursive: true, force: true }));

    const result = validateFixtureAptRepository(aptDir);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid Filename/);
    assert.match(result.stderr, /Expected a normalized relative path under "pool\/main\/n\/neverwrite\/"/);
});
