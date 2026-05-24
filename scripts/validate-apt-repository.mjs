import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import {
    APT_DEFAULT_COMPONENT,
    APT_DEFAULT_SUITE,
    APT_PACKAGE_NAME,
    APT_PUBLIC_KEY_FILE_NAME,
    APT_RELEASE_CHECKSUMS,
    APT_SOURCES_EXAMPLE_FILE_NAME,
    APT_SUPPORTED_ARCHITECTURES,
    getAptBinaryPackagesGzipPath,
    getAptBinaryPackagesPath,
    getDebianControlField,
    hashFile,
    normalizeAptComponent,
    normalizeAptSuite,
    normalizeDebianArchitecture,
    parseDebianControlStanza,
} from "./apt-repo-lib.mjs";
import { normalizeReleaseVersion } from "./appcast-lib.mjs";

function parseArgs(argv) {
    const args = {
        aptDir: null,
        version: null,
        suite: APT_DEFAULT_SUITE,
        component: APT_DEFAULT_COMPONENT,
        skipSignatureCheck: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--apt-dir") {
            args.aptDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--version") {
            args.version = next;
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
        if (arg === "--skip-signature-check") {
            args.skipSignatureCheck = true;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --apt-dir, --version, --suite, --component, --skip-signature-check.`,
        );
    }

    if (!args.aptDir) {
        throw new Error("Missing required argument --apt-dir <path>.");
    }

    return {
        ...args,
        version: args.version ? normalizeReleaseVersion(args.version) : null,
        suite: normalizeAptSuite(args.suite),
        component: normalizeAptComponent(args.component),
    };
}

function assertFileExists(filePath, label = filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing ${label}: ${filePath}`);
    }
}

function parseDebianControlFile(input) {
    return String(input ?? "")
        .replace(/\r\n/g, "\n")
        .split(/\n{2,}/)
        .map((stanza) => stanza.trimEnd())
        .filter(Boolean)
        .map((stanza) => parseDebianControlStanza(`${stanza}\n`));
}

function parseReleaseChecksums(releaseFields, fieldName) {
    const value = getDebianControlField(releaseFields, fieldName);
    if (!value) {
        throw new Error(`APT Release file is missing ${fieldName}.`);
    }

    return value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
            const [hash, size, relativePath] = line.split(/\s+/);
            if (!hash || !size || !relativePath) {
                throw new Error(`Invalid ${fieldName} line: ${line}`);
            }
            return {
                hash,
                sizeBytes: Number.parseInt(size, 10),
                relativePath,
            };
        });
}

function validateReleaseFile({ aptDir, suite, component }) {
    const suiteDir = path.join(aptDir, "dists", suite);
    const releasePath = path.join(suiteDir, "Release");
    const releaseFields = parseDebianControlStanza(
        fs.readFileSync(releasePath, "utf8"),
    );
    const expectedFields = {
        Origin: "NeverWrite",
        Label: "NeverWrite",
        Suite: suite,
        Codename: suite,
        Architectures: APT_SUPPORTED_ARCHITECTURES.join(" "),
        Components: component,
    };

    for (const [fieldName, expectedValue] of Object.entries(expectedFields)) {
        const actualValue = getDebianControlField(releaseFields, fieldName);
        if (actualValue !== expectedValue) {
            throw new Error(
                `APT Release ${fieldName} mismatch: expected "${expectedValue}", received "${actualValue ?? "missing"}".`,
            );
        }
    }

    for (const { fieldName, algorithm } of APT_RELEASE_CHECKSUMS) {
        for (const entry of parseReleaseChecksums(releaseFields, fieldName)) {
            const filePath = path.join(suiteDir, entry.relativePath);
            assertFileExists(filePath, `Release ${fieldName} target`);
            const actualSize = fs.statSync(filePath).size;
            if (actualSize !== entry.sizeBytes) {
                throw new Error(
                    `${entry.relativePath} size mismatch in ${fieldName}: expected ${entry.sizeBytes}, received ${actualSize}.`,
                );
            }
            const actualHash = hashFile(filePath, algorithm);
            if (actualHash !== entry.hash) {
                throw new Error(
                    `${entry.relativePath} hash mismatch in ${fieldName}: expected ${entry.hash}, received ${actualHash}.`,
                );
            }
        }
    }
}

