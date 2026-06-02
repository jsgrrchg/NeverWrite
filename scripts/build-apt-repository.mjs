import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

import {
    APT_DEFAULT_COMPONENT,
    APT_DEFAULT_SUITE,
    APT_EXACT_PATH_SUITE,
    APT_LAYOUT_CLASSIC,
    APT_LAYOUT_FLAT_RELEASE,
    APT_SOURCES_EXAMPLE_FILE_NAME,
    APT_SUPPORTED_ARCHITECTURES,
    buildAptPoolPackagePath,
    buildAptReleaseContent,
    buildDebianReleaseAssetName,
    buildGitHubReleaseDownloadBaseUrl,
    buildNeverWriteSourcesExample,
    compareReleaseVersionsDescending,
    getAptBinaryPackagesGzipPath,
    getAptBinaryPackagesPath,
    getAptRepositoryRoot,
    getDebianControlField,
    getFileHashes,
    listFilesRecursively,
    normalizeAptBaseUrl,
    normalizeAptComponent,
    normalizeAptLayout,
    normalizeAptSuite,
    parseAptPoolPackageFileName,
    parseDebianControlStanza,
    renderPackagesStanza,
} from "./apt-repo-lib.mjs";
import { CANONICAL_RELEASE_REPO_SLUG } from "./appcast-lib.mjs";
import { normalizeReleaseVersion } from "./appcast-lib.mjs";

function parseArgs(argv) {
    const args = {
        version: null,
        releaseAssetsDir: null,
        pagesDir: null,
        outputDir: null,
        baseUrl: null,
        suite: APT_DEFAULT_SUITE,
        component: APT_DEFAULT_COMPONENT,
        retainVersions: 3,
        layout: APT_LAYOUT_CLASSIC,
        repoSlug: CANONICAL_RELEASE_REPO_SLUG,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--version") {
            args.version = next;
            index += 1;
            continue;
        }
        if (arg === "--release-assets-dir") {
            args.releaseAssetsDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--pages-dir") {
            args.pagesDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--output-dir") {
            args.outputDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--base-url") {
            args.baseUrl = next;
            index += 1;
            continue;
        }
        if (arg === "--suite") {
            args.suite = next;
            index += 1;
            continue;
        }
        if (arg === "--component") {
            args.component = next;
            index += 1;
            continue;
        }
        if (arg === "--retain-versions") {
            args.retainVersions = Number.parseInt(next, 10);
            index += 1;
            continue;
        }
        if (arg === "--layout") {
            args.layout = next;
            index += 1;
            continue;
        }
        if (arg === "--repo-slug") {
            args.repoSlug = next;
            index += 1;
            continue;
        }
        throw new Error(
            `Unknown argument "${arg}". Supported args: --version, --release-assets-dir, --pages-dir, --output-dir, --base-url, --suite, --component, --retain-versions, --layout, --repo-slug.`,
        );
    }

    if (!args.version) {
        throw new Error("Missing required argument --version <X.Y.Z-or-tag>.");
    }
    if (!args.releaseAssetsDir) {
        throw new Error(
            "Missing required argument --release-assets-dir <path>.",
        );
    }
    if (!Number.isInteger(args.retainVersions) || args.retainVersions < 1) {
        throw new Error("--retain-versions must be a positive integer.");
    }

    const layout = normalizeAptLayout(args.layout);
    if (layout === APT_LAYOUT_CLASSIC && !args.pagesDir) {
        throw new Error("Missing required argument --pages-dir <path>.");
    }
    if (layout === APT_LAYOUT_FLAT_RELEASE && !args.outputDir) {
        throw new Error(
            "Missing required argument --output-dir <path> for flat-release layout.",
        );
    }

    const baseUrl =
        args.baseUrl ??
        (layout === APT_LAYOUT_FLAT_RELEASE
            ? buildGitHubReleaseDownloadBaseUrl(args.repoSlug, "latest")
            : null);
    if (!baseUrl) {
        throw new Error("Missing required argument --base-url <url>.");
    }

    return {
        ...args,
        layout,
        baseUrl: normalizeAptBaseUrl(baseUrl),
        version: normalizeReleaseVersion(args.version),
        suite: normalizeAptSuite(args.suite),
        component: normalizeAptComponent(args.component),
    };
}

