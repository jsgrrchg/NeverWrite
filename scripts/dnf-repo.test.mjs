import test from "node:test";
import assert from "node:assert/strict";
import {
    DNF_DEFAULT_BASE_URL,
    buildRpmReleaseAssetName,
    buildGitHubReleaseRpmLocationPrefix,
    buildGitHubReleaseRpmUrl,
    buildNeverWriteRepoExample,
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
