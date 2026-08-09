import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const CODEX_V8_ARTIFACT_PROFILE = "ptrcomp_sandbox_release";

const appRoot = import.meta.url.startsWith("file:")
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    : process.cwd();
const workspaceRoot = path.resolve(appRoot, "..", "..");
const defaultCargoLockPath = path.join(
    workspaceRoot,
    "vendor",
    "codex-acp",
    "Cargo.lock",
);
const defaultCacheRoot = path.join(appRoot, ".cache", "codex-v8");
const releaseBaseUrl = "https://github.com/openai/codex/releases/download";
const supportedTargets = new Set([
    "aarch64-apple-darwin",
    "x86_64-apple-darwin",
    "aarch64-pc-windows-msvc",
    "x86_64-pc-windows-msvc",
    "aarch64-unknown-linux-gnu",
    "x86_64-unknown-linux-gnu",
]);

function assertSafeSegment(value, description, pattern) {
    if (!pattern.test(value)) {
        throw new Error(`Invalid ${description}: ${value}`);
    }
}

export function resolveV8VersionFromLockfile(lockfileText) {
    const versions = new Set();
    const packageBlocks = lockfileText
        .split(/^\[\[package\]\]\s*$/m)
        .slice(1);

    for (const packageBlock of packageBlocks) {
        if (!/^name\s*=\s*"v8"\s*$/m.test(packageBlock)) {
            continue;
        }
        const version = packageBlock.match(
            /^version\s*=\s*"([^"]+)"\s*$/m,
        )?.[1];
        if (!version) {
            throw new Error(
                "The resolved v8 package has no version in Cargo.lock",
            );
        }
        versions.add(version);
    }

    if (versions.size !== 1) {
        throw new Error(
            `Expected exactly one resolved v8 version, found: ${JSON.stringify([...versions].sort())}`,
        );
    }

    return [...versions][0];
}

export async function resolveV8Version(
    cargoLockPath = defaultCargoLockPath,
) {
    return resolveV8VersionFromLockfile(
        await fs.readFile(cargoLockPath, "utf8"),
    );
}

export function createV8ArtifactPlan({
    version,
    profile = CODEX_V8_ARTIFACT_PROFILE,
    targetTriple,
    cacheRoot = defaultCacheRoot,
}) {
    assertSafeSegment(version, "v8 version", /^\d+\.\d+\.\d+$/);
    assertSafeSegment(profile, "V8 artifact profile", /^[a-z0-9_]+$/);
    if (!supportedTargets.has(targetTriple)) {
        throw new Error(`Unsupported V8 artifact target: ${targetTriple}`);
    }

    const archiveName = targetTriple.includes("windows")
        ? `rusty_v8_${profile}_${targetTriple}.lib.gz`
        : `librusty_v8_${profile}_${targetTriple}.a.gz`;
    const bindingName = `src_binding_${profile}_${targetTriple}.rs`;
    const manifestName = `rusty_v8_${profile}_${targetTriple}.sha256`;
    const baseUrl = `${releaseBaseUrl}/rusty-v8-v${version}`;
    const cacheDir = path.resolve(
        cacheRoot,
        version,
        profile,
        targetTriple,
    );

    return {
        version,
        profile,
        targetTriple,
        cacheDir,
        archiveName,
        archivePath: path.join(cacheDir, archiveName),
        archiveUrl: `${baseUrl}/${archiveName}`,
        bindingName,
        bindingPath: path.join(cacheDir, bindingName),
        bindingUrl: `${baseUrl}/${bindingName}`,
        manifestName,
        manifestPath: path.join(cacheDir, manifestName),
        manifestUrl: `${baseUrl}/${manifestName}`,
    };
}

export function parseV8ChecksumManifest(manifestText, artifactNames) {
    const expectedNames = new Set(artifactNames);
    const normalized = manifestText.replace(/\r\n?/g, "\n");
    const content = normalized.endsWith("\n")
        ? normalized.slice(0, -1)
        : normalized;
    const lines = content ? content.split("\n") : [];

    if (lines.length !== expectedNames.size) {
        throw new Error(
            `Expected ${expectedNames.size} V8 checksums, found ${lines.length}`,
        );
    }

    const checksums = new Map();
    for (const line of lines) {
        const match = line.match(/^([0-9a-f]{64})[ \t]+(\S+)[ \t]*$/);
        if (!match) {
            throw new Error(`Invalid V8 checksum line: ${JSON.stringify(line)}`);
        }

        const [, digest, artifactName] = match;
        if (!expectedNames.has(artifactName)) {
            throw new Error(
                `Unexpected V8 checksum artifact: ${artifactName}`,
            );
        }
        if (checksums.has(artifactName)) {
            throw new Error(
                `Duplicate V8 checksum artifact: ${artifactName}`,
            );
        }
        checksums.set(artifactName, digest);
    }

    for (const artifactName of expectedNames) {
        if (!checksums.has(artifactName)) {
            throw new Error(
                `V8 checksum manifest does not cover ${artifactName}`,
            );
        }
    }

    return checksums;
}

async function sha256File(filePath) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}

async function hasChecksum(filePath, expectedChecksum) {
    try {
        return (await sha256File(filePath)) === expectedChecksum;
    } catch (error) {
        if (error?.code === "ENOENT") {
            return false;
        }
        throw error;
    }
}

async function validateCachedArtifacts(plan) {
    try {
        const checksums = parseV8ChecksumManifest(
            await fs.readFile(plan.manifestPath, "utf8"),
            [plan.archiveName, plan.bindingName],
        );
        const [archiveValid, bindingValid] = await Promise.all([
            hasChecksum(
                plan.archivePath,
                checksums.get(plan.archiveName),
            ),
            hasChecksum(
                plan.bindingPath,
                checksums.get(plan.bindingName),
            ),
        ]);
        return archiveValid && bindingValid;
    } catch (error) {
        if (error?.code === "ENOENT") {
            return false;
        }
        return false;
    }
}

