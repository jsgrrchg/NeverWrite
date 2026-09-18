const pinnedManifestSha256ByVersion = Object.freeze({
    "150.4.0": Object.freeze({
        ptrcomp_sandbox_release: Object.freeze({
            "aarch64-apple-darwin":
                "4079b4b84a8b4fcf34a2a5ca7f080dffd0e1b53404b0032087b821e247febb43",
            "x86_64-apple-darwin":
                "d85c7ae0cf437a4415376c4b5b7daba50b0dcbe30f52612d21df8ce52eb8ada0",
            "aarch64-pc-windows-msvc":
                "9d153e6534d50961329132a64dd7f7cd18ba96501a4a43c1a6d8bfaeec454b2b",
            "x86_64-pc-windows-msvc":
                "a4d6221dddb4b5724b23411eaac47caf6095489fbf9d126f65b33cef96a0a8ef",
            "aarch64-unknown-linux-gnu":
                "4ee879a8bc7b0f482cac891415e22300dff4429a28897fddac88bb296ce07920",
            "x86_64-unknown-linux-gnu":
                "6774b42c9424c098c72a805c08d4e94be17c591cf02b1dc2633060255a8a61be",
        }),
    }),
});

export function resolvePinnedV8ManifestChecksum({
    version,
    profile,
    targetTriple,
}) {
    const checksum =
        pinnedManifestSha256ByVersion[version]?.[profile]?.[targetTriple];
    if (!checksum) {
        throw new Error(
            `No pinned V8 manifest SHA-256 for version ${version}, profile ${profile}, and target ${targetTriple}`,
        );
    }
    return checksum;
}
