import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    createV8ArtifactPlan,
    fetchCodexV8Artifacts,
    parseV8ChecksumManifest,
    resolveCodexV8CargoEnvironment,
    resolveV8VersionFromLockfile,
} from "./codex-v8-artifacts.mjs";

const version = "149.2.0";
const profile = "release";
const targetTriple = "aarch64-apple-darwin";
const wrapperPath = path.join(
    process.cwd(),
    "scripts",
    "run-with-codex-v8.mjs",
);

let testRoot;

beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "neverwrite-v8-test-"));
});

afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
});

function sha256(content) {
    return createHash("sha256").update(content).digest("hex");
}

function artifactFixture(plan, { archive, binding, manifest } = {}) {
    const archiveContent = archive ?? Buffer.from("archive");
    const bindingContent = binding ?? Buffer.from("binding");
    const manifestContent =
        manifest ??
        [
            `${sha256(archiveContent)}  ${plan.archiveName}`,
            `${sha256(bindingContent)}  ${plan.bindingName}`,
            "",
        ].join("\n");

    return new Map([
        [plan.archiveName, archiveContent],
        [plan.bindingName, bindingContent],
        [plan.manifestName, manifestContent],
    ]);
}

function fixtureFetch(files) {
    return vi.fn(async (url) => {
        const name = path.basename(new URL(url).pathname);
        if (!files.has(name)) {
            return new Response("Not found", {
                status: 404,
                statusText: "Not Found",
            });
        }
        return new Response(files.get(name));
    });
}

function wrapperEnvironment() {
    return {
        ...process.env,
        RUSTY_V8_ARCHIVE: path.join(testRoot, "custom-v8.a.gz"),
        RUSTY_V8_SRC_BINDING_PATH: path.join(testRoot, "custom-binding.rs"),
    };
}

describe("V8 artifact metadata", () => {
    it("resolves the exact v8 version from Cargo.lock", () => {
        expect(
            resolveV8VersionFromLockfile(`
version = 3

[[package]]
name = "other"
version = "1.0.0"

[[package]]
name = "v8"
version = "149.2.0"
source = "registry"
`),
        ).toBe(version);
    });

    it("rejects lockfiles without exactly one v8 version", () => {
        expect(() => resolveV8VersionFromLockfile("version = 3\n")).toThrow(
            /exactly one resolved v8 version/,
        );
        expect(() =>
            resolveV8VersionFromLockfile(`
[[package]]
name = "v8"
version = "149.2.0"

[[package]]
name = "v8"
version = "150.4.0"
`),
        ).toThrow(/149\.2\.0.*150\.4\.0/);
    });

    it.each([
        ["aarch64-apple-darwin", "librusty_v8_release_aarch64-apple-darwin.a.gz"],
        ["x86_64-apple-darwin", "librusty_v8_release_x86_64-apple-darwin.a.gz"],
        [
            "aarch64-unknown-linux-gnu",
            "librusty_v8_release_aarch64-unknown-linux-gnu.a.gz",
        ],
        [
            "x86_64-unknown-linux-gnu",
            "librusty_v8_release_x86_64-unknown-linux-gnu.a.gz",
        ],
        [
            "aarch64-pc-windows-msvc",
            "rusty_v8_release_aarch64-pc-windows-msvc.lib.gz",
        ],
        [
            "x86_64-pc-windows-msvc",
            "rusty_v8_release_x86_64-pc-windows-msvc.lib.gz",
        ],
    ])("resolves artifact names for %s", (target, archiveName) => {
        const plan = createV8ArtifactPlan({
            version,
            profile,
            targetTriple: target,
            cacheRoot: testRoot,
        });

        expect(plan.archiveName).toBe(archiveName);
        expect(plan.bindingName).toBe(
            `src_binding_release_${target}.rs`,
        );
        expect(plan.manifestName).toBe(`rusty_v8_release_${target}.sha256`);
        expect(plan.archiveUrl).toContain(
            `/rusty-v8-v${version}/${archiveName}`,
        );
    });
});

describe("V8 checksum manifests", () => {
    const archiveName = "librusty_v8_release_target.a.gz";
    const bindingName = "src_binding_release_target.rs";
    const checksum = "a".repeat(64);

    it("accepts exactly the expected pair with Windows CRLF", () => {
        const checksums = parseV8ChecksumManifest(
            `${checksum}  ${archiveName}\r\n${checksum}  ${bindingName}\r\n`,
            [archiveName, bindingName],
        );

        expect([...checksums.keys()]).toEqual([archiveName, bindingName]);
    });

    it.each([
        [`${checksum}  ${archiveName}\n`, /Expected 2 V8 checksums/],
        [
            `${checksum}  ${archiveName}\n${checksum}  ${bindingName}\n${checksum}  extra\n`,
            /Expected 2 V8 checksums/,
        ],
        [
            `${checksum}  ${archiveName}\n${checksum}  foreign.rs\n`,
            /Unexpected V8 checksum artifact/,
        ],
    ])("rejects incomplete or foreign manifests", (manifest, error) => {
        expect(() =>
            parseV8ChecksumManifest(manifest, [archiveName, bindingName]),
        ).toThrow(error);
    });
});