async function downloadFile(url, destinationPath, fetchImpl) {
    const tempPath = `${destinationPath}.${randomUUID()}.tmp`;
    try {
        const response = await fetchImpl(url);
        if (!response.ok) {
            throw new Error(
                `Failed to download ${url}: ${response.status} ${response.statusText}`,
            );
        }
        if (!response.body) {
            throw new Error(`Failed to download ${url}: empty response body`);
        }

        await pipeline(
            Readable.fromWeb(response.body),
            createWriteStream(tempPath, { flags: "wx" }),
        );
        await fs.rename(tempPath, destinationPath);
    } finally {
        await fs.rm(tempPath, { force: true });
    }
}

async function publishArtifactCache(stagingDir, plan) {
    await fs.rm(plan.cacheDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(plan.cacheDir), { recursive: true });
    try {
        await fs.rename(stagingDir, plan.cacheDir);
    } catch (error) {
        if (await validateCachedArtifacts(plan)) {
            await fs.rm(stagingDir, { recursive: true, force: true });
            return;
        }
        throw error;
    }
}

export async function fetchCodexV8Artifacts({
    targetTriple,
    profile = CODEX_V8_ARTIFACT_PROFILE,
    version,
    cargoLockPath = defaultCargoLockPath,
    cacheRoot = defaultCacheRoot,
    fetchImpl = globalThis.fetch,
}) {
    const resolvedVersion = version ?? (await resolveV8Version(cargoLockPath));
    const plan = createV8ArtifactPlan({
        version: resolvedVersion,
        profile,
        targetTriple,
        cacheRoot,
    });

    if (await validateCachedArtifacts(plan)) {
        return {
            archivePath: plan.archivePath,
            bindingPath: plan.bindingPath,
            version: resolvedVersion,
        };
    }

    await fs.rm(plan.cacheDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(plan.cacheDir), { recursive: true });
    const stagingDir = `${plan.cacheDir}.tmp-${process.pid}-${randomUUID()}`;
    const stagingPlan = {
        ...plan,
        cacheDir: stagingDir,
        archivePath: path.join(stagingDir, plan.archiveName),
        bindingPath: path.join(stagingDir, plan.bindingName),
        manifestPath: path.join(stagingDir, plan.manifestName),
    };

    try {
        await fs.mkdir(stagingDir, { recursive: true });
        await downloadFile(
            plan.manifestUrl,
            stagingPlan.manifestPath,
            fetchImpl,
        );
        const checksums = parseV8ChecksumManifest(
            await fs.readFile(stagingPlan.manifestPath, "utf8"),
            [plan.archiveName, plan.bindingName],
        );

        await Promise.all([
            downloadFile(plan.archiveUrl, stagingPlan.archivePath, fetchImpl),
            downloadFile(plan.bindingUrl, stagingPlan.bindingPath, fetchImpl),
        ]);

        const [archiveValid, bindingValid] = await Promise.all([
            hasChecksum(
                stagingPlan.archivePath,
                checksums.get(plan.archiveName),
            ),
            hasChecksum(
                stagingPlan.bindingPath,
                checksums.get(plan.bindingName),
            ),
        ]);
        if (!archiveValid || !bindingValid) {
            throw new Error(
                `Codex-built V8 artifacts for ${targetTriple} failed checksum validation`,
            );
        }

        await publishArtifactCache(stagingDir, plan);
    } catch (error) {
        await fs.rm(stagingDir, { recursive: true, force: true });
        throw error;
    }

    return {
        archivePath: plan.archivePath,
        bindingPath: plan.bindingPath,
        version: resolvedVersion,
    };
}

function configuredOverride(env, key) {
    return env[key]?.trim() || null;
}

export async function resolveCodexV8CargoEnvironment({
    targetTriple,
    profile = CODEX_V8_ARTIFACT_PROFILE,
    env = process.env,
    cargoLockPath = defaultCargoLockPath,
    cacheRoot = defaultCacheRoot,
    fetchImpl = globalThis.fetch,
    requireVerifiedArtifacts = false,
} = {}) {
    const archiveOverride = configuredOverride(env, "RUSTY_V8_ARCHIVE");
    const bindingOverride = configuredOverride(
        env,
        "RUSTY_V8_SRC_BINDING_PATH",
    );
    if (archiveOverride || bindingOverride) {
        if (requireVerifiedArtifacts) {
            throw new Error(
                "Verified V8 artifacts are required; direct RUSTY_V8 overrides are not allowed",
            );
        }
        if (!archiveOverride || !bindingOverride) {
            throw new Error(
                "RUSTY_V8_ARCHIVE and RUSTY_V8_SRC_BINDING_PATH must be set together",
            );
        }
        return {
            RUSTY_V8_ARCHIVE: archiveOverride,
            RUSTY_V8_SRC_BINDING_PATH: bindingOverride,
        };
    }

    if (["1", "true", "yes"].includes(env.V8_FROM_SOURCE?.toLowerCase())) {
        if (requireVerifiedArtifacts) {
            throw new Error(
                "Verified V8 artifacts are required; V8_FROM_SOURCE is not allowed",
            );
        }
        return {};
    }

    const artifacts = await fetchCodexV8Artifacts({
        targetTriple,
        profile,
        cargoLockPath,
        cacheRoot,
        fetchImpl,
    });
    return {
        RUSTY_V8_ARCHIVE: artifacts.archivePath,
        RUSTY_V8_SRC_BINDING_PATH: artifacts.bindingPath,
    };
}
