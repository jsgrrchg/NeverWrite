import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function parseArgs(argv) {
    const args = {
        rpmDir: null,
        keyId: null,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1] ?? null;

        if (arg === "--rpm-dir") {
            args.rpmDir = path.resolve(next);
            index += 1;
            continue;
        }
        if (arg === "--key-id") {
            args.keyId = next?.trim();
            index += 1;
            continue;
        }
        throw new Error(`Unknown argument "${arg}".`);
    }

    if (!args.rpmDir) throw new Error("Missing --rpm-dir");
    if (!args.keyId) throw new Error("Missing --key-id");

    return args;
}

function listRpmFiles(rootDir) {
    const files = [];
    const queue = [rootDir];

    while (queue.length > 0) {
        const current = queue.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const absolutePath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                queue.push(absolutePath);
            } else if (entry.isFile() && entry.name.endsWith(".rpm")) {
                files.push(absolutePath);
            }
        }
    }

    return files.sort();
}

function runCommand(command, args, options = {}) {
    const result = childProcess.spawnSync(command, args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 16,
        ...options,
    });
    if (result.status !== 0) {
        throw new Error(
            `Command failed: ${command} ${args.join(" ")}\n${result.stderr?.trim() || result.stdout?.trim()}`,
        );
    }
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function writePassphraseFile(tempDir) {
    const passphrase = process.env.APT_REPO_GPG_PASSPHRASE ?? "";
    if (!passphrase) {
        return null;
    }

    const passphrasePath = path.join(tempDir, "rpm-signing-passphrase");
    fs.writeFileSync(passphrasePath, passphrase, { mode: 0o600 });
    return passphrasePath;
}

function buildRpmSignDefines({ keyId, passphrasePath }) {
    const extraGpgArgs = [
        "--batch",
        "--pinentry-mode",
        "loopback",
        ...(passphrasePath ? ["--passphrase-file", passphrasePath] : []),
    ].join(" ");

    return [
        "--define",
        `_gpg_name ${keyId}`,
        "--define",
        `_gpg_path ${process.env.GNUPGHOME}`,
        "--define",
        "_signature gpg",
        "--define",
        `_gpg_sign_cmd_extra_args ${extraGpgArgs}`,
    ];
}

function assertRpmSignature(rpmPath) {
    const output = runCommand("rpm", ["-Kv", rpmPath]);
    if (!/signature/i.test(output)) {
        throw new Error(`RPM package is not signed: ${rpmPath}\n${output}`);
    }
    if (/(not ok|nokey|nottrusted|missing keys|bad)/i.test(output)) {
        throw new Error(`RPM package signature check failed: ${rpmPath}\n${output}`);
    }
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const rpmFiles = listRpmFiles(args.rpmDir);
    if (rpmFiles.length === 0) {
        throw new Error(`No RPM packages found in ${args.rpmDir}.`);
    }

    runCommand("rpmsign", ["--version"]);
    runCommand("rpm", ["--version"]);

    if (!process.env.GNUPGHOME) {
        throw new Error("GNUPGHOME must point to the imported release signing keyring.");
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "neverwrite-rpm-sign-"));
    try {
        const passphrasePath = writePassphraseFile(tempDir);
        const rpmSignDefines = buildRpmSignDefines({
            keyId: args.keyId,
            passphrasePath,
        });

        for (const rpmPath of rpmFiles) {
            runCommand("rpmsign", [...rpmSignDefines, "--addsign", rpmPath]);
            assertRpmSignature(rpmPath);
            console.log(`Signed RPM package: ${rpmPath}`);
        }
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main();
