import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChannelAppcastUrl,
  buildGitHubPagesBaseUrl,
  buildPublicReleaseAssetName,
  createStaticAppcastManifest,
  describeUpdaterArtifactKind,
  getAppcastPublishPath,
  getSignatureAssetName,
  normalizePlatformEntries,
} from "./appcast-lib.mjs";

test("buildGitHubPagesBaseUrl returns the project pages base URL", () => {
  assert.equal(
    buildGitHubPagesBaseUrl("vaultai/vaultai"),
    "https://vaultai.github.io/vaultai",
  );
});

test("getAppcastPublishPath returns channel/latest.json", () => {
  assert.equal(getAppcastPublishPath("stable"), "stable/latest.json");
  assert.equal(getAppcastPublishPath("beta"), "beta/latest.json");
});

test("buildChannelAppcastUrl joins the public base url and channel path", () => {
  assert.equal(
    buildChannelAppcastUrl("https://vaultai.github.io/vaultai/", "stable"),
    "https://vaultai.github.io/vaultai/stable/latest.json",
  );
});

test("buildPublicReleaseAssetName uses the human-facing naming convention", () => {
  assert.equal(
    buildPublicReleaseAssetName("0.2.0", "aarch64-apple-darwin"),
    "VaultAI_0.2.0_macOS_AppleSilicon.dmg",
  );
  assert.equal(
    buildPublicReleaseAssetName("0.2.0", "x86_64-pc-windows-msvc"),
    "VaultAI_0.2.0_Windows_x64_Setup.exe",
  );
});

test("describeUpdaterArtifactKind documents updater archive families", () => {
  assert.equal(
    describeUpdaterArtifactKind("x86_64-apple-darwin"),
    "macOS updater archive (.app.tar.gz)",
  );
  assert.equal(
    describeUpdaterArtifactKind("aarch64-pc-windows-msvc"),
    "Windows updater archive (.nsis.zip)",
  );
  assert.equal(getSignatureAssetName("VaultAI.app.tar.gz"), "VaultAI.app.tar.gz.sig");
});

test("normalizePlatformEntries accepts build targets and emits appcast keys", () => {
  assert.deepEqual(
    normalizePlatformEntries({
      "aarch64-apple-darwin": {
        url: "https://example.com/macos-arm64.tar.gz",
        signature: "sig-a",
      },
      "x86_64-pc-windows-msvc": {
        url: "https://example.com/windows-x64.zip",
        signature: "sig-b",
      },
    }),
    {
      "darwin-aarch64": {
        url: "https://example.com/macos-arm64.tar.gz",
        signature: "sig-a",
      },
      "windows-x86_64": {
        url: "https://example.com/windows-x64.zip",
        signature: "sig-b",
      },
    },
  );
});

test("createStaticAppcastManifest requires all v1 platform keys and preserves order", () => {
  const manifest = createStaticAppcastManifest({
    version: "v0.2.0",
    notes: "## Added\n\n- Multi-target appcast.",
    pubDate: "2026-04-04T18:00:00Z",
    platforms: {
      "x86_64-pc-windows-msvc": {
        url: "https://example.com/windows-x64.zip",
        signature: "sig-wx64",
      },
      "aarch64-apple-darwin": {
        url: "https://example.com/macos-arm64.tar.gz",
        signature: "sig-marm",
      },
      "aarch64-pc-windows-msvc": {
        url: "https://example.com/windows-arm64.zip",
        signature: "sig-warm",
      },
      "x86_64-apple-darwin": {
        url: "https://example.com/macos-x64.tar.gz",
        signature: "sig-mx64",
      },
    },
  });

  assert.deepEqual(Object.keys(manifest.platforms), [
    "darwin-aarch64",
    "darwin-x86_64",
    "windows-aarch64",
    "windows-x86_64",
  ]);
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.pub_date, "2026-04-04T18:00:00Z");
});

test("createStaticAppcastManifest rejects missing v1 platforms", () => {
  assert.throws(
    () =>
      createStaticAppcastManifest({
        version: "0.2.0",
        notes: "- notes",
        pubDate: "2026-04-04T18:00:00Z",
        platforms: {
          "darwin-aarch64": {
            url: "https://example.com/macos-arm64.tar.gz",
            signature: "sig",
          },
        },
      }),
    /missing required v1 platforms/i,
  );
});