function validatePackagesForArchitecture({
    aptDir,
    architecture,
    version,
}) {
    const arch = normalizeDebianArchitecture(architecture);
    const packagesPath = path.join(aptDir, getAptBinaryPackagesPath(arch));
    const packagesGzipPath = path.join(
        aptDir,
        getAptBinaryPackagesGzipPath(arch),
    );
    assertFileExists(packagesPath, `${arch} Packages index`);
    assertFileExists(packagesGzipPath, `${arch} Packages.gz index`);

    const packagesContent = fs.readFileSync(packagesPath, "utf8");
    const inflated = zlib.gunzipSync(fs.readFileSync(packagesGzipPath));
    if (!inflated.equals(Buffer.from(packagesContent, "utf8"))) {
        throw new Error(`${arch} Packages.gz does not match Packages.`);
    }

    const stanzas = parseDebianControlFile(packagesContent);
    if (stanzas.length === 0) {
        throw new Error(`${arch} Packages index contains no packages.`);
    }

    let foundExpectedVersion = !version;
    for (const stanza of stanzas) {
        const packageName = getDebianControlField(stanza, "Package");
        const packageVersion = getDebianControlField(stanza, "Version");
        const packageArchitecture = getDebianControlField(
            stanza,
            "Architecture",
        );
        const filename = getDebianControlField(stanza, "Filename");
        const size = Number.parseInt(getDebianControlField(stanza, "Size"), 10);

        if (packageName !== APT_PACKAGE_NAME) {
            throw new Error(
                `${arch} Packages contains unexpected package "${packageName}".`,
            );
        }
        if (packageArchitecture !== arch) {
            throw new Error(
                `${arch} Packages contains unexpected Architecture "${packageArchitecture}".`,
            );
        }
        if (!filename?.startsWith("pool/main/n/neverwrite/")) {
            throw new Error(
                `${arch} Packages contains invalid Filename "${filename ?? "missing"}".`,
            );
        }

        const packagePath = path.join(aptDir, filename);
        assertFileExists(packagePath, `${arch} package file`);

        if (fs.statSync(packagePath).size !== size) {
            throw new Error(`${filename} Size does not match package file.`);
        }
        for (const { fieldName, algorithm } of APT_RELEASE_CHECKSUMS) {
            const expectedHash = getDebianControlField(stanza, fieldName);
            if (!expectedHash) {
                throw new Error(`${filename} is missing ${fieldName}.`);
            }
            const actualHash = hashFile(packagePath, algorithm);
            if (expectedHash !== actualHash) {
                throw new Error(`${filename} ${fieldName} does not match.`);
            }
        }

        if (version && packageVersion === version) {
            foundExpectedVersion = true;
        }
    }

    if (!foundExpectedVersion) {
        throw new Error(`${arch} Packages does not contain version ${version}.`);
    }
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
                result.stderr?.toString().trim(),
                result.stdout?.toString().trim(),
            ]
                .filter(Boolean)
                .join("\n"),
        );
    }

    return result.stdout ?? "";
}

function verifySignatures({ aptDir, suite }) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "neverwrite-apt-gpg-"));
    const keyringPath = path.join(tempDir, "neverwrite-archive-keyring.gpg");
    const publicKeyPath = path.join(aptDir, APT_PUBLIC_KEY_FILE_NAME);
    const suiteDir = path.join(aptDir, "dists", suite);

    try {
        runCommand("gpg", [
            "--batch",
            "--yes",
            "--no-default-keyring",
            "--keyring",
            keyringPath,
            "--import",
            publicKeyPath,
        ]);
        runCommand("gpg", [
            "--batch",
            "--no-default-keyring",
            "--keyring",
            keyringPath,
            "--verify",
            path.join(suiteDir, "InRelease"),
        ]);
        runCommand("gpg", [
            "--batch",
            "--no-default-keyring",
            "--keyring",
            keyringPath,
            "--verify",
            path.join(suiteDir, "Release.gpg"),
            path.join(suiteDir, "Release"),
        ]);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

function validateSourcesExample(aptDir) {
    const sourcePath = path.join(aptDir, APT_SOURCES_EXAMPLE_FILE_NAME);
    assertFileExists(sourcePath, "Deb822 source example");
    const source = fs.readFileSync(sourcePath, "utf8");
    for (const expectedLine of [
        "Types: deb",
        "Suites: stable",
        "Components: main",
        "Architectures: amd64 arm64",
        "Signed-By: /etc/apt/keyrings/neverwrite.asc",
    ]) {
        if (!source.includes(expectedLine)) {
            throw new Error(
                `${APT_SOURCES_EXAMPLE_FILE_NAME} is missing "${expectedLine}".`,
            );
        }
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const suiteDir = path.join(args.aptDir, "dists", args.suite);

    assertFileExists(args.aptDir, "APT repository root");
    assertFileExists(path.join(args.aptDir, APT_PUBLIC_KEY_FILE_NAME), "APT public key");
    assertFileExists(path.join(suiteDir, "Release"), "APT Release");
    assertFileExists(path.join(suiteDir, "InRelease"), "APT InRelease");
    assertFileExists(path.join(suiteDir, "Release.gpg"), "APT Release.gpg");

    validateSourcesExample(args.aptDir);
    validateReleaseFile({
        aptDir: args.aptDir,
        suite: args.suite,
        component: args.component,
    });

    for (const architecture of APT_SUPPORTED_ARCHITECTURES) {
        validatePackagesForArchitecture({
            aptDir: args.aptDir,
            architecture,
            version: args.version,
        });
    }

    if (!args.skipSignatureCheck) {
        verifySignatures({ aptDir: args.aptDir, suite: args.suite });
    }

    console.log(
        `APT repository is valid for ${args.version ? `version ${args.version}` : "all indexed versions"}.`,
    );
}

main();