function runCommand(command, args, options = {}) {
    const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
        ...options,
    });

    if (result.status !== 0) {
        throw new Error(
            [
                `Command failed: ${command} ${args.join(" ")}`,
                result.error?.message,
                result.stderr?.trim(),
                result.stdout?.trim(),
            ]
                .filter(Boolean)
                .join("\n"),
        );
    }

    return result.stdout ?? "";
}

function assertDpkgDebAvailable() {
    runCommand("dpkg-deb", ["--version"]);
}

function findSingleReleaseAsset(releaseAssetsDir, assetName) {
    const matches = listFilesRecursively(releaseAssetsDir).filter(
        (filePath) => path.basename(filePath) === assetName,
    );
    if (matches.length !== 1) {
        throw new Error(
            `Expected exactly one release asset named ${assetName} in ${releaseAssetsDir}, found ${matches.length}.`,
        );
    }
    return matches[0];
}

function copyCurrentReleaseDebs({ version, releaseAssetsDir, aptDir }) {
    const copied = [];

    for (const architecture of APT_SUPPORTED_ARCHITECTURES) {
        const assetName = buildDebianReleaseAssetName(version, architecture);
        const source = findSingleReleaseAsset(releaseAssetsDir, assetName);
        const relativePath = buildAptPoolPackagePath(version, architecture);
        const destination = path.join(aptDir, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
        copied.push({ architecture, relativePath, destination });
    }

    return copied;
}

function pruneOldPoolPackages({ aptDir, retainVersions, currentVersion }) {
    const poolDir = path.join(aptDir, "pool", "main", "n", "neverwrite");
    fs.mkdirSync(poolDir, { recursive: true });

    const packages = fs
        .readdirSync(poolDir)
        .map((fileName) => ({
            fileName,
            metadata: parseAptPoolPackageFileName(fileName),
        }))
        .filter((entry) => entry.metadata);
    const sortedVersions = [
        ...new Set(packages.map((entry) => entry.metadata.version)),
    ].sort(compareReleaseVersionsDescending);
    const orderedVersions = [
        currentVersion,
        ...sortedVersions.filter((version) => version !== currentVersion),
    ];
    const retainedVersions = new Set(orderedVersions.slice(0, retainVersions));
    const removed = [];

    for (const { fileName, metadata } of packages) {
        if (!retainedVersions.has(metadata.version)) {
            const packagePath = path.join(poolDir, fileName);
            fs.rmSync(packagePath, { force: true });
            removed.push(packagePath);
        }
    }

    return { retainedVersions: [...retainedVersions], removed };
}

function readDebianControlFields(packagePath) {
    const output = runCommand("dpkg-deb", ["-f", packagePath]);
    const fields = parseDebianControlStanza(output);
    if (fields.length === 0) {
        throw new Error(`dpkg-deb returned no control fields for ${packagePath}.`);
    }
    return fields;
}

function validateDebianPackageFields({
    packagePath,
    relativePath,
    fields,
    architecture,
}) {
    const expected = {
        Package: "neverwrite",
        Architecture: architecture,
    };

    for (const [fieldName, expectedValue] of Object.entries(expected)) {
        const actualValue = getDebianControlField(fields, fieldName);
        if (actualValue !== expectedValue) {
            throw new Error(
                `${relativePath} has unexpected ${fieldName}: expected ${expectedValue}, received ${actualValue ?? "missing"}.`,
            );
        }
    }

    const version = getDebianControlField(fields, "Version");
    if (!version) {
        throw new Error(`${relativePath} is missing Debian Version metadata.`);
    }

    if (!fs.existsSync(packagePath)) {
        throw new Error(`${relativePath} does not exist at ${packagePath}.`);
    }
}

function collectPoolPackages({ aptDir }) {
    const poolDir = path.join(aptDir, "pool", "main", "n", "neverwrite");
    const packages = [];

    for (const packagePath of listFilesRecursively(poolDir)) {
        const metadata = parseAptPoolPackageFileName(path.basename(packagePath));
        if (!metadata) {
            continue;
        }

        const relativePath = path
            .relative(aptDir, packagePath)
            .split(path.sep)
            .join(path.posix.sep);
        const fields = readDebianControlFields(packagePath);
        validateDebianPackageFields({
            packagePath,
            relativePath,
            fields,
            architecture: metadata.architecture,
        });
        packages.push({
            version: metadata.version,
            architecture: metadata.architecture,
            content: renderPackagesStanza({
                controlFields: fields,
                filename: relativePath,
                sizeBytes: fs.statSync(packagePath).size,
                hashes: getFileHashes(packagePath),
            }),
        });
    }

    return packages;
}

function collectCurrentReleasePackages({ version, releaseAssetsDir }) {
    const packages = [];

    for (const architecture of APT_SUPPORTED_ARCHITECTURES) {
        const assetName = buildDebianReleaseAssetName(version, architecture);
        const source = findSingleReleaseAsset(releaseAssetsDir, assetName);
        const fields = readDebianControlFields(source);
        validateDebianPackageFields({
            packagePath: source,
            relativePath: assetName,
            fields,
            architecture,
        });
        packages.push({
            version,
            architecture,
            content: renderPackagesStanza({
                controlFields: fields,
                filename: assetName,
                sizeBytes: fs.statSync(source).size,
                hashes: getFileHashes(source),
            }),
        });
    }

    return packages;
}

function renderPackagesFileForArchitecture({ packages, architecture }) {
    const stanzas = packages
        .filter((pkg) => pkg.architecture === architecture)
        .sort((left, right) =>
            compareReleaseVersionsDescending(left.version, right.version),
        )
        .map((pkg) => pkg.content);

    return stanzas.join("\n");
}

function gzipDeterministic(input) {
    const gzip = childProcess.spawnSync("gzip", ["-9", "-n", "-c"], {
        input,
        encoding: null,
        maxBuffer: 1024 * 1024 * 16,
    });

    if (gzip.status === 0) {
        return gzip.stdout;
    }

    return zlib.gzipSync(Buffer.from(input, "utf8"), { level: 9, mtime: 0 });
}

function writeClassicPackagesIndexes({ aptDir, packages }) {
    const written = [];

    for (const architecture of APT_SUPPORTED_ARCHITECTURES) {
        const packagesRelativePath = getAptBinaryPackagesPath(architecture);
        const packagesPath = path.join(aptDir, packagesRelativePath);
        const content = renderPackagesFileForArchitecture({
            packages,
            architecture,
        });

        fs.mkdirSync(path.dirname(packagesPath), { recursive: true });
        fs.writeFileSync(packagesPath, content, "utf8");
        fs.writeFileSync(
            path.join(aptDir, getAptBinaryPackagesGzipPath(architecture)),
            gzipDeterministic(content),
        );
        written.push(packagesRelativePath);
    }

    return written;
}

function renderFlatPackagesFile({ packages }) {
    return packages
        .sort((left, right) => {
            const versionOrder = compareReleaseVersionsDescending(
                left.version,
                right.version,
            );
            if (versionOrder !== 0) {
                return versionOrder;
            }
            return left.architecture.localeCompare(right.architecture);
        })
        .map((pkg) => pkg.content)
        .join("\n");
}

function writeFlatPackagesIndex({ aptDir, packages }) {
    const content = renderFlatPackagesFile({ packages });
    const packagesPath = path.join(aptDir, "Packages");

    fs.mkdirSync(aptDir, { recursive: true });
    fs.writeFileSync(packagesPath, content, "utf8");
    fs.writeFileSync(
        path.join(aptDir, "Packages.gz"),
        gzipDeterministic(content),
    );

    return ["Packages", "Packages.gz"];
}

function collectClassicReleaseFiles(aptDir, suite) {
    const distsDir = path.join(aptDir, "dists", suite);
    return listFilesRecursively(distsDir)
        .map((filePath) => ({
            absolutePath: filePath,
            relativePath: path
                .relative(distsDir, filePath)
                .split(path.sep)
                .join(path.posix.sep),
        }))
        .filter(
            (file) =>
                !["Release", "InRelease", "Release.gpg"].includes(
                    file.relativePath,
                ),
        )
        .map((file) => ({
            relativePath: file.relativePath,
            sizeBytes: fs.statSync(file.absolutePath).size,
            hashes: getFileHashes(file.absolutePath),
        }));
}

function collectFlatReleaseFiles(aptDir) {
    return ["Packages", "Packages.gz"].map((relativePath) => {
        const absolutePath = path.join(aptDir, relativePath);
        return {
            relativePath,
            sizeBytes: fs.statSync(absolutePath).size,
            hashes: getFileHashes(absolutePath),
        };
    });
}

function removeClassicStaleSignatures(aptDir, suite) {
    const suiteDir = path.join(aptDir, "dists", suite);
    fs.rmSync(path.join(suiteDir, "InRelease"), { force: true });
    fs.rmSync(path.join(suiteDir, "Release.gpg"), { force: true });
}

function removeFlatStaleSignatures(aptDir) {
    fs.rmSync(path.join(aptDir, "InRelease"), { force: true });
    fs.rmSync(path.join(aptDir, "Release.gpg"), { force: true });
}

function buildClassicRepository(args) {
    const aptDir = getAptRepositoryRoot(args.pagesDir);
    fs.mkdirSync(aptDir, { recursive: true });

    const copied = copyCurrentReleaseDebs({
        version: args.version,
        releaseAssetsDir: args.releaseAssetsDir,
        aptDir,
    });
    const retention = pruneOldPoolPackages({
        aptDir,
        retainVersions: args.retainVersions,
        currentVersion: args.version,
    });

    const packages = collectPoolPackages({ aptDir });

    console.log(
        `Copied Debian packages: ${copied.map((entry) => entry.relativePath).join(", ")}`,
    );
    console.log(
        `Retained APT package versions: ${retention.retainedVersions.join(", ")}`,
    );
    if (retention.removed.length > 0) {
        console.log(`Pruned old Debian packages: ${retention.removed.length}`);
    }

    fs.rmSync(path.join(aptDir, "dists", args.suite), {
        recursive: true,
        force: true,
    });
    const packagesIndexes = writeClassicPackagesIndexes({ aptDir, packages });
    const releaseFiles = collectClassicReleaseFiles(aptDir, args.suite);
    const releasePath = path.join(aptDir, "dists", args.suite, "Release");

    fs.writeFileSync(
        releasePath,
        buildAptReleaseContent({
            suite: args.suite,
            component: args.component,
            files: releaseFiles,
        }),
        "utf8",
    );
    fs.writeFileSync(
        path.join(aptDir, APT_SOURCES_EXAMPLE_FILE_NAME),
        buildNeverWriteSourcesExample(args.baseUrl),
        "utf8",
    );
    removeClassicStaleSignatures(aptDir, args.suite);

    return { aptDir, packages, packagesIndexes, releasePath };
}

function buildFlatReleaseRepository(args) {
    const aptDir = args.outputDir;
    fs.rmSync(aptDir, { recursive: true, force: true });
    fs.mkdirSync(aptDir, { recursive: true });

    const packages = collectCurrentReleasePackages({
        version: args.version,
        releaseAssetsDir: args.releaseAssetsDir,
    });
    const packagesIndexes = writeFlatPackagesIndex({ aptDir, packages });
    const releaseFiles = collectFlatReleaseFiles(aptDir);
    const releasePath = path.join(aptDir, "Release");

    fs.writeFileSync(
        releasePath,
        buildAptReleaseContent({
            suite: args.suite,
            component: null,
            files: releaseFiles,
        }),
        "utf8",
    );
    fs.writeFileSync(
        path.join(aptDir, APT_SOURCES_EXAMPLE_FILE_NAME),
        buildNeverWriteSourcesExample(args.baseUrl, {
            suite: APT_EXACT_PATH_SUITE,
            component: null,
        }),
        "utf8",
    );
    removeFlatStaleSignatures(aptDir);

    return { aptDir, packages, packagesIndexes, releasePath };
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    assertDpkgDebAvailable();

    const { aptDir, packages, packagesIndexes, releasePath } =
        args.layout === APT_LAYOUT_FLAT_RELEASE
            ? buildFlatReleaseRepository(args)
            : buildClassicRepository(args);

    console.log(
        `APT package versions indexed: ${packages.map((pkg) => `${pkg.version} (${pkg.architecture})`).join(", ")}`,
    );
    console.log(`Wrote APT package indexes: ${packagesIndexes.join(", ")}`);
    console.log(`Wrote APT Release metadata: ${releasePath}`);
}

main();
