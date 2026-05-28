import test from "node:test";
import assert from "node:assert/strict";
import {
    DNF_DEFAULT_BASE_URL,
    buildRpmReleaseAssetName,
    buildGitHubReleaseRpmUrl,
    buildNeverWriteRepoExample,
    buildPrimaryXml,
    buildRepomdXml,
    normalizeRpmArchitecture,
} from "./dnf-repo-lib.mjs";

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
    assert.match(example, /\[neverwrite\]/);
});

test("normalizeRpmArchitecture accepts valid RPM architectures", () => {
    assert.equal(normalizeRpmArchitecture("x86_64"), "x86_64");
    assert.equal(normalizeRpmArchitecture("aarch64"), "aarch64");
    assert.throws(() => normalizeRpmArchitecture("amd64"), /Unsupported/);
    assert.throws(() => normalizeRpmArchitecture("arm64"), /Unsupported/);
});

test("buildPrimaryXml generates valid XML with package metadata", () => {
    const packages = [
        {
            name: "neverwrite",
            arch: "x86_64",
            version: "0.3.0",
            locationUrl: "https://github.com/jsgrrchg/NeverWrite/releases/download/v0.3.0/NeverWrite-0.3.0-x86_64.rpm",
            sizeBytes: 1000000,
            hashes: { sha256: "a".repeat(64) },
        },
    ];
    const xml = buildPrimaryXml({ packages });
    assert.match(xml, /<package type="rpm">/);
    assert.match(xml, /<name>neverwrite<\/name>/);
    assert.match(xml, /<arch>x86_64<\/arch>/);
    assert.match(xml, /<location href="https:\/\/github\.com/);
});

test("buildRepomdXml generates valid repomd XML", () => {
    const files = [
        {
            relativePath: "primary.xml.gz",
            sizeBytes: 100,
            hashes: { sha256: "b".repeat(64) },
        },
    ];
    const xml = buildRepomdXml({ files });
    assert.match(xml, /<repomd/);
    assert.match(xml, /<data type="primary">/);
});