describe("V8 artifact cache", () => {
    it("downloads a verified pair and reuses a valid cache", async () => {
        const plan = createV8ArtifactPlan({
            version,
            profile,
            targetTriple,
            cacheRoot: testRoot,
        });
        const fetchImpl = fixtureFetch(artifactFixture(plan));

        const first = await fetchCodexV8Artifacts({
            version,
            profile,
            targetTriple,
            cacheRoot: testRoot,
            fetchImpl,
        });
        const second = await fetchCodexV8Artifacts({
            version,
            profile,
            targetTriple,
            cacheRoot: testRoot,
            fetchImpl,
        });

        expect(first).toEqual(second);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(await fs.readFile(first.archivePath, "utf8")).toBe("archive");
        expect(await fs.readFile(first.bindingPath, "utf8")).toBe("binding");
    });

    it("redownloads the complete pair when the cache is corrupt", async () => {
        const plan = createV8ArtifactPlan({
            version,
            profile,
            targetTriple,
            cacheRoot: testRoot,
        });
        const files = artifactFixture(plan);
        const initialFetch = fixtureFetch(files);
        const artifacts = await fetchCodexV8Artifacts({
            version,
            profile,
            targetTriple,
            cacheRoot: testRoot,
            fetchImpl: initialFetch,
        });
        await fs.writeFile(artifacts.archivePath, "corrupt");
        const recoveryFetch = fixtureFetch(files);

        await fetchCodexV8Artifacts({
            version,
            profile,
            targetTriple,
            cacheRoot: testRoot,
            fetchImpl: recoveryFetch,
        });

        expect(recoveryFetch).toHaveBeenCalledTimes(3);
        expect(await fs.readFile(artifacts.archivePath, "utf8")).toBe(
            "archive",
        );
    });

    it("removes artifacts that fail checksum validation", async () => {
        const plan = createV8ArtifactPlan({
            version,
            profile,
            targetTriple,
            cacheRoot: testRoot,
        });
        const files = artifactFixture(plan, {
            archive: Buffer.from("invalid archive"),
            manifest: [
                `${sha256("expected archive")}  ${plan.archiveName}`,
                `${sha256("binding")}  ${plan.bindingName}`,
                "",
            ].join("\n"),
        });

        await expect(
            fetchCodexV8Artifacts({
                version,
                profile,
                targetTriple,
                cacheRoot: testRoot,
                fetchImpl: fixtureFetch(files),
            }),
        ).rejects.toThrow(/failed checksum validation/);
        await expect(fs.access(plan.archivePath)).rejects.toMatchObject({
            code: "ENOENT",
        });
        const cacheParentEntries = await fs.readdir(path.dirname(plan.cacheDir));
        expect(cacheParentEntries).not.toContain(
            expect.stringMatching(/\.tmp-/),
        );
    });
});

describe("V8 Cargo environment", () => {
    it.each(["RUSTY_V8_ARCHIVE", "RUSTY_V8_SRC_BINDING_PATH"])(
        "rejects a partial %s override",
        async (configuredKey) => {
            await expect(
                resolveCodexV8CargoEnvironment({
                    targetTriple,
                    env: { [configuredKey]: "/custom/artifact" },
                    cargoLockPath: path.join(testRoot, "missing.lock"),
                }),
            ).rejects.toThrow(/must be set together/);
        },
    );

    it("preserves complete overrides without reading or downloading", async () => {
        const fetchImpl = vi.fn(() => {
            throw new Error("unexpected download");
        });
        const env = {
            RUSTY_V8_ARCHIVE: "/custom/archive.a.gz",
            RUSTY_V8_SRC_BINDING_PATH: "/custom/binding.rs",
        };

        await expect(
            resolveCodexV8CargoEnvironment({
                targetTriple,
                env,
                cargoLockPath: path.join(testRoot, "missing.lock"),
                fetchImpl,
            }),
        ).resolves.toEqual(env);
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe("V8 command wrapper", () => {
    it("inherits stdio, injects both paths, and preserves the exit code", () => {
        const result = spawnSync(
            process.execPath,
            [
                wrapperPath,
                "--target",
                targetTriple,
                "--",
                process.execPath,
                "-e",
                "console.log(`${process.env.RUSTY_V8_ARCHIVE}|${process.env.RUSTY_V8_SRC_BINDING_PATH}`); process.exit(23);",
            ],
            {
                encoding: "utf8",
                env: wrapperEnvironment(),
            },
        );

        expect(result.status).toBe(23);
        expect(result.stdout.trim()).toBe(
            `${path.join(testRoot, "custom-v8.a.gz")}|${path.join(testRoot, "custom-binding.rs")}`,
        );
    });

    if (process.platform !== "win32") {
        it("preserves a signal raised by the child command", () => {
            const result = spawnSync(
                process.execPath,
                [
                    wrapperPath,
                    "--target",
                    targetTriple,
                    "--",
                    process.execPath,
                    "-e",
                    "process.kill(process.pid, 'SIGTERM');",
                ],
                { env: wrapperEnvironment() },
            );

            expect(result.status).toBeNull();
            expect(result.signal).toBe("SIGTERM");
        });

        it("forwards signals received by the wrapper", async () => {
            const result = await new Promise((resolve, reject) => {
                const child = spawn(
                    process.execPath,
                    [
                        wrapperPath,
                        "--target",
                        targetTriple,
                        "--",
                        process.execPath,
                        "-e",
                        "process.on('SIGTERM', () => process.exit(42)); console.log('ready'); setInterval(() => {}, 1000);",
                    ],
                    {
                        env: wrapperEnvironment(),
                        stdio: ["ignore", "pipe", "inherit"],
                    },
                );
                child.once("error", reject);
                child.stdout.once("data", () => child.kill("SIGTERM"));
                child.once("exit", (code, signal) =>
                    resolve({ code, signal }),
                );
            });

            expect(result).toEqual({ code: 42, signal: null });
        });
    }
});
