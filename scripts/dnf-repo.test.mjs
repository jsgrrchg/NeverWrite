import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import {
    DNF_DEFAULT_BASE_URL,
    DNF_PUBLIC_KEY_FILE_NAME,
    DNF_REPO_EXAMPLE_FILE_NAME,
    DNF_SUPPORTED_ARCHITECTURES,
    buildRpmReleaseAssetName,
    buildGitHubReleaseRpmLocationPrefix,
    buildGitHubReleaseRpmUrl,
    buildNeverWriteRepoExample,
    normalizeRpmArchitecture,
} from "./dnf-repo-lib.mjs";

const VALIDATE_DNF_REPOSITORY_SCRIPT = fileURLToPath(
    new URL("./validate-dnf-repository.mjs", import.meta.url),
);

function withTempDir(callback) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "neverwrite-dnf-test-"));
    try {
        callback(tempDir);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function writeFixtureDnfRepository(
    rootDir,
    {
        version = "0.4.0",
        packageLocationBase = "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.4.0",
        includePackageBinary = false,
    } = {},
) {
    const dnfDir = path.join(rootDir, "dnf");
    const repodataDir = path.join(dnfDir, "repodata");
    fs.mkdirSync(repodataDir, { recursive: true });

    const packages = DNF_SUPPORTED_ARCHITECTURES.map((arch) => {
        const assetName = buildRpmReleaseAssetName(version, arch);
        return [
            '<package type="rpm">',
            "<name>neverwrite</name>",
            `<arch>${arch}</arch>`,
            `<version epoch="0" ver="${version}" rel="1"/>`,
            `<location href="${packageLocationBase}/${assetName}"/>`,
            "<rpm:provides><rpm:entry name=\"neverwrite\"/></rpm:provides>",
            "<rpm:requires><rpm:entry name=\"bash\"/></rpm:requires>",
            '<rpm:header-range start="0" end="1"/>',
            "</package>",
        ].join("");
    }).join("");

    fs.writeFileSync(
        path.join(repodataDir, "primary.xml.gz"),
        zlib.gzipSync(`<metadata>${packages}</metadata>`),
    );
    fs.writeFileSync(
        path.join(repodataDir, "filelists.xml.gz"),
        zlib.gzipSync(
            '<filelists><package name="neverwrite"><file>/usr/bin/neverwrite</file></package></filelists>',
        ),
    );
    fs.writeFileSync(
        path.join(repodataDir, "repomd.xml"),
        [
            '<repomd xmlns="http://linux.duke.edu/metadata/repo">',
            '<data type="primary">',
            `<checksum type="sha256">${"a".repeat(64)}</checksum>`,
            '<location href="repodata/primary.xml.gz"/>',
            "</data>",
            "</repomd>",
        ].join(""),
    );
    fs.writeFileSync(path.join(repodataDir, "repomd.xml.asc"), "signature");
    fs.writeFileSync(
        path.join(dnfDir, DNF_REPO_EXAMPLE_FILE_NAME),
        buildNeverWriteRepoExample(),
    );
    fs.writeFileSync(path.join(dnfDir, DNF_PUBLIC_KEY_FILE_NAME), "public-key");

    if (includePackageBinary) {
        fs.writeFileSync(
            path.join(dnfDir, buildRpmReleaseAssetName(version, "x86_64")),
            "rpm",
        );
    }

    return dnfDir;
}

function validateDnfRepository(dnfDir, version = "0.4.0") {
    return childProcess.spawnSync(
        process.execPath,
        [
            VALIDATE_DNF_REPOSITORY_SCRIPT,
            "--dnf-dir",
            dnfDir,
            "--version",
            version,
            "--skip-signature-check",
        ],
        { encoding: "utf8" },
    );
}

test("RPM release asset names use RPM architecture naming", () => {
    assert.equal(
        buildRpmReleaseAssetName("0.3.0", "x86_64"),
        "NeverWrite-0.3.0-x86_64.rpm",
    );
    assert.equal(
        buildRpmReleaseAssetName("0.3.0", "aarch64"),
        "NeverWrite-0.3.0-aarch64.rpm",
    );
});

test("buildGitHubReleaseRpmLocationPrefix builds GitHub release asset prefix", () => {
    assert.equal(
        buildGitHubReleaseRpmLocationPrefix("jsgrrchg/NeverWrite", "v0.3.0"),
        "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.3.0/",
    );
});

test("buildGitHubReleaseRpmUrl builds correct GitHub URL", () => {
    const url = buildGitHubReleaseRpmUrl(
        "jsgrrchg/NeverWrite", "v0.3.0", "0.3.0", "x86_64",
    );
    assert.equal(
        url,
        "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.3.0/NeverWrite-0.3.0-x86_64.rpm",
    );
});

test("buildNeverWriteRepoExample uses the public DNF endpoint", () => {
    const example = buildNeverWriteRepoExample();
    assert.match(example, /baseurl=https:\/\/jsgrrchg\.github\.io\/NeverWrite\/dnf/);
    assert.match(example, /gpgcheck=1/);
    assert.match(example, /repo_gpgcheck=1/);
    assert.match(example, /\[neverwrite\]/);
});

test("normalizeRpmArchitecture accepts valid RPM architectures", () => {
    assert.equal(normalizeRpmArchitecture("x86_64"), "x86_64");
    assert.equal(normalizeRpmArchitecture("aarch64"), "aarch64");
    assert.throws(() => normalizeRpmArchitecture("amd64"), /Unsupported/);
    assert.throws(() => normalizeRpmArchitecture("arm64"), /Unsupported/);
});

test("validate-dnf-repository accepts metadata that references GitHub Release RPM assets", () => {
    withTempDir((tempDir) => {
        const dnfDir = writeFixtureDnfRepository(tempDir);
        const result = validateDnfRepository(dnfDir);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /DNF repository is valid for version 0\.4\.0/);
    });
});

test("validate-dnf-repository rejects package binaries in the DNF metadata tree", () => {
    withTempDir((tempDir) => {
        const dnfDir = writeFixtureDnfRepository(tempDir, {
            includePackageBinary: true,
        });
        const result = validateDnfRepository(dnfDir);

        assert.notEqual(result.status, 0);
        assert.match(
            `${result.stdout}\n${result.stderr}`,
            /package binaries on GitHub Releases/,
        );
    });
});

test("validate-dnf-repository rejects package locations outside GitHub Releases", () => {
    withTempDir((tempDir) => {
        const dnfDir = writeFixtureDnfRepository(tempDir, {
            packageLocationBase: "https://jsgrrchg.github.io/NeverWrite/dnf",
        });
        const result = validateDnfRepository(dnfDir);

        assert.notEqual(result.status, 0);
        assert.match(
            `${result.stdout}\n${result.stderr}`,
            /missing GitHub Release location/,
        );
    });
});
