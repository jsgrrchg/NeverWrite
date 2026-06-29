import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
    APT_DEFAULT_SUITE,
    APT_LAYOUT_CLASSIC,
    APT_LAYOUT_FLAT_RELEASE,
    APT_PUBLIC_KEY_FILE_NAME,
    normalizeAptLayout,
    normalizeAptSuite,
} from "./apt-repo-lib.mjs";

function parseArgs(argv) {
    const args = {
        aptDir: null,
        keyId: null,
        suite: APT_DEFAULT_SUITE,
        layout: APT_LAYOUT_CLASSIC,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--apt-dir") {
            args.aptDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--key-id") {
            args.keyId = next;
            index += 1;
            continue;
        }
        if (arg === "--suite") {
            args.suite = next;
            index += 1;
            continue;
        }
        if (arg === "--layout") {
            args.layout = next;
            index += 1;
            continue;
        }

        throw new Error(
            `Unknown argument "${arg}". Supported args: --apt-dir, --key-id, --suite, --layout.`,
        );
    }

    if (!args.aptDir) {
        throw new Error("Missing required argument --apt-dir <path>.");
    }
    if (!args.keyId?.trim()) {
        throw new Error("Missing required argument --key-id <fingerprint>.");
    }

    return {
        ...args,
        keyId: args.keyId.trim(),
        suite: normalizeAptSuite(args.suite),
        layout: normalizeAptLayout(args.layout),
    };
}

function runGpg(args, { input = null, stdoutFile = null } = {}) {
    const result = childProcess.spawnSync("gpg", args, {
        input,
        encoding: stdoutFile ? null : "utf8",
        maxBuffer: 1024 * 1024 * 16,
    });

    if (result.status !== 0) {
        throw new Error(
            [
                `gpg command failed: gpg ${args.join(" ")}`,
                result.error?.message,
                result.stderr?.toString().trim(),
                result.stdout?.toString().trim(),
            ]
                .filter(Boolean)
                .join("\n"),
        );
    }

    if (stdoutFile) {
        fs.writeFileSync(stdoutFile, result.stdout);
    }

    return result.stdout;
}

function signingPassphraseArgs(passphrase) {
    return passphrase
        ? ["--pinentry-mode", "loopback", "--passphrase-fd", "0"]
        : ["--pinentry-mode", "loopback"];
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const suiteDir =
        args.layout === APT_LAYOUT_FLAT_RELEASE
            ? args.aptDir
            : path.join(args.aptDir, "dists", args.suite);
    const releasePath = path.join(suiteDir, "Release");
    const inReleasePath = path.join(suiteDir, "InRelease");
    const detachedSignaturePath = path.join(suiteDir, "Release.gpg");
    const publicKeyPath = path.join(args.aptDir, APT_PUBLIC_KEY_FILE_NAME);
    const passphrase = process.env.APT_REPO_GPG_PASSPHRASE ?? "";

    if (!fs.existsSync(releasePath)) {
        throw new Error(`Cannot sign missing APT Release file: ${releasePath}`);
    }

    runGpg(
        [
            "--batch",
            "--yes",
            "--export-options",
            "export-minimal",
            "--armor",
            "--export",
            args.keyId,
        ],
        { stdoutFile: publicKeyPath },
    );

    runGpg(
        [
            "--batch",
            "--yes",
            ...signingPassphraseArgs(passphrase),
            "--local-user",
            args.keyId,
            "--clearsign",
            "--output",
            inReleasePath,
            releasePath,
        ],
        { input: passphrase ? `${passphrase}\n` : null },
    );

    runGpg(
        [
            "--batch",
            "--yes",
            ...signingPassphraseArgs(passphrase),
            "--local-user",
            args.keyId,
            "--armor",
            "--detach-sign",
            "--output",
            detachedSignaturePath,
            releasePath,
        ],
        { input: passphrase ? `${passphrase}\n` : null },
    );

    console.log(`Wrote APT public key: ${publicKeyPath}`);
    console.log(`Wrote signed APT metadata: ${inReleasePath}`);
    console.log(`Wrote detached APT signature: ${detachedSignaturePath}`);
}

main();
